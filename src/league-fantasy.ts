type WeeklyTeam = { id: number; points: number | null; reportedPoints: number | null; customPoints: number | null;
  matchupId: number | null; starterIds: string[]; playerIds: string[] | null; players: Record<string, number | null> };

export function parseFantasyScores(report: any, leagueId: string, season: unknown, rosterIds: Set<number>, snapshotPath: string, starterCount?: number) {
  if (report?.league_id !== leagueId || String(report.season) !== String(season)
    || !Number.isInteger(report.week) || report.week < 1 || report.week > 22
    || typeof report.refreshed_at !== "string" || !Number.isFinite(Date.parse(report.refreshed_at)) || !Array.isArray(report.ranking)
    || report.ranking.length !== rosterIds.size) throw new Error("Saved fantasy scores are incomplete or belong to another league or season.");
  const seen = new Set<number>();
  const score = (value: unknown): number | null => {
    if (value == null) return null;
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Saved fantasy points are invalid.");
    return value;
  };
  const teams: WeeklyTeam[] = report.ranking.map((row: any) => {
    if (!row || !rosterIds.has(row.roster_id) || seen.has(row.roster_id) || !Array.isArray(row.starters)
      || (starterCount != null && row.starters.length !== starterCount)
      || (row.matchup_id != null && !Number.isSafeInteger(row.matchup_id))) {
      throw new Error("Saved fantasy teams are missing or duplicated.");
    }
    seen.add(row.roster_id);
    const playerIds: string[] | null = row.player_ids ?? null;
    if (playerIds !== null && (!Array.isArray(playerIds) || playerIds.some(id => typeof id !== "string" || !id)
      || new Set(playerIds).size !== playerIds.length)) throw new Error("Saved fantasy player identities are invalid.");
    const players: Record<string, number | null> = Object.create(null);
    if (row.players_points != null) {
      if (typeof row.players_points !== "object" || Array.isArray(row.players_points)) throw new Error("Saved player points are invalid.");
      for (const [id, value] of Object.entries(row.players_points)) {
        if (!id || (playerIds && !playerIds.includes(id))) throw new Error("Saved player scores do not match player identities.");
        players[id] = score(value);
      }
    }
    const starters = new Set<string>();
    for (const player of row.starters) {
      if (!player || typeof player.player_id !== "string" || !player.player_id
        || (player.player_id !== "0" && starters.has(player.player_id))) throw new Error("Saved fantasy starters are invalid or duplicated.");
      if (player.player_id === "0") continue;
      if (playerIds && !playerIds.includes(player.player_id)) throw new Error("Saved starters do not match player identities.");
      starters.add(player.player_id);
      players[player.player_id] = score(player.points) ?? players[player.player_id] ?? null;
    }
    const customPoints = score(row.custom_points), reportedPoints = score(Object.hasOwn(row, "reported_points") ? row.reported_points : row.points);
    return { id: row.roster_id, points: customPoints ?? reportedPoints, reportedPoints, customPoints,
      matchupId: row.matchup_id ?? null, starterIds: row.starters.map((player: any) => player.player_id), playerIds, players };
  });
  return { week: report.week as number, season: String(report.season), seasonType: report.season_type ?? "regular", fetchedAt: report.refreshed_at as string, snapshotPath, teams };
}
