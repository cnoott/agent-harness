# Assessment research quality benchmark

This benchmark measures the guided researcher before news affects any forecast.
It does not change baseline calculations, source acceptance, or the UI.

See the [initial measured results](research-quality-results-2026-09-20.md), including
failed live/model checks and their limits.

## Three separate kinds of evidence

1. **Deterministic replay** exercises the real host research bridge with scripted
   tool calls and synthetic sources. It checks the fixtures and grading harness;
   it is not evidence that a model can research.
2. **Model on frozen sources** runs the existing planning/gathering/review pipeline
   against the same synthetic source set. Expected answers are withheld from the
   model. Discovery is deterministic, so this tests extraction and orchestration,
   not real search quality.
3. **Live research** uses the ordinary scoped Research concerns endpoint and real
   RiskOS acceptance. Inspect captures and manually adjudicate meaning. Transport
   acceptance and a complete checklist do not establish factual correctness.

## Commands

Run from the agent-harness repository. `--model` makes paid model calls using the
configured research pipeline; it retains the shared 30-call/eight-minute limits.
Neither benchmark mode sends synthetic evidence to the real RiskOS service.
Both use a loopback receipt stub, not a RiskOS acceptance implementation. Each
run gets a new isolated directory under `.data/research-quality/`.

```sh
npm run research:benchmark -- --replay official-status
npm run research:benchmark -- --model official-status
```

Cases: `official-status`, `practice`, `role-expectation`, `teammate`, `conflict`,
and `unknown`. The unknown case deliberately mentions a player without answering
the status question. Conflicts require both reports; teammate absence must not
become the target player's absence. Publication times remain unknown.

Each run saves the package, host journal/outbox/audit, fixture hash, model counts,
elapsed time, token usage and exact-match grade. Nonzero exit means a fixture
mismatch or run failure; inspect both rather than treating one as the other.
The exact-match rubric is deliberately narrow: descriptive wording differences
can require manual review. These are development cases, not an independent holdout.

Read an existing live run without model calls or delivery:

```sh
npm run research:inspect -- DATA_ROOT CHAT_ID RUN_ID NEW_OUTPUT_DIRECTORY
npm run research:grade -- PACKAGE_JSON FIXTURE_JSON NEW_RESULT_JSON
```

`DATA_ROOT` is the harness `.data` directory. The inspector reads SQLite in
read-only mode and exports package, audit, report and a blank review sheet. It
never overwrites an existing output directory. Keep outputs in Git-ignored local
storage: captured reports and league context are not public fixtures.

## Review rubric

Record reviewer, review time and package hash. For every finding inspect subject
and affected player, exact source support, attribution/classification, timing and
game scope. For each checklist item use correct, unsupported, missed supported
answer, justified unknown, not checked, or not reviewed, with a reason and source
reference. Do not mark every unknown as an error. Do not award coverage merely
because an article mentions the player. Evaluate missed answers against frozen
available evidence; later web discoveries are not observation-time ground truth.

Report correct and unsupported findings, missed known answers and justified gaps
separately. Report model/tool calls, source/capture failures, elapsed time and token
usage separately from quality. Cost stays null unless reliable per-run billing
is available; cached input tokens are not equivalent to uncached billed tokens.

Before expanding to forecasting, run all six cases with the model, review failed
cases, and test a small live set with varied situations. Require no unsupported
status claims or teammate/target confusion, no lost evidence on failure, and
capture-backed known answers in the answerable controlled cases. These are
development release checks, not statistical accuracy or predictive calibration.
Preserve failed runs and use additional unseen cases before claiming generalization.
