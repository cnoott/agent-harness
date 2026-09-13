# Workspace commands

Each `commands/<name>.json` registers a reusable agent workflow. The command menu and `/help` read these files automatically; never maintain a separate help list. Commands belong to this sport's shared workspace. `/help` is reserved.

Names use lowercase letters, digits, and hyphens, start with a letter, and are at most 32 characters. Files must be under 16 KB:

```json
{
  "description": "One sentence explaining what this does and which script it uses.",
  "instructions": "Run python scripts/example.py using exec, verify success and freshness, then explain the result."
}
```

Descriptions are at most 240 characters; instructions are at most 12000. Save scripts under `scripts/`. Before registering a command, run and validate the workflow, document its inputs and saved outputs, and check that its name is unused. Write a temporary file and rename it into place so readers never see partial JSON. Do not overwrite another command without the user's request. Keep credentials out of definitions and scripts. Commands use the agent's existing tools and permissions; registration does not grant new permissions or schedule work.

After registering, tell the user the exact slash command and what it does. The menu reloads when opened, after a run, and when switching chats. `/help` always reads the current registry. Invalid entries are reported and skipped. The server never executes command scripts on the host; instructions go through the normal agent loop and sandbox.

`/roster` is initially supplied in NFL workspaces for Sleeper. Read the script before modifying it. Template files are only installed if absent, so existing scripts and custom definitions are preserved.
