import "dotenv/config";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { emptyRunStats, runAgent } from "../src/agent.js";
import { getModelConfig } from "../src/model.js";
import { execute, stopSandbox } from "../src/sandbox.js";
import { createSession, workspacePath } from "../src/store.js";
import { legalLineups, lineupIds, readCheckpoint, type Slate } from "./lib/fantasy-eval.js";
import { atomicJson, directoryManifest, hashJson, readState, sha256File, shadowRoot } from "./lib/shadow-eval.js";
import type { ToolEvent } from "../src/types.js";

async function main() {
  const testId = process.argv[2] || "nba-shadow-final-five-v1";
  const root = shadowRoot(testId);
  const state = await readState(root);
  if (state.state !== "REGISTERED") throw new Error(`Prediction requires REGISTERED state; found ${state.state}. No reruns are allowed.`);
  const { model } = getModelConfig(true);
  if (model !== state.protocol.model) throw new Error(`The configured model must remain ${state.protocol.model} for this registered test.`);
  if (state.protocol.sandbox_network_enabled || state.protocol.allowed_tools.some((name) => name.startsWith("browser_"))) throw new Error("Historical shadow protocols must disable browser tools and sandbox networking.");
  for (const [file, expected] of Object.entries(state.code_hashes)) {
    if (await sha256File(path.resolve(file)) !== expected) throw new Error(`Registered code changed before prediction: ${file}`);
  }
  for (const slateId of state.protocol.source_slates) {
    const inputRoot = path.join(root, "inputs", slateId);
    const current = hashJson({ slate: await sha256File(path.join(inputRoot, "slate.json")), request: await sha256File(path.join(inputRoot, "request.md")) });
    if (current !== state.input_hashes[slateId]) throw new Error(`Registered input changed before prediction: ${slateId}`);
  }
  state.state = "PREDICTING";
  await atomicJson(path.join(root, "state.json"), state);
  await mkdir(path.join(root, "sealed"), { recursive: true });

  for (const slateId of state.protocol.source_slates) {
    const inputRoot = path.join(root, "inputs", slateId);
    const slate = JSON.parse(await readFile(path.join(inputRoot, "slate.json"), "utf8")) as Slate;
    const prompt = await readFile(path.join(inputRoot, "request.md"), "utf8");
    const session = await createSession();
    const workspace = workspacePath(session.id);
    const events: ToolEvent[] = [];
    const stats = emptyRunStats();
    const startedAt = new Date().toISOString();
    const started = Date.now();
    let status = "prediction_error";
    let error = "";
    let legal = false;
    let checkpointOk = false;
    let lineup: string[] = [];
    let agentOutput = "";
    let networkMode = "not-created";

    try {
      await cp(inputRoot, workspace, { recursive: true });
      await execute(session.id, "true", { networkEnabled: false });
      const container = `sandbox-harness-${session.id.replaceAll("-", "").slice(0, 20)}`;
      const inspection = spawnSync("docker", ["inspect", "--format", "{{.HostConfig.NetworkMode}}", container], { encoding: "utf8" });
      networkMode = inspection.stdout.trim();
      if (inspection.status !== 0 || networkMode !== "none") throw new Error(`Sandbox network mode is ${networkMode || "unknown"}, expected none.`);
      agentOutput = await runAgent(session, prompt, (event) => events.push(event), { cancelled: false }, stats, {
        allowedTools: state.protocol.allowed_tools,
        sandboxNetworkEnabled: false,
      });
      const recommendationFile = path.join(workspace, "recommendation.json");
      if (!existsSync(recommendationFile)) throw new Error("Agent did not create recommendation.json");
      const recommendation = JSON.parse(await readFile(recommendationFile, "utf8")) as { lineup?: unknown };
      lineup = lineupIds(recommendation.lineup);
      legal = legalLineups(slate).some((candidate) => candidate.join("|") === lineup.join("|"));
      const checkpoint = readCheckpoint(workspace, slate.as_of, lineup);
      checkpointOk = Boolean(checkpoint.table && checkpoint.rows > 0 && checkpoint.matchesAsOf && checkpoint.matchesLineup);
      const artifactsComplete = existsSync(path.join(workspace, "recommendation.md")) && existsSync(path.join(workspace, "fantasy.sqlite"));
      status = legal && checkpointOk && artifactsComplete ? "sealed_valid" : "sealed_invalid";
      if (!artifactsComplete) error = "One or more required recommendation artifacts are missing.";
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    } finally {
      await stopSandbox(session.id);
    }

    const temporary = path.join(root, "sealed", `.tmp-${slateId}`);
    const destination = path.join(root, "sealed", slateId);
    if (existsSync(temporary) || existsSync(destination)) throw new Error(`Attempt bundle already exists for ${slateId}; refusing a retry.`);
    await mkdir(temporary, { recursive: true });
    await cp(inputRoot, path.join(temporary, "input"), { recursive: true });
    for (const artifact of ["recommendation.json", "recommendation.md", "fantasy.sqlite"]) {
      const source = path.join(workspace, artifact);
      if (existsSync(source)) await cp(source, path.join(temporary, artifact));
    }
    await writeFile(path.join(temporary, "agent-output.txt"), agentOutput);
    await writeFile(path.join(temporary, "events.json"), `${JSON.stringify(events, null, 2)}\n`);
    const metadata = {
      slate_id: slateId,
      started_at: startedAt,
      sealed_at: new Date().toISOString(),
      session_id: session.id,
      model: state.protocol.model,
      allowed_tools: state.protocol.allowed_tools,
      sandbox_network_mode: networkMode,
      status,
      error,
      legal,
      checkpoint_ok: checkpointOk,
      lineup,
      duration_ms: Date.now() - started,
      ...stats,
    };
    await atomicJson(path.join(temporary, "metadata.json"), metadata);
    const manifest = await directoryManifest(temporary, new Set(["MANIFEST.json"]));
    await atomicJson(path.join(temporary, "MANIFEST.json"), { files: manifest, manifest_hash: hashJson(manifest) });
    await rename(temporary, destination);
    state.attempts.push({ slate_id: slateId, status, bundle_hash: hashJson(manifest), session_id: session.id });
    await atomicJson(path.join(root, "state.json"), state);
    console.log(`${slateId}: ${status}`);
  }

  state.state = "SEALED";
  state.sealed_at = new Date().toISOString();
  await atomicJson(path.join(root, "state.json"), state);
  console.log(JSON.stringify({ id: testId, state: state.state, attempts: state.attempts.length, root }, null, 2));
}

void main();
