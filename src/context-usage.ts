import type { ContextUsage } from "./types.js";

export const compactionThresholdTokens = 18_000;
export const geminiCompactionThresholdCharacters = 60_000;

export function contextCapacity(provider: string, model: string): number | null {
  // https://developers.openai.com/api/docs/models/gpt-5.6-luna (2026-09-12)
  return provider === "openai" && model === "gpt-5.6-luna" ? 1_050_000 : null;
}

export function contextUsage(provider: string, model: string, request: unknown, reported: unknown, carriedTokens = 0): ContextUsage {
  const serialized = JSON.stringify(request ?? "");
  const hasImages = /"inlineData"|"input_image"/.test(serialized);
  const exact = typeof reported === "number" && Number.isSafeInteger(reported) && reported >= 0;
  return {
    provider, model, inputTokens: exact ? reported : hasImages ? null : Math.ceil(Buffer.byteLength(serialized) / 4) + carriedTokens,
    capacityTokens: contextCapacity(provider, model), source: exact ? "reported" : hasImages ? "unavailable" : "estimated",
    compaction: provider === "openai" ? { threshold: compactionThresholdTokens, unit: "tokens" }
      : provider === "gemini" ? { threshold: geminiCompactionThresholdCharacters, unit: "characters" } : null,
    phase: exact ? "response" : "request", capturedAt: new Date().toISOString(),
  };
}
