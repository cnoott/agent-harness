import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

export type Player = { id: string; name: string; positions: string[] };
export type Slate = {
  id?: string;
  as_of: string;
  slots: string[];
  players: Array<Player & Record<string, unknown>>;
};
export type Outcomes = { actual_dk_points: Record<string, number> };

export function isEligible(player: Player, slot: string) {
  if (slot === "UTIL") return true;
  if (slot === "F") return player.positions.some((position) => position === "F" || position === "SF" || position === "PF");
  if (slot === "G") return player.positions.some((position) => position === "G" || position === "PG" || position === "SG");
  return player.positions.includes(slot);
}

export function legalLineups(slate: Slate) {
  const lineups: string[][] = [];
  const visit = (slotIndex: number, chosen: string[]) => {
    if (slotIndex === slate.slots.length) {
      lineups.push([...chosen]);
      return;
    }
    for (const player of slate.players) {
      if (!chosen.includes(player.id) && isEligible(player, slate.slots[slotIndex])) {
        chosen.push(player.id);
        visit(slotIndex + 1, chosen);
        chosen.pop();
      }
    }
  };
  visit(0, []);
  return lineups;
}

export function lineupIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    if (typeof entry === "string" || typeof entry === "number") return String(entry);
    if (entry && typeof entry === "object" && "player_id" in entry) return String((entry as { player_id: unknown }).player_id);
    if (entry && typeof entry === "object" && "id" in entry) return String((entry as { id: unknown }).id);
    return "";
  }).filter(Boolean);
}

function normalizedStoredLineup(value: string) {
  try {
    return lineupIds(JSON.parse(value));
  } catch {
    return value.split(",").map((part) => part.trim()).filter(Boolean);
  }
}

export function readCheckpoint(workspace: string, expectedAsOf: string, expectedLineup: string[]) {
  const database = path.join(workspace, "fantasy.sqlite");
  const base = { exists: false, table: false, rows: 0, matchesAsOf: false, matchesLineup: false };
  if (!existsSync(database)) return base;
  const tables = spawnSync("sqlite3", [database, "select name from sqlite_master where type='table' and name='recommendations';"], { encoding: "utf8" });
  if (tables.status !== 0 || !tables.stdout.trim()) return { ...base, exists: true };
  const row = spawnSync("sqlite3", ["-json", database, "select as_of, lineup from recommendations;"], { encoding: "utf8" });
  if (row.status !== 0) return { ...base, exists: true, table: true };
  let rows: Array<{ as_of?: string; lineup?: string }> = [];
  try { rows = JSON.parse(row.stdout || "[]") as Array<{ as_of?: string; lineup?: string }>; } catch { return { ...base, exists: true, table: true }; }
  const matching = rows.some((candidate) => candidate.as_of === expectedAsOf && normalizedStoredLineup(candidate.lineup || "").join("|") === expectedLineup.join("|"));
  return {
    exists: true,
    table: true,
    rows: rows.length,
    matchesAsOf: matching,
    matchesLineup: matching,
  };
}

export function scoreLineup(lineup: string[], outcomes: Outcomes) {
  return lineup.reduce((sum, id) => {
    const value = outcomes.actual_dk_points[id];
    if (!Number.isFinite(value)) throw new Error(`Missing or invalid outcome for player ${id}.`);
    return sum + value;
  }, 0);
}

export function gradeRecommendation(slate: Slate, outcomes: Outcomes, lineup: string[], workspace?: string) {
  const validLineups = legalLineups(slate);
  const legal = validLineups.some((candidate) => candidate.join("|") === lineup.join("|"));
  const realizedPoints = legal ? scoreLineup(lineup, outcomes) : 0;
  const optimal = validLineups
    .map((candidate) => ({ lineup: candidate, total: scoreLineup(candidate, outcomes) }))
    .sort((left, right) => right.total - left.total)[0];
  const checkpoint = workspace ? readCheckpoint(workspace, slate.as_of, lineup) : undefined;
  return {
    legal,
    persistentCheckpoint: checkpoint,
    recommendedLineup: lineup,
    realizedPoints,
    hindsightOptimalLineup: optimal.lineup,
    hindsightOptimalPoints: optimal.total,
    regret: optimal.total - realizedPoints,
  };
}

export async function readFixture(fixture: string) {
  const slate = JSON.parse(await readFile(path.join(fixture, "visible/slate.json"), "utf8")) as Slate;
  const outcomes = JSON.parse(await readFile(path.join(fixture, "hidden/actual-outcomes.json"), "utf8")) as Outcomes;
  const ids = slate.players.map((player) => player.id);
  if (new Set(ids).size !== ids.length) throw new Error(`Fixture ${fixture} contains duplicate player IDs.`);
  if (Object.keys(outcomes.actual_dk_points).length !== ids.length || ids.some((id) => !Number.isFinite(outcomes.actual_dk_points[id]))) {
    throw new Error(`Fixture ${fixture} does not have exact finite outcome coverage.`);
  }
  return { slate, outcomes };
}
