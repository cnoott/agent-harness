import { DatabaseSync } from "node:sqlite";

async function main() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk.toString();
  const { sql } = JSON.parse(input);
  if (typeof sql !== "string" || !/^(SELECT|WITH)\b/i.test(sql.trim()) || Buffer.byteLength(sql) > 32 * 1024) throw new Error("Expected one SELECT or WITH statement");
  const db = new DatabaseSync(process.argv[2], { readOnly: true, allowExtension: false });
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000; PRAGMA hard_heap_limit=33554432;");
    const version = db.prepare("PRAGMA user_version").get()!.user_version;
    if (version !== 1 && version !== 2) throw new Error("Unsupported NFL database schema version");
    if (!db.prepare("SELECT 1 FROM games LIMIT 1").get() && (version === 1 || !db.prepare("SELECT 1 FROM nfl_schedule LIMIT 1").get())) {
      process.stdout.write(JSON.stringify({ columns: [], rows: [], truncated: false, message: "No games imported. Run npm run nfl:import -- <game-id> on the host." }));
      return;
    }
    const statement = db.prepare(sql);
    if (statement.sourceSQL.trim() !== sql.trim()) throw new Error("Multiple statements are not allowed");
    statement.setReadBigInts(true);
    const columns = typeof statement.columns === "function" ? statement.columns().map(column => column.name) : [];
    const rows: Record<string, unknown>[] = [];
    let truncated = false;
    let bytes = Buffer.byteLength(JSON.stringify({ columns, rows: [], truncated: false }));
    if (bytes > 8_000) throw new Error("Selected column metadata exceeds the 8,000-byte result limit; select fewer columns or use shorter aliases");
    for (const row of statement.iterate()) {
      if (!columns.length) {
        columns.push(...Object.keys(row));
        bytes = Buffer.byteLength(JSON.stringify({ columns, rows: [], truncated: false }));
        if (bytes > 8_000) throw new Error("Selected column metadata exceeds the 8,000-byte result limit; select fewer columns or use shorter aliases");
      }
      const encoded = JSON.stringify(row, (_key, value) => typeof value === "bigint"
        ? value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString() : value);
      const addedBytes = Buffer.byteLength(encoded) + (rows.length ? 1 : 0);
      if (bytes + addedBytes > 8_000 && !rows.length) throw new Error("A selected row exceeds the 8,000-byte result limit; select fewer columns or use substr to read long values in pieces");
      if (rows.length >= 200 || bytes + addedBytes > 8_000) { truncated = true; break; }
      rows.push(JSON.parse(encoded));
      bytes += addedBytes;
    }
    process.stdout.write(JSON.stringify({ columns, rows, truncated }));
  } finally { db.close(); }
}

main().catch(error => {
  process.stdout.write(JSON.stringify({ error: Array.from(error instanceof Error ? error.message : String(error)).slice(0, 1_000).join("") }));
  process.exitCode = 1;
});
