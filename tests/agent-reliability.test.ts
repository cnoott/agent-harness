import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import type { ToolEvent } from "../src/types.js";

const directory = await mkdtemp(path.join(tmpdir(), "harness-agent-reliability-"));
process.chdir(directory);
process.env.OPENAI_API_KEY = "self-test-key";
after(async () => { process.chdir(tmpdir()); await rm(directory, { recursive: true, force: true }); });
const { runAgent, cancelRun } = await import("../src/agent.js");
const { createSession, workspacePath } = await import("../src/store.js");
const { withHistory } = await import("../src/history.js");
const { SandboxExecutionError } = await import("../src/sandbox.js");

test("agent correlates failures, malformed arguments, history reads, and restrictions", async () => {
  let calls: any[] = [];
  let requests: any[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    requests.push(JSON.parse(raw));
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ type: "response.completed", response: { id: `r-${requests.length}`, output: requests.length === 1 ? calls : [], output_text: "done", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const session = await createSession("nfl");
    session.messages.push({ id: "prior", role: "user", text: "Saved evidence 🏈", createdAt: session.createdAt });
    calls = [{ type: "function_call", name: "example", call_id: "provider-1", arguments: "{}" }, { type: "function_call", name: "example", call_id: "provider-2", arguments: "broken{" }];
    const events: ToolEvent[] = [];
    await runAgent(session, "test", event => events.push(event), { cancelled: false }, undefined, {
      model: { provider: "openai", model: "mock" }, extraTools: [{ type: "function", name: "example", parameters: { type: "object", properties: {} } }], toolHandler: async () => ({ success: false, message: "failed action" }),
    });
    const starts = events.filter(e => e.type === "tool_start");
    const ends = events.filter(e => e.type === "tool_end");
    assert.equal(starts.length, 2);
    assert.equal(new Set(starts.map(e => e.callId)).size, 2);
    assert.deepEqual(ends.map(e => e.callId), starts.map(e => e.callId));
    assert(ends.every(e => e.status === "failed" && typeof e.durationMs === "number"));
    const audit = withHistory(session.id, db => db.prepare("SELECT data FROM events WHERE kind='tool_end'").all());
    assert(audit.every(row => JSON.parse(String(row.data)).status === "failed"));
    assert(requests[0].tools.some((tool: any) => tool.name === "history_read"));

    requests = [];
    calls = [{ type: "function_call", name: "history_read", call_id: "history-1", arguments: JSON.stringify({ query: "Saved evidence", eventId: 0, offset: 0, afterEventId: 0 }) }];
    await runAgent(session, "find evidence", () => {}, { cancelled: false }, undefined, { model: { provider: "openai", model: "mock" } });
    assert(JSON.parse(requests[1].input[0].output).events.some((e: any) => e.excerpt.includes("Saved evidence")));
    requests = [];
    await runAgent(session, "only sports", () => {}, { cancelled: false }, undefined, { model: { provider: "openai", model: "mock" }, allowedTools: ["sports_query"] });
    assert.deepEqual(requests[0].tools.map((tool: any) => tool.name), ["sports_query"]);
    assert.match(JSON.parse(requests[1].input[0].output).error, /not enabled/);

    await mkdir(path.join(directory, ".data/sports"), { recursive: true });
    const sports = new DatabaseSync(path.join(directory, ".data/sports/nfl.sqlite"));
    sports.exec("CREATE TABLE games(id TEXT); INSERT INTO games VALUES ('fixture'); PRAGMA user_version=1;");
    sports.close();
    requests = [];
    calls = [{ type: "function_call", name: "sports_query", call_id: "sports-1", arguments: JSON.stringify({ sql: "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<50) SELECT x,printf('%200s','evidence') AS evidence FROM n ORDER BY x" }) }];
    await runAgent(session, "read saved rows", () => {}, { cancelled: false }, undefined, { model: { provider: "openai", model: "mock" }, allowedTools: ["sports_query"] });
    const structured = JSON.parse(requests[1].input[0].output);
    assert(structured.rows.length > 0 && structured.truncated);
    assert.deepEqual(structured.columns, ["x", "evidence"]);
    assert(Buffer.byteLength(JSON.stringify(structured)) <= 8000);
    assert(!("preview" in structured));

    requests = [];
    calls = [{ type: "function_call", name: "example", call_id: "escaped-result", arguments: "{}" }];
    const escaped = await createSession();
    const outside = await mkdtemp(path.join(directory, "outside-"));
    await symlink(outside, path.join(workspacePath(escaped.id), ".harness"));
    await runAgent(escaped, "save large result", () => {}, { cancelled: false }, undefined, {
      model: { provider: "openai", model: "mock" }, extraTools: [{ type: "function", name: "example", parameters: { type: "object", properties: {} } }],
      toolHandler: async () => ({ text: "evidence".repeat(2000) }),
    });
    assert.match(JSON.parse(requests[1].input[0].output).error, /symlink/);
    assert.deepEqual(await readdir(outside), []);

    requests = [];
    calls = [{ type: "function_call", name: "example", call_id: "cancel-1", arguments: "{}" }];
    const control = { cancelled: false, controller: new AbortController() };
    const interruptedEvents: ToolEvent[] = [];
    await assert.rejects(runAgent(session, "cancel", e => interruptedEvents.push(e), control, undefined, {
      model: { provider: "openai", model: "mock" }, extraTools: [{ type: "function", name: "example", parameters: { type: "object", properties: {} } }],
      toolHandler: async () => { cancelRun(control); throw new Error("interrupted"); },
    }));
    assert.equal(interruptedEvents.find(e => e.type === "tool_end")?.status, "interrupted");

    requests = [];
    const unknownEvents: ToolEvent[] = [];
    const log = { path: "/workspace/partial.log", bytes: 0, bytesSeen: 0, sha256: "fixture" };
    await assert.rejects(runAgent(session, "unconfirmed termination", e => unknownEvents.push(e), { cancelled: false }, undefined, {
      runId: "unknown-stop", model: { provider: "openai", model: "mock" }, extraTools: [{ type: "function", name: "example", parameters: { type: "object", properties: {} } }],
      toolHandler: async () => { throw new SandboxExecutionError("Could not confirm termination", {
        stdout: "", stderr: "", exitCode: 1, outputFiles: { stdout: log, stderr: log }, metadataFile: "/workspace/metadata.json",
        truncated: false, outputLimitExceeded: true, cancelled: false, terminationConfirmed: false,
      }); },
    }), /confirm termination/);
    assert.equal(unknownEvents.find(e => e.type === "tool_end")?.status, "interrupted");
    assert.equal(withHistory(session.id, db => db.prepare("SELECT count(*) AS n FROM events WHERE run_id='unknown-stop' AND kind='tool_end'").get()!.n), 0);
  } finally {
    delete process.env.OPENAI_BASE_URL;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("the run deadline includes durable memory refresh", async () => {
  let requests = 0;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    requests++;
    const body = JSON.parse(raw);
    if (!body.stream) {
      await new Promise(resolve => setTimeout(resolve, 250));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "memory", output: [{ type: "message", content: [{ type: "output_text", text: "Saved memory" }] }] }));
    } else {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ type: "response.completed", response: { id: "done", output: [], output_text: "done" } })}\n\ndata: [DONE]\n\n`);
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const session = await createSession("nfl");
    session.messages = Array.from({ length: 10 }, (_, index) => ({ id: `message-${index}`, role: "user", text: "Older context", createdAt: session.createdAt }));
    await assert.rejects(runAgent(session, "continue", () => {}, { cancelled: false }, undefined, {
      model: { provider: "openai", model: "mock" }, maxRuntimeMs: 50,
    }), /Run time limit reached/);
    assert.equal(requests, 1, "An expired run must not start the main model request");
  } finally {
    delete process.env.OPENAI_BASE_URL;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
