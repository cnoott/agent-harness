const heading = document.querySelector("#nfl-games-title");
const status = document.querySelector("#nfl-games-status");
const error = document.querySelector("#nfl-games-error");
const list = document.querySelector("#nfl-games-list");
let chatId;
let controller;
let timer;

function element(tag, className, text) {
  const item = document.createElement(tag);
  item.className = className;
  item.textContent = text;
  return item;
}
function age(value) {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
function render(data) {
  const season = data.season;
  heading.textContent = season ? `NFL games · ${season.type === 3 ? "Playoffs" : "Week"} ${season.week}` : "NFL games";
  const errors = [data.error, ...(data.tasks ?? []).map(task => task.error)].filter(Boolean);
  error.textContent = errors.join(" · ");
  status.textContent = data.running ? "Updates every minute" : "Collection unavailable";
  list.replaceChildren();
  if (!season) {
    list.append(element("p", "workspace-copy", errors.length ? "Schedule unavailable. Retrying automatically." : "Loading the NFL schedule…"));
    return;
  }
  if (!data.games.length) {
    list.append(element("p", "workspace-copy", "No regular-season or playoff games this week."));
    return;
  }
  for (const game of data.games) {
    const item = element("li", `nfl-game${game.state === "in" ? " nfl-game-live" : ""}`, "");
    const line = element("div", "nfl-game-heading", "");
    line.append(element("strong", "", `${game.away_abbreviation ?? "TBD"} @ ${game.home_abbreviation ?? "TBD"}`));
    if (game.state !== "pre" && game.away_score != null && game.home_score != null) line.append(element("strong", "", `${game.away_score} – ${game.home_score}`));
    item.append(line);
    const kickoff = new Date(game.starts_at).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
    const detail = game.state === "pre" ? `${kickoff}${game.status === "STATUS_SCHEDULED" ? "" : ` · ${game.status_detail}`}` : game.status_detail;
    item.append(element("p", "nfl-game-detail", detail));
    if (game.state !== "pre" || game.play_count) {
      const freshness = game.plays_fetched_at ? `Plays saved ${age(game.plays_fetched_at)}` : "Play-by-play not available yet";
      item.append(element("p", `nfl-game-freshness${game.stale ? " nfl-game-warning" : ""}`, `${game.stale ? "Stale · " : ""}${freshness}`));
    }
    if (game.scoreboard_stale && game.state === "in") item.append(element("p", "nfl-game-warning", "Scoreboard update delayed"));
    if (game.collection_error) item.append(element("p", "nfl-game-warning", `Collection delayed: ${game.collection_error}`));
    list.append(item);
  }
}
async function refresh() {
  if (!chatId) return;
  controller?.abort();
  const request = new AbortController();
  controller = request;
  try {
    const response = await fetch(`/api/chats/${encodeURIComponent(chatId)}/nfl/games`, { signal: request.signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not load NFL games");
    if (!request.signal.aborted) render(data);
  } catch (failure) {
    if (request.signal.aborted) return;
    error.textContent = failure.message || String(failure);
    status.textContent = "Games could not refresh · Displayed data may be stale";
  }
}
export function setNflGamesChat(id, workspaceId) {
  controller?.abort();
  clearInterval(timer);
  chatId = workspaceId === "nfl" ? id : null;
  list.replaceChildren();
  error.textContent = "";
  if (!chatId) {
    heading.textContent = workspaceId === "nba" ? "NBA games" : "NFL games";
    status.textContent = workspaceId === "nba" ? "NBA game collection is not connected yet." : "Open an NFL chat to view games.";
    return;
  }
  heading.textContent = "NFL games";
  status.textContent = "Loading games…";
  void refresh();
  timer = setInterval(refresh, 60_000);
}
