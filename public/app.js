const state = { chatId: localStorage.getItem("sandbox-harness-chat"), currentAssistant: null, running: false };
const $ = (selector) => document.querySelector(selector);
const messages = $("#messages");
const activity = $("#activity");
const activityEvents = $("#activity-events");
const prompt = $("#prompt");
const send = $("#send");
const stop = $("#stop");
const status = $("#status");
const browserPreview = $("#browser-preview");
const browserPreviewImage = $("#browser-preview-image");
const browserPreviewStatus = $("#browser-preview-status");
const browserPreviewUrl = $("#browser-preview-url");
const browserControlToggle = $("#browser-control-toggle");
const browserControlPanel = $("#browser-control-panel");
const browserControlHint = $("#browser-control-hint");
const browserType = $("#browser-type");
let browserEvents;
let browserControlEnabled = false;
let scrollTimer;

function enableLiveReload() {
  if (!location.hostname.match(/^(127\\.0\\.0\\.1|localhost)$/)) return;
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

function renderMessage(message) {
  const item = $("#message-template").content.firstElementChild.cloneNode(true);
  item.classList.add(message.role);
  item.querySelector(".message-meta").textContent = message.role === "user" ? "You" : "Agent";
  item.querySelector(".message-content").textContent = message.text;
  messages.append(item);
  messages.scrollTop = messages.scrollHeight;
  return item;
}

function appendActivity(label, data, { collapsed = false, tone = "tool", state = "" } = {}) {
  activity.classList.remove("hidden");
  const event = document.createElement("details");
  event.className = `activity-event ${tone}`;
  const rendered = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  event.open = !collapsed;
  const summary = document.createElement("summary");
  const labelElement = document.createElement("span");
  labelElement.className = "activity-label";
  labelElement.textContent = label;
  const stateElement = document.createElement("span");
  stateElement.className = "activity-state";
  stateElement.textContent = state;
  summary.append(labelElement, stateElement);
  const output = document.createElement("pre");
  output.textContent = rendered.length > 8000 ? `${rendered.slice(0, 8000)}\n…` : rendered;
  event.append(summary, output);
  activityEvents.append(event);
  activity.scrollTop = activity.scrollHeight;
}

function clearBrowserPreview() {
  browserPreview.classList.add("hidden");
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

async function createChat() {
  const response = await fetch("/api/chats", { method: "POST" });
  const chat = await response.json();
  state.chatId = chat.id;
  localStorage.setItem("sandbox-harness-chat", chat.id);
  $("#chat-id").textContent = chat.id.slice(0, 8);
  messages.replaceChildren();
  activityEvents.replaceChildren();
  activity.classList.add("hidden");
  clearBrowserPreview();
  setBrowserControl(false);
  connectBrowserEvents();
  await refreshFiles();
}

async function loadChat() {
  if (!state.chatId) return createChat();
  const response = await fetch(`/api/chats/${state.chatId}`);
  if (!response.ok) return createChat();
  const chat = await response.json();
  $("#chat-id").textContent = chat.id.slice(0, 8);
  messages.replaceChildren();
  chat.messages.forEach(renderMessage);
  connectBrowserEvents();
  await refreshFiles();
}

async function refreshFiles() {
  if (!state.chatId) return;
  const response = await fetch(`/api/chats/${state.chatId}/files`);
  const files = response.ok ? await response.json() : [];
  const root = $("#files");
  root.replaceChildren();
  if (!files.length) root.textContent = "No files yet.";
  files.forEach((file) => {
    const link = document.createElement("a");
    link.className = "file";
    link.href = `/api/chats/${state.chatId}/files/${file.path.split("/").map(encodeURIComponent).join("/")}`;
    link.target = "_blank";
    link.textContent = file.path;
    const size = document.createElement("span");
    size.className = "file-size";
    size.textContent = formatBytes(file.size);
    link.append(size);
    root.append(link);
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
  state.running = running;
  send.disabled = running;
  stop.classList.toggle("hidden", !running);
  status.textContent = running ? "Agent is working…" : "Ready";
  browserControlToggle.disabled = running;
  if (running) setBrowserControl(false);
}

function renderBrowserPreview(preview) {
  browserPreview.classList.remove("hidden");
  browserPreviewImage.src = preview.image;
  browserPreviewImage.alt = preview.title ? `Live browser preview: ${preview.title}` : "Live browser preview";
  browserPreviewStatus.textContent = preview.title || "Browsing";
  browserPreviewUrl.href = preview.url;
  browserPreviewUrl.textContent = preview.url;
}

async function run(text) {
  setRunning(true);
  activityEvents.replaceChildren();
  activity.classList.add("hidden");
  state.currentAssistant = null;
  try {
    const response = await fetch(`/api/chats/${state.chatId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!response.ok) throw new Error((await response.json()).error || "Could not start run");
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
        if (event.type === "text_delta") {
          if (!state.currentAssistant) state.currentAssistant = renderMessage({ role: "assistant", text: "" });
          const content = state.currentAssistant.querySelector(".message-content");
          content.textContent += event.data;
        } else if (event.type === "tool_start") appendActivity(event.name, event.data, { state: "Running" });
        else if (event.type === "tool_end") appendActivity(event.name, event.data, { collapsed: true, state: "Output" });
        else if (event.type === "browser_frame") renderBrowserPreview(event.data);
        else if (event.type === "status") appendActivity("Agent status", event.data, { tone: "status", state: "Info" });
        else if (event.type === "error") appendActivity("Error", event.data, { tone: "error", state: "Needs attention" });
        else if (event.type === "done") {
          if (state.currentAssistant) state.currentAssistant.querySelector(".message-content").textContent = event.data.text;
          else renderMessage(event.data);
        }
      }
    }
  } catch (error) {
    appendActivity("Error", error.message || String(error));
  } finally {
    setRunning(false);
    await refreshFiles();
  }
}

$("#composer").addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = prompt.value.trim();
  if (!text || state.running) return;
  renderMessage({ role: "user", text });
  prompt.value = "";
  try {
    await uploadSelectedFiles();
    await run(text);
  } catch (error) {
    appendActivity("Upload error", error.message || String(error));
    setRunning(false);
  }
});

stop.addEventListener("click", () => fetch(`/api/chats/${state.chatId}/stop`, { method: "POST" }));
$("#new-chat").addEventListener("click", createChat);
$("#refresh-files").addEventListener("click", refreshFiles);
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
enableLiveReload();
loadChat();
