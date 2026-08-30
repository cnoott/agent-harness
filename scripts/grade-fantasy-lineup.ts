import { readFile } from "node:fs/promises";
import path from "node:path";
import { gradeRecommendation, lineupIds, readFixture } from "./lib/fantasy-eval.js";

async function main() {
  const [workspace = process.cwd(), fixture = path.resolve("fixtures/fantasy-nba-dk")] = process.argv.slice(2);
  const { slate, outcomes } = await readFixture(fixture);
  const recommendation = JSON.parse(await readFile(path.join(workspace, "recommendation.json"), "utf8")) as { lineup?: unknown };
  const lineup = lineupIds(recommendation.lineup);
  const result = gradeRecommendation(slate, outcomes, lineup, workspace);
  console.log(JSON.stringify(result, null, 2));
  const checkpoint = result.persistentCheckpoint;
  if (!result.legal || !checkpoint?.table || checkpoint.rows < 1 || !checkpoint.matchesAsOf || !checkpoint.matchesLineup) process.exitCode = 1;
}

void main();
