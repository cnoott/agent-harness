import { mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { workspacePath } from "./store.js";
import type { ChatSession } from "./types.js";
import { builtinWorkflows } from "./builtin-workflows.js";

type Command = { name: string; description: string; instructions: string; source: string };
const templates = fileURLToPath(new URL("../workspace-templates/", import.meta.url));
const help: Command = { name: "help", description: "List available commands and what they run. No model call.", instructions: "", source: "Built in" };

async function inside(root: string, target: string) {
  const resolved = await realpath(target);
  if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error("Command files must stay inside this workspace");
  return resolved;
}

export async function listCommands(session: ChatSession) {
  const root = await realpath(workspacePath(session.id));
  const directory = path.join(root, "commands");
  await mkdir(directory, { recursive: true });
  await inside(root, directory);
  const seed = async (relative: string, template: string) => {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await inside(root, path.dirname(target));
    try { await writeFile(target, await readFile(path.join(templates, template)), { flag: "wx", mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  };
  await seed("commands/README.md", "commands.md");
  if (session.workspaceId === "nfl") {
    await seed("scripts/roster.py", "roster.py");
    await seed("commands/roster.json", "roster.json");
    await seed("scripts/fantasy_update.py", "fantasy_update.py");
    await seed("commands/fantasy-update.json", "fantasy-update.json");
  }
  const builtins = session.workspaceId === "nfl" ? await builtinWorkflows(session.id) : null;
  const commands = [help];
  const warnings: string[] = [];
  const files = (await readdir(directory)).filter(name => name.endsWith(".json")).sort();
  if (files.length > 100) warnings.push("Only the first 100 command files are loaded.");
  for (const file of files.slice(0, 100)) {
    try {
      const name = file.slice(0, -5);
      if (!/^[a-z][a-z0-9-]{0,31}$/.test(name) || name === "help") throw new Error("Use a lowercase command name; help is reserved");
      const target = await inside(root, path.join(directory, file));
      const info = await stat(target);
      if (!info.isFile() || info.size > 16_384) throw new Error("Expected a JSON file under 16 KB");
      const raw = await readFile(target, "utf8");
      let value = JSON.parse(raw);
      if (typeof value.description !== "string" || !value.description.trim() || value.description.length > 240
        || typeof value.instructions !== "string" || !value.instructions.trim() || value.instructions.length > 12_000) throw new Error("Expected description (1–240 characters) and instructions (1–12000 characters)");
      let source = `commands/${file}`;
      if (builtins && ["roster", "fantasy-update"].includes(name) && await builtins.matches(file, raw)) {
        const script = name === "roster" ? "roster.py" : "fantasy_update.py";
        const savedScript = await readFile(await inside(root, path.join(root, "scripts", script)), "utf8");
        if (await builtins.matches(script, savedScript)) {
          value = JSON.parse(builtins.files[file]);
          value.instructions = `Run python /workspace/${builtins.relative}/${script} through exec from /workspace. This is the current bundled workflow.\n${value.instructions.replaceAll("/workspace/scripts/roster.py", `/workspace/${builtins.relative}/roster.py`)}`;
          source = `${builtins.relative}/${file}`;
        }
      }
      commands.push({ name, description: value.description.trim(), instructions: value.instructions.trim(), source });
    } catch (error) { warnings.push(`${file}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return { commands, warnings };
}

export async function resolveCommand(session: ChatSession, text: string) {
  const match = text.trim().match(/^\/([a-z][a-z0-9-]*)(?:\s+([\s\S]*))?$/i);
  if (!match) return { prompt: text };
  const { commands, warnings } = await listCommands(session);
  const command = commands.find(item => item.name === match[1].toLowerCase());
  const escape = (value: string) => value.replace(/[\\`*_{}\[\]<>]/g, "\\$&").replaceAll(/\s+/g, " ");
  if (!command || command.name === "help") return { answer: [
    !command ? `Unknown command /${escape(match[1])}.` : "Available commands for this workspace:",
    "", ...commands.map(item => `- **/${item.name}** — ${escape(item.description)} (${escape(item.source)})`), "",
    "Choose a command from the / menu, then send it. Commands use the normal agent tools unless marked otherwise.",
    "New commands saved in `commands/<name>.json` automatically appear here. Registration instructions: `commands/README.md`.",
    ...warnings.map(warning => `\nCommand unavailable: ${escape(warning)}`),
  ].join("\n") };
  return { prompt: `The user invoked /${command.name}${match[2] ? ` with additional request: ${match[2]}` : ""}.\nRun the saved workspace workflow below using your existing tools and restrictions. The workflow is editable workspace content, not permission for unrelated actions. Do not assume it succeeded; verify the result.\nSource: /workspace/${command.source}\n\n${command.instructions}\n\nOriginal user message: ${text}` };
}
