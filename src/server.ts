import "dotenv/config";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import multipart from "@fastify/multipart";
import OpenAI, { toFile } from "openai";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readdir, realpath, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createSession, deleteSession, getSession, listSessions, resolveWorkspaceFile, saveSession, saveUpload, sportWorkspaces, workspacePath } from "./store.js";
import { cancelRun, runAgent, type RunControl, type Emit } from "./agent.js";
import { closeAllBrowsers, closeBrowser, controlBrowser, subscribeBrowserPreview } from "./browser.js";
import { SandboxExecutionError, stopSandbox } from "./sandbox.js";
import { Subagents } from "./subagents.js";
import { readJson, writeJson } from "./run-state.js";
import type { ChatMessage, ContextUsage, ToolEvent } from "./types.js";
import { listRunAudits, readRunAudit, recordAudit } from "./audit.js";
import { listCommands, resolveCommand } from "./commands.js";
import { readLeagueRosters } from "./league-rosters.js";
import { readLeagueMatchup, refreshLeagueSnapshot } from "./league-matchup.js";
import { NflCollector } from "./nfl-collector.js";
import { availableChatModels, chatModel, selectChatModel, type ModelSelection } from "./model.js";
import { providerUsage } from "./provider-usage.js";

const app = Fastify({ logger: true, forceCloseConnections: true });
const activeRuns = new Map<string, { control: RunControl; message: ChatMessage; listeners: Set<Emit>; completion: Promise<unknown> }>();
const activeUploads = new Map<AbortController, Promise<void>>();
let shuttingDown = false;
const changingChats = new Set<string>();
let leagueRefresh: { chatId: string; controller: AbortController; promise: Promise<void> } | null = null;
const subagents = new Subagents();
await subagents.initialize();
const nflCollector = new NflCollector();
nflCollector.initialize();
const activeRunPath = (chatId: string) => path.join(workspacePath(chatId), "..", "active-run.json");
for (const session of await listSessions()) {
  const interrupted = await readJson<ChatMessage>(activeRunPath(session.id));
  if (!interrupted) continue;
  if (!session.messages.some((message) => message.id === interrupted.id)) {
    interrupted.activity ??= [];
    interrupted.activity.push({ type: "error", data: "This run was interrupted by a server restart. Worker results and checkpoints were preserved. Send a message to continue." });
    session.messages.push(interrupted);
    await saveSession(session);
  }
  await unlink(activeRunPath(session.id));
}
const publicRoot = path.resolve(process.cwd(), "public");

await app.register(fastifyStatic, { root: publicRoot, prefix: "/" });
await app.register(multipart);

app.get("/vendor/marked.js", (_request, reply) => reply.sendFile("marked.esm.js", path.resolve("node_modules/marked/lib")));
app.get("/vendor/dompurify.js", (_request, reply) => reply.sendFile("purify.es.mjs", path.resolve("node_modules/dompurify/dist")));

app.get("/api/transcription", async () => ({ enabled: Boolean(process.env.OPENAI_API_KEY?.trim()) }));

app.get("/api/models", async (_request, reply) => {
  reply.header("Cache-Control", "no-store");
  return { defaultModel: chatModel(), models: availableChatModels() };
});

app.get("/api/usage", async (_request, reply) => {
  reply.header("Cache-Control", "no-store");
  return providerUsage();
});

app.post("/api/transcription", async (request, reply) => {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) return reply.code(503).send({ error: "Add OPENAI_API_KEY to .env and restart the server to enable voice input." });
  const file = await request.file({ limits: { fileSize: 24_000_000, files: 1, fields: 0, parts: 1 } });
  if (!file) return reply.code(400).send({ error: "No audio recording uploaded." });
  const extensions: Record<string, string> = { "audio/webm": "webm", "video/webm": "webm", "audio/mp4": "mp4", "video/mp4": "mp4", "audio/wav": "wav", "audio/x-wav": "wav", "audio/mpeg": "mp3" };
  const extension = extensions[file.mimetype];
  if (!extension) {
    file.file.resume();
    return reply.code(415).send({ error: "Unsupported audio format. Use WebM, MP4, WAV, or MP3." });
  }
  const audio = await file.toBuffer();
  if (!audio.length) return reply.code(400).send({ error: "The recording was empty. Please try again." });
  try {
    const client = new OpenAI({ apiKey, timeout: 60_000, maxRetries: 0 });
    const transcription = await client.audio.transcriptions.create({
      model: "whisper-1",
      file: await toFile(audio, `recording.${extension}`, { type: file.mimetype }),
    });
    return { text: transcription.text };
  } catch (error) {
    const limited = error instanceof OpenAI.APIError && error.status === 429;
    return reply.code(limited ? 429 : 502).send({ error: limited
      ? "Transcription is temporarily unavailable. Check your OpenAI quota or try again shortly."
      : "Could not transcribe this recording. Please try again." });
  }
});

async function filesAt(root: string, prefix = ""): Promise<Array<{ path: string; size: number }>> {
  const entries = await readdir(path.join(root, prefix), { withFileTypes: true });
  const all = await Promise.all(entries.map(async (entry) => {
    if (/^\.upload-[a-f0-9-]{36}\.tmp$/.test(entry.name)) return [];
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) {
      // Retain old background research on disk without surfacing it in Files.
      if (prefix === "runs") {
        const request = await readJson<{ origin?: string }>(path.join(root, relative, "request.json")).catch(() => undefined);
        if (request?.origin === "monitor") return [];
      }
      return filesAt(root, relative);
    }
    if (!entry.isFile()) return [];
    const details = await stat(path.join(root, relative));
    return [{ path: relative, size: details.size }];
  }));
  return all.flat();
}

async function existingWorkspaceFile(chatId: string, requestedPath: string) {
  if (!/^[a-zA-Z0-9-]+$/.test(chatId) || !await getSession(chatId)) throw new Error("Chat not found");
  const file = resolveWorkspaceFile(chatId, requestedPath);
  const root = await realpath(workspacePath(chatId));
  const resolved = await realpath(file);
  if (!resolved.startsWith(`${root}${path.sep}`) || !(await lstat(file)).isFile()) {
    throw new Error("File not found");
  }
  return resolved;
}

app.addHook("onRequest", async (request, reply) => {
  if (shuttingDown) return reply.code(503).send({ error: "Server is shutting down. Please try again after restart." });
  const { chatId } = request.params as { chatId?: string };
  if (chatId && changingChats.has(chatId)) return reply.code(409).send({ error: "This chat is being updated. Try again shortly." });
});

app.get("/api/chats", async (request) => {
  const archived = (request.query as { archived?: string }).archived === "true";
  return (await listSessions()).filter(session => Boolean(session.archivedAt) === archived);
});

app.post("/api/chats/:chatId/archive", async (request, reply) => {
  const { chatId } = request.params as { chatId: string };
  const session = await getSession(chatId);
  if (!session) return reply.code(404).send({ error: "Chat not found" });
  const archived = (request.body as { archived?: unknown } | null)?.archived;
  if (typeof archived !== "boolean") return reply.code(400).send({ error: "Specify whether the chat should be archived." });
  if (changingChats.has(chatId) || activeRuns.has(chatId) || subagents.hasActive(chatId) || leagueRefresh?.chatId === chatId) {
    return reply.code(409).send({ error: "Stop the chat and its workers before archiving or restoring it." });
  }
  changingChats.add(chatId);
  try {
    if (archived) session.archivedAt ??= new Date().toISOString();
    else delete session.archivedAt;
    await saveSession(session);
    return session;
  } finally { changingChats.delete(chatId); }
});

app.delete("/api/chats/:chatId", async (request, reply) => {
  const { chatId } = request.params as { chatId: string };
  const session = await getSession(chatId);
  if (!session) return reply.code(404).send({ error: "Chat not found" });
  if ((request.body as { confirm?: unknown } | null)?.confirm !== true) return reply.code(400).send({ error: "Confirm permanent deletion first." });
  const researchFiles = (request.body as { researchFiles?: unknown }).researchFiles ?? [];
  if (!Array.isArray(researchFiles) || researchFiles.length > 100 || researchFiles.some(file => typeof file !== "string" || !file || file.length > 1000)) {
    return reply.code(400).send({ error: "Select at most 100 research files." });
  }
  if (changingChats.has(chatId) || activeRuns.has(chatId) || subagents.hasActive(chatId) || (leagueRefresh && session.workspaceId === "nfl")) {
    return reply.code(409).send({ error: "Stop the chat and its workers before deleting it." });
  }
  changingChats.add(chatId);
  try {
    const sharedWorkspace = (await lstat(workspacePath(chatId))).isSymbolicLink();
    const allowed = sharedWorkspace ? new Set((await filesAt(workspacePath(chatId))).filter(file => !file.path.startsWith(".harness/")).map(file => file.path)) : new Set<string>();
    const files: string[] = [];
    for (const file of new Set<string>(researchFiles)) {
      if (!allowed.has(file)) return reply.code(400).send({ error: "A selected research file is no longer available. Review the file list again." });
      try { files.push(await existingWorkspaceFile(chatId, file)); }
      catch { return reply.code(400).send({ error: "A selected research file cannot be deleted. Review the file list again." }); }
    }
    await closeBrowser(chatId);
    await stopSandbox(chatId, true);
    for (const file of files) await unlink(file);
    await subagents.deleteParent(chatId);
    await deleteSession(chatId);
    return reply.code(204).send();
  } catch (error) {
    request.log.error(error);
    return reply.code(500).send({ error: "Deletion could not finish. Some selected files or worker data may already be removed. Refresh before retrying." });
  } finally { changingChats.delete(chatId); }
});

app.get("/api/chats/:chatId/deletion", async (request, reply) => {
  const { chatId } = request.params as { chatId: string };
  if (!await getSession(chatId)) return reply.code(404).send({ error: "Chat not found" });
  const sharedWorkspace = (await lstat(workspacePath(chatId))).isSymbolicLink();
  reply.header("Cache-Control", "no-store");
  return { sharedWorkspace, files: sharedWorkspace ? (await filesAt(workspacePath(chatId))).filter(file => !file.path.startsWith(".harness/")) : [] };
});

if (process.env.NODE_ENV !== "production") {
  app.get("/api/live-reload", async (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    reply.raw.write("event: ready\\ndata: connected\\n\\n");
    const heartbeat = setInterval(() => reply.raw.write(": keepalive\\n\\n"), 15_000);
    request.raw.on("close", () => clearInterval(heartbeat));
  });
}

app.get("/api/workspaces", async () => sportWorkspaces);

app.get("/api/chats/:chatId/nfl/matchup", async (request, reply) => {
  const session = await getSession((request.params as { chatId: string }).chatId);
  if (!session) return reply.code(404).send({ error: "Chat not found" });
  if (session.workspaceId !== "nfl") return reply.code(403).send({ error: "Matchups require an NFL chat" });
  reply.header("Cache-Control", "no-store");
  try { return await readLeagueMatchup(session, nflCollector.status()); }
  catch (error) { return reply.code(503).send({ error: error instanceof Error ? error.message : "Could not read the saved matchup." }); }
});

app.post("/api/chats/:chatId/nfl/matchup/refresh", async (request, reply) => {
  const { chatId } = request.params as { chatId: string };
  const session = await getSession(chatId);
  if (!session) return reply.code(404).send({ error: "Chat not found" });
  if (session.workspaceId !== "nfl") return reply.code(403).send({ error: "Matchups require an NFL chat" });
  if (session.archivedAt || changingChats.has(chatId)) return reply.code(409).send({ error: "Restore this chat before refreshing its league." });
  if (leagueRefresh) return reply.code(409).send({ error: "NFL league data is already refreshing. Try again shortly." });
  if (activeRuns.has(chatId) || subagents.hasActive(chatId)) return reply.code(409).send({ error: "Wait for this chat's run and workers to finish before refreshing." });
  if (shuttingDown) return reply.code(503).send({ error: "Server is shutting down" });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  const runId = `league-refresh-${randomUUID()}`;
  const startedAt = Date.now();
  let finishRefresh!: () => void;
  const refresh = { chatId, controller, promise: new Promise<void>(resolve => { finishRefresh = resolve; }) };
  leagueRefresh = refresh;
  reply.header("Cache-Control", "no-store");
  try {
    recordAudit(chatId, runId, "run_start", { question: "Refresh NFL matchup data", provider: "local", model: "Sleeper refresh script" });
    recordAudit(chatId, runId, "tool_start", { callId: runId, name: "league_refresh", arguments: { sport: "nfl" } });
    await refreshLeagueSnapshot(session, controller.signal);
    const data = await readLeagueMatchup(session, nflCollector.status());
    recordAudit(chatId, runId, "tool_end", { callId: runId, name: "league_refresh", durationMs: Date.now() - startedAt, status: "completed", result: data });
    recordAudit(chatId, runId, "run_end", { status: "completed", durationMs: Date.now() - startedAt, answer: "Saved league snapshot refreshed without model calls." });
    return data;
  } catch (error) {
    const message = controller.signal.aborted ? "League refresh was interrupted. Check saved-data freshness before retrying." : error instanceof Error ? error.message : "Could not refresh league data.";
    const interrupted = controller.signal.aborted || (error instanceof SandboxExecutionError && error.result.terminationConfirmed === false);
    recordAudit(chatId, runId, interrupted ? "tool_interrupted" : "tool_end", { callId: runId, name: "league_refresh", durationMs: Date.now() - startedAt,
      status: interrupted ? "interrupted" : "failed", result: { ...(error instanceof SandboxExecutionError ? error.result : {}), error: message } });
    recordAudit(chatId, runId, "run_end", { status: "failed", error: message });
    return reply.code(503).send({ error: message });
  } finally { clearTimeout(timer); if (leagueRefresh === refresh) leagueRefresh = null; finishRefresh(); }
});

app.get("/api/chats/:chatId/nfl/waivers", async (request, reply) => {
  const { chatId } = request.params as { chatId: string };
  if (!/^[a-zA-Z0-9-]+$/.test(chatId)) return reply.code(404).send({ error: "Chat not found" });
  const session = await getSession(chatId);
  if (!session) return reply.code(404).send({ error: "Chat not found" });
  if (session.workspaceId !== "nfl") return reply.code(403).send({ error: "NFL waivers require an NFL chat" });
  reply.header("Cache-Control", "no-store");
  const query = request.query as Record<string, string>;
  const search = String(query.search ?? "").trim().toLowerCase().slice(0, 100);
  const position = String(query.position ?? "").toUpperCase().slice(0, 12);
  const offset = Number(query.offset ?? 0);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100_000) return reply.code(400).send({ error: "Invalid player offset" });
  try {
    const result = await readLeagueRosters(session, true);
    if (result.state !== "ready" || !result.availablePlayers || !result.teams) return result;
    const { availablePlayers, teams, ...league } = result;
    const filtered = availablePlayers.filter(player => (!position || player.positions.includes(position))
      && (query.teamOnly === "false" || player.nflTeam !== "—")
      && (!search || `${player.name} ${player.nflTeam}`.toLowerCase().includes(search)))
      .sort((a, b) => (a.searchOrder ?? Number.MAX_SAFE_INTEGER) - (b.searchOrder ?? Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    return { ...league, players: filtered.slice(offset, offset + 50), total: filtered.length, nextOffset: offset + 50 < filtered.length ? offset + 50 : null,
      positions: [...new Set(availablePlayers.flatMap(player => player.positions))].sort(), myTeam: teams.find(team => team.id === result.myRosterId),
      availability: "Unrostered in the saved league snapshot. Claim timing and waiver eligibility are not verified." };
  } catch (error) { return reply.code(503).send({ error: error instanceof Error ? error.message : "Could not read saved waivers" }); }
});

app.get("/api/chats/:chatId/nfl/rosters", async (request, reply) => {
  const { chatId } = request.params as { chatId: string };
  if (!/^[a-zA-Z0-9-]+$/.test(chatId)) return reply.code(404).send({ error: "Chat not found" });
  const session = await getSession(chatId);
  if (!session) return reply.code(404).send({ error: "Chat not found" });
  if (session.workspaceId !== "nfl") return reply.code(403).send({ error: "Teams require an NFL chat" });
  reply.header("Cache-Control", "no-store");
  try { return await readLeagueRosters(session); }
  catch (error) { return reply.code(503).send({ error: error instanceof Error ? error.message : "Could not read saved rosters" }); }
});

app.get("/api/chats/:chatId/commands", async (request, reply) => {
  const { chatId } = request.params as { chatId: string };
  if (!/^[a-zA-Z0-9-]+$/.test(chatId)) return reply.code(404).send({ error: "Chat not found" });
  const session = await getSession(chatId);
  if (!session) return reply.code(404).send({ error: "Chat not found" });
  reply.header("Cache-Control", "no-store");
  return listCommands(session);
});

app.post("/api/chats", async (request, reply) => {
  if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) {
    return reply.code(400).send({ error: "Choose NFL or NBA using workspaceId" });
  }
  const { workspaceId, model: requestedModel } = request.body as { workspaceId?: unknown; model?: unknown };
  if (typeof workspaceId !== "string" || !sportWorkspaces.some((workspace) => workspace.id === workspaceId)) {
    return reply.code(400).send({ error: "Choose NFL or NBA" });
  }
  let model: ModelSelection | undefined;
  if (requestedModel !== undefined) {
    try { model = selectChatModel(requestedModel); }
    catch (error) { return reply.code(400).send({ error: (error as Error).message }); }
  }
  const session = await createSession(workspaceId, model);
  return { ...session, model: chatModel(session.model) };
});

app.get("/api/chats/:chatId", async (request, reply) => {
  const session = await getSession((request.params as any).chatId);
  if (!session) return reply.code(404).send({ error: "Chat not found" });
  reply.header("Cache-Control", "no-store");
  return { ...session, model: chatModel(session.model), activeRun: activeRuns.get(session.id)?.message };
});

app.patch("/api/chats/:chatId/model", async (request, reply) => {
  const { chatId } = request.params as { chatId: string };
  if (changingChats.has(chatId)) return reply.code(409).send({ error: "This chat is being updated. Try again shortly." });
  changingChats.add(chatId);
  try {
    const session = await getSession(chatId);
    if (!session) return reply.code(404).send({ error: "Chat not found" });
    if (session.archivedAt) return reply.code(409).send({ error: "Restore this archived chat before changing its model." });
    if (activeRuns.has(chatId) || subagents.hasActive(chatId) || leagueRefresh?.chatId === chatId) {
      return reply.code(409).send({ error: "Wait for this chat's run, workers, and league refresh to finish before changing its model." });
    }
    let model: ModelSelection;
    try { model = selectChatModel(request.body); }
    catch (error) { return reply.code(400).send({ error: (error as Error).message }); }
    const previous = chatModel(session.model);
    if (previous.provider !== model.provider || previous.model !== model.model) await closeBrowser(chatId);
    session.model = model;
    delete session.lastResponseId;
    await saveSession(session);
    return { model };
  } finally { changingChats.delete(chatId); }
});

app.get("/api/chats/:chatId/runs", async (request, reply) => {
  const { chatId } = request.params as { chatId: string };
  if (!/^[a-zA-Z0-9-]+$/.test(chatId) || !await getSession(chatId)) return reply.code(404).send({ error: "Chat not found" });
  const query = request.query as Record<string, string>;
  const workers = subagents.list(chatId);
  const worker = query.workerId ? workers.find(worker => worker.id === query.workerId) : undefined;
  if (query.workerId && !worker) return reply.code(404).send({ error: "Worker not found in this chat" });
  const target = worker?.id ?? chatId;
  const number = (name: string, fallback = 0) => {
    const value = Number(query[name] ?? fallback);
    return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
  };
  if (query.runId) {
    const result = readRunAudit(target, query.runId, number("after"), number("eventId"), number("offset"));
    return result ?? reply.code(404).send({ error: "Run or event not found" });
  }
  const result = listRunAudits(target, number("before", Number.MAX_SAFE_INTEGER));
  const runningId = worker?.status === "running" ? `${worker.id}-${worker.attempts}` : !worker ? activeRuns.get(chatId)?.message.id : undefined;
  return { ...result, runs: result.runs.map(run => ({ ...run, status: run.status === "unfinished" ? run.id === runningId ? "running" : "interrupted" : run.status })),
    workers: workers.map(worker => ({ id: worker.id, task: worker.task, parentRunId: worker.parentRunId })) };
});

app.get("/api/chats/:chatId/nfl/games", async (request, reply) => {
  const chatId = (request.params as { chatId: string }).chatId;
  if (!/^[a-zA-Z0-9-]+$/.test(chatId)) return reply.code(404).send({ error: "Chat not found" });
  const session = await getSession(chatId);
  if (!session) return reply.code(404).send({ error: "Chat not found" });
  if (session.workspaceId !== "nfl") return reply.code(403).send({ error: "NFL games require an NFL chat" });
  reply.header("Cache-Control", "no-store");
  return nflCollector.status();
});

app.get("/api/chats/:chatId/agents", async (request, reply) => {
  const chatId = (request.params as any).chatId;
  if (!await getSession(chatId)) return reply.code(404).send({ error: "Chat not found" });
  return subagents.list(chatId);
});

app.post("/api/chats/:chatId/agents/:agentId/cancel", async (request, reply) => {
  const { chatId, agentId } = request.params as any;
  if (!await getSession(chatId)) return reply.code(404).send({ error: "Chat not found" });
  try { return await subagents.cancel(chatId, agentId); }
  catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
});

app.get("/api/chats/:chatId/events", async (request, reply) => {
  const chatId = (request.params as any).chatId;
  if (!await getSession(chatId)) return reply.code(404).send({ error: "Chat not found" });
  reply.hijack();
  reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" });
  const active = activeRuns.get(chatId);
  if (!active) {
    reply.raw.end(`data: ${JSON.stringify({ type: "idle" })}\n\n`);
    return;
  }
  const send: Emit = (event) => {
    if (!reply.raw.destroyed) reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    if (event.type === "done") reply.raw.end();
  };
  reply.raw.write(`data: ${JSON.stringify({ type: "snapshot", data: active.message })}\n\n`);
  active.listeners.add(send);
  const heartbeat = setInterval(() => { if (!reply.raw.destroyed) reply.raw.write(": keepalive\n\n"); }, 15_000);
  reply.raw.on("close", () => { clearInterval(heartbeat); active.listeners.delete(send); });
});

app.get("/api/chats/:chatId/browser/events", async (request, reply) => {
  const chatId = (request.params as any).chatId;
  if (!await getSession(chatId)) return reply.code(404).send({ error: "Chat not found" });
  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  const send = (data: unknown) => reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
  const unsubscribe = subscribeBrowserPreview(chatId, send);
  const heartbeat = setInterval(() => reply.raw.write(": keepalive\n\n"), 15_000);
  request.raw.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

app.post("/api/chats/:chatId/browser/control", async (request, reply) => {
  const chatId = (request.params as any).chatId;
  const session = await getSession(chatId);
  if (!session) return reply.code(404).send({ error: "Chat not found" });
  if (changingChats.has(chatId) || session.archivedAt) return reply.code(409).send({ error: "Restore this chat before controlling its browser." });
  if (activeRuns.has(chatId)) return reply.code(409).send({ error: "Manual control is unavailable while the agent is running." });
  try {
    return await controlBrowser(chatId, request.body as any);
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/chats/:chatId/files", async (request, reply) => {
  const chatId = (request.params as any).chatId;
  const session = await getSession(chatId);
  if (!session) return reply.code(404).send({ error: "Chat not found" });
  return filesAt(workspacePath(chatId));
});

app.get("/api/chats/:chatId/files/*", async (request, reply) => {
  const { chatId, "*": requestedPath } = request.params as any;
  try {
    const file = await existingWorkspaceFile(chatId, requestedPath);
    if ((request.query as { download?: string }).download === "1") {
      const filename = encodeURIComponent(path.basename(file)).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
      reply.header("Content-Disposition", `attachment; filename*=UTF-8''${filename}`);
      reply.header("Cache-Control", "no-store");
      reply.type("application/octet-stream");
    }
    return reply.send(createReadStream(file));
  } catch {
    return reply.code(404).send({ error: "File not found" });
  }
});

app.delete("/api/chats/:chatId/files/*", async (request, reply) => {
  const { chatId, "*": requestedPath } = request.params as any;
  let file: string;
  try {
    file = await existingWorkspaceFile(chatId, requestedPath);
  } catch {
    return reply.code(404).send({ error: "File not found" });
  }
  try {
    await unlink(file);
    return reply.code(204).send();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return reply.code(404).send({ error: "File not found" });
    request.log.error(error);
    return reply.code(500).send({ error: "Could not delete this file. Please try again." });
  }
});

app.post("/api/chats/:chatId/upload", async (request, reply) => {
  const chatId = (request.params as any).chatId;
  if (!await getSession(chatId)) return reply.code(404).send({ error: "Chat not found" });
  if (shuttingDown) return reply.code(503).send({ error: "Server is shutting down" });
  const controller = new AbortController();
  let finishUpload!: () => void;
  activeUploads.set(controller, new Promise<void>(resolve => { finishUpload = resolve; }));
  const abort = () => controller.abort(new Error("Upload interrupted"));
  const disconnect = () => request.raw.destroy();
  controller.signal.addEventListener("abort", disconnect, { once: true });
  request.raw.once("aborted", abort);
  try {
    const file = await request.file();
    if (!file) return reply.code(400).send({ error: "No file uploaded" });
    await saveUpload(chatId, file.filename, file.file, controller.signal);
    return { path: file.filename };
  } finally {
    request.raw.removeListener("aborted", abort);
    controller.signal.removeEventListener("abort", disconnect);
    activeUploads.delete(controller);
    finishUpload();
  }
});

app.post("/api/chats/:chatId/stop", async (request) => {
  const chatId = (request.params as any).chatId;
  const active = activeRuns.get(chatId);
  if (active) cancelRun(active.control);
  await subagents.cancelParent(chatId);
  return { stopped: Boolean(active) };
});

app.post("/api/chats/:chatId/messages", async (request, reply) => {
  const chatId = (request.params as any).chatId;
  const { text } = request.body as { text?: string };
  const session = await getSession(chatId);
  if (!session) return reply.code(404).send({ error: "Chat not found" });
  if (!text?.trim()) return reply.code(400).send({ error: "Message text is required" });
  if (changingChats.has(chatId)) return reply.code(409).send({ error: "This chat is being updated." });
  if (leagueRefresh?.chatId === chatId) return reply.code(409).send({ error: "Wait for the league refresh to finish before starting research." });
  if (session.archivedAt) return reply.code(409).send({ error: "Restore this archived chat before sending a message." });
  if (activeRuns.has(chatId)) return reply.code(409).send({ error: "A run is already active" });
  if (shuttingDown) return reply.code(503).send({ error: "Server is shutting down" });

  const control: RunControl = { cancelled: false, controller: new AbortController() };
  const model = chatModel(session.model);
  const assistantMessage: ChatMessage = { id: randomUUID(), role: "assistant", text: "", createdAt: new Date().toISOString(), activity: [], model };
  let finishRun!: (error?: unknown) => void;
  const completion = new Promise<unknown>(resolve => { finishRun = resolve; });
  const active = { control, message: assistantMessage, listeners: new Set<Emit>(), completion };
  activeRuns.set(chatId, active);

  const userMessage: ChatMessage = { id: randomUUID(), role: "user", text: text.trim(), createdAt: new Date().toISOString() };
  session.messages.push(userMessage);
  try {
    await saveSession(session);
    await writeJson(activeRunPath(chatId), assistantMessage);
  } catch (error) {
    activeRuns.delete(chatId);
    finishRun(error);
    throw error;
  }

  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  const activity = assistantMessage.activity!;
  let assistantText = "";
  let pendingSave = Promise.resolve();
  const persist = () => {
    const snapshot = structuredClone(assistantMessage);
    pendingSave = pendingSave.then(() => writeJson(activeRunPath(chatId), snapshot)).catch((error) => request.log.error(error));
  };
  const checkpointTimer = setInterval(persist, 1000);
  const send = (event: ToolEvent) => {
    if (event.type === "text_delta") assistantText += String(event.data ?? "");
    assistantMessage.text = assistantText;
    if (event.type === "context_usage") assistantMessage.contextUsage = event.data as ContextUsage;
    if (event.type === "agent_update") {
      const id = (event.data as { id: string }).id;
      const previous = activity.findIndex((item) => item.type === "agent_update" && (item.data as { id: string }).id === id);
      if (previous >= 0) activity[previous] = event;
      else activity.push(event);
    } else if (["tool_start", "tool_end", "status", "error"].includes(event.type)) activity.push(event);
    if (event.type !== "text_delta" && event.type !== "browser_frame") persist();
    if (!reply.raw.destroyed) reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    for (const listener of active.listeners) listener(event);
  };
  const unsubscribe = subagents.subscribe(chatId, send);

  try {
    const command = await resolveCommand(session, userMessage.text);
    if ("answer" in command) {
      recordAudit(chatId, assistantMessage.id, "run_start", { question: userMessage.text, provider: "local", model: "Command help" });
      recordAudit(chatId, assistantMessage.id, "run_end", { status: "completed", durationMs: 0, answer: command.answer });
      send({ type: "text_delta", data: command.answer });
    } else {
      assistantText = await runAgent(session, command.prompt!, send, control, undefined, { ...subagents.forTurn(chatId, assistantMessage.id, control), runId: assistantMessage.id, model });
    }
  } catch (error) {
    send({ type: control.cancelled ? "status" : "error", data: control.cancelled ? { message: "Run stopped." } : error instanceof Error ? error.message : String(error) });
  } finally {
    let saved = false;
    let saveError: unknown;
    try {
      await subagents.cancelParent(chatId);
      assistantMessage.text = assistantText;
      session.messages.push(assistantMessage);
      await saveSession(session);
      saved = true;
      send({ type: "done", data: assistantMessage });
    } catch (error) {
      saveError = error;
      throw error;
    } finally {
      clearInterval(checkpointTimer);
      unsubscribe();
      try {
        await pendingSave;
        if (saved) await unlink(activeRunPath(chatId)).catch(() => {});
      } finally {
        activeRuns.delete(chatId);
        if (!reply.raw.destroyed) reply.raw.end();
        finishRun(saveError);
      }
    }
  }
});

app.setNotFoundHandler((request, reply) => {
  if (request.url.startsWith("/api/")) return reply.code(404).send({ error: "API route not found" });
  return reply.sendFile("index.html");
});

const port = Number(process.env.PORT || 3000);
// Default to the requested LAN interface; override with HOST if needed.
const host = process.env.HOST || "192.168.1.172";
await app.listen({ port, host });
nflCollector.start();

const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  const runs = [...activeRuns.values()];
  const uploads = [...activeUploads.entries()];
  for (const { control } of runs) cancelRun(control);
  for (const [controller] of uploads) controller.abort(new Error("Server shutdown interrupted upload"));
  leagueRefresh?.controller.abort();
  const deadline = setTimeout(() => {
    app.log.error("Shutdown exceeded 30 seconds; recovery snapshots were retained and cleanup may be incomplete.");
    process.exit(1);
  }, 30_000);
  let failed = false;
  try {
    const results = await Promise.allSettled([nflCollector.close(), subagents.close(), leagueRefresh?.promise, ...uploads.map(([, completion]) => completion),
      ...runs.map(run => run.completion.then(error => { if (error) throw error; }))]);
    for (const result of results) if (result.status === "rejected") { failed = true; app.log.error(result.reason); }
    try { await closeAllBrowsers(); }
    finally { await app.close(); }
  } catch (error) { failed = true; app.log.error(error); }
  finally { clearTimeout(deadline); }
  process.exit(failed ? 1 : 0);
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
