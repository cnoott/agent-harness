import { marked } from "/vendor/marked.js";
import DOMPurify from "/vendor/dompurify.js";

const state = { chatId: localStorage.getItem("sandbox-harness-chat"), workspaceId: "shared", creatingChat: false, currentAssistant: null, running: false, voiceMode: "idle" };
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
const browserControlToggle = $("#browser-control-toggle");
const browserControlPanel = $("#browser-control-panel");
const browserControlHint = $("#browser-control-hint");
const browserType = $("#browser-type");
let browserEvents;
let browserControlEnabled = false;
let scrollTimer;
let filesRequest = 0;

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

function renderMessage(message) {
  const item = $("#message-template").content.firstElementChild.cloneNode(true);
  item.classList.add(message.role);
  item.querySelector(".message-meta").textContent = message.role === "user" ? "You" : "Agent";
  item.dataset.text = message.text;
  const content = item.querySelector(".message-content");
  if (message.role === "assistant") renderMarkdown(content, message.text);
  else content.textContent = message.text;
  messages.append(item);
  for (const event of message.activity || []) renderActivity(item, event);
  finishActivity(item);
  scrollMessages();
  return item;
}

function appendActivity(label, data, { tone = "error" } = {}) {
  const item = state.running && state.currentAssistant ? state.currentAssistant : renderMessage({ role: "assistant", text: "" });
  renderActivity(item, { type: tone === "error" ? "error" : "status", name: label, data });
}

function renderActivity(item, activity) {
  const group = item.querySelector(".tool-activity");
  const events = item.querySelector(".activity-events");
  group.classList.remove("hidden");
  const isTool = activity.type.startsWith("tool_");
  let event = activity.type === "tool_end" && [...events.children].find((entry) => entry.dataset.name === activity.name && entry.dataset.running === "true");
  if (!event) {
    event = createActivityEvent(activity.name || (activity.type === "error" ? "Error" : "Agent status"));
    event.dataset.name = activity.name || "";
    event.dataset.tool = String(isTool);
    events.append(event);
  }
  const failed = activity.type === "error" || (activity.type === "tool_end" && (activity.data?.error || activity.data?.success === false || (typeof activity.data?.exitCode === "number" && activity.data.exitCode !== 0)));
  event.dataset.running = String(activity.type === "tool_start");
  event.classList.toggle("error", Boolean(failed));
  event.querySelector(".activity-state").textContent = failed ? "Failed" : activity.type === "tool_start" ? "Running" : isTool ? "Done" : "Info";
  const output = document.createElement("pre");
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

async function createChat(workspaceId = state.workspaceId, workspaceName) {
  if (state.running || state.voiceMode !== "idle" || state.creatingChat) return;
  state.creatingChat = true;
  $("#start-chat").disabled = true;
  try {
    const response = await fetch("/api/chats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId, workspaceName }),
    });
    const chat = await response.json();
    if (!response.ok) throw new Error(chat.error || "Could not create chat.");
    state.chatId = chat.id;
    state.workspaceId = chat.workspaceId ?? chat.id;
    localStorage.setItem("sandbox-harness-chat", chat.id);
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
  } finally {
    state.creatingChat = false;
    $("#start-chat").disabled = false;
  }
}

async function chooseWorkspace() {
  if (state.running || state.voiceMode !== "idle" || state.creatingChat) return;
  try {
    const response = await fetch("/api/workspaces");
    if (!response.ok) throw new Error("Could not load workspaces.");
    const workspaces = await response.json();
    const select = $("#new-chat-workspace");
    select.replaceChildren();
    const newOption = document.createElement("option");
    newOption.value = "new";
    newOption.textContent = "+ Create new workspace…";
    select.append(newOption);
    for (const workspace of workspaces) {
      const option = document.createElement("option");
      option.value = workspace.id;
      option.textContent = workspace.name;
      select.append(option);
    }
    select.value = state.workspaceId;
    if (!select.value) select.value = "shared";
    $("#new-workspace-name").value = "";
    $("#new-workspace-fields").classList.add("hidden");
    $("#new-workspace-name").required = false;
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

function formatChatDate(value) {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

async function refreshHistory() {
  const response = await fetch("/api/chats");
  const chats = response.ok ? await response.json() : [];
  historyList.replaceChildren();
  if (!chats.length) {
    historyList.textContent = "No chats yet.";
    return;
  }
  for (const chat of chats) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "history-item";
    item.classList.toggle("current", chat.id === state.chatId);
    const title = document.createElement("span");
    title.className = "history-item-title";
    title.textContent = chatLabel(chat);
    const date = document.createElement("span");
    date.className = "history-item-date";
    date.textContent = formatChatDate(chat.createdAt);
    item.append(title, date);
    item.addEventListener("click", async () => {
      if (state.running || state.voiceMode !== "idle" || chat.id === state.chatId) return closeHistory();
      state.chatId = chat.id;
      localStorage.setItem("sandbox-harness-chat", chat.id);
      clearBrowserPreview();
      setBrowserControl(false);
      prompt.value = "";
      resizePrompt();
      await loadChat();
      closeHistory();
    });
    historyList.append(item);
  }
}

function closeHistory() {
  historyDrawer.classList.remove("open");
  historyBackdrop.classList.add("hidden");
  historyDrawer.setAttribute("aria-hidden", "true");
  historyToggle.setAttribute("aria-expanded", "false");
}

async function toggleHistory() {
  if (historyDrawer.classList.contains("open")) return closeHistory();
  await refreshHistory();
  historyDrawer.classList.add("open");
  historyBackdrop.classList.remove("hidden");
  historyDrawer.setAttribute("aria-hidden", "false");
  historyToggle.setAttribute("aria-expanded", "true");
}

async function loadChat() {
  if (!state.chatId) return createChat();
  const response = await fetch(`/api/chats/${state.chatId}`);
  if (!response.ok) return createChat();
  const chat = await response.json();
  state.workspaceId = chat.workspaceId ?? chat.id;
  $("#chat-id").textContent = chat.id.slice(0, 8);
  $("#workspace-name").textContent = chat.workspaceName || (state.workspaceId === "shared" ? "Shared workspace" : `Workspace ${state.workspaceId.slice(0, 8)}`);
  messages.replaceChildren();
  state.currentAssistant = null;
  chat.messages.forEach(renderMessage);
  scrollMessages(true);
  connectBrowserEvents();
  await refreshFiles();
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
    link.textContent = file.path;
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
  state.running = running;
  updateComposer();
  stop.classList.toggle("hidden", !running);
  status.textContent = running ? "Agent is working…" : "Ready";
  browserControlToggle.disabled = running;
  if (running) setBrowserControl(false);
}

function updateComposer() {
  const voiceBusy = state.voiceMode !== "idle";
  send.disabled = state.running || voiceBusy || !prompt.value.trim();
  send.classList.toggle("hidden", state.running);
  voice.disabled = state.running || Boolean(voiceUnavailable) || ["starting", "transcribing"].includes(state.voiceMode);
  voice.title = voiceUnavailable || (state.voiceMode === "recording" ? "Stop recording and transcribe" : "Start voice input");
  voice.setAttribute("aria-label", voice.title);
  voice.setAttribute("aria-pressed", String(state.voiceMode === "recording"));
  voice.classList.toggle("is-recording", state.voiceMode === "recording");
  voice.querySelector(".mic-icon").classList.toggle("hidden", state.voiceMode === "recording");
  voice.querySelector(".recording-stop").classList.toggle("hidden", state.voiceMode !== "recording");
  voiceCancel.classList.toggle("hidden", !voiceBusy);
  $("#new-chat").disabled = state.running || voiceBusy;
  historyToggle.disabled = state.running || voiceBusy;
  $("#file-input").disabled = state.running || voiceBusy;
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
  browserPreview.classList.remove("hidden");
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
          const content = state.currentAssistant.querySelector(".message-content");
          state.currentAssistant.dataset.text += event.data;
          renderMarkdown(content, state.currentAssistant.dataset.text);
          scrollMessages();
        } else if (["tool_start", "tool_end", "status", "error"].includes(event.type)) renderActivity(state.currentAssistant, event);
        else if (event.type === "browser_frame") renderBrowserPreview(event.data);
        else if (event.type === "done") {
          completed = true;
          state.currentAssistant.dataset.text = event.data.text;
          renderMarkdown(state.currentAssistant.querySelector(".message-content"), event.data.text);
          finishActivity(state.currentAssistant);
        }
      }
    }
    if (!completed) throw new Error("The connection ended before the response finished. Reload the chat to check its saved state.");
  } catch (error) {
    appendActivity("Error", error.message || String(error));
  } finally {
    finishActivity(state.currentAssistant);
    setRunning(false);
    await refreshFiles();
  }
}

$("#composer").addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = prompt.value.trim();
  if (!text || state.running || state.voiceMode !== "idle") return;
  showComposerError();
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
$("#new-chat").addEventListener("click", chooseWorkspace);
$("#cancel-new-chat").addEventListener("click", () => $("#new-chat-dialog").close());
$("#new-chat-workspace").addEventListener("change", () => {
  const creating = $("#new-chat-workspace").value === "new";
  $("#new-workspace-fields").classList.toggle("hidden", !creating);
  $("#new-workspace-name").required = creating;
  $("#new-chat-error").textContent = "";
  if (creating) $("#new-workspace-name").focus();
});
$("#new-chat-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#new-chat-error").textContent = "";
  try {
    const workspaceId = $("#new-chat-workspace").value;
    await createChat(workspaceId, workspaceId === "new" ? $("#new-workspace-name").value.trim() : undefined);
  } catch (error) {
    $("#new-chat-error").textContent = error.message || String(error);
  }
});
$("#refresh-files").addEventListener("click", refreshFiles);
historyToggle.addEventListener("click", toggleHistory);
$("#history-close").addEventListener("click", closeHistory);
historyBackdrop.addEventListener("click", closeHistory);
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
configureVoice();
loadChat().catch((error) => showComposerError(error.message || String(error)));
