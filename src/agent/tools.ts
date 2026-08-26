import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { ToolDefinition } from "./types.js";

const MAX_OUTPUT_CHARS = 80_000;

function stringArg(args: Record<string, unknown>, name: string, fallback?: string): string {
  const value = args[name];
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
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

function truncateOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_CHARS) return output;
  return `${output.slice(0, MAX_OUTPUT_CHARS)}\n… output truncated after ${MAX_OUTPUT_CHARS} characters`;
}

interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runProcess(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs = 30_000,
): Promise<ProcessResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length <= MAX_OUTPUT_CHARS) stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length <= MAX_OUTPUT_CHARS) stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`Command timed out after ${timeoutMs}ms`));
        return;
      }
      resolvePromise({
        stdout: truncateOutput(stdout),
        stderr: truncateOutput(stderr),
        exitCode: code ?? 1,
      });
    });
  });
}

export interface WorkspaceToolOptions {
  allowedRoots?: string[];
}

class WorkspacePaths {
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

export async function createWorkspaceTools(
  cwd: string,
  options: WorkspaceToolOptions = {},
): Promise<ToolDefinition[]> {
  const workspace = await WorkspacePaths.create(cwd, options.allowedRoots);

  const tools: ToolDefinition[] = [
    {
      name: "pwd",
      description: "Show the controller's current working directory and every filesystem root granted to this session.",
      parameters: "{}",
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
      description: "Change the persistent working directory for subsequent controller operations. The destination must be inside an allowed root.",
      parameters: '{"path":"/absolute/or/relative/directory"}',
      mutates: false,
      execute: async (args) => {
        const next = await workspace.changeDirectory(stringArg(args, "path"));
        return `Current working directory: ${next}`;
      },
    },
    {
      name: "read",
      description: "Read a UTF-8 text file with numbered lines. Use offset and limit for large files.",
      parameters: '{"path":"relative/file.ts","offset":1,"limit":300}',
      mutates: false,
      execute: async (args) => {
        const path = await workspace.existing(stringArg(args, "path"));
        const offset = numberArg(args, "offset", 1, 1, 10_000_000);
        const limit = numberArg(args, "limit", 300, 1, 2_000);
        const info = await stat(path);
        if (!info.isFile()) throw new Error(`${workspace.display(path)} is not a file`);
        const lines = (await readFile(path, "utf8")).split("\n");
        const selected = lines.slice(offset - 1, offset - 1 + limit);
        const numbered = selected.map((line, index) => `${offset + index}: ${line}`).join("\n");
        const suffix = offset - 1 + selected.length < lines.length ? `\n… ${lines.length - offset - selected.length + 1} more lines` : "";
        return `${workspace.display(path)} (${lines.length} lines)\n${numbered}${suffix}`;
      },
    },
    {
      name: "grep",
      description: "Search file contents with ripgrep regular expressions and return file, line, and column matches.",
      parameters: '{"pattern":"expression","path":"src","glob":"*.ts","max_results":200}',
      mutates: false,
      execute: async (args) => {
        const pattern = stringArg(args, "pattern");
        const requested = stringArg(args, "path", ".");
        const path = await workspace.existing(requested);
        const maxResults = numberArg(args, "max_results", 200, 1, 2_000);
        const commandArgs = ["--line-number", "--column", "--no-heading", "--color", "never"];
        const glob = args.glob;
        if (glob !== undefined) {
          if (typeof glob !== "string") throw new Error("glob must be a string");
          commandArgs.push("--glob", glob);
        }
        commandArgs.push("--", pattern, path);
        const result = await runProcess("rg", commandArgs, workspace.cwd);
        if (result.exitCode > 1) throw new Error(result.stderr || `rg exited ${result.exitCode}`);
        const lines = result.stdout.trimEnd().split("\n").filter(Boolean);
        if (lines.length === 0) return "No matches";
        const shown = lines.slice(0, maxResults).map((line) => {
          const absolute = isAbsolute(line) ? line : resolve(workspace.cwd, line);
          return workspace.display(absolute);
        });
        if (lines.length > shown.length) shown.push(`… ${lines.length - shown.length} more matches`);
        return shown.join("\n");
      },
    },
    {
      name: "find",
      description: "List repository files, optionally below a path and filtered by an rg glob.",
      parameters: '{"path":"src","glob":"*.ts","max_results":500}',
      mutates: false,
      execute: async (args) => {
        const requested = stringArg(args, "path", ".");
        const path = await workspace.existing(requested);
        const maxResults = numberArg(args, "max_results", 500, 1, 5_000);
        const commandArgs = ["--files", "--hidden", "--glob", "!.git/**", "--glob", "!node_modules/**"];
        const glob = args.glob;
        if (glob !== undefined) {
          if (typeof glob !== "string") throw new Error("glob must be a string");
          commandArgs.push("--glob", glob);
        }
        commandArgs.push(path);
        const result = await runProcess("rg", commandArgs, workspace.cwd);
        if (result.exitCode > 1) throw new Error(result.stderr || `rg exited ${result.exitCode}`);
        const files = result.stdout
          .trimEnd()
          .split("\n")
          .filter(Boolean)
          .map((file) => workspace.display(isAbsolute(file) ? file : resolve(workspace.cwd, file)));
        if (files.length === 0) return "No files found";
        const shown = files.slice(0, maxResults);
        if (files.length > shown.length) shown.push(`… ${files.length - shown.length} more files`);
        return shown.join("\n");
      },
    },
    {
      name: "ls",
      description: "List one directory with entry types and sizes.",
      parameters: '{"path":"src"}',
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
      description: "Replace exactly one occurrence of old_text in an existing UTF-8 file.",
      parameters: '{"path":"src/file.ts","old_text":"exact text","new_text":"replacement"}',
      mutates: true,
      execute: async (args) => {
        const path = await workspace.existing(stringArg(args, "path"));
        const oldText = stringArg(args, "old_text");
        const newText = stringArg(args, "new_text");
        if (oldText.length === 0) throw new Error("old_text must not be empty");
        const content = await readFile(path, "utf8");
        const first = content.indexOf(oldText);
        if (first < 0) throw new Error("old_text was not found");
        if (content.indexOf(oldText, first + oldText.length) >= 0) {
          throw new Error("old_text occurs more than once; include more surrounding context");
        }
        await writeFile(path, `${content.slice(0, first)}${newText}${content.slice(first + oldText.length)}`, "utf8");
        return `Updated ${workspace.display(path)}`;
      },
    },
    {
      name: "write",
      description: "Create or completely overwrite a UTF-8 file, creating parent directories as needed.",
      parameters: '{"path":"relative/file.ts","content":"complete file contents"}',
      mutates: true,
      execute: async (args) => {
        const path = await workspace.writable(stringArg(args, "path"));
        const content = stringArg(args, "content");
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, content, "utf8");
        return `Wrote ${workspace.display(path)} (${content.length} characters)`;
      },
    },
    {
      name: "bash",
      description: "Run a shell command in the workspace. Use for tests, builds, git status, and operations without a dedicated tool.",
      parameters: '{"command":"pnpm test","timeout_ms":30000}',
      mutates: true,
      execute: async (args) => {
        const command = stringArg(args, "command");
        const timeoutMs = numberArg(args, "timeout_ms", 30_000, 100, 300_000);
        const result = await runProcess("/bin/zsh", ["-lc", command], workspace.cwd, timeoutMs);
        const sections = [
          `exit_code: ${result.exitCode}`,
          result.stdout ? `stdout:\n${result.stdout}` : "",
          result.stderr ? `stderr:\n${result.stderr}` : "",
        ].filter(Boolean);
        return sections.join("\n");
      },
    },
  ];

  return tools;
}
