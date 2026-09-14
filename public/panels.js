const panel = document.querySelector("#context-panel");
const heading = document.querySelector("#context-panel-title");
const buttons = [...document.querySelectorAll("[data-open-panel]")];
const browserButton = document.querySelector("#browser-toggle");
const overlayPanel = matchMedia("(max-width: 1199px)");
const titles = { matchup: "My matchup", games: "Games", teams: "Teams", waivers: "Waivers", files: "Files", browser: "Browser", runs: "Runs" };
let sport = "";
let selected = null;
let opener = null;
let browserAutoHandled = false;

function showPanel(name, focus = true) {
  selected = name;
  panel.classList.toggle("hidden", !name);
  document.querySelector(".chat-panel").inert = Boolean(name) && overlayPanel.matches;
  document.querySelector("main").classList.toggle("has-context-panel", Boolean(name));
  document.querySelector("main").classList.toggle("has-teams-panel", name === "teams" || name === "waivers" || name === "matchup");
  for (const view of panel.querySelectorAll("[data-panel]")) view.classList.toggle("hidden", view.dataset.panel !== name);
  for (const button of buttons) button.setAttribute("aria-expanded", String(button.dataset.openPanel === name));
  if (name) {
    heading.textContent = `${sport ? `${sport.toUpperCase()} · ` : ""}${titles[name]}`;
    panel.scrollTop = 0;
    if (focus) heading.focus({ preventScroll: true });
  }
  document.dispatchEvent(new CustomEvent("panel-change", { detail: name }));
}
export function closePanel() {
  showPanel(null, false);
  if (opener && !opener.disabled && !opener.classList.contains("hidden")) opener.focus();
}
for (const button of buttons) {
  button.addEventListener("click", () => {
    opener = button;
    if (selected === button.dataset.openPanel) closePanel();
    else showPanel(button.dataset.openPanel);
  });
}
document.querySelector("#context-panel-close").addEventListener("click", closePanel);
document.addEventListener("keydown", event => {
  if (event.key !== "Escape" || document.querySelector("dialog[open], .history-menu[open]") || (matchMedia("(max-width: 1099px)").matches && document.querySelector("#history-drawer.open"))) return;
  if (selected) closePanel();
});

export function setPanelWorkspace(workspaceId) {
  const next = ["nfl", "nba"].includes(workspaceId) ? workspaceId : "";
  if (next !== sport) showPanel(null, false);
  sport = next;
  document.body.dataset.sport = sport;
  document.querySelectorAll("[data-sport]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.sport === sport)));
  document.querySelector(".chat-heading h1").textContent = sport ? `${sport.toUpperCase()} chat` : "Sandbox Harness";
  document.querySelector("#history-title").textContent = sport ? `${sport.toUpperCase()} chats` : "Chats";
  document.querySelector("#new-chat").textContent = sport ? `New ${sport.toUpperCase()} chat` : "New chat";
  document.querySelector("#games-toggle").disabled = !sport;
  document.querySelector("#matchup-toggle").disabled = sport !== "nfl";
  document.querySelector("#matchup-toggle").hidden = sport !== "nfl";
  document.querySelector("#teams-toggle").disabled = !sport;
  document.querySelector("#waivers-toggle").disabled = !sport;
  document.querySelector("#files-toggle").disabled = !workspaceId;
  if (!workspaceId) showPanel(null, false);
}
export function setBrowserAvailable(available) {
  browserButton.classList.toggle("hidden", !available);
  browserButton.textContent = available ? "Browser · Live" : "Browser";
  if (!available && selected === "browser") showPanel(null, false);
}
export function resetBrowserActivity() {
  browserAutoHandled = false;
}
export function showBrowserActivity() {
  browserButton.classList.remove("hidden");
  if (!browserAutoHandled && !selected) {
    opener = browserButton;
    showPanel("browser", false);
  }
  browserAutoHandled = true;
}

overlayPanel.addEventListener("change", () => {
  document.querySelector(".chat-panel").inert = Boolean(selected) && overlayPanel.matches;
});
