import { DatabaseSync } from "node:sqlite";
import { chmod, link, mkdir, mkdtemp, open, rm, stat } from "node:fs/promises";
import path from "node:path";
import { nflDatabasePath } from "../src/nfl-data.js";

const args = process.argv.slice(2);
if (args.length > 1) throw new Error("Usage: npm run nfl:backup -- [new-backup-file]");
const destination = path.resolve(args[0] || path.join(".data", "backups", `nfl-${new Date().toISOString().replaceAll(":", "-")}.sqlite`));
await stat(nflDatabasePath);
await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
try { await stat(destination); throw new Error("Backup destination already exists; choose a new file."); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
const temporary = await mkdtemp(path.join(path.dirname(destination), ".nfl-backup-"));
const staged = path.join(temporary, "nfl.sqlite");
const db = new DatabaseSync(nflDatabasePath, { readOnly: true });
try {
  db.exec("PRAGMA busy_timeout=5000");
  db.prepare("VACUUM INTO ?").run(staged);
} catch (error) {
  await rm(temporary, { recursive: true, force: true });
  throw error;
} finally { db.close(); }
await chmod(staged, 0o600);
const handle = await open(staged, "r");
try { await handle.sync(); } finally { await handle.close(); }
const copy = new DatabaseSync(staged, { readOnly: true });
try {
  if (copy.prepare("PRAGMA integrity_check").get()!.integrity_check !== "ok") throw new Error("Backup integrity check failed");
  if (copy.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Backup foreign-key check failed");
  await link(staged, destination);
  console.log(JSON.stringify({ backup: destination, integrity: "ok", games: copy.prepare("SELECT count(*) AS n FROM games").get()!.n, plays: copy.prepare("SELECT count(*) AS n FROM plays").get()!.n }, null, 2));
} finally { copy.close(); await rm(temporary, { recursive: true, force: true }); }
