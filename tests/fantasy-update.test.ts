import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("fantasy refresh preserves overrides and ties, and rejects incomplete responses before publication", () => {
  execFileSync("python3", ["-c", `
import contextlib, copy, io, json, os, sys, tempfile
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import fantasy_update
lid = "123456789012345678"
league = {"league_id": lid, "sport": "nfl", "season": "2026", "season_type": "regular", "total_rosters": 2, "scoring_settings": {}, "roster_positions": ["QB", "FLEX"]}
rosters = [{"league_id": lid, "roster_id": rid, "players": players, "starters": players, "owner_id": str(rid)} for rid, players in [(1, ["p1", "p2"]), (2, ["p3", "p4"])]]
matches = [{"roster_id": r["roster_id"], "matchup_id": 1, "players": r["players"], "starters": r["players"], "starters_points": [10, 0], "points": 10, "custom_points": 0} for r in rosters]
state = {"season": "2026", "season_type": "regular", "week": 1}
def fetch(endpoint):
    if endpoint.endswith("/rosters"): return copy.deepcopy(rosters)
    if endpoint.endswith("/users"): return [{"user_id": str(rid), "display_name": f"Team {rid}"} for rid in [1, 2]]
    if "/matchups/" in endpoint: return copy.deepcopy(matches)
    if endpoint == "/players/nfl": return {pid: {"full_name": pid} for pid in ["p1", "p2", "p3", "p4"]}
    if endpoint == "/state/nfl": return copy.deepcopy(state)
    return copy.deepcopy(league)
fantasy_update.roster.fetch = fetch
def run():
    with contextlib.redirect_stdout(io.StringIO()): fantasy_update.main()
with tempfile.TemporaryDirectory() as directory:
    os.chdir(directory)
    Path("LEAGUE.md").write_text(f"League name / ID: {lid}\\nMy team: roster 1\\n")
    sys.argv = ["fantasy_update.py"]
    run()
    target = Path("data/sleeper") / lid / "fantasy-latest.json"
    report = json.loads(target.read_text())
    assert report["my_score"] == 0
    assert report["ranking"][0]["reported_points"] == 10
    assert report["ranking"][0]["custom_points"] == 0
    assert report["matchups"][0]["tied"] is True
    assert report["matchups"][0]["winner"] is None
    assert report["matchups"][0]["leader"] is None
    matches[1]["custom_points"] = None
    run()
    report = json.loads(target.read_text())
    assert report["matchups"][0]["leader"] == "Team 2"
    assert report["matchups"][0]["winner"] is None
    state["week"] = 2
    sys.argv = ["fantasy_update.py", "--week", "1"]
    run()
    assert json.loads(target.read_text())["matchups"][0]["winner"] == "Team 2"
    before = target.read_bytes()
    raw = target.with_name("latest.json").read_bytes()
    valid = copy.deepcopy(matches)
    for change in ["short_scores", "duplicate_starter", "nonfinite", "wrong_team", "unknown_player"]:
        matches[:] = copy.deepcopy(valid)
        if change == "short_scores": matches[0]["starters_points"] = [10]
        if change == "duplicate_starter": matches[0]["starters"] = ["p1", "p1"]
        if change == "nonfinite": matches[0]["custom_points"] = float("nan")
        if change == "wrong_team": matches[1]["roster_id"] = 1
        if change == "unknown_player": matches[0]["players_points"] = {"not-rostered": 2}
        try: run()
        except ValueError: pass
        else: raise AssertionError(f"Accepted {change}")
        assert target.read_bytes() == before
        assert target.with_name("latest.json").read_bytes() == raw
`, fileURLToPath(new URL("../workspace-templates", import.meta.url))], {
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }, timeout: 10_000,
  });
});
