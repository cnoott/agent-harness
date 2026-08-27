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
