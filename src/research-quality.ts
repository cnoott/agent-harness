/** Evaluation only. Never used to accept evidence or calculate fantasy points. */
import { createHash } from 'node:crypto';
import { categories } from './assessment-playbook.js';

export type QualityCase = {
  version: string; id: string; label: string; target: any; teammate: any;
  category: string; status: string; rationale: string;
  sources: Array<{id: string; url: string; text: string; author: string; basis: string; stage: string}>;
  expected: Array<{subject_id: string; kind: string; value: string; classification: string; excerpt: string; source_id: string}>;
};
export const contentHash = (text: string) => createHash('sha256').update(text).digest('hex');

/** Exact fixture scoring measures extraction, not semantic truth in arbitrary live reports. */
export function gradeFixture(spec: QualityCase, pkg: any) {
  const findings: any[] = pkg.findings ?? [];
  const docs = new Map<string, any>((pkg.documents ?? []).map((d: any) => [d.capture_id, d]));
  const matches = (f: any, e: QualityCase['expected'][number]) => {
    const d = docs.get(f.capture_id), source = spec.sources.find(s => s.id === e.source_id)!;
    return ['subject_id','kind','value','classification','excerpt'].every(k => f[k] === (e as any)[k])
      && f.target_ids?.length === 1 && f.target_ids[0] === spec.target.id
      && d?.source_url === source.url && d.text === source.text && d.sha256 === contentHash(source.text);
  };
  const found = spec.expected.filter(e => findings.some(f => matches(f,e))).length;
  const unexpected = findings.filter(f => !spec.expected.some(e => matches(f,e))).length;
  const coverage = categories.map(category => {
    const rows = (pkg.coverage ?? []).filter((c: any) => c.player_id === spec.target.id && c.category === category);
    const row = rows[0];
    const correct = rows.length === 1 && (category === spec.category ? row.status === spec.status : ['unresolved','not_checked'].includes(row.status));
    const referencesValid = row?.finding_ids?.every((id: string) => findings.some(f => f.id === id)) ?? false;
    const expectedReferences = category !== spec.category || spec.expected.every(e => findings.some(f => matches(f,e) && row?.finding_ids?.includes(f.id)));
    return {category, status: row?.status ?? 'missing', correct: correct && referencesValid && expectedReferences};
  });
  const duplicates = findings.length - new Set(findings.map(f => JSON.stringify([f.subject_id,f.kind,f.value,f.classification,f.excerpt]))).size;
  return {case_id: spec.id, fixture_sha256: contentHash(JSON.stringify(spec)), mode: 'synthetic extraction',
    expected_findings: spec.expected.length, found, missed: spec.expected.length-found, unexpected, duplicates,
    coverage, pass: found === spec.expected.length && unexpected === 0 && duplicates === 0 && coverage.every(c => c.correct),
    semantic_review: 'Not a live semantic accuracy grade; exact controlled fixture matches only.'};
}

/** Audit counters are host observations. A lack of findings is not automatically a failure. */
export function summarizeResearch(pkg: any, events: Array<{kind: string; data: any}>) {
  const starts = events.filter(e => e.kind === 'model_start');
  const end = [...events].reverse().find(e => e.kind === 'run_end')?.data;
  const searches: any[] = pkg.guidance?.activity?.filter((a: any) => a.kind === 'search') ?? [];
  const byPhase: Record<string,number> = {};
  for(const e of starts) byPhase[e.data?.phase ?? 'unknown']=(byPhase[e.data?.phase ?? 'unknown'] ?? 0)+1;
  return {version: '1.0', run_id: pkg.run_id, outcome: pkg.outcome, package_version: pkg.version,
    playbook_version: pkg.guidance?.playbook_version ?? null,
    elapsed_ms: end?.durationMs ?? null, model_calls: starts.length,
    model_calls_by_phase: byPhase, tool_calls: events.filter(e => e.kind === 'tool_start').length,
    tool_failures: events.filter(e => e.kind === 'tool_end' && e.data?.status === 'failed').map(e => ({name:e.data.name,error:e.data.result?.error ?? null})),
    tokens: end?.stats ?? null, cost_usd: null, cost_note: 'No verified per-run billing amount; token totals can include cached context.',
    captures: pkg.documents?.length ?? 0, capture_failures: (pkg.attempts ?? []).filter((a: any) => a.error).length,
    accepted_findings: pkg.delivered === true && !pkg.rejected ? pkg.findings?.length ?? 0 : null,
    findings_in_package: pkg.findings?.length ?? 0,
    preferred_searches: searches.filter(a => a.stage === 'preferred').length,
    wider_searches: searches.filter(a => a.stage === 'wider').length,
    coverage: pkg.coverage ?? [], stop_reason: pkg.guidance?.stop_reason ?? null,
    review: {status:'pending', instruction:'Review every finding against its captured text, timing and identity. Record missed supported answers and justified unknowns. Do not grade from checklist completeness alone.'}};
}
