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

class WorkspacePaths {
  private constructor(readonly root: string) {}

  static async create(cwd: string): Promise<WorkspacePaths> {
    return new WorkspacePaths(await realpath(cwd));
  }

  lexical(path: string): string {
    const normalized = path.startsWith("@") ? path.slice(1) : path;
    const candidate = resolve(this.root, normalized || ".");
    const fromRoot = relative(this.root, candidate);
    if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
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
    return relative(this.root, path) || ".";
  }

  private assertResolvedInside(resolvedPath: string, requestedPath: string): void {
    const fromRoot = relative(this.root, resolvedPath);
    if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      throw new Error(`Path resolves outside the workspace: ${requestedPath}`);
    }
  }
}

export async function createWorkspaceTools(cwd: string): Promise<ToolDefinition[]> {
  const workspace = await WorkspacePaths.create(cwd);

  const tools: ToolDefinition[] = [
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
        const result = await runProcess("rg", commandArgs, workspace.root);
        if (result.exitCode > 1) throw new Error(result.stderr || `rg exited ${result.exitCode}`);
        const lines = result.stdout.trimEnd().split("\n").filter(Boolean);
        if (lines.length === 0) return "No matches";
        const shown = lines.slice(0, maxResults).map((line) => line.replace(`${workspace.root}${sep}`, ""));
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
        const result = await runProcess("rg", commandArgs, workspace.root);
        if (result.exitCode > 1) throw new Error(result.stderr || `rg exited ${result.exitCode}`);
        const files = result.stdout
          .trimEnd()
          .split("\n")
          .filter(Boolean)
          .map((file) => file.replace(`${workspace.root}${sep}`, ""));
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
        const result = await runProcess("/bin/zsh", ["-lc", command], workspace.root, timeoutMs);
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
