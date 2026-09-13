import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { importNflGame, nflDatabasePath, nflSummaryUrl, openNflDatabase } from "./nfl-data.js";

const scoreboardUrl = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";
const minute = 60_000;
const day = 24 * 60 * minute;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

type Calendar = { value: string; startDate: string; endDate: string; entries?: Calendar[] };
type Season = { year: number; type: number; week: number; calendar: Calendar[] };
type ScheduleGame = {
  id: string; season: number; season_type: number; week: number; starts_at: string;
  state: string; status: string; completed: number; completed_at: string | null;
};
class ProviderError extends Error {
  constructor(text: string, readonly retryAt = 0) { super(text); }
}
function number(value: unknown, label: string) {
  if ((typeof value !== "string" && typeof value !== "number") || String(value).trim() === "" || !Number.isSafeInteger(Number(value)) || Number(value) < 0) throw new Error(`Invalid ${label}`);
  return Number(value);
}
function date(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`Invalid ${label}`);
  return new Date(value).toISOString();
}

export function saveNflScoreboard(db: DatabaseSync, payload: any, sourceUrl: string, fetchedAt: string, season: number) {
  if (!payload?.leagues?.some((league: any) => league.id === "28" && league.slug === "nfl") || !Array.isArray(payload.events)) throw new Error("Invalid NFL scoreboard");
  const seen = new Set<string>();
  const events = payload.events.filter((event: any) => event.season?.year === season && [2, 3].includes(event.season?.type));
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const event of events) {
      if (typeof event.id !== "string" || !/^\d+$/.test(event.id) || seen.has(event.id)) throw new Error("Invalid or duplicate schedule game ID");
      seen.add(event.id);
      if (event.competitions?.length !== 1 || event.competitions[0].id !== event.id) throw new Error("Schedule competition mismatch");
      const competition = event.competitions[0];
      if (!Array.isArray(competition.competitors) || competition.competitors.length !== 2) throw new Error("Invalid schedule competitors");
      const teams = ["home", "away"].map(side => {
        const participant = competition.competitors.find((item: any) => item.homeAway === side);
        if (!participant?.team || typeof participant.team.id !== "string") throw new Error("Missing schedule team");
        const team = participant.team;
        if (/^-\d+$/.test(team.id) && team.isActive === false) return { id: null, score: null };
        if (!/^\d+$/.test(team.id) || !team.displayName?.trim() || !team.abbreviation?.trim()) throw new Error("Invalid schedule team");
        db.prepare("INSERT INTO teams VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,abbreviation=excluded.abbreviation")
          .run(team.id, team.displayName, team.abbreviation);
        return { id: team.id, score: participant.score == null ? null : number(participant.score, "schedule score") };
      });
      if (teams[0].id && teams[0].id === teams[1].id) throw new Error("Duplicate schedule teams");
      const status = competition.status;
      if (!["pre", "in", "post"].includes(status?.type?.state) || typeof status.type.completed !== "boolean" || !status.type.name) throw new Error("Invalid schedule status");
      const previous = db.prepare("SELECT * FROM nfl_schedule WHERE id=?").get(event.id);
      if (previous && String(previous.fetched_at) > fetchedAt) continue;
      if (previous?.completed && !status.type.completed) throw new Error("Completed schedule game regressed");
      const imported = db.prepare("SELECT home_team_id,away_team_id FROM games WHERE id=?").get(event.id);
      if (imported && (imported.home_team_id !== teams[0].id || imported.away_team_id !== teams[1].id)) throw new Error("Imported game teams changed");
      db.prepare(`INSERT INTO nfl_schedule VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        season=excluded.season,season_type=excluded.season_type,week=excluded.week,starts_at=excluded.starts_at,
        home_team_id=excluded.home_team_id,away_team_id=excluded.away_team_id,home_score=excluded.home_score,away_score=excluded.away_score,
        state=excluded.state,status=excluded.status,status_detail=excluded.status_detail,quarter=excluded.quarter,clock=excluded.clock,
        completed=excluded.completed,completed_at=COALESCE(nfl_schedule.completed_at,excluded.completed_at),
        fetched_at=excluded.fetched_at,source_url=excluded.source_url,raw_json=excluded.raw_json`)
        .run(event.id, season, event.season.type, number(event.week?.number, "schedule week"), date(competition.date, "kickoff"),
          teams[0].id, teams[1].id, teams[0].score, teams[1].score, status.type.state, status.type.name,
          String(status.type.shortDetail ?? status.type.description ?? status.type.name), number(status.period ?? 0, "quarter"), String(status.displayClock ?? ""),
          Number(status.type.completed), status.type.completed ? fetchedAt : null, fetchedAt, sourceUrl, JSON.stringify(event));
    }
    db.exec("COMMIT");
    return events.length;
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export class NflCollector {
  private db?: DatabaseSync;
  private token = randomUUID();
  private owner = false;
  private fatal: string | null = null;
  private controller = new AbortController();
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private cycleWorked = false;
  private readonly filename: string;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;

  constructor(options: { filename?: string; fetcher?: typeof fetch; now?: () => number } = {}) {
    this.filename = options.filename ?? nflDatabasePath;
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? Date.now;
  }

  initialize() {
    try {
      this.db = openNflDatabase(this.filename);
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const owner = this.db.prepare("SELECT pid FROM nfl_collector_owner WHERE id=1").get();
        if (owner) {
          let alive = true;
          try { process.kill(Number(owner.pid), 0); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false; else throw error; }
          if (alive) throw new Error("NFL collection is owned by another server process");
        }
        this.db.prepare("INSERT OR REPLACE INTO nfl_collector_owner VALUES (1,?,?)").run(process.pid, this.token);
        this.db.exec("COMMIT");
        this.owner = true;
      } catch (error) { this.db.exec("ROLLBACK"); throw error; }
      for (const key of ["scoreboard", "schedule"]) {
        this.db.prepare("INSERT OR IGNORE INTO nfl_collector_tasks(key,next_at) VALUES (?,?)").run(key, this.iso());
        this.db.prepare("UPDATE nfl_collector_tasks SET next_at=? WHERE key=? AND failures=0").run(this.iso(), key);
      }
    } catch (error) {
      this.fatal = message(error);
      if (!this.owner) { this.db?.close(); this.db = undefined; }
    }
  }

  private iso(offset = 0) { return new Date(this.now() + offset).toISOString(); }
  private state<T>(key: string): T | undefined {
    const row = this.db!.prepare("SELECT value FROM nfl_collector_state WHERE key=?").get(key);
    return row ? JSON.parse(String(row.value)) : undefined;
  }
  private saveState(key: string, value: unknown) {
    this.db!.prepare("INSERT INTO nfl_collector_state VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, JSON.stringify(value));
  }
  private due(key: string) {
    const row = this.db!.prepare("SELECT next_at FROM nfl_collector_tasks WHERE key=?").get(key);
    return !row || String(row.next_at) <= this.iso();
  }
  private async request(url: string) {
    const response = await this.fetcher(url, { signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(20_000)]) });
    if (!response.ok) {
      const retry = response.headers.get("retry-after");
      const retryAt = retry ? (/^\d+(\.\d+)?$/.test(retry) ? this.now() + Number(retry) * 1000 : Date.parse(retry)) : 0;
      throw new ProviderError(`ESPN HTTP ${response.status}`, Number.isFinite(retryAt) ? retryAt : 0);
    }
    return response.json();
  }
  private async task(key: string, interval: number, work: () => Promise<void>) {
    if (!this.due(key) || this.controller.signal.aborted) return;
    this.cycleWorked = true;
    this.db!.prepare(`INSERT INTO nfl_collector_tasks(key,next_at,attempted_at) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET attempted_at=excluded.attempted_at`).run(key, this.iso(), this.iso());
    try {
      await work();
      this.db!.prepare("UPDATE nfl_collector_tasks SET next_at=?,failures=0,error=NULL,succeeded_at=? WHERE key=?").run(this.iso(interval), this.iso(), key);
    } catch (error) {
      if (this.controller.signal.aborted) return;
      const failures = Number(this.db!.prepare("SELECT failures FROM nfl_collector_tasks WHERE key=?").get(key)!.failures) + 1;
      const retryAt = Math.max(this.now() + Math.min(15 * minute, minute * 2 ** Math.min(failures - 1, 4)), error instanceof ProviderError ? error.retryAt : 0);
      this.db!.prepare("UPDATE nfl_collector_tasks SET next_at=?,failures=?,error=? WHERE key=?")
        .run(new Date(retryAt).toISOString(), failures, message(error).slice(0, 1000), key);
    }
  }

  start() {
    if (!this.owner || this.fatal || this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, 1000);
    this.timer.unref();
    void this.tick();
  }
  tick(): Promise<void> {
    if (!this.owner || this.fatal || this.controller.signal.aborted) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.collect().catch(error => { this.fatal = message(error); }).finally(() => { this.running = undefined; });
    return this.running;
  }
  private async collect() {
    this.cycleWorked = false;
    await this.task("scoreboard", minute, async () => {
      const payload: any = await this.request(scoreboardUrl);
      const year = number(payload.season?.year, "current season");
      const type = number(payload.season?.type, "current season type");
      const week = number(payload.week?.number ?? 0, "current week");
      const league = payload.leagues?.find((item: any) => item.id === "28" && item.slug === "nfl");
      if (!Array.isArray(league?.calendar)) throw new Error("Missing NFL calendar");
      const changed = this.state<Season>("season")?.year !== year;
      saveNflScoreboard(this.db!, payload, scoreboardUrl, this.iso(), year);
      this.saveState("season", { year, type, week, calendar: league.calendar });
      if (changed) this.db!.prepare("UPDATE nfl_collector_tasks SET next_at=?,failures=0,error=NULL WHERE key='schedule'").run(this.iso());
    });
    const season = this.state<Season>("season");
    if (!season) return;
    await this.task("schedule", day, async () => {
      const calendar = season.calendar.filter(entry => ["2", "3"].includes(entry.value));
      if (!calendar.length) throw new Error("Regular-season calendar unavailable");
      const start = calendar.map(entry => date(entry.startDate, "calendar start")).sort()[0];
      const end = calendar.map(entry => date(entry.endDate, "calendar end")).sort().at(-1)!;
      const compact = (value: string) => value.slice(0, 10).replaceAll("-", "");
      const url = `${scoreboardUrl}?dates=${compact(start)}-${compact(end)}&limit=1000`;
      const payload: any = await this.request(url);
      if (!Array.isArray(payload.events) || !payload.events.length || payload.events.length >= 1000) throw new Error("Incomplete season schedule");
      if (!saveNflScoreboard(this.db!, payload, url, this.iso(), season.year)) throw new Error("No current-season games in schedule");
    });
    const earlierWeeks = this.db!.prepare(`SELECT DISTINCT season_type,week FROM nfl_schedule
      WHERE season=? AND completed=0 AND starts_at<=? AND home_team_id IS NOT NULL AND away_team_id IS NOT NULL
      AND status NOT IN ('STATUS_CANCELED','STATUS_CANCELLED') AND NOT (season_type=? AND week=?)`)
      .all(season.year, this.iso(), season.type, season.week);
    for (const entry of earlierWeeks) {
      await this.task(`week:${season.year}:${entry.season_type}:${entry.week}`, minute, async () => {
        const url = `${scoreboardUrl}?dates=${season.year}&seasontype=${entry.season_type}&week=${entry.week}`;
        saveNflScoreboard(this.db!, await this.request(url), url, this.iso(), season.year);
      });
    }
    const games = this.db!.prepare(`SELECT s.* FROM nfl_schedule s LEFT JOIN games g ON g.id=s.id
      WHERE s.season=? AND s.home_team_id IS NOT NULL AND s.away_team_id IS NOT NULL
      AND (s.state='in' OR (s.completed=1 AND (g.id IS NULL OR g.completed=0 OR s.completed_at>=?))
        OR (s.state='pre' AND s.starts_at<=? AND s.status NOT IN ('STATUS_POSTPONED','STATUS_CANCELED','STATUS_CANCELLED','STATUS_SUSPENDED')))
      ORDER BY CASE WHEN s.state='in' THEN 0 WHEN s.state='pre' THEN 1 WHEN g.id IS NOT NULL AND g.completed=0 THEN 2 ELSE 3 END,s.starts_at DESC`)
      .all(season.year, this.iso(-7 * day), this.iso()) as unknown as ScheduleGame[];
    let index = 0;
    const worker = async () => {
      while (index < games.length && !this.controller.signal.aborted) {
        const game = games[index++];
        await this.task(`game:${game.id}`, game.completed ? day : minute, async () => {
          const payload: any = await this.request(nflSummaryUrl(game.id));
          importNflGame(this.db!, game.id, payload, this.iso());
          const competition = payload.header.competitions[0];
          if (competition.status.type.completed) {
            this.db!.prepare(`UPDATE nfl_schedule SET state='post',completed=1,completed_at=COALESCE(completed_at,?),
              status=?,status_detail=?,home_score=(SELECT home_score FROM games WHERE id=?),
              away_score=(SELECT away_score FROM games WHERE id=?) WHERE id=?`)
              .run(this.iso(), competition.status.type.name, competition.status.type.shortDetail ?? "Final", game.id, game.id, game.id);
          }
        });
      }
    };
    const results = await Promise.allSettled(Array.from({ length: Math.min(4, games.length) }, worker));
    for (const result of results) if (result.status === "rejected") throw result.reason;
    if (this.cycleWorked) this.saveState("last_cycle_at", this.iso());
  }

  status() {
    if (!this.db) return { running: false, error: this.fatal, season: null, games: [] };
    const season = this.state<Season>("season");
    const tasks = this.db.prepare("SELECT key,next_at,attempted_at,succeeded_at,error FROM nfl_collector_tasks WHERE key NOT LIKE 'game:%'").all();
    const games = season ? this.db.prepare(`SELECT * FROM nfl_games WHERE season=? AND season_type=? AND week=?
      ORDER BY CASE state WHEN 'in' THEN 0 WHEN 'pre' THEN 1 ELSE 2 END,starts_at,id`).all(season.year, season.type, season.week) : [];
    return {
      running: this.owner && !this.fatal && !this.controller.signal.aborted, error: this.fatal,
      season: season ? { year: season.year, type: season.type, week: season.week } : null,
      lastCycleAt: this.state<string>("last_cycle_at") ?? null, tasks,
      games: games.map(game => ({ ...game, stale: game.state === "in" && (!game.plays_fetched_at || this.now() - Date.parse(String(game.plays_fetched_at)) > 3 * minute),
        scoreboard_stale: !game.scoreboard_fetched_at || this.now() - Date.parse(String(game.scoreboard_fetched_at)) > 3 * minute })),
    };
  }
  async close() {
    clearInterval(this.timer);
    this.controller.abort();
    await this.running;
    if (this.owner) this.db!.prepare("DELETE FROM nfl_collector_owner WHERE token=?").run(this.token);
    this.db?.close();
    this.db = undefined;
    this.owner = false;
  }
}
