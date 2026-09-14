import { recordHistory, withHistory } from "./history.js";

export class AuditPersistenceError extends Error {}

export function redactAudit(value: unknown): unknown {
  const secrets = Object.entries(process.env).filter(([key, value]) => /key|token|secret|password|credential/i.test(key) && value && value.length >= 8).map(([, value]) => value!);
  const clean = (item: unknown, key = ""): unknown => {
    if (/^(authorization|proxy-authorization|cookie|set-cookie|password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|client[_-]?secret)$/i.test(key)) return "[redacted]";
    if (key === "modelImage" || key === "inlineData") return { omitted: "Binary image; see the tool screenshot path", mimeType: (item as any)?.mimeType };
    if (key === "thoughtSignature" || key === "encrypted_content") return "[opaque provider state omitted]";
    if (typeof item === "string") {
      if (/^\s*[\[{]/.test(item)) {
        try { return JSON.stringify(clean(JSON.parse(item))); } catch { /* Preserve non-JSON text. */ }
      }
      if (/^data:image\//.test(item)) return "[binary image omitted]";
      let text = item;
      for (const secret of secrets) text = text.split(secret).join("[redacted]");
      return text.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, "$1 [redacted]")
        .replace(/((?:password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)\s*[=:]\s*["']?)[^\s"'&,;]+/gi, "$1[redacted]")
        .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[redacted]@");
    }
    if (Array.isArray(item)) return item.filter(value => !value?.thought).map(value => clean(value));
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, value]) => [key, clean(value, key)]));
    return item;
  };
  return clean(value);
}

export function recordAudit(chatId: string, runId: string, kind: string, data: unknown) {
  try { recordHistory(chatId, kind, redactAudit(data), "", runId); }
  catch (error) { throw new AuditPersistenceError(`Could not persist run audit: ${error instanceof Error ? error.message : String(error)}`); }
}

export function listRunAudits(chatId: string, before = Number.MAX_SAFE_INTEGER) {
  return withHistory(chatId, db => {
    const rows = db.prepare(`SELECT start.id, start.run_id, start.created_at, start.data,
      (SELECT data FROM events WHERE run_id = start.run_id AND kind = 'run_end' ORDER BY id DESC LIMIT 1) AS ending,
      (SELECT COUNT(*) FROM events WHERE run_id = start.run_id AND kind = 'tool_start') AS tool_calls,
      (SELECT COUNT(*) FROM events AS call WHERE call.run_id = start.run_id AND call.kind = 'tool_start'
        AND NOT EXISTS (SELECT 1 FROM events AS finish WHERE finish.run_id = call.run_id AND finish.kind = 'tool_end'
          AND json_extract(finish.data, '$.callId') = json_extract(call.data, '$.callId'))) AS unresolved_calls
      FROM events AS start WHERE kind = 'run_start' AND id < ? ORDER BY id DESC LIMIT 21`).all(before);
    return {
      runs: rows.slice(0, 20).map(row => {
        const start = JSON.parse(String(row.data));
        const end = row.ending ? JSON.parse(String(row.ending)) : null;
        return { id: row.run_id, startedAt: row.created_at, model: start.model, provider: start.provider,
          parentId: start.parentId, parentRunId: start.parentRunId, worker: start.worker,
          question: String(start.question ?? "").slice(0, 300), status: end?.status ?? "unfinished",
          durationMs: end?.durationMs ?? null, stats: end?.stats ?? null, estimatedCostUsd: null,
          toolCalls: row.tool_calls, unresolvedCalls: row.unresolved_calls };
      }),
      nextBefore: rows.length > 20 ? Number(rows[19].id) : null,
    };
  });
}

export function readRunAudit(chatId: string, runId: string, after = 0, eventId = 0, offset = 0) {
  return withHistory(chatId, db => {
    if (!db.prepare("SELECT 1 FROM events WHERE run_id = ? AND kind = 'run_start'").get(runId)) return null;
    if (eventId) {
      const row = db.prepare("SELECT id, kind, created_at, substr(data, ? + 1, 32000) AS content, length(data) AS size FROM events WHERE run_id = ? AND id = ?").get(offset, runId, eventId);
      if (!row) return null;
      return { id: row.id, kind: row.kind, createdAt: row.created_at, content: row.content,
        nextOffset: offset + 32_000 < Number(row.size) ? offset + 32_000 : null, totalCharacters: row.size };
    }
    const rows = db.prepare("SELECT id, kind, created_at, json_extract(data, '$.name') AS name, json_extract(data, '$.phase') AS phase, substr(data, 1, 1500) AS preview, length(data) AS size FROM events WHERE run_id = ? AND id > ? ORDER BY id LIMIT 51").all(runId, after);
    return { events: rows.slice(0, 50).map(row => ({ id: row.id, kind: row.kind, name: row.name, phase: row.phase, createdAt: row.created_at, preview: row.preview, characters: row.size, truncated: Number(row.size) > 1500 })),
      nextAfter: rows.length > 50 ? Number(rows[49].id) : null };
  });
}
