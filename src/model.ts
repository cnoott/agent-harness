export type ModelSelection = { provider: "openai" | "gemini"; model: string };

export function getModelConfig(requireApiKey = false, selection?: ModelSelection): ModelSelection & { apiKey: string | undefined } {
  const provider = selection?.provider || process.env.MODEL_PROVIDER?.trim().toLowerCase()
    || (process.env.GEMINI_API_KEY?.trim() && !process.env.OPENAI_API_KEY?.trim() ? "gemini" : "openai");
  if (provider !== "openai" && provider !== "gemini") {
    throw new Error("MODEL_PROVIDER must be openai or gemini.");
  }

  const keyName = provider === "gemini" ? "GEMINI_API_KEY" : "OPENAI_API_KEY";
  const apiKey = process.env[keyName]?.trim();
  if (requireApiKey && !apiKey) {
    throw new Error(`${keyName} is missing. Add it to .env before running the agent.`);
  }
  const model = selection?.model || (provider === "gemini"
    ? process.env.GEMINI_MODEL?.trim() || "gemini-2.5-flash"
    : process.env.OPENAI_MODEL?.trim() || "gpt-5.6-luna");
  return { provider, model, apiKey };
}

export function availableModels(): ModelSelection[] {
  return (["openai", "gemini"] as const).flatMap((provider) => {
    if (!process.env[provider === "openai" ? "OPENAI_API_KEY" : "GEMINI_API_KEY"]?.trim()) return [];
    const configured = process.env[provider === "openai" ? "OPENAI_SUBAGENT_MODELS" : "GEMINI_SUBAGENT_MODELS"];
    const fallback = provider === "openai" ? process.env.OPENAI_MODEL || "gpt-5.6-luna" : process.env.GEMINI_MODEL || "gemini-2.5-flash";
    return [...new Set((configured || fallback).split(",").map((model) => model.trim()).filter(Boolean))].map((model) => ({ provider, model }));
  });
}

export function chatModel(selection?: ModelSelection): ModelSelection {
  const { provider, model } = getModelConfig(false, selection);
  return { provider, model };
}

export function availableChatModels(): ModelSelection[] {
  const primary = (["openai", "gemini"] as const).flatMap((provider) => {
    const config = getModelConfig(false, { provider, model: "" });
    return config.apiKey ? [{ provider, model: config.model }] : [];
  });
  return [...primary, ...availableModels()].filter((item, index, all) =>
    all.findIndex(candidate => candidate.provider === item.provider && candidate.model === item.model) === index);
}

export function selectChatModel(value: unknown): ModelSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Choose a configured provider and model.");
  const { provider, model } = value as Record<string, unknown>;
  const selection = availableChatModels().find(candidate => candidate.provider === provider && candidate.model === model);
  if (!selection) throw new Error("This model is not configured. Choose an available model with a configured API key.");
  return selection;
}
