# Sandbox Harness

A deliberately thin local agent harness: an OpenAI or Gemini model can use a persistent Docker workspace and a Stagehand-controlled browser through a simple chat interface.

## What it includes

- Shared persistent files, including SQLite (`sqlite3`) so the agent can create task-specific databases and schemas. New chats default to the current workspace; the new-chat picker can select an existing workspace or create a named, empty workspace that later chats can reuse.
- One Docker sandbox per chat, with the selected workspace mounted at `/workspace`. Chat history and browser profiles remain per chat.
- A small tool set: `exec`, `browser_open`, `browser_observe`, `browser_act`, `browser_extract`, and `browser_screenshot`.
- A direct OpenAI Responses API or Google Gemini API tool loop with streamed text and visible tool activity.
- File upload, browsing, explicit downloads, and confirmed deletion in the workspace UI.
- Markdown responses, including tables and code blocks, plus collapsed tool activity inside each assistant response. New tool activity is saved with chat history; older chats still show their saved text.
- Enter sends a message; Shift+Enter inserts a new line. The microphone records up to five minutes, then uses OpenAI Whisper (`whisper-1`) to add an editable transcript to your draft. Stop recording to transcribe, or Cancel to discard it.
- Agent-turn requests retry temporary HTTP 500/502/503/504 failures up to three times, waiting 2, 4, and 8 seconds. Retries preserve tool results and stop if response output has already started; retry status appears in the activity log.
- Empty Gemini completions and `MALFORMED_FUNCTION_CALL` responses without visible text share a two-retry limit with short delays. Malformed responses are discarded without executing their tools; retries preserve conversation state and include tool-schema guidance. Responses that already emitted visible text stop to avoid replaying a partial answer. Abnormal completions save metadata (no prompts, screenshots, or credentials) under `/workspace/.harness/model-diagnostics`; blocked or incomplete responses stop with their specific reason.
- The agent is instructed to validate extracted row counts and required fields against the source before analysis and retry incomplete extraction.
- Failed browser actions return a fresh observation and viewport screenshot. Immediate repeats of an unsuccessful action are blocked on an unchanged page; explicit observation, navigation, or manual control clears the guard. Errors thrown by the browser service remain retryable after inspection.
- Screenshot requests and failed browser actions send actual images to the selected model. Images stay out of text tool logs; PNG artifacts remain available in the workspace. Gemini keeps only the newest batch of screenshots in the current turn's context.
- The agent understands manual login in its shared Chromium window and checks the current page when you return control. Finish the agent turn before taking control, then tell it when you are done.
- Each chat keeps a durable SQLite history at `.data/sessions/<id>/history.sqlite`, outside the sandbox and shared workspace. Messages, model completions, tool attempts/results, and run outcomes survive restarts. Existing messages and saved activity are imported automatically; an old summary is rebuilt from its original history when needed.
- The `history_read` tool searches this chat's original records and reads long results in pages. Large tool outputs also remain available under `/workspace/.harness/tool-results`, and screenshots under `/workspace/.harness/screenshots`.
- Context management uses token budgets instead of a fixed message count. Complete user messages are processed in consecutive fragments when necessary; current requests using at most a quarter of the input budget also remain verbatim after compaction. Structured task checkpoints preserve goals, constraints, decisions, findings, completed actions, and pending work. Each candidate is checked in a second model pass before its state and exact source cursor are committed together; older checkpoint versions remain stored. Invalid, incomplete, oversized, or non-shrinking checkpoints are rejected. If full history cannot fit and compaction fails, the run stops with its history retained.
- `HARNESS_CONTEXT_TOKENS` defaults to `32000` (allowed: `16000`–`200000`), with `8192` tokens of headroom. Cross-turn compaction uses UTF-8 size estimates; Gemini additionally counts conversation tokens before each model step, estimates instruction/tool overhead, and rebuilds oversized tool conversations from durable records. OpenAI uses Responses API server-side compaction within a turn. Checkpoint model calls are included in run token statistics.
- On continuation after an interrupted run, the agent receives references to tool attempts with uncertain outcomes and is instructed to inspect state before retrying. This does not automatically replay actions or guarantee exactly-once execution of shell commands and browser actions.

## Prerequisites

- Node.js 22.13 or newer (for built-in SQLite)
- Docker Desktop running
- An OpenAI or Google Gemini API key

## Run it

```bash
cp .env.example .env
# Add OPENAI_API_KEY or GEMINI_API_KEY to .env
npm install
npm run sandbox:build
npm run dev
```

Open `http://127.0.0.1:3000`.

`npm run dev` watches the server and automatically refreshes open local harness tabs after a code change.

Voice input requires `OPENAI_API_KEY` in `.env`, even when Gemini handles the chat. The key stays on the server; recordings are sent to OpenAI for transcription and are not saved in the workspace. Your browser must allow microphone access and use HTTPS or localhost (plain HTTP on a LAN IP cannot access the microphone). For local microphone use, run `HOST=127.0.0.1 npm run dev` and open `http://127.0.0.1:3000`. Transcripts are never submitted automatically.

### Using Gemini

Set these values in `.env` (keep your key private):

```dotenv
MODEL_PROVIDER=gemini
GEMINI_API_KEY=your-gemini-api-key
GEMINI_MODEL=gemini-2.5-flash
```

Restart the server after editing `.env`. Chat, durable memory, and browser actions all use the selected provider. Gemini does not require an OpenAI key.

Set `MODEL_PROVIDER=openai` to switch back. If `MODEL_PROVIDER` is blank, the harness selects Gemini when only `GEMINI_API_KEY` is set; otherwise it defaults to OpenAI. When both keys are present, set the provider explicitly.

The Gemini integration uses Google's [Gen AI JavaScript SDK](https://googleapis.github.io/js-genai/release_docs/) and Stagehand's [Google model support](https://docs.stagehand.dev/v3/configuration/models).

## Notes

- The default shared workspace lives at `.data/workspaces/shared`. Each new UI chat links `.data/sessions/<id>/workspace` to its selected folder, so uploads, downloads, and agent commands all use the same files. Earlier chats keep their existing folders and can share them with new chats through the picker; files are not moved or merged. Replay and shadow-evaluation scripts still create isolated workspaces.
- The browser uses CloakBrowser's persistent Chromium profile with Stagehand attached in `LOCAL` mode for browser actions. CloakBrowser manages graceful browser shutdown to save login storage. CloakBrowser downloads its binary on the first browser session; the host does not need a separate Chrome/Chromium installation.
- Each chat saves its Chromium profile at `.data/sessions/<id>/browser-profile`, outside the Docker workspace and file-download routes. Sign in once in the harness browser after enabling this; persistent cookies and site storage are reused when you reopen the same chat after a restart. Existing temporary browser logins are not migrated. New chats have separate profiles, and sites can still expire logins. Profiles are local and excluded from Git.
- The agent has broad control over its own Docker workspace. This is a prototype harness, not a hardened multi-user environment.
- `OPENAI_MODEL` defaults to `gpt-5.6-luna`; set it in `.env` to use another model your account supports.
- `GEMINI_MODEL` defaults to `gemini-2.5-flash`; set it in `.env` to use another Gemini model your account supports.

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
The selected model must match the registered protocol's `model`. For a Gemini
shadow test, register a separate protocol with a new `id` and the Gemini model
name before prediction; the existing OpenAI protocol remains fixed.
Results are written under `.data/evals/shadow/nba-shadow-final-five-v1/` as
sealed artifact bundles, `report.json`, `REPORT.md`, and `results.sqlite`.
