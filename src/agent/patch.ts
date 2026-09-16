import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { PathResolver } from "./tools.js";
import type { ToolDefinition } from "./types.js";

export type DiffLineKind = "context" | "add" | "remove";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  /** Set by a `\ No newline at end of file` marker following this line. */
  noNewline: boolean;
}

export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

export type FileChangeKind = "modify" | "create" | "delete";

export interface ParsedFileDiff {
  kind: FileChangeKind;
  /** The path the change applies to, with `a/` and `b/` prefixes removed. */
  path: string;
  oldPath: string | undefined;
  newPath: string | undefined;
  hunks: DiffHunk[];
}

export interface HunkPlacement {
  /** One-based hunk number within its file. */
  index: number;
  /** Lines between where the `@@` header pointed and where the hunk matched. */
  offset: number;
}

export interface ApplyResult {
  content: string;
  placements: HunkPlacement[];
  added: number;
  removed: number;
}

const HUNK_HEADER = /^@@+ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function stripFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return text;
  const lines = trimmed.split("\n");
  lines.shift();
  while (lines.length > 0 && lines[lines.length - 1]!.trim().length === 0) lines.pop();
  if (lines.length > 0 && lines[lines.length - 1]!.trim().startsWith("```")) lines.pop();
  return lines.join("\n");
}

function parsePath(raw: string, prefix: string): string | undefined {
  let value = raw.split("\t")[0] ?? "";
  value = value.trim();
  if (value.length === 0) return undefined;
  if (value.startsWith('"') && value.endsWith('"') && value.length > 1) {
    value = value.slice(1, -1).replace(/\\"/g, '"');
  }
  if (value === "/dev/null") return undefined;
  if (value.startsWith(`${prefix}/`)) value = value.slice(prefix.length + 1);
  while (value.startsWith("./")) value = value.slice(2);
  return value.length === 0 ? undefined : value;
}

/**
 * Parses one or more file diffs out of unified diff text. `diff --git`
 * headers, `a/`/`b/` prefixes, git mode lines, and surrounding code fences are
 * tolerated; `@@` line numbers are recorded but treated as hints by
 * {@link applyHunks}.
 */
export function parseUnifiedDiff(text: string): ParsedFileDiff[] {
  const lines = stripFence(text).split("\n");
  const files: ParsedFileDiff[] = [];
  let current: ParsedFileDiff | undefined;
  let oldRaw: string | undefined;
  let sawDevNullSource = false;
  let modeCreate = false;
  let modeDelete = false;
  let index = 0;

  const startFile = (newRaw: string | undefined): void => {
    const oldPath = oldRaw === undefined ? undefined : parsePath(oldRaw, "a");
    const newPath = newRaw === undefined ? undefined : parsePath(newRaw, "b");
    const created = modeCreate || sawDevNullSource;
    const deleted = modeDelete || (newRaw !== undefined && newPath === undefined);
    const kind: FileChangeKind = created ? "create" : deleted ? "delete" : "modify";
    const path = kind === "delete" ? (oldPath ?? newPath) : (newPath ?? oldPath);
    if (path === undefined) throw new Error("A file diff is missing both its --- and +++ paths");
    current = { kind, path, oldPath, newPath, hunks: [] };
    files.push(current);
    oldRaw = undefined;
    sawDevNullSource = false;
    modeCreate = false;
    modeDelete = false;
  };

  while (index < lines.length) {
    const line = lines[index]!;
    index += 1;
    if (line.startsWith("diff --git ")) {
      current = undefined;
      oldRaw = undefined;
      sawDevNullSource = false;
      modeCreate = false;
      modeDelete = false;
      continue;
    }
    if (line.startsWith("new file mode")) {
      modeCreate = true;
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      modeDelete = true;
      continue;
    }
    if (line.startsWith("--- ")) {
      oldRaw = line.slice(4);
      sawDevNullSource = parsePath(oldRaw, "a") === undefined;
      continue;
    }
    if (line.startsWith("+++ ")) {
      startFile(line.slice(4));
      continue;
    }
    const header = HUNK_HEADER.exec(line);
    if (header === null) continue;
    if (current === undefined) {
      throw new Error(`Hunk "${line}" appears before any --- / +++ file header`);
    }
    const oldStart = Number(header[1]);
    const oldCount = header[2] === undefined ? 1 : Number(header[2]);
    const newStart = Number(header[3]);
    const newCount = header[4] === undefined ? 1 : Number(header[4]);
    const body: DiffLine[] = [];
    let oldRemaining = oldCount;
    let newRemaining = newCount;
    while (index < lines.length && (oldRemaining > 0 || newRemaining > 0)) {
      const raw = lines[index]!;
      if (raw.startsWith("@@") || raw.startsWith("diff --git ")) break;
      if (raw.startsWith("\\")) {
        const previous = body[body.length - 1];
        if (previous !== undefined) previous.noNewline = true;
        index += 1;
        continue;
      }
      const marker = raw.slice(0, 1);
      if (marker === "+") {
        body.push({ kind: "add", text: raw.slice(1), noNewline: false });
        newRemaining -= 1;
      } else if (marker === "-") {
        body.push({ kind: "remove", text: raw.slice(1), noNewline: false });
        oldRemaining -= 1;
      } else if (marker === " " || raw.length === 0) {
        body.push({ kind: "context", text: raw.slice(1), noNewline: false });
        oldRemaining -= 1;
        newRemaining -= 1;
      } else {
        break;
      }
      index += 1;
    }
    // A trailing `\ No newline` marker can follow the final counted line.
    if (index < lines.length && lines[index]!.startsWith("\\")) {
      const previous = body[body.length - 1];
      if (previous !== undefined) previous.noNewline = true;
      index += 1;
    }
    if (body.length === 0) {
      throw new Error(`Hunk "${line}" in ${current.path} has no body lines`);
    }
    current.hunks.push({ oldStart, oldCount, newStart, newCount, lines: body });
  }

  for (const file of files) {
    if (file.hunks.length === 0) throw new Error(`No hunks found for ${file.path}`);
  }
  return files;
}

interface SplitContent {
  lines: string[];
  eol: string;
  endsWithNewline: boolean;
}

function splitLines(content: string): SplitContent {
  if (content.length === 0) return { lines: [], eol: "\n", endsWithNewline: true };
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const endsWithNewline = content.endsWith("\n");
  const body = endsWithNewline ? content.slice(0, -1) : content;
  const lines = body
    .split("\n")
    .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  return { lines, eol, endsWithNewline };
}

function joinLines(lines: string[], eol: string, endsWithNewline: boolean): string {
  if (lines.length === 0) return "";
  return lines.join(eol) + (endsWithNewline ? eol : "");
}

function trimEnd(line: string): string {
  return line.replace(/[ \t\r]+$/, "");
}

function matchesAt(lines: string[], start: number, expected: string[]): boolean {
  if (start < 0 || start + expected.length > lines.length) return false;
  for (let offset = 0; offset < expected.length; offset += 1) {
    if (trimEnd(lines[start + offset]!) !== trimEnd(expected[offset]!)) return false;
  }
  return true;
}

/** Positions matching `expected` at the smallest distance from `hint`. */
function locate(lines: string[], hint: number, expected: string[], minimum: number): number[] {
  const reach = Math.max(lines.length, 1);
  for (let distance = 0; distance <= reach; distance += 1) {
    const candidates = distance === 0 ? [hint] : [hint - distance, hint + distance];
    const found = candidates.filter(
      (candidate) => candidate >= minimum && matchesAt(lines, candidate, expected),
    );
    if (found.length > 0) return found;
  }
  return [];
}

/**
 * Applies hunks to file content. `@@` line numbers are only a starting point:
 * each hunk's context and removed lines are searched for outward from that
 * position, ignoring trailing whitespace. Throws if any hunk cannot be placed
 * unambiguously, leaving the caller free to abandon the whole patch.
 *
 * `firstHunkNumber` shifts the numbering used in placements and errors, so a
 * second diff section for the same file keeps counting where the first stopped.
 */
export function applyHunks(
  content: string,
  hunks: DiffHunk[],
  firstHunkNumber = 1,
): ApplyResult {
  const source = splitLines(content);
  const lines = [...source.lines];
  let endsWithNewline = source.endsWithNewline;
  const placements: HunkPlacement[] = [];
  let added = 0;
  let removed = 0;
  let delta = 0;
  let minimum = 0;

  for (const [position, hunk] of hunks.entries()) {
    const number = firstHunkNumber + position;
    const expected = hunk.lines.filter((line) => line.kind !== "add").map((line) => line.text);
    const upperBound = Math.max(minimum, lines.length - expected.length);
    const hint = Math.min(Math.max(hunk.oldStart - 1 + delta, minimum), upperBound);
    const matches = locate(lines, hint, expected, minimum);
    if (matches.length === 0) {
      throw new Error(
        `hunk ${number} (@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@) does not match the file`,
      );
    }
    if (matches.length > 1) {
      throw new Error(
        `hunk ${number} (@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@) matches ambiguously at lines ${matches
          .map((match) => match + 1)
          .join(" and ")}`,
      );
    }

    const start = matches[0]!;
    const replacement: string[] = [];
    let cursor = start;
    for (const line of hunk.lines) {
      if (line.kind === "context") {
        replacement.push(lines[cursor]!);
        cursor += 1;
      } else if (line.kind === "remove") {
        cursor += 1;
        removed += 1;
      } else {
        replacement.push(line.text);
        added += 1;
      }
    }

    if (start + expected.length >= lines.length) {
      const newSide = hunk.lines.filter((line) => line.kind !== "remove");
      const last = newSide[newSide.length - 1];
      if (last !== undefined) endsWithNewline = !last.noNewline;
    }

    lines.splice(start, expected.length, ...replacement);
    const offset = start - (hunk.oldStart - 1 + delta);
    if (offset !== 0) placements.push({ index: number, offset });
    delta += replacement.length - expected.length;
    minimum = start + replacement.length;
  }

  return {
    content: joinLines(lines, source.eol, endsWithNewline),
    placements,
    added,
    removed,
  };
}

interface PlannedChange {
  kind: FileChangeKind;
  absolute: string;
  display: string;
  content: string;
  added: number;
  removed: number;
  placements: HunkPlacement[];
  /** Hunks already applied to this file, across every section that targets it. */
  hunks: number;
}

function stringArg(args: Record<string, unknown>, names: string[]): string {
  for (const name of names) {
    const value = args[name];
    if (value === undefined) continue;
    if (typeof value !== "string") throw new Error(`${name} must be a string`);
    return value;
  }
  throw new Error(`${names[0]} must be a string`);
}

async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Applies a whole unified diff in one call, so a multi-file, multi-hunk change
 * costs a single browser round trip instead of one edit per hunk. Every hunk is
 * located and applied in memory first: if any of them fails, nothing is written.
 */
export function createPatchTool(resolver: PathResolver): ToolDefinition {
  return {
    name: "patch",
    description:
      "Apply a unified diff to one or more files in a single call (git or bare ---/+++ headers, /dev/null for created or deleted files). Hunks are matched by context, not by @@ line numbers; if any hunk fails, no file is touched. Prefer it over several edits when a change spans multiple places.",
    parameters: "diff",
    mutates: true,
    execute: async (args) => {
      const files = parseUnifiedDiff(stringArg(args, ["diff", "patch", "content"]));
      if (files.length === 0) {
        throw new Error("No file diffs found; supply a unified diff containing @@ hunks");
      }

      const planned: PlannedChange[] = [];
      // One entry per file: a diff may carry several sections for the same
      // path, and each must build on the previous section's result rather than
      // on the on-disk content, or the earlier section's edits are lost.
      const byPath = new Map<string, PlannedChange>();
      for (const file of files) {
        // `writable` accepts a path that does not exist yet, so a section can
        // patch a file an earlier section in the same diff created.
        const absolute = await resolver.writable(file.path);
        const display = resolver.display(absolute);
        const previous = byPath.get(absolute);
        if (previous !== undefined && (previous.kind === "delete" || file.kind === "delete")) {
          throw new Error(
            `${display}: the diff both deletes and changes this file. No files were changed.`,
          );
        }
        if (previous !== undefined && file.kind === "create") {
          throw new Error(`${display}: the diff creates this file twice. No files were changed.`);
        }

        let base: string;
        if (previous !== undefined) {
          base = previous.content;
        } else {
          const existing = await readIfPresent(absolute);
          if (file.kind === "create" && existing !== undefined && existing.length > 0) {
            throw new Error(`Cannot create ${display}: it already exists and is not empty`);
          }
          if (file.kind !== "create" && existing === undefined) {
            throw new Error(`Cannot patch ${display}: the file does not exist`);
          }
          base = existing ?? "";
        }

        let result: ApplyResult;
        try {
          result = applyHunks(base, file.hunks, (previous?.hunks ?? 0) + 1);
        } catch (error) {
          throw new Error(
            `${display}: ${error instanceof Error ? error.message : String(error)}. No files were changed.`,
          );
        }

        if (previous === undefined) {
          const change: PlannedChange = {
            kind: file.kind,
            absolute,
            display,
            content: result.content,
            added: result.added,
            removed: result.removed,
            placements: result.placements,
            hunks: file.hunks.length,
          };
          planned.push(change);
          byPath.set(absolute, change);
        } else {
          previous.content = result.content;
          previous.added += result.added;
          previous.removed += result.removed;
          previous.placements.push(...result.placements);
          previous.hunks += file.hunks.length;
        }
      }

      const summary: string[] = [];
      for (const change of planned) {
        if (change.kind === "delete") {
          await unlink(change.absolute);
        } else {
          if (change.kind === "create") await mkdir(dirname(change.absolute), { recursive: true });
          await writeFile(change.absolute, change.content, "utf8");
        }
        const counts =
          change.kind === "delete"
            ? `(-${change.removed})`
            : `(+${change.added} -${change.removed})`;
        const drift =
          change.placements.length === 0
            ? ""
            : ` [${change.placements
                .map((placement) => `hunk ${placement.index} at offset ${placement.offset > 0 ? "+" : ""}${placement.offset}`)
                .join(", ")}]`;
        summary.push(`${change.kind === "modify" ? "modified" : `${change.kind}d`} ${change.display} ${counts}${drift}`);
      }
      return summary.join("\n");
    },
  };
}
