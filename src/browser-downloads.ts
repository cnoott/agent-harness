import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, mkdtemp, open, realpath, rm } from "node:fs/promises";
import path from "node:path";
import type { BrowserContext, Download, Page } from "playwright-core";

export type BrowserDownload = {
  id: string;
  status: "pending" | "completed" | "failed" | "interrupted";
  filename: string;
  path?: string;
  error?: string;
};

type PendingDownload = { download: Download; result: BrowserDownload; done: Promise<void> };

function filenameFor(value: string) {
  const cleaned = value.replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, "_").replace(/^\.+/, "").trim();
  let filename = "";
  for (const character of cleaned) {
    if (Buffer.byteLength(filename + character) > 160) break;
    filename += character;
  }
  return filename || "download";
}

async function waitFor(promise: Promise<unknown>, timeoutMs: number) {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([promise, new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class BrowserDownloads {
  private pending = new Map<string, PendingDownload>();
  private recent: BrowserDownload[] = [];
  private closing = false;
  private pages = new WeakSet<Page>();

  constructor(private workspace: string, context: BrowserContext) {
    context.on("page", this.registerPage);
    for (const page of context.pages()) this.registerPage(page);
    context.on("close", () => { void this.interrupt("Browser closed before the download was saved."); });
  }

  private registerPage = (page: Page) => {
    if (this.pages.has(page)) return;
    this.pages.add(page);
    page.on("download", this.capture);
  };

  private capture = (download: Download) => {
    const result: BrowserDownload = { id: randomUUID(), filename: filenameFor(download.suggestedFilename()), status: "pending" };
    const pending: PendingDownload = { download, result, done: Promise.resolve() };
    this.pending.set(result.id, pending);
    if (this.closing) {
      result.status = "interrupted";
      result.error = "Browser is closing; the download was not saved.";
    }
    pending.done = this.persist(pending).finally(() => {
      this.pending.delete(result.id);
      this.recent.push({ ...result });
      if (this.recent.length > 20) this.recent.shift();
    });
  };

  private async persist(pending: PendingDownload) {
    let staging: string | undefined;
    let destination: string | undefined;
    let published = false;
    const { download, result } = pending;
    try {
      if (result.status === "interrupted") {
        await download.cancel();
        return;
      }
      const root = await realpath(this.workspace);
      // Staging stays on the workspace volume, outside the Files listing.
      staging = await mkdtemp(path.join(path.dirname(root), ".browser-download-"));
      const temporary = path.join(staging, "artifact.part");
      await download.saveAs(temporary);
      const failure = await download.failure();
      if (failure) throw new Error(failure);
      const handle = await open(temporary, "r+");
      try { await handle.sync(); } finally { await handle.close(); }
      const directory = path.join(root, "downloads");
      await mkdir(directory, { recursive: true });
      if ((await lstat(directory)).isSymbolicLink() || await realpath(directory) !== directory) {
        throw new Error("Download directory must be a directory inside the workspace, without symlinks.");
      }
      if (pending.result.status !== "pending") return;
      const filename = `${result.id}-${result.filename}`;
      destination = path.join(directory, filename);
      await link(temporary, destination);
      published = true;
      if (pending.result.status !== "pending") {
        await rm(destination, { force: true });
        return;
      }
      result.status = "completed";
      result.path = `/workspace/downloads/${filename}`;
    } catch (error) {
      if (result.status !== "interrupted") {
        result.status = "failed";
        result.error = error instanceof Error ? error.message : String(error);
      }
      if (published && destination) await rm(destination, { force: true }).catch(() => {});
    } finally {
      if (staging) await rm(staging, { recursive: true, force: true }).catch(() => {});
    }
  }

  snapshot(): BrowserDownload[] {
    return [...this.recent, ...Array.from(this.pending.values(), ({ result }) => result)].map((result) => ({ ...result }));
  }

  async settle(timeoutMs = 250) {
    await waitFor(Promise.allSettled(Array.from(this.pending.values(), ({ done }) => done)), timeoutMs);
  }

  async interrupt(reason: string) {
    this.closing = true;
    await Promise.allSettled(Array.from(this.pending.values(), ({ download, result }) => {
      if (result.status !== "pending") return Promise.resolve();
      result.status = "interrupted";
      result.error = reason;
      return download.cancel();
    }));
  }

  async close(timeoutMs = 5_000) {
    this.closing = true;
    const cancellationMs = Math.min(1_000, timeoutMs / 5);
    await this.settle(Math.max(0, timeoutMs - cancellationMs));
    if (!this.pending.size) return;
    await waitFor(this.interrupt("Download interrupted by browser shutdown before it was saved."), cancellationMs / 2);
    await this.settle(cancellationMs / 2);
  }
}
