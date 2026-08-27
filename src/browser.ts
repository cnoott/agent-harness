import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ensureBinary, getDefaultStealthArgs } from "cloakbrowser";
import { workspacePath } from "./store.js";

type BrowserTool = "browser_open" | "browser_observe" | "browser_act" | "browser_extract" | "browser_screenshot";
type BrowserControlAction =
  | { type: "click"; x: number; y: number }
  | { type: "scroll"; x: number; y: number; deltaX: number; deltaY: number }
  | { type: "type"; text: string }
  | { type: "key"; key: string }
  | { type: "back" };

export type BrowserPreview = { image: string; title: string; url: string; capturedAt: string };
type BrowserSession = { stagehand: any; page: any; previewTimer?: NodeJS.Timeout; previewInFlight?: boolean };
const sessions = new Map<string, BrowserSession>();
const previewListeners = new Map<string, Set<(preview: BrowserPreview) => void>>();

async function publishPreview(chatId: string) {
  const session = sessions.get(chatId);
  const listeners = previewListeners.get(chatId);
  if (!session || !listeners?.size || session.previewInFlight) return;
  session.previewInFlight = true;
  try {
    const image = await session.page.screenshot({ type: "jpeg", quality: 60, scale: "css" });
    const preview = {
      image: `data:image/jpeg;base64,${image.toString("base64")}`,
      title: await session.page.title(),
      url: session.page.url(),
      capturedAt: new Date().toISOString(),
    };
    for (const listener of listeners) listener(preview);
  } catch {
    // A transient navigation or page close should not interrupt the agent run.
  } finally {
    session.previewInFlight = false;
  }
}

function startPreviewTimer(chatId: string, session: BrowserSession) {
  if (session.previewTimer) return;
  session.previewTimer = setInterval(() => void publishPreview(chatId), 1_250);
  void publishPreview(chatId);
}

export function subscribeBrowserPreview(chatId: string, listener: (preview: BrowserPreview) => void) {
  const listeners = previewListeners.get(chatId) ?? new Set();
  listeners.add(listener);
  previewListeners.set(chatId, listeners);
  const session = sessions.get(chatId);
  if (session) startPreviewTimer(chatId, session);
  return () => {
    const activeListeners = previewListeners.get(chatId);
    if (!activeListeners) return;
    activeListeners.delete(listener);
    if (activeListeners.size) return;
    previewListeners.delete(chatId);
    const activeSession = sessions.get(chatId);
    if (activeSession?.previewTimer) clearInterval(activeSession.previewTimer);
    if (activeSession) activeSession.previewTimer = undefined;
  };
}

async function readPage(page: any, mode: "content" | "actions") {
  const expression = mode === "content"
    ? `(() => JSON.stringify({
        text: (document.body?.innerText || "").slice(0, 80000),
        links: Array.from(document.querySelectorAll("a[href]")).slice(0, 80).map((a) => ({ text: (a.innerText || a.getAttribute("aria-label") || "").trim().slice(0, 300), href: a.href }))
      }))()`
    : `(() => JSON.stringify(Array.from(document.querySelectorAll("a, button, input, select, textarea")).slice(0, 100).map((el) => ({
        tag: el.tagName.toLowerCase(),
        text: (el.innerText || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "").trim().slice(0, 200),
        href: el instanceof HTMLAnchorElement ? el.href : undefined,
        type: el.getAttribute("type")
      }))))()`;
  const response = await page.sendCDP("Runtime.evaluate", { expression, returnByValue: true });
  const value = response?.result?.value;
  return typeof value === "string" ? JSON.parse(value) : value;
}

async function getBrowser(chatId: string): Promise<BrowserSession> {
  const existing = sessions.get(chatId);
  if (existing) return existing;

  const { Stagehand } = await import("@browserbasehq/stagehand");
  const executablePath = await ensureBinary();
  const stagehand = new (Stagehand as any)({
    env: "LOCAL",
    headless: true,
    modelName: process.env.OPENAI_MODEL || "gpt-5.6-luna",
    localBrowserLaunchOptions: {
      executablePath,
      args: getDefaultStealthArgs(),
      headless: true,
    },
  });
  await stagehand.init();
  const page = stagehand.page ?? stagehand.context.pages()[0];
  const session = { stagehand, page };
  sessions.set(chatId, session);
  if (previewListeners.get(chatId)?.size) startPreviewTimer(chatId, session);
  return session;
}

export async function runBrowserTool(chatId: string, name: BrowserTool, args: Record<string, unknown>) {
  const { page, stagehand } = await getBrowser(chatId);
  if (name === "browser_open") {
    await page.goto(String(args.url), { waitUntil: "domcontentloaded" });
    await publishPreview(chatId);
    return { url: page.url(), title: await page.title() };
  }
  // Keep page reading deterministic. Stagehand's AI extraction builds full
  // accessibility snapshots, which is needlessly expensive for a general
  // browsing tool and can exceed a low-rate-limit account's token budget.
  if (name === "browser_observe") return { instruction: String(args.instruction), actions: await readPage(page, "actions") };
  if (name === "browser_act") {
    const result = await stagehand.act(String(args.instruction));
    await publishPreview(chatId);
    return result;
  }
  if (name === "browser_extract") return { instruction: String(args.instruction), url: page.url(), title: await page.title(), ...(await readPage(page, "content")) };
  const screenshots = path.join(workspacePath(chatId), ".harness", "screenshots");
  await mkdir(screenshots, { recursive: true });
  const filename = `${randomUUID()}.png`;
  const image = await page.screenshot({ fullPage: true });
  await writeFile(path.join(screenshots, filename), image);
  await publishPreview(chatId);
  return {
    url: page.url(),
    title: await page.title(),
    screenshot: `/workspace/.harness/screenshots/${filename}`,
    note: "Screenshot saved in the workspace. Use browser_extract for page content rather than passing image data through context.",
  };
}

export async function controlBrowser(chatId: string, action: BrowserControlAction) {
  const session = sessions.get(chatId);
  if (!session) throw new Error("Open a page with the agent before taking manual browser control.");
  const { page } = session;
  if (action.type === "click") await page.click(action.x, action.y);
  if (action.type === "scroll") await page.scroll(action.x, action.y, action.deltaX, action.deltaY);
  if (action.type === "type") await page.type(action.text, { delay: 20 });
  if (action.type === "key") await page.keyPress(action.key);
  if (action.type === "back") await page.goBack({ waitUntil: "domcontentloaded" });
  await publishPreview(chatId);
  return { url: page.url(), title: await page.title() };
}

export async function closeBrowser(chatId: string) {
  const browser = sessions.get(chatId);
  if (!browser) return;
  if (browser.previewTimer) clearInterval(browser.previewTimer);
  await browser.stagehand.close();
  sessions.delete(chatId);
}
