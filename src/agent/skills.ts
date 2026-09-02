import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ToolDefinition } from "./types.js";

/**
 * Agent Skills, in the layout GitHub Copilot uses: a directory per skill whose
 * `SKILL.md` carries YAML frontmatter (`name`, `description`) followed by the
 * instructions, with optional bundled references, scripts, and assets beside it.
 */
export interface Skill {
  name: string;
  description: string;
  /** Absolute skill directory. */
  directory: string;
  /** Absolute path of the SKILL.md file. */
  file: string;
  /** Where the skill was discovered: "project" for repository skills, "personal" for home-directory skills, or "env" for COPILOT_SKILLS_DIRS. */
  source: "project" | "personal" | "env";
  /** Remaining frontmatter fields, e.g. `license` or `compatibility`. */
  metadata: Record<string, string>;
}

export const SKILL_FILE = "SKILL.md";
export const MAX_SKILL_CHARS = 60_000;

/** Repository-relative directories searched for skills, in precedence order. */
export const PROJECT_SKILL_DIRS = [".github/skills", ".claude/skills", ".agents/skills"];
/** Home-relative directories searched for personal skills, in precedence order. */
export const PERSONAL_SKILL_DIRS = [".copilot/skills", ".claude/skills", ".agents/skills"];

export interface SkillDiscoveryOptions {
  home?: string;
  /** Extra skill directories, typically from the COPILOT_SKILLS_DIRS variable. */
  extraDirs?: string[];
}

export function skillDirsFromEnv(value = process.env.COPILOT_SKILLS_DIRS): string[] {
  if (value === undefined) return [];
  return value
    .split(new RegExp(`[,${delimiter === ":" ? ":" : ";"}]`))
    .map((entry) => entry.trim())
    .filter(Boolean);
}

interface Frontmatter {
  fields: Record<string, string>;
  body: string;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    if ((first === '"' || first === "'") && trimmed.endsWith(first)) {
      const inner = trimmed.slice(1, -1);
      return first === '"' ? inner.replaceAll('\\"', '"').replaceAll("\\n", "\n") : inner;
    }
  }
  return trimmed;
}

/**
 * Parse the subset of YAML that skill frontmatter uses: `key: value` scalars,
 * quoted scalars, `>`/`|` block scalars, and indented continuation lines.
 * Nested mappings and lists are flattened to their raw text.
 */
export function parseFrontmatter(content: string): Frontmatter {
  const normalized = content.replace(/^﻿/, "").replaceAll("\r\n", "\n");
  const match = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(normalized);
  if (match === null) return { fields: {}, body: normalized };
  const fields: Record<string, string> = {};
  const lines = match[1]!.split("\n");
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    index += 1;
    if (line.trim().length === 0 || line.trimStart().startsWith("#")) continue;
    const entry = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (entry === null) continue;
    const key = entry[1]!;
    const rest = entry[2]!.trim();
    const continuation: string[] = [];
    while (index < lines.length && (/^\s+\S/.test(lines[index]!) || lines[index]!.trim().length === 0)) {
      const next = lines[index]!;
      if (next.trim().length === 0 && !(index + 1 < lines.length && /^\s+\S/.test(lines[index + 1]!))) break;
      continuation.push(next.trim());
      index += 1;
    }
    if (rest === ">" || rest === ">-" || rest === "|" || rest === "|-") {
      const folded = rest.startsWith(">");
      fields[key] = folded ? continuation.join(" ").trim() : continuation.join("\n").trim();
    } else if (continuation.length > 0 && rest.length === 0) {
      fields[key] = continuation.join("\n").trim();
    } else if (continuation.length > 0) {
      fields[key] = [unquote(rest), ...continuation].join(" ").trim();
    } else {
      fields[key] = unquote(rest);
    }
  }
  return { fields, body: normalized.slice(match[0].length) };
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function loadSkillDirectory(
  directory: string,
  source: Skill["source"],
): Promise<Skill | undefined> {
  const file = join(directory, SKILL_FILE);
  let content: string;
  try {
    content = await readFile(file, "utf8");
  } catch {
    return undefined;
  }
  const { fields, body } = parseFrontmatter(content);
  const { name, description, ...metadata } = fields;
  const resolvedName = (name ?? basename(directory)).trim();
  if (resolvedName.length === 0) return undefined;
  const summary = (description ?? "").trim();
  const fallback = body
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("#"));
  return {
    name: resolvedName,
    description: summary || fallback || "No description",
    directory,
    file,
    source,
    metadata,
  };
}

async function skillsBelow(root: string, source: Skill["source"]): Promise<Skill[]> {
  if (!(await isDirectory(root))) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const skills: Skill[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name.startsWith(".")) continue;
    const directory = join(root, entry.name);
    if (!(await isDirectory(directory))) continue;
    const skill = await loadSkillDirectory(directory, source);
    if (skill !== undefined) skills.push(skill);
  }
  return skills;
}

/**
 * Discover every skill visible from `cwd`. Project skills win over personal
 * skills of the same name, and the first directory in each list wins over later
 * ones, mirroring Copilot's precedence.
 */
export async function discoverSkills(cwd: string, options: SkillDiscoveryOptions = {}): Promise<Skill[]> {
  const home = options.home ?? homedir();
  const candidates: { root: string; source: Skill["source"] }[] = [
    ...PROJECT_SKILL_DIRS.map((dir) => ({ root: resolve(cwd, dir), source: "project" as const })),
    ...(options.extraDirs ?? skillDirsFromEnv()).map((dir) => ({
      root: resolve(cwd, dir),
      source: "env" as const,
    })),
    ...PERSONAL_SKILL_DIRS.map((dir) => ({ root: resolve(home, dir), source: "personal" as const })),
  ];
  const seenNames = new Set<string>();
  const seenRoots = new Set<string>();
  const skills: Skill[] = [];
  for (const candidate of candidates) {
    if (seenRoots.has(candidate.root)) continue;
    seenRoots.add(candidate.root);
    for (const skill of await skillsBelow(candidate.root, candidate.source)) {
      const key = skill.name.toLowerCase();
      if (seenNames.has(key)) continue;
      seenNames.add(key);
      skills.push(skill);
    }
  }
  return skills;
}

export function findSkill(skills: Skill[], name: string): Skill | undefined {
  const wanted = name.trim().toLowerCase();
  return skills.find((skill) => skill.name.toLowerCase() === wanted);
}

export function formatSkillList(skills: Skill[]): string {
  if (skills.length === 0) return "No skills found";
  return skills
    .map((skill) => `- ${skill.name} (${skill.source}): ${skill.description}`)
    .join("\n");
}

async function listSkillFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && files.length < 200) files.push(relative(directory, path));
    }
  };
  await walk(directory);
  return files;
}

function truncate(content: string): string {
  if (content.length <= MAX_SKILL_CHARS) return content;
  return `${content.slice(0, MAX_SKILL_CHARS)}\n… truncated after ${MAX_SKILL_CHARS} characters`;
}

/** Render the full instructions of one skill plus the files bundled beside it. */
export async function loadSkill(skill: Skill): Promise<string> {
  const { body } = parseFrontmatter(await readFile(skill.file, "utf8"));
  const files = (await listSkillFiles(skill.directory)).filter((file) => file !== SKILL_FILE);
  const bundled =
    files.length === 0
      ? ""
      : `\n\nBundled files (read one with skill name + file):\n${files.map((file) => `- ${file}`).join("\n")}`;
  return `Skill: ${skill.name}\nDirectory: ${skill.directory}\n\n${truncate(body.trim())}${bundled}`;
}

/** Read one file bundled inside a skill directory; the path may not escape it. */
export async function readSkillFile(skill: Skill, file: string): Promise<string> {
  const root = await realpath(skill.directory);
  const candidate = resolve(root, file);
  const inside = (path: string): boolean => {
    const fromRoot = relative(root, path);
    return fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
  };
  if (!inside(candidate)) throw new Error(`File escapes the ${skill.name} skill directory: ${file}`);
  const resolved = await realpath(candidate);
  if (!inside(resolved)) throw new Error(`File resolves outside the ${skill.name} skill directory: ${file}`);
  if (!(await stat(resolved)).isFile()) throw new Error(`${file} is not a file`);
  const content = await readFile(resolved, "utf8");
  const lines = content.split("\n");
  return `${skill.name}/${relative(root, resolved)} (${lines.length} lines)\n${truncate(
    lines.map((line, index) => `${index + 1}: ${line}`).join("\n"),
  )}`;
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

/**
 * The `skill` operation: list skills, load one skill's instructions, or read a
 * file bundled with it. `currentDirectory` is consulted on each call so skills
 * follow a persistent `cd` into another project.
 */
export function createSkillTool(currentDirectory: () => string, options: SkillDiscoveryOptions = {}): ToolDefinition {
  return {
    name: "skill",
    description:
      "Load an on-demand skill: without arguments lists available skills; with name returns that skill's full instructions; with name and file reads a file bundled inside the skill.",
    parameters: "name?, file?",
    mutates: false,
    execute: async (args) => {
      const name = optionalString(args, ["name", "skill"]);
      const file = optionalString(args, ["file", "path"]);
      const skills = await discoverSkills(currentDirectory(), options);
      if (name === undefined || name.trim().length === 0) {
        if (file !== undefined) throw new Error("file requires a skill name");
        return formatSkillList(skills);
      }
      const skill = findSkill(skills, name);
      if (skill === undefined) {
        const available = skills.map((entry) => entry.name).join(", ") || "none";
        throw new Error(`Unknown skill: ${name}. Available skills: ${available}`);
      }
      if (file !== undefined && file.trim().length > 0) return readSkillFile(skill, file);
      return loadSkill(skill);
    },
  };
}
