import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

type CsvRow = Record<string, string>;
type Game = { date: string; fantasyPoints: number; minutes: number };

const sourceUrl = "https://raw.githubusercontent.com/NocturneBear/NBA-Data-2010-2024/main/regular_season_box_scores_2010_2024_part_3.csv";

function csvLine(line: string) {
  const fields: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') { value += '"'; index += 1; }
      else quoted = !quoted;
    } else if (char === "," && !quoted) { fields.push(value); value = ""; }
    else value += char;
  }
  fields.push(value);
  return fields;
}

function number(row: CsvRow, key: string) {
  return Number(row[key] || 0);
}

function minutes(value: string) {
  const [whole = "0", seconds = "0"] = value.split(":");
  return Number(whole) + Number(seconds) / 60;
}

function fantasyPoints(row: CsvRow) {
  return number(row, "points") + 1.25 * number(row, "reboundsTotal") + 1.5 * number(row, "assists")
    + 2 * number(row, "steals") + 2 * number(row, "blocks") - 0.5 * number(row, "turnovers");
}

function average(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function rounded(value: number) {
  return Math.round(value * 100) / 100;
}

function opponent(row: CsvRow) {
  const parts = row.matchup.split(/ @ | vs\. /);
  return parts.find((team) => team !== row.teamTricode) || "unknown";
}

function rotatePick<T>(items: T[], count: number, seed: number) {
  if (items.length <= count) return items;
  const maxOffset = Math.min(items.length - count, 8);
  const offset = seed % (maxOffset + 1);
  return items.slice(offset, offset + count);
}

async function main() {
  const source = path.resolve(process.argv[2] || ".data/source/regular_season_box_scores_2010_2024_part_3.csv");
  const destination = path.resolve(process.argv[3] || "fixtures/fantasy-nba-replay");
  const raw = await readFile(source, "utf8");
  const [headerLine, ...lines] = raw.trim().split(/\r?\n/);
  const headers = csvLine(headerLine);
  const rows = lines.map((line) => {
    const values = csvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] || ""]));
  }).filter((row) => row.season_year === "2023-24") as CsvRow[];
  rows.sort((left, right) => left.game_date.localeCompare(right.game_date) || left.gameId.localeCompare(right.gameId));

  const byDate = new Map<string, CsvRow[]>();
  for (const row of rows) {
    const group = byDate.get(row.game_date) || [];
    group.push(row);
    byDate.set(row.game_date, group);
  }

  const history = new Map<string, Game[]>();
  const lastPosition = new Map<string, string>();
  const candidates: Array<{ id: string; slate: Record<string, unknown>; outcomes: Record<string, unknown> }> = [];
  for (const [date, dateRows] of byDate) {
    const prepared = dateRows.map((row) => {
      const prior = history.get(row.personId) || [];
      const position = lastPosition.get(row.personId);
      const lastFive = prior.slice(-5);
      const restDays = prior.length ? Math.max(0, Math.round((Date.parse(date) - Date.parse(prior.at(-1)!.date)) / 86_400_000) - 1) : null;
      return {
        row,
        visible: position && prior.length >= 8 ? {
          id: row.personId,
          name: row.personName,
          positions: [position],
          team: row.teamTricode,
          opponent: opponent(row),
          home: row.matchup.includes(" vs. "),
          season_dk_avg: rounded(average(prior.map((game) => game.fantasyPoints))),
          last_5_dk_avg: rounded(average(lastFive.map((game) => game.fantasyPoints))),
          projected_minutes: rounded(average(lastFive.map((game) => game.minutes))),
          prior_games: prior.length,
          rest_days: restDays,
        } : null,
      };
    });

    if (date >= "2023-12-01") {
      const byPosition = (position: string) => prepared.filter((item) => item.visible?.positions[0] === position)
        .sort((left, right) => Number(right.visible!.season_dk_avg) - Number(left.visible!.season_dk_avg));
      const seed = Number(date.replaceAll("-", ""));
      const selected = [
        ...rotatePick(byPosition("G"), 3, seed),
        ...rotatePick(byPosition("F"), 3, seed + 3),
        ...rotatePick(byPosition("C"), 2, seed + 7),
      ];
      if (selected.length === 8) {
        const id = `nba-${date}`;
        const players = selected.map((item) => item.visible);
        const actual = Object.fromEntries(selected.map((item) => [item.row.personId, rounded(fantasyPoints(item.row))]));
        candidates.push({
          id,
          slate: {
            id,
            sport: "NBA",
            format: "DraftKings-style points (simplified slots, no salary cap)",
            as_of: `${date}T12:00:00-05:00`,
            game_date: date,
            slots: ["G", "F", "UTIL"],
            scoring: { points: 1, rebounds: 1.25, assists: 1.5, steals: 2, blocks: 2, turnovers: -0.5 },
            players,
            provenance: {
              source_url: sourceUrl,
              visible_features: "Computed only from each player's games before game_date.",
              limitations: ["No historical injury reports", "No historical betting lines", "Simplified G/F/C eligibility", "No DraftKings salary cap or bonuses"],
            },
          },
          outcomes: { slate_id: id, game_date: date, actual_dk_points: actual },
        });
      }
    }

    for (const row of dateRows) {
      if (row.position) lastPosition.set(row.personId, row.position);
      const playedMinutes = minutes(row.minutes);
      if (playedMinutes > 0) {
        const playerHistory = history.get(row.personId) || [];
        playerHistory.push({ date, fantasyPoints: fantasyPoints(row), minutes: playedMinutes });
        history.set(row.personId, playerHistory);
      }
    }
  }

  const count = Math.min(20, candidates.length);
  const selected = Array.from({ length: count }, (_, index) => candidates[Math.round(index * (candidates.length - 1) / Math.max(1, count - 1))]);
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  const request = [
    "Choose the best legal NBA fantasy lineup from the supplied historical pregame snapshot.",
    "Use only visible data; do not browse for or infer the result of this historical game.",
    "Write /workspace/recommendation.json with a lineup array in slot order G, F, UTIL and optional player projections.",
    "Write /workspace/recommendation.md explaining the choice and uncertainty.",
    "Create /workspace/fantasy.sqlite with a recommendations table containing as_of and lineup columns, then insert the final choice using the slate's exact as_of value and JSON lineup.",
  ].join("\n");
  for (const fixture of selected) {
    const root = path.join(destination, fixture.id);
    await mkdir(path.join(root, "visible"), { recursive: true });
    await mkdir(path.join(root, "hidden"), { recursive: true });
    await writeFile(path.join(root, "visible/slate.json"), `${JSON.stringify(fixture.slate, null, 2)}\n`);
    await writeFile(path.join(root, "visible/request.md"), `${request}\n`);
    await writeFile(path.join(root, "hidden/actual-outcomes.json"), `${JSON.stringify(fixture.outcomes, null, 2)}\n`);
  }
  const manifest = {
    version: 1,
    generated_at: new Date().toISOString(),
    dataset_class: "historical box-score replay",
    source_url: sourceUrl,
    source_sha256: createHash("sha256").update(raw).digest("hex"),
    leakage_policy: "Visible rolling features use only games strictly before each target date. Same-day fantasy outcomes are stored only under hidden/.",
    limitations: ["Third-party MIT-licensed dataset derived from NBA data", "No historical injury reports or betting lines", "Roster candidates are selected deterministically from players listed for that day's games", "Simplified G/F/C eligibility and no salary cap"],
    slates: selected.map((fixture) => fixture.id),
  };
  await writeFile(path.join(destination, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote ${selected.length} historical replay fixtures to ${destination}`);
}

void main();
