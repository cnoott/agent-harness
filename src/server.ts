import "dotenv/config";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import multipart from "@fastify/multipart";
import OpenAI, { toFile } from "openai";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, readdir, realpath, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createSession, getSession, listSessions, resolveWorkspaceFile, saveSession, workspacePath } from "./store.js";
import { cancelRun, runAgent, type RunControl, type Emit } from "./agent.js";
import { importHistory } from "./history.js";
import { controlBrowser, subscribeBrowserPreview } from "./browser.js";
import { Subagents } from "./subagents.js";
import { readJson, writeJson } from "./run-state.js";
import type { ChatMessage, ToolEvent } from "./types.js";

const app = Fastify({ logger: true });
const activeRuns = new Map<string, { control: RunControl; message: ChatMessage; listeners: Set<Emit> }>();
const subagents = new Subagents();
await subagents.initialize();
const activeRunPath = (chatId: string) => path.join(workspacePath(chatId), "..", "active-run.json");
for (const session of await listSessions()) {
  const interrupted = await readJson<ChatMessage>(activeRunPath(session.id));
  if (!interrupted) continue;
  if (!session.messages.some((message) => message.id === interrupted.id)) {
    interrupted.activity ??= [];
    interrupted.activity.push({ type: "error", data: "This run was interrupted by a server restart. Worker results and checkpoints were preserved. Send a message to continue." });
    session.messages.push(interrupted);
    importHistory(session);
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
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) return filesAt(root, relative);
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

app.get("/api/chats", async () => listSessions());

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

app.get("/api/workspaces", async () => {
  const workspaces = new Map([["shared", { id: "shared", name: "Shared workspace" }]]);
  for (const session of await listSessions()) {
    const id = session.workspaceId ?? session.id;
    if (id !== session.id || workspaces.has(id)) continue;
    const title = session.workspaceName ?? session.messages.find((message) => message.role === "user")?.text.replaceAll(/\s+/g, " ").trim();
    workspaces.set(id, { id, name: title ? `${title.slice(0, 80)} · ${id.slice(0, 8)}` : `Workspace ${id.slice(0, 8)}` });
  }
  return [...workspaces.values()];
});

app.post("/api/chats", async (request, reply) => {
  if (request.body !== undefined && (!request.body || typeof request.body !== "object" || Array.isArray(request.body))) {
    return reply.code(400).send({ error: "Expected an object with an optional workspaceId" });
  }
  const { workspaceId = "shared", workspaceName } = (request.body ?? {}) as { workspaceId?: unknown; workspaceName?: unknown };
  if (workspaceId === "new") {
    if (typeof workspaceName !== "string" || !workspaceName.trim() || workspaceName.trim().length > 80) {
      return reply.code(400).send({ error: "Enter a workspace name between 1 and 80 characters" });
    }
    return createSession(undefined, workspaceName.trim());
  }
  if (typeof workspaceId !== "string" || !/^(shared|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.test(workspaceId)) {
    return reply.code(400).send({ error: "Invalid workspace ID" });
  }
  if (workspaceId !== "shared" && !await getSession(workspaceId)) return reply.code(404).send({ error: "Workspace not found" });
  return createSession(workspaceId);
});

app.get("/api/chats/:chatId", async (request, reply) => {
  const session = await getSession((request.params as any).chatId);
  if (!session) return reply.code(404).send({ error: "Chat not found" });
  return { ...session, activeRun: activeRuns.get(session.id)?.message };
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
  if (!await getSession(chatId)) return reply.code(404).send({ error: "Chat not found" });
  if (activeRuns.has(chatId)) return reply.code(409).send({ error: "Manual control is unavailable while the agent is running." });
  try {
    return await controlBrowser(chatId, request.body as any);
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/chats/:chatId/files", async (request, reply) => {
  const chatId = (request.params as any).chatId;
  if (!await getSession(chatId)) return reply.code(404).send({ error: "Chat not found" });
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
  const file = await request.file();
  if (!file) return reply.code(400).send({ error: "No file uploaded" });
  const destination = resolveWorkspaceFile(chatId, file.filename);
  await mkdir(path.dirname(destination), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const write = createWriteStream(destination);
    file.file.pipe(write).on("finish", resolve).on("error", reject);
  });
  return { path: file.filename };
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
  if (activeRuns.has(chatId)) return reply.code(409).send({ error: "A run is already active" });

  const control: RunControl = { cancelled: false, controller: new AbortController() };
  const assistantMessage: ChatMessage = { id: randomUUID(), role: "assistant", text: "", createdAt: new Date().toISOString(), activity: [] };
  const active = { control, message: assistantMessage, listeners: new Set<Emit>() };
  activeRuns.set(chatId, active);

  const userMessage: ChatMessage = { id: randomUUID(), role: "user", text: text.trim(), createdAt: new Date().toISOString() };
  session.messages.push(userMessage);
  try {
    importHistory(session);
    await saveSession(session);
    await writeJson(activeRunPath(chatId), assistantMessage);
  } catch (error) {
    activeRuns.delete(chatId);
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
    assistantText = await runAgent(session, userMessage.text, send, control, undefined, subagents.forTurn(chatId, assistantMessage.id, control));
  } catch (error) {
    send({ type: control.cancelled ? "status" : "error", data: control.cancelled ? { message: "Run stopped." } : error instanceof Error ? error.message : String(error) });
  } finally {
    let saved = false;
    try {
      await subagents.cancelParent(chatId);
      assistantMessage.text = assistantText;
      session.messages.push(assistantMessage);
      importHistory(session);
      await saveSession(session);
      saved = true;
      send({ type: "done", data: assistantMessage });
    } finally {
      clearInterval(checkpointTimer);
      unsubscribe();
      await pendingSave;
      if (saved) await unlink(activeRunPath(chatId)).catch(() => {});
      activeRuns.delete(chatId);
      if (!reply.raw.destroyed) reply.raw.end();
    }
  }
});

app.setNotFoundHandler((request, reply) => reply.sendFile("index.html"));

const port = Number(process.env.PORT || 3000);
// Default to the requested LAN interface; override with HOST if needed.
const host = process.env.HOST || "192.168.1.172";
await app.listen({ port, host });

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { control } of activeRuns.values()) cancelRun(control);
  await subagents.close();
  process.exit(0);
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
