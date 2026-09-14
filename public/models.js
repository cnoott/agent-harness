import { setContextModel } from "/context.js";

const select = document.querySelector("#chat-model");
const status = document.querySelector("#model-status");
const retry = document.querySelector("#retry-models");
const spend = document.querySelector("#provider-spend");
const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 });
const tokens = new Intl.NumberFormat();
let catalog;
let selected;
let chatId;
let busy = true;
let saving = false;
let unresolvedChat;
let usage;
let usageError = "";
let usageRequest;
const modelKey = model => model ? `${model.provider}:${model.model}` : "";
const providerName = provider => provider === "openai" ? "OpenAI" : provider === "gemini" ? "Gemini" : "Provider";

function showStatus(message = "", error = false) {
  status.textContent = message;
  status.hidden = !message;
  status.dataset.error = String(error);
}

function renderModels() {
  const choices = catalog?.models ?? [];
  select.replaceChildren();
  if (selected && !choices.some(model => modelKey(model) === modelKey(selected))) {
    const option = new Option(`${providerName(selected.provider)} · ${selected.model} (unavailable)`, modelKey(selected));
    option.disabled = true;
    select.append(option);
  }
  for (const model of choices) select.append(new Option(`${providerName(model.provider)} · ${model.model}`, modelKey(model)));
  if (!select.options.length) select.append(new Option(catalog ? "No models configured" : "Models unavailable", ""));
  select.value = modelKey(selected);
  select.disabled = busy || saving || !choices.length;
  select.title = selected ? `${providerName(selected.provider)} · ${selected.model}. Main chat model; changes apply to the next message.` : "Configure a provider API key to choose a model.";
}

export function setModelBusy(value) {
  busy = value;
  select.disabled = value || saving || !catalog?.models?.length;
}

export function setModelChat(id, model) {
  chatId = id;
  selected = model ?? selected ?? catalog?.defaultModel;
  showStatus();
  renderModels();
  setContextModel(selected);
  renderUsage();
}

export function getSelectedModel() {
  return catalog?.models.find(model => modelKey(model) === modelKey(selected));
}

export async function loadModels() {
  retry.hidden = true;
  retry.textContent = "Reload models";
  try {
    const response = await fetch("/api/models");
    if (!response.ok) throw new Error("Could not load models.");
    catalog = await response.json();
    selected ??= catalog.defaultModel;
    showStatus();
  } catch (error) {
    showStatus(error.message || "Could not load models.", true);
    retry.hidden = false;
  }
  renderModels();
  setContextModel(selected);
  renderUsage();
}

select.addEventListener("change", async () => {
  const model = catalog?.models.find(model => modelKey(model) === select.value);
  if (!model || busy || saving) return renderModels();
  if (!chatId) { setModelChat(null, model); return; }
  const target = chatId;
  saving = true;
  document.dispatchEvent(new CustomEvent("chat-model-saving", { detail: true }));
  renderModels();
  showStatus("Saving model…");
  try {
    const response = await fetch(`/api/chats/${target}/model`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(model),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not change model.");
    if (chatId === target) {
      setModelChat(target, result.model);
      document.dispatchEvent(new CustomEvent("chat-model-changed", { detail: { chatId: target } }));
    }
  } catch (error) {
    if (chatId === target) {
      try {
        const response = await fetch(`/api/chats/${target}`);
        if (!response.ok) throw new Error();
        const current = await response.json();
        setModelChat(target, current.activeRun?.model ?? current.model);
        showStatus(`${error.message || "Could not confirm the change."} Showing the saved model.`, true);
      } catch {
        unresolvedChat = target;
        retry.textContent = "Retry model sync";
        retry.hidden = false;
        showStatus("Could not confirm the saved model. Retry model sync before sending a message.", true);
      }
    }
  } finally {
    saving = Boolean(unresolvedChat);
    document.dispatchEvent(new CustomEvent("chat-model-saving", { detail: saving }));
    renderModels();
  }
});

function renderUsage() {
  const provider = selected?.provider;
  const data = usage?.providers?.find(item => item.provider === provider);
  document.querySelector("#spend-heading").textContent = `${providerName(provider)} usage · all models`;
  if (!data || usageError) {
    spend.textContent = usageError ? "Usage unavailable" : "Usage…";
    document.querySelector("#spend-amount").textContent = usageError || "Loading recorded usage…";
    for (const id of ["spend-tokens", "spend-breakdown", "spend-coverage", "spend-since"]) document.getElementById(id).textContent = "";
    return;
  }
  const incomplete = data.unpricedResponses > 0 || data.missingUsageResponses > 0 || usage.unreadableHistories > 0 || usage.unattributedResponses > 0;
  const knownCost = Number.isFinite(data.estimatedCostUsd) && !(incomplete && !data.pricedResponses);
  const amount = knownCost ? dollars.format(data.estimatedCostUsd) : "Cost unavailable";
  spend.textContent = knownCost ? `${amount}${incomplete ? "+" : ""} est.` : amount;
  document.querySelector("#spend-toggle").setAttribute("aria-label", `${providerName(provider)} recorded spending: ${spend.textContent}`);
  document.querySelector("#spend-amount").textContent = knownCost ? `${amount} estimated${incomplete ? " · partial" : ""}` : "Pricing unavailable";
  document.querySelector("#spend-tokens").textContent = `${tokens.format(data.totalTokens)}${data.missingUsageResponses || usage.unreadableHistories || usage.unattributedResponses ? "+" : ""} tokens used`;
  document.querySelector("#spend-breakdown").textContent = `${tokens.format(data.inputTokens)} input (${tokens.format(data.cachedInputTokens)} cached) · ${tokens.format(data.outputTokens)} output`;
  document.querySelector("#spend-coverage").textContent = `${usage.coverage || "Recorded app usage across chats and workers; not your provider account bill."}${incomplete ? ` ${data.unpricedResponses} responses without pricing; ${data.missingUsageResponses} without usage.${usage.unreadableHistories ? ` ${usage.unreadableHistories} unreadable histories.` : ""}${usage.unattributedResponses ? ` ${usage.unattributedResponses} responses without a known provider.` : ""}` : ""}`;
  document.querySelector("#spend-since").textContent = data.since ? `Retained records since ${new Date(data.since).toLocaleDateString()} · updated ${new Date(usage.capturedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "No recorded usage yet.";
}

export function refreshProviderUsage() {
  if (usageRequest) return usageRequest;
  document.querySelector("#refresh-usage").disabled = true;
  usageRequest = (async () => {
    try {
      const response = await fetch("/api/usage");
      if (!response.ok) throw new Error("Could not load usage. Try refreshing.");
      usage = await response.json();
      usageError = "";
    } catch (error) { usageError = error.message || "Could not load usage."; }
    finally {
      usageRequest = null;
      document.querySelector("#refresh-usage").disabled = false;
      renderUsage();
    }
  })();
  return usageRequest;
}

retry.addEventListener("click", async () => {
  if (!unresolvedChat) return loadModels();
  retry.disabled = true;
  try {
    const response = await fetch(`/api/chats/${unresolvedChat}`);
    if (!response.ok) throw new Error();
    const current = await response.json();
    setModelChat(unresolvedChat, current.activeRun?.model ?? current.model);
    unresolvedChat = null;
    saving = false;
    retry.hidden = true;
    document.dispatchEvent(new CustomEvent("chat-model-saving", { detail: false }));
    renderModels();
  } catch { showStatus("Model sync is unavailable. Retry or reload the page.", true); }
  finally { retry.disabled = false; }
});
document.querySelector("#refresh-usage").addEventListener("click", refreshProviderUsage);
for (const popover of document.querySelectorAll(".composer-detail")) {
  popover.addEventListener("toggle", () => {
    if (!popover.open) return;
    for (const other of document.querySelectorAll(".composer-detail")) if (other !== popover) other.open = false;
    if (popover.id === "provider-usage") void refreshProviderUsage();
  });
  popover.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    popover.open = false;
    popover.querySelector("summary").focus();
  });
}
document.addEventListener("click", event => {
  for (const popover of document.querySelectorAll(".composer-detail")) if (!popover.contains(event.target)) popover.open = false;
});
setInterval(() => { if (!document.hidden) void refreshProviderUsage(); }, 30_000);
