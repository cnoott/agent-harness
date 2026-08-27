import OpenAI from "openai";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { execute } from "./sandbox.js";
import { runBrowserTool, subscribeBrowserPreview } from "./browser.js";
import { workspacePath } from "./store.js";
import type { ChatSession, ToolEvent } from "./types.js";

const instructions = [
  "You are a capable general-purpose agent.",
  "Work toward the user's goal using the available browser, command execution, and filesystem tools.",
  "You may inspect data, write code, execute it, browse the web, and iterate on your work.",
  "The workspace persists across turns, so inspect and build on existing work when useful.",
  "You may create and use SQLite databases anywhere in /workspace when structured persistent data is useful; choose the schema that fits the task.",
  "For large data or command output, save it in the workspace and inspect focused excerpts instead of dumping it into the conversation.",
  "Return a useful result and relevant artifacts when you are done.",
].join(" ");

const maxRecentHistoryMessages = 6;
const maxMessageCharacters = 4_000;
const maxSummaryCharacters = 6_000;
const summaryRefreshMessageCount = 4;
const maxToolResultCharacters = 8_000;
const compactionThresholdTokens = 18_000;

function truncate(text: string, maxCharacters: number) {
  if (text.length <= maxCharacters) return text;
  const head = Math.floor(maxCharacters * 0.72);
  const tail = maxCharacters - head;
  return `${text.slice(0, head)}\n\n… [${text.length - maxCharacters} characters omitted] …\n\n${text.slice(-tail)}`;
}

function buildTurnContext(session: ChatSession, userText: string) {
  const priorMessages = session.messages.slice(0, -1).slice(-maxRecentHistoryMessages);
  const history = priorMessages.map((message) => `${message.role.toUpperCase()}:\n${truncate(message.text, maxMessageCharacters)}`).join("\n\n");
  const pendingMessages = session.memory ? messagesNeedingSummary(session) : [];
  const pendingHistory = pendingMessages.map((message) => `${message.role.toUpperCase()}:\n${truncate(message.text, maxMessageCharacters)}`).join("\n\n");
  return [
    "This is a new agent turn. Earlier tool traces are intentionally not included; inspect the persistent /workspace when details are needed.",
    session.memory ? `Durable memory from earlier turns:\n${truncate(session.memory.summary, maxSummaryCharacters)}` : "No durable memory yet.",
    pendingHistory ? `Conversation material awaiting the next memory refresh:\n${pendingHistory}` : "No pending conversation material.",
    history ? `Recent conversation:\n${history}` : "No earlier conversation.",
    `Current user goal:\n${userText}`,
  ].join("\n\n");
}

function messagesNeedingSummary(session: ChatSession) {
  const olderMessages = session.messages.slice(0, Math.max(0, session.messages.length - maxRecentHistoryMessages));
  if (!olderMessages.length) return [];

  const summarizedAt = session.memory
    ? olderMessages.findIndex((message) => message.id === session.memory?.summarizedThroughMessageId)
    : -1;
  if (session.memory && summarizedAt === -1) return olderMessages;
  return olderMessages.slice(summarizedAt + 1);
}

async function compactToolResult(chatId: string, callId: string, result: unknown) {
  const serialized = JSON.stringify(result, null, 2);
  if (serialized.length <= maxToolResultCharacters) return result;

  const logDirectory = path.join(workspacePath(chatId), ".harness", "tool-results");
  await mkdir(logDirectory, { recursive: true });
  const filename = `${callId.replaceAll(/[^a-zA-Z0-9_-]/g, "_")}.json`;
  const workspaceFile = path.join(logDirectory, filename);
  await writeFile(workspaceFile, serialized);
  return {
    truncated: true,
    originalCharacters: serialized.length,
    fullResult: `/workspace/.harness/tool-results/${filename}`,
    preview: truncate(serialized, maxToolResultCharacters),
    note: "The complete tool result was saved in the workspace. Inspect that file with focused commands if you need more detail.",
  };
}

const tools: any[] = [
  {
    type: "function",
    name: "exec",
    description: "Execute a shell command inside the persistent Docker workspace at /workspace. Use this to inspect files, write code, install packages, run analyses, and test work.",
    strict: true,
    parameters: { type: "object", additionalProperties: false, properties: { command: { type: "string" } }, required: ["command"] },
  },
  {
    type: "function",
    name: "browser_open",
    description: "Open a URL in the current browser tab.",
    strict: true,
    parameters: { type: "object", additionalProperties: false, properties: { url: { type: "string" } }, required: ["url"] },
  },
  {
    type: "function",
    name: "browser_observe",
    description: "Inspect the current page and return candidate actions relevant to an instruction.",
    strict: true,
    parameters: { type: "object", additionalProperties: false, properties: { instruction: { type: "string" } }, required: ["instruction"] },
  },
  {
    type: "function",
    name: "browser_act",
    description: "Perform a single natural-language action in the current browser page, such as clicking, filling, scrolling, or selecting.",
    strict: true,
    parameters: { type: "object", additionalProperties: false, properties: { instruction: { type: "string" } }, required: ["instruction"] },
  },
  {
    type: "function",
    name: "browser_extract",
    description: "Extract requested information from the current browser page.",
    strict: true,
    parameters: { type: "object", additionalProperties: false, properties: { instruction: { type: "string" } }, required: ["instruction"] },
  },
  {
    type: "function",
    name: "browser_screenshot",
    description: "Capture a screenshot of the current browser page.",
    strict: true,
    parameters: { type: "object", additionalProperties: false, properties: {}, required: [] },
  },
];

export type RunControl = { cancelled: boolean };
export type Emit = (event: ToolEvent) => void;

function rateLimitDelayMs(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const seconds = /try again in\s+(\d+)s/i.exec(message)?.[1];
  if (seconds) return (Number(seconds) + 1) * 1_000;
  const status = (error as any)?.status;
  return status === 429 || /rate limit/i.test(message) ? 20_000 : null;
}

async function waitForRateLimit(delayMs: number, control: RunControl) {
  let remaining = delayMs;
  while (remaining > 0 && !control.cancelled) {
    const interval = Math.min(1_000, remaining);
    await new Promise((resolve) => setTimeout(resolve, interval));
    remaining -= interval;
  }
}

async function refreshMemoryIfNeeded(client: OpenAI, model: string, session: ChatSession, control: RunControl, emit: Emit) {
  const newMessages = messagesNeedingSummary(session);
  if (!newMessages.length) return;
  if (session.memory && newMessages.length < summaryRefreshMessageCount) return;

  emit({ type: "status", data: { message: "Compacting earlier conversation into durable memory." } });
  const transcript = newMessages.map((message) => `${message.role.toUpperCase()}:\n${truncate(message.text, maxMessageCharacters)}`).join("\n\n");
  const input = [
    "Update a durable memory for a long-running agent chat.",
    "Preserve only user goals, constraints, decisions, verified findings, exact source URLs, artifact paths, unresolved work, and current state.",
    "Do not invent facts. Do not retain conversational filler or raw tool traces. Return plain concise memory, at most 6000 characters.",
    session.memory ? `Existing memory:\n${session.memory.summary}` : "No existing memory.",
    `New conversation material:\n${transcript}`,
  ].join("\n\n");

  while (!control.cancelled) {
    try {
      const response: any = await client.responses.create({
        model,
        input,
        store: true,
        reasoning: { effort: "low" },
        text: { verbosity: "low" },
      } as any);
      const summary = truncate(String(response.output_text || "").trim(), maxSummaryCharacters);
      if (summary) {
        session.memory = {
          summary,
          summarizedThroughMessageId: newMessages.at(-1)!.id,
          updatedAt: new Date().toISOString(),
        };
      }
      return;
    } catch (error) {
      const delayMs = rateLimitDelayMs(error);
      if (!delayMs) {
        emit({ type: "status", data: { message: "Could not refresh durable memory; continuing with recent conversation." } });
        return;
      }
      emit({ type: "status", data: { message: "Model rate limit reached while compacting memory; waiting before continuing.", retryInSeconds: Math.ceil(delayMs / 1_000) } });
      await waitForRateLimit(delayMs, control);
    }
  }
}

async function callTool(chatId: string, name: string, args: Record<string, unknown>) {
  if (name === "exec") return execute(chatId, String(args.command));
  if (name.startsWith("browser_")) return runBrowserTool(chatId, name as any, args);
  throw new Error(`Unknown tool: ${name}`);
}

export async function runAgent(session: ChatSession, userText: string, emit: Emit, control: RunControl) {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is missing. Add it to .env before running the agent.");
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const model = process.env.OPENAI_MODEL || "gpt-5.6-luna";
  await refreshMemoryIfNeeded(client, model, session, control, emit);
  if (control.cancelled) return "Run stopped.";
  // Each user turn starts a fresh Responses chain. This prevents one oversized
  // browser or terminal result from becoming permanent context for the chat.
  let previousResponseId: string | undefined;
  let input: any = buildTurnContext(session, userText);
  let finalText = "";
  const unsubscribePreview = subscribeBrowserPreview(session.id, (preview) => emit({ type: "browser_frame", data: preview }));

  try {
  while (!control.cancelled) {
    let stream: any;
    while (!control.cancelled) {
      try {
        stream = await client.responses.create({
          model,
          instructions,
          tools,
          tool_choice: "auto",
          parallel_tool_calls: false,
          store: true,
          context_management: [{ type: "compaction", compact_threshold: compactionThresholdTokens }],
          ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
          input,
          stream: true,
        } as any);
        break;
      } catch (error) {
        const delayMs = rateLimitDelayMs(error);
        if (!delayMs) throw error;
        emit({ type: "status", data: { message: "Model rate limit reached; waiting before continuing.", retryInSeconds: Math.ceil(delayMs / 1_000) } });
        await waitForRateLimit(delayMs, control);
      }
    }
    if (control.cancelled || !stream) break;

    let response: any;
    for await (const event of stream as any) {
      if (control.cancelled) break;
      if (event.type === "response.output_text.delta") {
        finalText += event.delta;
        emit({ type: "text_delta", data: event.delta });
      }
      if (event.type === "response.completed") response = event.response;
      if (event.type === "response.failed") throw new Error(event.response?.error?.message || "OpenAI response failed");
    }

    if (control.cancelled) break;
    if (!response) throw new Error("Response ended before completion");
    previousResponseId = response.id;
    const calls = response.output.filter((item: any) => item.type === "function_call");
    if (calls.length === 0) {
      return finalText || response.output_text || "";
    }

    const outputs: any[] = [];
    for (const call of calls) {
      if (control.cancelled) break;
      const args = JSON.parse(call.arguments || "{}");
      emit({ type: "tool_start", name: call.name, data: args });
      try {
        const result = await callTool(session.id, call.name, args);
        const compactResult = await compactToolResult(session.id, call.call_id, result);
        emit({ type: "tool_end", name: call.name, data: compactResult });
        outputs.push({ type: "function_call_output", call_id: call.call_id, output: JSON.stringify(compactResult) });
      } catch (error) {
        const result = { error: error instanceof Error ? error.message : String(error) };
        emit({ type: "tool_end", name: call.name, data: result });
        outputs.push({ type: "function_call_output", call_id: call.call_id, output: JSON.stringify(result) });
      }
    }
    input = outputs;
  }

  return finalText || "Run stopped.";
  } finally {
    unsubscribePreview();
  }
}
