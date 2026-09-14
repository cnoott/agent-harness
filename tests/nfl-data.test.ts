import assert from "node:assert/strict";
import { test } from "node:test";
import { openNflDatabase } from "../src/nfl-data.js";
import { saveNflScoreboard } from "../src/nfl-collector.js";

function scoreboard() {
  return {
    leagues: [{ id: "28", slug: "nfl" }],
    events: [{ id: "100", season: { year: 2026, type: 2 }, week: { number: 1 }, competitions: [{
      id: "100", date: "2026-09-13T17:00:00Z",
      competitors: [
        { homeAway: "home", score: "7", team: { id: "1", displayName: "Home", abbreviation: "HOM" } },
        { homeAway: "away", score: "3", team: { id: "2", displayName: "Away", abbreviation: "AWY" } },
      ],
      status: { type: { state: "in", completed: false, name: "STATUS_IN_PROGRESS" }, period: 1, displayClock: "10:00" },
    }] }],
  };
}

test("older scoreboards preserve both game state and team metadata", () => {
  const db = openNflDatabase(":memory:");
  try {
    saveNflScoreboard(db, scoreboard(), "fixture", "2026-09-13T18:00:00.000Z", 2026);
    const stale = scoreboard();
    stale.events[0].competitions[0].competitors[0].team.displayName = "Outdated name";
    stale.events[0].competitions[0].competitors[0].score = "0";
    saveNflScoreboard(db, stale, "fixture", "2026-09-13T17:00:00.000Z", 2026);
    assert.equal(db.prepare("SELECT name FROM teams WHERE id='1'").get()!.name, "Home");
    assert.equal(db.prepare("SELECT home_score FROM nfl_schedule WHERE id='100'").get()!.home_score, 7);
  } finally { db.close(); }
});

test("scoreboards compare retrieval instants and reject invalid timestamps", () => {
  const db = openNflDatabase(":memory:");
  try {
    saveNflScoreboard(db, scoreboard(), "fixture", "2026-09-13T18:00:00Z", 2026);
    const newer = scoreboard();
    newer.events[0].competitions[0].competitors[0].score = "14";
    saveNflScoreboard(db, newer, "fixture", "2026-09-13T14:01:00-04:00", 2026);
    assert.equal(db.prepare("SELECT home_score FROM nfl_schedule WHERE id='100'").get()!.home_score, 14);
    assert.throws(() => saveNflScoreboard(db, scoreboard(), "fixture", "invalid", 2026), /retrieval time/);
    assert.equal(db.prepare("SELECT home_score FROM nfl_schedule WHERE id='100'").get()!.home_score, 14);
  } finally { db.close(); }
});

test("invalid scoreboards roll back all rows and completed games cannot regress", () => {
  const db = openNflDatabase(":memory:");
  try {
    const invalid = scoreboard();
    invalid.events.push(structuredClone(invalid.events[0]));
    assert.throws(() => saveNflScoreboard(db, invalid, "fixture", "2026-09-13T18:00:00Z", 2026), /duplicate/);
    assert.equal(db.prepare("SELECT count(*) AS n FROM teams").get()!.n, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM nfl_schedule").get()!.n, 0);
    const completed = scoreboard();
    completed.events[0].competitions[0].status.type = { state: "post", completed: true, name: "STATUS_FINAL" };
    saveNflScoreboard(db, completed, "fixture", "2026-09-13T20:00:00Z", 2026);
    assert.throws(() => saveNflScoreboard(db, scoreboard(), "fixture", "2026-09-13T21:00:00Z", 2026), /regressed/);
    assert.equal(db.prepare("SELECT completed FROM nfl_schedule WHERE id='100'").get()!.completed, 1);
  } finally { db.close(); }
});
