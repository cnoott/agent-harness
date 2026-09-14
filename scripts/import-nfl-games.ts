import { fetchNflGame, importNflGame, nflDatabasePath, openNflDatabase } from "../src/nfl-data.js";

async function main() {
  const ids = process.argv.slice(2);
  if (!ids.length || ids.some(id => !/^\d+$/.test(id))) throw new Error("Usage: npm run nfl:import -- <game-id> [game-id...]");
  for (const id of new Set(ids)) {
    const payload = await fetchNflGame(id);
    const db = openNflDatabase();
    try { console.log(JSON.stringify({ database: nflDatabasePath, ...importNflGame(db, id, payload) })); }
    finally { db.close(); }
  }
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
