import { spawn } from "node:child_process";
import { createHash, randomUUID, type Hash } from "node:crypto";
import { mkdir, open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { ensureWorkspaceDirectory, workspacePath } from "./store.js";
import { writeJson } from "./run-state.js";

type DockerResult = { stdout: string; stderr: string; exitCode: number };
type OutputFile = { path: string; bytes: number; bytesSeen: number; sha256: string };
export type CommandResult = DockerResult & {
  outputFiles: { stdout: OutputFile; stderr: OutputFile };
  metadataFile: string;
  truncated: boolean;
  outputLimitExceeded: boolean;
  cancelled: boolean;
  terminationConfirmed?: boolean;
  error?: string;
};
export type SandboxOptions = { networkEnabled?: boolean; inputDirectory?: string; signal?: AbortSignal };
export class SandboxExecutionError extends Error {
  constructor(message: string, readonly result: CommandResult) { super(message); }
}

function runDocker(args: string[], timeoutMs: number, signal?: AbortSignal): Promise<DockerResult> {
  signal?.throwIfAborted();
  if (timeoutMs <= 0) throw new Error("Docker operation timed out");
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let finished = false;
    const finish = (error?: Error, exitCode = 1) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) { child.kill("SIGKILL"); reject(error); }
      else resolve({ stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), exitCode });
    };
    const abort = () => finish(signal?.reason instanceof Error ? signal.reason : new Error("Docker operation cancelled"));
    const timer = setTimeout(() => finish(new Error("Docker operation timed out")), Math.max(1, timeoutMs));
    child.stdout.on("data", (data: Buffer) => { stdout = Buffer.concat([stdout, data]).subarray(-32 * 1024); });
    child.stderr.on("data", (data: Buffer) => { stderr = Buffer.concat([stderr, data]).subarray(-32 * 1024); });
    child.on("error", error => finish(error));
    child.on("close", code => finish(undefined, code ?? 1));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function containerName(chatId: string) {
  if (!/^[a-zA-Z0-9-]+$/.test(chatId)) throw new Error("Invalid chat ID");
  return `sandbox-harness-${chatId.replaceAll("-", "").slice(0, 20)}`;
}

type SandboxConfiguration = { workspace: string; inputs?: string; networkEnabled: boolean };
type Setup = { configuration: string; controller: AbortController; promise: Promise<string>; waiters: number };
const setups = new Map<string, Setup>();

async function prepareSandbox(name: string, expected: SandboxConfiguration, signal: AbortSignal, deadline: number) {
  const run = (args: string[]) => runDocker(args, deadline - Date.now(), signal);
  const inspect = async () => {
    const result = await run(["inspect", "--format", '{"state":{{json .State.Status}},"network":{{json .HostConfig.NetworkMode}},"mounts":{{json .Mounts}}}', name]);
    if (result.exitCode !== 0) {
      if (result.stderr.includes(`No such object: ${name}`) || result.stderr.includes(`No such container: ${name}`)) return null;
      throw new Error(`Could not inspect Docker sandbox: ${result.stderr || result.stdout}`);
    }
    const value = JSON.parse(result.stdout) as { state: string; network: string; mounts: Array<{ Type: string; Source: string; Destination: string; RW: boolean }> };
    const workspace = value.mounts.filter(mount => mount.Destination === "/workspace");
    const inputs = value.mounts.filter(mount => mount.Destination === "/inputs");
    const matches = (mount: typeof workspace[number], source: string, writable: boolean) => mount.Type === "bind" && mount.Source === source && mount.RW === writable;
    if (workspace.length !== 1 || !matches(workspace[0], expected.workspace, true)
      || (expected.inputs ? inputs.length !== 1 || !matches(inputs[0], expected.inputs, false) : inputs.length !== 0)
      || (expected.networkEnabled ? !["default", "bridge"].includes(value.network) : value.network !== "none")) {
      throw new Error("Existing Docker sandbox mounts or network do not match this chat. Its container and local files were preserved.");
    }
    return value;
  };
  let container = await inspect();
  if (!container) {
    const result = await run(["run", "-d", "--name", name,
      ...(expected.networkEnabled ? [] : ["--network", "none"]),
      ...(expected.inputs ? ["-v", `${expected.inputs}:/inputs:ro`] : []),
      "-v", `${expected.workspace}:/workspace`, "-w", "/workspace", "sandbox-harness:local"]);
    if (result.exitCode !== 0) throw new Error(`Could not create Docker sandbox: ${result.stderr || result.stdout}`);
    container = await inspect();
  } else if (["created", "exited"].includes(container.state)) {
    const result = await run(["start", name]);
    if (result.exitCode !== 0) throw new Error(`Could not start Docker sandbox: ${result.stderr || result.stdout}`);
    container = await inspect();
  }
  if (container?.state !== "running") throw new Error(`Docker sandbox is ${container?.state ?? "missing"}; no command was executed.`);
  return name;
}

export async function ensureSandbox(chatId: string, options: SandboxOptions = {}) {
  options.signal?.throwIfAborted();
  const deadline = Date.now() + 30_000;
  const name = containerName(chatId);
  await mkdir(workspacePath(chatId), { recursive: true });
  const expected = { workspace: await realpath(workspacePath(chatId)), inputs: options.inputDirectory ? await realpath(options.inputDirectory) : undefined, networkEnabled: options.networkEnabled !== false };
  options.signal?.throwIfAborted();
  const configuration = JSON.stringify(expected);
  let setup = setups.get(name);
  if (setup && setup.configuration !== configuration) throw new Error("Docker sandbox setup is already using a different workspace or network configuration.");
  if (!setup) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("Docker sandbox setup exceeded 30 seconds")), Math.max(1, deadline - Date.now()));
    setup = { configuration, controller, waiters: 0, promise: Promise.resolve("") };
    const current = setup;
    setup.promise = prepareSandbox(name, expected, controller.signal, deadline).finally(() => {
      clearTimeout(timer);
      if (setups.get(name) === current) setups.delete(name);
    });
    setups.set(name, setup);
  }
  const current = setup;
  current.waiters++;
  return new Promise<string>((resolve, reject) => {
    let finished = false;
    const finish = (error?: unknown, value?: string) => {
      if (finished) return;
      finished = true;
      options.signal?.removeEventListener("abort", abort);
      current.waiters--;
      if (!current.waiters && setups.get(name) === current) current.controller.abort(new Error("Docker sandbox setup cancelled"));
      if (error) reject(error); else resolve(value!);
    };
    const abort = () => finish(options.signal?.reason ?? new Error("Docker sandbox setup cancelled"));
    current.promise.then(value => finish(undefined, value), error => finish(error));
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
  });
}

const maxOutputBytes = 16 * 1024 * 1024;
const previewBytes = 4000;
const commandScript = "import os,sys,signal,subprocess,pathlib\nmarker=pathlib.Path(sys.argv[1]); cancelled=pathlib.Path(sys.argv[1]+'.cancel')\nif cancelled.exists(): sys.exit(130)\np=subprocess.Popen(['sh','-lc',sys.argv[2]],start_new_session=True)\nmarker.write_text(str(p.pid))\nif cancelled.exists():\n try: os.killpg(p.pid,signal.SIGKILL)\n except ProcessLookupError: pass\ntry: sys.exit(p.wait())\nfinally:\n marker.unlink(missing_ok=True)\n cancelled.unlink(missing_ok=True)";
const cancellationScript = "import os,signal,sys,pathlib\np=pathlib.Path(sys.argv[1])\npathlib.Path(sys.argv[1]+'.cancel').touch()\ntry: pid=int(p.read_text())\nexcept FileNotFoundError: sys.exit(2)\ntry: os.killpg(pid,signal.SIGKILL)\nexcept ProcessLookupError: pass";

export async function execute(chatId: string, command: string, options: SandboxOptions = {}): Promise<CommandResult> {
  options.signal?.throwIfAborted();
  const name = await ensureSandbox(chatId, options);
  options.signal?.throwIfAborted();
  const root = await realpath(workspacePath(chatId));
  const id = randomUUID();
  const relative = `.harness/exec-output/${id}`;
  await ensureWorkspaceDirectory(chatId, ".harness/exec-output");
  const directory = path.join(root, relative);
  await mkdir(directory, { mode: 0o700 });
  const files: Array<{ stream: "stdout" | "stderr"; handle: FileHandle; path: string; bytes: number; bytesSeen: number; hash: Hash; head: Buffer; tail: Buffer }> = [];
  try {
    for (const stream of ["stdout", "stderr"] as const) {
      const handle = await open(path.join(directory, `${stream}.log`), "wx", 0o600);
      files.push({ stream, handle, path: `/workspace/${relative}/${stream}.log`, bytes: 0, bytesSeen: 0, hash: createHash("sha256"), head: Buffer.alloc(0), tail: Buffer.alloc(0) });
    }
  } catch (error) {
    await Promise.allSettled(files.map(file => file.handle.close()));
    throw error;
  }
  let reservedBytes = 0;
  let outputLimitExceeded = false;
  let failure: Error | undefined;
  let cancellation: Promise<void> | undefined;
  let terminationConfirmed: boolean | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  const marker = `/tmp/harness-command-${id}`;
  const stop = (error: Error) => {
    failure ??= error;
    if (!child || cancellation) return;
    const commandProcess = child;
    cancellation = runDocker(["exec", name, "python", "-c", cancellationScript, marker], 5000)
      .then(result => { terminationConfirmed = result.exitCode === 0; }, () => { terminationConfirmed = false; })
      .finally(() => { commandProcess.kill("SIGKILL"); });
  };
  const abort = () => stop(options.signal?.reason instanceof Error ? options.signal.reason : new Error("Command cancelled"));
  const preview = (file: typeof files[number]) => {
    let text = file.head.toString("utf8");
    if (file.bytes > previewBytes) {
      const head = new StringDecoder("utf8").write(file.head);
      let offset = 0;
      while (offset < file.tail.length && (file.tail[offset] & 0xc0) === 0x80) offset++;
      text = `${head}\n… [${file.bytes - file.head.length - file.tail.length} bytes omitted] …\n${file.tail.subarray(offset).toString("utf8")}`;
    }
    return new StringDecoder("utf8").write(Buffer.from(text).subarray(0, previewBytes));
  };
  const result = (exitCode: number): CommandResult => ({
    stdout: preview(files[0]), stderr: preview(files[1]), exitCode,
    outputFiles: Object.fromEntries(files.map(file => [file.stream, { path: file.path, bytes: file.bytes, bytesSeen: file.bytesSeen, sha256: file.hash.copy().digest("hex") }])) as CommandResult["outputFiles"],
    metadataFile: `/workspace/${relative}/metadata.json`,
    truncated: files.some(file => file.bytes > previewBytes || file.bytesSeen > file.bytes || Buffer.byteLength(file.head.toString("utf8")) > previewBytes),
    outputLimitExceeded, cancelled: Boolean(options.signal?.aborted),
    ...(terminationConfirmed === undefined ? {} : { terminationConfirmed }), ...(failure ? { error: failure.message } : {}),
  });
  let exitCode = 1;
  try {
    await writeJson(path.join(directory, "metadata.json"), { status: "running", ...result(1) });
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    if (!failure) {
      child = spawn("docker", ["exec", name, "python", "-c", commandScript, marker, command], { stdio: ["ignore", "pipe", "pipe"] });
      const closed = new Promise<number>(resolve => {
        child!.on("error", error => { failure ??= error; });
        child!.on("close", code => resolve(code ?? 1));
      });
      const collect = async (file: typeof files[number], stream: Readable) => {
        try {
          for await (const data of stream) {
            const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
            file.bytesSeen += chunk.length;
            const retained = chunk.subarray(0, Math.max(0, maxOutputBytes - reservedBytes));
            reservedBytes += retained.length;
            if (retained.length !== chunk.length) {
              outputLimitExceeded = true;
              stop(new Error("Command output exceeded 16 MiB; partial logs were preserved. Redirect larger artifacts into /workspace."));
            }
            for (let offset = 0; offset < retained.length;) {
              const { bytesWritten } = await file.handle.write(retained, offset, retained.length - offset);
              if (!bytesWritten) throw new Error("Could not write command output");
              const saved = retained.subarray(offset, offset + bytesWritten);
              file.hash.update(saved);
              const previousBytes = file.bytes;
              file.bytes += bytesWritten;
              if (file.bytes <= previewBytes) file.head = Buffer.concat([file.head, saved]);
              else {
                if (previousBytes <= previewBytes) {
                  const combined = Buffer.concat([file.head, saved]);
                  file.head = Buffer.from(combined.subarray(0, 3072));
                  file.tail = Buffer.from(combined.subarray(-768));
                } else file.tail = Buffer.from(Buffer.concat([file.tail, saved]).subarray(-768));
              }
              offset += bytesWritten;
            }
          }
        } catch (error) {
          stop(error instanceof Error ? error : new Error(String(error)));
        }
      };
      await Promise.all([collect(files[0], child.stdout!), collect(files[1], child.stderr!)]);
      exitCode = await closed;
      await cancellation;
    }
  } catch (error) {
    stop(error instanceof Error ? error : new Error(String(error)));
    await cancellation;
  } finally {
    options.signal?.removeEventListener("abort", abort);
    for (const file of files) {
      try { await file.handle.sync(); } catch (error) { failure ??= error instanceof Error ? error : new Error(String(error)); }
      try { await file.handle.close(); } catch (error) { failure ??= error instanceof Error ? error : new Error(String(error)); }
    }
  }
  if (options.signal?.aborted) failure ??= options.signal.reason instanceof Error ? options.signal.reason : new Error("Command cancelled");
  const completed = result(exitCode);
  try {
    await writeJson(path.join(directory, "metadata.json"), { status: completed.cancelled ? "interrupted" : failure || exitCode !== 0 ? "failed" : "completed", ...completed });
  } catch (error) {
    failure ??= error instanceof Error ? error : new Error(String(error));
    completed.error = failure.message;
  }
  if (failure) throw new SandboxExecutionError(failure.message, completed);
  return completed;
}

export async function stopSandbox(chatId: string, requireRemoval = false) {
  const name = containerName(chatId);
  const setup = setups.get(name);
  if (setup) {
    setup.controller.abort(new Error("Docker sandbox is being removed"));
    await setup.promise.catch(() => {});
  }
  try {
    const result = await runDocker(["rm", "-f", name], 5000);
    if (result.exitCode !== 0 && !result.stderr.includes(`No such container: ${name}`)) throw new Error(result.stderr || result.stdout);
  } catch (error) {
    if (requireRemoval) throw new Error(`Could not remove this chat's sandbox: ${error instanceof Error ? error.message : String(error)}`);
  }
}
