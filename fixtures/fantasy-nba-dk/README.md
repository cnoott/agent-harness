# NBA fantasy lineup evaluation fixture

This is a controlled, pre-game-style evaluation fixture for the harness. It
tests whether an agent can inspect a roster, apply legal lineup constraints,
persist its analysis, and make a recommendation without seeing the outcome.

`visible/` is the only directory copied into the agent's `/workspace` during a
run. `hidden/actual-outcomes.json` is withheld until the recommendation has
been written and is used only by the grader.

The fixture is intentionally small. It validates the workflow, not a claim of
production-grade forecast accuracy. A later historical-data adapter can
replace these files with sourced pre-game snapshots and official box scores
without changing the agent contract.

## Agent contract

The agent receives:

- `visible/slate.json`: roster candidates, eligibility, scoring and pre-game
  indicators.
- `visible/request.md`: the requested result.

It should create:

- `/workspace/recommendation.json` with `lineup` (an array of player IDs) and
  an optional `projected_points` mapping.
- A concise `/workspace/recommendation.md` explaining the choice.
- `/workspace/fantasy.sqlite`, containing at least a `recommendations` table
  with the chosen lineup and the slate's `as_of` timestamp.

The valid slots are `PG`, `F`, and `UTIL`; a player may appear only once.
