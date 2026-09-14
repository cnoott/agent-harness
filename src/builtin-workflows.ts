import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { ensureWorkspaceDirectory } from "./store.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const installing = new Map<string, Promise<void>>();
const legacy: Record<string, string[]> = {
  "roster.py": ["ab6caaa9a8e31aefa55ce3cb0eec9e694c3d6f32d43c9c88b58a6426c8892eb8", "e2661e3e2af1b495da92bab5fe41c94ed16bd25ea62e8bf5e48de9f43c4b5971"],
  "roster.json": ["5657a65a6117176b899fced220c0e8ae2143c65aa67f926bae1ad5b12c2aed44"],
  "fantasy_update.py": ["e552ea04b0625f93ad6ae033d3b84185d4ed191ae897200480409a3c78b1f2cb"],
  "fantasy-update.json": ["afcde5b9d3152f4846705484bff5f80dfe24e2686848e9deafbe1be912d65f93"],
};

export async function builtinWorkflows(chatId: string) {
  const names = ["roster.py", "fantasy_update.py", "roster.json", "fantasy-update.json"];
  const files = Object.fromEntries(await Promise.all(names.map(async name => [name, await readFile(new URL(`../workspace-templates/${name}`, import.meta.url), "utf8")])));
  const version = digest(names.map(name => files[name]).join("\n"));
  const relative = `.harness/workflows/${version}`;
  const directory = await ensureWorkspaceDirectory(chatId, relative);
  let installation = installing.get(directory);
  if (!installation) {
    installation = (async () => {
      for (const name of names) {
        const target = path.join(directory, name);
        try { await writeFile(target, files[name], { flag: "wx", mode: 0o600 }); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          if ((await lstat(target)).isSymbolicLink() || await readFile(target, "utf8") !== files[name]) throw new Error("Bundled workflow has been modified; remove its version directory to restore it.");
        }
      }
    })();
    installing.set(directory, installation);
  }
  try { await installation; }
  finally {
    if (installing.get(directory) === installation) installing.delete(directory);
  }
  return { files, relative, async matches(name: string, value: string) {
    const hash = digest(value);
    if (hash === digest(files[name]) || legacy[name]?.includes(hash)) return true;
    // Previous bundles identify untouched defaults without replacing custom workspace files.
    for (const entry of await readdir(path.dirname(directory))) {
      if (!/^[a-f0-9]{64}$/.test(entry)) continue;
      try {
        const previousPath = await realpath(path.join(directory, "..", entry, name));
        if (!previousPath.startsWith(`${path.dirname(directory)}${path.sep}`)) continue;
        const previous = await readFile(previousPath, "utf8");
        if (digest(previous) === hash) return true;
      } catch { /* Incomplete old bundles do not identify a default. */ }
    }
    return false;
  } };
}
