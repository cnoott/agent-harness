"""Refresh validated Sleeper scores using the bundled roster collector."""
import contextlib
import io
import json
from pathlib import Path
import sys

import roster


def main():
    with contextlib.redirect_stdout(io.StringIO()):
        snapshot = roster.main()
    summary, league = snapshot["summary"], snapshot["league"]
    week = summary["week"]
    if week is None or snapshot["matchups"] is None:
        raise ValueError("No current matchup week is available; pass --week 1 through 22")
    users = {user["user_id"]: user for user in snapshot["users"]}
    teams = {}
    for team in snapshot["rosters"]:
        owner = users.get(team.get("owner_id"), {})
        teams[team["roster_id"]] = (owner.get("metadata") or {}).get("team_name") or owner.get("display_name") or f"Roster {team['roster_id']}"
    catalog = json.loads(Path("data/sleeper/players-cache.json").read_text())["players"]
    rows = []
    for entry in snapshot["matchups"]:
        scores = entry.get("starters_points")
        player_scores = entry.get("players_points") or {}
        starters = []
        for index, pid in enumerate(entry["starters"]):
            points = scores[index] if scores is not None else None
            if points is None:
                points = player_scores.get(pid)
            starters.append({"player_id": pid, "player": "Empty slot" if pid == "0" else catalog.get(pid, {}).get("full_name") or pid,
                             "points": None if pid == "0" else points})
        custom = entry.get("custom_points")
        rows.append({"matchup_id": entry.get("matchup_id"), "roster_id": entry["roster_id"], "team": teams[entry["roster_id"]],
                     "points": custom if custom is not None else entry.get("points"), "reported_points": entry.get("points"), "custom_points": custom,
                     "starters": starters, "player_ids": entry["players"], "players_points": player_scores,
                     "is_my_team": entry["roster_id"] == summary["roster_id"]})
    ranking = sorted(rows, key=lambda row: (row["points"] is not None, row["points"] or 0), reverse=True)
    state = snapshot["nfl_state"]
    complete = str(state.get("season")) == str(league["season"]) and type(state.get("week")) is int and state["week"] > week
    matchups = []
    for mid in sorted({row["matchup_id"] for row in rows if row["matchup_id"] is not None}):
        sides = [row for row in ranking if row["matchup_id"] == mid]
        scored = len(sides) == 2 and all(row["points"] is not None for row in sides)
        tied = scored and sides[0]["points"] == sides[1]["points"]
        leader = sides[0] if scored and not tied else None
        matchups.append({"matchup_id": mid, "status": "final" if complete and scored else "in_progress" if scored else "unknown", "tied": tied,
                         "leader": leader["team"] if leader else None, "winner": leader["team"] if complete and leader else None,
                         "winner_points": leader["points"] if complete and leader else None, "sides": sides})
    standout = [{"player": player["player"], "team": row["team"], "points": player["points"]}
                for row in rows for player in row["starters"] if player["player_id"] != "0" and player["points"] is not None]
    standout.sort(key=lambda player: player["points"], reverse=True)
    mine = next(row for row in rows if row["is_my_team"])
    report = {"refreshed_at": summary["fetched_at"], "league_id": league["league_id"], "league_name": league.get("name"),
              "season": league["season"], "season_type": league.get("season_type", "regular"), "week": week,
              "my_team": mine["team"], "my_score": mine["points"], "ranking": ranking, "matchups": matchups,
              "standout_players": standout[:10], "source": "Sleeper API"}
    directory = Path("data/sleeper") / league["league_id"]
    stamped = Path(summary["snapshot"]).stem
    roster.save_json(directory / f"fantasy-{stamped}.json", report)
    roster.save_json(directory / "fantasy-latest.json", report)
    print(json.dumps(report, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"error": str(error), "refreshed": False}), file=sys.stderr)
        sys.exit(1)
