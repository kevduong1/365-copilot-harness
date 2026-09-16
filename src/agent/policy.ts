import type { ToolCall, ToolDefinition } from "./types.js";

export type ApprovalDecision = "allow" | "ask";

/** A learned command rule, scoped to the tool whose call taught it. */
export interface CommandRule {
  tool: string;
  prefix: string;
}

/** A session permission rule learned from an "always allow" answer. */
export type ApprovalRule =
  | { kind: "tool"; name: string }
  | { kind: "command"; tool: string; prefix: string };

export interface ApprovalPolicyOptions {
  /** Auto-approve the built-in read-only command allowlist. Defaults to true. */
  autoApproveSafeCommands?: boolean;
  tools?: string[];
  commandPrefixes?: CommandRule[];
}

export interface ApprovalRules {
  tools: string[];
  commandPrefixes: CommandRule[];
  autoApproveSafeCommands: boolean;
}

/**
 * Commands whose first word alone does not identify the operation, so a learned
 * prefix rule keeps the subcommand: `git commit`, not all of `git`.
 */
const SUBCOMMAND_HEADS = new Set(["git", "pnpm", "npm", "yarn", "cargo", "go", "docker", "make", "node"]);

/**
 * Read-only commands that never need an approval prompt. Multi-word entries
 * (every `git` entry, the version probes) must match word for word, so
 * `git commit` is not covered by `git status`.
 *
 * Commands that can execute another program or write a file through an ordinary
 * option are deliberately absent, however read-only they look: `env` and `find`
 * run arbitrary commands, `rg --pre` runs a preprocessor, and `tree`, `du`,
 * `df`, `date`, and `file` are not worth the remaining argument surface.
 */
const SAFE_COMMANDS: readonly string[] = [
  "ls",
  "pwd",
  "cat",
  "head",
  "tail",
  "wc",
  "echo",
  "which",
  "whoami",
  "printenv",
  "stat",
  "grep",
  "git status",
  "git log",
  "git diff",
  "git show",
  "git branch",
  "git rev-parse",
  "git remote",
  "node --version",
  "pnpm --version",
  "npm --version",
  "pnpm ls",
  "npm ls",
];

const SAFE_ENTRIES: readonly string[][] = SAFE_COMMANDS.map((entry) => entry.split(" "));

/**
 * Any shell metacharacter disqualifies a command outright: the classifier only
 * reasons about the first word, so a pipeline, redirect, heredoc, or
 * substitution could smuggle an arbitrary second command past it.
 */
const SHELL_OPERATORS = /[|;&<>`]|\$\(|\$\{/u;

/**
 * Control characters (newlines and tabs included), format characters, and every
 * space separator other than a plain ASCII space. All of them tokenize
 * differently here than in a real shell, so a command carrying one is opaque.
 */
const OPAQUE_CHARACTERS = /\p{Cc}|\p{Cf}|\p{Zl}|\p{Zp}|(?! )\p{Zs}/u;

/**
 * Options that turn a reading command into an executing or writing one. Matched
 * as a prefix, so `--output=/etc/passwd` is rejected alongside `--output`.
 */
const EXECUTING_FLAGS: readonly string[] = [
  "-o",
  "--output",
  "--pre",
  "-exec",
  "-execdir",
  "-delete",
  "-ok",
  "-fprint",
  "-fls",
];

/**
 * Git's pre-command escape hatches: `-c core.pager=…`, an alternate work tree,
 * or a diff filter all run code of the caller's choosing.
 */
const GIT_ESCAPE_FLAGS: readonly string[] = [
  "--config",
  "-c",
  "--git-dir",
  "--work-tree",
  "-C",
  "--exec-path",
  "--upload-pack",
  "--receive-pack",
  "--ext-diff",
  "--textconv",
  "--extcmd",
];

/** `git branch` options that only read; everything else edits or deletes refs. */
const SAFE_GIT_BRANCH_FLAGS = new Set([
  "-a",
  "-r",
  "-v",
  "-vv",
  "--all",
  "--remotes",
  "--list",
  "--show-current",
  "--merged",
  "--no-merged",
  "--contains",
  "--verbose",
]);

/** Tools whose `command` argument is a shell line rather than ordinary data. */
const SHELL_TOOLS = new Set(["bash", "shell", "sh", "job_start"]);

/**
 * True when a command carries shell syntax or characters this classifier cannot
 * reason about. Both the safe-command allowlist and learned prefix rules refuse
 * such a command, so neither can be widened by appending `&& rm -rf x`.
 */
export function hasUnsafeSyntax(command: string): boolean {
  return SHELL_OPERATORS.test(command) || OPAQUE_CHARACTERS.test(command);
}

function startsWithAny(token: string, flags: readonly string[]): boolean {
  return flags.some((flag) => token.startsWith(flag));
}

/** `git branch` is safe only while every argument merely lists refs. */
function safeGitBranch(args: string[]): boolean {
  let listing = false;
  for (const arg of args) {
    if (arg.startsWith("-")) {
      if (!SAFE_GIT_BRANCH_FLAGS.has(arg)) return false;
      if (arg === "--list") listing = true;
      continue;
    }
    // A bare name is a rename or a create target unless it filters a listing.
    if (!listing) return false;
  }
  return true;
}

/** `git remote` is safe only for the listing and lookup subcommands. */
function safeGitRemote(args: string[]): boolean {
  const [head] = args;
  if (head === undefined) return true;
  if (head === "-v" || head === "--verbose") return args.length === 1;
  return head === "show" || head === "get-url";
}

/** True only for commands that read state and cannot reach anything else. */
export function isSafeCommand(command: string): boolean {
  if (typeof command !== "string") return false;
  const text = command.trim();
  if (text.length === 0) return false;
  if (hasUnsafeSyntax(text)) return false;

  const words = text.split(/\s+/u);
  const head = words[0];
  // A leading `NAME=value` is an environment assignment, so the command that
  // actually runs is some later word.
  if (head === undefined || head.includes("=")) return false;

  const entry = SAFE_ENTRIES.find(
    (candidate) =>
      candidate.length <= words.length && candidate.every((word, index) => words[index] === word),
  );
  if (entry === undefined) return false;

  const args = words.slice(entry.length);
  if (args.some((arg) => startsWithAny(arg, EXECUTING_FLAGS))) return false;
  if (head === "git" && args.some((arg) => startsWithAny(arg, GIT_ESCAPE_FLAGS))) return false;

  const subcommand = entry[1];
  if (subcommand === "branch") return safeGitBranch(args);
  if (subcommand === "remote") return safeGitRemote(args);
  return true;
}

/**
 * The rule text an "always allow" answer would learn for a command: the first
 * word, plus the subcommand for tools whose first word is too broad to grant.
 */
export function commandPrefix(command: string): string {
  const words = command.trim().split(/\s+/u).filter(Boolean);
  const head = words[0];
  if (head === undefined) return "";
  const next = words[1];
  if (next !== undefined && SUBCOMMAND_HEADS.has(head)) return `${head} ${next}`;
  return head;
}

/**
 * A prefix rule matches only at a word boundary, so `git commit` never covers
 * `git commitx`, and only for a command free of shell syntax, so it never
 * covers `git commit && rm -rf x` either.
 */
export function matchesPrefix(command: string, prefix: string): boolean {
  const text = command.trim();
  const rule = prefix.trim();
  if (rule.length === 0 || hasUnsafeSyntax(text) || !text.startsWith(rule)) return false;
  return text.length === rule.length || /\s/u.test(text.charAt(rule.length));
}

function shellCommand(call: ToolCall): string | undefined {
  if (!SHELL_TOOLS.has(call.name)) return undefined;
  const value = call.arguments.command;
  return typeof value === "string" ? value : undefined;
}

/**
 * The rule an "always allow" answer learns for this call, or undefined when
 * there is nothing safe to learn and the card must not offer the option.
 *
 * A shell tool never yields a tool-wide rule: "always allow bash" would grant
 * every command the model can write, so a call whose command is missing or
 * blank simply has no rule to offer.
 */
export function ruleFor(call: ToolCall, definition: ToolDefinition): ApprovalRule | undefined {
  if (SHELL_TOOLS.has(call.name) || SHELL_TOOLS.has(definition.name)) {
    const command = shellCommand(call);
    const prefix = command === undefined ? "" : commandPrefix(command);
    // The rule is scoped to the tool that ran the command: granting a prefix to
    // the foreground shell must not also grant it to the background job runner.
    return prefix.length === 0 ? undefined : { kind: "command", tool: call.name, prefix };
  }
  return { kind: "tool", name: definition.name };
}

/** How a rule reads on the approval card and in `/permissions`. */
export function ruleLabel(rule: ApprovalRule): string {
  return rule.kind === "command" ? `${rule.tool} "${rule.prefix} …"` : rule.name;
}

/**
 * Session-scoped approval rules. Nothing here is persisted: every rule lasts
 * only as long as the process, so a granted prefix cannot outlive the session
 * that granted it.
 */
export class ApprovalPolicy {
  private readonly tools = new Set<string>();
  private readonly prefixes: CommandRule[] = [];
  private safeCommands: boolean;

  constructor(options: ApprovalPolicyOptions = {}) {
    this.safeCommands = options.autoApproveSafeCommands ?? true;
    for (const name of options.tools ?? []) this.allowTool(name);
    for (const rule of options.commandPrefixes ?? []) this.allowCommandPrefix(rule.prefix, rule.tool);
  }

  get autoApproveSafeCommands(): boolean {
    return this.safeCommands;
  }

  setAutoApproveSafeCommands(enabled: boolean): void {
    this.safeCommands = enabled;
  }

  decide(call: ToolCall, definition: ToolDefinition): ApprovalDecision {
    if (!definition.mutates) return "allow";
    if (this.tools.has(definition.name) || this.tools.has(call.name)) return "allow";
    const command = shellCommand(call);
    if (command !== undefined) {
      if (this.safeCommands && isSafeCommand(command)) return "allow";
      const matched = this.prefixes.some(
        (rule) => rule.tool === call.name && matchesPrefix(command, rule.prefix),
      );
      if (matched) return "allow";
    }
    return "ask";
  }

  allowTool(name: string): void {
    const trimmed = name.trim();
    if (trimmed.length > 0) this.tools.add(trimmed);
  }

  allowCommandPrefix(prefix: string, tool = "bash"): void {
    const trimmed = prefix.trim().replaceAll(/\s+/gu, " ");
    if (trimmed.length === 0) return;
    const exists = this.prefixes.some((rule) => rule.tool === tool && rule.prefix === trimmed);
    if (!exists) this.prefixes.push({ tool, prefix: trimmed });
  }

  learn(rule: ApprovalRule): void {
    if (rule.kind === "tool") this.allowTool(rule.name);
    else this.allowCommandPrefix(rule.prefix, rule.tool);
  }

  rules(): ApprovalRules {
    return {
      tools: [...this.tools],
      commandPrefixes: [...this.prefixes],
      autoApproveSafeCommands: this.safeCommands,
    };
  }

  clear(): void {
    this.tools.clear();
    this.prefixes.length = 0;
  }
}

/** The `/permissions` listing. */
export function formatRules(rules: ApprovalRules): string {
  const lines = [
    `Safe-command auto-approval: ${rules.autoApproveSafeCommands ? "on" : "off"}`,
    rules.tools.length === 0
      ? "Always-allowed tools: none"
      : `Always-allowed tools: ${rules.tools.join(", ")}`,
    rules.commandPrefixes.length === 0
      ? "Always-allowed commands: none"
      : `Always-allowed commands: ${rules.commandPrefixes
          .map((rule) => ruleLabel({ kind: "command", ...rule }))
          .join(", ")}`,
  ];
  return lines.join("\n");
}
