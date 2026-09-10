import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { launchPersistentContext } from "cloakbrowser";
import { workspacePath } from "./store.js";
import { getModelConfig } from "./model.js";

type BrowserTool = "browser_open" | "browser_observe" | "browser_act" | "browser_extract" | "browser_screenshot";
type BrowserControlAction =
  | { type: "click"; x: number; y: number }
  | { type: "scroll"; x: number; y: number; deltaX: number; deltaY: number }
  | { type: "type"; text: string }
  | { type: "key"; key: string }
  | { type: "back" };

export type BrowserPreview = { image: string; title: string; url: string; capturedAt: string };
type BrowserSession = {
  stagehand: any;
  browserContext: Awaited<ReturnType<typeof launchPersistentContext>>;
  page: any;
  previewTimer?: NodeJS.Timeout;
  previewInFlight?: boolean;
  failedAction?: { instruction: string; pageState: string };
};
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
    : `(() => {
        const isVisible = (el) => {
          if (el.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
          if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
          const bounds = el.getBoundingClientRect();
          return bounds.width > 0 && bounds.height > 0;
        };
        const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
        let text = "";
        let node;
        while (text.length < 4000 && (node = walker.nextNode())) {
          if (node.parentElement && isVisible(node.parentElement) && node.textContent.trim()) {
            text += node.textContent.trim() + "\\n";
          }
        }
        return JSON.stringify({
          title: document.title,
          url: location.href,
          text: text.slice(0, 4000),
          actions: Array.from(document.querySelectorAll("a, button, input, select, textarea"))
            .filter(isVisible)
            .slice(0, 100)
            .map((el) => ({
              tag: el.tagName.toLowerCase(),
              text: (el.innerText || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "").trim().slice(0, 200),
              href: el instanceof HTMLAnchorElement ? el.href : undefined,
              type: el.getAttribute("type")
            }))
        });
      })()`;
  const response = await page.sendCDP("Runtime.evaluate", { expression, returnByValue: true });
  if (response?.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || "Failed to read browser page.");
  }
  const value = response?.result?.value;
  if (typeof value !== "string") throw new Error("Browser page observation did not return JSON.");
  return JSON.parse(value);
}

async function getBrowser(chatId: string): Promise<BrowserSession> {
  const existing = sessions.get(chatId);
  if (existing) return existing;

  const { provider, model, apiKey } = getModelConfig(true);
  const { Stagehand } = await import("@browserbasehq/stagehand");
  const userDataDir = path.join(workspacePath(chatId), "..", "browser-profile");
  await mkdir(userDataDir, { recursive: true, mode: 0o700 });
  const browserContext = await launchPersistentContext({
    userDataDir,
    headless: false,
    viewport: { width: 1288, height: 711 },
    args: ["--remote-debugging-port=0"],
  });
  let stagehand: any;
  try {
    const [port, browserPath] = (await readFile(path.join(userDataDir, "DevToolsActivePort"), "utf8")).trim().split(/\r?\n/);
    stagehand = new (Stagehand as any)({
      env: "LOCAL",
      headless: false,
      model: { modelName: `${provider === "gemini" ? "google" : "openai"}/${model}`, apiKey },
      localBrowserLaunchOptions: { cdpUrl: `ws://127.0.0.1:${port}${browserPath}` },
    });
    await stagehand.init();
  } catch (error) {
    await Promise.allSettled([browserContext.close(), stagehand?.close()]);
    throw error;
  }
  const page = stagehand.page ?? stagehand.context.pages()[0];
  const session: BrowserSession = { stagehand, browserContext, page };
  sessions.set(chatId, session);
  browserContext.on("close", () => {
    if (session.previewTimer) clearInterval(session.previewTimer);
    if (sessions.get(chatId) === session) sessions.delete(chatId);
    void stagehand.close().catch(() => {});
  });
  if (previewListeners.get(chatId)?.size) startPreviewTimer(chatId, session);
  return session;
}

async function captureScreenshot(chatId: string, page: any) {
  const screenshots = path.join(workspacePath(chatId), ".harness", "screenshots");
  await mkdir(screenshots, { recursive: true });
  const filename = `${randomUUID()}.png`;
  const image = await page.screenshot({ type: "png", fullPage: false, scale: "css" });
  await writeFile(path.join(screenshots, filename), image);
  return {
    url: page.url(),
    title: await page.title(),
    screenshot: `/workspace/.harness/screenshots/${filename}`,
    capturedAt: new Date().toISOString(),
    modelImage: { mimeType: "image/png", data: image.toString("base64") },
    note: "Current viewport screenshot attached for visual inspection and saved in the workspace. Use browser_extract for longer page content.",
  };
}

export async function runBrowserTool(chatId: string, name: BrowserTool, args: Record<string, unknown>) {
  const session = await getBrowser(chatId);
  const { page, stagehand } = session;
  if (name === "browser_open") {
    await page.goto(String(args.url), { waitUntil: "domcontentloaded" });
    session.failedAction = undefined;
    await publishPreview(chatId);
    return { url: page.url(), title: await page.title() };
  }
  // Keep page reading deterministic. Stagehand's AI extraction builds full
  // accessibility snapshots, which is needlessly expensive for a general
  // browsing tool and can exceed a low-rate-limit account's token budget.
  if (name === "browser_observe") {
    const observation = await readPage(page, "actions");
    session.failedAction = undefined;
    return { instruction: String(args.instruction), ...observation };
  }
  if (name === "browser_act") {
    const instruction = String(args.instruction).trim();
    if (session.failedAction?.instruction === instruction) {
      const observation = await readPage(page, "actions");
      if (session.failedAction.pageState === JSON.stringify(observation)) {
        return {
          success: false,
          retryBlocked: true,
          message: "This action already failed on the unchanged page. It was not executed again.",
          observation,
          recovery: "Use the fresh observation or request a screenshot to choose a different action. After manual changes, call browser_observe before retrying.",
        };
      }
    }
    session.failedAction = undefined;
    let result: any;
    let actionFailed = false;
    try {
      result = await stagehand.act(instruction, { page });
      actionFailed = result.success === false;
    } catch (error) {
      result = { success: false, message: error instanceof Error ? error.message : String(error), actions: [] };
    }
    await publishPreview(chatId);
    if (result.success === false) {
      result.recovery = actionFailed
        ? "Inspect the fresh observation and screenshot before choosing a different action. A failed click does not prove a popup or login wall exists. Do not repeat or rephrase the same failed click on an unchanged page."
        : "The browser action raised an error. Inspect the fresh observation and screenshot before deciding whether retrying is appropriate.";
      try {
        result.observation = await readPage(page, "actions");
        if (actionFailed) session.failedAction = { instruction, pageState: JSON.stringify(result.observation) };
      } catch (error) {
        result.observationError = error instanceof Error ? error.message : String(error);
      }
      try {
        Object.assign(result, await captureScreenshot(chatId, page));
      } catch (error) {
        result.screenshotError = error instanceof Error ? error.message : String(error);
      }
    }
    return result;
  }
  if (name === "browser_extract") return { instruction: String(args.instruction), url: page.url(), title: await page.title(), ...(await readPage(page, "content")) };
  const screenshot = await captureScreenshot(chatId, page);
  await publishPreview(chatId);
  return screenshot;
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
  session.failedAction = undefined;
  await publishPreview(chatId);
  return { url: page.url(), title: await page.title() };
}

export async function closeBrowser(chatId: string) {
  const browser = sessions.get(chatId);
  if (!browser) return;
  if (browser.previewTimer) clearInterval(browser.previewTimer);
  try {
    await browser.browserContext.close();
  } finally {
    await browser.stagehand.close();
    if (sessions.get(chatId) === browser) sessions.delete(chatId);
  }
}
