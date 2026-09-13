import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { createWriteStream, existsSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ChatSession } from "./types.js";
import type { ModelSelection } from "./model.js";

const dataRoot = path.resolve(process.cwd(), ".data", "sessions");

export const sportWorkspaces = [{ id: "nfl", name: "NFL" }, { id: "nba", name: "NBA" }];

export function workspacePath(chatId: string) {
  if (chatId.startsWith("worker-")) return path.resolve(dataRoot, "..", "agents", chatId, "workspace");
  return path.join(dataRoot, chatId, "workspace");
}

function sessionPath(chatId: string) {
  return path.join(dataRoot, chatId, "session.json");
}

export async function createSession(workspaceId?: string, model?: ModelSelection): Promise<ChatSession> {
  const sport = sportWorkspaces.find((workspace) => workspace.id === workspaceId);
  if (workspaceId !== undefined && !sport) throw new Error("Choose NFL or NBA");
  const id = randomUUID();
  const session: ChatSession = { id, workspaceId: id, createdAt: new Date().toISOString(), messages: [] };
  if (model) session.model = model;
  if (sport) {
    const target = path.resolve(dataRoot, "..", "workspaces", sport.id);
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "LEAGUE.md"), `# ${sport.name} league context

- Website: Unknown
- League name / ID: Unknown
- My team: Unknown
- Scoring and roster rules: Unknown
- Waiver rules: Unknown
- Time zone: Unknown

Save confirmed league settings here. Ask for missing details before making league-specific assumptions.
Keep passwords and API keys out of this file.
`, { flag: "wx", mode: 0o600 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    session.workspaceId = sport.id;
    session.workspaceName = sport.name;
    await mkdir(path.dirname(workspacePath(id)), { recursive: true });
    await symlink(path.relative(path.dirname(workspacePath(id)), await realpath(target)), workspacePath(id), "dir");
  } else {
    await mkdir(workspacePath(id), { recursive: true });
  }
  await saveSession(session);
  return session;
}

export async function getSession(chatId: string): Promise<ChatSession | null> {
  if (!/^[a-zA-Z0-9-]+$/.test(chatId)) return null;
  const file = sessionPath(chatId);
  try { return JSON.parse(await readFile(file, "utf8")) as ChatSession; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function saveSession(session: ChatSession) {
  const file = sessionPath(session.id);
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(session, null, 2));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

export async function listSessions(): Promise<ChatSession[]> {
  if (!existsSync(dataRoot)) return [];
  const entries = await readdir(dataRoot, { withFileTypes: true });
  const sessions = await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => getSession(entry.name)));
  return sessions.filter((value): value is ChatSession => value !== null).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function deleteSession(chatId: string) {
  if (!/^[a-zA-Z0-9-]+$/.test(chatId)) throw new Error("Invalid chat ID");
  await rm(path.dirname(sessionPath(chatId)), { recursive: true, force: true });
}

export function resolveWorkspaceFile(chatId: string, requestedPath: string) {
  const root = workspacePath(chatId);
  const resolved = path.resolve(root, requestedPath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error("Path is outside the workspace");
  return resolved;
}

export async function saveUpload(chatId: string, requestedPath: string, source: Readable & { truncated?: boolean }, signal?: AbortSignal) {
  const root = await realpath(workspacePath(chatId));
  const destination = path.resolve(root, requestedPath);
  const invalidPath = () => Object.assign(new Error("Upload path must stay inside the workspace and cannot use symlinks"), { statusCode: 400 });
  if (!destination.startsWith(`${root}${path.sep}`)) throw invalidPath();
  const validateParent = async () => {
    let directory = root;
    for (const part of path.relative(root, path.dirname(destination)).split(path.sep).filter(Boolean)) {
      directory = path.join(directory, part);
      try { await mkdir(directory); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      const details = await lstat(directory);
      if (!details.isDirectory() || details.isSymbolicLink()) throw invalidPath();
    }
    const existing = await lstat(destination).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    if (existing && !existing.isFile()) throw invalidPath();
  };
  signal?.throwIfAborted();
  await validateParent();
  const temporary = path.join(path.dirname(destination), `.upload-${randomUUID()}.tmp`);
  try {
    await pipeline(source, createWriteStream(temporary, { flags: "wx", mode: 0o600 }), { signal });
    if (source.truncated) throw Object.assign(new Error("Upload exceeds the file size limit"), { statusCode: 413 });
    const handle = await open(temporary, "r");
    try { await handle.sync(); } finally { await handle.close(); }
    signal?.throwIfAborted();
    await validateParent();
    await rename(temporary, destination);
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  }
}
