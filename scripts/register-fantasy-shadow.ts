import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { atomicJson, defaultProtocolPath, hashJson, loadProtocol, sha256File, shadowRoot, type ShadowState } from "./lib/shadow-eval.js";
import type { Slate } from "./lib/fantasy-eval.js";

const relevantCode = [
  "src/agent.ts",
  "src/model.ts",
  "src/sandbox.ts",
  "scripts/register-fantasy-shadow.ts",
  "scripts/predict-fantasy-shadow.ts",
  "scripts/grade-fantasy-shadow.ts",
  "scripts/lib/shadow-eval.ts",
  "scripts/lib/fantasy-eval.ts",
  "scripts/lib/fantasy-baselines.ts",
];

function command(program: string, args: string[]) {
  const result = spawnSync(program, args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `${program} failed`);
  return result.stdout.trim();
}

async function main() {
  const protocolFile = path.resolve(process.argv[2] || defaultProtocolPath);
  const protocol = await loadProtocol(protocolFile);
  const root = shadowRoot(protocol.id);
  if (existsSync(root)) throw new Error(`Shadow test ${protocol.id} already exists; registration is immutable.`);
  if (protocol.attempts_per_slate !== 1) throw new Error("A sealed shadow test must allow exactly one attempt per slate.");
  await mkdir(path.join(root, "inputs"), { recursive: true });
  await mkdir(path.join(root, "private"), { recursive: true });

  const sourceRoot = path.resolve(protocol.source_fixture_root);
  const mappings: Record<string, { source_fixture: string; source_player_ids: string[] }> = {};
  const inputHashes: Record<string, string> = {};
  for (const slateId of protocol.source_slates) {
    const visibleRoot = path.join(sourceRoot, slateId, "visible");
    const sourceSlate = JSON.parse(await readFile(path.join(visibleRoot, "slate.json"), "utf8")) as Slate & Record<string, unknown>;
    if (sourceSlate.players.length !== 8) throw new Error(`${slateId} does not contain exactly eight candidates.`);
    const teamAliases = new Map<string, string>();
    const alias = (team: unknown) => {
      const key = String(team || "unknown");
      if (!teamAliases.has(key)) teamAliases.set(key, `Team ${teamAliases.size + 1}`);
      return teamAliases.get(key)!;
    };
    const players = sourceSlate.players.map((player, index) => {
      const copy = { ...player } as Record<string, unknown>;
      copy.id = `p${index + 1}`;
      copy.name = `Player ${String.fromCharCode(65 + index)}`;
      copy.team = alias(player.team);
      copy.opponent = alias(player.opponent);
      copy.days_since_last_appearance = copy.rest_days;
      delete copy.rest_days;
      return copy;
    });
    const anonymized = {
      id: `sealed-slate-${protocol.source_slates.indexOf(slateId) + 1}`,
      sport: sourceSlate.sport,
      format: sourceSlate.format,
      as_of: "relative:T-60m",
      slots: sourceSlate.slots,
      scoring: sourceSlate.scoring,
      players,
      provenance: {
        mode: "sealed anonymized historical shadow input",
        visible_features: "All rolling features precede the target event.",
        identifiers_removed: true,
      },
    };
    const destination = path.join(root, "inputs", slateId);
    await mkdir(destination, { recursive: true });
    await writeFile(path.join(destination, "slate.json"), `${JSON.stringify(anonymized, null, 2)}\n`);
    await writeFile(path.join(destination, "request.md"), [
      "Choose the best legal fantasy lineup from the supplied pre-event snapshot.",
      "Use the visible data only. Write recommendation.json with a lineup in slot order G, F, UTIL.",
      "Write recommendation.md explaining the decision and uncertainty.",
      "Create fantasy.sqlite with a recommendations table containing as_of and lineup, and insert the final choice using as_of relative:T-60m.",
    ].join("\n") + "\n");
    mappings[slateId] = { source_fixture: path.join(sourceRoot, slateId), source_player_ids: sourceSlate.players.map((player) => player.id) };
    inputHashes[slateId] = hashJson({
      slate: await sha256File(path.join(destination, "slate.json")),
      request: await sha256File(path.join(destination, "request.md")),
    });
  }

  const existingLedger = path.resolve(".data/evals/fantasy-replays.sqlite");
  if (existsSync(existingLedger)) {
    const quoted = protocol.source_slates.map((id) => `'${id.replaceAll("'", "''")}'`).join(",");
    const attempts = Number(command("sqlite3", [existingLedger, `select count(*) from replay_runs where slate_id in (${quoted}) and status != 'baselines_only';`]) || 0);
    if (attempts > 0) throw new Error(`Selected holdout contains ${attempts} prior agent attempts.`);
  }

  const codeHashes = Object.fromEntries(await Promise.all(relevantCode.map(async (file) => [file, await sha256File(path.resolve(file))])));
  const state: ShadowState = {
    id: protocol.id,
    state: "REGISTERED",
    registered_at: new Date().toISOString(),
    protocol_hash: await sha256File(protocolFile),
    protocol,
    git_sha: command("git", ["rev-parse", "HEAD"]),
    git_status: command("git", ["status", "--porcelain"]),
    code_hashes: codeHashes,
    input_hashes: inputHashes,
    attempts: [],
  };
  await atomicJson(path.join(root, "private/grading-map.json"), mappings);
  await atomicJson(path.join(root, "state.json"), state);
  console.log(JSON.stringify({ id: protocol.id, state: state.state, slates: protocol.source_slates.length, root }, null, 2));
}

void main();
