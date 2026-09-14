import { open, realpath } from "node:fs/promises";
import path from "node:path";

type Catalog = { players: Record<string, any>; fetched_at?: string };
const catalogs = new Map<string, { signature: string; value: Promise<Catalog> }>();

export async function readPlayerCatalog(root: string): Promise<Catalog> {
  const target = await realpath(path.join(root, "data/sleeper/players-cache.json"));
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error("Player catalog must remain inside the workspace");
  const handle = await open(target, "r");
  try {
    const info = await handle.stat({ bigint: true });
    if (!info.isFile() || info.size > 40_000_000n) throw new Error("Player catalog is invalid or too large");
    const signature = `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
    const cached = catalogs.get(root);
    if (cached?.signature === signature) return await cached.value;
    const value = (async () => {
      const raw = await handle.readFile("utf8");
      if (Buffer.byteLength(raw) > 40_000_000) throw new Error("Player catalog is too large");
      const catalog = JSON.parse(raw);
      if (!catalog?.players || Array.isArray(catalog.players) || typeof catalog.players !== "object") throw new Error("Invalid player catalog");
      return catalog as Catalog;
    })();
    const entry = { signature, value };
    catalogs.delete(root);
    catalogs.set(root, entry);
    if (catalogs.size > 4) catalogs.delete(catalogs.keys().next().value!);
    try { return await value; }
    catch (error) { if (catalogs.get(root) === entry) catalogs.delete(root); throw error; }
  } finally { await handle.close(); }
}
