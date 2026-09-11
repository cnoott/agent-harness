export type ModelSelection = { provider: "openai" | "gemini"; model: string };

export function getModelConfig(requireApiKey = false, selection?: ModelSelection) {
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
