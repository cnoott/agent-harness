import { createHash } from "node:crypto";
import { readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export type ShadowProtocol = {
  id: string;
  version: number;
  description: string;
  source_fixture_root: string;
  source_slates: string[];
  selection_rule: string;
  primary_baseline: "season_avg" | "last_5" | "blended" | "minutes_adjusted";
  model: string;
  allowed_tools: string[];
  sandbox_network_enabled: boolean;
  attempts_per_slate: number;
  acceptance: {
    technical_validity_required: number;
    minimum_primary_baseline_wins: number;
    require_lower_mean_regret_than_primary_baseline: boolean;
  };
  limitations: string[];
};

export type ShadowState = {
  id: string;
  state: "REGISTERED" | "PREDICTING" | "SEALED" | "SCORED";
  registered_at: string;
  protocol_hash: string;
  protocol: ShadowProtocol;
  git_sha: string;
  git_status: string;
  code_hashes: Record<string, string>;
  input_hashes: Record<string, string>;
  attempts: Array<Record<string, unknown>>;
  sealed_at?: string;
  scored_at?: string;
};

export const defaultProtocolPath = path.resolve("fixtures/fantasy-nba-shadow-v1/protocol.json");

export async function sha256File(file: string) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

export async function loadProtocol(file = defaultProtocolPath) {
  return JSON.parse(await readFile(file, "utf8")) as ShadowProtocol;
}

export function shadowRoot(protocolId: string) {
  return path.resolve(".data/evals/shadow", protocolId);
}

export async function readState(root: string) {
  return JSON.parse(await readFile(path.join(root, "state.json"), "utf8")) as ShadowState;
}

export async function atomicJson(file: string, value: unknown) {
  const temporary = `${file}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, file);
}

async function filesBelow(root: string, relative = ""): Promise<string[]> {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const child = path.join(relative, entry.name);
    return entry.isDirectory() ? filesBelow(root, child) : [child];
  }));
  return nested.flat().sort();
}

export async function directoryManifest(root: string, ignoredNames = new Set<string>()) {
  const manifest: Record<string, { sha256: string; bytes: number }> = {};
  for (const relative of await filesBelow(root)) {
    if (ignoredNames.has(path.basename(relative))) continue;
    const file = path.join(root, relative);
    manifest[relative] = { sha256: await sha256File(file), bytes: (await stat(file)).size };
  }
  return manifest;
}

export function hashJson(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function mean(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

export function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
