import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { workspacePath } from "./store.js";
import type { ChatSession } from "./types.js";

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
    const cache = JSON.parse(await read("data/sleeper/players-cache.json", 40_000_000));
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
  let matchup;
  if (includeMatchup) {
    const entries = snapshot.matchups;
    const week = summary.week;
    if (!Number.isInteger(week) || week < 1 || week > 22 || !Array.isArray(entries)) {
      matchup = { state: "unavailable", message: "No weekly matchup is saved for this league. Refresh data to check the current week." };
    } else {
      if (!Array.isArray(league.roster_positions) || String(snapshot.nfl_state?.season) !== String(league.season) || snapshot.nfl_state?.week !== week) {
        throw new Error("Saved matchup week or lineup settings are inconsistent. Refresh data.");
      }
      if (entries.length !== teams.length || new Set(entries.map(entry => entry?.roster_id)).size !== teams.length
        || entries.some(entry => !ids.has(entry?.roster_id))) throw new Error("Saved matchup teams are incomplete or duplicated. Refresh data.");
      const weeklyTeam = (entry: any) => {
        const roster = rosters.find(roster => roster.roster_id === entry.roster_id);
        if (!Array.isArray(entry.players) || entry.players.some((id: unknown) => typeof id !== "string" || !id)
          || new Set(entry.players).size !== entry.players.length || !Array.isArray(entry.starters)
          || entry.starters.some((id: unknown) => id !== "0" && !entry.players.includes(id))
          || new Set(entry.starters.filter((id: string) => id !== "0")).size !== entry.starters.filter((id: string) => id !== "0").length) {
          throw new Error("Saved matchup lineups are incomplete or duplicated. Refresh data.");
        }
        if (entry.starters.length !== league.roster_positions.filter((slot: string) => !["BN", "IR"].includes(slot)).length
          || (entry.starters_points != null && (!Array.isArray(entry.starters_points) || entry.starters_points.length !== entry.starters.length))
          || (entry.matchup_id != null && !Number.isSafeInteger(entry.matchup_id))) throw new Error("Saved matchup slots or identity are invalid. Refresh data.");
        const score = (value: unknown): number | null => {
          if (value == null) return null;
          if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Saved matchup scores are invalid. Refresh data.");
          return value;
        };
        const player = (id: string, index: number) => {
          const info = catalog[id];
          return { id, name: id === "0" ? "Empty slot" : text(info?.full_name, [info?.first_name, info?.last_name].filter(value => typeof value === "string").join(" ") || `Unknown player (${id})`),
            position: text(info?.position, "?"), slot: index < 0 ? roster?.reserve?.includes(id) ? "Reserve" : roster?.taxi?.includes(id) ? "Taxi" : "Bench" : text(league.roster_positions?.[index], "?"), nflTeam: text(info?.team, "—"),
            injuryStatus: info ? text(info.injury_status, "None listed") : "Unknown",
            points: id === "0" ? null : (index < 0 ? null : score(entry.starters_points?.[index])) ?? score(entry.players_points?.[id]) };
        };
        const team = teams.find(team => team.id === entry.roster_id)!;
        return { id: team.id, name: team.name, owner: team.owner, points: score(entry.custom_points) ?? score(entry.points),
          reportedPoints: score(entry.points), customPoints: score(entry.custom_points),
          starters: entry.starters.map(player), bench: entry.players.filter((id: string) => !entry.starters.includes(id)).map((id: string) => player(id, -1)) };
      };
      const ownEntry = entries.find(entry => entry.roster_id === myRosterId)!;
      const opponents = ownEntry.matchup_id == null ? [] : entries.filter(entry => entry.roster_id !== myRosterId && entry.matchup_id === ownEntry.matchup_id);
      matchup = { state: "ready", week, season: String(league.season), seasonType: snapshot.nfl_state?.season_type,
        matchupId: ownEntry.matchup_id ?? null, myTeam: weeklyTeam(ownEntry), opponent: opponents.length === 1 ? weeklyTeam(opponents[0]) : null,
        message: opponents.length === 1 ? null : ownEntry.matchup_id == null ? "No head-to-head matchup assigned (possibly a bye)." : "A single opponent could not be resolved from the saved matchup.",
        scoringSettings: league.scoring_settings ?? null };
    }
  }
  return { state: "ready", leagueId, leagueName: text(league.name, "Sleeper league"), season: league.season,
    myRosterId, fetchedAt: summary.fetched_at, playersFetchedAt, snapshotPath, warnings, availablePlayers, matchup,
    teams: teams.sort((a, b) => a.id === myRosterId ? -1 : b.id === myRosterId ? 1 : a.name.localeCompare(b.name)) };
}
