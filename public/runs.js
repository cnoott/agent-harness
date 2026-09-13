const agent = document.querySelector("#run-agent");
const list = document.querySelector("#run-list");
const events = document.querySelector("#run-events");
const status = document.querySelector("#runs-status");
const error = document.querySelector("#runs-error");
const older = document.querySelector("#runs-more");
const back = document.querySelector("#runs-back");
let chatId = null;
let generation = 0;
let nextBefore = null;

function node(tag, text) {
  const element = document.createElement(tag);
  element.textContent = text;
  return element;
}
async function request(params, version) {
  const query = new URLSearchParams({ workerId: agent.value, ...params });
  const response = await fetch(`/api/chats/${encodeURIComponent(chatId)}/runs?${query}`);
  const data = await response.json();
  if (version !== generation) return null;
  if (!response.ok) throw new Error(data.error || "Could not load run audit");
  return data;
}
async function showRuns(append = false) {
  if (!chatId) return;
  const version = ++generation;
  error.textContent = "";
  status.textContent = "Loading runs…";
  events.replaceChildren();
  back.classList.add("hidden");
  older.classList.add("hidden");
  if (!append) list.replaceChildren();
  try {
    const data = await request(append && nextBefore ? { before: nextBefore } : {}, version);
    if (!data) return;
    const selected = agent.value;
    agent.replaceChildren(new Option("Main chat", ""), ...data.workers.map(worker => new Option(`${worker.id.slice(0, 15)} · ${worker.task.slice(0, 70)}`, worker.id)));
    agent.value = selected;
    for (const run of data.runs) {
      const card = node("article", "");
      card.className = "run-card";
      const button = node("button", run.question || run.id);
      button.className = "secondary";
      button.addEventListener("click", () => showEvents(run.id));
      card.append(button, node("p", `${new Date(run.startedAt).toLocaleString()} · ${run.status} · ${run.model || "Unknown model"}`),
        node("p", `${run.toolCalls} tool calls${run.durationMs === null ? "" : ` · ${(run.durationMs / 1000).toFixed(1)}s`}${run.stats ? ` · ${run.stats.totalTokens} reported agent-loop tokens` : ""}`));
      if (run.unresolvedCalls) card.append(node("p", `${run.unresolvedCalls} calls without a recorded outcome. Check their effects before retrying.`));
      if (run.parentRunId) card.append(node("p", `Parent run: ${run.parentRunId}`));
      list.append(card);
    }
    nextBefore = data.nextBefore;
    older.classList.toggle("hidden", !nextBefore);
    status.textContent = list.children.length ? "Select a run to inspect its events. Dollar cost is unavailable; model events include provider-reported usage, including memory calls. Browser-internal model usage is not included." : "No audited runs yet. Send a message to start one.";
  } catch (cause) { if (version === generation) { status.textContent = ""; error.textContent = cause.message; } }
}
async function showEvents(runId, after = 0) {
  const version = after ? generation : ++generation;
  error.textContent = "";
  list.replaceChildren();
  older.classList.add("hidden");
  back.classList.remove("hidden");
  if (!after) events.replaceChildren();
  status.textContent = `Run ${runId}`;
  try {
    const data = await request({ runId, after }, version);
    if (!data) return;
    for (const event of data.events) {
      const details = node("details", "");
      details.className = "run-card";
      details.append(node("summary", `${event.kind}${event.name || event.phase ? ` · ${event.name || event.phase}` : ""} · ${new Date(event.createdAt).toLocaleTimeString()}`));
      const content = node("pre", event.preview + (event.truncated ? "\n[Preview truncated; read full event below.]" : ""));
      let offset = 0;
      const read = node("button", "Read full event");
      read.className = "secondary";
      read.addEventListener("click", async () => {
        read.disabled = true;
        try {
          const full = await request({ runId, eventId: event.id, offset }, version);
          if (!full) return;
          if (!offset) content.textContent = "";
          content.textContent += full.content;
          offset = full.nextOffset;
          read.textContent = offset === null ? "Complete event loaded" : "Read next part";
        } catch (cause) { if (version === generation) error.textContent = cause.message; }
        finally { read.disabled = offset === null; }
      });
      details.append(content, read);
      events.append(details);
    }
    if (data.nextAfter) {
      const more = node("button", "More events");
      more.className = "secondary";
      more.addEventListener("click", () => { more.remove(); showEvents(runId, data.nextAfter); });
      events.append(more);
    }
  } catch (cause) { if (version === generation) error.textContent = cause.message; }
}
export function setAuditChat(id) {
  chatId = id;
  generation++;
  document.querySelector("#runs-toggle").disabled = !id;
  agent.replaceChildren(new Option("Main chat", ""));
  list.replaceChildren(); events.replaceChildren();
  older.classList.add("hidden"); back.classList.add("hidden");
  status.textContent = ""; error.textContent = "";
}
document.querySelector("#runs-toggle").addEventListener("click", () => {
  if (!document.querySelector('[data-panel="runs"]').classList.contains("hidden")) showRuns();
});
document.querySelector("#runs-refresh").addEventListener("click", () => showRuns());
agent.addEventListener("change", () => showRuns());
older.addEventListener("click", () => showRuns(true));
back.addEventListener("click", () => showRuns());
