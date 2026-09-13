import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const directory = await mkdtemp(path.join(tmpdir(), "harness-uploads-"));
process.chdir(directory);
after(async () => { process.chdir(tmpdir()); await rm(directory, { recursive: true, force: true }); });
const { createSession, workspacePath, saveUpload } = await import("../src/store.js");

test("uploads publish complete bytes and preserve an existing file on failure", async () => {
  const session = await createSession("nfl");
  const root = workspacePath(session.id);
  await saveUpload(session.id, "nested/研究.txt", Readable.from(["complete 🏈"]));
  const file = path.join(root, "nested/研究.txt");
  assert.equal(await readFile(file, "utf8"), "complete 🏈");
  const broken = Readable.from((async function* () { yield "partial"; throw new Error("disconnected"); })());
  await assert.rejects(saveUpload(session.id, "nested/研究.txt", broken), /disconnected/);
  const oversized = Object.assign(Readable.from(["truncated bytes"]), { truncated: true });
  await assert.rejects(saveUpload(session.id, "nested/研究.txt", oversized), /size limit/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(saveUpload(session.id, "nested/研究.txt", Readable.from(["aborted"]), controller.signal));
  assert.equal(await readFile(file, "utf8"), "complete 🏈");
  assert.deepEqual(await readdir(path.dirname(file)), ["研究.txt"]);
});

test("uploads reject traversal and symlink destinations and directories", async () => {
  const session = await createSession("nba");
  const outside = path.join(directory, "outside.txt");
  await writeFile(outside, "unchanged");
  await symlink(outside, path.join(workspacePath(session.id), "link.txt"));
  await symlink(directory, path.join(workspacePath(session.id), "outside"));
  for (const name of ["../outside.txt", "link.txt", "outside/outside.txt", "."]) {
    await assert.rejects(saveUpload(session.id, name, Readable.from(["bad"])), /inside the workspace/);
  }
  assert.equal(await readFile(outside, "utf8"), "unchanged");
});

test("all durable runtime locations remain Git ignored and untracked", () => {
  const repository = fileURLToPath(new URL("../", import.meta.url));
  const files = [".data/sessions/chat/session.json", ".data/sessions/chat/browser-profile/Cookies", ".data/sports/nfl.sqlite", ".data/backups/nfl.sqlite",
    ".data/agents/worker/checkpoint.json", ".data/workspaces/nfl/downloads/artifact.pdf", ".data/workspaces/nfl/.harness/exec-output/call/stdout.log"];
  const ignored = execFileSync("git", ["check-ignore", "--stdin"], { cwd: repository, input: files.join("\n") + "\n", encoding: "utf8" });
  assert.deepEqual(ignored.trim().split("\n"), files);
  assert.equal(execFileSync("git", ["ls-files", "--", ".data", ".env"], { cwd: repository, encoding: "utf8" }), "");
});
