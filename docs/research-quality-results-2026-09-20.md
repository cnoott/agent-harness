# Research quality benchmark — 2026-09-20

## What shipped

Six synthetic known-answer cases, an isolated replay/model runner, exact extraction
grading, read-only live audit export, and a source-review worksheet. Production and
benchmark submission instructions now share the same constant (wording unchanged).
No baseline calculation, news adjustment, scoring model, or UI behavior changed.

## Deterministic checks

- All six scripted bridge replays passed: official status, practice, role
  expectation, teammate absence, conflicting reports, and unknown status.
- 93 harness tests passed, two existing skips. TypeScript and diff checks passed.
- New tests reject missed known evidence, unsupported completeness, altered
  quotations/captures, wrong classification/identity, duplicate findings, missing
  references and teammate-to-target status confusion.

These are fixture/tooling checks, not model accuracy. Replays use a loopback receipt
stub; they do not exercise RiskOS acceptance. Existing RiskOS code was not changed
and its suites were not rerun for this benchmark milestone. No browser UI changes
were made, so browser layout tests were not repeated.

## Model on controlled sources

The official-status case was run with the real configured model pipeline and a
synthetic source. With the production submission instructions shared, it found
the expected `out` statement with the exact quote, correct identity and official
classification, and kept the other four questions unresolved. However, it emitted
the same finding five times (four explicitly marked duplicates). The benchmark
therefore failed its duplicate criterion. It completed in 180.427 seconds, with
26 model/tool calls, 263,611 input and 12,678 output tokens. This is one case, not
a six-case model pass or a production RiskOS acceptance result.

The first model trial is retained but excluded from comparative evaluation: the
benchmark initially omitted the production submission guidance. That run used
`ruled out` instead of the required `out`, also repeated the finding, and took
183.226 seconds / 30 calls. Sharing the existing instruction constant fixed the
benchmark mismatch; neither run demonstrates readiness. Both runs and their costs
must be included when accounting for evaluation work. Verified dollar cost remains
unknown. Results are in `.data/research-quality/official-status-*/result.json`.

## Live run

Isolated chat `d1123af0-681c-43a0-accb-8ea07015cdd6`, research run
`cb3f643d-a9a2-4777-9b5c-7017a285cb37`, Jalen Hurts, saved NFL 2026 Week 2 scope.
This used the real scoped workflow and real RiskOS acceptance.

| Observation | Result |
| --- | --- |
| Duration | 480.309 seconds; stopped at deadline |
| Model calls started / responses completed | 29 / 28 |
| Tool calls | 28 |
| Preferred / wider searches | 3 / 0 |
| Successful captures | 1, NFL injury report |
| Accepted news findings | 0 |
| Input / output tokens | 1,151,800 / 39,658 |
| Verified per-run billed cost | Unknown; input totals include reused/cached context |

The first Google search encountered traffic verification. Later search output
required several artifact reads. Three submissions tried to cite saved statistical
context through a nonexistent public capture; exact-quote validation rejected them.
A later coverage-only package retained unknowns and kept historical workload
descriptive. A phase-completion attempt also failed requirement/status validation.

The only captured source was the official NFL injury report. Its frozen text does
not name Jalen Hurts, so it cannot establish his status. All five gaps are justified
against that capture; we did not establish that no answer existed elsewhere. No
wider search happened despite unresolved questions. This remains a discovery and
orchestration failure, not proof the player has no news or is healthy.

All 16 baseline values, variability, supporting games and statistical timestamps
matched before/after. Restarting the isolated harness recovered all 16 complete
assessment payloads exactly. The existing RiskOS/Postgres services were not
restarted in this milestone. Temporary QA harness processes were stopped.

Local artifacts: `.data/research-quality-live-review/` contains the immutable
package export, audit, host metrics, and an explicitly assistant-reviewed worksheet.
This review is not independent human adjudication. Raw SSE and before/after
snapshots remain under `.data/research-quality-*`.

## Release implication

Do not use this result to authorize news-based numerical adjustments. Next fix
search-output overhead, recognition of blocked discovery, separation of saved
statistics from public news captures, and redundant findings when only one claim
is supported. Then repeat controlled and live trials.
The full six-case **model** suite and an independently reviewed live sample remain
necessary before claiming research quality; six scripted passes do not satisfy that
gate. Keep unknowns visible rather than weakening quote or identity checks.
