import "dotenv/config";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import multipart from "@fastify/multipart";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createSession, getSession, listSessions, resolveWorkspaceFile, saveSession, workspacePath } from "./store.js";
import { runAgent, type RunControl } from "./agent.js";
import { controlBrowser, subscribeBrowserPreview } from "./browser.js";
import type { ChatMessage, ToolEvent } from "./types.js";

const app = Fastify({ logger: true });
const activeRuns = new Map<string, RunControl>();
const publicRoot = path.resolve(process.cwd(), "public");

await app.register(fastifyStatic, { root: publicRoot, prefix: "/" });
await app.register(multipart);

async function filesAt(root: string, prefix = ""): Promise<Array<{ path: string; size: number }>> {
  const entries = await readdir(path.join(root, prefix), { withFileTypes: true });
  const all = await Promise.all(entries.map(async (entry) => {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) return filesAt(root, relative);
    const details = await stat(path.join(root, relative));
    return [{ path: relative, size: details.size }];
  }));
  return all.flat();
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

app.post("/api/chats", async () => createSession());

app.get("/api/chats/:chatId", async (request, reply) => {
  const session = await getSession((request.params as any).chatId);
  if (!session) return reply.code(404).send({ error: "Chat not found" });
  return session;
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
    const file = resolveWorkspaceFile(chatId, requestedPath);
    return reply.send(createReadStream(file));
  } catch (error) {
    return reply.code(404).send({ error: error instanceof Error ? error.message : "File not found" });
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
  const control = activeRuns.get((request.params as any).chatId);
  if (control) control.cancelled = true;
  return { stopped: Boolean(control) };
});

app.post("/api/chats/:chatId/messages", async (request, reply) => {
  const chatId = (request.params as any).chatId;
  const { text } = request.body as { text?: string };
  const session = await getSession(chatId);
  if (!session) return reply.code(404).send({ error: "Chat not found" });
  if (!text?.trim()) return reply.code(400).send({ error: "Message text is required" });
  if (activeRuns.has(chatId)) return reply.code(409).send({ error: "A run is already active" });

  const userMessage: ChatMessage = { id: randomUUID(), role: "user", text: text.trim(), createdAt: new Date().toISOString() };
  session.messages.push(userMessage);
  await saveSession(session);

  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  const send = (event: ToolEvent) => reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  const control: RunControl = { cancelled: false };
  activeRuns.set(chatId, control);

  try {
    const result = await runAgent(session, userMessage.text, send, control);
    const assistantMessage: ChatMessage = { id: randomUUID(), role: "assistant", text: result, createdAt: new Date().toISOString() };
    session.messages.push(assistantMessage);
    await saveSession(session);
    send({ type: "done", data: assistantMessage });
  } catch (error) {
    send({ type: "error", data: error instanceof Error ? error.message : String(error) });
  } finally {
    activeRuns.delete(chatId);
    reply.raw.end();
  }
});

app.setNotFoundHandler((request, reply) => reply.sendFile("index.html"));

const port = Number(process.env.PORT || 3000);
// Default to the requested LAN interface; override with HOST if needed.
const host = process.env.HOST || "192.168.1.172";
await app.listen({ port, host });
