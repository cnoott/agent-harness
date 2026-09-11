import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";

const directory = await mkdtemp(path.join(tmpdir(), "harness-workers-"));
after(async () => { process.chdir(tmpdir()); await rm(directory, { recursive: true, force: true }); });
process.chdir(directory);
process.env.OPENAI_API_KEY = "self-test-key";
process.env.GEMINI_API_KEY = "self-test-key";
process.env.OPENAI_SUBAGENT_MODELS = "worker-openai";
process.env.GEMINI_SUBAGENT_MODELS = "worker-gemini";
const { Subagents } = await import("../src/subagents.js");
const { createSession, workspacePath, listSessions } = await import("../src/store.js");
const { runAgent, cancelRun } = await import("../src/agent.js");
const { writeJson } = await import("../src/run-state.js");
type Runner = typeof runAgent;
const assignment = { task: "Calculate a result", context: "selected context", expectedOutput: "An answer", provider: "openai", model: "worker-openai" };
const result = { outcome: "completed", summary: "Verified answer", output: "42", artifacts: [], limitations: [] };
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function settled(manager: InstanceType<typeof Subagents>, parentId: string, id: string) {
  for (let attempt = 0; attempt < 250; attempt++) {
    const record = manager.list(parentId).find((item) => item.id === id)!;
    if (!["queued", "running"].includes(record.status)) return record;
    await delay(20);
  }
  throw new Error("Worker did not settle");
}

await test("sub-agent lifecycle and isolation", async (t) => {
  const parent = await createSession();
  parent.messages.push({ id: "secret", role: "user", text: "PARENT_PRIVATE_HISTORY", createdAt: new Date().toISOString() });
  let active = 0;
  let peak = 0;
  const seen: Array<{ prompt: string; tools: string[]; provider: string | undefined }> = [];
  const runner: Runner = async (session, prompt, _emit, control, _stats, options = {}) => {
    active++;
    peak = Math.max(peak, active);
    seen.push({ prompt, tools: options.extraTools?.map((item) => item.name) ?? [], provider: options.model?.provider });
    try {
      await delay(100);
      if (control.cancelled) return "stopped";
      await writeFile(path.join(workspacePath(session.id), "answer.txt"), "42\n");
      return await options.finishTask!({ ...result, artifacts: [{ path: "answer.txt", description: "Answer" }] });
    } finally { active--; }
  };
  const manager = new Subagents(runner);
  await t.test("queues workers with two concurrent slots and mixed providers", async () => {
    const [first, concurrentDuplicate] = await Promise.all([
      manager.start(parent.id, "turn-a", "call-a", assignment),
      manager.start(parent.id, "turn-a", "call-a", assignment),
    ]);
    assert.equal(concurrentDuplicate.id, first.id);
    const second = await manager.start(parent.id, "turn-a", "call-b", { ...assignment, provider: "gemini", model: "worker-gemini" });
    const third = await manager.start(parent.id, "turn-a", "call-c", assignment);
    assert.equal(third.status, "queued");
    const records = await Promise.all([first, second, third].map((record) => settled(manager, parent.id, record.id)));
    assert.equal(peak, 2);
    assert(records.every((record) => record.status === "completed"));
    assert.equal(await readFile(path.join(workspacePath(parent.id), records[0].result!.artifacts[0].path), "utf8"), "42\n");
    assert(seen.some((item) => item.provider === "gemini"));
    assert(seen.every((item) => !item.prompt.includes("PARENT_PRIVATE_HISTORY")));
    assert(seen.every((item) => item.tools.join(",") === "finish_task"));
    assert.equal((await listSessions()).length, 1);
    assert(!JSON.stringify(manager.list(parent.id)).includes("selected context"));
    assert(!JSON.stringify(manager.list(parent.id)).includes("geminiContents"));
    const duplicate = await manager.start(parent.id, "turn-a", "call-a", assignment);
    assert.equal(duplicate.id, first.id);
    assert.equal(manager.list(parent.id).length, 3);
  });
  await t.test("rejects cross-chat access and unavailable models", async () => {
    await assert.rejects(manager.cancel("other-chat", manager.list(parent.id)[0].id), /not found/);
    await assert.rejects(manager.start(parent.id, "turn-a", "bad-model", { ...assignment, model: "unknown" }), /configured model/);
  });
  await manager.close();

  await t.test("returns blocked outcomes without creating a chat", async () => {
    const blocked = new Subagents(async (_session, _prompt, _emit, _control, _stats, options) => options!.finishTask!({ ...result, outcome: "blocked", summary: "Login required", output: "", limitations: ["Needs user login"] }));
    const record = await blocked.start(parent.id, "blocked-turn", "blocked", assignment);
    assert.equal((await settled(blocked, parent.id, record.id)).status, "blocked");
    await blocked.close();
  });

  await t.test("rejects escaped artifacts and accepts a corrected deliverable", async () => {
    const safe = new Subagents(async (session, _prompt, _emit, _control, _stats, options) => {
      await symlink("/etc/hosts", path.join(workspacePath(session.id), "escape"));
      await assert.rejects(options!.finishTask!({ ...result, artifacts: [{ path: "../run.json", description: "escape" }] }), /relative/);
      await assert.rejects(options!.finishTask!({ ...result, artifacts: [{ path: "escape", description: "escape" }] }), /inside/);
      await assert.rejects(options!.finishTask!({ ...result, output: "x".repeat(8001) }), /8000/);
      return options!.finishTask!(result);
    });
    const record = await safe.start(parent.id, "safe-turn", "safe", assignment);
    assert.equal((await settled(safe, parent.id, record.id)).status, "completed");
    await safe.close();
  });

  await t.test("cancels running and queued workers and propagates restrictions", async () => {
    let stopped = 0;
    const cancellable = new Subagents(async (_session, _prompt, _emit, control, _stats, options) => {
      assert.deepEqual(options!.allowedTools, ["exec"]);
      assert.equal(options!.sandboxNetworkEnabled, false);
      await new Promise<void>((resolve) => {
        if (control.controller!.signal.aborted) resolve();
        else control.controller!.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      stopped++;
      return "stopped";
    });
    for (const id of ["one", "two", "three"]) await cancellable.start(parent.id, "cancel-turn", id, assignment, { sandboxNetworkEnabled: false });
    await delay(30);
    await cancellable.cancelParent(parent.id);
    assert(cancellable.list(parent.id).every((record) => record.status === "cancelled"));
    assert.equal(stopped, 2);
    await cancellable.close();
  });

  await t.test("restart preserves results and prevents uncertain tool replay", async () => {
    const interruptedId = `worker-${"a".repeat(32)}`;
    const safeId = `worker-${"b".repeat(32)}`;
    for (const id of [interruptedId, safeId]) {
      const base = JSON.parse(await readFile(path.join(".data/agents", manager.list(parent.id)[0].id, "run.json"), "utf8"));
      await mkdir(workspacePath(id), { recursive: true });
      await writeJson(path.join(".data/agents", id, "run.json"), { ...base, id, status: "running", result: undefined });
      await writeJson(path.join(".data/agents", id, "checkpoint.json"), { input: "saved task", geminiContents: [], steps: 2, progress: "saved progress", pendingTools: id === interruptedId ? [{ name: "exec", callId: "uncertain" }] : [] });
    }
    let resumed = false;
    const recovered = new Subagents(async (_session, _prompt, _emit, _control, _stats, options) => {
      assert.equal(options!.checkpoint!.progress, "saved progress");
      resumed = true;
      return options!.finishTask!(result);
    });
    await recovered.initialize();
    assert.equal(recovered.list(parent.id).find((record) => record.id === interruptedId)!.status, "interrupted");
    await assert.rejects(recovered.resume(parent.id, "resume-turn", interruptedId), /may have executed/);
    await recovered.resume(parent.id, "resume-turn", safeId);
    assert.equal((await settled(recovered, parent.id, safeId)).status, "completed");
    assert(resumed);
    assert(recovered.list(parent.id).some((record) => record.result?.output === "42"));
    await recovered.close();
  });
});

await test("actual agent loop keeps progress separate, validates finish, and enforces limits", async () => {
  let mode = "finish";
  let requests = 0;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    requests++;
    assert.equal(input.model, "worker-openai");
    assert(input.tools.some((tool: any) => tool.name === "finish_task"));
    assert(!input.tools.some((tool: any) => tool.name === "agent_start"));
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "PRIVATE_PROGRESS" })}\n\n`);
    if (mode === "abort") return;
    const output = mode === "finish" ? [{ type: "function_call", name: "finish_task", call_id: "finish-1", arguments: JSON.stringify(result) }] : [];
    response.end(`data: ${JSON.stringify({ type: "response.completed", response: { id: `response-${requests}`, output, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const { finishTaskTool } = await import("../src/subagents.js");
  const session = { id: `worker-${"c".repeat(32)}`, messages: [], createdAt: new Date().toISOString() };
  const options = { worker: true, model: { provider: "openai" as const, model: "worker-openai" }, allowedTools: [], extraTools: [finishTaskTool], maxSteps: 2, finishTask: async (args: any) => JSON.stringify(args) };
  try {
    const answer = await runAgent(session, "test", () => {}, { cancelled: false }, undefined, options);
    assert(!answer.includes("PRIVATE_PROGRESS"));
    assert.equal(JSON.parse(answer).output, "42");
    mode = "no-finish";
    requests = 0;
    await assert.rejects(runAgent(session, "test", () => {}, { cancelled: false }, undefined, options), /call limit/);
    assert.equal(requests, 2);
    mode = "abort";
    const control = { cancelled: false, controller: new AbortController() };
    const pending = runAgent(session, "test", () => {}, control, undefined, options);
    await delay(100);
    cancelRun(control);
    await pending;
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env.OPENAI_BASE_URL;
  }
});

await test("Gemini compacts at a safe tool boundary and resumes with the task intact", async () => {
  let compactions = 0;
  let streamCalls = 0;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    if (request.url!.includes(":generateContent")) {
      compactions++;
      assert(JSON.stringify(input.contents).includes("large historical result"));
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "Verified total: 42. Next: deliver the answer." }] }, finishReason: "STOP" }], usageMetadata: { totalTokenCount: 25 } }));
      return;
    }
    streamCalls++;
    assert(JSON.stringify(input.contents).includes("ORIGINAL_ASSIGNMENT"));
    assert(JSON.stringify(input.contents).includes("Verified total: 42"));
    assert(!JSON.stringify(input.contents).includes("large historical result"));
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "finish_task", args: result } }] }, finishReason: "STOP" }], usageMetadata: { totalTokenCount: 15 } })}\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.GOOGLE_GEMINI_BASE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const { finishTaskTool } = await import("../src/subagents.js");
  try {
    const checkpoints: any[] = [];
    const answer = await runAgent({ id: `worker-${"d".repeat(32)}`, messages: [], createdAt: new Date().toISOString() }, "ORIGINAL_ASSIGNMENT", () => {}, { cancelled: false }, undefined, {
      worker: true, model: { provider: "gemini", model: "worker-gemini" }, allowedTools: [], extraTools: [finishTaskTool],
      checkpoint: { input: "original", geminiContents: [{ role: "user", parts: [{ text: "large historical result ".repeat(3500) }] }], steps: 3, progress: "", pendingTools: [] },
      saveCheckpoint: async (checkpoint) => { checkpoints.push(structuredClone(checkpoint)); },
      finishTask: async (args) => JSON.stringify(args),
    });
    assert.equal(JSON.parse(answer).output, "42");
    assert.equal(compactions, 1);
    assert.equal(streamCalls, 1);
    assert(checkpoints.some((checkpoint) => checkpoint.progress.includes("Verified total: 42")));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env.GOOGLE_GEMINI_BASE_URL;
  }
});
