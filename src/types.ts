import type { ModelSelection } from "./model.js";

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  activity?: ToolEvent[];
  contextUsage?: ContextUsage;
  model?: ModelSelection;
};

export type ChatMemory = {
  summary: string;
  summarizedThroughMessageId?: string;
  updatedAt: string;
  cursor?: HistoryCursor;
  state?: TaskState;
};

export type HistoryCursor = { eventId: number; offset: number };

export type TaskState = {
  goal: string;
  constraints: string[];
  decisions: string[];
  findings: string[];
  completed: string[];
  pending: string[];
};

export type ChatSession = {
  id: string;
  archivedAt?: string;
  workspaceId?: string;
  workspaceName?: string;
  model?: ModelSelection;
  createdAt: string;
  lastResponseId?: string;
  memory?: ChatMemory;
  messages: ChatMessage[];
};

export type ToolEvent = {
  type: "context_usage" | "tool_start" | "tool_end" | "text_delta" | "status" | "browser_frame" | "error" | "done" | "agent_update";
  name?: string;
  callId?: string;
  status?: "completed" | "failed" | "interrupted";
  durationMs?: number;
  data?: unknown;
};

export type ContextUsage = {
  provider: string;
  model: string;
  inputTokens: number | null;
  capacityTokens: number | null;
  compaction?: { threshold: number; unit: "tokens" | "characters" } | null;
  source: "estimated" | "reported" | "unavailable";
  phase: "request" | "response" | "compacting";
  capturedAt: string;
};
