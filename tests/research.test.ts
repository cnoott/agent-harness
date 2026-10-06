import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { ResearchEvidence, validatePlan, validateBrief, validateReview, type ResearchPlan, type ResearchReview } from "../src/research.js";
import type { ChatSession, ToolEvent } from "../src/types.js";

const fixture = JSON.parse(await readFile(new URL("./fixtures/september-17-research.json", import.meta.url), "utf8"));
const originalDirectory = process.cwd();
const directory = await mkdtemp(path.join(tmpdir(), "harness-research-"));
process.chdir(directory);
process.env.OPENAI_API_KEY = "self-test-key";
const { runResearchTurn, cancelRun, createResearchPacket, formatResearchPacket } = await import("../src/agent.js");
const { createSession, saveSession, getSession, workspacePath } = await import("../src/store.js");
const { withHistory } = await import("../src/history.js");
const { Subagents } = await import("../src/subagents.js");
after(async () => { process.chdir(originalDirectory); await rm(directory, { recursive: true, force: true }); });
const constraint = { id: "keep-defense", text: "Keep the defense slot filled; a skill player needs a skill-position cut.", sourceMessageId: "correction", quote: fixture.correction, status: "active" as const, supersedes: [] };
const requirement = { id: "cut", description: "Value the required skill-position cut", critical: true };
function plan(): ResearchPlan {
  return { text: "Verify roster cost before recommending a trade.", requirements: [requirement], constraints: [constraint], supersededDecisions: [{ decision: fixture.assistant, sourceMessageId: "old-advice", correctionMessageId: "correction", quote: fixture.correction }] };
}
async function session() {
  const s = await createSession("nfl");
  s.messages = [
    { id: "old-advice", role: "assistant", text: fixture.assistant, createdAt: s.createdAt },
    { id: "correction", role: "user", text: fixture.correction, createdAt: s.createdAt },
    { id: "long-reply", role: "assistant", text: "Earlier advice and sources. ".repeat(500), createdAt: s.createdAt },
    { id: "followup", role: "user", text: fixture.followup, createdAt: s.createdAt },
  ];
  return s;
}
function review(reference: string, conditional = false): ResearchReview {
  const answer = `Keep the defense slot filled. Historical roster capacity is 14.${conditional ? " A recommendation remains conditional because cut valuation is missing." : " The required cut has supporting evidence."}`;
  return { answer, conclusion: conditional ? "conditional" : "supported",
    claims: [{ text: "Historical roster capacity is 14.", requirementIds: ["cut"], kind: "historical", references: [reference], quote: "Roster capacity: 14", assumptions: "" }],
    constraints: [{ id: "keep-defense", disposition: "respected", answerExcerpt: "Keep the defense slot filled.", references: [] }], contradictions: [],
    gaps: conditional ? [{ requirementId: "cut", answerExcerpt: "cut valuation is missing" }] : [], rating: { value: "", basis: "", kind: "none" } };
}
const pipeline = { plan: { provider: "openai" as const, model: "plan" }, gather: { provider: "openai" as const, model: "drive" }, reason: { provider: "openai" as const, model: "review" } };
const call = (name: string, args: unknown) => [{ type: "function_call", name, call_id: crypto.randomUUID(), arguments: JSON.stringify(args) }];
async function mockProvider(respond: (request: any, index: number) => Promise<any> | any, action: () => Promise<void>) {
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw); requests.push(request);
    try {
      const output = await respond(request, requests.length);
      if (!Array.isArray(output)) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(output)); return; }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "UNCHECKED DRAFT: Drop Houston D/ST" })}\n\n`);
      res.end(`data: ${JSON.stringify({ type: "response.completed", response: { id: `r-${requests.length}`, output, output_text: "UNCHECKED DRAFT", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })}\n\ndata: [DONE]\n\n`);
    } catch (error) { res.writeHead(500); res.end(String(error)); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${(server.address() as any).port}`;
  try { await action(); } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

test("constraints keep original user provenance, supersede explicitly, and survive restart and worker handoffs", async () => {
  const s = await session();
  s.researchState = validatePlan(plan(), s);
  await saveSession(s);
  const restored = (await getSession(s.id))!;
  const packet = await createResearchPacket(restored, fixture.followup);
  for (const audience of ["parent", "worker"] as const) {
    const formatted = formatResearchPacket(packet, audience);
    assert(formatted.includes(fixture.correction));
    assert(formatted.includes('"sourceMessageId":"correction"'));
    assert(formatted.includes(fixture.assistant));
  }
  const forged = plan(); forged.constraints[0] = { ...constraint, sourceMessageId: "old-advice", quote: fixture.assistant };
  assert.throws(() => validatePlan(forged, s), /original user/);
  s.messages.push({ id: "new-correction", role: "user", text: "I changed the roster rules; temporarily leaving defense empty is allowed.", createdAt: s.createdAt });
  const replacement = plan(); replacement.constraints = [{ ...constraint, id: "defense-empty", sourceMessageId: "new-correction", quote: s.messages.at(-1)!.text, text: "Defense may be temporarily empty.", supersedes: [constraint.id] }];
  const state = validatePlan(replacement, s);
  assert.equal(state.constraints[0].status, "superseded"); assert.equal(state.constraints[1].status, "active");
  replacement.constraints[0].status = "unresolved";
  assert.throws(() => validatePlan(replacement, s), /Ambiguous/);
  const other = await createSession("nba");
  assert.equal((await createResearchPacket(other, "NBA question")).constraints, undefined);
});

test("artifact reader preserves Unicode, validates versions, rejects escapes and failed workers, and reuses excerpts", async () => {
  const root = path.join(directory, "artifacts"); await mkdir(root);
  const audit: any[] = [];
  const evidence = new ResearchEvidence(root, (kind, data) => audit.push({ kind, data }));
  await writeFile(path.join(root, "facts.txt"), fixture.facts + "😀".repeat(5000));
  const first = await evidence.read({ path: "facts.txt", offset: 0, limit: 4000 }, "drive");
  assert(Buffer.byteLength(JSON.stringify(first)) < 8000);
  const reused = await evidence.read({ path: "facts.txt", offset: 0, limit: 4000 }, "drive");
  assert.equal(reused.reused, true); assert.equal(reused.excerpt, undefined);
  assert.equal((await evidence.read({ path: "facts.txt", offset: 0, limit: 4000, reread: true }, "drive")).excerpt, first.excerpt);
  await writeFile(path.join(root, "unicode.txt"), "😀😀");
  const unicode = await evidence.read({ path: "unicode.txt", offset: 0, limit: 1 }, "drive");
  assert.equal(unicode.excerpt, "😀"); assert.equal(unicode.nextOffset, 2);
  const verified = await evidence.read({ path: "facts.txt", offset: 0, limit: 4000 }, "review");
  await evidence.checkReferences([verified.evidenceId], true, "Roster capacity: 14");
  await writeFile(path.join(root, "facts.txt"), "Changed evidence");
  await assert.rejects(evidence.checkReferences([verified.evidenceId], true), /changed/);
  const changed = await evidence.read({ path: "facts.txt", offset: 0, limit: 4000 }, "review");
  assert.notEqual(changed.version, first.version); assert.equal(changed.reused, false);
  await assert.rejects(evidence.read({ path: "../outside", offset: 0, limit: 10 }, "drive"), /workspace/);
  await writeFile(path.join(directory, "outside.txt"), "outside");
  await symlink(path.join(directory, "outside.txt"), path.join(root, "escape"));
  await assert.rejects(evidence.read({ path: "escape", offset: 0, limit: 10 }, "drive"), /workspace/);
  await assert.rejects(evidence.read({ path: "unregistered.txt", offset: 0, limit: 10 }, "review"), /registered/);
  await evidence.ingestWorkers({ id: "failed-worker", status: "failed", result: { summary: "Made up", artifacts: [] } });
  await assert.rejects(evidence.checkReferences(["worker:failed-worker"]), /successful evidence/);
  await mkdir(path.join(root, "subagent-results/worker"), { recursive: true });
  await writeFile(path.join(root, "subagent-results/worker/exact.txt"), "worker evidence");
  await evidence.ingestWorkers({ id: "worker", status: "completed", requirementIds: ["cut"], result: { summary: "Cut evidence", output: "worker evidence", limitations: [], artifacts: [{ path: "subagent-results/worker/exact.txt", description: "Exact exported artifact" }] } });
  assert.equal((await evidence.read({ path: "subagent-results/worker/exact.txt", offset: 0, limit: 100 }, "review")).excerpt, "worker evidence");
  await evidence.ingestWorkers({ id: "worker", status: "failed" });
  await assert.rejects(evidence.checkReferences(["worker:worker"]), /successful evidence/);
  await assert.rejects(evidence.read({ path: "subagent-results/worker/exact.txt", offset: 0, limit: 100 }, "review"), /registered/);
  await evidence.registerSynthesis("facts.txt", "Summary, not primary evidence");
  const summary = await evidence.read({ path: "facts.txt", offset: 0, limit: 100 }, "review");
  assert.equal(summary.verifiable, false);
  await assert.rejects(evidence.checkReferences([summary.evidenceId], true), /successful evidence/);
  assert(audit.some(e => e.data.reused));
});

test("requirements, verified numeric claims, contradictions and visible caveats are completion gates", async () => {
  const s = await session(); const state = validatePlan(plan(), s);
  const evidence = new ResearchEvidence(workspacePath(s.id), () => {});
  const driveId = evidence.recordTool("drive", "sports_query", { facts: fixture.facts }, "drive")!;
  const reviewId = evidence.recordTool("review", "sports_query", { facts: fixture.facts }, "review")!;
  const brief = { text: "Facts", evidence: [{ requirementId: "cut", status: "supported" as const, references: [driveId], limitations: [], contradictions: [] }] };
  await validateBrief(brief, [requirement], evidence);
  await assert.rejects(validateBrief({ text: "Facts", evidence: [] }, [requirement], evidence), /Every assigned/);
  await assert.rejects(validateBrief({ ...brief, evidence: [{ ...brief.evidence[0], references: ["invented"] }] }, [requirement], evidence), /successful evidence/);
  await validateReview(review(reviewId), state, [requirement], brief, evidence);
  await assert.rejects(validateReview(review(driveId), state, [requirement], brief, evidence), /this phase/);
  const dropped = review(reviewId); dropped.constraints = [];
  await assert.rejects(validateReview(dropped, state, [requirement], brief, evidence), /Every active/);
  const incorrectFigure = review(reviewId); incorrectFigure.answer = incorrectFigure.answer.replace("14", "99"); incorrectFigure.claims[0].text = incorrectFigure.claims[0].text.replace("14", "99");
  await assert.rejects(validateReview(incorrectFigure, state, [requirement], brief, evidence), /figures/);
  const madeUp = review(reviewId); madeUp.answer += " Expected gain is 20 points.";
  await assert.rejects(validateReview(madeUp, state, [requirement], brief, evidence), /numerical/);
  const missing = { text: "Not enough", evidence: [{ requirementId: "cut", status: "missing" as const, references: [], limitations: ["No cut valuation"], contradictions: [] }] };
  await assert.rejects(validateReview(review(reviewId), state, [requirement], missing, evidence), /conditional/);
  await validateReview(review(reviewId, true), state, [requirement], missing, evidence);
  const conflict = { text: "Different recorded yardage", evidence: [{ requirementId: "cut", status: "conflicting" as const, references: [driveId], limitations: [], contradictions: [{ id: "yards", text: "Thomas structured and narrative yardage disagree." }] }] };
  await assert.rejects(validateReview(review(reviewId, true), state, [requirement], conflict, evidence), /Every active/);
  const resolved = review(reviewId, true);
  resolved.answer += " The yardage disagreement remains unresolved.";
  resolved.contradictions = [{ id: "yards", disposition: "unresolved", answerExcerpt: "The yardage disagreement remains unresolved.", references: [] }];
  await validateReview(resolved, state, [requirement], conflict, evidence);
  // Workflow prose is not a structured evidence contradiction.
  brief.text += " This brief intentionally makes no fantasy recommendation.";
  await validateReview(review(reviewId), state, [requirement], brief, evidence);
});

for (const resolved of [true, false]) test(`frozen September 17 replay: one targeted retry, ${resolved ? "resolved" : "conditional"} answer, no draft streaming`, async () => {
  const s = await session(); await writeFile(path.join(workspacePath(s.id), "facts.txt"), fixture.facts);
  let drivePass = 0, reviewerReads = 0; const requests: any[] = [], events: ToolEvent[] = [];
  await mockProvider(request => {
    requests.push(request);
    const result = Array.isArray(request.input) ? JSON.parse(request.input[0].output) : undefined;
    if (request.model === "plan") return call("finish_research", plan());
    if (request.model === "drive") {
      if (typeof request.input === "string") {
        drivePass++;
        if (drivePass === 2 && resolved) return call("read_research_artifact", { path: "facts.txt", offset: 0, limit: 1000 });
        return call("finish_research", { text: "Cut valuation is missing.", evidence: [{ requirementId: "cut", status: "missing", references: [], limitations: ["No cut valuation"], contradictions: [] }] });
      }
      return call("finish_research", { text: "A fixture establishes cut valuation.", evidence: [{ requirementId: "cut", status: "supported", references: [result.evidenceId], limitations: [], contradictions: [] }] });
    }
    if (typeof request.input === "string") {
      reviewerReads++;
      // With a missing brief, verify a successful saved query through sports_query below.
      return call("sports_query", { sql: "SELECT 'Roster capacity: ' || capacity AS fact FROM roster_fixture" });
    }
    return call("finish_research", review(result.evidenceId, !resolved));
  }, async () => {
    const { DatabaseSync } = await import("node:sqlite");
    await mkdir(path.join(directory, ".data/sports"), { recursive: true });
    const db = new DatabaseSync(path.join(directory, ".data/sports/nfl.sqlite"));
    db.exec("CREATE TABLE IF NOT EXISTS games(id TEXT); INSERT INTO games VALUES ('fixture'); CREATE TABLE IF NOT EXISTS roster_fixture(capacity INTEGER); DELETE FROM roster_fixture; INSERT INTO roster_fixture VALUES (14); PRAGMA user_version=1;"); db.close();
    const answer = await runResearchTurn(s, fixture.followup, e => events.push(e), { cancelled: false }, undefined, { research: pipeline });
    assert.equal(answer, review("irrelevant", !resolved).answer, JSON.stringify(withHistory(s.id, db => db.prepare("SELECT kind,data FROM events WHERE kind IN ('research_completion_rejected','research_validation_failed') OR (kind='tool_end' AND json_extract(data,'$.status')='failed')").all())));
  });
  assert.equal(drivePass, 2); assert.equal(reviewerReads, 1);
  assert.equal(events.filter(e => e.type === "text_delta").length, 1);
  assert(!JSON.stringify(events).includes("UNCHECKED DRAFT"));
  assert(!events.some(e => e.name === "finish_research"));
  assert(requests.filter(r => r.model !== "plan").every(r => typeof r.input !== "string" || r.input.includes(fixture.correction)));
  assert(requests.find(r => r.model === "drive" && typeof r.input === "string" && r.input.includes("Targeted retry")).input.includes('"cut"'));
  const restored = (await getSession(s.id))!; assert.equal(restored.researchState!.constraints[0].quote, fixture.correction);
  const retries = withHistory(s.id, db => db.prepare("SELECT count(*) n FROM events WHERE kind='research_retry'").get()!.n);
  assert.equal(retries, 1);
});

test("invalid completion allows one correction then a bounded fallback without leaking the rejected answer", async () => {
  const s = await session(); let attempts = 0; const events: ToolEvent[] = [];
  await mockProvider(() => { attempts++; return call("finish_research", { ...plan(), constraints: [{ ...constraint, quote: "invented quote" }] }); }, async () => {
    const answer = await runResearchTurn(s, fixture.followup, e => events.push(e), { cancelled: false }, undefined, { research: pipeline });
    assert.match(answer, /couldn't validate/);
  });
  assert.equal(attempts, 2); assert.equal(events.filter(e => e.type === "text_delta").length, 1);
  assert(!JSON.stringify(events).includes("UNCHECKED DRAFT"));
});

test("cancelled research retains validated constraints without releasing an answer", async () => {
  const s = await session(); const control = { cancelled: false }; const events: ToolEvent[] = [];
  await mockProvider(request => {
    if (request.model === "plan") return call("finish_research", plan());
    cancelRun(control); return [];
  }, async () => {
    await assert.rejects(runResearchTurn(s, fixture.followup, e => events.push(e), control, undefined, { research: pipeline }));
  });
  assert.equal(events.filter(e => e.type === "text_delta").length, 0);
  assert.equal((await getSession(s.id))!.researchState!.constraints[0].quote, fixture.correction);
});

test("research workers receive constraints and requirement ownership; duplicate assignments need a reason", async () => {
  const s = await session(); s.researchState = validatePlan(plan(), s); await saveSession(s);
  const packet = await createResearchPacket(s, fixture.followup); packet.requirements = [requirement];
  const seen: string[] = [];
  const manager = new Subagents(async (_session, prompt, _emit, _control, _stats, options) => {
    seen.push(prompt);
    return options!.finishTask!({ outcome: "completed", summary: "Verified fixture", output: fixture.facts, limitations: [], artifacts: [] });
  });
  const options = { research: pipeline, researchPacket: packet };
  const args = { task: "Verify cut", context: "", expectedOutput: "facts", provider: "openai", model: "drive", requirementIds: ["cut"], crossCheckReason: "" };
  try {
    const first = await manager.start(s.id, "run", "one", args, options);
    await assert.rejects(manager.start(s.id, "run", "two", args, options), /already have an assignment/);
    await manager.wait(s.id, [first.id], new AbortController().signal);
    assert(seen[0].includes(fixture.correction));
    assert.deepEqual(first.requirementIds, ["cut"]);
    const second = await manager.start(s.id, "run", "three", { ...args, crossCheckReason: "Independently verify the roster count" }, options);
    await manager.wait(s.id, [second.id], new AbortController().signal);
    await assert.rejects(manager.start(s.id, "run", "four", { ...args, requirementIds: ["other"] }, options), /requirement IDs/);
  } finally { await manager.close(); }
});

test("supported research skips retry and corrects a rejected reviewer draft once before publishing", async () => {
  const s = await session(); await writeFile(path.join(workspacePath(s.id), "reviewable.txt"), fixture.facts);
  let reviewReference = "", attempts = 0, drivePasses = 0;
  const events: ToolEvent[] = [];
  await mockProvider(request => {
    const result = Array.isArray(request.input) ? JSON.parse(request.input[0].output) : undefined;
    if (request.model === "plan") return call("finish_research", plan());
    if (request.model === "drive") {
      if (typeof request.input === "string") { drivePasses++; return call("read_research_artifact", { path: "reviewable.txt", offset: 0, limit: 1000, reread: false }); }
      return call("finish_research", { text: "Supported frozen evidence", evidence: [{ requirementId: "cut", status: "supported", references: [result.evidenceId], limitations: [], contradictions: [] }] });
    }
    if (typeof request.input === "string") return call("read_research_artifact", { path: "reviewable.txt", offset: 0, limit: 1000, reread: false });
    if (result.evidenceId) reviewReference = result.evidenceId;
    attempts++;
    const completion = review(reviewReference);
    if (attempts === 1) completion.constraints = [];
    return call("finish_research", completion);
  }, async () => {
    const answer = await runResearchTurn(s, fixture.followup, e => events.push(e), { cancelled: false }, undefined, { research: pipeline });
    assert.equal(answer, review("any").answer);
  });
  assert.equal(drivePasses, 1); assert.equal(attempts, 2);
  assert.equal(events.filter(e => e.type === "text_delta").length, 1);
  assert.equal(withHistory(s.id, db => db.prepare("SELECT count(*) n FROM events WHERE kind='research_retry'").get()!.n), 0);
  assert.equal(withHistory(s.id, db => db.prepare("SELECT count(*) n FROM events WHERE kind='research_completion_rejected'").get()!.n), 1);
});

test("a bare prose response cannot bypass phase completion", async () => {
  const s = await session(); let calls = 0; const events: ToolEvent[] = [];
  await mockProvider(() => { calls++; return []; }, async () => {
    const answer = await runResearchTurn(s, fixture.followup, e => events.push(e), { cancelled: false }, undefined, { research: pipeline });
    assert.match(answer, /couldn't validate/);
  });
  assert.equal(calls, 2); assert(!JSON.stringify(events).includes("UNCHECKED DRAFT"));
});

test("memory refresh precedes packet creation without replacing original user corrections", async () => {
  const s = await session();
  s.messages.splice(2, 0, ...Array.from({ length: 8 }, (_, i) => ({ id: `older-${i}`, role: "assistant" as const, text: "Older research", createdAt: s.createdAt })));
  let refreshed = false, planSawFreshMemory = false;
  await mockProvider(request => {
    if (!request.stream) { refreshed = true; return { id: "memory", output_text: "Fresh durable summary", output: [] }; }
    if (request.model === "plan") {
      planSawFreshMemory = request.input.includes("Fresh durable summary") && request.input.includes(fixture.correction);
      return call("finish_research", plan());
    }
    if (request.model === "drive") return call("finish_research", { text: "Missing cut evidence", evidence: [{ requirementId: "cut", status: "missing", references: [], limitations: ["Cut valuation is missing"], contradictions: [] }] });
    return call("finish_research", {
      answer: "Keep the defense slot filled. I cannot recommend a cut because cut valuation is missing.", conclusion: "insufficient", claims: [],
      constraints: [{ id: "keep-defense", disposition: "respected", answerExcerpt: "Keep the defense slot filled.", references: [] }], contradictions: [],
      gaps: [{ requirementId: "cut", answerExcerpt: "cut valuation is missing" }], rating: { value: "", basis: "", kind: "none" },
    });
  }, async () => { assert.match(await runResearchTurn(s, fixture.followup, () => {}, { cancelled: false }, undefined, { research: pipeline }), /cannot recommend/); });
  assert(refreshed); assert(planSawFreshMemory);
  assert.equal((await getSession(s.id))!.researchState!.constraints[0].quote, fixture.correction);
});
