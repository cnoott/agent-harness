import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { after, test } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = await mkdtemp(path.join(tmpdir(), "harness-rosters-"));
process.chdir(directory);
after(async () => { process.chdir(tmpdir()); await rm(directory, { recursive: true, force: true }); });
const { createSession, workspacePath } = await import("../src/store.js");
const { readLeagueRosters } = await import("../src/league-rosters.js");

test("saved rosters preserve empty slots and reject duplicate or overlapping assignments", async () => {
  const session = await createSession("nfl");
  const root = workspacePath(session.id);
  const leagueId = "123456789012345678";
  await writeFile(path.join(root, "LEAGUE.md"), `League name / ID: ${leagueId}\nMy team: roster 1\n`);
  const folder = path.join(root, "data/sleeper", leagueId);
  await mkdir(folder, { recursive: true });
  const snapshot = {
    league: { league_id: leagueId, sport: "nfl", total_rosters: 1, scoring_settings: {}, roster_positions: ["QB", "FLEX", "FLEX", "BN"] },
    rosters: [{ league_id: leagueId, roster_id: 1, players: ["p1", "p2"], starters: ["p1", "0", "0"], reserve: [] as string[], taxi: [] as string[] }],
    users: [], summary: { league_id: leagueId, fetched_at: "2026-09-13T18:00:00Z" },
  };
  const save = (value: typeof snapshot) => writeFile(path.join(folder, "latest.json"), JSON.stringify(value));
  await save(snapshot);
  const ready = await readLeagueRosters(session);
  assert.equal(ready.state, "ready");
  assert.deepEqual(ready.teams![0].players.map((player: any) => [player.id, player.group]), [["p1", "Starter"], ["p2", "Bench"]]);
  for (const change of [
    (value: typeof snapshot) => { value.rosters[0].starters = ["p1", "p1", "0"]; },
    (value: typeof snapshot) => { value.rosters[0].reserve = ["p2", "p2"]; },
    (value: typeof snapshot) => { value.rosters[0].taxi = ["p1"]; },
  ]) {
    const invalid = structuredClone(snapshot);
    change(invalid);
    await save(invalid);
    await assert.rejects(readLeagueRosters(session), /slots/);
    execFileSync("python3", ["-c", `
import importlib.util, json, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location("roster", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
payload = json.loads(Path(sys.argv[2]).read_text())
def fetch(endpoint):
    if endpoint.endswith("/rosters"): return payload["rosters"]
    if endpoint.endswith("/users"): return payload["users"]
    if endpoint.startswith("/league/"): return payload["league"]
    raise AssertionError("Invalid roster reached later fetch")
module.fetch = fetch
sys.argv = ["roster.py"]
try:
    module.main()
except ValueError as error:
    assert "slots" in str(error), str(error)
else:
    raise AssertionError("Invalid roster accepted")
`, fileURLToPath(new URL("../workspace-templates/roster.py", import.meta.url)), path.join(folder, "latest.json")], {
      cwd: root, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    });
  }
});

test("rosters use the newest valid Sleeper scores and preserve zero, negatives, and missing scores", async () => {
  const session = await createSession("nfl");
  const root = workspacePath(session.id);
  const leagueId = "123456789012345678";
  const folder = path.join(root, "data/sleeper", leagueId);
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(root, "LEAGUE.md"), `League name / ID: ${leagueId}\nMy team: roster 1\n`);
  const snapshot = {
    league: { league_id: leagueId, sport: "nfl", season: "2026", total_rosters: 1, roster_positions: ["QB", "BN"] },
    rosters: [{ league_id: leagueId, roster_id: 1, players: ["p1", "p2"], starters: ["p1"] }], users: [],
    summary: { league_id: leagueId, fetched_at: "2026-09-14T01:00:00Z", week: 1 },
    nfl_state: { season: "2026", week: 1 },
    matchups: [{ roster_id: 1, points: 10, custom_points: 0, players: ["p1", "p2"], starters: ["p1"], starters_points: [-1], players_points: { p1: -1, p2: 7.5 } }],
  };
  await writeFile(path.join(folder, "latest.json"), JSON.stringify(snapshot));
  const fantasy = { league_id: leagueId, season: "2026", week: 1, refreshed_at: "2026-09-14T02:00:00Z",
    ranking: [{ roster_id: 1, points: 119.72, starters: [{ player_id: "p1", points: 0 }] }] };
  await writeFile(path.join(folder, "fantasy-latest.json"), JSON.stringify(fantasy));
  let result = await readLeagueRosters(session);
  assert.equal(result.fantasy?.week, 1);
  assert.equal(result.teams![0].points, 119.72);
  assert.deepEqual(result.teams![0].players.map((p: any) => p.points), [0, 7.5]);
  assert.equal(result.teams![0].players[1].pointsFetchedAt, snapshot.summary.fetched_at);
  let matchup = await readLeagueRosters(session, false, true);
  assert.equal(matchup.matchup?.myTeam?.points, result.teams![0].points);
  assert.equal(matchup.matchup?.myTeam?.starters[0].points, 0);
  assert.equal(matchup.matchup?.myTeam?.bench[0].points, 7.5);
  fantasy.week = 2;
  await writeFile(path.join(folder, "fantasy-latest.json"), JSON.stringify(fantasy));
  result = await readLeagueRosters(session);
  assert.deepEqual(result.teams![0].players.map((p: any) => p.points), [0, null], "Do not mix scores from different weeks");
  matchup = await readLeagueRosters(session, false, true);
  assert.equal(matchup.matchup?.week, 2);
  assert.equal(matchup.matchup?.myTeam?.points, result.teams![0].points);
  assert.equal(matchup.matchup?.myTeam?.bench.length, 0);
  fantasy.week = 1;
  await writeFile(path.join(folder, "fantasy-latest.json"), JSON.stringify(fantasy));
  snapshot.summary.fetched_at = "2026-09-14T03:00:00Z";
  await writeFile(path.join(folder, "latest.json"), JSON.stringify(snapshot));
  result = await readLeagueRosters(session);
  assert.equal(result.teams![0].points, 0, "Commissioner zero override is authoritative");
  matchup = await readLeagueRosters(session, false, true);
  assert.equal(matchup.matchup?.myTeam?.customPoints, 0);
  assert.equal(matchup.matchup?.myTeam?.reportedPoints, 10);
  assert.deepEqual(result.teams![0].players.map((p: any) => p.points), [-1, 7.5]);
  for (const change of [
    (v: typeof fantasy) => { v.league_id = "987654321098765432"; },
    (v: typeof fantasy) => { v.season = "2025"; },
    (v: typeof fantasy) => { v.ranking.push(v.ranking[0]); },
    (v: typeof fantasy) => { v.ranking[0].starters.push(v.ranking[0].starters[0]); },
    (v: typeof fantasy) => { v.ranking[0].points = "119.72" as any; },
  ]) {
    const invalid = structuredClone(fantasy); change(invalid);
    await writeFile(path.join(folder, "fantasy-latest.json"), JSON.stringify(invalid));
    result = await readLeagueRosters(session);
    assert.equal(result.teams![0].points, 0);
    assert(result.warnings!.some(warning => warning.includes("/fantasy-update")));
  }
  await rm(path.join(folder, "fantasy-latest.json"));
  delete (snapshot as any).matchups;
  await writeFile(path.join(folder, "latest.json"), JSON.stringify(snapshot));
  result = await readLeagueRosters(session);
  assert.equal(result.state, "ready");
  assert.equal(result.fantasy, null);
  assert.equal(result.teams![0].points, null);
});
