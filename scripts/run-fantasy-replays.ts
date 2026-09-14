import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { emptyRunStats, runAgent } from "../src/agent.js";
import { getModelConfig } from "../src/model.js";
import { stopSandbox } from "../src/sandbox.js";
import { createSession, workspacePath } from "../src/store.js";
import { gradeRecommendation, legalLineups, lineupIds, readFixture } from "./lib/fantasy-eval.js";
import { baselineNames, bestBaseline } from "./lib/fantasy-baselines.js";

type BaselineResult = { name: string; lineup: string[]; points: number; regret: number };

function option(name: string, fallback?: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function sql(value: unknown) {
  return `'${String(value ?? "").replaceAll("'", "''")}'`;
}

function initializeLedger(database: string) {
  mkdirSync(path.dirname(database), { recursive: true });
  const schema = `
    pragma journal_mode=wal;
    create table if not exists replay_runs (
      run_id text primary key, started_at text not null, slate_id text not null,
      model text not null, session_id text, status text not null, legal integer,
      checkpoint_ok integer, realized_points real, optimal_points real, regret real,
      duration_ms integer, tool_calls integer, response_count integer,
      input_tokens integer, output_tokens integer, total_tokens integer,
      error text, recommendation_json text, fixture_hash text
    );
    create table if not exists baseline_results (
      run_id text not null, name text not null, lineup_json text not null,
      realized_points real not null, regret real not null,
      primary key (run_id, name)
    );`;
  const result = spawnSync("sqlite3", [database], { input: schema, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || "Could not initialize replay ledger");
  const columns = spawnSync("sqlite3", [database, "pragma table_info(replay_runs);"], { encoding: "utf8" });
  if (!columns.stdout.split("\n").some((line) => line.split("|")[1] === "fixture_hash")) {
    const migration = spawnSync("sqlite3", [database, "alter table replay_runs add column fixture_hash text;"], { encoding: "utf8" });
    if (migration.status !== 0) throw new Error(migration.stderr || "Could not add fixture hash to replay ledger");
  }
}

function writeLedger(database: string, row: Record<string, unknown>, baselines: BaselineResult[]) {
  const insert = `begin;
    insert into replay_runs (
      run_id, started_at, slate_id, model, session_id, status, legal, checkpoint_ok,
      realized_points, optimal_points, regret, duration_ms, tool_calls, response_count,
      input_tokens, output_tokens, total_tokens, error, recommendation_json, fixture_hash
    ) values (
      ${sql(row.runId)}, ${sql(row.startedAt)}, ${sql(row.slateId)}, ${sql(row.model)}, ${sql(row.sessionId)}, ${sql(row.status)},
      ${Number(row.legal || 0)}, ${Number(row.checkpointOk || 0)}, ${Number(row.realizedPoints || 0)}, ${Number(row.optimalPoints || 0)},
      ${Number(row.regret || 0)}, ${Number(row.durationMs || 0)}, ${Number(row.toolCalls || 0)}, ${Number(row.responseCount || 0)},
      ${Number(row.inputTokens || 0)}, ${Number(row.outputTokens || 0)}, ${Number(row.totalTokens || 0)}, ${sql(row.error)}, ${sql(row.recommendationJson)}, ${sql(row.fixtureHash)}
    );
    ${baselines.map((baseline) => `insert into baseline_results values (${sql(row.runId)}, ${sql(baseline.name)}, ${sql(JSON.stringify(baseline.lineup))}, ${baseline.points}, ${baseline.regret});`).join("\n")}
    commit;`;
  const result = spawnSync("sqlite3", [database], { input: insert, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || "Could not write replay ledger");
}

async function main() {
  const fixtureRoot = path.resolve(option("--fixtures", "fixtures/fantasy-nba-replay")!);
  const manifest = JSON.parse(await readFile(path.join(fixtureRoot, "manifest.json"), "utf8")) as { slates: string[] };
  const limit = Math.max(1, Number(option("--limit", "3")));
  const selected = manifest.slates.slice(0, limit);
  const runAgentFlag = process.argv.includes("--agent");
  const ledger = path.resolve(option("--ledger", ".data/evals/fantasy-replays.sqlite")!);
  const { model } = getModelConfig();
  initializeLedger(ledger);
  const results: Array<Record<string, unknown>> = [];

  for (const slateId of selected) {
    const runId = randomUUID();
    const startedAt = new Date().toISOString();
    const fixture = path.join(fixtureRoot, slateId);
    const fixtureMaterial = await Promise.all([
      readFile(path.join(fixture, "visible/slate.json")),
      readFile(path.join(fixture, "visible/request.md")),
      readFile(path.join(fixture, "hidden/actual-outcomes.json")),
    ]);
    const fixtureHash = createHash("sha256").update(Buffer.concat(fixtureMaterial)).digest("hex");
    const { slate, outcomes } = await readFixture(fixture);
    const optimal = gradeRecommendation(slate, outcomes, legalLineups(slate)[0]).hindsightOptimalPoints;
    const baselines = baselineNames.map((name) => {
      const lineup = bestBaseline(slate, name);
      const grade = gradeRecommendation(slate, outcomes, lineup);
      return { name, lineup, points: grade.realizedPoints, regret: grade.regret };
    });
    let row: Record<string, unknown> = { runId, startedAt, slateId, fixtureHash, model, status: runAgentFlag ? "running" : "baselines_only" };

    if (runAgentFlag) {
      const session = await createSession();
      const workspace = workspacePath(session.id);
      const stats = emptyRunStats();
      const started = Date.now();
      try {
        await cp(path.join(fixture, "visible"), workspace, { recursive: true });
        const prompt = await readFile(path.join(workspace, "request.md"), "utf8");
        await runAgent(session, prompt, () => undefined, { cancelled: false }, stats, {
          allowedTools: ["exec"], sandboxNetworkEnabled: false,
        });
        const recommendationPath = path.join(workspace, "recommendation.json");
        if (!existsSync(recommendationPath)) throw new Error("Agent did not create recommendation.json");
        const recommendationText = await readFile(recommendationPath, "utf8");
        const recommendation = JSON.parse(recommendationText) as { lineup?: unknown };
        const lineup = lineupIds(recommendation.lineup);
        const grade = gradeRecommendation(slate, outcomes, lineup, workspace);
        const checkpoint = grade.persistentCheckpoint;
        row = {
          ...row,
          sessionId: session.id,
          status: grade.legal && checkpoint?.matchesAsOf && checkpoint.matchesLineup ? "passed" : "failed",
          legal: Number(grade.legal),
          checkpointOk: Number(Boolean(checkpoint?.table && checkpoint.rows > 0 && checkpoint.matchesAsOf && checkpoint.matchesLineup)),
          realizedPoints: grade.realizedPoints,
          optimalPoints: grade.hindsightOptimalPoints,
          regret: grade.regret,
          durationMs: Date.now() - started,
          ...stats,
          recommendationJson: recommendationText,
        };
      } catch (error) {
        row = { ...row, sessionId: session.id, status: "error", durationMs: Date.now() - started, ...stats, error: error instanceof Error ? error.message : String(error) };
      } finally {
        await stopSandbox(session.id);
      }
    } else {
      row = { ...row, optimalPoints: optimal };
    }

    writeLedger(ledger, row, baselines);
    results.push({ ...row, baselines });
    console.log(`${slateId}: ${row.status}${runAgentFlag ? ` regret=${row.regret ?? "n/a"}` : ""}`);
  }

  const agentRows = results.filter((row) => row.status !== "baselines_only");
  const scoredAgentRows = agentRows.filter((row) => typeof row.regret === "number" && Number.isFinite(row.regret));
  const summary = {
    generatedAt: new Date().toISOString(),
    fixtureRoot,
    ledger,
    model,
    slates: selected.length,
    agentRuns: agentRows.length,
    scoredAgentRuns: scoredAgentRows.length,
    passed: agentRows.filter((row) => row.status === "passed").length,
    meanRegret: scoredAgentRows.length ? scoredAgentRows.reduce((sum, row) => sum + Number(row.regret), 0) / scoredAgentRows.length : null,
    totalTokens: agentRows.reduce((sum, row) => sum + Number(row.totalTokens || 0), 0),
    results,
  };
  await mkdir(path.dirname(ledger), { recursive: true });
  await writeFile(path.join(path.dirname(ledger), "latest-fantasy-replay.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify({ passed: summary.passed, agentRuns: summary.agentRuns, meanRegret: summary.meanRegret, totalTokens: summary.totalTokens, ledger }, null, 2));
  if (agentRows.some((row) => row.status !== "passed")) process.exitCode = 1;
}

void main();
