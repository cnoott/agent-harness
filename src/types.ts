export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  activity?: ToolEvent[];
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
  workspaceId?: string;
  workspaceName?: string;
  createdAt: string;
  lastResponseId?: string;
  memory?: ChatMemory;
  messages: ChatMessage[];
};

export type ToolEvent = {
  type: "tool_start" | "tool_end" | "text_delta" | "status" | "browser_frame" | "error" | "done" | "agent_update";
  name?: string;
  data?: unknown;
};
