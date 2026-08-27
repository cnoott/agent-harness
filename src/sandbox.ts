import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { workspacePath } from "./store.js";

type CommandResult = { stdout: string; stderr: string; exitCode: number };

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

export async function ensureSandbox(chatId: string) {
  await mkdir(workspacePath(chatId), { recursive: true });
  const name = containerName(chatId);
  const inspected = await run("docker", ["inspect", name]);
  if (inspected.exitCode === 0) return name;

  const created = await run("docker", [
    "run", "-d", "--name", name,
    "-v", `${workspacePath(chatId)}:/workspace`,
    "-w", "/workspace",
    "sandbox-harness:local",
  ]);
  if (created.exitCode !== 0) throw new Error(`Could not start Docker sandbox: ${created.stderr || created.stdout}`);
  return name;
}

export async function execute(chatId: string, command: string) {
  const name = await ensureSandbox(chatId);
  return run("docker", ["exec", name, "sh", "-lc", command]);
}

export async function stopSandbox(chatId: string) {
  const name = containerName(chatId);
  await run("docker", ["rm", "-f", name]);
}
