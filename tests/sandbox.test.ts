import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, open, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const originalPath = process.env.PATH;
const realSetTimeout = globalThis.setTimeout;
const directory = await mkdtemp(path.join(tmpdir(), "harness-sandbox-"));
const bin = path.join(directory, "bin");
await mkdir(bin);
process.chdir(directory);
process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
process.env.HARNESS_TEST_DOCKER_DIRECTORY = directory;
after(async () => {
  process.env.PATH = originalPath;
  delete process.env.HARNESS_TEST_DOCKER_DIRECTORY;
  process.chdir(tmpdir());
  await rm(directory, { recursive: true, force: true });
});
const { execute, ensureSandbox, stopSandbox, SandboxExecutionError } = await import("../src/sandbox.js");
const { createSession, workspacePath } = await import("../src/store.js");
const delay = (ms: number) => new Promise<void>(resolve => realSetTimeout(resolve, ms));
const dockerPath = path.join(bin, "docker");
await writeFile(dockerPath, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.HARNESS_TEST_DOCKER_DIRECTORY;
const args = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
fs.appendFileSync(path.join(root, 'calls.jsonl'), JSON.stringify(args) + '\\n');
const fail = message => { process.stderr.write(message); process.exit(1); };
const name = args[0] === 'inspect' ? args.at(-1) : args[0] === 'run' ? args[args.indexOf('--name') + 1] : args[1];
const stateFile = path.join(root, name + '.json');
const read = () => fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : null;
const save = value => fs.writeFileSync(stateFile, JSON.stringify(value));
const hold = () => setInterval(() => {}, 1000);
if (args[0] === 'inspect') {
  if (config.hangInspect) hold();
  else if (config.inspectError) fail(config.inspectError);
  else {
    const value = read();
    if (!value) fail('Error: No such object: ' + name);
    process.stdout.write(JSON.stringify(value));
  }
} else if (args[0] === 'run') {
  if (config.createError) fail(config.createError);
  const mounts = args.flatMap((arg, index) => {
    if (arg !== '-v') return [];
    const [Source, Destination, mode] = args[index + 1].split(':');
    return [{ Type: 'bind', Source, Destination, RW: mode !== 'ro' }];
  });
  save({ state: 'running', network: args.includes('--network') ? args[args.indexOf('--network') + 1] : 'default', mounts });
  process.stdout.write(name);
} else if (args[0] === 'start') {
  if (config.startError) fail(config.startError);
  save({ ...read(), state: 'running' });
  process.stdout.write(name);
} else if (args[0] === 'rm') {
  const target = path.join(root, args.at(-1) + '.json');
  if (config.removeError) fail(config.removeError);
  if (!fs.existsSync(target)) fail('Error: No such container: ' + args.at(-1));
  fs.unlinkSync(target);
} else if (args[0] === 'exec') {
  const marker = path.join(root, path.basename(args[5]) + '.pid');
  if (args.length === 6) {
    if (config.hangCancel) hold();
    else if (config.cancelError) fail(config.cancelError);
    else if (fs.existsSync(marker)) {
      try { process.kill(Number(fs.readFileSync(marker, 'utf8')), 'SIGTERM'); } catch {}
    }
  } else {
    fs.writeFileSync(marker, String(process.pid));
    const command = args[6];
    if (command === 'small') { process.stdout.write('hello\\n'); process.stderr.write('warning\\n'); }
    else if (command === 'failure') { process.stderr.write('command failed\\n'); process.exitCode = 7; }
    else if (command === 'large') { process.stdout.write('🙂'.repeat(6000)); process.stderr.write('界'.repeat(5000)); }
    else if (command === 'binary') { process.stdout.write(Buffer.alloc(3500, 255)); process.stderr.write(Buffer.alloc(3500, 255)); }
    else if (command === 'split') {
      const output = Buffer.from('🙂'.repeat(1500));
      process.stdout.write(output.subarray(0, 1));
      setTimeout(() => { process.stdout.write(output.subarray(1, 3)); setTimeout(() => process.stdout.write(output.subarray(3)), 5); }, 5);
    } else if (command === 'overflow') {
      (async () => {
        const chunk = Buffer.alloc(64 * 1024, 'x');
        for (let index = 0; index < 272; index++) {
          const output = index % 2 ? process.stderr : process.stdout;
          if (!output.write(chunk)) await new Promise(resolve => output.once('drain', resolve));
        }
      })();
    } else if (command === 'wait') { process.stdout.write('partial output\\n'); process.stderr.write('partial error\\n'); hold(); }
    else fail('Unknown fake command');
  }
} else fail('Unknown fake docker operation');
`);
await chmod(dockerPath, 0o700);

async function configure(config: Record<string, unknown> = {}) {
  await writeFile(path.join(directory, "config.json"), JSON.stringify(config));
  await writeFile(path.join(directory, "calls.jsonl"), "");
}
async function calls() {
  return (await readFile(path.join(directory, "calls.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as string[]);
}
async function waitUntil(check: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await check()) return;
    await delay(10);
  }
  throw new Error("Expected Docker activity did not occur");
}
function hostFile(chatId: string, file: string) { return path.join(workspacePath(chatId), file.replace(/^\/workspace\//, "")); }
async function verifyOutput(chatId: string, output: { path: string; bytes: number; sha256: string }) {
  const saved = await readFile(hostFile(chatId, output.path));
  assert.equal(saved.length, output.bytes);
  assert.equal(createHash("sha256").update(saved).digest("hex"), output.sha256);
  assert.equal((await stat(hostFile(chatId, output.path))).mode & 0o777, 0o600);
  return saved;
}

await test("sandbox regression", async suite => {
  await suite.test("Docker sandbox lifecycle", async t => {
    await t.test("coalesces creation and restarts matching stopped containers", async () => {
      await configure();
      const session = await createSession();
      const names = await Promise.all([ensureSandbox(session.id), ensureSandbox(session.id)]);
      assert.equal(names[0], names[1]);
      assert.equal((await calls()).filter(call => call[0] === "run").length, 1);
      const stateFile = path.join(directory, `${names[0]}.json`);
      const saved = JSON.parse(await readFile(stateFile, "utf8"));
      await writeFile(stateFile, JSON.stringify({ ...saved, state: "exited" }));
      await ensureSandbox(session.id);
      assert.equal((await calls()).filter(call => call[0] === "start").length, 1);
      assert.equal(JSON.parse(await readFile(stateFile, "utf8")).state, "running");
    });
    await t.test("rejects workspace, input, and network mismatches without removing containers", async () => {
      await configure();
      const session = await createSession();
      const inputs = path.join(directory, "inputs");
      await mkdir(inputs);
      const name = await ensureSandbox(session.id, { inputDirectory: inputs, networkEnabled: false });
      const stateFile = path.join(directory, `${name}.json`);
      const saved = JSON.parse(await readFile(stateFile, "utf8"));
      for (const changed of [
        { ...saved, network: "default" },
        { ...saved, mounts: saved.mounts.filter((mount: any) => mount.Destination !== "/inputs") },
        { ...saved, mounts: saved.mounts.map((mount: any) => ({ ...mount, RW: !mount.RW })) },
        { ...saved, mounts: saved.mounts.map((mount: any) => ({ ...mount, Source: `${mount.Source}-other` })) },
      ]) {
        await writeFile(stateFile, JSON.stringify(changed));
        await assert.rejects(ensureSandbox(session.id, { inputDirectory: inputs, networkEnabled: false }), /do not match/);
      }
      assert.equal((await calls()).filter(call => ["rm", "exec"].includes(call[0])).length, 0);
    });
    await t.test("distinguishes daemon failures and preserves failed starts", async () => {
      const session = await createSession();
      await configure({ inspectError: "Cannot connect to the Docker daemon" });
      await assert.rejects(ensureSandbox(session.id), /Could not inspect.*daemon/);
      assert.equal((await calls()).filter(call => call[0] === "run").length, 0);
      await configure({ createError: "image unavailable" });
      await assert.rejects(ensureSandbox(session.id), /Could not create.*image unavailable/);
      await configure();
      const name = await ensureSandbox(session.id);
      const file = path.join(directory, `${name}.json`);
      await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, "utf8")), state: "exited" }));
      await configure({ startError: "start refused" });
      await assert.rejects(ensureSandbox(session.id), /Could not start.*start refused/);
      assert.equal(JSON.parse(await readFile(file, "utf8")).state, "exited");
      await configure({ removeError: "daemon unavailable" });
      await assert.rejects(stopSandbox(session.id, true), /Could not remove/);
      await stopSandbox(session.id);
    });
    await t.test("cancels setup without executing a command", async () => {
      await configure({ hangInspect: true });
      const session = await createSession();
      const controller = new AbortController();
      const operation = execute(session.id, "small", { signal: controller.signal });
      const rejected = assert.rejects(operation, /cancel setup/);
      await waitUntil(async () => (await calls()).some(call => call[0] === "inspect"));
      controller.abort(new Error("cancel setup"));
      await rejected;
      assert.equal((await calls()).filter(call => call[0] === "exec").length, 0);
    });
    await t.test("bounds a hung setup to 30 seconds", async t => {
      await configure({ hangInspect: true });
      const session = await createSession();
      t.mock.timers.enable({ apis: ["setTimeout"] });
      try {
        const rejected = assert.rejects(ensureSandbox(session.id), /30 seconds|timed out/);
        await waitUntil(async () => (await calls()).some(call => call[0] === "inspect"));
        t.mock.timers.tick(30_000);
        await rejected;
      } finally { t.mock.timers.reset(); }
    });
  });

  await suite.test("durable bounded command output", async t => {
    await t.test("preserves small output, nonzero exit codes, and unique local logs", async () => {
      await configure();
      const session = await createSession();
      const first = await execute(session.id, "small");
      assert.equal(first.stdout, "hello\n");
      assert.equal(first.stderr, "warning\n");
      assert.equal(first.exitCode, 0);
      assert.equal(first.truncated, false);
      await verifyOutput(session.id, first.outputFiles.stdout);
      await verifyOutput(session.id, first.outputFiles.stderr);
      const second = await execute(session.id, "failure");
      assert.equal(second.exitCode, 7);
      assert.notEqual(first.metadataFile, second.metadataFile);
      assert.equal(JSON.parse(await readFile(hostFile(session.id, second.metadataFile), "utf8")).status, "failed");
    });
    await t.test("keeps complete UTF-8 logs and a combined 8 KB preview", async () => {
      await configure();
      const session = await createSession();
      for (const command of ["large", "split"]) {
        const result = await execute(session.id, command);
        const stdout = await verifyOutput(session.id, result.outputFiles.stdout);
        const stderr = await verifyOutput(session.id, result.outputFiles.stderr);
        assert.equal(stdout.toString("utf8"), "🙂".repeat(command === "large" ? 6000 : 1500));
        assert.equal(stderr.toString("utf8"), command === "large" ? "界".repeat(5000) : "");
        assert(!result.stdout.includes("�"));
        assert(!result.stderr.includes("�"));
        assert(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= 8000);
        assert(result.truncated);
        assert.equal(result.outputLimitExceeded, false);
      }
    });
    await t.test("stops output at 16 MiB and preserves verifiable partial logs", async () => {
      await configure();
      const session = await createSession();
      await assert.rejects(execute(session.id, "overflow"), error => {
        assert(error instanceof SandboxExecutionError);
        assert(error.result.outputLimitExceeded);
        assert(error.result.truncated);
        assert.equal(error.result.outputFiles.stdout.bytes + error.result.outputFiles.stderr.bytes, 16 * 1024 * 1024);
        assert(Buffer.byteLength(error.result.stdout) + Buffer.byteLength(error.result.stderr) <= 8000);
        return true;
      });
      const outputRoot = path.join(workspacePath(session.id), ".harness", "exec-output");
      const { readdir } = await import("node:fs/promises");
      const [id] = await readdir(outputRoot);
      const metadata = JSON.parse(await readFile(path.join(outputRoot, id, "metadata.json"), "utf8"));
      await verifyOutput(session.id, metadata.outputFiles.stdout);
      await verifyOutput(session.id, metadata.outputFiles.stderr);
      assert.equal(metadata.status, "failed");
    });
    await t.test("bounds decoded previews for invalid UTF-8 while keeping raw log bytes", async () => {
      await configure();
      const session = await createSession();
      const result = await execute(session.id, "binary");
      assert(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= 8000);
      assert(result.truncated);
      assert((await verifyOutput(session.id, result.outputFiles.stdout)).equals(Buffer.alloc(3500, 255)));
      assert((await verifyOutput(session.id, result.outputFiles.stderr)).equals(Buffer.alloc(3500, 255)));
    });
    await t.test("preserves interrupted logs when the cancellation helper hangs", async () => {
      await configure({ hangCancel: true });
      const session = await createSession();
      const controller = new AbortController();
      const operation = execute(session.id, "wait", { signal: controller.signal });
      let partial: any;
      const rejected = assert.rejects(operation, error => {
        assert(error instanceof SandboxExecutionError);
        partial = error.result;
        return true;
      });
      await waitUntil(async () => (await calls()).some(call => call[0] === "exec" && call.length === 7));
      await delay(30);
      const started = Date.now();
      controller.abort(new Error("stop output"));
      await rejected;
      assert(Date.now() - started < 6500);
      assert(partial.cancelled);
      assert.equal(partial.terminationConfirmed, false);
      assert.equal((await verifyOutput(session.id, partial.outputFiles.stdout)).toString(), "partial output\n");
      assert.equal(JSON.parse(await readFile(hostFile(session.id, partial.metadataFile), "utf8")).status, "interrupted");
    });
    await t.test("stops after disk write failure and reports partial file metadata", async () => {
      await configure();
      const session = await createSession();
      const probe = await open(path.join(directory, "probe"), "w");
      const prototype = Object.getPrototypeOf(probe);
      const originalWrite = prototype.write;
      await probe.close();
      prototype.write = async () => { throw new Error("simulated disk full"); };
      try {
        await assert.rejects(execute(session.id, "wait"), error => {
          assert(error instanceof SandboxExecutionError);
          assert.match(error.message, /disk full/);
          assert.equal(error.result.outputFiles.stdout.bytes, 0);
          assert.equal(error.result.outputFiles.stderr.bytes, 0);
          return true;
        });
      } finally { prototype.write = originalWrite; }
    });
    await t.test("does not confirm cancellation when the PID marker is missing", async () => {
      await configure({ cancelError: "unconfirmed termination" });
      const session = await createSession();
      const controller = new AbortController();
      const rejected = assert.rejects(execute(session.id, "wait", { signal: controller.signal }), error => {
        assert(error instanceof SandboxExecutionError);
        assert.equal(error.result.terminationConfirmed, false);
        return true;
      });
      await waitUntil(async () => (await calls()).some(call => call[0] === "exec" && call.length === 7));
      controller.abort(new Error("cancel command"));
      await rejected;
      const helper = (await calls()).find(call => call[0] === "exec" && call.length === 6)!;
      const marker = path.join(directory, "missing-pid-marker");
      await assert.rejects(promisify(execFile)("python3", ["-c", helper[4], marker]), error => {
        assert.equal((error as NodeJS.ErrnoException).code, 2);
        return true;
      });
      assert((await stat(`${marker}.cancel`)).isFile());
    });
    await t.test("rejects symlinked output directories before running commands", async () => {
      await configure();
      const session = await createSession();
      await symlink(directory, path.join(workspacePath(session.id), ".harness"));
      await assert.rejects(execute(session.id, "small"), /must not be a symlink/);
      assert.equal((await calls()).filter(call => call[0] === "exec").length, 0);
    });
  });

  await suite.test("real disposable Docker workspace survives stop and recreation", { skip: process.env.HARNESS_REAL_DOCKER_TESTS !== "1" }, async () => {
    process.env.PATH = originalPath;
    const session = await createSession();
    const run = promisify(execFile);
    try {
      const first = await execute(session.id, "printf 'persisted\\n' > marker.txt; sqlite3 saved.sqlite 'CREATE TABLE facts(value TEXT); INSERT INTO facts VALUES (42);'", { networkEnabled: false });
      assert.equal(first.exitCode, 0);
      const name = await ensureSandbox(session.id, { networkEnabled: false });
      const originalId = (await run("docker", ["inspect", "--format", "{{.Id}}", name])).stdout.trim();
      await run("docker", ["stop", name], { timeout: 15_000 });
      const restarted = await execute(session.id, "cat marker.txt; sqlite3 saved.sqlite 'SELECT value FROM facts;'", { networkEnabled: false });
      assert.equal(restarted.stdout, "persisted\n42\n");
      assert.equal((await run("docker", ["inspect", "--format", "{{.Id}}", name])).stdout.trim(), originalId);
      await stopSandbox(session.id, true);
      const recreated = await execute(session.id, "cat marker.txt; sqlite3 saved.sqlite 'SELECT value FROM facts;'", { networkEnabled: false });
      assert.equal(recreated.stdout, "persisted\n42\n");
      assert.notEqual((await run("docker", ["inspect", "--format", "{{.Id}}", name])).stdout.trim(), originalId);
      await verifyOutput(session.id, first.outputFiles.stdout);
      assert.equal(await realpath(workspacePath(session.id)), await realpath(path.dirname(hostFile(session.id, "/workspace/marker.txt"))));
    } finally {
      await stopSandbox(session.id, true);
      process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
    }
  });
});
