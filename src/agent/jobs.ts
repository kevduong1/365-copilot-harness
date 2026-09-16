import { spawn, type ChildProcess } from "node:child_process";
import { stat } from "node:fs/promises";
import type { PathResolver } from "./tools.js";
import type { ToolDefinition } from "./types.js";

export type JobStatus = "running" | "exited" | "killed" | "failed";

export interface JobRecord {
  id: number;
  /** Caller supplied label, or an abbreviation of the command. */
  name: string;
  command: string;
  cwd: string;
  status: JobStatus;
  pid?: number;
  exitCode?: number;
  signal?: NodeJS.Signals;
  /** Spawn failure message; only set when status is `failed`. */
  error?: string;
  startedAt: number;
  endedAt?: number;
}

export interface JobManagerOptions {
  resolver: PathResolver;
  /** Shell used to run commands; defaults to $SHELL, then /bin/zsh or /bin/bash. */
  shell?: string;
  /** Concurrently running jobs allowed before `job_start` refuses. */
  maxJobs?: number;
  /** Characters of captured output retained per job before the oldest is dropped. */
  maxBufferChars?: number;
}

export interface JobOutput {
  record: JobRecord;
  /** Output selected by this read, already bounded by `tail`. */
  text: string;
  /** Characters discarded from the ring buffer before the requested start. */
  droppedChars: number;
  /** Lines omitted from the front of `text` because of `tail`. */
  omittedLines: number;
  /** False when the job produced nothing new since the previous read. */
  hasNew: boolean;
}

const DEFAULT_MAX_JOBS = 8;
const DEFAULT_MAX_BUFFER_CHARS = 200_000;
const FORCE_KILL_GRACE_MS = 1_000;
const NAME_LENGTH = 40;

/**
 * Control sequences stripped from captured output. The operating-system
 * command branch stops at the next ESC or BEL rather than scanning ahead for a
 * terminator, so an unterminated title sequence cannot swallow the real output
 * that follows it.
 */
const ANSI_PATTERN =
  // eslint-disable-next-line no-control-regex
  /\u001B\[[0-9;:?]*[ -/]*[@-~]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)|\u001B[@-Z\\-_]/g;
const ANSI_PREFIX =
  // eslint-disable-next-line no-control-regex
  /^\u001B(?:\[[0-9;:?]*[ -/]*[@-~]|\][^\u0007\u001B]*(?:\u0007|\u001B\\)|[@-Z\\-_])/;
/** An operating-system command whose BEL or ESC-backslash terminator has not arrived yet. */
const PARTIAL_OSC =
  // eslint-disable-next-line no-control-regex
  /^\u001B\][^\u0007\u001B]*$/;

/** True for a sequence that has started but whose terminator is still missing. */
function isIncomplete(tail: string): boolean {
  return PARTIAL_OSC.test(tail) || !ANSI_PREFIX.test(tail);
}

/**
 * Strips terminal control sequences from a stream arriving in arbitrary
 * chunks, holding back a trailing partial escape or carriage return so a
 * sequence split across two chunks is still recognised.
 */
class StreamSanitizer {
  private carry = "";

  push(chunk: string): string {
    let text = this.carry + chunk;
    this.carry = "";
    const escape = text.lastIndexOf("\u001B");
    if (escape >= 0 && text.length - escape < 64 && isIncomplete(text.slice(escape))) {
      this.carry = text.slice(escape);
      text = text.slice(0, escape);
    }
    text = text.replace(ANSI_PATTERN, "");
    if (text.endsWith("\r")) {
      this.carry = `\r${this.carry}`;
      text = text.slice(0, -1);
    }
    return text.replace(/\r\n?/g, "\n");
  }

  flush(): string {
    const remainder = this.carry;
    this.carry = "";
    return remainder.replace(ANSI_PATTERN, "").replace(/\r\n?/g, "\n");
  }
}

interface JobEntry {
  record: JobRecord;
  child: ChildProcess | undefined;
  /** Retained tail of the combined stdout/stderr stream. */
  buffer: string;
  /** Characters written since the job started, including dropped ones. */
  total: number;
  /** Characters dropped off the front of the buffer; also the buffer's start offset. */
  dropped: number;
  /** Absolute offset already returned by `output`. */
  cursor: number;
  killRequested: boolean;
  exit: Promise<void>;
  settle: () => void;
  stdout: StreamSanitizer;
  stderr: StreamSanitizer;
}

function defaultShell(): string {
  const fromEnvironment = process.env.SHELL;
  if (fromEnvironment !== undefined && fromEnvironment.length > 0) return fromEnvironment;
  return process.platform === "darwin" ? "/bin/zsh" : "/bin/bash";
}

function abbreviate(command: string): string {
  const flattened = command.replace(/\s+/g, " ").trim();
  if (flattened.length <= NAME_LENGTH) return flattened || "job";
  return `${flattened.slice(0, NAME_LENGTH)}…`;
}

/**
 * Runs shell commands in the background so a dev server, watcher, or long test
 * run costs one tool call to start and a cheap poll for new output, instead of
 * blocking the agent's single-threaded round trip.
 */
export class JobManager {
  private readonly entries = new Map<number, JobEntry>();
  private readonly resolver: PathResolver;
  private readonly shell: string;
  private readonly maxJobs: number;
  private readonly maxBufferChars: number;
  private nextId = 1;

  constructor(options: JobManagerOptions) {
    this.resolver = options.resolver;
    this.shell = options.shell ?? defaultShell();
    this.maxJobs = options.maxJobs ?? DEFAULT_MAX_JOBS;
    this.maxBufferChars = options.maxBufferChars ?? DEFAULT_MAX_BUFFER_CHARS;
  }

  get cwd(): string {
    return this.resolver.cwd;
  }

  list(): JobRecord[] {
    return [...this.entries.values()].map((entry) => entry.record);
  }

  get(id: number): JobRecord {
    return this.entry(id).record;
  }

  async start(command: string, name?: string, cwd?: string): Promise<JobRecord> {
    if (command.trim().length === 0) throw new Error("command must be a non-empty string");
    const running = [...this.entries.values()].filter(
      (entry) => entry.record.status === "running",
    );
    if (running.length >= this.maxJobs) {
      const ids = running.map((entry) => `#${entry.record.id}`).join(", ");
      throw new Error(
        `Too many background jobs already running (${running.length}/${this.maxJobs}): ${ids}. Stop one with job_kill before starting another.`,
      );
    }

    const directory = cwd === undefined ? this.resolver.cwd : await this.resolveDirectory(cwd);
    const useProcessGroup = process.platform !== "win32";
    const id = this.nextId++;
    let settle: () => void = () => undefined;
    const exit = new Promise<void>((resolvePromise) => {
      settle = resolvePromise;
    });
    const entry: JobEntry = {
      record: {
        id,
        name: name !== undefined && name.trim().length > 0 ? name.trim() : abbreviate(command),
        command,
        cwd: directory,
        status: "running",
        startedAt: Date.now(),
      },
      child: undefined,
      buffer: "",
      total: 0,
      dropped: 0,
      cursor: 0,
      killRequested: false,
      exit,
      settle,
      stdout: new StreamSanitizer(),
      stderr: new StreamSanitizer(),
    };
    this.entries.set(id, entry);

    const child = spawn(this.shell, ["-lc", command], {
      cwd: directory,
      detached: useProcessGroup,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1", TERM: "dumb", PAGER: "cat", GIT_PAGER: "cat" },
    });
    entry.child = child;
    if (child.pid !== undefined) entry.record.pid = child.pid;

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.append(entry, entry.stdout.push(chunk)));
    child.stderr?.on("data", (chunk: string) => this.append(entry, entry.stderr.push(chunk)));
    child.once("error", (error: Error) => {
      entry.record.status = "failed";
      entry.record.error = error.message;
      entry.record.endedAt = Date.now();
      this.append(entry, `${error.message}\n`);
      entry.settle();
    });
    child.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
      this.append(entry, entry.stdout.flush());
      this.append(entry, entry.stderr.flush());
      if (entry.record.status === "failed") {
        entry.settle();
        return;
      }
      entry.record.endedAt = Date.now();
      if (signal !== null) entry.record.signal = signal;
      if (code !== null) entry.record.exitCode = code;
      entry.record.status = entry.killRequested || signal !== null ? "killed" : "exited";
      entry.settle();
    });

    return entry.record;
  }

  /** Returns output produced since the previous read, or the whole buffer. */
  read(id: number, options: { tail?: number; all?: boolean } = {}): JobOutput {
    const entry = this.entry(id);
    const all = options.all ?? false;
    const tail = options.tail;
    const from = all ? entry.dropped : Math.max(entry.cursor, entry.dropped);
    const droppedChars = all ? 0 : Math.max(0, entry.dropped - entry.cursor);
    const hasNew = entry.total > entry.cursor;
    let text = entry.buffer.slice(from - entry.dropped);
    entry.cursor = entry.total;

    let omittedLines = 0;
    if (tail !== undefined && text.length > 0) {
      const trailingNewline = text.endsWith("\n");
      const lines = (trailingNewline ? text.slice(0, -1) : text).split("\n");
      if (lines.length > tail) {
        omittedLines = lines.length - tail;
        text = lines.slice(-tail).join("\n") + (trailingNewline ? "\n" : "");
      }
    }
    return { record: entry.record, text, droppedChars, omittedLines, hasNew };
  }

  /** Resolves once the job exits, or once `timeoutMs` elapses. */
  async wait(id: number, timeoutMs: number, signal?: AbortSignal): Promise<JobRecord> {
    const entry = this.entry(id);
    if (entry.record.status !== "running") return entry.record;
    await new Promise<void>((resolvePromise, reject) => {
      const timer = setTimeout(finish, timeoutMs);
      const onAbort = (): void => {
        cleanup();
        reject(signal?.reason instanceof Error ? signal.reason : new Error("job_wait was aborted"));
      };
      function cleanup(): void {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
      function finish(): void {
        cleanup();
        resolvePromise();
      }
      if (signal?.aborted === true) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      void entry.exit.then(finish, finish);
    });
    return entry.record;
  }

  /** Signals the job's process group, escalating to SIGKILL after a grace period. */
  async kill(id: number, signal: NodeJS.Signals = "SIGTERM"): Promise<JobRecord> {
    const entry = this.entry(id);
    if (entry.record.status !== "running") return entry.record;
    entry.killRequested = true;
    this.signal(entry, signal);
    if (signal !== "SIGKILL") {
      const timer = setTimeout(() => this.signal(entry, "SIGKILL"), FORCE_KILL_GRACE_MS);
      timer.unref?.();
      await entry.exit;
      clearTimeout(timer);
    } else {
      await entry.exit;
    }
    return entry.record;
  }

  /** Stops every running job; used when the agent session shuts down. */
  async closeAll(): Promise<void> {
    const running = [...this.entries.values()].filter(
      (entry) => entry.record.status === "running",
    );
    await Promise.all(running.map((entry) => this.kill(entry.record.id).catch(() => undefined)));
  }

  private entry(id: number): JobEntry {
    const entry = this.entries.get(id);
    if (entry === undefined) throw new Error(`No background job #${id}; run job_list to see jobs`);
    return entry;
  }

  private signal(entry: JobEntry, signal: NodeJS.Signals): void {
    const child = entry.child;
    if (child === undefined) return;
    try {
      if (process.platform !== "win32" && child.pid !== undefined) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      // The job may have exited between the status check and this signal.
    }
  }

  private append(entry: JobEntry, text: string): void {
    if (text.length === 0) return;
    entry.buffer += text;
    entry.total += text.length;
    if (entry.buffer.length > this.maxBufferChars) {
      const excess = entry.buffer.length - this.maxBufferChars;
      entry.buffer = entry.buffer.slice(excess);
      entry.dropped += excess;
    }
  }

  private async resolveDirectory(path: string): Promise<string> {
    const resolved = await this.resolver.existing(path);
    if (!(await stat(resolved)).isDirectory()) {
      throw new Error(`${this.resolver.display(resolved)} is not a directory`);
    }
    return resolved;
  }
}

function statusText(record: JobRecord): string {
  switch (record.status) {
    case "running":
      return `running (pid ${record.pid ?? "?"}, ${Math.round((Date.now() - record.startedAt) / 1000)}s)`;
    case "exited":
      return `exited ${record.exitCode ?? 0}`;
    case "killed":
      return `killed${record.signal === undefined ? "" : ` (${record.signal})`}`;
    case "failed":
      return `failed: ${record.error ?? "could not start"}`;
  }
}

function formatOutput(output: JobOutput): string {
  const header = `#${output.record.id} ${output.record.name} — ${statusText(output.record)}`;
  const notes: string[] = [];
  if (output.droppedChars > 0) {
    notes.push(`… ${output.droppedChars} characters dropped; the buffer filled up`);
  }
  if (output.omittedLines > 0) notes.push(`… ${output.omittedLines} earlier lines omitted`);
  const body = output.text.replace(/\n+$/, "");
  if (body.length === 0) {
    notes.push(output.hasNew ? "(no output)" : "(no new output since the last read)");
    return [header, ...notes].join("\n");
  }
  return [header, ...notes, body].join("\n");
}

function requireString(args: Record<string, unknown>, names: string[]): string {
  for (const name of names) {
    const value = args[name];
    if (value === undefined) continue;
    if (typeof value !== "string") throw new Error(`${name} must be a string`);
    return value;
  }
  throw new Error(`${names[0]} must be a string`);
}

function optionalString(args: Record<string, unknown>, names: string[]): string | undefined {
  for (const name of names) {
    const value = args[name];
    if (value === undefined) continue;
    if (typeof value !== "string") throw new Error(`${name} must be a string`);
    return value;
  }
  return undefined;
}

function requireId(args: Record<string, unknown>): number {
  for (const name of ["id", "job_id", "jobId"]) {
    const value = args[name];
    if (value === undefined) continue;
    const id = typeof value === "string" ? Number(value.trim().replace(/^#/, "")) : value;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) {
      throw new Error(`${name} must be a positive integer job id`);
    }
    return id;
  }
  throw new Error("id must be a positive integer job id");
}

function boundedNumber(
  args: Record<string, unknown>,
  names: string[],
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  for (const name of names) {
    const value = args[name];
    if (value === undefined) continue;
    const parsed = typeof value === "string" ? Number(value) : value;
    if (
      typeof parsed !== "number" ||
      !Number.isInteger(parsed) ||
      parsed < minimum ||
      parsed > maximum
    ) {
      throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
    }
    return parsed;
  }
  return fallback;
}

function booleanArg(args: Record<string, unknown>, names: string[], fallback: boolean): boolean {
  for (const name of names) {
    const value = args[name];
    if (value === undefined) continue;
    if (typeof value === "boolean") return value;
    if (value === "true") return true;
    if (value === "false") return false;
    throw new Error(`${name} must be a boolean`);
  }
  return fallback;
}

const SIGNALS = new Set<string>([
  "SIGTERM",
  "SIGKILL",
  "SIGINT",
  "SIGHUP",
  "SIGQUIT",
  "SIGUSR1",
  "SIGUSR2",
]);

function signalArg(args: Record<string, unknown>): NodeJS.Signals {
  const value = optionalString(args, ["signal"]);
  if (value === undefined) return "SIGTERM";
  const upper = value.toUpperCase();
  const normalized = upper.startsWith("SIG") ? upper : `SIG${upper}`;
  if (!SIGNALS.has(normalized)) {
    throw new Error(`signal must be one of ${[...SIGNALS].join(", ")}`);
  }
  return normalized as NodeJS.Signals;
}

/** The background-process operations exposed to the coding agent. */
export function createJobTools(manager: JobManager): ToolDefinition[] {
  return [
    {
      name: "job_start",
      description:
        "Start a long-running shell command in the background: dev servers, file watchers, builds, and test runs that outlive a single tool call. Returns immediately; poll job_output for progress or job_wait to block until it exits.",
      parameters: "command, name?, cwd?",
      mutates: true,
      execute: async (args) => {
        const command = requireString(args, ["command", "cmd"]);
        const name = optionalString(args, ["name", "label"]);
        const cwd = optionalString(args, ["cwd", "directory"]);
        const record = await manager.start(command, name, cwd);
        return `Started job #${record.id} (${record.name}), pid ${record.pid ?? "?"}, in ${record.cwd}. Poll it with job_output id=${record.id}, or job_wait to block until it exits.`;
      },
    },
    {
      name: "job_output",
      description:
        "Read a background job's status and the output it has produced since the previous read. Pass all=true for the whole retained buffer instead of only new output.",
      parameters: "id, tail?=200, all?=false",
      mutates: false,
      execute: async (args) => {
        const id = requireId(args);
        const tail = boundedNumber(args, ["tail", "lines"], 200, 1, 10_000);
        const all = booleanArg(args, ["all", "full"], false);
        return formatOutput(manager.read(id, { tail, all }));
      },
    },
    {
      name: "job_wait",
      description:
        "Block until a background job exits or the timeout elapses, then return its status and the output produced since the previous read.",
      parameters: "id, timeout_ms?=30000",
      mutates: false,
      execute: async (args, context) => {
        const id = requireId(args);
        const timeoutMs = boundedNumber(args, ["timeout_ms", "timeoutMs"], 30_000, 100, 600_000);
        const tail = boundedNumber(args, ["tail", "lines"], 200, 1, 10_000);
        const record = await manager.wait(id, timeoutMs, context?.signal);
        const output = formatOutput(manager.read(id, { tail }));
        if (record.status === "running") {
          return `${output}\n… still running after ${timeoutMs}ms; call job_wait again or job_kill to stop it`;
        }
        return output;
      },
    },
    {
      name: "job_kill",
      description:
        "Stop a background job by signalling its whole process group; SIGKILL follows one second later if it is still alive.",
      parameters: 'id, signal?="SIGTERM"',
      mutates: true,
      execute: async (args) => {
        const id = requireId(args);
        const record = await manager.kill(id, signalArg(args));
        return `#${record.id} ${record.name} — ${statusText(record)}`;
      },
    },
    {
      name: "job_list",
      description: "List every background job started in this session with its status.",
      parameters: "none",
      mutates: false,
      execute: async () => {
        const records = manager.list();
        if (records.length === 0) return "No background jobs";
        const rows = records.map(
          (record) => `#${record.id}\t${statusText(record)}\t${record.name}\t${record.command}`,
        );
        return ["id\tstatus\tname\tcommand", ...rows].join("\n");
      },
    },
  ];
}
