import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ChatSession } from "./types.js";

const dataRoot = path.resolve(process.cwd(), ".data", "sessions");

export function workspacePath(chatId: string) {
  return path.join(dataRoot, chatId, "workspace");
}

function sessionPath(chatId: string) {
  return path.join(dataRoot, chatId, "session.json");
}

export async function createSession(): Promise<ChatSession> {
  const id = randomUUID();
  const session: ChatSession = { id, createdAt: new Date().toISOString(), messages: [] };
  await mkdir(workspacePath(id), { recursive: true });
  await saveSession(session);
  return session;
}

export async function getSession(chatId: string): Promise<ChatSession | null> {
  const file = sessionPath(chatId);
  if (!existsSync(file)) return null;
  return JSON.parse(await readFile(file, "utf8")) as ChatSession;
}

export async function saveSession(session: ChatSession) {
  await mkdir(path.dirname(sessionPath(session.id)), { recursive: true });
  await writeFile(sessionPath(session.id), JSON.stringify(session, null, 2));
}

export async function listSessions(): Promise<ChatSession[]> {
  if (!existsSync(dataRoot)) return [];
  const entries = await readdir(dataRoot, { withFileTypes: true });
  const sessions = await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => getSession(entry.name)));
  return sessions.filter((value): value is ChatSession => value !== null).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function resolveWorkspaceFile(chatId: string, requestedPath: string) {
  const root = workspacePath(chatId);
  const resolved = path.resolve(root, requestedPath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error("Path is outside the workspace");
  return resolved;
}
