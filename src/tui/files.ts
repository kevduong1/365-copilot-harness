import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const SKIP = new Set([
  "node_modules",
  ".git",
  ".data",
  "dist",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  "playwright-report",
]);

export async function listProjectFiles(root: string, limit = 400): Promise<string[]> {
  const out: string[] = [];

  const walk = async (dir: string): Promise<void> => {
    if (out.length >= limit) return;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (out.length >= limit) return;
      if (entry.name.startsWith(".") && entry.name !== ".gitignore" && entry.name !== ".env.example") continue;
      if (SKIP.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.push(relative(root, full).replaceAll("\\", "/"));
    }
  };

  await walk(root);
  return out;
}
