import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
const directory = await mkdtemp(path.join(tmpdir(), "harness-commands-"));
process.chdir(directory);
after(async () => { process.chdir(tmpdir()); await rm(directory, { recursive: true, force: true }); });
const { createSession, workspacePath } = await import("../src/store.js");
const { listCommands, resolveCommand } = await import("../src/commands.js");

test("built-in commands run current bundles while customized scripts and commands stay intact", async () => {
  const session = await createSession("nfl");
  const root = workspacePath(session.id);
  let result = await listCommands(session);
  assert.deepEqual(result.warnings, []);
  for (const name of ["roster", "fantasy-update"]) {
    const command = result.commands.find(command => command.name === name)!;
    assert.match(command.instructions, /python \/workspace\/\.harness\/workflows\/[a-f0-9]{64}\//);
    assert(await readFile(path.join(root, command.source), "utf8"));
  }
  const old = "print('An earlier bundled roster workflow')\n";
  const previousBundle = path.join(root, ".harness/workflows", "a".repeat(64));
  await mkdir(previousBundle);
  await writeFile(path.join(previousBundle, "roster.py"), old);
  await writeFile(path.join(root, "scripts/roster.py"), old);
  result = await listCommands(session);
  assert.match(result.commands.find(command => command.name === "roster")!.source, /^\.harness/);
  assert.equal(await readFile(path.join(root, "scripts/roster.py"), "utf8"), old);
  const customized = `${old}\n# User customization\n`;
  await writeFile(path.join(root, "scripts/roster.py"), customized);
  result = await listCommands(session);
  assert.equal(result.commands.find(command => command.name === "roster")!.source, "commands/roster.json");
  assert.equal(await readFile(path.join(root, "scripts/roster.py"), "utf8"), customized);
  await writeFile(path.join(root, "commands/fantasy-update.json"), JSON.stringify({ description: "Custom workflow", instructions: "Run my custom script" }));
  assert.match((await resolveCommand(session, "/fantasy-update")).prompt!, /Run my custom script/);
  const nba = await createSession("nba");
  assert.deepEqual((await listCommands(nba)).commands.map(command => command.name), ["help"]);
});
