import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

export const SHELL_TIMEOUT_MS = 60_000;
export const SHELL_OUTPUT_LIMIT = 20_000;
const FORCE_KILL_GRACE_MS = 1_000;

export interface ShellRunOptions {
  cwd?: string;
  timeoutMs?: number;
  limit?: number;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

export interface ShellResult {
  ok: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  output: string;
}

/** The interactive shell to run `!` lines through, falling back per platform. */
export function loginShell(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const configured = env.SHELL?.trim();
  if (configured) return configured;
  return platform === "darwin" ? "/bin/zsh" : "/bin/bash";
}

// CSI/OSC and the other escape forms a TTY-unaware program still emits into a
// pipe. Built from a string so the escape bytes stay written as escapes.
const ANSI = new RegExp(
  "[\\u001B\\u009B](?:\\[[0-?]*[ -/]*[@-~]|\\][^\\u0007\\u001B]*(?:\\u0007|\\u001B\\\\)?|[@-Z\\\\-_])",
  "gu",
);

export function stripAnsi(text: string): string {
  return text.replaceAll(ANSI, "");
}

/** Keep the head and the tail: the command line is at the top, the error at the bottom. */
export function capOutput(text: string, limit = SHELL_OUTPUT_LIMIT): string {
  if (text.length <= limit) return text;
  const half = Math.floor((limit - 1) / 2);
  const dropped = text.length - half * 2;
  return `${text.slice(0, half)}\n… ${dropped.toLocaleString("en-US")} characters truncated …\n${text.slice(text.length - half)}`;
}

/**
 * Run one shell line locally and return everything it printed. This never goes
 * near Copilot: it is the TUI's `!command` passthrough, so the caller decides
 * what, if anything, the model gets to see.
 */
export async function runShellCommand(
  command: string,
  options: ShellRunOptions = {},
): Promise<ShellResult> {
  const timeoutMs = options.timeoutMs ?? SHELL_TIMEOUT_MS;
  const limit = options.limit ?? SHELL_OUTPUT_LIMIT;
  const shell = loginShell(options.env ?? process.env, options.platform ?? process.platform);

  return await new Promise<ShellResult>((resolve) => {
    let settled = false;
    let timedOut = false;
    const chunks: string[] = [];
    const finish = (result: Omit<ShellResult, "output">, extra = ""): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      const text = capOutput(stripAnsi(chunks.join("") + extra).trimEnd(), limit);
      resolve({ ...result, output: text });
    };

    // A `!cmd &` line leaves a background process holding the pipes, so the
    // shell alone is not what has to be killed: the whole group is.
    const useProcessGroup = (options.platform ?? process.platform) !== "win32";
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(shell, ["-lc", command], {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        detached: useProcessGroup,
        env: {
          ...(options.env ?? process.env),
          NO_COLOR: "1",
          TERM: "dumb",
          PAGER: "cat",
          GIT_PAGER: "cat",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      resolve({ ok: false, code: null, signal: null, timedOut: false, output: message });
      return;
    }

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => chunks.push(chunk));
    child.stderr?.on("data", (chunk: string) => chunks.push(chunk));

    let killTimer: NodeJS.Timeout | undefined;
    const kill = (signal: NodeJS.Signals): void => {
      try {
        if (useProcessGroup && child.pid !== undefined) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        // The group may have exited between the decision and this signal.
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill("SIGTERM");
      // A shell that ignores SIGTERM must not hold the TUI hostage.
      killTimer = setTimeout(() => kill("SIGKILL"), FORCE_KILL_GRACE_MS);
      killTimer.unref?.();
    }, timeoutMs);
    timer.unref?.();

    child.on("error", (error: Error) => {
      finish(
        { ok: false, code: null, signal: null, timedOut },
        `\n${error.name}: ${error.message}`,
      );
    });
    child.on("close", (code, signal) => {
      finish(
        { ok: !timedOut && code === 0, code, signal, timedOut },
        timedOut ? `\n… command timed out after ${Math.round(timeoutMs / 1000)}s` : "",
      );
    });
  });
}
