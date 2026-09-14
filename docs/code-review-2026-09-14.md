# Code review — 2026-09-14

## Scope

Reviewed the application source, browser UI, sandbox and persistence boundaries,
collector, roster ingestion, orchestration, and evaluation scripts. Ran the existing
suite before changes and added behavioral regression coverage for reproduced bugs.
NFL and NBA workspaces remain separate. Runtime data stays under ignored `.data/`.

## Findings fixed

| Priority | Finding and change | Regression evidence |
|---|---|---|
| P1 | Host artifact writers followed workspace-controlled directory symlinks. A shared directory guard now checks each ancestor for command logs, large tool results, screenshots, and model diagnostics. New artifacts use exclusive creation; tool result filenames use unique audit IDs. | Directory traversal/symlink tests and a large tool result attempted through an external symlink. |
| P1 | Historical replay agents could use browser tools and network access. Replays now allow only `exec` with sandbox networking disabled. | Subprocess replay test verifies the actual provider tool list; existing sandbox tests cover network configuration. |
| P2 | Failed replay attempts without scores counted as zero regret. Reports now expose scored attempt counts and average finite scores only. | A mock replay that creates no recommendation reports one failure, zero scored attempts, and null mean regret. |
| P2 | Run deadlines started after memory refresh, allowing that provider call to exceed the run budget. The outer run now owns the deadline; memory refresh propagates aborts. | A delayed mock memory response exceeds the budget and the run stops without another provider call. |
| P2 | Stale scoreboards updated team metadata before the stale-data check; string comparisons mishandled timestamp offsets. Check retrieval instants before mutations and normalize incoming timestamps. | Stale metadata preservation, offset timestamps, invalid dates, transactional rollback, and completed-game protection. |
| P2 | Duplicate and overlapping roster assignments were silently collapsed by sets. Both the Python refresh and TypeScript reader reject them while accepting repeated empty slots. | The same invalid snapshots are checked against both implementations. |
| P2 | Null or non-string chat text caused server errors. Validate the request text before trimming. | Malformed message bodies return HTTP 400. |
| P2 | Live reload emitted literal escaped newline characters and excluded the loopback IPv4 hostname. Correct SSE framing and explicit localhost matching. | Exact stream framing and a browser request to the live-reload endpoint. |

## Validation

From this repository:

```sh
RUN_BROWSER_TESTS=1 HARNESS_REAL_DOCKER_TESTS=1 npm test
npm run typecheck
git diff --check
```

Result: **53 tests passed, zero failed or skipped**, and TypeScript checking passed.
The baseline contained 46 tests, including two opt-in tests skipped by default.
Browser checks and real Docker stop/remove/recreate recovery ran successfully;
the latter preserved a text file and SQLite data in a disposable host workspace.
Provider calls in regression tests use local mocks; this is not a model-quality evaluation.

## Remaining boundaries

- The server uses a configured LAN interface and has no application authentication.
  Access therefore depends on the trusted local network. Remote/multi-user deployment
  requires an explicit authentication and isolation design.
- Artifact checks reject existing symlinks; they do not establish protection against
  every concurrent filesystem mutation by a hostile host process.
- No paid provider calls or live sports-feed acceptance tests were run. Historical
  replay tool restrictions do not remove facts already present in model weights.
- Prior persistence audit gaps were checked against current code. History retrieval,
  bounded output, atomic uploads, download retention, and Docker recovery already had
  implementations; this review exercised their tests rather than treating the older
  audit plan as current implementation status.
