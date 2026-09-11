export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  activity?: ToolEvent[];
};

export type ChatMemory = {
  summary: string;
  summarizedThroughMessageId: string;
  updatedAt: string;
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
  type: "tool_start" | "tool_end" | "text_delta" | "status" | "browser_frame" | "error" | "done";
  name?: string;
  data?: unknown;
};
