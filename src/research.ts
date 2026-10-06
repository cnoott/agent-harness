import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { ChatSession, ResearchConstraint, ResearchState } from "./types.js";

export type Requirement = { id: string; description: string; critical: boolean };
export type EvidenceItem = {
  requirementId: string; status: "supported" | "conflicting" | "missing";
  references: string[]; limitations: string[]; contradictions: Array<{ id: string; text: string }>;
};
export type ResearchPlan = {
  text: string; requirements: Requirement[];
  constraints: Array<Omit<ResearchConstraint, "status"> & { status: "active" | "unresolved"; supersedes: string[] }>;
  supersededDecisions: ResearchState["supersededDecisions"];
};
export type ResearchBrief = { text: string; evidence: EvidenceItem[] };
export type ResearchReview = {
  answer: string; conclusion: "supported" | "conditional" | "insufficient";
  claims: Array<{ text: string; requirementIds: string[]; kind: "historical" | "calculation" | "projection" | "judgment"; references: string[]; quote: string; assumptions: string }>;
  constraints: Array<{ id: string; disposition: "respected" | "resolved" | "unresolved"; answerExcerpt: string; references: string[] }>;
  contradictions: Array<{ id: string; disposition: "resolved" | "unresolved"; answerExcerpt: string; references: string[] }>;
  gaps: Array<{ requirementId: string; answerExcerpt: string }>;
  rating: { value: string; basis: string; kind: "subjective" | "calculated" | "none" };
};
export class ResearchCompletionError extends Error {}
export class ResearchEvidencePending extends Error {}
const string = { type: "string" };
const strings = { type: "array", items: string };
const object = (properties: Record<string, unknown>) => ({ type: "object", additionalProperties: false, properties, required: Object.keys(properties) });
const array = (properties: Record<string, unknown>) => ({ type: "array", items: object(properties) });
const enumeration = (...values: string[]) => ({ type: "string", enum: values });
export function researchCompletionTool(role: "plan" | "drive" | "review") {
  const properties = role === "plan" ? {
    text: string,
    requirements: array({ id: string, description: string, critical: { type: "boolean" } }),
    constraints: array({ id: string, text: string, sourceMessageId: string, quote: string, status: enumeration("active", "unresolved"), supersedes: strings }),
    supersededDecisions: array({ decision: string, sourceMessageId: string, correctionMessageId: string, quote: string }),
  } : role === "drive" ? {
    text: string,
    evidence: array({ requirementId: string, status: enumeration("supported", "conflicting", "missing"), references: strings, limitations: strings, contradictions: array({ id: string, text: string }) }),
  } : {
    answer: string, conclusion: enumeration("supported", "conditional", "insufficient"),
    claims: array({ text: string, requirementIds: strings, kind: enumeration("historical", "calculation", "projection", "judgment"), references: strings, quote: string, assumptions: string }),
    constraints: array({ id: string, disposition: enumeration("respected", "resolved", "unresolved"), answerExcerpt: string, references: strings }),
    contradictions: array({ id: string, disposition: enumeration("resolved", "unresolved"), answerExcerpt: string, references: strings }),
    gaps: array({ requirementId: string, answerExcerpt: string }),
    rating: object({ value: string, basis: string, kind: enumeration("subjective", "calculated", "none") }),
  };
  return { type: "function", name: "finish_research", strict: true,
    description: "Complete this research phase. Call alone after workers settle. References must be evidence IDs from successful tools or artifact reads. All answer excerpts and claim text must occur verbatim in the answer. Map verified claims to requirement IDs; every supported critical requirement needs verification. Each factual figure must occur in the quoted evidence, including calculation results. Quotes must occur verbatim in referenced evidence. Empty rating fields mean no numerical rating. A rejected completion allows only one correction.",
    parameters: object(properties) };
}
export const researchArtifactTool = {
  type: "function", name: "read_research_artifact", strict: true,
  description: "Read a UTF-8 excerpt of a research artifact. Use exact exported worker paths. Exploration may register its own workspace files; analysis may only read registered files. Offset is a UTF-16 character offset; nextOffset continues reading. Returns a content version, reusable evidence ID, and full path. Unchanged repeated reads return the existing receipt without its text; set reread true only to recover text lost from context.",
  parameters: object({ path: string, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 4000 }, reread: { type: "boolean" } }),
};

function requireThat(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function text(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function uniqueIds(items: Array<{ id: string }>) {
  requireThat(new Set(items.map(x => x.id)).size === items.length && items.every(x => text(x.id)), "IDs must be nonempty and unique.");
}
export function validatePlan(value: ResearchPlan, session: ChatSession): ResearchState {
  requireThat(text(value.text) && Array.isArray(value.requirements) && value.requirements.length > 0, "Provide a plan and evidence requirements.");
  uniqueIds(value.requirements);
  requireThat(value.requirements.every(r => text(r.description) && typeof r.critical === "boolean"), "Invalid requirement.");
  requireThat(Array.isArray(value.constraints) && Array.isArray(value.supersededDecisions), "Provide constraint updates and superseded decisions.");
  uniqueIds(value.constraints);
  const state: ResearchState = structuredClone(session.researchState ?? { constraints: [], supersededDecisions: [] });
  const positions = new Map(session.messages.map((m, i) => [m.id, i]));
  for (const update of value.constraints) {
    const source = session.messages.find(m => m.id === update.sourceMessageId && m.role === "user");
    requireThat(source && text(update.quote) && source.text.includes(update.quote) && text(update.text), "Constraints require an exact quote from an original user message.");
    requireThat(["active", "unresolved"].includes(update.status) && Array.isArray(update.supersedes), "Invalid constraint status or supersession.");
    const existing = state.constraints.find(c => c.id === update.id);
    if (existing) {
      requireThat(existing.text === update.text && existing.quote === update.quote && existing.sourceMessageId === update.sourceMessageId && existing.status === update.status && update.supersedes.length === 0, "Existing constraints are immutable; use a new ID for an explicit correction.");
      continue;
    }
    for (const id of update.supersedes) {
      const previous = state.constraints.find(c => c.id === id);
      requireThat(previous && positions.get(previous.sourceMessageId)! < positions.get(source.id)!, "Only a later user correction may supersede a constraint.");
      requireThat(update.status === "active", "Ambiguous constraints cannot supersede earlier constraints.");
      previous.status = "superseded";
    }
    const { supersedes: _, ...constraint } = update;
    state.constraints.push(constraint);
  }
  for (const decision of value.supersededDecisions) {
    const original = session.messages.find(m => m.id === decision.sourceMessageId && m.role === "assistant");
    const correction = session.messages.find(m => m.id === decision.correctionMessageId && m.role === "user");
    requireThat(original && correction && text(decision.decision) && original.text.includes(decision.decision) && text(decision.quote) && correction.text.includes(decision.quote) && positions.get(original.id)! < positions.get(correction.id)!, "Superseded decisions require original assistant text and a later exact user correction.");
    if (!state.supersededDecisions.some(d => JSON.stringify(d) === JSON.stringify(decision))) state.supersededDecisions.push(decision);
  }
  state.processedThroughMessageId = session.messages.filter(m => m.role === "user").at(-1)?.id;
  return state;
}

type Receipt = { id: string; name: string; content: string; role: string; version?: string; artifact?: string; capturedAt: string; offset?: number; nextOffset?: number | null; verifiable?: boolean };
export class ResearchEvidence {
  private receipts = new Map<string, Receipt>();
  private artifacts = new Map<string, { description: string; workerId?: string; synthesis?: boolean }>();
  private excerpts = new Map<string, string>();
  readonly workers = new Map<string, { id: string; status: string; requirementIds: string[]; summary: string; limitations: string[]; artifacts: string[] }>();
  constructor(readonly root: string, private audit: (kind: string, data: unknown) => void) {}
  manifest() {
    return { sources: [...this.receipts.values()].map(({ content, ...r }) => ({ ...r, characters: content.length })),
      artifacts: [...this.artifacts].map(([path, info]) => ({ path, ...info })), workers: [...this.workers.values()] };
  }
  recordTool(id: string, name: string, result: unknown, role: string) {
    if (name.startsWith("agent_") || name === "read_research_artifact") return undefined;
    const evidenceId = `tool:${id}`;
    this.receipts.set(evidenceId, { id: evidenceId, name, content: JSON.stringify(result), role, capturedAt: new Date().toISOString() });
    return evidenceId;
  }
  async ingestWorkers(value: unknown) {
    for (const worker of (Array.isArray(value) ? value : [value]) as any[]) {
      if (!worker?.id) continue;
      if (["failed", "cancelled", "interrupted", "blocked"].includes(worker.status)) {
        this.workers.delete(worker.id);
        this.receipts.delete(`worker:${worker.id}`);
        for (const [filename, artifact] of this.artifacts) if (artifact.workerId === worker.id) {
          this.artifacts.delete(filename);
          for (const [id, receipt] of this.receipts) if (receipt.artifact === filename) this.receipts.delete(id);
        }
        continue;
      }
      if (!worker.result || !["completed", "partial"].includes(worker.status)) continue;
      const result = worker.result;
      const paths: string[] = [];
      for (const artifact of result.artifacts ?? []) {
        const normalized = this.normalize(artifact.path);
        await this.file(normalized);
        this.artifacts.set(normalized, { description: artifact.description, workerId: worker.id });
        paths.push(normalized);
      }
      this.workers.set(worker.id, { id: worker.id, status: worker.status, requirementIds: worker.requirementIds ?? [], summary: result.summary, limitations: result.limitations, artifacts: paths });
      const id = `worker:${worker.id}`;
      this.receipts.set(id, { id, name: "worker_deliverable", content: JSON.stringify(result), role: "drive", capturedAt: new Date().toISOString() });
    }
  }
  async registerSynthesis(filename: string, description: string) {
    const relative = this.normalize(filename);
    await this.file(relative);
    this.artifacts.set(relative, { description, synthesis: true });
  }
  private normalize(filename: string) {
    requireThat(text(filename), "Provide an artifact path.");
    const relative = filename.startsWith("/workspace/") ? filename.slice(11) : filename;
    requireThat(!path.isAbsolute(relative) && !relative.split(/[\\/]/).includes(".."), "Artifact must be inside the sport workspace.");
    requireThat(Buffer.byteLength(relative) <= 1000, "Artifact path is too long.");
    return relative;
  }
  private async file(relative: string) {
    const root = await realpath(this.root);
    const filename = await realpath(path.join(root, relative));
    const details = await stat(filename);
    requireThat(filename.startsWith(`${root}${path.sep}`) && details.isFile() && details.size <= 25 * 1024 * 1024, "Artifact must be a regular workspace file, at most 25 MB.");
    return filename;
  }
  async read(args: Record<string, unknown>, role: string) {
    const relative = this.normalize(String(args.path));
    const known = this.artifacts.has(relative);
    requireThat(known || (role === "drive" && !relative.startsWith("subagent-results/")), "Use a registered artifact or a delivered worker artifact's exact path.");
    const filename = await this.file(relative);
    const offset = args.offset as number, limit = args.limit as number;
    requireThat(Number.isInteger(offset) && offset >= 0 && Number.isInteger(limit) && limit > 0 && limit <= 4000, "Invalid excerpt offset/limit.");
    const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes: Buffer;
    try {
      const details = await handle.stat();
      requireThat(details.isFile() && details.size <= 25 * 1024 * 1024, "Artifact exceeds size limit.");
      bytes = await handle.readFile();
    } finally { await handle.close(); }
    const content = bytes.toString("utf8");
    requireThat(offset <= content.length && !(offset > 0 && /[\uDC00-\uDFFF]/.test(content[offset]) && /[\uD800-\uDBFF]/.test(content[offset - 1])), "Offset must be a valid character boundary.");
    const version = createHash("sha256").update(bytes).digest("hex");
    let end = Math.min(content.length, offset + limit);
    if (end < content.length && /[\uDC00-\uDFFF]/.test(content[end])) end = end - 1 === offset ? end + 1 : end - 1;
    const key = `${relative}:${version}:${offset}:${limit}:${role}`;
    const reused = this.excerpts.has(key);
    const id = this.excerpts.get(key) ?? `artifact:${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
    let excerpt = content.slice(offset, end);
    while (Buffer.byteLength(JSON.stringify({ excerpt })) > 6000 && end > offset) {
      end--; if (/[\uDC00-\uDFFF]/.test(content[end])) end--;
      excerpt = content.slice(offset, end);
    }
    this.artifacts.set(relative, this.artifacts.get(relative) ?? { description: "Explorer evidence artifact" });
    this.excerpts.set(key, id);
    this.receipts.set(id, { id, name: "read_research_artifact", content: excerpt, role, version, verifiable: !this.artifacts.get(relative)?.synthesis, artifact: relative, offset, nextOffset: end < content.length ? end : null, capturedAt: new Date().toISOString() });
    this.audit("research_artifact_read", { id, path: relative, version, offset, nextOffset: end < content.length ? end : null, reused });
    return { evidenceId: id, verifiable: !this.artifacts.get(relative)?.synthesis, path: `/workspace/${relative}`, version, offset, ...(reused && !args.reread ? { note: "This unchanged excerpt was already inspected. Reuse its evidence ID; request reread to recover its text." } : { excerpt }), nextOffset: end < content.length ? end : null, totalCharacters: content.length, reused };
  }
  async checkReferences(ids: string[], reviewer = false, quote?: string) {
    requireThat(Array.isArray(ids) && ids.length > 0, "Provide evidence references.");
    for (const id of ids) {
      const receipt = this.receipts.get(id);
      requireThat(receipt && receipt.verifiable !== false && (!reviewer || receipt.role === "review"), "Reference must identify successful evidence inspected in this phase.");
      if (id.startsWith("worker:")) {
        const worker = this.workers.get(id.slice(7));
        requireThat(worker, "Worker evidence is no longer available.");
        for (const filename of worker.artifacts) await this.file(filename);
      }
      if (receipt.artifact) {
        const handle = await open(await this.file(receipt.artifact), constants.O_RDONLY | constants.O_NOFOLLOW);
        try { requireThat(createHash("sha256").update(await handle.readFile()).digest("hex") === receipt.version, "Artifact changed; inspect its current version before citing it."); }
        finally { await handle.close(); }
      }
    }
    if (quote !== undefined) requireThat(text(quote) && ids.some(id => this.receipts.get(id)!.content.includes(quote)), "Verification quote must occur in referenced evidence.");
  }
}

export async function validateBrief(brief: ResearchBrief, requirements: Requirement[], evidence: ResearchEvidence) {
  requireThat(text(brief.text) && Array.isArray(brief.evidence), "Provide a fact brief and requirement coverage.");
  const ids = brief.evidence.map(e => e.requirementId);
  requireThat(new Set(ids).size === ids.length && ids.length === requirements.length && requirements.every(r => ids.includes(r.id)), "Every assigned requirement needs exactly one status.");
  const contradictionIds: Array<{ id: string }> = [];
  for (const item of brief.evidence) {
    requireThat(["supported", "conflicting", "missing"].includes(item.status) && Array.isArray(item.limitations) && item.limitations.every(text) && Array.isArray(item.references) && Array.isArray(item.contradictions), "Invalid evidence coverage.");
    requireThat(item.contradictions.every(c => text(c.id) && text(c.text)), "Invalid contradiction.");
    contradictionIds.push(...item.contradictions);
    if (item.status !== "missing" || item.references.length) await evidence.checkReferences(item.references);
    if (item.status === "supported") requireThat(item.contradictions.length === 0, "Unresolved contradictions must be marked conflicting.");
    if (item.status === "conflicting") requireThat(item.contradictions.length > 0, "Conflicting evidence must identify the contradiction.");
    if (item.status === "missing") requireThat(item.limitations.length > 0, "Missing evidence needs an explanation.");
  }
  uniqueIds(contradictionIds);
}
export function criticalGaps(requirements: Requirement[], brief: ResearchBrief) {
  return requirements.filter(r => r.critical && brief.evidence.find(e => e.requirementId === r.id)?.status !== "supported");
}
function numericValues(value: string) {
  return (value.replace(/\]\([^)]*\)/g, "]").replace(/^\s*\d+[.)]\s/gm, "").match(/\d+(?:,\d{3})*(?:\.\d+)?/g) ?? []).map(n => String(Number(n.replaceAll(",", ""))));
}
export async function validateReview(review: ResearchReview, state: ResearchState, requirements: Requirement[], brief: ResearchBrief, evidence: ResearchEvidence) {
  requireThat(text(review.answer) && ["supported", "conditional", "insufficient"].includes(review.conclusion), "Provide an answer and conclusion status.");
  requireThat([review.claims, review.constraints, review.contradictions, review.gaps].every(Array.isArray), "Provide claims and all review dispositions.");
  const inAnswer = (excerpt: string) => requireThat(text(excerpt) && review.answer.includes(excerpt), "Review explanations must occur verbatim in the final answer.");
  const gaps = criticalGaps(requirements, brief);
  if (gaps.length || state.constraints.some(c => c.status === "unresolved")) requireThat(review.conclusion !== "supported", "Unresolved critical evidence or constraints require a conditional or insufficient conclusion.");
  for (const gap of gaps) {
    const entry = review.gaps.find(g => g.requirementId === gap.id);
    requireThat(entry, `Explain unresolved requirement ${gap.id}.`); inAnswer(entry.answerExcerpt);
  }
  const inspectDispositions = async (expected: Array<{ id: string }>, entries: ResearchReview["constraints"] | ResearchReview["contradictions"]) => {
    uniqueIds(entries);
    requireThat(entries.length === expected.length && expected.every(c => entries.some(e => e.id === c.id)), "Every active constraint and contradiction requires a disposition.");
    for (const entry of entries) {
      requireThat((entries === review.contradictions ? ["resolved", "unresolved"] : ["respected", "resolved", "unresolved"]).includes(entry.disposition), "Invalid disposition.");
      inAnswer(entry.answerExcerpt);
      if (entry.disposition === "resolved") await evidence.checkReferences(entry.references, true);
      else if (entry.references.length) await evidence.checkReferences(entry.references, true);
    }
  };
  await inspectDispositions(state.constraints.filter(c => c.status !== "superseded"), review.constraints);
  await inspectDispositions(brief.evidence.flatMap(e => e.contradictions), review.contradictions);
  if (review.constraints.some(c => c.disposition === "unresolved")) requireThat(review.conclusion !== "supported", "Unresolved constraints require a qualified conclusion.");
  for (const claim of review.claims) {
    inAnswer(claim.text);
    requireThat(Array.isArray(claim.requirementIds) && claim.requirementIds.every(id => requirements.some(r => r.id === id)), "Claim requirement IDs must come from the plan.");
    requireThat(["historical", "calculation", "projection", "judgment"].includes(claim.kind), "Invalid claim kind.");
    if (claim.kind !== "judgment" || /\d/.test(claim.text)) {
      await evidence.checkReferences(claim.references, true, claim.quote);
      const sourceFigures = new Set(numericValues(claim.quote));
      requireThat(numericValues(claim.text).every(n => sourceFigures.has(n)), "A claim's figures must appear in its verified quote; query or save the calculation result before citing it.");
    }
    if (["projection", "judgment", "calculation"].includes(claim.kind)) inAnswer(claim.assumptions);
  }
  if (review.conclusion !== "insufficient") {
    requireThat(review.claims.some(c => c.kind !== "judgment"), "A recommendation needs at least one verified factual claim; otherwise report insufficient evidence.");
    for (const requirement of requirements.filter(r => r.critical && brief.evidence.find(e => e.requirementId === r.id)?.status === "supported")) {
      requireThat(review.claims.some(c => c.kind !== "judgment" && c.requirementIds.includes(requirement.id)), `Verify decision-critical requirement ${requirement.id} before recommending.`);
    }
  }
  requireThat(review.rating && typeof review.rating.value === "string" && typeof review.rating.basis === "string", "Provide rating metadata (empty strings for no rating).");
  requireThat(["subjective", "calculated", "none"].includes(review.rating.kind), "Invalid rating kind.");
  if (review.rating.value) {
    requireThat(/^\d+(?:\.\d+)?(?:\s*\/\s*10)?$/.test(review.rating.value) && review.rating.kind !== "none", "Rating must be a numerical value with an explicit kind.");
    inAnswer(review.rating.value); inAnswer(review.rating.basis);
    if (review.rating.kind === "subjective") requireThat(/subjective|judgment|judgement|heuristic/i.test(review.rating.basis), "Label the rating basis as subjective judgment.");
    else requireThat(review.claims.some(c => c.kind === "calculation" && c.text.includes(review.rating.value)), "A calculated rating needs a verified calculation claim.");
  } else requireThat(review.rating.kind === "none", "Empty rating must have kind none.");
  const covered = new Set(numericValues(review.claims.map(c => c.text).join(" ") + " " + review.rating.value));
  requireThat(numericValues(review.answer).every(n => covered.has(n)), "Every numerical assertion must be covered by a verified claim or an explicitly explained rating.");
}
