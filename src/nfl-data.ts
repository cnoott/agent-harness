import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const nflDatabasePath = path.resolve(".data", "sports", "nfl.sqlite");
export const nflSummaryUrl = (gameId: string) => `https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=${gameId}`;

type RecordValue = Record<string, any>;
function record(value: unknown, label: string): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label}`);
  return value as RecordValue;
}
function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing ${label}`);
  return value;
}
function integer(value: unknown, label: string): number {
  if ((typeof value !== "number" && typeof value !== "string") || String(value).trim() === ""
    || !Number.isSafeInteger(Number(value)) || Number(value) < 0) throw new Error(`Invalid ${label}`);
  return Number(value);
}
const optionalNumber = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
const json = (value: unknown) => JSON.stringify(value ?? null);

const schema = `
CREATE TABLE source_snapshots (
  id INTEGER PRIMARY KEY, game_id TEXT NOT NULL, content_hash TEXT NOT NULL,
  source_url TEXT NOT NULL, first_fetched_at TEXT NOT NULL, last_fetched_at TEXT NOT NULL,
  raw_json TEXT NOT NULL CHECK(json_valid(raw_json)), UNIQUE(game_id, content_hash)
);
CREATE TABLE teams (id TEXT PRIMARY KEY, name TEXT NOT NULL, abbreviation TEXT NOT NULL);
CREATE TABLE games (
  id TEXT PRIMARY KEY, season INTEGER NOT NULL, season_type INTEGER NOT NULL, week INTEGER NOT NULL,
  starts_at TEXT NOT NULL, status TEXT NOT NULL, completed INTEGER NOT NULL,
  home_team_id TEXT NOT NULL REFERENCES teams(id), away_team_id TEXT NOT NULL REFERENCES teams(id),
  home_score INTEGER NOT NULL, away_score INTEGER NOT NULL,
  snapshot_id INTEGER NOT NULL REFERENCES source_snapshots(id), last_fetched_at TEXT NOT NULL,
  CHECK(home_team_id != away_team_id)
);
CREATE TABLE drives (
  game_id TEXT NOT NULL REFERENCES games(id), id TEXT NOT NULL, sequence INTEGER NOT NULL,
  team_id TEXT REFERENCES teams(id), result TEXT, raw_json TEXT NOT NULL,
  snapshot_id INTEGER NOT NULL REFERENCES source_snapshots(id), PRIMARY KEY(game_id, id)
);
CREATE TABLE plays (
  game_id TEXT NOT NULL, id TEXT NOT NULL, drive_id TEXT NOT NULL, sequence INTEGER NOT NULL,
  type_id TEXT NOT NULL, type_name TEXT NOT NULL, description TEXT NOT NULL,
  quarter INTEGER NOT NULL, clock TEXT NOT NULL, home_score INTEGER NOT NULL, away_score INTEGER NOT NULL,
  offense_team_id TEXT REFERENCES teams(id), defense_team_id TEXT REFERENCES teams(id),
  start_team_id TEXT REFERENCES teams(id), end_team_id TEXT REFERENCES teams(id),
  start_down REAL, start_distance REAL, start_yard_line REAL, start_yards_to_endzone REAL,
  end_down REAL, end_distance REAL, end_yard_line REAL, end_yards_to_endzone REAL,
  stat_yardage REAL, is_penalty INTEGER NOT NULL, is_turnover INTEGER NOT NULL, is_scoring INTEGER NOT NULL,
  is_no_play INTEGER NOT NULL, is_scramble INTEGER NOT NULL, is_kneel INTEGER NOT NULL,
  wall_clock TEXT, provider_modified_at TEXT, raw_json TEXT NOT NULL,
  snapshot_id INTEGER NOT NULL REFERENCES source_snapshots(id), PRIMARY KEY(game_id, id),
  FOREIGN KEY(game_id, drive_id) REFERENCES drives(game_id, id)
);
CREATE INDEX plays_game_sequence ON plays(game_id, sequence);
CREATE INDEX plays_offense ON plays(offense_team_id, game_id);
CREATE TABLE game_team_stats (
  game_id TEXT NOT NULL REFERENCES games(id), team_id TEXT NOT NULL REFERENCES teams(id),
  name TEXT NOT NULL, display_value TEXT NOT NULL, numeric_value REAL, numerator INTEGER, denominator INTEGER,
  raw_json TEXT NOT NULL, snapshot_id INTEGER NOT NULL REFERENCES source_snapshots(id),
  PRIMARY KEY(game_id, team_id, name)
);
CREATE VIEW team_game_overview AS
WITH totals AS (
  SELECT game_id, team_id,
    MAX(CASE WHEN name='rushingAttempts' THEN numeric_value END) AS rushing_attempts,
    MAX(CASE WHEN name='rushingYards' THEN numeric_value END) AS rushing_yards,
    MAX(CASE WHEN name='completionAttempts' THEN numerator END) AS completions,
    MAX(CASE WHEN name='completionAttempts' THEN denominator END) AS passing_attempts,
    MAX(CASE WHEN name='netPassingYards' THEN numeric_value END) AS net_passing_yards,
    MAX(CASE WHEN name='sacksYardsLost' THEN numerator END) AS sacks_taken,
    MAX(CASE WHEN name='sacksYardsLost' THEN denominator END) AS sack_yards_lost,
    MAX(CASE WHEN name='turnovers' THEN numeric_value END) AS turnovers,
    MAX(CASE WHEN name='thirdDownEff' THEN numerator END) AS third_down_conversions,
    MAX(CASE WHEN name='thirdDownEff' THEN denominator END) AS third_down_attempts
  FROM game_team_stats GROUP BY game_id, team_id
)
SELECT t.*, teams.name AS team_name, teams.abbreviation,
  CASE WHEN t.team_id=g.home_team_id THEN g.away_team_id ELSE g.home_team_id END AS opponent_team_id,
  CASE WHEN t.team_id=g.home_team_id THEN g.home_score ELSE g.away_score END AS points,
  CASE WHEN t.team_id=g.home_team_id THEN g.away_score ELSE g.home_score END AS opponent_points,
  1.0*rushing_attempts/NULLIF(rushing_attempts+passing_attempts,0) AS recorded_rush_share,
  g.season, g.week, g.starts_at, g.status, g.completed, g.last_fetched_at, g.snapshot_id
FROM totals t JOIN games g ON g.id=t.game_id JOIN teams ON teams.id=t.team_id;
PRAGMA user_version=1;
`;

const schemaV2 = `
CREATE TABLE nfl_schedule (
  id TEXT PRIMARY KEY, season INTEGER NOT NULL, season_type INTEGER NOT NULL, week INTEGER NOT NULL,
  starts_at TEXT NOT NULL, home_team_id TEXT REFERENCES teams(id), away_team_id TEXT REFERENCES teams(id),
  home_score INTEGER, away_score INTEGER, state TEXT NOT NULL, status TEXT NOT NULL,
  status_detail TEXT NOT NULL, quarter INTEGER NOT NULL, clock TEXT NOT NULL,
  completed INTEGER NOT NULL, completed_at TEXT, fetched_at TEXT NOT NULL,
  source_url TEXT NOT NULL, raw_json TEXT NOT NULL CHECK(json_valid(raw_json))
);
CREATE INDEX nfl_schedule_week ON nfl_schedule(season,season_type,week);
CREATE TABLE nfl_collector_tasks (
  key TEXT PRIMARY KEY, next_at TEXT NOT NULL, failures INTEGER NOT NULL DEFAULT 0,
  attempted_at TEXT, succeeded_at TEXT, error TEXT
);
CREATE TABLE nfl_collector_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE nfl_collector_owner (id INTEGER PRIMARY KEY CHECK(id=1), pid INTEGER NOT NULL, token TEXT NOT NULL);
CREATE VIEW nfl_games AS
SELECT s.id, s.season, s.season_type, s.week, s.starts_at,
  s.home_team_id, h.name AS home_team, h.abbreviation AS home_abbreviation,
  s.away_team_id, a.name AS away_team, a.abbreviation AS away_abbreviation,
  s.home_score, s.away_score, s.state, s.status, s.status_detail, s.quarter, s.clock, s.completed,
  s.fetched_at AS scoreboard_fetched_at, g.last_fetched_at AS plays_fetched_at,
  g.snapshot_id, (SELECT COUNT(*) FROM plays p WHERE p.game_id=s.id) AS play_count,
  t.error AS collection_error, t.next_at AS next_fetch_at
FROM nfl_schedule s LEFT JOIN teams h ON h.id=s.home_team_id LEFT JOIN teams a ON a.id=s.away_team_id
LEFT JOIN games g ON g.id=s.id LEFT JOIN nfl_collector_tasks t ON t.key='game:'||s.id
UNION ALL
SELECT g.id,g.season,g.season_type,g.week,g.starts_at,
  g.home_team_id,h.name,h.abbreviation,g.away_team_id,a.name,a.abbreviation,
  g.home_score,g.away_score,CASE WHEN g.completed THEN 'post' ELSE 'in' END,g.status,g.status,NULL,NULL,g.completed,
  NULL,g.last_fetched_at,g.snapshot_id,(SELECT COUNT(*) FROM plays p WHERE p.game_id=g.id),t.error,t.next_at
FROM games g JOIN teams h ON h.id=g.home_team_id JOIN teams a ON a.id=g.away_team_id
LEFT JOIN nfl_collector_tasks t ON t.key='game:'||g.id
WHERE NOT EXISTS (SELECT 1 FROM nfl_schedule s WHERE s.id=g.id);
PRAGMA user_version=2;
`;

export function openNflDatabase(filename = nflDatabasePath) {
  mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename);
  try {
    db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    const version = db.prepare("PRAGMA user_version").get()!.user_version;
    if (version !== 0 && version !== 1 && version !== 2) throw new Error(`Unsupported NFL schema version: ${version}`);
    db.exec("PRAGMA journal_mode=DELETE;");
    if (version === 0) {
      db.exec("BEGIN IMMEDIATE");
      try { db.exec(schema); db.exec("COMMIT"); }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    }
    if (version < 2) {
      db.exec("BEGIN IMMEDIATE");
      try { db.exec(schemaV2); db.exec("COMMIT"); }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    }
    return db;
  } catch (error) { db.close(); throw error; }
}

export function importNflGame(db: DatabaseSync, gameId: string, payload: unknown, fetchedAt = new Date().toISOString()) {
  if (!/^\d+$/.test(gameId) || !Number.isFinite(Date.parse(fetchedAt))) throw new Error("Invalid game ID or retrieval time");
  const root = record(payload, "summary");
  const header = record(root.header, "header");
  if (header.id !== gameId || header.league?.slug !== "nfl" || header.league?.id !== "28") throw new Error("Summary does not match requested NFL game");
  if (!Array.isArray(header.competitions) || header.competitions.length !== 1) throw new Error("Expected one NFL competition");
  const competition = record(header.competitions[0], "competition");
  if (competition.id !== gameId) throw new Error("Competition ID mismatch");
  if (!Array.isArray(competition.competitors) || competition.competitors.length !== 2) throw new Error("Expected two teams");
  const home = competition.competitors.find((item: RecordValue) => item.homeAway === "home");
  const away = competition.competitors.find((item: RecordValue) => item.homeAway === "away");
  if (!home || !away) throw new Error("Missing home/away teams");
  const teams = [home, away].map(item => ({
    id: text(item.team?.id, "team ID"), name: text(item.team?.displayName, "team name"),
    abbreviation: text(item.team?.abbreviation, "team abbreviation"), score: integer(item.score, "team score"),
  }));
  const teamIds = new Set(teams.map(team => team.id));
  if (teamIds.size !== 2) throw new Error("Duplicate teams");
  const teamId = (value: unknown) => {
    if (value === undefined || value === null) return null;
    if (typeof value !== "string" || !teamIds.has(value)) throw new Error("Unknown participating team ID");
    return value;
  };
  const startsAt = text(competition.date, "start time");
  if (!Number.isFinite(Date.parse(startsAt))) throw new Error("Invalid start time");
  const status = text(competition.status?.type?.name, "game status");
  if (typeof competition.status?.type?.completed !== "boolean") throw new Error("Missing completion status");
  const completed = Number(competition.status.type.completed);
  const season = integer(header.season?.year, "season");
  const seasonType = integer(header.season?.type, "season type");
  const week = integer(header.week, "week");
  const sourceDrives = record(root.drives, "drives");
  if (sourceDrives.previous !== undefined && !Array.isArray(sourceDrives.previous)) throw new Error("Invalid previous drives");
  if (!Array.isArray(sourceDrives.previous) && (completed || !sourceDrives.current)) throw new Error("Missing previous drives");
  const drives = new Map<string, { raw: RecordValue; sequence: number }>();
  const plays = new Map<string, { raw: RecordValue; driveId: string }>();
  let duplicatePlays = 0;
  for (const value of [...(sourceDrives.previous ?? []), ...(sourceDrives.current ? [sourceDrives.current] : [])]) {
    const drive = record(value, "drive");
    const id = text(drive.id, "drive ID");
    teamId(drive.team?.id);
    drives.set(id, { raw: drive, sequence: drives.get(id)?.sequence ?? drives.size });
    if (!Array.isArray(drive.plays)) throw new Error("Missing drive plays");
    for (const value of drive.plays) {
      const play = record(value, "play");
      const playId = text(play.id, "play ID");
      text(play.text, "play description"); text(play.type?.id, "play type ID"); text(play.type?.text, "play type");
      integer(play.sequenceNumber, "play sequence"); integer(play.period?.number, "quarter");
      text(play.clock?.displayValue, "play clock");
      integer(play.homeScore, "home score"); integer(play.awayScore, "away score");
      if ([play.isPenalty, play.isTurnover, play.scoringPlay].some(flag => typeof flag !== "boolean")) throw new Error("Invalid play flags");
      record(play.start, "play start"); record(play.end, "play end");
      teamId(play.start.team?.id); teamId(play.end.team?.id);
      if (!Array.isArray(play.teamParticipants)) throw new Error("Missing play team roles");
      for (const participant of play.teamParticipants) teamId(participant.id);
      if (plays.has(playId)) duplicatePlays++;
      plays.set(playId, { raw: play, driveId: id });
    }
  }
  if (!plays.size) throw new Error("No usable plays returned");
  const stats = new Map<string, { teamId: string; raw: RecordValue; value: string }>();
  if (root.boxscore !== undefined) record(root.boxscore, "boxscore");
  const boxscoreTeams = root.boxscore?.teams ?? [];
  if (!Array.isArray(boxscoreTeams) || (completed && boxscoreTeams.length !== 2)) throw new Error("Expected both team boxscores");
  const statsTeams = new Set<string>();
  for (const entry of boxscoreTeams) {
    const id = teamId(entry.team?.id);
    const statistics = !completed && entry.statistics === undefined ? [] : entry.statistics;
    if (!id || statsTeams.has(id) || !Array.isArray(statistics) || (completed && !statistics.length)) throw new Error("Invalid team statistics");
    statsTeams.add(id);
    for (const value of statistics) {
      const stat = record(value, "statistic");
      const name = text(stat.name, "statistic name");
      const display = text(stat.displayValue, "statistic value");
      const key = `${id}:${name}`;
      if (stats.has(key) && stats.get(key)!.value !== display) throw new Error(`Conflicting statistic ${key}`);
      stats.set(key, { teamId: id, raw: stat, value: display });
    }
  }
  const rawJson = json(root);
  const hash = createHash("sha256").update(rawJson).digest("hex");
  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = db.prepare("SELECT completed, home_team_id, away_team_id, last_fetched_at FROM games WHERE id=?").get(gameId);
    if (existing && (existing.home_team_id !== teams[0].id || existing.away_team_id !== teams[1].id)) throw new Error("Game teams changed unexpectedly");
    if (existing && Date.parse(String(existing.last_fetched_at)) > Date.parse(fetchedAt)) throw new Error("Refusing an older retrieval");
    if (existing?.completed && !completed) throw new Error("Completed game cannot become incomplete");
    const previous = db.prepare("SELECT id, raw_json FROM plays WHERE game_id=?").all(gameId);
    if (previous.some(play => !plays.has(String(play.id)))) throw new Error("Game timeline lost previously saved plays");
    db.prepare(`INSERT INTO source_snapshots (game_id,content_hash,source_url,first_fetched_at,last_fetched_at,raw_json)
      VALUES (?,?,?,?,?,?) ON CONFLICT(game_id,content_hash) DO UPDATE SET last_fetched_at=excluded.last_fetched_at`)
      .run(gameId, hash, nflSummaryUrl(gameId), fetchedAt, fetchedAt, rawJson);
    const snapshotId = db.prepare("SELECT id FROM source_snapshots WHERE game_id=? AND content_hash=?").get(gameId, hash)!.id;
    const saveTeam = db.prepare("INSERT INTO teams VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,abbreviation=excluded.abbreviation");
    for (const team of teams) saveTeam.run(team.id, team.name, team.abbreviation);
    db.prepare(`INSERT INTO games VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      season=excluded.season,season_type=excluded.season_type,week=excluded.week,starts_at=excluded.starts_at,status=excluded.status,
      completed=excluded.completed,home_score=excluded.home_score,away_score=excluded.away_score,snapshot_id=excluded.snapshot_id,last_fetched_at=excluded.last_fetched_at`)
      .run(gameId, season, seasonType, week, startsAt, status, completed, teams[0].id, teams[1].id, teams[0].score, teams[1].score, snapshotId, fetchedAt);
    const saveDrive = db.prepare(`INSERT INTO drives VALUES (?,?,?,?,?,?,?) ON CONFLICT(game_id,id) DO UPDATE SET
      sequence=excluded.sequence,team_id=excluded.team_id,result=excluded.result,raw_json=excluded.raw_json,snapshot_id=excluded.snapshot_id`);
    for (const [id, drive] of drives) saveDrive.run(gameId, id, drive.sequence, teamId(drive.raw.team?.id), drive.raw.result ?? null, json(drive.raw), snapshotId);
    const columns = ["game_id","id","drive_id","sequence","type_id","type_name","description","quarter","clock","home_score","away_score",
      "offense_team_id","defense_team_id","start_team_id","end_team_id","start_down","start_distance","start_yard_line","start_yards_to_endzone",
      "end_down","end_distance","end_yard_line","end_yards_to_endzone","stat_yardage","is_penalty","is_turnover","is_scoring","is_no_play","is_scramble","is_kneel",
      "wall_clock","provider_modified_at","raw_json","snapshot_id"];
    const savePlay = db.prepare(`INSERT INTO plays (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})
      ON CONFLICT(game_id,id) DO UPDATE SET ${columns.slice(2).map(column => `${column}=excluded.${column}`).join(",")}`);
    for (const [id, { raw: play, driveId }] of plays) {
      const role = (name: string) => teamId(play.teamParticipants.find((entry: RecordValue) => entry.type === name)?.id);
      savePlay.run(gameId, id, driveId, Number(play.sequenceNumber), play.type.id, play.type.text, play.text, Number(play.period.number), play.clock.displayValue,
        Number(play.homeScore), Number(play.awayScore), role("offense"), role("defense"), teamId(play.start.team?.id), teamId(play.end.team?.id),
        ...[play.start, play.end].flatMap(situation => [situation.down, situation.distance, situation.yardLine, situation.yardsToEndzone].map(optionalNumber)),
        optionalNumber(play.statYardage), Number(play.isPenalty === true), Number(play.isTurnover === true), Number(play.scoringPlay === true),
        Number(play.type.id === "8" || /\bno play\b/i.test(play.text)), Number(/\bscrambl\w*/i.test(play.text)), Number(/\bkneel\w*/i.test(play.text)),
        play.wallclock ?? null, play.modified ?? null, json(play), snapshotId);
    }
    db.prepare("DELETE FROM game_team_stats WHERE game_id=?").run(gameId);
    const saveStat = db.prepare("INSERT INTO game_team_stats VALUES (?,?,?,?,?,?,?,?,?)");
    for (const stat of stats.values()) {
      const numeric = /^-?\d+(?:\.\d+)?$/.test(stat.value) ? Number(stat.value) : null;
      const pair = stat.raw.name === "completionAttempts" ? /^(\d+)\/(\d+)$/.exec(stat.value)
        : ["sacksYardsLost", "thirdDownEff"].includes(stat.raw.name) ? /^(\d+)-(\d+)$/.exec(stat.value) : null;
      saveStat.run(gameId, stat.teamId, stat.raw.name, stat.value, numeric, pair ? Number(pair[1]) : null, pair ? Number(pair[2]) : null, json(stat.raw), snapshotId);
    }
    const priorById = new Map(previous.map(play => [String(play.id), play.raw_json]));
    const added = [...plays.keys()].filter(id => !priorById.has(id)).length;
    const corrected = [...plays].filter(([id, play]) => priorById.has(id) && priorById.get(id) !== json(play.raw)).length;
    db.exec("COMMIT");
    return { gameId, teams: teams.map(team => `${team.abbreviation} ${team.score}`), drives: drives.size, plays: plays.size,
      duplicatePlays, added, corrected, snapshotId, fetchedAt };
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export async function fetchNflGame(gameId: string) {
  if (!/^\d+$/.test(gameId)) throw new Error("Game IDs must contain digits only");
  const response = await fetch(nflSummaryUrl(gameId), { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`ESPN returned HTTP ${response.status} for ${gameId}`);
  return response.json() as Promise<unknown>;
}
