import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import { isAbsolute, join } from "node:path";

/**
 * Which command-line dialect a shell speaks. The harness only needs to know
 * how to hand it a command string and what to tell the model about syntax.
 */
export type ShellFamily = "posix" | "cmd";

export interface ShellSpec {
  /** Executable to spawn; a bare name is resolved through PATH by the OS. */
  command: string;
  family: ShellFamily;
  /** Where the choice came from, for diagnostics and the tool description. */
  source: "HARNESS_SHELL" | "SHELL" | "git-bash" | "default";
}

function exists(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function familyOf(command: string): ShellFamily {
  return /(?:^|[\\/])(?:cmd|command)(?:\.exe)?$/i.test(command.trim()) ? "cmd" : "posix";
}

/** Locations Git for Windows installs bash.exe; never System32, which is WSL's launcher. */
function gitBashCandidates(env: NodeJS.ProcessEnv): string[] {
  const roots = [
    env.EXEPATH,
    env.ProgramFiles,
    env["ProgramFiles(x86)"],
    env.ProgramW6432,
    env.LOCALAPPDATA === undefined ? undefined : join(env.LOCALAPPDATA, "Programs"),
  ].filter((root): root is string => root !== undefined && root !== "");
  const candidates: string[] = [];
  for (const root of roots) {
    const base = /[\\/]git$/i.test(root) ? root : join(root, "Git");
    candidates.push(join(base, "bin", "bash.exe"), join(base, "usr", "bin", "bash.exe"));
  }
  return candidates;
}

/**
 * Pick the shell that runs `bash`, `job_start`, and TUI `!` lines. POSIX hosts
 * trust `$SHELL` and fall back to zsh or bash. Windows prefers Git Bash so the
 * model's POSIX habits keep working, and only uses cmd.exe when nothing else is
 * installed. `HARNESS_SHELL` overrides everything on every platform.
 */
export function resolveShell(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): ShellSpec {
  const override = env.HARNESS_SHELL?.trim();
  if (override) return { command: override, family: familyOf(override), source: "HARNESS_SHELL" };

  const configured = env.SHELL?.trim();
  if (platform !== "win32") {
    if (configured) return { command: configured, family: "posix", source: "SHELL" };
    return { command: platform === "darwin" ? "/bin/zsh" : "/bin/bash", family: "posix", source: "default" };
  }

  // Git Bash exports SHELL=/usr/bin/bash, an MSYS path Node cannot spawn, so a
  // SHELL value only counts on Windows when it is a real Windows path.
  if (configured && isAbsolute(configured) && /^[A-Za-z]:/.test(configured) && exists(configured)) {
    return { command: configured, family: familyOf(configured), source: "SHELL" };
  }
  for (const candidate of gitBashCandidates(env)) {
    if (exists(candidate)) return { command: candidate, family: "posix", source: "git-bash" };
  }
  const comspec = env.ComSpec?.trim() || env.COMSPEC?.trim() || "cmd.exe";
  return { command: comspec, family: "cmd", source: "default" };
}

/** Wrap a caller-supplied shell path in a spec; used by library options that accept a string. */
export function shellSpecFromCommand(command: string): ShellSpec {
  return { command, family: familyOf(command), source: "HARNESS_SHELL" };
}

export interface ShellInvocation {
  command: string;
  args: string[];
  /**
   * cmd.exe parses its own command line, so the command must be passed
   * verbatim instead of through Node's argument quoting.
   */
  windowsVerbatimArguments: boolean;
}

/** The argv that makes `shell` run one command string. */
export function shellInvocation(shell: ShellSpec, command: string): ShellInvocation {
  if (shell.family === "cmd") {
    return {
      command: shell.command,
      args: ["/d", "/s", "/c", `"${command}"`],
      windowsVerbatimArguments: true,
    };
  }
  return { command: shell.command, args: ["-lc", command], windowsVerbatimArguments: false };
}

/** One sentence for the tool description so the model writes commands the shell understands. */
export function shellSyntaxNote(shell: ShellSpec, platform: NodeJS.Platform = process.platform): string {
  if (shell.family === "cmd") {
    return "Commands run through Windows cmd.exe (no Git Bash was found), so use Windows syntax: dir, type, findstr, where, double quotes, and && between commands; POSIX-only tools such as ls, cat, and grep are not available.";
  }
  if (platform === "win32") {
    return "Commands run through Git Bash on Windows, so POSIX syntax works; write paths with forward slashes.";
  }
  return "";
}

export interface KillOptions {
  /** The child was spawned detached as its own process group leader. */
  processGroup: boolean;
  platform?: NodeJS.Platform;
}

/**
 * Stop a spawned shell and everything it started. POSIX signals the process
 * group. Windows has no groups or graceful signals, so `taskkill /t /f` ends
 * the whole tree at once; the caller's later SIGKILL escalation is harmless.
 */
export function killProcessTree(child: ChildProcess, signal: NodeJS.Signals, options: KillOptions): void {
  const platform = options.platform ?? process.platform;
  // No early return on an exited leader: on POSIX the group id outlives it
  // while backgrounded children still hold the pipes open.
  try {
    if (platform === "win32") {
      if (child.pid === undefined) {
        child.kill();
        return;
      }
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.once("error", () => child.kill());
      return;
    }
    if (options.processGroup && child.pid !== undefined) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    // The process may have exited between the decision and the signal.
  }
}

/** Environment additions that keep child output plain and non-interactive. */
export const PLAIN_OUTPUT_ENV = {
  NO_COLOR: "1",
  TERM: "dumb",
  PAGER: "cat",
  GIT_PAGER: "cat",
} as const;
