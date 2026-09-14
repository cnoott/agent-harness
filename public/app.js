import { setPanelWorkspace, setBrowserAvailable, resetBrowserActivity, showBrowserActivity, closePanel } from "/panels.js";
import { setRosterChat, setRosterBusy, refreshRosterView } from "/rosters.js";
import { setMatchupChat, setMatchupBusy, refreshMatchupView } from "/matchup.js";
import { setWaiverChat, setWaiverBusy, refreshWaivers } from "/waivers.js";
import { renderContext, settleContext } from "/context.js";
import { loadModels, setModelChat, setModelBusy, getSelectedModel, refreshProviderUsage } from "/models.js";
import { setCommandChat, setCommandsBusy, refreshCommands } from "/commands.js";
import { setAuditChat } from "/runs.js";
import { setNflGamesChat } from "/nfl-games.js";
import { marked } from "/vendor/marked.js";
import DOMPurify from "/vendor/dompurify.js";

const state = { chatId: localStorage.getItem("sandbox-harness-chat"), workspaceId: localStorage.getItem("sandbox-harness-sport") || "", creatingChat: false, switchingSport: false, changingChat: false, changingModel: false, loadingChat: true, archivedAt: null, currentAssistant: null, running: false, voiceMode: "idle" };
const sportDrafts = new Map();
const $ = (selector) => document.querySelector(selector);
const messages = $("#messages");
const prompt = $("#prompt");
const send = $("#send");
const stop = $("#stop");
const status = $("#status");
const voice = $("#voice");
const voiceCancel = $("#voice-cancel");
let voiceUnavailable = "Voice input is loading…";
let recording;
const browserPreview = $("#browser-preview");
const browserPreviewImage = $("#browser-preview-image");
const browserPreviewStatus = $("#browser-preview-status");
const browserPreviewUrl = $("#browser-preview-url");
const historyDrawer = $("#history-drawer");
const historyBackdrop = $("#history-backdrop");
const historyToggle = $("#history-toggle");
const historyList = $("#history-list");
let showArchivedChats = false;
let historyRequest = 0;
const narrowHistory = matchMedia("(max-width: 1099px)");
let deletingChat = null;
let deletePreviewRequest = null;
const browserControlToggle = $("#browser-control-toggle");
const browserControlPanel = $("#browser-control-panel");
const browserControlHint = $("#browser-control-hint");
const browserType = $("#browser-type");
let browserEvents;
let browserControlEnabled = false;
let scrollTimer;
let filesRequest = 0;
let runEvents;

function enableLiveReload() {
  if (!["127.0.0.1", "localhost", "[::1]"].includes(location.hostname)) return;
  let connectedOnce = false;
  const updates = new EventSource("/api/live-reload");
  updates.addEventListener("open", () => {
    if (connectedOnce) location.reload();
    connectedOnce = true;
  });
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function scrollMessages(force = false) {
  if (force || messages.scrollHeight - messages.scrollTop - messages.clientHeight < 160) messages.scrollTop = messages.scrollHeight;
}

function renderMarkdown(content, text) {
  content.innerHTML = DOMPurify.sanitize(marked.parse(text, { gfm: true }), { USE_PROFILES: { html: true } });
  for (const link of content.querySelectorAll("a")) {
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  }
}

function renderMessage(message, active = false) {
  const item = $("#message-template").content.firstElementChild.cloneNode(true);
  item.classList.add(message.role);
  if (message.id) item.dataset.messageId = message.id;
  item.querySelector(".message-meta").textContent = message.role === "user" ? "You" : "Agent";
  item.dataset.text = message.text;
  const content = item.querySelector(".message-content");
  if (message.role === "assistant") renderMarkdown(content, message.text);
  else content.textContent = message.text;
  messages.append(item);
  for (const event of message.activity || []) renderActivity(item, event);
  if (!active) finishActivity(item);
  scrollMessages();
  return item;
}

function appendActivity(label, data, { tone = "error" } = {}) {
  const item = state.running && state.currentAssistant ? state.currentAssistant : renderMessage({ role: "assistant", text: "" });
  renderActivity(item, { type: tone === "error" ? "error" : "status", name: label, data });
}

function renderActivity(item, activity) {
  if (activity.type === "agent_update") return renderWorker(item, activity.data);
  const group = item.querySelector(".tool-activity");
  const events = item.querySelector(".activity-events");
  group.classList.remove("hidden");
  const isTool = activity.type.startsWith("tool_");
  let event = isTool && [...events.children].find((entry) => activity.callId
    ? entry.dataset.callId === activity.callId
    : activity.type === "tool_end" && !entry.dataset.callId && entry.dataset.name === activity.name && entry.dataset.running === "true");
  if (!event) {
    event = createActivityEvent(activity.name || (activity.type === "error" ? "Error" : "Agent status"));
    event.dataset.name = activity.name || "";
    event.dataset.tool = String(isTool);
    if (activity.callId) event.dataset.callId = activity.callId;
    events.append(event);
  }
  const interrupted = activity.status === "interrupted";
  const failed = activity.type === "error" || (activity.type === "tool_end" && (activity.status === "failed" || (!activity.status && (activity.data?.error || activity.data?.success === false || (typeof activity.data?.exitCode === "number" && activity.data.exitCode !== 0)))));
  event.dataset.running = String(activity.type === "tool_start");
  event.classList.toggle("error", Boolean(failed || interrupted));
  const stateLabel = interrupted ? "Interrupted" : failed ? "Failed" : activity.type === "tool_start" ? "Running" : isTool ? "Done" : "Info";
  event.querySelector(".activity-state").textContent = `${stateLabel}${typeof activity.durationMs === "number" ? ` · ${(activity.durationMs / 1000).toFixed(1)}s` : ""}`;
  const part = activity.type === "tool_start" ? "input" : "output";
  const output = isTool && event.querySelector(`pre[data-part="${part}"]`) || document.createElement("pre");
  if (isTool) output.dataset.part = part;
  const rendered = typeof activity.data === "string" ? activity.data : JSON.stringify(activity.data ?? "", null, 2);
  output.textContent = `${isTool ? activity.type === "tool_start" ? "Input\n" : "Output\n" : ""}${rendered.length > 8000 ? `${rendered.slice(0, 8000)}\n…` : rendered}`;
  event.append(output);
  if (activity.type === "error") {
    const notice = item.querySelector(".message-notice");
    notice.textContent = typeof activity.data === "string" ? activity.data : "Something went wrong. Open the activity for details.";
    notice.classList.remove("hidden");
  }
  const count = [...events.children].filter((entry) => entry.dataset.tool === "true").length;
  group.querySelector(".tool-activity-count").textContent = count ? `${count} ${count === 1 ? "call" : "calls"}` : "";
  group.querySelector(".tool-activity-label").textContent = events.querySelector('[data-running="true"]') ? "Using tools…" : "Tool activity";
  scrollMessages();
}

function renderWorker(item, worker) {
  let group = item.querySelector(".workers");
  if (!group) {
    group = document.createElement("div");
    group.className = "workers";
    group.setAttribute("aria-label", "Sub-agents");
    item.querySelector(".message-content").before(group);
  }
  let card = [...group.children].find((entry) => entry.dataset.workerId === worker.id);
  if (!card) {
    card = document.createElement("details");
    card.className = "worker-card";
    card.dataset.workerId = worker.id;
    group.append(card);
  }
  const open = card.open;
  card.replaceChildren();
  card.open = open;
  card.dataset.workerStatus = worker.status;
  const heading = document.createElement("summary");
  const title = document.createElement("span");
  title.className = "worker-title";
  title.textContent = worker.task;
  const badge = document.createElement("span");
  badge.className = "worker-status";
  badge.textContent = worker.status[0].toUpperCase() + worker.status.slice(1);
  heading.append(title, badge);
  card.append(heading);
  const body = document.createElement("div");
  body.className = "worker-body";
  const meta = document.createElement("p");
  meta.className = "worker-meta";
  meta.dataset.model = `${worker.model.provider === "openai" ? "OpenAI" : "Gemini"} · ${worker.model.model}`;
  meta.dataset.startedAt = worker.startedAt || "";
  meta.dataset.endedAt = worker.endedAt || "";
  meta.dataset.tokens = worker.stats.totalTokens.toLocaleString();
  updateWorkerTime(meta);
  body.append(meta);
  const description = document.createElement("p");
  description.textContent = worker.error || worker.result?.summary || worker.activity;
  body.append(description);
  if (worker.result?.output) {
    const output = document.createElement("div");
    output.className = "worker-output";
    renderMarkdown(output, worker.result.output);
    body.append(output);
  }
  for (const artifact of worker.result?.artifacts || []) {
    const link = document.createElement("a");
    link.className = "worker-artifact";
    link.textContent = artifact.description || artifact.path;
    link.href = `/api/chats/${worker.parentId}/files/${artifact.path.split("/").map(encodeURIComponent).join("/")}?download=1`;
    body.append(link);
  }
  if (worker.result?.limitations.length) {
    const limitations = document.createElement("p");
    limitations.className = "muted";
    limitations.textContent = `Limitations: ${worker.result.limitations.join("; ")}`;
    body.append(limitations);
  }
  if (["queued", "running"].includes(worker.status)) {
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "secondary";
    cancel.textContent = "Stop worker";
    cancel.addEventListener("click", async () => {
      cancel.disabled = true;
      try {
        const response = await fetch(`/api/chats/${worker.parentId}/agents/${worker.id}/cancel`, { method: "POST" });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Could not stop worker.");
        renderWorker(item, result);
      } catch (error) {
        cancel.disabled = false;
        description.textContent = error.message;
      }
    });
    body.append(cancel);
  }
  card.append(body);
  scrollMessages();
}

function updateWorkerTime(meta) {
  const elapsed = meta.dataset.startedAt ? Math.max(0, Math.round(((meta.dataset.endedAt ? new Date(meta.dataset.endedAt).getTime() : Date.now()) - new Date(meta.dataset.startedAt).getTime()) / 1000)) : 0;
  meta.textContent = `${meta.dataset.model} · ${elapsed}s · ${meta.dataset.tokens} tokens`;
}

setInterval(() => {
  for (const meta of messages.querySelectorAll('.worker-meta[data-ended-at=""]')) updateWorkerTime(meta);
}, 1000);

function finishActivity(item) {
  for (const event of item.querySelectorAll('[data-running="true"]')) {
    event.dataset.running = "false";
    event.querySelector(".activity-state").textContent = "Interrupted";
  }
  item.querySelector(".tool-activity-label").textContent = "Tool activity";
  item.classList.remove("is-working");
}

function createActivityEvent(label) {
  const event = document.createElement("details");
  event.className = "activity-event";
  const summary = document.createElement("summary");
  const labelElement = document.createElement("span");
  labelElement.className = "activity-label";
  labelElement.textContent = label;
  const stateElement = document.createElement("span");
  stateElement.className = "activity-state";
  summary.append(labelElement, stateElement);
  event.append(summary);
  return event;
}

function clearBrowserPreview() {
  setBrowserAvailable(false);
  browserPreviewImage.removeAttribute("src");
  browserPreviewStatus.textContent = "Waiting";
  browserPreviewUrl.removeAttribute("href");
  browserPreviewUrl.textContent = "";
}

function connectBrowserEvents() {
  browserEvents?.close();
  if (!state.chatId) return;
  browserEvents = new EventSource(`/api/chats/${state.chatId}/browser/events`);
  browserEvents.onmessage = (event) => renderBrowserPreview(JSON.parse(event.data));
}

async function controlBrowser(action) {
  if (state.running) throw new Error("Wait for the agent to finish before taking control.");
  const response = await fetch(`/api/chats/${state.chatId}/browser/control`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(action),
  });
  if (!response.ok) throw new Error((await response.json()).error || "Browser control failed");
}

function setBrowserControl(enabled) {
  browserControlEnabled = enabled;
  browserControlToggle.textContent = enabled ? "Release control" : "Take control";
  browserControlToggle.classList.toggle("active", enabled);
  browserControlPanel.classList.toggle("hidden", !enabled);
  browserControlHint.classList.toggle("hidden", !enabled);
  browserPreview.classList.toggle("is-controlling", enabled);
}

function previewCoordinates(event) {
  const rect = browserPreviewImage.getBoundingClientRect();
  const ratio = browserPreviewImage.naturalWidth / browserPreviewImage.naturalHeight;
  const boxRatio = rect.width / rect.height;
  const contentWidth = boxRatio > ratio ? rect.height * ratio : rect.width;
  const contentHeight = boxRatio > ratio ? rect.height : rect.width / ratio;
  const offsetX = rect.left + (rect.width - contentWidth) / 2;
  const offsetY = rect.top + (rect.height - contentHeight) / 2;
  const x = event.clientX - offsetX;
  const y = event.clientY - offsetY;
  if (x < 0 || y < 0 || x > contentWidth || y > contentHeight) return null;
  return {
    x: x * browserPreviewImage.naturalWidth / contentWidth,
    y: y * browserPreviewImage.naturalHeight / contentHeight,
  };
}

async function createChat(workspaceId) {
  if (state.running || state.voiceMode !== "idle" || state.creatingChat || state.changingModel || state.loadingChat) return;
  state.creatingChat = true;
  updateComposer();
  $("#start-chat").disabled = true;
  try {
    const response = await fetch("/api/chats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId, model: getSelectedModel() }),
    });
    const chat = await response.json();
    if (!response.ok) throw new Error(chat.error || "Could not create chat.");
    renderContext(null);
    state.chatId = chat.id;
    setModelChat(chat.id, chat.model);
    state.archivedAt = null;
    showArchivedChats = false;
    state.workspaceId = chat.workspaceId ?? chat.id;
    setCommandChat(state.chatId);
    setAuditChat(state.chatId);
    setNflGamesChat(state.chatId, state.workspaceId);
    setRosterChat(state.chatId, state.workspaceId);
    setMatchupChat(state.chatId, state.workspaceId);
    setWaiverChat(state.chatId, state.workspaceId);
    setPanelWorkspace(state.workspaceId);
    localStorage.setItem("sandbox-harness-chat", chat.id);
    localStorage.setItem("sandbox-harness-sport", state.workspaceId);
    localStorage.setItem(`sandbox-harness-chat-${state.workspaceId}`, chat.id);
    $("#chat-id").textContent = chat.id.slice(0, 8);
    $("#workspace-name").textContent = chat.workspaceName || (state.workspaceId === "shared" ? "Shared workspace" : `Workspace ${state.workspaceId.slice(0, 8)}`);
    messages.replaceChildren();
    state.currentAssistant = null;
    prompt.value = "";
    resizePrompt();
    clearBrowserPreview();
    setBrowserControl(false);
    connectBrowserEvents();
    await refreshFiles();
    closeHistory();
    $("#new-chat-dialog").close();
    void refreshHistory();
  } finally {
    state.creatingChat = false;
    updateComposer();
    $("#start-chat").disabled = false;
  }
}

async function chooseWorkspace() {
  if (state.running || state.voiceMode !== "idle" || state.creatingChat || state.changingModel) return;
  try {
    const response = await fetch("/api/workspaces");
    if (!response.ok) throw new Error("Could not load workspaces.");
    const workspaces = await response.json();
    const select = $("#new-chat-workspace");
    select.replaceChildren();
    const newOption = document.createElement("option");
    newOption.value = "";
    newOption.disabled = true;
    newOption.textContent = "Choose NFL or NBA";
    select.append(newOption);
    for (const workspace of workspaces) {
      const option = document.createElement("option");
      option.value = workspace.id;
      option.textContent = workspace.name;
      select.append(option);
    }
    select.value = state.workspaceId;
    if (!select.value) select.value = "";
    $("#new-chat-error").textContent = "";
    $("#new-chat-dialog").showModal();
  } catch (error) {
    showComposerError(error.message || String(error));
  }
}

function chatLabel(chat) {
  const firstUserMessage = chat.messages?.find((message) => message.role === "user")?.text;
  return firstUserMessage?.replaceAll(/\s+/g, " ").trim() || "New chat";
}

async function switchSport(sport) {
  if (!["nfl", "nba"].includes(sport) || state.workspaceId === sport || state.running || state.voiceMode !== "idle" || state.creatingChat || state.switchingSport || state.changingModel || state.loadingChat) return;
  state.switchingSport = true;
  updateComposer();
  try {
    const response = await fetch("/api/chats");
    if (!response.ok) throw new Error("Could not switch sports. Please try again.");
    const chats = (await response.json()).filter(chat => chat.workspaceId === sport);
    const savedId = localStorage.getItem(`sandbox-harness-chat-${sport}`);
    const target = chats.find(chat => chat.id === savedId) ?? chats[0];
    sportDrafts.set(state.chatId || state.workspaceId, prompt.value);
    state.chatId = target?.id ?? null;
    state.workspaceId = sport;
    showArchivedChats = false;
    localStorage.setItem("sandbox-harness-sport", sport);
    if (target) localStorage.setItem("sandbox-harness-chat", target.id); else localStorage.removeItem("sandbox-harness-chat");
    clearBrowserPreview(); setBrowserControl(false); browserEvents?.close(); closeHistory();
    prompt.value = sportDrafts.get(target?.id ?? sport) ?? "";
    resizePrompt();
    await loadChat();
  } catch (error) { showComposerError(error.message || String(error)); }
  finally { state.switchingSport = false; updateComposer(); }
}

function formatChatDate(value) {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

async function refreshHistory() {
  const request = ++historyRequest;
  const sport = state.workspaceId;
  const archived = showArchivedChats;
  const scope = `${sport}:${archived}`;
  if (historyList.dataset.scope !== scope) {
    historyList.dataset.scope = scope;
    historyList.textContent = "Loading chats…";
  }
  historyList.setAttribute("aria-busy", "true");
  $("#history-error").textContent = "";
  document.querySelectorAll("[data-history-archived]").forEach(button => button.setAttribute("aria-pressed", String((button.dataset.historyArchived === "true") === archived)));
  try {
    const response = await fetch(`/api/chats?archived=${archived}`);
    const result = await response.json();
    if (request !== historyRequest || sport !== state.workspaceId || archived !== showArchivedChats) return;
    if (!response.ok) throw new Error("Could not load chats. Reopen Chats to retry.");
    const chats = result.filter(chat => !["nfl", "nba"].includes(sport) || chat.workspaceId === sport);
    const focusedChat = historyList.contains(document.activeElement) ? document.activeElement.closest(".history-row")?.dataset.chatId : null;
    historyList.replaceChildren();
    if (!chats.length) {
      historyList.textContent = archived ? "No archived chats." : "No chats yet. Start a new chat.";
      return;
    }
    for (const chat of chats) {
      const row = document.createElement("div");
      row.className = "history-row";
      row.dataset.chatId = chat.id;
      const item = document.createElement("button");
      item.type = "button";
      item.className = "history-item";
      item.classList.toggle("current", chat.id === state.chatId);
      if (chat.id === state.chatId) item.setAttribute("aria-current", "page");
      const title = document.createElement("span");
      title.className = "history-item-title";
      title.textContent = `${sport || !chat.workspaceId ? "" : `${chat.workspaceId.toUpperCase()} · `}${chatLabel(chat)}`;
      item.title = title.textContent;
      const date = document.createElement("span");
      date.className = "history-item-date";
      date.textContent = formatChatDate(chat.createdAt);
      item.append(title, date);
      item.addEventListener("click", async () => {
        if (state.changingChat || state.changingModel || state.running || state.voiceMode !== "idle" || state.creatingChat || state.switchingSport || state.loadingChat || chat.id === state.chatId) return closeHistory();
        state.changingChat = true;
        updateComposer();
        try {
          sportDrafts.set(state.chatId || state.workspaceId, prompt.value);
          state.chatId = chat.id;
          localStorage.setItem("sandbox-harness-chat", chat.id);
          clearBrowserPreview();
          setBrowserControl(false);
          prompt.value = sportDrafts.get(chat.id) ?? "";
          resizePrompt();
          closeHistory();
          await loadChat();
        } catch (error) { showComposerError(error.message || String(error)); }
        finally { state.changingChat = false; updateComposer(); }
      });
      const menu = document.createElement("details");
      menu.className = "history-menu";
      const menuToggle = document.createElement("summary");
      menuToggle.textContent = "···";
      menuToggle.setAttribute("aria-label", `Chat options: ${chatLabel(chat)}`);
      menuToggle.title = "Chat options";
      const archive = document.createElement("button");
      archive.type = "button"; archive.className = "secondary history-action";
      archive.textContent = chat.archivedAt ? "Restore" : "Archive";
      archive.setAttribute("aria-label", `${archive.textContent} chat: ${chatLabel(chat)}`);
      archive.addEventListener("click", () => { menu.open = false; void archiveChat(chat, !chat.archivedAt); });
      const remove = document.createElement("button");
      remove.type = "button"; remove.className = "secondary history-action danger";
      remove.textContent = "Delete";
      remove.setAttribute("aria-label", `Delete chat: ${chatLabel(chat)}`);
      remove.addEventListener("click", () => { menu.open = false; void showDeleteChat(chat); });
      const actions = document.createElement("div"); actions.className = "history-row-actions";
      actions.append(archive, remove);
      menu.append(menuToggle, actions);
      row.append(item, menu);
      historyList.append(row);
      if (chat.id === focusedChat) item.focus({ preventScroll: true });
    }
  } catch (error) {
    if (request === historyRequest && sport === state.workspaceId && archived === showArchivedChats) {
      $("#history-error").textContent = error.message || "Could not load chats.";
      if (historyList.textContent === "Loading chats…") historyList.replaceChildren();
    }
  } finally {
    if (request === historyRequest) historyList.setAttribute("aria-busy", "false");
  }
}

function forgetChatSelection(chat) {
  sportDrafts.delete(chat.id);
  for (const key of ["sandbox-harness-chat", `sandbox-harness-chat-${chat.workspaceId}`]) {
    if (localStorage.getItem(key) === chat.id) localStorage.removeItem(key);
  }
}

async function archiveChat(chat, archived) {
  if (state.changingChat || state.changingModel || state.running || state.voiceMode !== "idle") return;
  state.changingChat = true; updateComposer();
  $("#history-error").textContent = "";
  try {
    const response = await fetch(`/api/chats/${chat.id}/archive`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ archived }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not update chat.");
    if (archived) forgetChatSelection(chat);
    if (state.chatId === chat.id) {
      if (archived) {
        state.chatId = null; prompt.value = ""; resizePrompt();
        clearBrowserPreview(); setBrowserControl(false); browserEvents?.close();
      }
      await loadChat();
    }
    await refreshHistory();
  } catch (error) { $("#history-error").textContent = error.message || String(error); showComposerError(error.message || String(error)); }
  finally { state.changingChat = false; updateComposer(); }
}

async function showDeleteChat(chat) {
  if (state.changingChat || state.changingModel || state.running || state.voiceMode !== "idle") return;
  deletingChat = chat;
  deletePreviewRequest?.abort();
  const controller = new AbortController(); deletePreviewRequest = controller;
  $("#delete-chat-name").textContent = chatLabel(chat);
  $("#delete-chat-scope").textContent = "Loading deletion details…";
  $("#delete-chat-error").textContent = "";
  $("#delete-chat-search").value = "";
  $("#delete-chat-files").replaceChildren();
  $("#delete-chat-research").hidden = true;
  $("#delete-chat-count").textContent = "No shared files selected.";
  $("#confirm-delete-chat").disabled = true;
  $("#delete-chat-dialog").showModal();
  try {
    const response = await fetch(`/api/chats/${chat.id}/deletion`, { signal: controller.signal, cache: "no-store" });
    const data = await response.json();
    if (controller.signal.aborted) return;
    if (!response.ok) throw new Error(data.error || "Could not load deletion details.");
    $("#delete-chat-scope").textContent = data.sharedWorkspace
      ? "Research is shared across this sport's chats. Select only the files you want to remove for everyone. These files are not automatically attributed to this chat. Unselected shared files and the NFL game database stay saved."
      : "This chat has a private workspace. Its research files will also be deleted. Shared sport workspaces and the NFL game database stay saved.";
    $("#delete-chat-research").hidden = !data.sharedWorkspace;
    for (const file of data.files) {
      const label = document.createElement("label"); label.className = "delete-chat-file";
      const input = document.createElement("input"); input.type = "checkbox"; input.value = file.path;
      const name = document.createElement("span"); name.textContent = `${file.path} · ${formatBytes(file.size)}`;
      label.append(input, name); $("#delete-chat-files").append(label);
    }
    if (data.sharedWorkspace && !data.files.length) $("#delete-chat-files").textContent = "No shared research files available.";
    $("#confirm-delete-chat").disabled = false;
  } catch (error) { if (!controller.signal.aborted) $("#delete-chat-error").textContent = error.message || String(error); }
}

$("#delete-chat-search").addEventListener("input", () => {
  const query = $("#delete-chat-search").value.trim().toLowerCase();
  $("#delete-chat-files").querySelectorAll("label").forEach(label => { label.hidden = !label.textContent.toLowerCase().includes(query); });
});
$("#delete-chat-files").addEventListener("change", () => {
  const selected = $("#delete-chat-files").querySelectorAll("input:checked");
  $("#delete-chat-count").textContent = selected.length ? `${selected.length} shared ${selected.length === 1 ? "file" : "files"} selected for deletion.${selected.length > 100 ? " Select at most 100." : ""}` : "No shared files selected.";
  $("#confirm-delete-chat").disabled = selected.length > 100;
});
$("#cancel-delete-chat").addEventListener("click", () => $("#delete-chat-dialog").close());
$("#delete-chat-dialog").addEventListener("cancel", event => { if (state.changingChat) event.preventDefault(); });
$("#delete-chat-dialog").addEventListener("close", () => { deletePreviewRequest?.abort(); deletingChat = null; });
$("#delete-chat-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (!deletingChat || state.changingChat || state.changingModel || $("#confirm-delete-chat").disabled) return;
  const chat = deletingChat;
  const researchFiles = [...$("#delete-chat-files").querySelectorAll("input:checked")].map(input => input.value);
  state.changingChat = true; updateComposer();
  $("#confirm-delete-chat").disabled = true; $("#cancel-delete-chat").disabled = true;
  $("#delete-chat-error").textContent = "Deleting…";
  $("#delete-chat-research").inert = true;
  try {
    const response = await fetch(`/api/chats/${chat.id}`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: true, researchFiles }) });
    if (!response.ok) throw new Error((await response.json()).error || "Could not delete chat.");
    forgetChatSelection(chat);
    $("#delete-chat-dialog").close();
    if (state.chatId === chat.id) {
      state.chatId = null; prompt.value = ""; resizePrompt();
      clearBrowserPreview(); setBrowserControl(false); browserEvents?.close();
      await loadChat();
    }
    await refreshHistory();
  } catch (error) { $("#delete-chat-error").textContent = error.message || String(error); showComposerError(error.message || String(error)); }
  finally {
    state.changingChat = false; updateComposer();
    $("#confirm-delete-chat").disabled = false; $("#cancel-delete-chat").disabled = false; $("#delete-chat-research").inert = false;
  }
});

function setHistoryOpen(open) {
  historyDrawer.classList.toggle("open", open);
  document.body.classList.toggle("has-history", open);
  historyBackdrop.classList.toggle("hidden", !open || !narrowHistory.matches);
  historyDrawer.setAttribute("aria-hidden", String(!open));
  historyDrawer.inert = !open;
  document.querySelector("main").inert = open && narrowHistory.matches;
  document.querySelector(".workspace-navigation").inert = open && narrowHistory.matches;
  historyToggle.setAttribute("aria-expanded", String(open));
  if (!open && historyDrawer.contains(document.activeElement)) {
    const selectedPanel = document.querySelector('.panel-navigation [aria-expanded="true"]');
    (selectedPanel && matchMedia("(max-width: 1199px)").matches ? selectedPanel : historyToggle).focus();
  }
}

function closeHistory() {
  if (narrowHistory.matches) setHistoryOpen(false);
}

function toggleHistory() {
  const open = !historyDrawer.classList.contains("open");
  setHistoryOpen(open);
  if (open) {
    void refreshHistory();
    if (narrowHistory.matches) $("#history-close").focus();
  }
}

async function loadChat() {
  state.loadingChat = true;
  updateComposer();
  let loaded = false;
  try { await loadChatData(); loaded = true; }
  finally { state.loadingChat = !loaded; updateComposer(); }
}

async function loadChatData() {
  state.archivedAt = null;
  setCommandChat(null);
  renderContext(null);
  setAuditChat(null);
  setNflGamesChat(null, "");
  setRosterChat(null, "");
  setMatchupChat(null, "");
  setWaiverChat(null, "");
  setPanelWorkspace("");
  $("#files").replaceChildren();
  $("#files-error").textContent = "";
  runEvents?.close();
  if (!state.chatId) {
    setModelChat(null);
    if (!["nfl", "nba"].includes(state.workspaceId)) { void refreshHistory(); return chooseWorkspace(); }
    messages.replaceChildren(); state.currentAssistant = null;
    $("#chat-id").textContent = ""; $("#workspace-name").textContent = state.workspaceId.toUpperCase();
    setNflGamesChat(null, state.workspaceId); setRosterChat(null, state.workspaceId); setWaiverChat(null, state.workspaceId); setPanelWorkspace(state.workspaceId);
    setMatchupChat(null, state.workspaceId);
    setRunning(false);
    void refreshHistory();
    return;
  }
  const response = await fetch(`/api/chats/${state.chatId}`);
  if (response.status === 404) {
    state.chatId = null;
    localStorage.removeItem("sandbox-harness-chat");
    return loadChat();
  }
  if (!response.ok) throw new Error("Could not load chat. Reload the page to try again.");
  const chat = await response.json();
  state.archivedAt = chat.archivedAt ?? null;
  setModelChat(chat.id, chat.activeRun?.model ?? chat.model);
  void refreshProviderUsage();
  state.workspaceId = chat.workspaceId ?? chat.id;
  localStorage.setItem("sandbox-harness-sport", state.workspaceId);
  localStorage.setItem(`sandbox-harness-chat-${state.workspaceId}`, chat.id);
  setCommandChat(state.chatId);
  setAuditChat(state.chatId);
  setNflGamesChat(state.chatId, state.workspaceId);
  setRosterChat(state.chatId, state.workspaceId);
  setMatchupChat(state.chatId, state.workspaceId);
  setWaiverChat(state.chatId, state.workspaceId);
  setPanelWorkspace(state.workspaceId);
  void refreshHistory();
  $("#chat-id").textContent = chat.id.slice(0, 8);
  $("#workspace-name").textContent = chat.workspaceName || (state.workspaceId === "shared" ? "Shared workspace" : `Workspace ${state.workspaceId.slice(0, 8)}`);
  messages.replaceChildren();
  state.currentAssistant = null;
  chat.messages.forEach((message) => renderMessage(message));
  renderContext(chat.activeRun?.contextUsage ?? [...chat.messages].reverse().find(message => message.contextUsage)?.contextUsage);
  if (chat.activeRun) {
    state.currentAssistant = renderMessage(chat.activeRun, true);
    state.currentAssistant.classList.add("is-working");
    setRunning(true);
    reconnectRun();
  } else setRunning(false);
  const workerResponse = await fetch(`/api/chats/${state.chatId}/agents`);
  if (workerResponse.ok) {
    for (const worker of await workerResponse.json()) {
      const item = [...messages.children].find((entry) => entry.dataset.messageId === worker.parentRunId);
      if (item) renderWorker(item, worker);
    }
  }
  scrollMessages(true);
  if (!state.archivedAt) connectBrowserEvents(); else browserEvents?.close();
  await refreshFiles();
}

function applyRunEvent(event) {
  if (!state.currentAssistant) return;
  if (event.type === "context_usage") { setModelChat(state.chatId, { provider: event.data.provider, model: event.data.model }); renderContext(event.data); return; }
  if (event.type === "tool_start" && event.name?.startsWith("browser_")) showBrowserActivity();
  if (event.type === "text_delta") {
    state.currentAssistant.dataset.text += event.data;
    renderMarkdown(state.currentAssistant.querySelector(".message-content"), state.currentAssistant.dataset.text);
    scrollMessages();
  } else if (["tool_start", "tool_end", "status", "error", "agent_update"].includes(event.type)) renderActivity(state.currentAssistant, event);
  else if (event.type === "browser_frame") renderBrowserPreview(event.data);
  else if (event.type === "done") {
    if (event.data.model) setModelChat(state.chatId, event.data.model);
    state.currentAssistant.dataset.messageId = event.data.id;
    state.currentAssistant.dataset.text = event.data.text;
    renderMarkdown(state.currentAssistant.querySelector(".message-content"), event.data.text);
    finishActivity(state.currentAssistant);
  }
}

function reconnectRun() {
  runEvents?.close();
  runEvents = new EventSource(`/api/chats/${state.chatId}/events`);
  runEvents.onmessage = async ({ data }) => {
    const event = JSON.parse(data);
    if (event.type === "idle") {
      runEvents.close();
      try { await loadChat(); }
      catch { reconnectRun(); }
      return;
    }
    if (event.type === "snapshot") {
      state.currentAssistant?.remove();
      state.currentAssistant = renderMessage(event.data, true);
      state.currentAssistant.classList.add("is-working");
      setRunning(true);
      renderContext(event.data.contextUsage);
      return;
    }
    applyRunEvent(event);
    if (event.type === "done") {
      runEvents.close();
      setRunning(false);
      await refreshFiles();
    }
  };
  runEvents.onerror = () => { status.textContent = "Reconnecting…"; };
}

async function refreshFiles() {
  if (!state.chatId) return;
  const chatId = state.chatId;
  const requestId = ++filesRequest;
  const root = $("#files");
  const errorMessage = $("#files-error");
  errorMessage.textContent = "";
  let files;
  try {
    const response = await fetch(`/api/chats/${chatId}/files`);
    if (!response.ok) throw new Error("Could not load workspace files. Please refresh to try again.");
    files = await response.json();
  } catch (error) {
    if (state.chatId === chatId && requestId === filesRequest) errorMessage.textContent = error.message || "Could not load workspace files.";
    return;
  }
  if (state.chatId !== chatId || requestId !== filesRequest) return;
  files = files.filter(file => !file.path.startsWith(".harness/"));
  root.replaceChildren();
  if (!files.length) root.textContent = "No files yet.";
  files.forEach((file) => {
    const row = document.createElement("div");
    row.className = "file";
    const url = `/api/chats/${chatId}/files/${file.path.split("/").map(encodeURIComponent).join("/")}`;
    const link = document.createElement("a");
    link.className = "file-name";
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = file.path === "LEAGUE.md" ? "League settings" : file.path;
    link.title = file.path;
    const size = document.createElement("span");
    size.className = "file-size";
    size.textContent = formatBytes(file.size);
    const actions = document.createElement("div");
    actions.className = "file-actions";
    const download = document.createElement("a");
    download.className = "file-action";
    download.href = `${url}?download=1`;
    download.download = file.path.split("/").pop();
    download.textContent = "Download";
    download.setAttribute("aria-label", `Download ${file.path}`);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "file-action file-delete";
    remove.textContent = "Delete";
    remove.setAttribute("aria-label", `Delete ${file.path}`);
    remove.addEventListener("click", async () => {
      if (state.chatId !== chatId || !confirm(`Delete “${file.path}” from this workspace? This cannot be undone.`)) return;
      remove.disabled = true;
      remove.textContent = "Deleting…";
      errorMessage.textContent = "";
      try {
        const response = await fetch(url, { method: "DELETE" });
        if (!response.ok) {
          const result = await response.json().catch(() => ({}));
          throw new Error(result.error || "Could not delete this file. Please try again.");
        }
        if (state.chatId === chatId) {
          row.remove();
          await refreshFiles();
        }
      } catch (error) {
        if (state.chatId === chatId) errorMessage.textContent = error.message || "Could not delete this file.";
      } finally {
        remove.disabled = false;
        remove.textContent = "Delete";
      }
    });
    actions.append(download, remove);
    row.append(link, size, actions);
    root.append(row);
  });
}

async function uploadSelectedFiles() {
  const input = $("#file-input");
  for (const file of input.files) {
    const data = new FormData();
    data.append("file", file);
    status.textContent = `Uploading ${file.name}…`;
    const response = await fetch(`/api/chats/${state.chatId}/upload`, { method: "POST", body: data });
    if (!response.ok) throw new Error(`Could not upload ${file.name}`);
  }
  input.value = "";
  await refreshFiles();
}

function setRunning(running) {
  if (!running && state.running) { void refreshHistory(); void refreshProviderUsage(); }
  if (!running && state.running && !document.querySelector("#league-matchup").classList.contains("hidden")) void refreshMatchupView();
  if (!running && state.running && !document.querySelector("#league-waivers").classList.contains("hidden")) void refreshWaivers();
  if (!running && state.running) void refreshRosterView();
  setCommandsBusy(running);
  if (!running && state.running) void refreshCommands();
  if (!running) settleContext();
  if (running && !state.running) resetBrowserActivity();
  state.running = running;
  updateComposer();
  stop.classList.toggle("hidden", !running);
  status.textContent = running ? "Agent is working…" : "Ready";
  browserControlToggle.disabled = running;
  if (running) setBrowserControl(false);
}

function updateComposer() {
  const voiceBusy = state.voiceMode !== "idle";
  const readOnly = Boolean(state.archivedAt) || state.changingChat || state.changingModel || state.loadingChat;
  setModelBusy(state.running || voiceBusy || readOnly || state.creatingChat || state.switchingSport);
  setCommandsBusy(state.running || voiceBusy || readOnly);
  $("#archived-chat").hidden = !state.archivedAt;
  $("#restore-current-chat").disabled = state.changingChat || state.changingModel;
  prompt.disabled = readOnly;
  setRosterBusy(state.running || voiceBusy || readOnly);
  setMatchupBusy(state.running || voiceBusy || readOnly);
  setWaiverBusy(state.running || voiceBusy || readOnly);
  document.querySelectorAll("[data-sport]").forEach(button => { button.disabled = state.running || voiceBusy || state.creatingChat || state.switchingSport || state.changingChat || state.changingModel || state.loadingChat; });
  send.disabled = state.running || voiceBusy || readOnly || !prompt.value.trim();
  send.classList.toggle("hidden", state.running);
  voice.disabled = readOnly || state.running || Boolean(voiceUnavailable) || ["starting", "transcribing"].includes(state.voiceMode);
  voice.title = voiceUnavailable || (state.voiceMode === "recording" ? "Stop recording and transcribe" : "Start voice input");
  voice.setAttribute("aria-label", voice.title);
  voice.setAttribute("aria-pressed", String(state.voiceMode === "recording"));
  voice.classList.toggle("is-recording", state.voiceMode === "recording");
  voice.querySelector(".mic-icon").classList.toggle("hidden", state.voiceMode === "recording");
  voice.querySelector(".recording-stop").classList.toggle("hidden", state.voiceMode !== "recording");
  voiceCancel.classList.toggle("hidden", !voiceBusy);
  $("#new-chat").disabled = state.running || voiceBusy || state.creatingChat || state.switchingSport || state.changingChat || state.changingModel || state.loadingChat;
  historyToggle.disabled = false;
  historyList.inert = state.changingChat || state.changingModel || state.running || voiceBusy || state.creatingChat || state.switchingSport || state.loadingChat;
  $("#file-input").disabled = state.running || voiceBusy || readOnly;
}

function resizePrompt() {
  prompt.style.height = "auto";
  prompt.style.height = `${Math.min(prompt.scrollHeight, 200)}px`;
  updateComposer();
}

function showComposerError(message = "") {
  $("#composer-error").textContent = message;
  $("#composer-error").classList.toggle("hidden", !message);
}

async function configureVoice() {
  if (!window.isSecureContext) voiceUnavailable = "Voice input needs HTTPS or localhost. Open this app on localhost to use your microphone.";
  else if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) voiceUnavailable = "This browser does not support voice recording.";
  else {
    try {
      const response = await fetch("/api/transcription");
      if (!response.ok) throw new Error();
      voiceUnavailable = (await response.json()).enabled ? "" : "Add OPENAI_API_KEY to .env and restart the server to enable voice input.";
    } catch {
      voiceUnavailable = "Voice input is unavailable. Reload to try again.";
    }
  }
  $("#composer-hint").textContent = voiceUnavailable || "Enter to send · Shift + Enter for a new line · Mic to dictate";
  updateComposer();
}

function releaseRecording(session) {
  clearInterval(session.timer);
  clearTimeout(session.limit);
  session.stream?.getTracks().forEach((track) => track.stop());
}

function cancelRecording() {
  if (!recording) return;
  const session = recording;
  session.cancelled = true;
  session.controller.abort();
  if (session.recorder?.state === "recording") session.recorder.stop();
  releaseRecording(session);
  recording = null;
  state.voiceMode = "idle";
  status.textContent = "Ready";
  updateComposer();
}

async function startRecording() {
  if (state.running || state.voiceMode !== "idle" || voiceUnavailable) return;
  showComposerError();
  const session = { cancelled: false, controller: new AbortController(), chunks: [], size: 0 };
  recording = session;
  state.voiceMode = "starting";
  status.textContent = "Waiting for microphone…";
  updateComposer();
  try {
    session.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (session.cancelled) return releaseRecording(session);
    const mimeType = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find((type) => MediaRecorder.isTypeSupported(type));
    if (!mimeType) throw new Error("This browser cannot record a supported audio format. Try Chrome or Safari.");
    session.recorder = new MediaRecorder(session.stream, { mimeType });
    session.recorder.addEventListener("dataavailable", (event) => {
      if (session.cancelled || !event.data.size) return;
      session.chunks.push(event.data);
      session.size += event.data.size;
      if (session.size > 24_000_000) {
        cancelRecording();
        showComposerError("The recording is too large. Please record a shorter message.");
      }
    });
    session.recorder.addEventListener("error", () => {
      if (recording !== session || session.cancelled) return;
      cancelRecording();
      showComposerError("Microphone recording failed. Please try again.");
    });
    session.recorder.addEventListener("stop", () => transcribeRecording(session));
    session.recorder.start(1000);
    state.voiceMode = "recording";
    const startedAt = Date.now();
    status.textContent = "Recording · 0:00";
    session.timer = setInterval(() => {
      const seconds = Math.floor((Date.now() - startedAt) / 1000);
      status.textContent = `Recording · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
    }, 1000);
    session.limit = setTimeout(() => session.recorder.state === "recording" && session.recorder.stop(), 5 * 60_000);
    updateComposer();
  } catch (error) {
    releaseRecording(session);
    if (session.cancelled) return;
    cancelRecording();
    showComposerError(error.name === "NotAllowedError" ? "Microphone access was denied. Allow it in your browser's site settings and try again."
      : error.name === "NotFoundError" ? "No microphone found. Connect a microphone and try again."
      : error.message || "Could not start the microphone.");
  }
}

async function transcribeRecording(session) {
  releaseRecording(session);
  if (session.cancelled) return;
  state.voiceMode = "transcribing";
  status.textContent = "Transcribing…";
  updateComposer();
  try {
    const audio = new Blob(session.chunks, { type: session.recorder.mimeType });
    if (!audio.size) throw new Error("The recording was empty. Please try again.");
    const data = new FormData();
    data.append("file", audio, session.recorder.mimeType.includes("mp4") ? "recording.mp4" : "recording.webm");
    const response = await fetch("/api/transcription", { method: "POST", body: data, signal: session.controller.signal });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || result.message || "Could not transcribe the recording.");
    if (!result.text?.trim()) throw new Error("No speech was detected. Please try again.");
    if (session.cancelled) return;
    prompt.value += `${prompt.value && !/\s$/.test(prompt.value) ? " " : ""}${result.text.trim()}`;
    resizePrompt();
    prompt.focus();
  } catch (error) {
    if (!session.cancelled) showComposerError(error instanceof TypeError
      ? "Could not reach the transcription server. Check the connection and record again."
      : error.message || "Could not transcribe the recording.");
  } finally {
    if (recording === session) {
      recording = null;
      state.voiceMode = "idle";
      status.textContent = "Ready";
      updateComposer();
    }
  }
}

function renderBrowserPreview(preview) {
  setBrowserAvailable(true);
  browserPreviewImage.src = preview.image;
  browserPreviewImage.alt = preview.title ? `Live browser preview: ${preview.title}` : "Live browser preview";
  browserPreviewStatus.textContent = preview.title || "Browsing";
  browserPreviewUrl.href = preview.url;
  browserPreviewUrl.textContent = preview.url;
}

async function run(text) {
  setRunning(true);
  state.currentAssistant = renderMessage({ role: "assistant", text: "" });
  state.currentAssistant.classList.add("is-working");
  scrollMessages(true);
  let completed = false;
  try {
    const response = await fetch(`/api/chats/${state.chatId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!response.ok) throw new Error((await response.json()).error || "Could not start run");
    void refreshHistory();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop();
      for (const chunk of chunks) {
        if (!chunk.startsWith("data: ")) continue;
        const event = JSON.parse(chunk.slice(6));
        applyRunEvent(event);
        if (event.type === "done") completed = true;
      }
    }
  } catch (error) {
    appendActivity("Error", error.message || String(error));
  } finally {
    if (!completed) {
      status.textContent = "Reconnecting…";
      reconnectRun();
    }
    else {
      finishActivity(state.currentAssistant);
      setRunning(false);
      await refreshFiles();
    }
  }
}

$("#composer").addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = prompt.value.trim();
  if (!text || state.running || state.voiceMode !== "idle" || state.archivedAt || state.changingChat || state.changingModel || state.loadingChat) return;
  if (!state.chatId) {
    if (!["nfl", "nba"].includes(state.workspaceId)) return chooseWorkspace();
    try { await createChat(state.workspaceId); }
    catch (error) { showComposerError(error.message || String(error)); return; }
  }
  showComposerError();
  renderContext(null, true);
  setRunning(true);
  try {
    await uploadSelectedFiles();
    renderMessage({ role: "user", text });
    prompt.value = "";
    resizePrompt();
    await run(text);
  } catch (error) {
    showComposerError(error.message || String(error));
    setRunning(false);
  }
});

document.addEventListener("chat-model-saving", event => {
  state.changingModel = event.detail;
  updateComposer();
});
document.addEventListener("chat-model-changed", event => {
  if (event.detail.chatId !== state.chatId) return;
  clearBrowserPreview();
  setBrowserControl(false);
});

document.addEventListener("roster-chat-draft", event => {
  if (event.detail.chatId !== state.chatId || state.running || state.voiceMode !== "idle" || state.archivedAt || state.changingChat || state.changingModel || state.loadingChat) return;
  prompt.value = `${prompt.value.trim() ? `${prompt.value.trim()}\n\n` : ""}${event.detail.text}`;
  prompt.dispatchEvent(new Event("input", { bubbles: true }));
  closePanel();
  prompt.focus();
});
document.addEventListener("league-data-refreshed", event => {
  if (event.detail.chatId !== state.chatId) return;
  void refreshRosterView();
  if (!document.querySelector("#league-waivers").classList.contains("hidden")) void refreshWaivers();
  void refreshFiles();
});

prompt.addEventListener("input", resizePrompt);
prompt.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault();
    $("#composer").requestSubmit();
  }
});
voice.addEventListener("click", () => {
  if (state.voiceMode === "recording") {
    if (recording.recorder.state === "recording") recording.recorder.stop();
  } else startRecording();
});
voiceCancel.addEventListener("click", cancelRecording);
window.addEventListener("pagehide", cancelRecording);

stop.addEventListener("click", () => fetch(`/api/chats/${state.chatId}/stop`, { method: "POST" }));
$("#new-chat").addEventListener("click", () => {
  if (["nfl", "nba"].includes(state.workspaceId)) void createChat(state.workspaceId).catch(error => showComposerError(error.message || String(error)));
  else void chooseWorkspace();
});
document.querySelectorAll("[data-sport]").forEach(button => button.addEventListener("click", () => void switchSport(button.dataset.sport)));
$("#cancel-new-chat").addEventListener("click", () => $("#new-chat-dialog").close());
$("#new-chat-workspace").addEventListener("change", () => {
  $("#new-chat-error").textContent = "";
});
$("#new-chat-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#new-chat-error").textContent = "";
  try {
    const workspaceId = $("#new-chat-workspace").value;
    await createChat(workspaceId);
  } catch (error) {
    $("#new-chat-error").textContent = error.message || String(error);
  }
});
$("#refresh-files").addEventListener("click", refreshFiles);
historyToggle.addEventListener("click", toggleHistory);
document.querySelectorAll("[data-history-archived]").forEach(button => button.addEventListener("click", () => {
  if (state.changingChat || state.changingModel) return;
  showArchivedChats = button.dataset.historyArchived === "true";
  document.querySelectorAll("[data-history-archived]").forEach(item => item.setAttribute("aria-pressed", String(item === button)));
  void refreshHistory().catch(error => { $("#history-error").textContent = error.message; });
}));
$("#restore-current-chat").addEventListener("click", () => void archiveChat({ id: state.chatId, workspaceId: state.workspaceId }, false));
$("#history-close").addEventListener("click", () => setHistoryOpen(false));
historyBackdrop.addEventListener("click", () => setHistoryOpen(false));
narrowHistory.addEventListener("change", () => setHistoryOpen(!narrowHistory.matches));
document.addEventListener("keydown", event => {
  if (event.key !== "Escape" || document.querySelector("dialog[open]")) return;
  const menu = historyList.querySelector(".history-menu[open]");
  if (menu) { menu.open = false; menu.querySelector("summary").focus(); }
  else closeHistory();
});
document.addEventListener("click", event => {
  for (const menu of historyList.querySelectorAll(".history-menu[open]")) if (!menu.contains(event.target)) menu.open = false;
});
browserControlToggle.addEventListener("click", () => {
  if (state.running) return;
  setBrowserControl(!browserControlEnabled);
});
browserPreviewImage.addEventListener("click", async (event) => {
  if (!browserControlEnabled) return;
  const point = previewCoordinates(event);
  if (!point) return;
  try {
    await controlBrowser({ type: "click", ...point });
  } catch (error) {
    appendActivity("Browser control error", error.message || String(error), { tone: "error", state: "Needs attention" });
  }
});
browserPreviewImage.addEventListener("wheel", (event) => {
  if (!browserControlEnabled) return;
  event.preventDefault();
  const point = previewCoordinates(event) || { x: browserPreviewImage.naturalWidth / 2, y: browserPreviewImage.naturalHeight / 2 };
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => controlBrowser({ type: "scroll", ...point, deltaX: event.deltaX, deltaY: event.deltaY })
    .catch((error) => appendActivity("Browser control error", error.message || String(error), { tone: "error", state: "Needs attention" })), 60);
}, { passive: false });
$("#browser-back").addEventListener("click", () => controlBrowser({ type: "back" }).catch((error) => appendActivity("Browser control error", error.message || String(error), { tone: "error", state: "Needs attention" })));
$("#browser-type-send").addEventListener("click", async () => {
  const text = browserType.value;
  if (!text) return;
  try {
    await controlBrowser({ type: "type", text });
    browserType.value = "";
  } catch (error) {
    appendActivity("Browser control error", error.message || String(error), { tone: "error", state: "Needs attention" });
  }
});
for (const keyButton of document.querySelectorAll(".browser-key")) {
  keyButton.addEventListener("click", () => controlBrowser({ type: "key", key: keyButton.dataset.key })
    .catch((error) => appendActivity("Browser control error", error.message || String(error), { tone: "error", state: "Needs attention" })));
}
setHistoryOpen(!narrowHistory.matches);
enableLiveReload();
configureVoice();
void loadModels();
void refreshProviderUsage();
loadChat().catch((error) => showComposerError(error.message || String(error)));
