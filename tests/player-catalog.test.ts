import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { readPlayerCatalog } from "../src/player-catalog.js";

test("catalog cache shares reads, detects atomic replacements, and never masks invalid files", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "harness-catalog-"));
  const root = await realpath(temporary);
  const folder = path.join(root, "data/sleeper");
  await mkdir(folder, { recursive: true });
  const file = path.join(folder, "players-cache.json");
  const payload = (name: string) => JSON.stringify({ fetched_at: "2026-09-14T00:00:00Z", players: { p1: { full_name: name } } });
  try {
    await writeFile(file, payload("First"));
    const results = await Promise.all(Array.from({ length: 8 }, () => readPlayerCatalog(root)));
    assert(results.every(result => result === results[0]));
    const old = await stat(file);
    await writeFile(`${file}.new`, payload("Other"));
    await utimes(`${file}.new`, old.atime, old.mtime);
    await rename(`${file}.new`, file);
    const newer = await readPlayerCatalog(root);
    assert.notEqual(newer, results[0]);
    assert.equal(newer.players.p1.full_name, "Other");
    await writeFile(file, "{");
    await assert.rejects(readPlayerCatalog(root));
    await writeFile(file, payload("Fixed"));
    assert.equal((await readPlayerCatalog(root)).players.p1.full_name, "Fixed");
    await rm(file);
    await assert.rejects(readPlayerCatalog(root), /ENOENT/);
    await symlink(path.resolve("package.json"), file);
    await assert.rejects(readPlayerCatalog(root), /inside|within/);
    assert(await readFile(path.resolve("package.json"), "utf8"));
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
