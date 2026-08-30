import { existsSync, mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { baselineNames, bestBaseline } from "./lib/fantasy-baselines.js";
import { gradeRecommendation, lineupIds, type Outcomes, type Slate } from "./lib/fantasy-eval.js";
import { atomicJson, directoryManifest, hashJson, mean, median, readState, sha256File, shadowRoot } from "./lib/shadow-eval.js";

function sql(value: unknown) {
  return `'${String(value ?? "").replaceAll("'", "''")}'`;
}

async function main() {
  const testId = process.argv[2] || "nba-shadow-final-five-v1";
  const root = shadowRoot(testId);
  const state = await readState(root);
  if (state.state !== "SEALED") throw new Error(`Grading requires SEALED state; found ${state.state}.`);
  if (state.attempts.length !== state.protocol.source_slates.length) throw new Error("Not every registered slate consumed exactly one prediction attempt.");
  for (const [file, expected] of Object.entries(state.code_hashes)) {
    if (await sha256File(path.resolve(file)) !== expected) throw new Error(`Registered code changed before grading: ${file}`);
  }
  const mappings = JSON.parse(await readFile(path.join(root, "private/grading-map.json"), "utf8")) as Record<string, { source_fixture: string; source_player_ids: string[] }>;
  mkdirSync(path.join(root, "outcomes"), { recursive: true });
  const rows: Array<Record<string, any>> = [];

  for (const slateId of state.protocol.source_slates) {
    const bundle = path.join(root, "sealed", slateId);
    const storedManifest = JSON.parse(await readFile(path.join(bundle, "MANIFEST.json"), "utf8")) as { files: Record<string, unknown>; manifest_hash: string };
    const recomputed = await directoryManifest(bundle, new Set(["MANIFEST.json"]));
    if (hashJson(recomputed) !== storedManifest.manifest_hash) throw new Error(`Sealed artifact verification failed for ${slateId}.`);
    const slate = JSON.parse(await readFile(path.join(bundle, "input/slate.json"), "utf8")) as Slate;
    const metadata = JSON.parse(await readFile(path.join(bundle, "metadata.json"), "utf8")) as Record<string, any>;
    let lineup: string[] = [];
    if (existsSync(path.join(bundle, "recommendation.json"))) {
      const recommendation = JSON.parse(await readFile(path.join(bundle, "recommendation.json"), "utf8")) as { lineup?: unknown };
      lineup = lineupIds(recommendation.lineup);
    }

    const mapping = mappings[slateId];
    const sourceOutcomeFile = path.join(mapping.source_fixture, "hidden/actual-outcomes.json");
    const sourceOutcomes = JSON.parse(await readFile(sourceOutcomeFile, "utf8")) as Outcomes;
    if (mapping.source_player_ids.length !== slate.players.length) throw new Error(`Player mapping length mismatch for ${slateId}.`);
    const actualEntries = mapping.source_player_ids.map((sourceId, index) => {
      const value = sourceOutcomes.actual_dk_points[sourceId];
      if (!Number.isFinite(value)) throw new Error(`Missing or invalid outcome for ${slateId}/${sourceId}.`);
      return [`p${index + 1}`, value] as const;
    });
    if (Object.keys(sourceOutcomes.actual_dk_points).length !== mapping.source_player_ids.length) throw new Error(`Outcome coverage mismatch for ${slateId}.`);
    const outcomes: Outcomes = { actual_dk_points: Object.fromEntries(actualEntries) };
    await atomicJson(path.join(root, "outcomes", `${slateId}.json`), outcomes);

    const agent = gradeRecommendation(slate, outcomes, lineup, bundle);
    const baselines = Object.fromEntries(baselineNames.map((name) => {
      const baselineLineup = bestBaseline(slate, name);
      return [name, gradeRecommendation(slate, outcomes, baselineLineup)];
    }));
    const technicalValid = metadata.status === "sealed_valid" && agent.legal && Boolean(agent.persistentCheckpoint?.matchesAsOf && agent.persistentCheckpoint.matchesLineup);
    rows.push({
      slate_id: slateId,
      technical_valid: technicalValid,
      prediction_status: metadata.status,
      lineup,
      agent: { points: agent.realizedPoints, regret: agent.regret, optimal_points: agent.hindsightOptimalPoints, optimal_lineup: agent.hindsightOptimalLineup },
      baselines: Object.fromEntries(Object.entries(baselines).map(([name, grade]) => [name, { lineup: grade.recommendedLineup, points: grade.realizedPoints, regret: grade.regret }])),
      tokens: metadata.totalTokens,
      duration_ms: metadata.duration_ms,
      tool_calls: metadata.toolCalls,
      bundle_hash: storedManifest.manifest_hash,
      outcome_hash: await sha256File(path.join(root, "outcomes", `${slateId}.json`)),
    });
  }

  const primary = state.protocol.primary_baseline;
  const agentRegrets = rows.map((row) => Number(row.agent.regret));
  const baselineRegrets = rows.map((row) => Number(row.baselines[primary].regret));
  const wins = rows.filter((row) => row.agent.regret < row.baselines[primary].regret).length;
  const ties = rows.filter((row) => row.agent.regret === row.baselines[primary].regret).length;
  const losses = rows.length - wins - ties;
  const technicalValid = rows.filter((row) => row.technical_valid).length;
  const agentMeanRegret = mean(agentRegrets)!;
  const primaryMeanRegret = mean(baselineRegrets)!;
  const acceptance = {
    technical_validity: technicalValid === state.protocol.acceptance.technical_validity_required,
    primary_baseline_wins: wins >= state.protocol.acceptance.minimum_primary_baseline_wins,
    lower_mean_regret: !state.protocol.acceptance.require_lower_mean_regret_than_primary_baseline || agentMeanRegret < primaryMeanRegret,
  };
  const report = {
    id: testId,
    protocol_hash: state.protocol_hash,
    registered_at: state.registered_at,
    sealed_at: state.sealed_at,
    scored_at: new Date().toISOString(),
    model: state.protocol.model,
    primary_baseline: primary,
    slates: rows.length,
    technical_valid: technicalValid,
    agent: { mean_regret: agentMeanRegret, median_regret: median(agentRegrets), mean_points: mean(rows.map((row) => Number(row.agent.points))) },
    primary_comparison: { baseline_mean_regret: primaryMeanRegret, wins, ties, losses, mean_regret_delta_agent_minus_baseline: mean(rows.map((row) => Number(row.agent.regret) - Number(row.baselines[primary].regret))) },
    all_baselines: Object.fromEntries(baselineNames.map((name) => [name, { mean_regret: mean(rows.map((row) => Number(row.baselines[name].regret))), mean_points: mean(rows.map((row) => Number(row.baselines[name].points))) }])),
    usage: { total_tokens: rows.reduce((sum, row) => sum + Number(row.tokens || 0), 0), total_tool_calls: rows.reduce((sum, row) => sum + Number(row.tool_calls || 0), 0), total_duration_ms: rows.reduce((sum, row) => sum + Number(row.duration_ms || 0), 0) },
    acceptance: { ...acceptance, passed: Object.values(acceptance).every(Boolean) },
    rows,
    limitations: state.protocol.limitations,
  };
  await atomicJson(path.join(root, "report.json"), report);
  const markdown = [
    `# ${testId}`,
    "",
    `Result: **${report.acceptance.passed ? "provisional acceptance passed" : "provisional acceptance failed"}**`,
    "",
    `- Technical validity: ${technicalValid}/${rows.length}`,
    `- Agent mean regret: ${agentMeanRegret.toFixed(2)}`,
    `- ${primary} mean regret: ${primaryMeanRegret.toFixed(2)}`,
    `- Paired result: ${wins} wins / ${ties} ties / ${losses} losses`,
    `- Tokens: ${report.usage.total_tokens}`,
    "",
    "This is directional evidence from an anonymized historical shadow test, not proof of future profitability.",
  ].join("\n");
  await writeFile(path.join(root, "REPORT.md"), `${markdown}\n`);

  const database = path.join(root, "results.sqlite");
  const statements = [`
    create table test (id text primary key, protocol_hash text not null, model text not null, registered_at text not null, sealed_at text not null, scored_at text not null, passed integer not null);
    create table scores (slate_id text primary key, technical_valid integer not null, lineup_json text not null, points real not null, optimal_points real not null, regret real not null, tokens integer not null, duration_ms integer not null, bundle_hash text not null, outcome_hash text not null);
    create table baseline_scores (slate_id text not null, name text not null, lineup_json text not null, points real not null, regret real not null, primary key (slate_id, name));
    insert into test values (${sql(testId)}, ${sql(state.protocol_hash)}, ${sql(state.protocol.model)}, ${sql(state.registered_at)}, ${sql(state.sealed_at)}, ${sql(report.scored_at)}, ${Number(report.acceptance.passed)});`,
    ...rows.map((row) => `insert into scores values (${sql(row.slate_id)}, ${Number(row.technical_valid)}, ${sql(JSON.stringify(row.lineup))}, ${row.agent.points}, ${row.agent.optimal_points}, ${row.agent.regret}, ${Number(row.tokens || 0)}, ${Number(row.duration_ms || 0)}, ${sql(row.bundle_hash)}, ${sql(row.outcome_hash)});`),
    ...rows.flatMap((row) => baselineNames.map((name) => `insert into baseline_scores values (${sql(row.slate_id)}, ${sql(name)}, ${sql(JSON.stringify(row.baselines[name].lineup))}, ${row.baselines[name].points}, ${row.baselines[name].regret});`)),
  ].join("\n");
  const written = spawnSync("sqlite3", [database], { input: statements, encoding: "utf8" });
  if (written.status !== 0) throw new Error(written.stderr || "Could not write shadow results database.");
  state.state = "SCORED";
  state.scored_at = report.scored_at;
  await atomicJson(path.join(root, "state.json"), state);
  console.log(JSON.stringify({ id: testId, state: state.state, acceptance: report.acceptance, technical_valid: technicalValid, agent_mean_regret: agentMeanRegret, primary_mean_regret: primaryMeanRegret, wins, ties, losses, root }, null, 2));
}

void main();
