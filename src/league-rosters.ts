import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { workspacePath } from "./store.js";
import type { ChatSession } from "./types.js";
import { parseFantasyScores } from "./league-fantasy.js";
import { readPlayerCatalog } from "./player-catalog.js";

export async function readLeagueRosters(session: ChatSession, includeWaivers = false, includeMatchup = false) {
  if (session.workspaceId !== "nfl") throw new Error("League rosters require an NFL chat");
  const root = await realpath(workspacePath(session.id));
  const read = async (relative: string, limit: number) => {
    const target = await realpath(path.join(root, relative));
    if (!target.startsWith(`${root}${path.sep}`)) throw new Error("Roster data must remain inside the workspace");
    const info = await stat(target);
    if (!info.isFile() || info.size > limit) throw new Error("Roster data file is invalid or too large");
    return readFile(target, "utf8");
  };
  const context = await read("LEAGUE.md", 128_000).catch(error => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const leagueId = context.match(/League name \/ ID:.*?\b(\d{10,30})\b/)?.[1];
  const myRosterId = Number(context.match(/My team:.*?\broster\s+(\d+)\b/i)?.[1]);
  if (!leagueId || !Number.isSafeInteger(myRosterId) || myRosterId < 1) return { state: "unconfigured", message: "Save your Sleeper league ID and roster ID in League settings first." };
  const relative = `data/sleeper/${leagueId}/latest.json`;
  let snapshot;
  try { snapshot = JSON.parse(await read(relative, 8_000_000)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "empty", message: "No saved league rosters yet. Ask the agent to refresh with /roster." };
    throw error;
  }
  const { league, rosters, users, summary } = snapshot;
  if (league?.league_id !== leagueId || league?.sport !== "nfl" || summary?.league_id !== leagueId
    || !Array.isArray(rosters) || !rosters.length || rosters.length !== league.total_rosters
    || !Array.isArray(users) || !Number.isFinite(Date.parse(summary?.fetched_at))) throw new Error("Saved league snapshot is incomplete. Refresh with /roster.");
  let catalog: Record<string, any> = {};
  let playersFetchedAt: string | null = null;
  const warnings: string[] = [];
  try {
    const cache = await readPlayerCatalog(root);
    if (!cache.players || Array.isArray(cache.players) || typeof cache.players !== "object") throw new Error("Invalid player catalog");
    catalog = cache.players;
    playersFetchedAt = typeof cache.fetched_at === "string" ? cache.fetched_at : null;
  } catch { warnings.push("Player names could not be loaded; unknown players are shown by ID. Refresh with /roster."); }
  const owners = new Map(users.filter(user => user && typeof user.user_id === "string").map(user => [user.user_id, user]));
  const ids = new Set<number>();
  const owned = new Set<string>();
  const text = (value: unknown, fallback: string) => typeof value === "string" && value.trim() ? value.slice(0, 160) : fallback;
  const teams = rosters.map(roster => {
    if (!roster || roster.league_id !== leagueId || !Number.isSafeInteger(roster.roster_id) || ids.has(roster.roster_id)
      || !Array.isArray(roster.players) || !Array.isArray(roster.starters)) throw new Error("Saved rosters contain missing or duplicate identities. Refresh with /roster.");
    ids.add(roster.roster_id);
    const assignments = [roster.starters, roster.reserve ?? [], roster.taxi ?? []];
    if (assignments.some(value => !Array.isArray(value))) throw new Error("Saved roster slots are invalid. Refresh with /roster.");
    const assigned = assignments.flat().filter(id => id !== "0");
    if (new Set(assigned).size !== assigned.length) throw new Error("Saved roster slots contain duplicate or overlapping players. Refresh with /roster.");
    const starters = new Set(roster.starters);
    const reserve = new Set(roster.reserve ?? []);
    const taxi = new Set(roster.taxi ?? []);
    const players = roster.players.map((id: unknown) => {
      if (typeof id !== "string" || !id || owned.has(id)) throw new Error("Saved roster player ownership is incomplete or duplicated. Refresh with /roster.");
      owned.add(id);
      const info = catalog[id];
      const fallback = [info?.first_name, info?.last_name].filter(value => typeof value === "string").join(" ");
      const slot = starters.has(id) ? text(league.roster_positions?.[roster.starters.indexOf(id)], "") : "";
      return { id, name: text(info?.full_name, fallback || `Unknown player (${id})`), position: text(info?.position, "?"), slot,
        nflTeam: text(info?.team, "—"), group: starters.has(id) ? "Starter" : reserve.has(id) ? "Reserve" : taxi.has(id) ? "Taxi" : "Bench" };
    });
    const playerIds = new Set(players.map((player: { id: string }) => player.id));
    for (const id of [...starters, ...reserve, ...taxi]) if (id !== "0" && !playerIds.has(id as string)) throw new Error("Saved roster slots do not match its players. Refresh with /roster.");
    players.sort((a: { id: string; group: string; name: string }, b: { id: string; group: string; name: string }) => {
      const groups = ["Starter", "Bench", "Reserve", "Taxi"];
      return groups.indexOf(a.group) - groups.indexOf(b.group) || (a.group === "Starter" ? roster.starters.indexOf(a.id) - roster.starters.indexOf(b.id) : a.name.localeCompare(b.name));
    });
    const owner: any = owners.get(roster.owner_id);
    return { id: roster.roster_id, name: text(owner?.metadata?.team_name, text(owner?.display_name, `Team ${roster.roster_id}`)),
      owner: text(owner?.display_name, "Unassigned owner"), players,
      wins: Number.isFinite(roster.settings?.wins) ? roster.settings.wins : null,
      losses: Number.isFinite(roster.settings?.losses) ? roster.settings.losses : null };
  });
  if (!ids.has(myRosterId)) throw new Error("Your saved roster ID is not in this league. Check League settings.");
  if (includeWaivers && !Object.keys(catalog).length) throw new Error("The player catalog is unavailable. Refresh with /roster before viewing waivers.");
  const slots: Record<string, string[]> = { FLEX: ["RB", "WR", "TE"], SUPER_FLEX: ["QB", "RB", "WR", "TE"], REC_FLEX: ["WR", "TE"], WRRB_FLEX: ["WR", "RB"], IDP_FLEX: ["DL", "LB", "DB"], BN: [], IR: [] };
  const eligiblePositions = new Set<string>((Array.isArray(league.roster_positions) ? league.roster_positions : []).flatMap((slot: string) => slots[slot] ?? [slot]));
  const availablePlayers = includeWaivers ? Object.entries(catalog).filter(([id, player]) => player && typeof player === "object" && !owned.has(id)
    && player.active === true && (Array.isArray(player.fantasy_positions) ? player.fantasy_positions : [player.position]).some((position: string) => eligiblePositions.has(position)))
    .map(([id, player]) => ({ id, name: text(player.full_name, [player.first_name, player.last_name].filter(value => typeof value === "string").join(" ") || `Unknown player (${id})`),
      position: text(player.position, "?"), positions: (Array.isArray(player.fantasy_positions) ? player.fantasy_positions : [player.position]).filter((value: unknown) => typeof value === "string" && eligiblePositions.has(value)),
      nflTeam: text(player.team, "—"), injuryStatus: text(player.injury_status, "Not reported"),
      searchOrder: Number.isFinite(player.search_rank) ? player.search_rank : null })) : undefined;
  const snapshotPath = typeof summary.snapshot === "string" && new RegExp(`^data/sleeper/${leagueId}/[0-9TZ.]+\\.json$`).test(summary.snapshot) ? summary.snapshot : relative;
  const scoreSnapshots: ReturnType<typeof parseFantasyScores>[] = [];
  const starterCount = Array.isArray(league.roster_positions) ? league.roster_positions.filter((slot: string) => !["BN", "IR"].includes(slot)).length : undefined;
  if (!includeWaivers) {
    const fantasyPath = `data/sleeper/${leagueId}/fantasy-latest.json`;
    try {
      scoreSnapshots.push(parseFantasyScores(JSON.parse(await read(fantasyPath, 8_000_000)), leagueId, league.season, ids, fantasyPath, starterCount));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") warnings.push("Saved /fantasy-update scores could not be loaded. Run /fantasy-update to refresh them.");
    }
    if (Array.isArray(snapshot.matchups) && summary.week != null) {
      try {
        if (summary.season != null && String(summary.season) !== String(league.season)) throw new Error("Matchup season mismatch");
        const ranking = snapshot.matchups.map((entry: any) => {
          if (!Array.isArray(entry?.players) || !Array.isArray(entry?.starters) || (entry.starters_points != null
            && (!Array.isArray(entry.starters_points) || entry.starters_points.length !== entry.starters.length))) throw new Error("Matchup starter scores mismatch");
          return { ...entry, player_ids: entry.players, starters: entry.starters.map((id: string, index: number) => ({ player_id: id, points: entry.starters_points?.[index] })) };
        });
        scoreSnapshots.push(parseFantasyScores({ league_id: leagueId, season: league.season, season_type: league.season_type ?? snapshot.nfl_state?.season_type, week: summary.week,
          refreshed_at: summary.fetched_at, ranking }, leagueId, league.season, ids, snapshotPath, starterCount));
      } catch { warnings.push("Saved roster matchup scores could not be loaded. Refresh with /roster."); }
    }
  }
  const fantasy = scoreSnapshots.sort((a, b) => Date.parse(b.fetchedAt) - Date.parse(a.fetchedAt))[0] ?? null;
  const weeklyTeams = new Map((fantasy?.teams ?? []).map(team => {
    const sources = scoreSnapshots.filter(source => source.week === fantasy!.week && source.season === fantasy!.season)
      .map(source => ({ source, team: source.teams.find(row => row.id === team.id)! }));
    const playerScores = new Map<string, { points: number; fetchedAt: string }>();
    for (const saved of sources) for (const [id, points] of Object.entries(saved.team.players)) {
      if (points != null && !playerScores.has(id)) playerScores.set(id, { points, fetchedAt: saved.source.fetchedAt });
    }
    return [team.id, { ...team, playerScores, playerIds: team.playerIds ?? sources.find(saved => saved.team.playerIds)?.team.playerIds ?? Object.keys(team.players) }];
  }));
  let matchup;
  if (includeMatchup) {
    if (!fantasy) {
      matchup = { state: "unavailable", message: "No weekly matchup is saved for this league. Refresh data to check the current week." };
    } else {
      const weeklyTeam = (id: number) => {
        const scores = weeklyTeams.get(id)!;
        const team = teams.find(team => team.id === id)!;
        const roster = rosters.find(roster => roster.roster_id === id);
        const player = (id: string, index: number) => {
          const info = catalog[id];
          const saved = scores.playerScores.get(id);
          return { id, name: id === "0" ? "Empty slot" : text(info?.full_name, [info?.first_name, info?.last_name].filter(value => typeof value === "string").join(" ") || `Unknown player (${id})`),
            position: text(info?.position, "?"), slot: index < 0 ? roster?.reserve?.includes(id) ? "Reserve" : roster?.taxi?.includes(id) ? "Taxi" : "Bench" : text(league.roster_positions?.[index], "?"), nflTeam: text(info?.team, "—"),
            injuryStatus: info ? text(info.injury_status, "None listed") : "Unknown",
            points: id === "0" ? null : saved?.points ?? null, pointsFetchedAt: saved?.fetchedAt ?? null };
        };
        return { id: team.id, name: team.name, owner: team.owner, points: scores.points,
          reportedPoints: scores.reportedPoints, customPoints: scores.customPoints,
          starters: scores.starterIds.map(player), bench: scores.playerIds.filter(id => id !== "0" && !scores.starterIds.includes(id)).map(id => player(id, -1)) };
      };
      const ownEntry = weeklyTeams.get(myRosterId)!;
      const opponents = ownEntry.matchupId == null ? [] : [...weeklyTeams.values()].filter(team => team.id !== myRosterId && team.matchupId === ownEntry.matchupId);
      matchup = { state: "ready", week: fantasy.week, season: fantasy.season, seasonType: fantasy.seasonType,
        matchupId: ownEntry.matchupId, myTeam: weeklyTeam(myRosterId), opponent: opponents.length === 1 ? weeklyTeam(opponents[0].id) : null,
        message: opponents.length === 1 ? null : ownEntry.matchupId == null ? "No head-to-head matchup assigned (possibly a bye)." : "A single opponent could not be resolved from the saved matchup.",
        scoringSettings: league.scoring_settings ?? null };
    }
  }
  return { state: "ready", leagueId, leagueName: text(league.name, "Sleeper league"), season: league.season,
    myRosterId, fetchedAt: summary.fetched_at, playersFetchedAt, snapshotPath, warnings, availablePlayers, matchup,
    fantasy: fantasy ? { week: fantasy.week, season: fantasy.season, fetchedAt: fantasy.fetchedAt, snapshotPath: fantasy.snapshotPath } : null,
    teams: teams.sort((a, b) => a.id === myRosterId ? -1 : b.id === myRosterId ? 1 : a.name.localeCompare(b.name)).map(team => {
      const scores = weeklyTeams.get(team.id);
      return { ...team, points: scores?.points ?? null, players: team.players.map((player: any) => {
        const saved = scores?.playerScores.get(player.id);
        return { ...player, points: saved?.points ?? null, pointsFetchedAt: saved?.fetchedAt ?? null };
      }) };
    }) };
}
