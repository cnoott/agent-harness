import { readFile } from "node:fs/promises";
import { readLeagueRosters } from "./league-rosters.js";
import { execute } from "./sandbox.js";
import type { ChatSession } from "./types.js";

type Schedule = { season: { year: number; type: number; week: number } | null; games: Record<string, unknown>[] };

export async function readLeagueMatchup(session: ChatSession, schedule: Schedule) {
  const data = await readLeagueRosters(session, false, true);
  if (data.state !== "ready" || data.matchup?.state !== "ready") return data;
  const matchup = data.matchup;
  const currentWeek = Boolean(schedule.season && String(schedule.season.year) === matchup.season && schedule.season.week === matchup.week
    && schedule.season.type === (matchup.seasonType === "regular" ? 2 : matchup.seasonType === "post" ? 3 : -1));
  const teams = [matchup.myTeam, matchup.opponent].filter(team => team != null);
  const gameFor = (abbreviation: string) => {
    if (!currentWeek || abbreviation === "—") return null;
    const team = abbreviation === "WAS" ? "WSH" : abbreviation;
    const matches = schedule.games.filter(game => game.home_abbreviation === team || game.away_abbreviation === team);
    if (matches.length !== 1) return null;
    const game = matches[0];
    return { id: game.id, kickoff: game.starts_at, state: game.state, status: game.status, detail: game.status_detail,
      quarter: game.quarter, clock: game.clock, fetchedAt: game.scoreboard_fetched_at,
      stale: !game.scoreboard_fetched_at || Date.now() - Date.parse(String(game.scoreboard_fetched_at)) > 180_000,
      opponent: game.home_abbreviation === team ? `vs ${game.away_abbreviation}` : `at ${game.home_abbreviation}` };
  };
  const enrich = (team: NonNullable<typeof matchup.myTeam>) => ({ ...team,
    starters: team.starters.map((player: any) => ({ ...player, game: gameFor(player.nflTeam) })),
    bench: team.bench.map((player: any) => ({ ...player, game: gameFor(player.nflTeam) })) });
  return { ...data, teams: undefined, matchup: { ...matchup, currentWeek, myTeam: enrich(teams[0]!), opponent: matchup.opponent ? enrich(matchup.opponent) : null } };
}

export async function refreshLeagueSnapshot(session: ChatSession, signal: AbortSignal) {
  if (session.workspaceId !== "nfl") throw new Error("Matchup refresh requires an NFL chat");
  const script = await readFile(new URL("../workspace-templates/roster.py", import.meta.url), "utf8");
  const result = await execute(session.id, `python -c '${script.replaceAll("'", "'\\''")}'`, { signal });
  if (result.exitCode !== 0) {
    let message = "Could not refresh league data. The previous snapshot is still available.";
    try { message = JSON.parse(result.stderr.trim()).error || message; } catch { /* Non-JSON process failures use the fallback. */ }
    throw new Error(message);
  }
}
