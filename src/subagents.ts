import { randomUUID, createHash } from "node:crypto";
import { appendFile, copyFile, mkdir, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { cancelRun, emptyRunStats, runAgent, type Emit, type RunControl, type RunOptions, type RunStats } from "./agent.js";
import { availableModels, type ModelSelection } from "./model.js";
import { closeBrowser } from "./browser.js";
import { stopSandbox } from "./sandbox.js";
import { workspacePath } from "./store.js";
import { readJson, writeJson, type AgentCheckpoint } from "./run-state.js";

export type WorkerResult = {
  outcome: "completed" | "partial" | "blocked";
  summary: string;
  output: string;
  artifacts: Array<{ path: string; description: string }>;
  limitations: string[];
};
export type WorkerRecord = {
  id: string;
  parentId: string;
  parentRunId: string;
  task: string;
  context: string;
  expectedOutput: string;
  model: ModelSelection;
  status: "queued" | "running" | "completed" | "partial" | "blocked" | "failed" | "cancelled" | "interrupted";
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  updatedAt: string;
  activity: string;
  result?: WorkerResult;
  error?: string;
  stats: RunStats;
  allowedTools?: string[];
  networkEnabled: boolean;
  maxSteps: number;
  maxRuntimeMs: number;
  attempts: number;
};

const workerRoot = path.resolve(".data", "agents");
const activeStatuses = new Set(["queued", "running"]);
const tool = (name: string, description: string, properties: Record<string, unknown>) => ({
  type: "function", name, description, strict: true,
  parameters: { type: "object", additionalProperties: false, properties, required: Object.keys(properties) },
});
const workerId = { type: "string", description: "Worker ID returned by agent_start." };
export const finishTaskTool = tool("finish_task", "Finish your assignment with its deliverable. Call this tool on its own. Artifact paths are relative to your /workspace; include only files you want to deliver to the orchestrator.", {
  outcome: { type: "string", enum: ["completed", "partial", "blocked"] },
  summary: { type: "string" }, output: { type: "string" },
  artifacts: { type: "array", items: { type: "object", additionalProperties: false, properties: { path: { type: "string" }, description: { type: "string" } }, required: ["path", "description"] } },
  limitations: { type: "array", items: { type: "string" } },
});
const delegationTools = [
  tool("agent_start", "Start one bounded assignment using the same harness with a fresh private context. Returns immediately. Choose a configured provider/model, include the necessary context, and define the deliverable. Workers can read parent files at /inputs and write only their private workspace. Use for independent work; at most 8 assignments per parent turn and 2 workers run concurrently.", {
    task: { type: "string" }, context: { type: "string" }, expectedOutput: { type: "string" },
    provider: { type: "string", enum: ["openai", "gemini"] }, model: { type: "string" },
  }),
  tool("agent_read", "Read a worker's status and deliverable. Use an empty id to list your workers. Private transcripts are never returned.", { id: workerId }),
  tool("agent_wait", "Wait up to 30 seconds for one of these workers to finish. Returns terminal results or current status. Prefer waiting to repeatedly reading unchanged status.", { ids: { type: "array", items: workerId } }),
  tool("agent_cancel", "Cancel one of your workers, preserving its files and checkpoint.", { id: workerId }),
  tool("agent_resume", "Resume an interrupted worker's unchanged assignment from a safe checkpoint. No follow-up chat. If a tool may have executed before interruption, inspect its effects and start a new reconciled assignment instead.", { id: workerId }),
];

function recordPath(id: string) { return path.join(workerRoot, id, "run.json"); }
function checkpointPath(id: string) { return path.join(workerRoot, id, "checkpoint.json"); }
function requiredText(value: unknown, name: string, max: number, allowEmpty = false) {
  if (typeof value !== "string" || (!allowEmpty && !value.trim()) || value.length > max) throw new Error(`${name} must be ${allowEmpty ? "a" : "a nonempty"} string of at most ${max} characters.`);
  return value.trim();
}

export class Subagents {
  private records = new Map<string, WorkerRecord>();
  private running = new Map<string, { control: RunControl; promise: Promise<void> }>();
  private listeners = new Map<string, Set<Emit>>();
  private changes = new Set<() => void>();
  private writes = new Map<string, Promise<void>>();
  private scheduling = false;
  private closing = false;

  constructor(private runner = runAgent) {}

  async initialize() {
    await mkdir(workerRoot, { recursive: true, mode: 0o700 });
    for (const entry of await readdir(workerRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^worker-[a-f0-9]{32}$/.test(entry.name)) continue;
      const record = await readJson<WorkerRecord>(recordPath(entry.name));
      if (!record) continue;
      this.records.set(record.id, record);
      if (activeStatuses.has(record.status)) {
        record.status = "interrupted";
        record.activity = "Interrupted by a server restart";
        record.endedAt = new Date().toISOString();
        await stopSandbox(record.id);
        await this.save(record);
      }
    }
  }

  list(parentId: string) {
    return [...this.records.values()].filter((record) => record.parentId === parentId).map((record) => this.view(record));
  }

  private owned(parentId: string, id: unknown) {
    const record = typeof id === "string" ? this.records.get(id) : undefined;
    if (!record || record.parentId !== parentId) throw new Error("Worker not found in this chat.");
    return record;
  }

  private view(record: WorkerRecord) {
    const { id, parentId, parentRunId, task, expectedOutput, model, status, createdAt, startedAt, endedAt, updatedAt, activity, result, error, stats, attempts } = record;
    return { id, parentId, parentRunId, task, expectedOutput, model, status, createdAt, startedAt, endedAt, updatedAt, activity, result, error, stats, attempts };
  }

  private async save(record: WorkerRecord) {
    record.updatedAt = new Date().toISOString();
    const snapshot = structuredClone(record);
    const write = (this.writes.get(record.id) ?? Promise.resolve()).catch(() => {}).then(() => writeJson(recordPath(record.id), snapshot));
    this.writes.set(record.id, write);
    await write;
    const event = { type: "agent_update" as const, data: this.view(record) };
    for (const listener of this.listeners.get(record.parentId) ?? []) listener(event);
    for (const notify of this.changes) notify();
  }

  subscribe(parentId: string, emit: Emit) {
    const listeners = this.listeners.get(parentId) ?? new Set<Emit>();
    listeners.add(emit);
    this.listeners.set(parentId, listeners);
    return () => {
      listeners.delete(emit);
      if (!listeners.size) this.listeners.delete(parentId);
    };
  }

  async start(parentId: string, parentRunId: string, callId: string, args: Record<string, unknown>, options: RunOptions = {}) {
    if (this.closing) throw new Error("Server is shutting down.");
    const id = `worker-${createHash("sha256").update(`${parentId}:${parentRunId}:${callId}`).digest("hex").slice(0, 32)}`;
    const existing = this.records.get(id);
    if (existing) return this.view(existing);
    if ([...this.records.values()].filter((record) => record.parentRunId === parentRunId && record.parentId === parentId).length >= 8) throw new Error("This turn has reached its 8-worker limit. Use the existing results.");
    const model = availableModels().find((item) => item.provider === args.provider && item.model === args.model);
    if (!model) throw new Error(`Select a configured model: ${JSON.stringify(availableModels())}`);
    const record: WorkerRecord = {
      id, parentId, parentRunId,
      task: requiredText(args.task, "task", 8000), context: requiredText(args.context, "context", 16000, true),
      expectedOutput: requiredText(args.expectedOutput, "expectedOutput", 4000), model,
      status: "queued", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), activity: "Waiting for a worker slot",
      stats: emptyRunStats(), allowedTools: options.sandboxNetworkEnabled === false
        ? (options.allowedTools ?? ["exec"]).filter((name) => !name.startsWith("browser_") && !name.startsWith("agent_"))
        : options.allowedTools?.filter((name) => !name.startsWith("agent_")),
      networkEnabled: options.sandboxNetworkEnabled !== false, maxSteps: 40, maxRuntimeMs: 15 * 60_000, attempts: 0,
    };
    this.records.set(id, record);
    try {
      await mkdir(workspacePath(id), { recursive: true, mode: 0o700 });
      await this.save(record);
    } catch (error) {
      this.records.delete(id);
      throw error;
    }
    void this.schedule();
    return this.view(record);
  }

  private async schedule() {
    if (this.scheduling || this.closing) return;
    this.scheduling = true;
    try {
      for (const record of this.records.values()) {
        if (this.running.size >= 2) break;
        if (record.status !== "queued") continue;
        const control: RunControl = { cancelled: false, controller: new AbortController() };
        const entry = { control, promise: Promise.resolve() };
        this.running.set(record.id, entry);
        entry.promise = this.execute(record, control).catch((error) => {
          console.error("Could not persist worker state", record.id, error instanceof Error ? error.message : String(error));
        }).finally(() => {
          this.running.delete(record.id);
          void this.schedule();
        });
      }
    } finally {
      this.scheduling = false;
    }
  }

  private async execute(record: WorkerRecord, control: RunControl) {
    let trace = Promise.resolve();
    try {
      record.status = "running";
      record.startedAt = new Date().toISOString();
      record.endedAt = undefined;
      record.error = undefined;
      record.activity = "Working on the assignment";
      record.attempts += 1;
      await this.save(record);
      const prompt = `Assignment:\n${record.task}\n\nSelected context:\n${record.context}\n\nRequired deliverable:\n${record.expectedOutput}`;
      const checkpoint = await readJson<AgentCheckpoint>(checkpointPath(record.id));
      await this.runner({ id: record.id, createdAt: record.createdAt, messages: [] }, prompt, (event) => {
        if (event.type === "browser_frame") return;
        trace = trace.then(() => appendFile(path.join(workerRoot, record.id, "activity.jsonl"), `${JSON.stringify(event)}\n`, { mode: 0o600 }));
        if (event.type === "tool_start" && record.status === "running") {
          record.activity = `Using ${event.name}`;
          trace = trace.then(() => this.save(record));
        }
        trace = trace.catch((error) => console.error("Could not persist worker activity", record.id, error instanceof Error ? error.message : String(error)));
      }, control, record.stats, {
        worker: true, model: record.model, inputDirectory: workspacePath(record.parentId),
        allowedTools: record.allowedTools, sandboxNetworkEnabled: record.networkEnabled,
        maxSteps: record.maxSteps, maxRuntimeMs: record.maxRuntimeMs,
        extraTools: [finishTaskTool], checkpoint,
        saveCheckpoint: async (state) => { await writeJson(checkpointPath(record.id), state); await this.save(record); },
        finishTask: async (args) => {
          control.controller?.signal.throwIfAborted();
          const result = await this.deliver(record, args);
          control.controller?.signal.throwIfAborted();
          record.result = result;
          record.status = result.outcome;
          record.activity = result.summary;
          record.endedAt = new Date().toISOString();
          await this.save(record);
          return JSON.stringify(result);
        },
      });
      if (record.status === "running") {
        record.status = control.cancelled ? "cancelled" : "failed";
        record.error = control.cancelled ? undefined : "Worker ended without a valid deliverable.";
        record.activity = control.cancelled ? "Stopped" : "No deliverable returned";
      }
    } catch (error) {
      record.status = control.cancelled ? (this.closing ? "interrupted" : "cancelled") : "failed";
      record.error = control.cancelled ? undefined : (error instanceof Error ? error.message : String(error));
      record.activity = control.cancelled ? "Stopped; checkpoint preserved" : "Worker failed";
    } finally {
      await trace.catch(() => {});
      await Promise.allSettled([closeBrowser(record.id), stopSandbox(record.id)]);
      record.endedAt ??= new Date().toISOString();
      await this.save(record);
    }
  }

  private async deliver(record: WorkerRecord, args: Record<string, unknown>): Promise<WorkerResult> {
    if (!["completed", "partial", "blocked"].includes(String(args.outcome))) throw new Error("Invalid outcome.");
    const summary = requiredText(args.summary, "summary", 2000);
    const output = requiredText(args.output, "output", 8000, true);
    if (!Array.isArray(args.limitations) || args.limitations.length > 12) throw new Error("Provide at most 12 limitations.");
    const limitations = args.limitations.map((item) => requiredText(item, "limitation", 1000));
    if (!Array.isArray(args.artifacts) || args.artifacts.length > 20) throw new Error("Provide at most 20 artifacts.");
    const sourceRoot = await realpath(workspacePath(record.id));
    const sources: Array<{ source: string; name: string; description: string }> = [];
    for (const [index, artifact] of args.artifacts.entries()) {
      const filename = requiredText(artifact?.path, "artifact path", 1000);
      if (path.isAbsolute(filename) || filename.split(/[\\/]/).includes("..")) throw new Error("Artifact paths must be relative to the worker workspace.");
      const source = await realpath(path.join(sourceRoot, filename));
      const details = await stat(source);
      if (!source.startsWith(`${sourceRoot}${path.sep}`) || !details.isFile() || details.size > 25 * 1024 * 1024) throw new Error("Artifact must be a file inside the worker workspace, at most 25 MB.");
      sources.push({ source, name: `${index + 1}-${path.basename(filename).replaceAll(/[^a-zA-Z0-9._-]/g, "_")}`, description: requiredText(artifact.description, "artifact description", 1000) });
    }
    const parentRoot = await realpath(workspacePath(record.parentId));
    const relative = `subagent-results/${record.id}`;
    const destination = path.join(parentRoot, relative);
    for (const directory of [path.join(parentRoot, "subagent-results"), destination]) {
      await mkdir(directory, { recursive: true });
      if (await realpath(directory) !== directory) throw new Error("Artifact destination must not be a symlink.");
    }
    const artifacts = [];
    for (const source of sources) {
      const target = path.join(destination, source.name);
      // A fresh name avoids following or overwriting a file another run created.
      const filename = `${randomUUID().slice(0, 8)}-${path.basename(target)}`;
      await copyFile(source.source, path.join(destination, filename), 1);
      artifacts.push({ path: `${relative}/${filename}`, description: source.description });
    }
    const result = { outcome: args.outcome as WorkerResult["outcome"], summary, output, artifacts, limitations };
    await writeJson(path.join(workerRoot, record.id, "result.json"), result);
    return result;
  }

  async cancel(parentId: string, id: string) {
    const record = this.owned(parentId, id);
    const running = this.running.get(record.id);
    if (running) {
      cancelRun(running.control);
      await stopSandbox(record.id);
      await running.promise;
    } else if (record.status === "queued") {
      record.status = "cancelled";
      record.activity = "Stopped before starting";
      record.endedAt = new Date().toISOString();
      await this.save(record);
    }
    return this.view(record);
  }

  async cancelParent(parentId: string) {
    await Promise.all([...this.records.values()].filter((record) => record.parentId === parentId && activeStatuses.has(record.status)).map((record) => this.cancel(parentId, record.id)));
  }

  async resume(parentId: string, parentRunId: string, id: string) {
    if (this.closing) throw new Error("Server is shutting down.");
    const record = this.owned(parentId, id);
    if (record.status !== "interrupted") throw new Error("Only interrupted workers can resume their unchanged assignment.");
    if (record.attempts >= 3) throw new Error("Worker resume limit reached; inspect the partial work and start a new assignment.");
    if ([...this.records.values()].filter((item) => item.parentId === parentId && item.parentRunId === parentRunId && item.id !== id).length >= 8) throw new Error("This turn has reached its 8-worker limit. Use the existing results.");
    const checkpoint = await readJson<AgentCheckpoint>(checkpointPath(id));
    if (checkpoint?.pendingTools.length) throw new Error(`Interrupted actions may have executed (${checkpoint.pendingTools.map((call) => call.name).join(", ")}). Reconcile their effects before starting a new assignment.`);
    record.parentRunId = parentRunId;
    record.status = "queued";
    record.activity = "Resuming the saved assignment";
    await this.save(record);
    void this.schedule();
    return this.view(record);
  }

  private async wait(parentId: string, ids: string[], signal: AbortSignal) {
    const records = ids.map((id) => this.owned(parentId, id));
    if (!records.length || records.length > 8) throw new Error("Wait for 1–8 workers.");
    if (records.every((record) => activeStatuses.has(record.status)) && !signal.aborted) {
      await new Promise<void>((resolve) => {
        const finish = () => { clearTimeout(timer); this.changes.delete(changed); signal.removeEventListener("abort", finish); resolve(); };
        const changed = () => { if (records.some((record) => !activeStatuses.has(record.status))) finish(); };
        const timer = setTimeout(finish, 30_000);
        this.changes.add(changed);
        signal.addEventListener("abort", finish, { once: true });
        changed();
      });
    }
    signal.throwIfAborted();
    return records.map((record) => this.view(record));
  }

  forTurn(parentId: string, parentRunId: string, control: RunControl, options: RunOptions = {}): RunOptions {
    const delivered = new Set<string>();
    const signal = (control.controller ??= new AbortController()).signal;
    const mark = (views: ReturnType<Subagents["list"]>) => {
      for (const record of views) if (!activeStatuses.has(record.status)) delivered.add(record.id);
      return views;
    };
    return {
      ...options,
      extraTools: delegationTools,
      context: async () => {
        const workers = this.list(parentId).slice(-20).map(({ id, status, task }) => ({ id, status, task: task.slice(0, 180) }));
        return `Delegate independent work when useful. Give each worker a distinct assignment and expected output. Workers cannot chat with users or each other. Available worker models: ${JSON.stringify(availableModels())}. Your worker inventory (runtime data): ${JSON.stringify(workers)}. Use agent_read for results; do not assume a worker's completion proves correctness. Check artifacts and sources. Finish only after required workers settle.`;
      },
      toolHandler: async (name, args, callId) => {
        signal.throwIfAborted();
        if (name === "agent_start") return this.start(parentId, parentRunId, callId, args, options);
        if (name === "agent_read") return args.id === "" ? mark(this.list(parentId)) : mark([this.view(this.owned(parentId, args.id))])[0];
        if (name === "agent_wait") {
          if (!Array.isArray(args.ids) || args.ids.some((id) => typeof id !== "string")) throw new Error("ids must be an array of worker IDs.");
          return mark(await this.wait(parentId, args.ids, signal));
        }
        if (name === "agent_cancel") return this.cancel(parentId, String(args.id));
        if (name === "agent_resume") return this.resume(parentId, parentRunId, String(args.id));
        throw new Error(`Unknown tool: ${name}`);
      },
      onIdle: async () => {
        const owned = () => this.list(parentId).filter((record) => record.parentRunId === parentRunId);
        while (owned().some((record) => activeStatuses.has(record.status))) {
          await this.wait(parentId, owned().filter((record) => activeStatuses.has(record.status)).map((record) => record.id), signal);
        }
        const fresh = owned().filter((record) => !delivered.has(record.id));
        return fresh.length ? mark(fresh) : undefined;
      },
    };
  }

  async close() {
    this.closing = true;
    for (const { control } of this.running.values()) cancelRun(control);
    await Promise.allSettled([...this.running.values()].map(({ promise }) => promise));
  }
}
