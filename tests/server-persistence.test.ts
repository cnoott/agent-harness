import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";

const repository = fileURLToPath(new URL("../", import.meta.url));
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("server persists uploads and waits for main-chat saves during shutdown", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "harness-server-persistence-"));
  const provider = createServer(async (req, res) => {
    for await (const _chunk of req) { /* Drain the mock request. */ }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Saved before shutdown 🏈" })}\n\n`);
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  let child: ChildProcess | undefined;
  let output = "";
  let url = "";
  const start = async () => {
    output = "";
    child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), "--import", pathToFileURL(path.join(directory, "network.mjs")).href, path.join(repository, "src/server.ts")], {
      cwd: directory, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HOST: "127.0.0.1", PORT: "0", OPENAI_API_KEY: "self-test-key", OPENAI_MODEL: "mock", OPENAI_SUBAGENT_MODELS: "mock", GEMINI_API_KEY: "", OPENAI_BASE_URL: `http://127.0.0.1:${(provider.address() as any).port}` },
    });
    child.stdout!.on("data", chunk => { output += chunk.toString(); });
    child.stderr!.on("data", chunk => { output += chunk.toString(); });
    for (let i = 0; i < 400; i++) {
      const match = output.match(/Server listening at (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { url = match[1]; return; }
      if (child.exitCode !== null) throw new Error(`Server failed: ${output}`);
      await delay(20);
    }
    throw new Error(`Server did not start: ${output}`);
  };
  const stop = async () => {
    const exited = once(child!, "exit");
    child!.kill("SIGTERM");
    const [code] = await exited;
    assert.equal(code, 0, output);
    child = undefined;
  };
  try {
    await symlink(path.join(repository, "public"), path.join(directory, "public"));
    await symlink(path.join(repository, "node_modules"), path.join(directory, "node_modules"));
    await writeFile(path.join(directory, "network.mjs"), "const original = globalThis.fetch; globalThis.fetch = (input, options) => String(input).startsWith('https:') ? Promise.resolve(new Response('{}', {status:503})) : original(input, options);\n");
    await start();
    const created = await fetch(`${url}/api/chats`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workspaceId: "nfl" }) });
    assert.equal(created.status, 200);
    const session = await created.json() as any;
    for (const body of [null, {}, { text: 42 }, { text: [] }, { text: {} }, { text: "   " }]) {
      const invalid = await fetch(`${url}/api/chats/${session.id}/messages`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      assert.equal(invalid.status, 400, `Invalid message body: ${JSON.stringify(body)}`);
    }
    const liveReload = await fetch(`${url}/api/live-reload`);
    const liveReader = liveReload.body!.getReader();
    try {
      const first = await liveReader.read();
      assert.equal(new TextDecoder().decode(first.value), "event: ready\ndata: connected\n\n");
    } finally { await liveReader.cancel(); }
    const sessionFile = path.join(directory, ".data/sessions", session.id, "session.json");
    const upload = new FormData();
    upload.append("file", new Blob(["local fixture 🏈"]), "fixture.txt");
    assert.equal((await fetch(`${url}/api/chats/${session.id}/upload`, { method: "POST", body: upload })).status, 200);
    const tooLarge = new FormData();
    tooLarge.append("file", new Blob(["x".repeat(2 * 1024 * 1024)]), "fixture.txt");
    assert.equal((await fetch(`${url}/api/chats/${session.id}/upload`, { method: "POST", body: tooLarge })).status, 413);
    assert.equal(await (await fetch(`${url}/api/chats/${session.id}/files/fixture.txt?download=1`)).text(), "local fixture 🏈");

    if (process.env.RUN_BROWSER_TESTS === "1") {
      const { launch } = await import("cloakbrowser");
      const browser = await launch({ headless: true });
      try {
        session.messages = [{ id: "ui-fixture", role: "assistant", text: "Activity fixture", createdAt: session.createdAt, activity: [
          { type: "tool_start", name: "sports_query", callId: "first", data: { sql: "first input" } },
          { type: "tool_start", name: "sports_query", callId: "second", data: { sql: "second input" } },
          { type: "tool_end", name: "sports_query", callId: "second", status: "failed", durationMs: 200, data: { success: false, message: "second output" } },
          { type: "tool_end", name: "sports_query", callId: "first", status: "completed", durationMs: 100, data: { rows: ["first output"] } },
          { type: "tool_start", name: "exec", data: { command: "legacy input" } },
          { type: "tool_end", name: "exec", data: { stdout: "legacy output", exitCode: 0 } },
          { type: "tool_start", name: "exec", callId: "interrupted", data: { command: "pending" } },
          { type: "tool_end", name: "exec", callId: "interrupted", status: "interrupted", data: { error: "stopped" } },
        ] }];
        await writeFile(sessionFile, JSON.stringify(session));
        const page = await browser.newPage();
        page.setDefaultTimeout(5000);
        await page.addInitScript(({ id }) => { localStorage.setItem("sandbox-harness-chat", id); localStorage.setItem("sandbox-harness-sport", "nfl"); }, { id: session.id });
        const liveReloadRequest = page.waitForRequest(request => request.url().endsWith("/api/live-reload"));
        await page.goto(url);
        await liveReloadRequest;
        await page.waitForSelector('.activity-event[data-call-id="first"]', { state: "attached" });
        for (let pass = 0; pass < 2; pass++) {
          await page.waitForSelector('.activity-event[data-call-id="first"]', { state: "attached" });
          await page.locator(".tool-activity > summary").first().click();
          await page.waitForSelector('.activity-event[data-call-id="first"]');
          assert.equal(await page.locator(".activity-event").count(), 4);
          const first = await page.locator('.activity-event[data-call-id="first"]').textContent();
          assert.match(first!, /first input/); assert.match(first!, /first output/); assert.doesNotMatch(first!, /second output/);
          assert.match((await page.locator('.activity-event[data-call-id="second"] .activity-state').textContent())!, /Failed/);
          assert.match((await page.locator('.activity-event[data-call-id="interrupted"] .activity-state').textContent())!, /Interrupted/);
          if (!pass) await page.reload();
        }
        await page.locator("#files-toggle").click();
        const fileLink = page.getByRole("link", { name: "Download fixture.txt", exact: true });
        await fileLink.waitFor();
        const downloaded = page.waitForEvent("download");
        await fileLink.click();
        const download = await downloaded;
        const saved = path.join(directory, "downloaded.txt");
        await download.saveAs(saved);
        assert.equal(await readFile(saved, "utf8"), "local fixture 🏈");
        const rosterData = {
          state: "ready", leagueId: "123456789012345678", leagueName: "Test league", season: "2026", myRosterId: 1,
          fetchedAt: "2026-09-14T01:00:00Z", warnings: [], snapshotPath: "data/sleeper/latest.json",
          fantasy: { season: "2026", week: 1, fetchedAt: "2026-09-14T02:00:00Z" },
          teams: [
            { id: 1, name: "My team", owner: "Me", wins: 0, losses: 0, points: 119.72, players: [
              { id: "p1", name: "Starter One", position: "QB", nflTeam: "PHI", group: "Starter", slot: "QB", points: 24.72 },
              { id: "p2", name: "Starter Zero", position: "RB", nflTeam: "DEN", group: "Starter", slot: "RB", points: 0 },
              { id: "p3", name: "Defense", position: "DEF", nflTeam: "HOU", group: "Starter", slot: "DEF", points: -1 },
              { id: "p4", name: "Bench Player", position: "WR", nflTeam: "GB", group: "Bench", slot: "", points: null },
            ] },
            { id: 2, name: "Other team", owner: "Them", wins: 0, losses: 0, points: 98.5, players: [
              { id: "p5", name: "Other Starter", position: "QB", nflTeam: "CIN", group: "Starter", slot: "QB", points: 18.5 },
            ] },
          ],
        };
        await page.route("**/nfl/rosters", route => route.fulfill({ json: rosterData }));
        await page.locator("#teams-toggle").click();
        await page.locator(".league-team-card.is-mine").waitFor();
        assert.match((await page.locator(".league-team-card.is-mine").textContent())!, /119\.72 pts/);
        assert.match((await page.locator("#rosters-score-status").textContent())!, /Week 1 fantasy points/);
        await page.locator(".league-team-card.is-mine").click();
        assert.deepEqual(await page.locator("#roster-mine .roster-player-score").allTextContents(), ["24.72", "0.00", "-1.00", "—"]);
        await page.locator('#roster-mine input[type="checkbox"]').first().check();
        await page.locator('[data-roster-view="overview"]').click();
        await page.locator('[data-roster-view="builder"]').click();
        assert.equal(await page.locator('#roster-mine input[type="checkbox"]').first().isChecked(), true);
        assert((await page.locator("#roster-mine .roster-player-list").boundingBox())!.height >= 150, "Scores must not collapse the roster list");
        let refreshCalls = 0, messageCalls = 0, failRefresh = false;
        page.on("request", request => { if (request.url().endsWith("/messages") && request.method() === "POST") messageCalls++; });
        await page.route("**/nfl/matchup/refresh", async route => {
          assert.equal(route.request().method(), "POST"); refreshCalls++;
          if (failRefresh) return route.fulfill({ status: 503, json: { error: "Sleeper fixture unavailable" } });
          rosterData.teams[0].points = 120.72;
          await route.fulfill({ json: { state: "ready" } });
        });
        const draftBefore = await page.locator("#prompt").inputValue();
        await page.locator("#rosters-refresh").click();
        await page.waitForFunction(() => document.querySelector("#roster-mine .roster-fantasy-total")?.textContent === "120.72 pts");
        assert.equal(refreshCalls, 1);
        assert.equal(messageCalls, 0);
        assert.equal(await page.locator("#prompt").inputValue(), draftBefore);
        assert.equal(await page.locator('#roster-mine input[type="checkbox"]').first().isChecked(), true);
        failRefresh = true;
        await page.locator("#rosters-refresh").click();
        await page.waitForFunction(() => document.querySelector("#rosters-error")?.textContent?.includes("Sleeper fixture unavailable"));
        assert.match((await page.locator("#rosters-status").textContent())!, /previous roster snapshot/);
        assert.equal(await page.locator("#roster-mine .roster-fantasy-total").textContent(), "120.72 pts");
        assert.equal(messageCalls, 0);
        failRefresh = false;
        await page.locator("#rosters-refresh").click();
        await page.waitForFunction(() => document.querySelector("#rosters-error")?.textContent === "");
        if (process.env.HARNESS_ROSTER_QA_SCREENSHOT) {
          await page.locator("#context-panel").evaluate(node => { node.scrollTop = 0; });
          await page.screenshot({ path: `${process.env.HARNESS_ROSTER_QA_SCREENSHOT}-desktop.png`, fullPage: true });
          await page.setViewportSize({ width: 390, height: 844 });
          await page.screenshot({ path: `${process.env.HARNESS_ROSTER_QA_SCREENSHOT}-mobile.png`, fullPage: true });
          assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "Mobile view must not overflow horizontally");
        }
        if (process.env.HARNESS_QA_SCREENSHOT) {
          await page.locator(".tool-activity").first().evaluate((node: any) => { node.open = true; });
          await page.locator(".activity-event").evaluateAll(nodes => nodes.forEach((node: any) => { node.open = true; }));
          await page.screenshot({ path: process.env.HARNESS_QA_SCREENSHOT, fullPage: true });
        }
      } finally { await browser.close(); }
    }

    const running = await fetch(`${url}/api/chats/${session.id}/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "test shutdown" }) });
    const reader = running.body!.getReader();
    let stream = "";
    while (!stream.includes("Saved before shutdown")) {
      const chunk = await reader.read();
      assert(!chunk.done);
      stream += new TextDecoder().decode(chunk.value);
    }
    const unfinishedUpload = httpRequest(`${url}/api/chats/${session.id}/upload`, { method: "POST", headers: { "Content-Type": "multipart/form-data; boundary=shutdown-fixture" } });
    unfinishedUpload.on("error", () => {});
    unfinishedUpload.write('--shutdown-fixture\r\nContent-Disposition: form-data; name="file"; filename="fixture.txt"\r\nContent-Type: text/plain\r\n\r\npartial replacement');
    const workspace = path.join(directory, ".data/workspaces/nfl");
    for (let i = 0; !(await readdir(workspace)).some(name => name.startsWith(".upload-")); i++) {
      assert(i < 100, "Upload should begin writing its temporary file");
      await delay(10);
    }
    await stop();
    unfinishedUpload.destroy();
    assert.equal(await readFile(path.join(workspace, "fixture.txt"), "utf8"), "local fixture 🏈");
    assert(!(await readdir(workspace)).some(name => name.startsWith(".upload-")));
    const stored = JSON.parse(await readFile(sessionFile, "utf8"));
    assert.equal(stored.messages.at(-1).text, "Saved before shutdown 🏈");
    await assert.rejects(access(path.join(path.dirname(sessionFile), "active-run.json")));
    const db = new DatabaseSync(path.join(path.dirname(sessionFile), "history.sqlite"), { readOnly: true });
    try { assert.equal(JSON.parse(String(db.prepare("SELECT data FROM events WHERE kind='run_end' ORDER BY id DESC LIMIT 1").get()!.data)).status, "cancelled"); }
    finally { db.close(); }
    await start();
    const restored = await (await fetch(`${url}/api/chats/${session.id}`)).json() as any;
    assert.equal(restored.messages.filter((m: any) => m.text === "Saved before shutdown 🏈").length, 1);
    assert.equal(await (await fetch(`${url}/api/chats/${session.id}/files/fixture.txt`)).text(), "local fixture 🏈");
    await stop();
  } finally {
    if (child && child.exitCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; }
    provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
