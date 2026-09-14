import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { after, test } from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import type { BrowserContext, Download } from "playwright-core";
import { launchPersistentContext } from "cloakbrowser";
import { BrowserDownloads } from "../src/browser-downloads.js";

const directory = await mkdtemp(path.join(tmpdir(), "harness-downloads-"));
after(async () => { await rm(directory, { recursive: true, force: true }); });

async function fixture() {
  const root = await mkdtemp(path.join(directory, "case-"));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  const page = new EventEmitter();
  const context = Object.assign(new EventEmitter(), { pages: () => [page] });
  const downloads = new BrowserDownloads(workspace, context as unknown as BrowserContext);
  return { root, workspace, page, context, downloads };
}

function fakeDownload(saveAs: (destination: string) => Promise<void>, suggestedFilename = "report.csv", cancel = async () => {}) {
  return { suggestedFilename: () => suggestedFilename, saveAs, cancel, failure: async () => null } as unknown as Download;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("publishes only completed downloads from existing and new pages with safe unique names", async () => {
  const { workspace, page, context, downloads, root } = await fixture();
  const written = deferred();
  const finish = deferred();
  page.emit("download", fakeDownload(async (destination) => {
    await writeFile(destination, "partial");
    written.resolve();
    await finish.promise;
    await writeFile(destination, "complete content");
  }, "../../report.csv"));
  await written.promise;
  assert.deepEqual(await readdir(workspace), []);
  assert.equal(downloads.snapshot()[0].status, "pending");
  assert.equal(downloads.snapshot()[0].path, undefined);
  finish.resolve();
  await downloads.settle(1_000);
  const popup = new EventEmitter();
  context.emit("page", popup);
  popup.emit("download", fakeDownload((destination) => writeFile(destination, "second report"), "../../report.csv"));
  await downloads.close(1_000);
  const records = downloads.snapshot();
  assert.equal(records.length, 2);
  assert(records.every(({ status }) => status === "completed"));
  assert(records.every(({ path: location }) => location?.startsWith("/workspace/downloads/")));
  assert.notEqual(records[0].path, records[1].path);
  assert(!records[0].filename.includes("/"));
  assert.equal(await readFile(path.join(workspace, records[0].path!.slice("/workspace/".length)), "utf8"), "complete content");
  assert.deepEqual(await readdir(root), ["workspace"]);
});

test("failed transfers remove partial bytes and preserve actionable failure details", async () => {
  const { page, downloads, root, workspace } = await fixture();
  page.emit("download", fakeDownload(async (destination) => {
    await writeFile(destination, "partial bytes");
    throw new Error("network transfer failed");
  }));
  await downloads.close(1_000);
  assert.deepEqual(await readdir(workspace), []);
  assert.deepEqual(await readdir(root), ["workspace"]);
  assert.equal(downloads.snapshot()[0].status, "failed");
  assert.match(downloads.snapshot()[0].error!, /network transfer failed/);
  assert.equal(downloads.snapshot()[0].path, undefined);
});

test("shutdown waits for a completing download and marks cancelled downloads interrupted", async () => {
  const first = await fixture();
  first.page.emit("download", fakeDownload(async (destination) => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    await writeFile(destination, "saved during shutdown");
  }));
  await first.downloads.close(2_000);
  assert.equal(first.downloads.snapshot()[0].status, "completed");

  const second = await fixture();
  const started = deferred();
  const cancelled = deferred();
  second.page.emit("download", fakeDownload(async (destination) => {
    await writeFile(destination, "unfinished");
    started.resolve();
    await cancelled.promise;
    throw new Error("cancelled");
  }, "report.csv", async () => { cancelled.resolve(); }));
  await started.promise;
  await second.downloads.close(100);
  assert.equal(second.downloads.snapshot()[0].status, "interrupted");
  assert.equal(second.downloads.snapshot()[0].path, undefined);
  assert.deepEqual(await readdir(second.workspace), []);
  assert.deepEqual(await readdir(second.root), ["workspace"]);
});

test("shutdown remains bounded when cancellation and the browser transport hang", async () => {
  const { page, downloads, workspace } = await fixture();
  const started = deferred();
  const finish = deferred();
  page.emit("download", fakeDownload(async (destination) => {
    await writeFile(destination, "partial");
    started.resolve();
    await finish.promise;
  }, "report.csv", () => new Promise(() => {})));
  await started.promise;
  const before = Date.now();
  await downloads.close(100);
  assert(Date.now() - before < 500);
  assert.equal(downloads.snapshot()[0].status, "interrupted");
  assert.deepEqual(await readdir(workspace), []);
  finish.resolve();
  await downloads.settle(1_000);
  assert.equal(downloads.snapshot()[0].path, undefined);
  assert.deepEqual(await readdir(path.join(workspace, "downloads")), []);
});

test("rejects a downloads directory symlink without writing outside the workspace", async () => {
  const { page, downloads, workspace, root } = await fixture();
  const outside = path.join(root, "outside");
  await mkdir(outside);
  await symlink(outside, path.join(workspace, "downloads"));
  page.emit("download", fakeDownload((destination) => writeFile(destination, "report")));
  await downloads.close(1_000);
  assert.equal(downloads.snapshot()[0].status, "failed");
  assert.match(downloads.snapshot()[0].error!, /without symlinks/);
  assert.deepEqual(await readdir(outside), []);
});

test("a real local browser download survives closing its persistent context", { timeout: 30_000, skip: process.env.RUN_BROWSER_TESTS !== "1" }, async () => {
  const { workspace, root } = await fixture();
  const body = "player,score\nA,42\n";
  const server = createServer((request, response) => {
    if (request.url === "/report") {
      response.writeHead(200, { "content-type": "text/csv", "content-disposition": "attachment; filename=report.csv" });
      response.end(body);
    } else {
      response.end('<a href="/report" download>Download report</a>');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  let context: BrowserContext | undefined;
  let stagehand: any;
  try {
    const profile = path.join(root, "profile");
    context = await launchPersistentContext({ userDataDir: profile, headless: true, args: ["--remote-debugging-port=0"], contextOptions: { acceptDownloads: true } });
    const downloads = new BrowserDownloads(workspace, context);
    const { Stagehand } = await import("@browserbasehq/stagehand");
    const [port, browserPath] = (await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).trim().split(/\r?\n/);
    stagehand = new Stagehand({ env: "LOCAL", disablePino: true, logger: () => {}, model: { modelName: "openai/gpt-4.1-mini", apiKey: "unused-local-test" }, localBrowserLaunchOptions: { cdpUrl: `ws://127.0.0.1:${port}${browserPath}` } });
    await stagehand.init();
    const page = context.pages()[0];
    const address = server.address() as { port: number };
    const attachedPage = stagehand.context.pages()[0];
    await attachedPage.goto(`http://127.0.0.1:${address.port}`);
    await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Download report" }).click()]);
    await downloads.settle(1_000);
    try {
      await attachedPage.goto(`http://127.0.0.1:${address.port}/report`);
    } catch (error) {
      assert.match(String(error), /ERR_ABORTED|download/i);
      assert.equal(downloads.snapshot().length, 2);
    }
    await downloads.close();
    await context.close();
    context = undefined;
    const saved = downloads.snapshot();
    assert.equal(saved.length, 2);
    assert(saved.every(({ status }) => status === "completed"));
    assert.equal(await readFile(path.join(workspace, saved[0].path!.slice("/workspace/".length)), "utf8"), body);
  } finally {
    await context?.close();
    await stagehand?.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
