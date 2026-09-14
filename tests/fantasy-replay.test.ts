import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";

const execute = promisify(execFile);
const repository = fileURLToPath(new URL("../", import.meta.url));

test("historical replay restricts tools and does not score failed attempts as perfect", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "harness-replay-"));
  const requests: any[] = [];
  const provider = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    requests.push(JSON.parse(raw));
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ type: "response.completed", response: { id: "fixture", output: [], output_text: "No recommendation produced." } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  try {
    await writeFile(path.join(directory, "docker"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await assert.rejects(execute(process.execPath, ["--import", import.meta.resolve("tsx"), path.join(repository, "scripts/run-fantasy-replays.ts"),
      "--fixtures", path.join(repository, "fixtures/fantasy-nba-replay"), "--limit", "1", "--agent"], {
      cwd: directory, timeout: 10_000,
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, OPENAI_API_KEY: "self-test-key", GEMINI_API_KEY: "", MODEL_PROVIDER: "openai", OPENAI_MODEL: "mock", OPENAI_BASE_URL: `http://127.0.0.1:${(provider.address() as any).port}` },
    }), (error: any) => error.code === 1);
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].tools.map((tool: any) => tool.name), ["exec"]);
    const report = JSON.parse(await readFile(path.join(directory, ".data/evals/latest-fantasy-replay.json"), "utf8"));
    assert.equal(report.agentRuns, 1);
    assert.equal(report.passed, 0);
    assert.equal(report.scoredAgentRuns, 0);
    assert.equal(report.meanRegret, null);
  } finally {
    provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
