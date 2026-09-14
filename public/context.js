const label = document.querySelector("#context-label");
const fullness = document.querySelector("#context-fullness");
const detail = document.querySelector("#context-detail");
const toggle = document.querySelector("#context-toggle");
const wrapper = document.querySelector("#context-usage");
const ring = document.querySelector("#context-ring");
const compactionLabel = document.querySelector("#compaction-label");
const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const limitFormat = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 2 });
let currentUsage;
let selectedModel;

function drawRing(ratio) {
  const context = ring.getContext("2d");
  context.clearRect(0, 0, 48, 48);
  context.lineWidth = 6;
  context.strokeStyle = "#484a4f";
  context.beginPath();
  context.arc(24, 24, 17, 0, Math.PI * 2);
  context.stroke();
  if (ratio === null || ratio <= 0) return;
  context.strokeStyle = ratio >= 0.9 ? "#f0ba68" : "#a8aaaf";
  context.lineCap = "round";
  context.beginPath();
  context.arc(24, 24, 17, -Math.PI / 2, -Math.PI / 2 + Math.min(1, ratio) * Math.PI * 2);
  context.stroke();
}

export function setContextModel(model) {
  selectedModel = model;
  renderContext(currentUsage);
}

export function settleContext() {
  if (!currentUsage || currentUsage.phase === "compacting") renderContext(null);
}

export function renderContext(usage, preparing = false) {
  currentUsage = usage;
  const differentModel = usage && selectedModel && (usage.provider !== selectedModel.provider || usage.model !== selectedModel.model);
  if (!usage || differentModel) {
    fullness.textContent = preparing ? "Preparing…" : "Not measured yet";
    label.textContent = "Measured after your next message";
    detail.textContent = differentModel ? "The previous measurement belongs to a different model." : "Input context is measured during a run.";
    compactionLabel.hidden = true;
    toggle.setAttribute("aria-label", `Context window: ${fullness.textContent.toLowerCase()}`);
    wrapper.dataset.level = "normal";
    drawRing(null);
    return;
  }
  const known = Number.isFinite(usage.inputTokens) && usage.inputTokens >= 0;
  const capacity = Number.isFinite(usage.capacityTokens) && usage.capacityTokens > 0;
  const ratio = known && capacity ? usage.inputTokens / usage.capacityTokens : null;
  const approximate = usage.source === "estimated" ? "~" : "";
  const amount = known ? `${approximate}${compact.format(usage.inputTokens)}` : "Unknown";
  fullness.textContent = usage.phase === "compacting" ? "Compacting…" : ratio === null ? "Limit unknown" : `${approximate}${Math.round(ratio * 100)}% full`;
  label.textContent = `${amount}${capacity ? ` / ${limitFormat.format(usage.capacityTokens)}` : ""} tokens used`;
  detail.textContent = `${usage.model} · ${usage.source === "reported" ? "Reported" : usage.source === "estimated" ? "Estimated" : "Unavailable"} input · ${new Date(usage.capturedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  detail.title = "Latest request input, including cached tokens; not total spending or cumulative run tokens. Output also needs room in the model window. Unknown limits are never inferred from a different model.";
  const trigger = usage.compaction;
  const hasTrigger = Number.isFinite(trigger?.threshold) && trigger.threshold > 0 && ["tokens", "characters"].includes(trigger.unit);
  compactionLabel.hidden = false;
  compactionLabel.textContent = hasTrigger ? `Run compaction trigger: ${compact.format(trigger.threshold)} ${trigger.unit}` : "Compaction trigger available after next run";
  compactionLabel.title = "The harness's in-run compaction trigger is separate from the model's context window. Characters are not tokens; this trigger is not a hard limit or exact countdown.";
  toggle.setAttribute("aria-label", `Context window: ${fullness.textContent}, ${label.textContent}`);
  wrapper.dataset.level = ratio !== null && ratio >= 0.9 ? "high" : "normal";
  drawRing(usage.phase === "compacting" ? null : ratio);
}
