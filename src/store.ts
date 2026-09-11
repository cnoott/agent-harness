import { mkdir, readdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
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

export async function createSession(workspaceId?: string, workspaceName?: string): Promise<ChatSession> {
  const id = randomUUID();
  const session: ChatSession = { id, workspaceId: id, createdAt: new Date().toISOString(), messages: [] };
  if (workspaceName) session.workspaceName = workspaceName;
  if (workspaceId) {
    let target: string;
    if (workspaceId === "shared") {
      target = path.resolve(dataRoot, "..", "workspaces", "shared");
      await mkdir(target, { recursive: true });
      session.workspaceId = "shared";
    } else {
      const source = await getSession(workspaceId);
      if (!source) throw new Error("Workspace not found");
      target = workspacePath(source.id);
      session.workspaceId = source.workspaceId ?? source.id;
      session.workspaceName = source.workspaceName;
    }
    await mkdir(path.dirname(workspacePath(id)), { recursive: true });
    await symlink(path.relative(path.dirname(workspacePath(id)), await realpath(target)), workspacePath(id), "dir");
  } else {
    await mkdir(workspacePath(id), { recursive: true });
  }
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
