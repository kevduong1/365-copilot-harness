import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  access,
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  matchesGlob,
  relative,
  resolve,
  sep,
} from "node:path";
import { config } from "../config.js";
import { JobManager, createJobTools } from "./jobs.js";
import { createPatchTool } from "./patch.js";
import { createSkillTool } from "./skills.js";
import type { ToolDefinition, ToolExecutionContext } from "./types.js";

const FORCE_KILL_GRACE_MS = 1_000;
/** Per-stream capture ceiling. Far above the display cap so the retained copy stays useful. */
const CAPTURE_LIMIT_CHARS = 1_000_000;
const MAX_READ_BYTES = 50 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 8 * 1024;
const MAX_LINE_CHARS = 2_000;
const MAX_WALK_FILES = 50_000;
const MAX_FALLBACK_MATCHES = 20_000;
const RETAINED_OUTPUT_LIMIT = 20;
const OUTPUT_SCHEME = "harness://output/";

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN =
  /\u001B\[[0-9;?]*[ -/]*[@-~]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)|\u001B[@-Z\\-_]/g;

function stripAnsi(text: string): string {
  return text.includes("\u001B") ? text.replace(ANSI_PATTERN, "") : text;
}

function stringArg(args: Record<string, unknown>, name: string, fallback?: string): string {
  const value = args[name];
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

function optionalStringArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

function aliasedStringArg(args: Record<string, unknown>, names: string[]): string {
  const supplied = names.filter((name) => args[name] !== undefined);
  if (supplied.length === 0) throw new Error(`${names[0]} must be a string`);
  const values = supplied.map((name) => stringArg(args, name));
  if (new Set(values).size > 1) {
    throw new Error(`Conflicting values supplied for ${supplied.join(" and ")}`);
  }
  return values[0]!;
}

function aliasedIntegerArg(
  args: Record<string, unknown>,
  names: string[],
  fallback?: number,
): number {
  const supplied = names.filter((name) => args[name] !== undefined);
  if (supplied.length === 0) {
    if (fallback !== undefined) return fallback;
    throw new Error(`${names[0]} must be a positive integer`);
  }
  const values = supplied.map((name) => args[name]);
  if (new Set(values).size > 1) {
    throw new Error(`Conflicting values supplied for ${supplied.join(" and ")}`);
  }
  const value = values[0];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${supplied[0]} must be a positive integer`);
  }
  return value;
}

function aliasedBooleanArg(
  args: Record<string, unknown>,
  names: string[],
  fallback: boolean,
): boolean {
  const supplied = names.filter((name) => args[name] !== undefined);
  if (supplied.length === 0) return fallback;
  const values = supplied.map((name) => args[name]);
  if (new Set(values).size > 1) {
    throw new Error(`Conflicting values supplied for ${supplied.join(" and ")}`);
  }
  const value = values[0];
  if (typeof value !== "boolean") throw new Error(`${supplied[0]} must be a boolean`);
  return value;
}

function booleanArg(args: Record<string, unknown>, name: string, fallback: boolean): boolean {
  return aliasedBooleanArg(args, [name], fallback);
}

function numberArg(
  args: Record<string, unknown>,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = args[name] ?? fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

/* ------------------------------------------------------------------ *
 * Retained full outputs
 * ------------------------------------------------------------------ */

/**
 * Bounded store of untruncated tool outputs. One instance per workspace tool
 * set, so a subagent can never page through the outputs of another agent.
 */
export class RetainedOutputs {
  private readonly entries = new Map<number, string>();
  private nextId = 1;

  retain(content: string): number {
    const id = this.nextId;
    this.nextId += 1;
    this.entries.set(id, content);
    while (this.entries.size > RETAINED_OUTPUT_LIMIT) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
    return id;
  }

  get(id: number): string | undefined {
    return this.entries.get(id);
  }
}

const retainedOutputsByToolSet = new WeakMap<ToolDefinition[], RetainedOutputs>();

/** Test and diagnostics hook: the retained outputs a given tool set produced. */
export function getRetainedOutput(tools: ToolDefinition[], id: number): string | undefined {
  return retainedOutputsByToolSet.get(tools)?.get(id);
}

interface TruncateOptions {
  limit?: number;
  /** When supplied, the untruncated output is kept here and referenced in the note. */
  store?: RetainedOutputs;
}

/**
 * Keep the head and the tail of an oversized output: the tail of test and
 * build output is usually where the failure is.
 */
function truncateOutput(output: string, options: TruncateOptions = {}): string {
  const limit = options.limit ?? config.toolOutputMaxChars;
  if (output.length <= limit) return output;
  const headLength = Math.max(1, Math.floor(limit * 0.6));
  const tailLength = Math.max(1, limit - headLength);
  const omitted = output.length - headLength - tailLength;
  const head = output.slice(0, headLength);
  const tail = output.slice(output.length - tailLength);
  const marker = `\n… ${omitted} characters omitted …\n`;
  if (options.store === undefined) return `${head}${marker}${tail}`;
  const reference = `${OUTPUT_SCHEME}${options.store.retain(output)}`;
  return `${head}${marker}${tail}\nFull output retained as ${reference}; read it with read path "${reference}" offset/limit`;
}

function truncateLine(line: string): string {
  if (line.length <= MAX_LINE_CHARS) return line;
  return `${line.slice(0, MAX_LINE_CHARS)}… (line truncated)`;
}

function parseOutputReference(path: string): number | undefined {
  if (!path.startsWith(OUTPUT_SCHEME)) return undefined;
  const raw = path.slice(OUTPUT_SCHEME.length);
  if (!/^\d+$/.test(raw)) throw new Error(`Malformed retained output reference: ${path}`);
  return Number(raw);
}

/* ------------------------------------------------------------------ *
 * Child processes
 * ------------------------------------------------------------------ */

interface ProcessOutcome {
  stdout: string;
  stderr: string;
  exitCode: number;
  status: "exited" | "timeout" | "aborted";
}

interface ProcessOptions {
  cwd: string;
  timeoutMs?: number;
  stdin?: string;
  signal?: AbortSignal;
}

function isSpawnEnoent(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

let cachedShell: string | undefined;

async function resolveShell(): Promise<string> {
  if (cachedShell !== undefined) return cachedShell;
  const fromEnvironment = process.env.SHELL;
  if (fromEnvironment !== undefined && fromEnvironment !== "") {
    try {
      await access(fromEnvironment, fsConstants.X_OK);
      cachedShell = fromEnvironment;
      return cachedShell;
    } catch {
      // Fall through to the platform default.
    }
  }
  cachedShell = process.platform === "darwin" ? "/bin/zsh" : "/bin/bash";
  return cachedShell;
}

async function runProcess(
  command: string,
  args: string[],
  options: ProcessOptions,
): Promise<ProcessOutcome> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  return new Promise((resolvePromise, reject) => {
    const useProcessGroup = process.platform !== "win32";
    const child = spawn(command, args, {
      cwd: options.cwd,
      detached: useProcessGroup,
      // stdin is always piped and closed immediately, so a command that reads
      // it sees EOF instead of hanging on an inherited terminal.
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        NO_COLOR: "1",
        TERM: "dumb",
        PAGER: "cat",
        GIT_PAGER: "cat",
      },
    });

    let stdout = "";
    let stderr = "";
    let status: ProcessOutcome["status"] = "exited";
    let forceKillTimer: NodeJS.Timeout | undefined;

    const kill = (signal: NodeJS.Signals): void => {
      try {
        if (useProcessGroup && child.pid !== undefined) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        // The process may have exited between the decision and this signal.
      }
    };
    const terminate = (reason: "timeout" | "aborted"): void => {
      if (status !== "exited") return;
      status = reason;
      kill("SIGTERM");
      forceKillTimer = setTimeout(() => kill("SIGKILL"), FORCE_KILL_GRACE_MS);
    };

    const timer = setTimeout(() => terminate("timeout"), timeoutMs);
    const onAbort = (): void => terminate("aborted");
    if (options.signal !== undefined) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }

    const cleanup = (): void => {
      clearTimeout(timer);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      options.signal?.removeEventListener("abort", onAbort);
    };

    child.stdin.on("error", () => {
      // The command may exit without draining stdin.
    });
    child.stdin.end(options.stdin ?? "");

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length <= CAPTURE_LIMIT_CHARS) stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length <= CAPTURE_LIMIT_CHARS) stderr += chunk;
    });
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("close", (code) => {
      cleanup();
      resolvePromise({
        stdout: stripAnsi(stdout),
        stderr: stripAnsi(stderr),
        exitCode: status === "exited" ? (code ?? 1) : 1,
        status,
      });
    });
  });
}

/* ------------------------------------------------------------------ *
 * ripgrep with a pure-Node fallback
 * ------------------------------------------------------------------ */

let ripgrepAvailable: boolean | undefined;

/** Testing hook: force (or clear) the cached ripgrep availability decision. */
export function setRipgrepAvailability(available: boolean | undefined): void {
  ripgrepAvailable = available;
}

/** Runs ripgrep, or resolves undefined when ripgrep is not on PATH. */
async function runRipgrep(args: string[], cwd: string): Promise<ProcessOutcome | undefined> {
  if (ripgrepAvailable === false) return undefined;
  try {
    const result = await runProcess("rg", args, { cwd, timeoutMs: 60_000 });
    ripgrepAvailable = true;
    if (result.status !== "exited") throw new Error(`rg ${result.status}`);
    return result;
  } catch (error) {
    if (isSpawnEnoent(error)) {
      ripgrepAvailable = false;
      return undefined;
    }
    throw error;
  }
}

function safeMatchesGlob(path: string, pattern: string): boolean {
  try {
    return matchesGlob(path, pattern);
  } catch {
    return false;
  }
}

/**
 * Approximates ripgrep glob semantics: a pattern without a slash matches the
 * basename at any depth, a pattern with one is anchored at the search root,
 * and a leading `!` negates.
 */
function createGlobFilter(glob: string | undefined): (relativePath: string) => boolean {
  if (glob === undefined || glob === "") return () => true;
  const negated = glob.startsWith("!");
  const pattern = negated ? glob.slice(1) : glob;
  const patterns = pattern.includes("/")
    ? [pattern.replace(/^\//, ""), `**/${pattern.replace(/^\//, "")}`]
    : [pattern, `**/${pattern}`];
  return (relativePath) => {
    const matched = patterns.some((candidate) => safeMatchesGlob(relativePath, candidate));
    return negated ? !matched : matched;
  };
}

interface IgnoreRule {
  pattern: string;
  directoryOnly: boolean;
  anchored: boolean;
}

/** A deliberately simple .gitignore reader: no negations, no nested files. */
async function loadIgnoreRules(root: string): Promise<IgnoreRule[]> {
  let contents: string;
  try {
    contents = await readFile(join(root, ".gitignore"), "utf8");
  } catch {
    return [];
  }
  const rules: IgnoreRule[] = [];
  for (const rawLine of contents.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#") || line.startsWith("!")) continue;
    const directoryOnly = line.endsWith("/");
    const withoutSlash = directoryOnly ? line.slice(0, -1) : line;
    const anchored = withoutSlash.startsWith("/") || withoutSlash.includes("/");
    const pattern = withoutSlash.replace(/^\//, "");
    if (pattern === "") continue;
    rules.push({ pattern, directoryOnly, anchored });
  }
  return rules;
}

function isIgnored(rules: IgnoreRule[], relativePath: string, isDirectory: boolean): boolean {
  if (rules.length === 0) return false;
  return rules.some((rule) => {
    if (rule.directoryOnly && !isDirectory) return false;
    const candidates = rule.anchored
      ? [rule.pattern, `${rule.pattern}/**`]
      : [rule.pattern, `**/${rule.pattern}`, `**/${rule.pattern}/**`, `${rule.pattern}/**`];
    return candidates.some((candidate) => safeMatchesGlob(relativePath, candidate));
  });
}

interface WalkedFile {
  absolute: string;
  /** Path relative to the walk root, always with forward slashes. */
  relative: string;
}

async function walkFiles(root: string, rules: IgnoreRule[]): Promise<WalkedFile[]> {
  const found: WalkedFile[] = [];
  const visit = async (directory: string): Promise<void> => {
    if (found.length >= MAX_WALK_FILES) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (found.length >= MAX_WALK_FILES) return;
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      if (entry.isSymbolicLink()) continue;
      const absolute = join(directory, entry.name);
      const relativePath = relative(root, absolute).split(sep).join("/");
      if (entry.isDirectory()) {
        if (isIgnored(rules, relativePath, true)) continue;
        await visit(absolute);
      } else if (entry.isFile()) {
        if (isIgnored(rules, relativePath, false)) continue;
        found.push({ absolute, relative: relativePath });
      }
    }
  };
  await visit(root);
  return found;
}

/** Lists the candidate files below a path, honouring .git, node_modules, and a root .gitignore. */
async function collectFiles(path: string, glob: string | undefined): Promise<WalkedFile[]> {
  const info = await stat(path);
  const matchesFilter = createGlobFilter(glob);
  if (!info.isDirectory()) {
    const name = basename(path);
    return matchesFilter(name) ? [{ absolute: path, relative: name }] : [];
  }
  const rules = await loadIgnoreRules(path);
  const files = await walkFiles(path, rules);
  return files.filter((file) => matchesFilter(file.relative));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

interface GrepOptions {
  pattern: string;
  ignoreCase: boolean;
  fixedStrings: boolean;
  context: number;
  filesOnly: boolean;
  maxResults: number;
}

interface GrepMatch {
  file: string;
  line: number;
  column: number;
  text: string;
}

/** Pure-Node ripgrep replacement; emits the same `file:line:col:text` rows. */
async function grepFallback(
  files: WalkedFile[],
  displayPath: (absolute: string) => string,
  options: GrepOptions,
): Promise<string[]> {
  const source = options.fixedStrings ? escapeRegExp(options.pattern) : options.pattern;
  let expression: RegExp;
  try {
    expression = new RegExp(source, options.ignoreCase ? "gi" : "g");
  } catch (error) {
    throw new Error(`Invalid pattern: ${error instanceof Error ? error.message : String(error)}`);
  }

  const rendered: string[] = [];
  const matchingFiles: string[] = [];
  let total = 0;

  for (const file of files) {
    let buffer: Buffer;
    try {
      buffer = await readFile(file.absolute);
    } catch {
      continue;
    }
    if (looksBinary(buffer)) continue;
    const lines = buffer.toString("utf8").split("\n");
    const matches: GrepMatch[] = [];
    const name = displayPath(file.absolute);
    for (let index = 0; index < lines.length; index += 1) {
      const text = lines[index]!;
      expression.lastIndex = 0;
      const found = expression.exec(text);
      if (found === null) continue;
      matches.push({ file: name, line: index + 1, column: found.index + 1, text });
      total += 1;
      if (total >= MAX_FALLBACK_MATCHES) break;
    }
    if (matches.length === 0) continue;
    if (options.filesOnly) {
      matchingFiles.push(name);
      continue;
    }
    rendered.push(...renderFileMatches(name, lines, matches, options.context));
    if (total >= MAX_FALLBACK_MATCHES) break;
  }

  if (options.filesOnly) return matchingFiles;
  return rendered;
}

function renderFileMatches(
  name: string,
  lines: string[],
  matches: GrepMatch[],
  context: number,
): string[] {
  if (context === 0) {
    return matches.map((match) => `${name}:${match.line}:${match.column}:${truncateLine(match.text)}`);
  }
  const matchedLines = new Map(matches.map((match) => [match.line, match] as const));
  const ranges: Array<[number, number]> = [];
  for (const match of matches) {
    const from = Math.max(1, match.line - context);
    const to = Math.min(lines.length, match.line + context);
    const last = ranges[ranges.length - 1];
    if (last !== undefined && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else ranges.push([from, to]);
  }
  const rendered: string[] = [];
  for (const [index, range] of ranges.entries()) {
    if (index > 0) rendered.push("--");
    for (let line = range[0]; line <= range[1]; line += 1) {
      const text = truncateLine(lines[line - 1] ?? "");
      const match = matchedLines.get(line);
      rendered.push(match === undefined ? `${name}-${line}-${text}` : `${name}:${line}:${match.column}:${text}`);
    }
  }
  return rendered;
}

/* ------------------------------------------------------------------ *
 * Workspace paths
 * ------------------------------------------------------------------ */

export interface WorkspaceToolOptions {
  allowedRoots?: string[];
  /** Called after a successful `cd` so the host can follow the agent's working directory. */
  onDirectoryChange?: (cwd: string) => void;
  /** Include the background job operations; defaults to true. */
  jobs?: boolean;
}

const jobManagers = new Set<JobManager>();

/** Kill every background job started by any workspace tool set; call on shutdown. */
export async function closeAllJobs(): Promise<void> {
  const managers = [...jobManagers];
  jobManagers.clear();
  await Promise.all(managers.map((manager) => manager.closeAll().catch(() => undefined)));
}

/** The path-validation surface other agent modules depend on. */
export interface PathResolver {
  readonly cwd: string;
  existing(path: string): Promise<string>;
  writable(path: string): Promise<string>;
  display(path: string): string;
}

export class WorkspacePaths implements PathResolver {
  private currentDirectory: string;

  private constructor(
    cwd: string,
    readonly roots: string[],
    private readonly validationRoots: string[],
  ) {
    this.currentDirectory = cwd;
  }

  static async create(cwd: string, allowedRoots: string[] = []): Promise<WorkspacePaths> {
    const requestedRoots = [cwd, ...allowedRoots].map((root) => resolve(root));
    const resolvedRequestedRoots = await Promise.all(
      requestedRoots.map((root) => realpath(root)),
    );
    const resolvedCwd = resolvedRequestedRoots[0]!;
    const resolvedRoots = resolvedRequestedRoots;
    for (const root of resolvedRoots) {
      if (!(await stat(root)).isDirectory()) throw new Error(`Allowed root is not a directory: ${root}`);
    }
    const uniqueRoots = [...new Set(resolvedRoots)];
    const validationRoots = [...new Set([...requestedRoots, ...resolvedRoots])];
    return new WorkspacePaths(resolvedCwd, uniqueRoots, validationRoots);
  }

  get cwd(): string {
    return this.currentDirectory;
  }

  lexical(path: string): string {
    const normalized = path.startsWith("@") ? path.slice(1) : path;
    const candidate = resolve(this.currentDirectory, normalized || ".");
    if (!this.isInsideAllowedRoot(candidate)) {
      throw new Error(`Path escapes the workspace: ${path}`);
    }
    return candidate;
  }

  async existing(path: string): Promise<string> {
    const candidate = this.lexical(path);
    const resolved = await realpath(candidate);
    this.assertResolvedInside(resolved, path);
    return resolved;
  }

  async writable(path: string): Promise<string> {
    const candidate = this.lexical(path);
    try {
      const existing = await realpath(candidate);
      this.assertResolvedInside(existing, path);
      return existing;
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code !== "ENOENT") throw error;
    }

    let parent = dirname(candidate);
    for (;;) {
      try {
        const resolvedParent = await realpath(parent);
        this.assertResolvedInside(resolvedParent, path);
        return candidate;
      } catch (error) {
        const code = error instanceof Error && "code" in error ? error.code : undefined;
        if (code !== "ENOENT") throw error;
        const next = dirname(parent);
        if (next === parent) throw new Error(`Could not resolve a safe parent for ${path}`);
        parent = next;
      }
    }
  }

  display(path: string): string {
    const fromCurrent = relative(this.currentDirectory, path);
    if (fromCurrent !== ".." && !fromCurrent.startsWith(`..${sep}`) && !isAbsolute(fromCurrent)) {
      return fromCurrent || ".";
    }
    return path;
  }

  async changeDirectory(path: string): Promise<string> {
    const next = await this.existing(path);
    const info = await stat(next);
    if (!info.isDirectory()) throw new Error(`${this.display(next)} is not a directory`);
    this.currentDirectory = next;
    return next;
  }

  private assertResolvedInside(resolvedPath: string, requestedPath: string): void {
    if (!this.isInsideAllowedRoot(resolvedPath)) {
      throw new Error(`Path resolves outside the workspace: ${requestedPath}`);
    }
  }

  private isInsideAllowedRoot(path: string): boolean {
    return this.validationRoots.some((root) => {
      const fromRoot = relative(root, path);
      return fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
    });
  }
}

/* ------------------------------------------------------------------ *
 * edit helpers
 * ------------------------------------------------------------------ */

type MatchMode = "exact" | "trailing whitespace" | "indentation";

interface TolerantMatch {
  index: number;
  text: string;
  mode: MatchMode;
  count: number;
}

function tolerantPattern(oldText: string, mode: Exclude<MatchMode, "exact">): RegExp {
  const parts = oldText.split("\n").map((line) => {
    const withoutTrailing = line.replace(/[ \t]+$/, "");
    if (mode === "trailing whitespace") return `${escapeRegExp(withoutTrailing)}[ \\t]*`;
    const body = withoutTrailing.replace(/^[ \t]+/, "");
    return `[ \\t]*${escapeRegExp(body)}[ \\t]*`;
  });
  return new RegExp(parts.join("\n"), "g");
}

function findTolerantMatch(content: string, oldText: string): TolerantMatch | undefined {
  const first = content.indexOf(oldText);
  if (first >= 0) {
    return {
      index: first,
      text: oldText,
      mode: "exact",
      count: content.split(oldText).length - 1,
    };
  }
  for (const mode of ["trailing whitespace", "indentation"] as const) {
    const matches = [...content.matchAll(tolerantPattern(oldText, mode))];
    if (matches.length === 0) continue;
    const match = matches[0]!;
    return { index: match.index, text: match[0], mode, count: matches.length };
  }
  return undefined;
}

function leadingIndent(line: string): string {
  return /^[ \t]*/.exec(line)?.[0] ?? "";
}

/** Re-indents replacement text from the indentation old_text assumed to the one the file uses. */
function reindent(newText: string, from: string, to: string): string {
  if (from === to) return newText;
  return newText
    .split("\n")
    .map((line) => (line.startsWith(from) ? `${to}${line.slice(from.length)}` : line))
    .join("\n");
}

function lineNumberAt(content: string, index: number): number {
  let line = 1;
  for (let position = 0; position < index; position += 1) {
    if (content.charCodeAt(position) === 10) line += 1;
  }
  return line;
}

/** A short numbered window around the change so the model can verify without re-reading. */
function changedRegionSnippet(content: string, firstLine: number, lastLine: number): string {
  const lines = content.split("\n");
  const from = Math.max(1, firstLine - 3);
  const to = Math.min(lines.length, lastLine + 3);
  const shown: string[] = [];
  for (let line = from; line <= to; line += 1) {
    if (shown.length >= 16) {
      shown.push(`… ${to - line + 1} more lines`);
      break;
    }
    shown.push(`${line}: ${truncateLine(lines[line - 1] ?? "")}`);
  }
  return shown.join("\n");
}

/* ------------------------------------------------------------------ *
 * Tools
 * ------------------------------------------------------------------ */

export async function createWorkspaceTools(
  cwd: string,
  options: WorkspaceToolOptions = {},
): Promise<ToolDefinition[]> {
  const workspace = await WorkspacePaths.create(cwd, options.allowedRoots);

  /** Rewrites the absolute search root ripgrep echoes back into a workspace-relative path. */
  const shortenRipgrepLine = (line: string, searchRoot: string): string => {
    if (line === "--" || !line.startsWith(searchRoot)) return line;
    const displayRoot = workspace.display(searchRoot);
    const remainder = line.slice(searchRoot.length);
    if (remainder.startsWith(sep)) {
      return displayRoot === "." ? remainder.slice(1) : `${displayRoot}${remainder}`;
    }
    return `${displayRoot}${remainder}`;
  };

  const retained = new RetainedOutputs();

  const readRetainedOutput = (id: number, offset: number, limit: number): string => {
    const content = retained.get(id);
    if (content === undefined) {
      throw new Error(`${OUTPUT_SCHEME}${id} is no longer retained; re-run the command`);
    }
    const lines = content.split("\n");
    const selected = lines.slice(offset - 1, offset - 1 + limit);
    const numbered = selected.map((line, index) => `${offset + index}: ${truncateLine(line)}`).join("\n");
    const remaining = lines.length - (offset - 1 + selected.length);
    const suffix = remaining > 0 ? `\n… ${remaining} more lines` : "";
    return truncateOutput(`${OUTPUT_SCHEME}${id} (${lines.length} lines)\n${numbered}${suffix}`);
  };

  const tools: ToolDefinition[] = [
    {
      name: "pwd",
      description: "Show the current working directory and every granted filesystem root.",
      parameters: "none",
      mutates: false,
      execute: async () =>
        [
          `Current working directory: ${workspace.cwd}`,
          "Allowed roots:",
          ...workspace.roots.map((root) => `- ${root}`),
        ].join("\n"),
    },
    {
      name: "cd",
      description: "Change the persistent working directory; the destination must be inside an allowed root.",
      parameters: "path",
      mutates: false,
      execute: async (args) => {
        const next = await workspace.changeDirectory(stringArg(args, "path"));
        options.onDirectoryChange?.(next);
        return `Current working directory: ${next}`;
      },
    },
    {
      name: "read",
      description:
        'Read a UTF-8 text file with numbered lines; path may also be a retained "harness://output/<id>". Binary files are rejected. Use offset and limit for large files.',
      parameters: "path, offset?=1, limit?=300",
      mutates: false,
      execute: async (args) => {
        const requested = stringArg(args, "path");
        const offset = numberArg(args, "offset", 1, 1, 10_000_000);
        const limit = numberArg(args, "limit", 300, 1, 2_000);

        const retainedId = parseOutputReference(requested);
        if (retainedId !== undefined) return readRetainedOutput(retainedId, offset, limit);

        const path = await workspace.existing(requested);
        const info = await stat(path);
        if (!info.isFile()) throw new Error(`${workspace.display(path)} is not a file`);
        if (info.size > MAX_READ_BYTES) {
          throw new Error(
            `${workspace.display(path)} is ${info.size} bytes; refusing to read more than ${MAX_READ_BYTES} bytes`,
          );
        }
        const buffer = await readFile(path);
        if (looksBinary(buffer)) {
          throw new Error(
            `${workspace.display(path)} looks binary (NUL byte in the first ${BINARY_SNIFF_BYTES} bytes); use bash for binary inspection`,
          );
        }
        const lines = buffer.toString("utf8").split("\n");
        const selected = lines.slice(offset - 1, offset - 1 + limit);
        const numbered = selected
          .map((line, index) => `${offset + index}: ${truncateLine(line)}`)
          .join("\n");
        const remaining = lines.length - (offset - 1 + selected.length);
        const suffix = remaining > 0 ? `\n… ${remaining} more lines` : "";
        return truncateOutput(`${workspace.display(path)} (${lines.length} lines)\n${numbered}${suffix}`, {
          store: retained,
        });
      },
    },
    {
      name: "grep",
      description:
        "Search file contents by regex (ripgrep when installed, otherwise a built-in walker); returns file:line:col:text.",
      parameters:
        'pattern, path?=".", glob?, max_results?=200, ignore_case?=false, fixed_strings?=false, context?=0, files_only?=false',
      mutates: false,
      execute: async (args) => {
        const pattern = stringArg(args, "pattern");
        const requested = stringArg(args, "path", ".");
        const path = await workspace.existing(requested);
        const maxResults = numberArg(args, "max_results", 200, 1, 2_000);
        const glob = optionalStringArg(args, "glob");
        const ignoreCase = booleanArg(args, "ignore_case", false);
        const fixedStrings = booleanArg(args, "fixed_strings", false);
        const context = numberArg(args, "context", 0, 0, 20);
        const filesOnly = booleanArg(args, "files_only", false);

        const commandArgs = ["--no-heading", "--color", "never"];
        if (filesOnly) commandArgs.push("--files-with-matches");
        else commandArgs.push("--line-number", "--column");
        if (ignoreCase) commandArgs.push("--ignore-case");
        if (fixedStrings) commandArgs.push("--fixed-strings");
        if (context > 0 && !filesOnly) commandArgs.push("--context", String(context));
        if (glob !== undefined) commandArgs.push("--glob", glob);
        commandArgs.push("--", pattern, path);

        let lines: string[];
        const result = await runRipgrep(commandArgs, workspace.cwd);
        if (result === undefined) {
          const files = await collectFiles(path, glob);
          lines = await grepFallback(files, (absolute) => workspace.display(absolute), {
            pattern,
            ignoreCase,
            fixedStrings,
            context,
            filesOnly,
            maxResults,
          });
        } else {
          if (result.exitCode > 1) throw new Error(result.stderr || `rg exited ${result.exitCode}`);
          lines = result.stdout
            .trimEnd()
            .split("\n")
            .filter(Boolean)
            .map((line) => shortenRipgrepLine(line, path));
        }

        if (lines.length === 0) return filesOnly ? "No matching files" : "No matches";
        const shown = lines.slice(0, maxResults);
        if (lines.length > shown.length) {
          shown.push(`… ${lines.length - shown.length} more ${filesOnly ? "files" : "matches"}`);
        }
        return truncateOutput(shown.join("\n"), { store: retained });
      },
    },
    {
      name: "find",
      description:
        "List repository files, optionally below a path and filtered by a glob; skips .git, node_modules, and root .gitignore entries.",
      parameters: 'path?=".", glob?, max_results?=500',
      mutates: false,
      execute: async (args) => {
        const requested = stringArg(args, "path", ".");
        const path = await workspace.existing(requested);
        const maxResults = numberArg(args, "max_results", 500, 1, 5_000);
        const glob = optionalStringArg(args, "glob");

        const commandArgs = ["--files", "--hidden", "--glob", "!.git/**", "--glob", "!node_modules/**"];
        if (glob !== undefined) commandArgs.push("--glob", glob);
        commandArgs.push(path);

        let files: string[];
        const result = await runRipgrep(commandArgs, workspace.cwd);
        if (result === undefined) {
          const walked = await collectFiles(path, glob);
          files = walked.map((file) => workspace.display(file.absolute));
        } else {
          if (result.exitCode > 1) throw new Error(result.stderr || `rg exited ${result.exitCode}`);
          files = result.stdout
            .trimEnd()
            .split("\n")
            .filter(Boolean)
            .map((file) => workspace.display(isAbsolute(file) ? file : resolve(workspace.cwd, file)));
        }

        if (files.length === 0) return "No files found";
        const shown = files.slice(0, maxResults);
        if (files.length > shown.length) shown.push(`… ${files.length - shown.length} more files`);
        return truncateOutput(shown.join("\n"), { store: retained });
      },
    },
    {
      name: "ls",
      description: "List one directory with entry types and sizes.",
      parameters: 'path?="."',
      mutates: false,
      execute: async (args) => {
        const path = await workspace.existing(stringArg(args, "path", "."));
        const entries = await readdir(path, { withFileTypes: true });
        const rows = await Promise.all(
          entries
            .sort((left, right) => left.name.localeCompare(right.name))
            .map(async (entry) => {
              const type = entry.isDirectory() ? "dir " : entry.isSymbolicLink() ? "link" : "file";
              const size = entry.isFile() ? (await stat(resolve(path, entry.name))).size : 0;
              return `${type}\t${size}\t${entry.name}`;
            }),
        );
        return rows.join("\n") || "Directory is empty";
      },
    },
    {
      name: "edit",
      description:
        "Edit an existing UTF-8 file by exact text replacement or by inclusive line range. Exact mode requires a unique match unless replace_all is set; it retries whitespace-tolerantly and returns a numbered snippet of the change.",
      parameters:
        "(exact) path, old_text, new_text, replace_all?=false | (line-range) path, start_line, end_line?=start_line, new_text",
      mutates: true,
      execute: async (args) => {
        const path = await workspace.existing(stringArg(args, "path"));
        const original = await readFile(path, "utf8");
        const usesCrlf = original.includes("\r\n");
        const content = usesCrlf ? original.replaceAll("\r\n", "\n") : original;
        const save = async (updated: string): Promise<void> => {
          await writeFile(path, usesCrlf ? updated.replaceAll("\n", "\r\n") : updated, "utf8");
        };
        const newText = aliasedStringArg(args, ["new_text", "newText", "new_string", "newString"]);
        const hasRange =
          args.start_line !== undefined ||
          args.startLine !== undefined ||
          args.end_line !== undefined ||
          args.endLine !== undefined;
        const hasExact =
          args.old_text !== undefined ||
          args.oldText !== undefined ||
          args.old_string !== undefined ||
          args.oldString !== undefined;

        if (hasRange && hasExact) {
          throw new Error("Use either old_text exact replacement or start_line/end_line, not both");
        }

        if (hasRange) {
          const startLine = aliasedIntegerArg(args, ["start_line", "startLine"]);
          const endLine = aliasedIntegerArg(args, ["end_line", "endLine"], startLine);
          if (endLine < startLine) throw new Error("end_line must be greater than or equal to start_line");
          const lines = content.split("\n");
          if (endLine > lines.length) {
            throw new Error(`Line range ${startLine}-${endLine} exceeds the ${lines.length}-line file`);
          }
          const replacementLines =
            newText.length === 0 ? [] : newText.replace(/\n$/, "").split("\n");
          lines.splice(startLine - 1, endLine - startLine + 1, ...replacementLines);
          const updated = lines.join("\n");
          await save(updated);
          const lastLine = startLine + Math.max(replacementLines.length, 1) - 1;
          return [
            `Updated ${workspace.display(path)} lines ${startLine}-${endLine}`,
            changedRegionSnippet(updated, startLine, lastLine),
          ].join("\n");
        }

        if (!hasExact) {
          throw new Error("edit requires either old_text or start_line/end_line");
        }
        const oldText = aliasedStringArg(args, ["old_text", "oldText", "old_string", "oldString"]);
        const replaceAll = aliasedBooleanArg(args, ["replace_all", "replaceAll"], false);
        if (oldText.length === 0) throw new Error("old_text must not be empty");

        const match = findTolerantMatch(content, oldText);
        if (match === undefined) throw new Error("old_text was not found");
        if (!replaceAll && match.count > 1) {
          throw new Error("old_text occurs more than once; include more surrounding context");
        }

        let updated: string;
        if (match.mode === "exact") {
          updated = replaceAll
            ? content.split(oldText).join(newText)
            : `${content.slice(0, match.index)}${newText}${content.slice(match.index + oldText.length)}`;
        } else {
          const expectedIndent = leadingIndent(oldText.split("\n")[0]!);
          const actualIndent = leadingIndent(match.text.split("\n")[0]!);
          const replacement = reindent(newText, expectedIndent, actualIndent);
          updated = `${content.slice(0, match.index)}${replacement}${content.slice(match.index + match.text.length)}`;
        }
        await save(updated);

        const replacements = replaceAll && match.mode === "exact" ? match.count : 1;
        const firstLine = lineNumberAt(updated, match.index);
        const lastLine = firstLine + Math.max(newText.split("\n").length, 1) - 1;
        const how = match.mode === "exact" ? "" : ` matched ignoring ${match.mode}`;
        return [
          `Updated ${workspace.display(path)} (${replacements} replacement${replacements !== 1 ? "s" : ""})${how}`,
          changedRegionSnippet(updated, firstLine, lastLine),
        ].join("\n");
      },
    },
    {
      name: "write",
      description:
        "Create or completely overwrite a UTF-8 file, creating parent directories as needed. Overwriting a binary file needs force.",
      parameters: "path, content, force?=false",
      mutates: true,
      execute: async (args) => {
        const path = await workspace.writable(stringArg(args, "path"));
        const content = stringArg(args, "content");
        const force = booleanArg(args, "force", false);

        let previousSize: number | undefined;
        try {
          const info = await stat(path);
          if (!info.isFile()) throw new Error(`${workspace.display(path)} is not a file`);
          previousSize = info.size;
          if (!force && looksBinary(await readFile(path))) {
            throw new Error(
              `${workspace.display(path)} looks binary; pass force=true to overwrite it`,
            );
          }
        } catch (error) {
          const code = error instanceof Error && "code" in error ? error.code : undefined;
          if (code !== "ENOENT") throw error;
        }

        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, content, "utf8");
        return previousSize === undefined
          ? `Created ${workspace.display(path)} (${content.length} characters)`
          : `Overwrote ${workspace.display(path)} (${content.length} characters; previous file was ${previousSize} bytes)`;
      },
    },
    {
      name: "bash",
      description:
        "Run a shell command in the workspace: tests, builds, git, and anything without a dedicated operation. Output is trimmed head and tail; the full text stays readable at harness://output/<id>.",
      parameters: "command, timeout_ms?=30000, stdin?, cwd?",
      mutates: true,
      execute: async (args, context?: ToolExecutionContext) => {
        const command = stringArg(args, "command");
        const timeoutMs = numberArg(args, "timeout_ms", 30_000, 100, 300_000);
        const stdin = optionalStringArg(args, "stdin");
        const requestedCwd = optionalStringArg(args, "cwd");

        let directory = workspace.cwd;
        if (requestedCwd !== undefined) {
          directory = await workspace.existing(requestedCwd);
          if (!(await stat(directory)).isDirectory()) {
            throw new Error(`${workspace.display(directory)} is not a directory`);
          }
        }

        const shell = await resolveShell();
        const result = await runProcess(shell, ["-lc", command], {
          cwd: directory,
          timeoutMs,
          ...(stdin === undefined ? {} : { stdin }),
          ...(context?.signal === undefined ? {} : { signal: context.signal }),
        });

        const cap = config.toolOutputMaxChars;
        const stderrBudget = Math.min(result.stderr.length, Math.max(1_000, Math.floor(cap / 3)));
        const stdoutBudget = Math.max(1_000, cap - stderrBudget);
        const stdout = truncateOutput(result.stdout, { limit: stdoutBudget, store: retained });
        const stderr = truncateOutput(result.stderr, { limit: stderrBudget, store: retained });

        const status =
          result.status === "exited" ? String(result.exitCode) : result.status;
        const sections = [
          `exit_code: ${status}`,
          result.status === "timeout" ? `timed_out after ${timeoutMs}ms` : "",
          result.status === "aborted" ? "aborted by the harness" : "",
          stdout ? `stdout:\n${stdout}` : "",
          stderr ? `stderr:\n${stderr}` : "",
        ].filter(Boolean);
        return sections.join("\n");
      },
    },
    createPatchTool(workspace),
    createSkillTool(() => workspace.cwd),
  ];

  if (options.jobs !== false) {
    const manager = new JobManager({ resolver: workspace });
    jobManagers.add(manager);
    tools.push(...createJobTools(manager));
  }

  retainedOutputsByToolSet.set(tools, retained);
  return tools;
}
