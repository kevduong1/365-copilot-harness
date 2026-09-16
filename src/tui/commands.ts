export interface SlashCommand {
  name: string;
  aliases: string[];
  description: string;
  args?: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "new", aliases: ["clear"], description: "Start a new Copilot conversation" },
  { name: "home", aliases: ["welcome"], description: "Return to the welcome screen" },
  { name: "compact", aliases: [], description: "Summarize into a fresh browser chat", args: "[note]" },
  { name: "context", aliases: ["tokens"], description: "Show estimated context usage" },
  { name: "session-info", aliases: ["status", "info"], description: "Show session details" },
  { name: "copy", aliases: [], description: "Copy the last assistant response", args: "[n]" },
  { name: "find", aliases: [], description: "Search the conversation scrollback" },
  { name: "agent", aliases: [], description: "Switch to coding-agent mode" },
  { name: "chat", aliases: [], description: "Switch to raw browser chat" },
  { name: "tools", aliases: [], description: "List active local tools" },
  { name: "agents", aliases: [], description: "List subagents spawned this session" },
  { name: "skills", aliases: [], description: "List available agent skills" },
  { name: "skill", aliases: ["use"], description: "Ask the agent to apply a skill", args: "<name> [request]" },
  { name: "always-approve", aliases: ["yolo"], description: "Toggle always-approve for mutating tools" },
  {
    name: "permissions",
    aliases: ["rules", "perms"],
    description: "Show, clear, or tune session permission rules",
    args: "[clear | safe on|off]",
  },
  { name: "multiline", aliases: ["ml"], description: "Toggle Enter inserts a newline" },
  { name: "vim-mode", aliases: [], description: "Toggle vim-style scrollback keys" },
  { name: "compact-mode", aliases: [], description: "Toggle denser scrollback padding" },
  { name: "rename", aliases: ["title"], description: "Rename this session", args: "<title>" },
  { name: "rewind", aliases: ["undo"], description: "Drop later turns and start a fresh chat" },
  { name: "login", aliases: [], description: "Open Chrome to refresh the Microsoft session" },
  { name: "help", aliases: [], description: "Browse commands and keyboard shortcuts" },
  { name: "shortcuts", aliases: [], description: "Open the keyboard shortcuts card" },
  { name: "quit", aliases: ["exit"], description: "Quit the application" },
];

export function findCommand(token: string): SlashCommand | undefined {
  const name = token.replace(/^\//, "").toLowerCase();
  return SLASH_COMMANDS.find((command) => command.name === name || command.aliases.includes(name));
}

export function filterCommands(query: string): SlashCommand[] {
  const q = query.replace(/^\//, "").toLowerCase();
  if (q.length === 0) return SLASH_COMMANDS;
  return SLASH_COMMANDS.filter(
    (command) =>
      command.name.startsWith(q) ||
      command.aliases.some((alias) => alias.startsWith(q)) ||
      command.name.includes(q) ||
      command.description.toLowerCase().includes(q),
  );
}

export interface PaletteItem {
  id: string;
  label: string;
  hint: string;
  command?: string;
}

export function paletteItems(): PaletteItem[] {
  return [
    { id: "new", label: "New session", hint: "Ctrl+N", command: "/new" },
    { id: "home", label: "Welcome screen", hint: "/home", command: "/home" },
    { id: "compact", label: "Compact conversation", hint: "/compact", command: "/compact" },
    { id: "context", label: "Context usage", hint: "/context", command: "/context" },
    { id: "agents", label: "Subagent tasks", hint: "Ctrl+G", command: "/agents" },
    { id: "tools", label: "List tools", hint: "/tools", command: "/tools" },
    { id: "skills", label: "List skills", hint: "/skills", command: "/skills" },
    { id: "always", label: "Toggle always-approve", hint: "Ctrl+O", command: "/always-approve" },
    { id: "permissions", label: "Permission rules", hint: "/permissions", command: "/permissions" },
    { id: "chat", label: "Raw chat mode", hint: "/chat", command: "/chat" },
    { id: "agent", label: "Agent mode", hint: "/agent", command: "/agent" },
    { id: "vim", label: "Toggle vim mode", hint: "/vim-mode", command: "/vim-mode" },
    { id: "multiline", label: "Toggle multiline", hint: "Ctrl+M", command: "/multiline" },
    { id: "copy", label: "Copy last response", hint: "/copy", command: "/copy" },
    { id: "find", label: "Find in scrollback", hint: "/find", command: "/find" },
    { id: "help", label: "Help", hint: "/help", command: "/help" },
    { id: "shortcuts", label: "Keyboard shortcuts", hint: "Ctrl+X", command: "/shortcuts" },
    { id: "quit", label: "Quit", hint: "Ctrl+Q", command: "/quit" },
  ];
}

export function welcomeItems(ready: boolean): { label: string; hint: string; action: string }[] {
  return [
    { label: ready ? "New session" : "Waiting for Chrome…", hint: "↵", action: "new" },
    { label: "Command palette", hint: "Ctrl+P", action: "palette" },
    { label: "Keyboard shortcuts", hint: "?", action: "shortcuts" },
    { label: "Quit", hint: "Ctrl+Q", action: "quit" },
  ];
}
