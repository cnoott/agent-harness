import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { workspacePath } from "./store.js";

type CommandResult = { stdout: string; stderr: string; exitCode: number };
export type SandboxOptions = { networkEnabled?: boolean; inputDirectory?: string; signal?: AbortSignal };

function run(program: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => { stdout += data.toString(); });
    child.stderr.on("data", (data) => { stderr += data.toString(); });
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ stdout, stderr, exitCode: exitCode ?? 1 }));
  });
}

function containerName(chatId: string) {
  return `sandbox-harness-${chatId.replaceAll("-", "").slice(0, 20)}`;
}

export async function ensureSandbox(chatId: string, options: SandboxOptions = {}) {
  await mkdir(workspacePath(chatId), { recursive: true });
  const name = containerName(chatId);
  const inspected = await run("docker", ["inspect", name]);
  if (inspected.exitCode === 0) return name;

  const networkArgs = options.networkEnabled === false ? ["--network", "none"] : [];
  const inputArgs = options.inputDirectory ? ["-v", `${await realpath(options.inputDirectory)}:/inputs:ro`] : [];
  const created = await run("docker", [
    "run", "-d", "--name", name,
    ...networkArgs,
    ...inputArgs,
    "-v", `${await realpath(workspacePath(chatId))}:/workspace`,
    "-w", "/workspace",
    "sandbox-harness:local",
  ]);
  if (created.exitCode !== 0) throw new Error(`Could not start Docker sandbox: ${created.stderr || created.stdout}`);
  return name;
}

export async function execute(chatId: string, command: string, options: SandboxOptions = {}) {
  options.signal?.throwIfAborted();
  const name = await ensureSandbox(chatId, options);
  options.signal?.throwIfAborted();
  const marker = `/tmp/harness-command-${randomUUID()}`;
  const script = "import os,sys,signal,subprocess,pathlib\nmarker=pathlib.Path(sys.argv[1]); cancelled=pathlib.Path(sys.argv[1]+'.cancel')\nif cancelled.exists(): sys.exit(130)\np=subprocess.Popen(['sh','-lc',sys.argv[2]],start_new_session=True)\nmarker.write_text(str(p.pid))\nif cancelled.exists():\n try: os.killpg(p.pid,signal.SIGKILL)\n except ProcessLookupError: pass\ntry: sys.exit(p.wait())\nfinally:\n marker.unlink(missing_ok=True)\n cancelled.unlink(missing_ok=True)";
  const abort = () => {
    const kill = "import os,signal,sys,pathlib\np=pathlib.Path(sys.argv[1])\npathlib.Path(sys.argv[1]+'.cancel').touch()\nif p.exists():\n try: os.killpg(int(p.read_text()),signal.SIGKILL)\n except (ProcessLookupError,FileNotFoundError): pass";
    void run("docker", ["exec", name, "python", "-c", kill, marker]).catch(() => {});
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    const result = await run("docker", ["exec", name, "python", "-c", script, marker, command]);
    options.signal?.throwIfAborted();
    return result;
  } finally {
    options.signal?.removeEventListener("abort", abort);
  }
}

export async function stopSandbox(chatId: string) {
  const name = containerName(chatId);
  await run("docker", ["rm", "-f", name]);
}
