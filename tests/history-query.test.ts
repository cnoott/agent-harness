import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ChatSession } from "../src/types.js";

const originalDirectory = process.cwd();
const directory = await mkdtemp(path.join(tmpdir(), "harness-history-query-"));
after(async () => { process.chdir(originalDirectory); await rm(directory, { recursive: true, force: true }); });
process.chdir(directory);
const { importHistory, readHistory, recordHistory, unfinishedRuns, withHistory, historyReadTool } = await import("../src/history.js");
const { recordAudit, redactAudit } = await import("../src/audit.js");
const { querySports, sportsQueryInstructions } = await import("../src/sports-query.js");
const { nflDatabasePath } = await import("../src/nfl-data.js");
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const brokenSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

await mkdir(path.dirname(nflDatabasePath), { recursive: true });
const database = new DatabaseSync(nflDatabasePath);
database.exec("PRAGMA user_version = 2; CREATE TABLE games (id TEXT); INSERT INTO games VALUES ('test'); CREATE TABLE nfl_schedule (id TEXT); CREATE TABLE nfl_collector_state (key TEXT, value TEXT); CREATE TABLE samples (id INTEGER PRIMARY KEY, value TEXT)");
database.prepare("INSERT INTO nfl_collector_state VALUES ('season', ?)").run(JSON.stringify({ year: 2026, type: 2, week: 1 }));
for (let id = 1; id <= 70; id++) database.prepare("INSERT INTO samples VALUES (?, ?)").run(id, '😀漢字\\\"\n'.repeat(20));
database.close();

await test("history and sports query regression checks", async t => {
  await t.test("imports legacy history idempotently without duplicating audited tool activity", () => {
    const session: ChatSession = {
      id: "legacy-history", createdAt: "2026-09-13T00:00:00Z", messages: [
        { id: "old", role: "assistant", text: "Earlier result", createdAt: "2026-09-12T00:00:00Z", activity: [
          { type: "tool_start", name: "sports_query", data: { sql: "SELECT 1" } },
        ] },
        { id: "modern", role: "assistant", text: "New result", createdAt: "2026-09-13T00:00:00Z", activity: [
          { type: "tool_end", name: "sports_query", data: { rows: [2] } },
        ] },
      ],
    };
    recordAudit(session.id, "modern", "run_start", { question: "New question" });
    recordAudit(session.id, "modern", "tool_end", { name: "sports_query", result: { rows: [2] } });
    importHistory(session);
    importHistory(session);
    session.messages[0].activity!.push({ type: "tool_end", name: "sports_query", data: { rows: [1] } });
    importHistory(session);
    importHistory(session);
    withHistory(session.id, db => {
      const rows = db.prepare("SELECT source_id, kind, created_at, data FROM events ORDER BY id").all();
      assert.equal(rows.length, 6);
      assert.equal(rows.filter(row => String(row.source_id).startsWith("activity:modern:")).length, 0);
      assert.equal(rows.filter(row => String(row.source_id).startsWith("activity:old:")).length, 2);
      assert(rows.filter(row => row.kind === "message").every(row => !Object.hasOwn(JSON.parse(String(row.data)), "activity")));
      const imported = rows.find(row => row.source_id === "activity:old:1")!;
      assert.equal(imported.created_at, session.messages[0].createdAt);
      assert.deepEqual(JSON.parse(String(imported.data)).provenance, { source: "legacy_session_activity", messageId: "old", timestampSource: "message" });
      assert.equal(rows.filter(row => row.kind === "run_start").length, 1);
    });
  });

  await t.test("caller-redacted legacy imports preserve session data and hide credentials", () => {
    process.env.HISTORY_TEST_SECRET = "history-secret-for-test";
    const session: ChatSession = { id: "redacted-history", createdAt: "2026-09-13T00:00:00Z", messages: [
      { id: "secret", role: "user", text: "history-secret-for-test", createdAt: "2026-09-13T00:00:00Z" },
    ] };
    try {
      importHistory(redactAudit(session) as ChatSession);
      assert.equal(session.messages[0].text, "history-secret-for-test");
      assert(!JSON.stringify(readHistory(session.id, {})).includes("history-secret-for-test"));
      assert(JSON.stringify(readHistory(session.id, {})).includes("[redacted]"));
    } finally { delete process.env.HISTORY_TEST_SECRET; }
  });

  await t.test("history pages reconstruct escaped Unicode data within the serialized byte budget", () => {
    const data = { name: "exec", result: { text: '😀漢字\\\"\n\u0000'.repeat(4_000) } };
    const id = recordHistory("paged-history", "tool_end", data, "", "run");
    let offset = 0;
    const chunks: string[] = [];
    for (;;) {
      const page = readHistory("paged-history", { eventId: id, offset });
      assert("content" in page);
      assert(size(page) <= 8_000);
      assert(!brokenSurrogate.test(page.content));
      chunks.push(page.content);
      if (page.nextOffset === null) break;
      assert(page.nextOffset > offset);
      offset = page.nextOffset;
    }
    assert(chunks.length > 5);
    assert.equal(chunks.join(""), JSON.stringify(data));
    const emoji = JSON.stringify(data).indexOf("😀");
    assert("error" in readHistory("paged-history", { eventId: id, offset: emoji + 1 }));
    assert("error" in readHistory("other-history", { eventId: id }));
  });

  await t.test("history search is bounded and excludes model payloads and retrieval echoes", () => {
    const chatId = "search-history";
    for (let index = 0; index < 12; index++) recordHistory(chatId, "tool_end", { name: "exec", result: "😀".repeat(700), index }, "");
    recordHistory(chatId, "model_start", { input: "excluded-marker" }, "");
    recordHistory(chatId, "model_end", { output: "excluded-marker" }, "");
    recordHistory(chatId, "tool_start", { name: "history_read", arguments: "excluded-marker" }, "");
    recordHistory(chatId, "tool_end", { name: "history_read", result: "excluded-marker" }, "");
    assert.deepEqual((readHistory(chatId, { query: "excluded-marker" }) as any).events, []);
    assert.deepEqual((readHistory("other-search", {}) as any).events, []);
    let afterEventId = 0;
    const seen: number[] = [];
    for (;;) {
      const page = readHistory(chatId, { afterEventId });
      assert("events" in page);
      assert(size(page) <= 8_000);
      assert(page.events.every(event => !brokenSurrogate.test(event.excerpt)));
      seen.push(...page.events.map(event => event.eventId));
      if (page.nextAfterEventId === null) break;
      assert(page.nextAfterEventId > afterEventId);
      afterEventId = page.nextAfterEventId;
    }
    assert.equal(seen.length, 12);
    assert.equal(new Set(seen).size, 12);
    assert.equal(historyReadTool.strict, true);
    assert.deepEqual(historyReadTool.parameters.required, ["query", "eventId", "offset", "afterEventId"]);
  });

  await t.test("uncertain actions remain discoverable after cancelled and failed run endings", () => {
    const chatId = "uncertain-history";
    for (const status of ["cancelled", "failed", "completed"]) {
      recordAudit(chatId, status, "run_start", { question: status });
      recordAudit(chatId, status, "tool_start", { callId: status, name: "exec" });
      if (status === "completed") recordAudit(chatId, status, "tool_end", { callId: status, name: "exec", result: {} });
      recordAudit(chatId, status, "run_end", { status });
    }
    recordAudit(chatId, "interrupted", "run_start", { question: "Interrupted before tool" });
    const runs = unfinishedRuns(chatId);
    assert.deepEqual(runs.map(run => run.runId), ["interrupted", "failed", "cancelled"]);
    assert.equal(runs[0].uncertainActions.length, 0);
    assert(runs.slice(1).every(run => run.uncertainActions.length === 1 && run.uncertainActions[0].name === "exec"));
  });

  await t.test("canonical season guidance executes against the collector state shape", async () => {
    const sql = sportsQueryInstructions.match(/Discover the current season and week with (SELECT .*?WHERE key = 'season')\./)?.[1];
    assert(sql);
    const result = await querySports("nfl", sql);
    assert.deepEqual(result.rows, [{ year: 2026, type: 2, week: 1 }]);
    await assert.rejects(querySports("nba", sql), /NFL workspace/);
  });

  await t.test("sports queries page complete Unicode rows without losing structure", async () => {
    const seen: number[] = [];
    let pages = 0;
    for (;;) {
      const result = await querySports("nfl", `SELECT id, value FROM samples ORDER BY id LIMIT 200 OFFSET ${seen.length}`);
      assert(size(result) <= 8_000);
      assert.deepEqual(result.columns, ["id", "value"]);
      const rows = result.rows as Array<{ id: number; value: string }>;
      assert(rows.length > 0);
      assert(rows.every(row => row.value === '😀漢字\\\"\n'.repeat(20)));
      seen.push(...rows.map(row => row.id));
      pages++;
      if (!result.truncated) break;
    }
    assert(pages > 1);
    assert.deepEqual(seen, Array.from({ length: 70 }, (_, index) => index + 1));
  });

  await t.test("sports queries enforce exact byte and row limits with actionable oversize failures", async () => {
    const empty = { columns: ["value"], rows: [{ value: "" }], truncated: false };
    const text = "x".repeat(8_000 - size(empty));
    const exact = await querySports("nfl", `SELECT '${text}' AS value`);
    assert.equal(size(exact), 8_000);
    assert.equal(exact.truncated, false);
    await assert.rejects(querySports("nfl", `SELECT '${text}x' AS value`), /row exceeds.*select fewer columns or use substr/);
    await assert.rejects(querySports("nfl", `SELECT 1 AS "${"c".repeat(8_100)}"`), /column metadata.*shorter aliases/);
    const rows = await querySports("nfl", "WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < 201) SELECT n FROM numbers ORDER BY n");
    assert.equal((rows.rows as unknown[]).length, 200);
    assert.equal(rows.truncated, true);
    assert(size(rows) <= 8_000);
    await assert.rejects(querySports("nfl", "SELECT 1; DELETE FROM samples"), /Multiple statements/);
  });
});
