import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate as yieldToServer } from "node:timers/promises";
import type { ModelSelection } from "./model.js";

type Provider = ModelSelection["provider"];
type Usage = Record<string, any>;
type ModelResponse = { provider: Provider; model: string; usage: Usage | null; createdAt: string; responseId: string | null };
type ProviderTotal = {
  provider: Provider; inputTokens: number; outputTokens: number; cachedInputTokens: number; totalTokens: number;
  estimatedCostUsd: number | null; unpricedResponses: number; pricedResponses: number; responseCount: number;
  missingUsageResponses: number; since: string | null;
};

const pricing = [
  { provider: "openai", model: "gpt-5.6-luna", inputPerMillion: 0.2, cachedInputPerMillion: 0.02, outputPerMillion: 1.2,
    source: "https://developers.openai.com/api/docs/models/gpt-5.6-luna", verifiedAt: "2026-09-13",
    note: "Standard token rates. Above 272,000 input tokens: 2x input and 1.5x output. Reported cache writes cost 1.25x uncached input." },
  { provider: "gemini", model: "gemini-2.5-flash", inputPerMillion: 0.3, cachedInputPerMillion: 0.03, outputPerMillion: 2.5,
    source: "https://ai.google.dev/gemini-api/docs/pricing#gemini-2.5-flash", verifiedAt: "2026-09-13",
    note: "Standard paid-tier text/image/video rates; output includes thinking tokens. Free-tier credits and audio rates are not applied." },
] as const;

function tokens(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function responseTokens(provider: Provider, usage: Usage | null) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const input = tokens(provider === "openai" ? usage.input_tokens : usage.promptTokenCount);
  const candidates = tokens(provider === "openai" ? usage.output_tokens : usage.candidatesTokenCount);
  const thoughts = provider === "gemini" ? tokens(usage.thoughtsTokenCount ?? 0) : 0;
  const toolInput = provider === "gemini" ? tokens(usage.toolUsePromptTokenCount ?? 0) : 0;
  const cached = tokens((provider === "openai" ? usage.input_tokens_details?.cached_tokens : usage.cachedContentTokenCount) ?? 0);
  const writes = provider === "openai" ? tokens(usage.input_tokens_details?.cache_write_tokens ?? 0) : 0;
  if (input === null || candidates === null || thoughts === null || toolInput === null || cached === null || writes === null || cached + writes > input) return null;
  const total = input + toolInput + candidates + thoughts;
  const reportedTotal = provider === "openai" ? usage.total_tokens : usage.totalTokenCount;
  if (!Number.isSafeInteger(total) || (reportedTotal !== undefined && tokens(reportedTotal) !== total)) return null;
  return { input: input + toolInput, output: candidates + thoughts, cached, writes };
}

function responseCost(response: ModelResponse, counts: NonNullable<ReturnType<typeof responseTokens>>) {
  const rates = pricing.find(item => item.provider === response.provider && item.model === response.model);
  if (!rates) return null;
  const usage = response.usage!;
  if (response.provider === "gemini" && (usage.toolUsePromptTokenCount > 0
    || (Array.isArray(usage.promptTokensDetails) && usage.promptTokensDetails.some((item: any) => item?.modality === "AUDIO")))) return null;
  const long = response.provider === "openai" && counts.input > 272_000;
  const inputCost = ((counts.input - counts.cached - counts.writes) * rates.inputPerMillion
    + counts.cached * rates.cachedInputPerMillion + counts.writes * rates.inputPerMillion * 1.25) * (long ? 2 : 1);
  return (inputCost + counts.output * rates.outputPerMillion * (long ? 1.5 : 1)) / 1_000_000;
}

const historyCache = new Map<string, { signature: string; value: Awaited<ReturnType<typeof readResponses>> }>();

async function readResponses(file: string) {
  const db = new DatabaseSync(file, { readOnly: true, allowExtension: false });
  try {
    db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 200;");
    const runs = new Map<string, { provider: unknown; model: unknown }>();
    const calls = new Map<string, { provider: unknown; model: unknown }>();
    const responses = new Map<string, ModelResponse>();
    let unattributedResponses = 0;
    let scannedRows = 0;
    const rows = db.prepare(`SELECT id, run_id, kind, created_at,
      json_extract(data, '$.provider') AS provider, json_extract(data, '$.model') AS model,
      json_extract(data, '$.callId') AS call_id, json_extract(data, '$.responseId') AS response_id,
      CASE WHEN kind = 'model_end' THEN json_extract(data, '$.usage') END AS usage
      FROM events WHERE kind IN ('run_start', 'model_start', 'model_end') ORDER BY id`).iterate();
    for (const row of rows) {
      if (++scannedRows % 500 === 0) await yieldToServer();
      const runId = String(row.run_id ?? "");
      const callId = `${runId}:${row.call_id ?? row.id}`;
      if (row.kind === "run_start") { runs.set(runId, { provider: row.provider, model: row.model }); continue; }
      if (row.kind === "model_start") {
        const run = runs.get(runId);
        calls.set(callId, { provider: row.provider ?? run?.provider, model: row.model ?? run?.model });
        continue;
      }
      const model = calls.get(callId) ?? runs.get(runId);
      const provider = row.provider ?? model?.provider;
      if (provider !== "openai" && provider !== "gemini") { unattributedResponses += 1; continue; }
      responses.set(callId, { provider, model: String(row.model ?? model?.model ?? ""),
        usage: typeof row.usage === "string" ? JSON.parse(row.usage) : null,
        createdAt: String(row.created_at), responseId: typeof row.response_id === "string" ? row.response_id : null });
    }
    return { responses: [...responses.values()], unattributedResponses };
  } finally { db.close(); }
}

export async function providerUsage() {
  const providers: ProviderTotal[] = (["openai", "gemini"] as const).map(provider => ({
    provider, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0, estimatedCostUsd: 0,
    unpricedResponses: 0, pricedResponses: 0, responseCount: 0, missingUsageResponses: 0, since: null,
  }));
  let unreadableHistories = 0;
  let unattributedResponses = 0;
  const seen = new Set<string>();
  const seenFiles = new Set<string>();
  for (const area of ["sessions", "agents"]) {
    const root = path.resolve(".data", area);
    const directories = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") unreadableHistories += 1;
      return [];
    });
    for (const directory of directories) {
      if (!directory.isDirectory() || !/^[a-zA-Z0-9-]+$/.test(directory.name)) continue;
      const file = path.join(root, directory.name, "history.sqlite");
      try {
        const [databaseFile, walFile] = await Promise.all([stat(file), stat(`${file}-wal`).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        })]);
        if (!databaseFile.isFile()) continue;
        seenFiles.add(file);
        const signature = [databaseFile, walFile].map(item => item ? `${item.ino}:${item.size}:${item.mtimeMs}:${item.ctimeMs}` : "missing").join("|");
        const cached = historyCache.get(file);
        const history = cached?.signature === signature ? cached.value : await readResponses(file);
        historyCache.set(file, { signature, value: history });
        unattributedResponses += history.unattributedResponses;
        for (const response of history.responses) {
          if (response.responseId) {
            const key = `${response.provider}:${response.responseId}`;
            if (seen.has(key)) continue;
            seen.add(key);
          }
          const total = providers.find(item => item.provider === response.provider)!;
          total.responseCount += 1;
          if (!total.since || response.createdAt < total.since) total.since = response.createdAt;
          const counts = responseTokens(response.provider, response.usage);
          if (!counts) {
            total.missingUsageResponses += 1;
            total.unpricedResponses += 1;
            continue;
          }
          total.inputTokens += counts.input;
          total.outputTokens += counts.output;
          total.cachedInputTokens += counts.cached;
          total.totalTokens += counts.input + counts.output;
          const cost = responseCost(response, counts);
          if (cost === null) total.unpricedResponses += 1;
          else { total.pricedResponses += 1; total.estimatedCostUsd! += cost; }
        }
      } catch (error) {
        historyCache.delete(file);
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") unreadableHistories += 1;
      }
    }
  }
  for (const file of historyCache.keys()) if (!seenFiles.has(file)) historyCache.delete(file);
  for (const total of providers) {
    if (total.unpricedResponses && !total.pricedResponses) total.estimatedCostUsd = null;
    else total.estimatedCostUsd = Number(total.estimatedCostUsd!.toFixed(8));
  }
  return { providers, capturedAt: new Date().toISOString(), unreadableHistories, unattributedResponses, pricing,
    coverage: "Saved usage across all chats and workers, including memory and compaction. Dollar amounts estimate standard paid rates and exclude browser/audio calls and missing records.",
    coverageDetails: {
      tokens: "Input includes cached tokens and reported tool prompt tokens. Output includes reported reasoning tokens. Context estimates and cumulative run totals are not added.",
      freshness: "Completed model responses appear during live runs. Unchanged history files are cached; SQLite and WAL changes invalidate the cache.",
      pricing: "Published standard paid rates are applied to retained responses. These are estimates, not provider bills; free-tier credits, discounts, service-tier differences and taxes are not applied.",
      excluded: ["Browser-agent model calls", "Audio transcription", "External script model calls", "Provider tool and cache storage fees", "Deleted or missing audits", "Unfinished calls without final usage"],
      incomplete: "Unknown models, unsupported usage types, missing usage or unreadable histories produce partial totals. Unattributed responses cannot be assigned to a provider.",
      retention: "Archived chat audits remain included. Permanently deleting chats or workers removes their usage from these retained totals.",
    } };
}
