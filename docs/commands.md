# Slash commands

Click **/ Commands** beside Attach, or type `/` in the composer. The menu filters as you type and shows each command's description and definition file. Select a command, optionally add a request, then send it. Arrow Down moves from the draft to the choices; arrow keys move between choices; Enter selects and Escape closes the menu. Selecting a command does not execute it.

- `/help` lists the current workspace's commands. It reads the registry directly, makes no model calls, and saves the result in chat and Runs.
- `/roster` is supplied in NFL workspaces. The agent runs `scripts/roster.py` through its existing `exec` tool and explains the fresh roster. `/roster show only my bench` supplies an additional request. This uses the configured chat model for execution decisions and presentation; the script itself makes no model calls.
- Unknown command names return help without starting the model. NBA starts with `/help`; no NFL command is advertised there.

Commands are reusable agent instructions, not a separate execution engine. They keep normal tool restrictions, cancellation, run auditing, and workspace boundaries. The server never executes their scripts on the host. Natural-language questions can reuse the same saved scripts.

## Adding a command

The registry is the selected sport workspace's `commands/` directory. Each `<name>.json` contains `description` and `instructions`. Its filename determines the slash name. For example, after creating and validating a script:

```json
{
  "description": "Refresh my league settings using scripts/league.py.",
  "instructions": "Run python scripts/league.py through exec. Verify success, report the retrieval time, and cite the saved output."
}
```

Saving that as `commands/league.json` registers `/league`. This is an example; `/league` is not preinstalled. Read `commands/README.md` in the workspace for the format and registration rules. Agent instructions tell it to validate a requested reusable workflow, register an unused name, verify the saved file, and tell the user how to invoke it. This does not automatically turn every script into a command.

**There is no separate help document to maintain.** The menu reloads when opened, after runs, and on chat changes; `/help` reads the current files on every invocation. Same-sport chats share commands, while NFL/NBA stay separate. Definitions must remain within that workspace. Invalid JSON, reserved `/help`, oversized definitions, and invalid filenames are skipped with a visible warning. Up to 100 definition files are loaded. Credentials do not belong in these files.

The app seeds registration instructions and the NFL roster workflow when commands are first loaded, including for existing chats. It never overwrites existing definitions or scripts. Workers can propose definitions and scripts as artifacts for the parent to install in the shared workspace.

## Roster data

Open **Teams** under **League** in the right rail to browse a searchable **League overview** from the saved NFL snapshot. Team cards show names, owners, win–loss records when known, roster size, and QB/RB/WR/TE counts. Search finds rostered players, team names, and owners across the league.

Choose a team card to open **Trade builder**. Your roster and the partner's roster scroll independently, with a position filter; starters follow saved lineup order, and bench, reserve, and taxi players remain separate. The **You send / You receive** package keeps selections visible, with individual remove controls and **Clear all**. Returning to the overview preserves the package and shows its selected-player count on **Trade builder**. Reopening the same partner keeps both sides; choosing another partner keeps outgoing players and clears incoming players.

**Discuss trade** or **Explore trade ideas** adds a reviewable question to the chat draft, preserving team/roster IDs, selected player IDs, source path, and retrieval time. Opening views and choosing players make no model calls or transactions. The user reviews and sends the draft through normal chat.

**Ask agent to refresh** adds `/roster` to the composer. The panel reads saved files when opened and after chat runs; it makes no provider or model calls itself. Existing draft text is preserved when adding a question. On narrow screens, Teams opens over the chat; adding a draft closes the panel and focuses the composer. Missing configuration, missing snapshots, unreadable data, and missing player names have separate messages. NBA chats cannot access the NFL endpoint; their Teams and Waivers views show the unconnected ESPN Fantasy state.

`GET /api/chats/:chatId/nfl/rosters` resolves the league and selected roster from that chat's trusted NFL workspace and `LEAGUE.md`, validates the latest saved snapshot, and returns normalized rosters. It accepts no league or file-path override and never fetches Sleeper directly. JSON reads are size-bounded and confined to the workspace. Refresh failures keep the previous display with an error and its original timestamp.

The script reads the confirmed league and roster IDs from `LEAGUE.md`; `--league-id` and `--roster-id` allow explicit overrides. It uses [Sleeper's documented read-only API](https://docs.sleeper.com/) without a browser login. It fetches league settings, every roster, league users, NFL state, and current matchups when the league season matches the current regular/postseason week. Player names use a cached catalog refreshed at most daily, with its own retrieval timestamp.

It validates league identity, roster count, unique roster IDs and player ownership, starter/reserve/taxi membership, owners, and matchup roster coverage. Unknown player names are reported. Incomplete or failed fetches exit nonzero without replacing the last successful league snapshot. The agent must not report old data as refreshed.

Saved data lives under `data/sleeper/<league-id>/` in the sport workspace: a timestamped JSON snapshot plus `latest.json`. Raw league settings, rosters, users, matchups, and normalized selected-roster details are retained. This is an on-request snapshot, not background syncing. It does not submit transactions or establish whether an unrostered player can be claimed immediately.

## My NFL matchup

The **My matchup** view resolves your saved roster against the week's Sleeper `matchup_id`, showing your starters beside the opposing lineup. Weekly starter order comes from the matchup snapshot rather than the current roster's starter list. Your bench is collapsible. Team totals use Sleeper's `custom_points` when supplied, including zero, otherwise its reported `points`; commissioner overrides are labeled. Missing scores remain unknown. Totals are not forced to equal the displayed player sum.

Player NFL teams join the cached ESPN schedule only when season, season type, and week agree. Kickoffs use the browser's local time; current-game clocks and final status come from that saved schedule. Washington's Sleeper `WAS` identifier maps to ESPN `WSH`. Missing, ambiguous, postponed, or stale games do not count as known upcoming/live/final games. These counts describe the starters' team games, not guaranteed player participation or fantasy-slot eligibility. Empty slots and unassigned/ambiguous opponents remain explicit.

**Refresh data** makes no model calls: the server executes the app-owned `workspace-templates/roster.py` through the chat's Docker sandbox, without overwriting the agent's saved script. It refreshes league/roster/matchup data, preserves dated snapshots, and reuses the daily player catalog. This follows [Sleeper's player-catalog caching guidance](https://docs.sleeper.com/#fetch-all-players). Injury catalog time is shown separately and is not represented as a fresh inactive report. **Check my lineup** drafts a question to verify current official injuries, eligible bench alternatives, scoring settings, and lock rules; the user reviews and sends it. No lineup or transaction is submitted by the panel.

`GET /api/chats/:chatId/nfl/matchup` only reads saved data. `POST /api/chats/:chatId/nfl/matchup/refresh` performs the explicit refresh. Both resolve the trusted NFL scope and accept no league/path overrides. Only one UI league refresh runs at a time, with a two-minute deadline and cancellation on server shutdown. Archived chats cannot refresh; chat changes/deletion and a new run on the refreshing chat are blocked until it finishes. The local refresh appears in Runs with source snapshot context. The open view rereads cached server data every minute; it does not automatically fetch Sleeper scores. Errors preserve the previous displayed snapshot.

## Waivers and sport selection

**Waivers** reads the same saved NFL snapshot and player catalog. It excludes players owned by any team, keeps active players eligible for the league's lineup positions, and defaults to players assigned to an NFL team. Search by player or team and filter by fantasy position. Results follow Sleeper's search order, not projections, with 50 players per page. The view shows roster and catalog retrieval times separately. An unrostered player is only a research candidate: current claim timing, waiver rules, and availability are not established by this snapshot.

Select a candidate and optionally a player from your roster to draft a pickup/drop question containing player and roster IDs, source path, and snapshot time. Review and send it through ordinary chat. **Ask agent to refresh** drafts `/roster`; opening or filtering the panel makes no provider or model calls and does not submit transactions.

`GET /api/chats/:chatId/nfl/waivers` resolves the trusted NFL workspace and uses the same bounded snapshot validation as Teams. It accepts `search`, `position`, `teamOnly`, and `offset`, returns 50 candidates plus `nextOffset`, and rejects NBA access. Missing catalogs and incomplete snapshots produce an error rather than an apparently complete player pool.

The NFL/NBA toggle in the right rail restores the last chat for that sport, or displays an empty sport workspace if none exists. The left sidebar lists that sport's chats, and New chat inherits the selected sport. Files, commands, teams, waivers, and game views follow that scope; unsent drafts survive toggle switching during the page session. ESPN Fantasy is the selected NBA provider, but a league URL/ID and an NBA data connection are still needed. The NBA views do not reuse Sleeper NFL data.

## Validation

Temporary registry checks covered registration, automatically updated help, NFL/NBA separation, arguments, unknown commands, invalid/reserved entries, out-of-workspace links, and preservation of existing scripts. Browser checks covered filtering, keyboard selection, help output, registration visibility, and sport switching. The actual server's `/help` saved one answer and a local audit without model execution.

The actual agent loop ran the script inside a disposable Docker sandbox against live Sleeper data, verifying roster reconciliation and starter/bench separation. The model responses selecting the script were mocked; this verifies execution, storage, and audit behavior rather than autonomous model selection quality. Existing TypeScript and worker checks passed.

Teams was checked against a saved snapshot, including player search and a trade draft with correct roster/player IDs. No trade question was submitted during UI validation. Temporary-file checks covered missing settings/snapshots/catalog, partial or malformed snapshots, starter ordering, and cross-sport/path isolation.

Waivers was checked against that saved snapshot: ownership exclusion, position filtering, pagination, and a pickup/drop draft with correct IDs and source freshness. No pickup question or transaction was submitted. Temporary-file checks covered missing catalogs, incomplete rosters, unique candidates, lineup eligibility, and NBA rejection. Browser checks verified NFL/NBA separation; a mocked server verified starting with no NBA chats, creating new NBA chats in the selected workspace, and preserving drafts across toggles. TypeScript and the existing nine worker checks passed.

My matchup was verified against saved Sleeper data and a real model-free refresh from the browser. The completed refresh was recorded in Runs. Temporary data checks covered commissioner zero overrides, missing points, empty slots/byes, duplicate/reduced lineups, invalid scores, season/week separation, Washington mapping, stale schedules, and NBA rejection. A mocked script refresh verified catalog reuse and preservation of `latest.json` on malformed responses. Browser checks covered the lineup-question draft without sending it, bench access, NFL/NBA isolation, and simulated live/unknown game states, injury labels, commissioner overrides, and a provider timeout retaining previous data. Live NFL changes remain simulated in these UI checks.
