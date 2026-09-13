"""Read-only Sleeper refresh. Run from the sport workspace; see --help."""
import argparse
import datetime as dt
import json
import math
import os
from pathlib import Path
import re
import sys
import tempfile
import urllib.request

API = "https://api.sleeper.app/v1"


def fetch(endpoint):
    request = urllib.request.Request(API + endpoint, headers={"User-Agent": "SportsHarness/1.0"})
    with urllib.request.urlopen(request, timeout=20) as response:
        data = response.read(32_000_001)
        if len(data) > 32_000_000:
            raise ValueError("Sleeper response exceeds 32 MB")
        return json.loads(data)


def save_json(target, data):
    target.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(prefix=".refresh-", dir=target.parent)
    try:
        with os.fdopen(handle, "w") as output:
            json.dump(data, output, ensure_ascii=False)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main():
    parser = argparse.ArgumentParser(description="Refresh Sleeper NFL league and rosters. Reads LEAGUE.md; saves data/sleeper/<league-id>/<timestamp>.json and latest.json. No login or model calls.")
    parser.add_argument("--league-id", help="Confirmed Sleeper league ID, otherwise read LEAGUE.md")
    parser.add_argument("--roster-id", type=int, help="Confirmed roster ID, otherwise read LEAGUE.md")
    args = parser.parse_args()
    context = Path("LEAGUE.md").read_text() if Path("LEAGUE.md").exists() else ""
    league_match = re.search(r"League name / ID:.*?\b(\d{10,})\b", context)
    roster_match = re.search(r"My team:.*?\broster\s+(\d+)\b", context, re.I)
    league_id = args.league_id or (league_match[1] if league_match else None)
    roster_id = args.roster_id if args.roster_id is not None else int(roster_match[1]) if roster_match else None
    if not league_id or not re.fullmatch(r"\d{10,30}", league_id) or roster_id is None or roster_id < 1:
        raise ValueError("Save a confirmed Sleeper league ID and roster ID in LEAGUE.md, or pass --league-id and --roster-id")
    league = fetch(f"/league/{league_id}")
    if not isinstance(league, dict) or league.get("league_id") != league_id or league.get("sport") != "nfl":
        raise ValueError("Sleeper did not return the requested NFL league")
    if not isinstance(league.get("scoring_settings"), dict) or not isinstance(league.get("roster_positions"), list):
        raise ValueError("League settings or lineup slots are missing")
    rosters = fetch(f"/league/{league_id}/rosters")
    users = fetch(f"/league/{league_id}/users")
    if not isinstance(rosters, list) or not rosters or len(rosters) != league.get("total_rosters"):
        raise ValueError("Roster count does not reconcile with the league's total_rosters")
    ids, owned = set(), set()
    for roster in rosters:
        if not isinstance(roster, dict) or roster.get("league_id") != league_id:
            raise ValueError("Roster identity mismatch")
        rid = roster.get("roster_id")
        if not isinstance(rid, int) or rid < 1 or rid in ids:
            raise ValueError("Invalid or duplicate roster ID")
        ids.add(rid)
        players = roster.get("players")
        if not isinstance(players, list) or any(not isinstance(p, str) or not p for p in players) or len(players) != len(set(players)):
            raise ValueError("Missing or duplicate roster players")
        if owned.intersection(players):
            raise ValueError("A player appears on more than one roster")
        owned.update(players)
        for field in ["starters", "reserve", "taxi"]:
            values = roster.get(field) or []
            if not isinstance(values, list) or any(p != "0" and p not in players for p in values):
                raise ValueError(f"Invalid {field} players for roster {rid}")
        if not isinstance(roster.get("starters"), list):
            raise ValueError("Starter slots are missing")
    mine = next((r for r in rosters if r["roster_id"] == roster_id), None)
    if mine is None:
        raise ValueError("The selected roster does not exist in this league")
    if not isinstance(users, list) or any(not isinstance(u, dict) or not u.get("user_id") for u in users):
        raise ValueError("League users are unavailable")
    owners = {u["user_id"]: u for u in users}
    if len(owners) != len(users) or any(r.get("owner_id") and r["owner_id"] not in owners for r in rosters):
        raise ValueError("Roster owners do not reconcile with league users")
    state = fetch("/state/nfl")
    if not isinstance(state, dict):
        raise ValueError("NFL state is unavailable")
    week = state.get("week") if str(state.get("season")) == str(league.get("season")) and state.get("season_type") in ["regular", "post"] else None
    matchups = None
    if isinstance(week, int) and 1 <= week <= 22:
        matchups = fetch(f"/league/{league_id}/matchups/{week}")
        if not isinstance(matchups, list) or len(matchups) != len(rosters) or {m.get("roster_id") for m in matchups if isinstance(m, dict)} != ids:
            raise ValueError("Current matchup rosters do not reconcile with the league")
        for matchup in matchups:
            players, starters = matchup.get("players"), matchup.get("starters")
            if not isinstance(players, list) or any(not isinstance(p, str) or not p for p in players) or len(players) != len(set(players)):
                raise ValueError("Matchup players are missing or duplicated")
            if not isinstance(starters, list) or any(p != "0" and p not in players for p in starters) or len([p for p in starters if p != "0"]) != len(set(starters) - {"0"}):
                raise ValueError("Matchup starter identities are invalid")
            if len(starters) != len([slot for slot in league["roster_positions"] if slot not in ["BN", "IR"]]):
                raise ValueError("Matchup starter slots do not match the league lineup")
            if matchup.get("matchup_id") is not None and type(matchup["matchup_id"]) is not int:
                raise ValueError("Invalid matchup identity")
            values = [matchup.get("points"), matchup.get("custom_points")]
            if matchup.get("starters_points") is not None:
                if not isinstance(matchup["starters_points"], list) or len(matchup["starters_points"]) != len(starters):
                    raise ValueError("Starter scores do not match starter slots")
                values.extend(matchup["starters_points"])
            if matchup.get("players_points") is not None:
                if not isinstance(matchup["players_points"], dict):
                    raise ValueError("Player scores are invalid")
                values.extend(matchup["players_points"].values())
            if any(value is not None and (type(value) not in [int, float] or not math.isfinite(value)) for value in values):
                raise ValueError("Matchup scores are invalid")
    now = dt.datetime.now(dt.timezone.utc)
    cache = Path("data/sleeper/players-cache.json")
    cached = None
    if cache.exists():
        try:
            candidate = json.loads(cache.read_text())
            age = (now - dt.datetime.fromisoformat(candidate["fetched_at"])).total_seconds()
            if 0 <= age < 86400 and isinstance(candidate.get("players"), dict):
                cached = candidate
        except (ValueError, KeyError, TypeError):
            pass
    if cached is None:
        catalog = fetch("/players/nfl")
        if not isinstance(catalog, dict) or not catalog or any(not isinstance(p, dict) for p in catalog.values()):
            raise ValueError("NFL player catalog is unavailable")
        cached = {"fetched_at": now.isoformat(), "players": catalog}
        save_json(cache, cached)
    catalog = cached["players"]
    warnings = []

    def player(pid):
        if pid == "0":
            return {"player_id": pid, "name": "Empty slot"}
        p = catalog.get(pid, {})
        name = p.get("full_name") or " ".join(filter(None, [p.get("first_name"), p.get("last_name")]))
        if not name:
            warnings.append(f"Unknown player name: {pid}")
        return {"player_id": pid, "name": name or "Unknown", "position": p.get("position"), "team": p.get("team")}

    excluded = set(mine["starters"] + (mine.get("reserve") or []) + (mine.get("taxi") or []))
    owner = owners.get(mine.get("owner_id"), {})
    summary = {
        "league_id": league_id, "league_name": league.get("name"), "season": league.get("season"),
        "roster_id": roster_id, "team_name": (owner.get("metadata") or {}).get("team_name") or owner.get("display_name"),
        "fetched_at": dt.datetime.now(dt.timezone.utc).isoformat(), "players_fetched_at": cached["fetched_at"],
        "lineup_slots": league["roster_positions"], "rosters_validated": len(rosters), "week": week,
        "starters": [player(p) for p in mine["starters"]],
        "bench": [player(p) for p in mine["players"] if p not in excluded],
        "reserve": [player(p) for p in mine.get("reserve") or []], "taxi": [player(p) for p in mine.get("taxi") or []],
        "warnings": warnings,
    }
    directory = Path("data/sleeper") / league_id
    snapshot = directory / (now.strftime("%Y%m%dT%H%M%S.%fZ") + ".json")
    summary["snapshot"] = str(snapshot)
    payload = {"summary": summary, "source": API, "league": league, "rosters": rosters, "users": users, "matchups": matchups, "nfl_state": state}
    save_json(snapshot, payload)
    save_json(directory / "latest.json", payload)
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"error": str(error), "refreshed": False}), file=sys.stderr)
        sys.exit(1)
