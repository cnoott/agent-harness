const prompt = document.querySelector("#prompt");
const menu = document.querySelector("#command-menu");
const list = document.querySelector("#command-list");
const status = document.querySelector("#command-status");
const toggle = document.querySelector("#commands-toggle");
let chatId = null;
let commands = [];
let busy = false;
let opened = false;
let requestVersion = 0;

export function setCommandChat(id) {
  chatId = id;
  commands = [];
  requestVersion++;
  closeCommands();
  toggle.disabled = !id || busy;
  if (id) void refreshCommands();
}

export function setCommandsBusy(value) {
  busy = value;
  toggle.disabled = busy || !chatId;
  if (busy) closeCommands();
}

function closeCommands() {
  opened = false;
  menu.hidden = true;
  toggle.setAttribute("aria-expanded", "false");
}

function render() {
  list.replaceChildren();
  const prefix = prompt.value.match(/^\/([a-z0-9-]*)$/i)?.[1]?.toLowerCase() ?? "";
  const matches = commands.filter(command => command.name.startsWith(prefix));
  for (const command of matches) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "command-option";
    const name = document.createElement("strong");
    name.textContent = `/${command.name}`;
    const description = document.createElement("span");
    description.textContent = command.description;
    const source = document.createElement("small");
    source.textContent = command.source;
    button.append(name, description, source);
    button.title = command.instructions || command.description;
    button.addEventListener("click", () => {
      prompt.value = `/${command.name}`;
      prompt.dispatchEvent(new Event("input", { bubbles: true }));
      closeCommands();
      prompt.focus();
    });
    list.append(button);
  }
  if (!matches.length) {
    const empty = document.createElement("p");
    empty.textContent = "No matching commands. Use /help to see the current list.";
    list.append(empty);
  }
}

export async function refreshCommands() {
  if (!chatId) return;
  const id = chatId;
  const version = ++requestVersion;
  status.textContent = "Loading commands…";
  try {
    const response = await fetch(`/api/chats/${id}/commands`, { cache: "no-store" });
    const data = await response.json();
    if (version !== requestVersion || id !== chatId) return;
    if (!response.ok) throw new Error(data.error || "Could not load commands");
    commands = data.commands;
    status.textContent = data.warnings.length ? data.warnings.join(" · ") : "Choose a shortcut, then send it. /help always shows the current list.";
    render();
  } catch (error) {
    if (version !== requestVersion || id !== chatId) return;
    commands = [];
    render();
    status.textContent = error.message || "Could not load commands";
  }
}

function openCommands() {
  if (!chatId || busy) return;
  opened = true;
  menu.hidden = false;
  toggle.setAttribute("aria-expanded", "true");
  render();
  void refreshCommands();
}

toggle.addEventListener("click", () => opened ? closeCommands() : openCommands());
document.querySelector("#commands-close").addEventListener("click", closeCommands);
prompt.addEventListener("input", () => {
  if (/^\/[a-z0-9-]*$/i.test(prompt.value)) {
    if (!opened) openCommands();
    else render();
  } else closeCommands();
});
prompt.addEventListener("keydown", event => {
  if (!opened) return;
  if (event.key === "Escape") { event.preventDefault(); closeCommands(); }
  if (event.key === "ArrowDown") { event.preventDefault(); list.querySelector("button")?.focus(); }
});
menu.addEventListener("keydown", event => {
  if (event.key === "Escape") { closeCommands(); prompt.focus(); return; }
  if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
  const buttons = [...list.querySelectorAll("button")];
  const index = buttons.indexOf(document.activeElement);
  if (index < 0) return;
  event.preventDefault();
  buttons[(index + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length]?.focus();
});
