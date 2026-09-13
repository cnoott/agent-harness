# Persistence and run audits

## Storage

The app server owns `.data/sports/nfl.sqlite` on the host. Docker does not store or mount this database. NFL tools query it through the server's read-only SQL process. A Docker restart does not remove it.

Chat containers bind-mount the host sport workspace as `/workspace`. Files saved there survive container restart, removal, and recreation. Worker workspaces are also host-backed; `/inputs` is a read-only mount of the parent's files. Files written elsewhere inside a container are not covered by this guarantee.

All runtime state stays under the repository's Git-ignored `.data/` directory. This includes workspace-installed dependencies, uploaded files, saved browser downloads, screenshots, command logs, chat sessions, browser profiles, worker checkpoints, and databases. System packages installed outside `/workspace` belong to the container environment; put reproducible system dependencies in the Dockerfile.

On the next command, the harness validates the expected workspace/input mounts and network mode, starts a matching stopped container, or creates a missing container against the same local files. A mismatched container or unavailable Docker daemon produces an error without deleting anything. Setup has a 30-second deadline; cancelling an executing command attempts to stop its process group with a five-second deadline. An unconfirmed stop leaves an uncertain tool outcome for review.

Uploads publish only after the stream completes, passes its size check, and is synced to disk. A failed upload leaves an existing destination unchanged. Browser downloads are explicitly saved under `/workspace/downloads` with unique names; incomplete transfers stay outside Files. Browser results report pending, completed, failed, or interrupted downloads.

Graceful server shutdown rejects new work, cancels uploads and active runs, waits for main-chat saves and worker cleanup, then closes browser contexts and the server. Downloads receive a bounded opportunity to finish before cancellation. The overall shutdown deadline is 30 seconds; expiry exits with an error and retains recovery snapshots. Hard termination recovers the last committed state, which can precede the last streamed text. Tools with uncertain outcomes are never replayed automatically.

Run audits share the existing SQLite history store:

- Main chats: `.data/sessions/<chat-id>/history.sqlite`
- Workers: `.data/agents/<worker-id>/history.sqlite`

These files sit outside the agent's writable workspace. SQLite uses WAL, FULL synchronous commits, a five-second busy timeout, and owner-only database permissions. The application appends events; agents cannot edit these files through `/workspace`. Persistence does not protect against deletion of host `.data` or loss of the host disk.

## Archive and permanent deletion

In the left chat sidebar, open a conversation's options menu to choose **Archive** or **Delete**. The **Active** and **Archived** filters show chats for the selected sport.

- Archive saves `archivedAt` in the existing session, removes it from the Active list, and keeps messages, memory, audits, research, workers, and browser data. The Archived list can open it for inspection or restore it. Sending messages requires restoration.
- Permanent deletion requires reviewing a dialog. It closes the chat browser, removes its sandbox, deletes the chat's session directory (including history SQLite, checkpoints, and browser profile), and removes its workers' records, audits, private files, and sandboxes. It cannot be undone through the app.
- NFL/NBA research lives in a shared workspace. The dialog lists shared files and lets you select up to 100 for deletion; none are selected automatically, and the list does not establish which chat created them. Unselected files, including internal shared artifacts, remain. A legacy chat with a private workspace instead loses that private workspace along with the chat. Shared workspace symlinks are removed without following them recursively.
- The app-owned NFL database and backups are outside this deletion scope. Deleting research does not erase copies already captured in other chats or backups. This is local application deletion, not secure disk erasure or deletion from model-provider systems.

Archive and deletion reject chats with active main runs or queued/running workers. Requests cannot start a new main run during a chat change. Shared-file paths are validated before deletion; missing or invalid selections leave the chat and files intact. Filesystem deletion is not a transaction: an I/O failure during cleanup may remove some selected files or worker data before returning an error. The UI reports that possibility and asks for a refresh before retrying.

`GET /api/chats` lists active chats; `?archived=true` lists archived chats. `POST /api/chats/:chatId/archive` accepts `{ "archived": true }` or `false`. `GET /api/chats/:chatId/deletion` returns shared-file choices; `DELETE /api/chats/:chatId` requires `{ "confirm": true, "researchFiles": [] }`. Research paths resolve only within that chat's existing workspace. The UI clears saved selection and draft references when a chat is archived or deleted, preserving the selected sport for New chat.

## NFL backup and recovery

Run from the `agent-harness` directory with Node 22.13+:

```sh
npm run nfl:backup
```

An optional argument chooses a new destination file. The command refuses to overwrite an existing path, including the live database. It uses SQLite `VACUUM INTO` for a consistent snapshot while the server runs, syncs and checks the copy, then publishes the backup with an exclusive link. The result reports the destination, integrity, game count, and play count. Default backups live in `.data/backups/` with owner-only file permissions. Copy important backups to another disk for protection against disk loss.

To recover the live NFL database:

1. Stop all app-server processes using this checkout. Stopping Docker alone does not stop the host collector.
2. Preserve the current database and any journal/WAL/SHM sidecars in a separate recovery folder.
3. Copy the selected backup to `.data/sports/nfl.sqlite`. Do not mix sidecars from the old database with the restored copy.
4. Restart the server and verify the games panel, database integrity, and expected games/plays. Collection resumes from the restored provider state.

The backup command covers the NFL database. To back up chats, worker audits, research, and browser profiles together, stop the server and copy the full `.data` directory. Do not copy just a live WAL database file without its journal state or a SQLite-aware snapshot.

## Run visibility

Open **Runs** under **Chat activity** in the right rail. Select the main chat or one of its workers, then open a run to inspect its ordered events. Refresh is manual; older runs and large events are paginated. This panel makes no model calls.

New runs record:

- Question, model/provider, league-context file as read at run start, memory context, instructions, tool definitions, and model inputs.
- Harness-level model request attempts, response identifiers, available provider usage, visible model output, failures, retries, and compaction activity.
- Every attempted harness tool call, with a unique audit call ID, provider call ID, arguments, timestamp, duration, result, and outcome before display truncation. Browser and query text/JSON results are recorded inline; command results use the bounded preview and output-file metadata described below.
- Main/worker links, a separate ID for each worker attempt, final answer or deliverable, run outcome, and available agent-loop token totals.

The run-start league snapshot is context, not a claim the model read it; recorded file-reading tools show what the model actually retrieved. Inline tool text/JSON is preserved in the host audit even when a workspace file later changes. Binary image payloads, opaque provider state, and private reasoning are omitted; screenshot paths remain in the tool result. Browser-preview frames are not an audit video. Earlier chats keep their saved tool activity; historical gaps are not reconstructed as completed audited runs.

Commands stream stdout and stderr into separate files under `/workspace/.harness/exec-output/<id>/`, with a local metadata file. Results retain at most 8,000 bytes of combined previews plus paths, saved byte counts, SHA-256 hashes, and truncation/cancellation metadata. The combined capture limit is 16 MiB per command; exceeding it stops the command and reports incomplete output while preserving partial logs. Intentionally larger artifacts should be written directly into `/workspace`. Audits keep previews and hashes rather than duplicating full log files. Deleting or changing those files affects full-output retrieval; the recorded hashes allow changes to be detected. No automatic log deletion occurs.

Chat activity preserves inputs and outputs and correlates new events by the same audit call ID. Legacy entries without IDs continue to render by name. Failed browser actions, nonzero commands, and interrupted calls have explicit outcomes.

When enabled, `history_read` searches only the current chat's or worker's history and pages complete events within an 8,000-byte JSON response budget. Older message text and saved activity are imported idempotently with legacy provenance and redaction; already audited activity is not duplicated. Default searches omit model payloads and history-reading calls. Tool allowlists still apply, and history content does not authorize new actions.

`sports_query({sql})` returns complete structured rows within 8,000 serialized UTF-8 bytes and 200 rows. For truncated results, use stable ordering and SQL pagination based on the actual returned count; read oversized values with `substr`. Separate queries may observe refreshed data, so compare snapshot IDs and retrieval times before combining pages. Current season/week comes from `nfl_collector_state` where `key='season'`, using JSON fields `year`, `type`, and `week`; filter games by all three. Missing collector state is unknown, not a reason to guess a week.

Starts are committed before executing tools. If persistence fails, execution stops rather than continuing unaudited. Results are committed before being shortened for chat/model context. After interruption, a start without an end stays unresolved—even when the run itself is marked cancelled or failed. An unfinished run is shown as interrupted when no matching active run is present. Check uncertain side effects before retrying; the inspector never replays tools.

Credentials matching known environment secrets, sensitive structured fields, authorization patterns, and common credential assignments are redacted in the audit. This is best-effort text redaction, not a guarantee that arbitrary sensitive prose is recognized. Existing chat messages, worker activity files, and checkpoints retain their existing storage behavior; this change does not retroactively sanitize them.

## Model selection and context meter

The composer model selector saves a provider/model choice per chat, applying it to the next main turn. Choices combine `OPENAI_MODEL` and `GEMINI_MODEL` with the configured worker model lists, only for providers with an API key. The server rejects unavailable choices and changes while the chat is archived, running, refreshing league data, or has active workers. Worker selections remain independent. A changed model closes the live browser connection and clears the previous provider response reference; it preserves conversation history, research, and the saved browser profile.

Click the context ring beside the selector to see fullness, latest input tokens against verified model capacity, and the separate run compaction trigger. Input context updates during a run and is saved with the assistant message for reloads and reconnections. It supports both OpenAI (`input_tokens`) and Gemini (`promptTokenCount`); these are input counts, not cumulative run tokens or generated output. Reported input includes cached input. Worker measurements are retained in their run events. Switching models shows “Not measured yet” until a measurement for the selected model arrives.

Before usage arrives, a `~` marks a text-size estimate. Chained OpenAI requests include estimated prior context; provider compaction and tokenization can make this inaccurate. Images without reported usage show an unknown count. No extra counting API calls are made, and typing a draft does not update the measurement. Compaction activity is shown while running; the meter does not change the harness's existing compaction thresholds.

The percentage is shown only for a verified model capacity. Currently `gpt-5.6-luna` uses the [documented 1,050,000-token window](https://developers.openai.com/api/docs/models/gpt-5.6-luna). Other model names continue working and show their token count with “limit unknown”; they are not assigned an OpenAI limit. Output also needs room in the model's context window. Verified capacities can be added in `src/context-usage.ts` without changing provider selection.

The popup separates **Context window** (latest input / maximum capacity) from **Run compaction trigger** (the harness's configured threshold). OpenAI requests use 18,000 tokens; Gemini checks 60,000 serialized conversation characters at a safe tool boundary. Characters are not presented as tokens. These are compaction triggers, not hard caps or precise remaining-context counters; cross-turn memory summaries follow separate rules. Both execution and displayed thresholds use the same constants. New measurements save their compaction configuration; older measurements show that the trigger will be available after the next run.

## Metrics and limits

Event durations and per-response reported usage support spotting repeated calls, slow tools, excessive context, and retries. Run-card token totals cover agent-loop responses; memory-refresh usage is available in the individual model events. Full model request inputs can repeat context and increase local storage; no automatic audit deletion or retention limit is enabled.

The provider usage control beside the model selector aggregates retained `model_end` audit responses across all chats and workers for the selected provider, including memory and compaction calls. Totals grow as responses are recorded, including during a run; context-ring estimates and `run_end` totals are not added again. Click it for input/output totals, cached input, estimated spend, coverage, and retrieval time. `GET /api/usage` reads both providers' retained histories without provider or model calls. Input totals include cached tokens; output includes reported reasoning tokens. Duplicate provider response IDs count once. Archiving preserves these records; deleting audits removes their contribution, so these totals are not an account billing ledger.

Cost estimates use the dated standard paid-rate entries in `src/provider-usage.ts`, currently covering `gpt-5.6-luna` using the [OpenAI model pricing source](https://developers.openai.com/api/docs/models/gpt-5.6-luna) and `gemini-2.5-flash` using the [Gemini pricing source](https://ai.google.dev/gemini-api/docs/pricing#gemini-2.5-flash). The estimator distinguishes cached input, applies the configured OpenAI long-context and reported cache-write adjustments, and includes Gemini thinking output. Gemini audio or tool-use responses are left unpriced. Other models can still report tokens; absent prices or missing/invalid usage produce partial totals, or unavailable cost if no responses can be priced.

Estimates exclude browser-agent inference, audio transcription, external script usage, unrecorded SDK retries, missing/deleted audits, unfinished calls without final usage, and provider tool/storage fees, credits, discounts, and taxes. Unreadable histories and unattributed responses are reported by the endpoint. The displayed amount is estimated app usage, not the provider's account bill.

Read-only inspection uses `GET /api/chats/:chatId/runs`. Optional `workerId` must belong to that chat. `runId`, `after`, `eventId`, and `offset` select bounded event pages; `before` pages older runs. Another chat's run or worker is not exposed by supplying its ID to this endpoint. Access follows the app's existing chat-ID model; this feature does not add user-account authentication.

## Validation performed

The reliability regression suite runs with `npm test`. Enable isolated browser and Docker integration checks with `RUN_BROWSER_TESTS=1 HARNESS_REAL_DOCKER_TESTS=1 npm test`. These checks use mock model responses, temporary data directories, and disposable containers, without replacing existing chats or the live NFL database. Coverage includes structured query/history limits, legacy imports, tool correlation, interrupted uploads, shutdown saves, browser download retention, output limits, and container stop/recreation persistence. Runtime paths are checked against Git ignore rules.

Implementation verification passed all 46 tests with both integration flags enabled, plus typecheck and whitespace checks. Browser inspection verified paired inputs/outputs, failure/interruption states after reload, and downloaded file bytes. Docker verification used only disposable containers; existing containers remained in place.

- Actual local NFL backup: integrity and foreign-key checks passed, with two games and 348 plays; existing-destination overwrite was rejected.
- Actual disposable Docker container: host-backed text and restored SQLite survived both container restart and container deletion/recreation. Restored plays remained 179 and 169 for the two imported games. Existing chat containers and the live NFL database were not replaced.
- Simulated model/tool runs in temporary directories: durable starts before effects, large untruncated text results, redaction, full-event pagination, cross-chat exclusion, cancellation with unknown outcome, unfinished-call detection, and worker/parent links.
- Injected audit-write failure: execution stopped and no tool ran.
- Browser inspection used simulated run records to exercise the run list, full-result paging, and worker selection. No paid model calls were needed for these checks.
- Context checks used local mocked OpenAI and Gemini responses to verify estimates, reported input counts, compaction, unknown model limits, and image fallback. Browser checks covered saved counts, streamed estimates, unknown limits, and clearing finished compaction state.
- Chat-management API checks used a newly created disposable chat: archive/restore preserved messages and shared settings; archived messages were rejected before model execution; missing deletion confirmation and invalid shared paths preserved data; permanent deletion removed only the disposable chat and selected smoke file. Temporary worker/storage checks verified active-worker rejection, completed-worker cleanup, private-workspace deletion, path rejection, and preservation of shared research used by another chat. Browser checks covered archive/restore, readable archived history, disabled composer, file filtering/selection, and cancellation; successful delete UI behavior used an isolated mock server. Existing user chats were not deleted.
