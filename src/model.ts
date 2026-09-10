export function getModelConfig(requireApiKey = false) {
  const provider = process.env.MODEL_PROVIDER?.trim().toLowerCase()
    || (process.env.GEMINI_API_KEY?.trim() && !process.env.OPENAI_API_KEY?.trim() ? "gemini" : "openai");
  if (provider !== "openai" && provider !== "gemini") {
    throw new Error("MODEL_PROVIDER must be openai or gemini.");
  }

  const keyName = provider === "gemini" ? "GEMINI_API_KEY" : "OPENAI_API_KEY";
  const apiKey = process.env[keyName]?.trim();
  if (requireApiKey && !apiKey) {
    throw new Error(`${keyName} is missing. Add it to .env before running the agent.`);
  }
  const model = provider === "gemini"
    ? process.env.GEMINI_MODEL?.trim() || "gemini-2.5-flash"
    : process.env.OPENAI_MODEL?.trim() || "gpt-5.6-luna";
  return { provider, model, apiKey };
}
