# Sandbox Harness

A deliberately thin local agent harness: an OpenAI model can use a persistent Docker workspace and a Stagehand-controlled browser through a simple chat interface.

## What it includes

- A persistent workspace per chat at `.data/sessions/<id>/workspace`, including SQLite (`sqlite3`) so the agent can create task-specific databases and schemas.
- One Docker sandbox per chat, mounted at `/workspace`.
- A small tool set: `exec`, `browser_open`, `browser_observe`, `browser_act`, `browser_extract`, and `browser_screenshot`.
- A direct OpenAI Responses API tool loop with streamed text and visible tool activity.
- File upload, browsing, and download in the UI.
- Context management: a rolling durable summary plus six recent messages carry cross-turn state; large tool results are saved under `/workspace/.harness/tool-results` and screenshots under `/workspace/.harness/screenshots` rather than being replayed to the model. Tool-heavy runs use Responses API server-side compaction.

## Prerequisites

- Node.js 22 or newer
- Docker Desktop running
- An OpenAI API key

## Run it

```bash
cp .env.example .env
# Add OPENAI_API_KEY to .env
npm install
npm run sandbox:build
npm run dev
```

Open `http://127.0.0.1:3000`.

`npm run dev` watches the server and automatically refreshes open local harness tabs after a code change.

## Notes

- The browser uses Stagehand in `LOCAL` mode with CloakBrowser's Chromium binary and stealth launch arguments. CloakBrowser downloads its binary on the first browser session; the host does not need a separate Chrome/Chromium installation.
- The agent has broad control over its own Docker workspace. This is a prototype harness, not a hardened multi-user environment.
- `OPENAI_MODEL` defaults to `gpt-5.6-luna`; set it in `.env` to use another model your account supports.

## NBA lineup evaluation

`fixtures/fantasy-nba-dk` is a controlled NBA, DraftKings-style historical
evaluation. The agent receives only `visible/` pre-game-style data and must
write a legal recommendation plus a persistent SQLite checkpoint in its chat
workspace. The hidden outcome file is used only afterwards by the grader.

Run the evaluator after a harness chat has created its artifacts:

```bash
npm run fantasy:grade -- .data/sessions/<chat-id>/workspace
```

The output reports lineup legality, SQLite checkpoint status, realized points,
hindsight-optimal points, and regret. It verifies the harness workflow and is
not evidence of real-world forecast accuracy; replace the fixture with sourced
pregame snapshots and official box scores before making performance claims.

### Historical replay loop

`fixtures/fantasy-nba-replay` contains 20 historical 2023–24 slates generated
from a third-party MIT-licensed box-score dataset derived from NBA data. Every
visible rolling statistic is calculated from games strictly before the target
date; target-date fantasy points live only in each fixture's `hidden/` folder.
The manifest records the source URL, source hash, leakage policy, and important
limitations. These first slates intentionally omit historical injuries,
betting lines, salaries, and DraftKings bonuses.

Rebuild fixtures after downloading the source CSV to the default ignored path:

```bash
npm run fantasy:fixtures
```

Run deterministic baselines without spending model tokens:

```bash
npm run fantasy:replay -- --limit 20
```

Run the real harness agent on a bounded number of slates:

```bash
npm run fantasy:replay -- --agent --limit 3
```

Each agent replay gets a clean chat workspace containing only `visible/` data.
The runner freezes the recommendation, reveals the outcome to the grader, and
stores legality, checkpoint validity, regret, latency, tool calls, and token
usage in `.data/evals/fantasy-replays.sqlite`. Every row includes a fixture
hash so regenerated datasets cannot be compared accidentally. The latest detailed report is
also written to `.data/evals/latest-fantasy-replay.json`.

### One-shot sealed shadow test

The stronger `fantasy-nba-shadow-v1` protocol reserves five agent-unseen
historical slates. It anonymizes player, team, and date identifiers, exposes
only the shell tool, starts Docker with `--network none`, permits exactly one
attempt per slate, and separates prediction from outcome grading into distinct
processes. Predictions and SQLite checkpoints are hashed and sealed before the
grader reads any hidden outcome file.

```bash
npm run fantasy:shadow:register
npm run fantasy:shadow:predict
npm run fantasy:shadow:grade
```

The state machine is `REGISTERED -> PREDICTING -> SEALED -> SCORED`. Prediction
cannot be rerun after leaving `REGISTERED`; failures consume their attempt.
Results are written under `.data/evals/shadow/nba-shadow-final-five-v1/` as
sealed artifact bundles, `report.json`, `REPORT.md`, and `results.sqlite`.
