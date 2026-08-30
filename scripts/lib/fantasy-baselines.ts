import { legalLineups, type Slate } from "./fantasy-eval.js";

export const baselineNames = ["season_avg", "last_5", "blended", "minutes_adjusted"] as const;
export type BaselineName = typeof baselineNames[number];

function projected(player: Record<string, unknown>, baseline: BaselineName) {
  const season = Number(player.season_dk_avg || 0);
  const recent = Number(player.last_5_dk_avg || 0);
  if (baseline === "season_avg") return season;
  if (baseline === "last_5") return recent;
  if (baseline === "minutes_adjusted") {
    const minutes = Number(player.projected_minutes || 0);
    return (0.6 * season + 0.4 * recent) * Math.min(1.15, Math.max(0.7, minutes / 32));
  }
  return 0.65 * season + 0.35 * recent;
}

export function bestBaseline(slate: Slate, baseline: BaselineName) {
  const byId = new Map(slate.players.map((player) => [player.id, player]));
  return legalLineups(slate).map((lineup) => ({
    lineup,
    projection: lineup.reduce((sum, id) => sum + projected(byId.get(id) || {}, baseline), 0),
  })).sort((left, right) => right.projection - left.projection || left.lineup.join("|").localeCompare(right.lineup.join("|")))[0].lineup;
}
