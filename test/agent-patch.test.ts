import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import test from "node:test";
import {
  applyHunks,
  createPatchTool,
  parseUnifiedDiff,
} from "../src/agent/patch.js";
import type { PathResolver } from "../src/agent/tools.js";

function createResolver(root: string): PathResolver {
  const inside = (candidate: string): boolean => {
    const fromRoot = relative(root, candidate);
    return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
  };
  return {
    cwd: root,
    async existing(path: string): Promise<string> {
      const absolute = await realpath(resolve(root, path));
      if (!inside(absolute)) throw new Error(`Path escapes the workspace: ${path}`);
      return absolute;
    },
    async writable(path: string): Promise<string> {
      const absolute = resolve(root, path);
      if (!inside(absolute)) throw new Error(`Path escapes the workspace: ${path}`);
      return absolute;
    },
    display(path: string): string {
      return relative(root, path) || ".";
    },
  };
}

async function workspace(t: { after: (fn: () => unknown) => void }): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "copilot-patch-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("parseUnifiedDiff reads git headers, prefixes, and hunk bodies", () => {
  const files = parseUnifiedDiff(
    [
      "diff --git a/src/one.ts b/src/one.ts",
      "index 1234567..89abcde 100644",
      "--- a/src/one.ts",
      "+++ b/src/one.ts",
      "@@ -2,3 +2,4 @@ function example()",
      " context",
      "-gone",
      "+added",
      "+more",
      " tail",
      "diff --git a/src/two.ts b/src/two.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/two.ts",
      "@@ -0,0 +1,2 @@",
      "+alpha",
      "+beta",
    ].join("\n"),
  );

  assert.equal(files.length, 2);
  const [first, second] = files;
  assert.ok(first && second);
  assert.equal(first.kind, "modify");
  assert.equal(first.path, "src/one.ts");
  assert.equal(first.hunks.length, 1);
  assert.deepEqual(
    first.hunks[0]?.lines.map((line) => `${line.kind}:${line.text}`),
    ["context:context", "remove:gone", "add:added", "add:more", "context:tail"],
  );
  assert.equal(second.kind, "create");
  assert.equal(second.path, "src/two.ts");
  assert.equal(second.hunks[0]?.newCount, 2);
});

test("parseUnifiedDiff marks a missing trailing newline and detects deletions", () => {
  const files = parseUnifiedDiff(
    [
      "--- a/gone.txt",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-one",
      "-two",
      "\\ No newline at end of file",
    ].join("\n"),
  );
  assert.equal(files[0]?.kind, "delete");
  assert.equal(files[0]?.path, "gone.txt");
  assert.equal(files[0]?.hunks[0]?.lines[1]?.noNewline, true);
});

test("applyHunks locates a hunk whose line numbers drifted", () => {
  const content = ["pad", "pad", "pad", "alpha", "beta", "gamma", ""].join("\n");
  const [file] = parseUnifiedDiff(
    ["--- a/f", "+++ b/f", "@@ -1,3 +1,3 @@", " alpha", "-beta", "+BETA", " gamma"].join("\n"),
  );
  assert.ok(file);
  const result = applyHunks(content, file.hunks);
  assert.equal(result.content, ["pad", "pad", "pad", "alpha", "BETA", "gamma", ""].join("\n"));
  assert.deepEqual(result.placements, [{ index: 1, offset: 3 }]);
  assert.equal(result.added, 1);
  assert.equal(result.removed, 1);
});

test("applyHunks ignores trailing whitespace differences and keeps the file's own context", () => {
  const content = "alpha   \nbeta\ngamma\t\n";
  const [file] = parseUnifiedDiff(
    ["--- a/f", "+++ b/f", "@@ -1,3 +1,3 @@", " alpha", "-beta", "+BETA", " gamma"].join("\n"),
  );
  assert.ok(file);
  const result = applyHunks(content, file.hunks);
  assert.equal(result.content, "alpha   \nBETA\ngamma\t\n");
});

test("applyHunks refuses an ambiguous hunk", () => {
  const content = ["a", "dup", "mid", "dup", "z", ""].join("\n");
  const [file] = parseUnifiedDiff(
    ["--- a/f", "+++ b/f", "@@ -3,1 +3,2 @@", "-dup", "+dup", "+extra"].join("\n"),
  );
  assert.ok(file);
  assert.throws(() => applyHunks(content, file.hunks), /matches ambiguously at lines 2 and 4/);
});

test("applyHunks refuses a hunk whose context is absent", () => {
  const [file] = parseUnifiedDiff(
    ["--- a/f", "+++ b/f", "@@ -1,2 +1,2 @@", " nothere", "-beta", "+BETA"].join("\n"),
  );
  assert.ok(file);
  assert.throws(() => applyHunks("alpha\nbeta\n", file.hunks), /hunk 1 .* does not match/);
});

test("patch applies several hunks across several files in one call", async (t) => {
  const root = await workspace(t);
  const resolver = createResolver(root);
  const patch = createPatchTool(resolver);
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "src", "a.ts"),
    ["one", "two", "three", "four", "five", "six", "seven", "eight", ""].join("\n"),
  );
  await writeFile(join(root, "src", "b.ts"), "export const b = 1;\n");

  const output = await patch.execute({
    diff: [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,3 +1,4 @@",
      " one",
      "-two",
      "+TWO",
      "+TWO-AND-A-HALF",
      " three",
      "@@ -6,3 +7,3 @@",
      " six",
      "-seven",
      "+SEVEN",
      " eight",
      "diff --git a/src/b.ts b/src/b.ts",
      "--- a/src/b.ts",
      "+++ b/src/b.ts",
      "@@ -1,1 +1,1 @@",
      "-export const b = 1;",
      "+export const b = 2;",
    ].join("\n"),
  });

  assert.match(output, /modified src\/a\.ts \(\+3 -2\)/);
  assert.match(output, /modified src\/b\.ts \(\+1 -1\)/);
  assert.equal(
    await readFile(join(root, "src", "a.ts"), "utf8"),
    ["one", "TWO", "TWO-AND-A-HALF", "three", "four", "five", "six", "SEVEN", "eight", ""].join("\n"),
  );
  assert.equal(await readFile(join(root, "src", "b.ts"), "utf8"), "export const b = 2;\n");
});

test("patch creates and deletes files, including nested directories", async (t) => {
  const root = await workspace(t);
  const patch = createPatchTool(createResolver(root));
  await writeFile(join(root, "old.txt"), "gone\n");

  const output = await patch.execute({
    diff: [
      "diff --git a/nested/new.txt b/nested/new.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/nested/new.txt",
      "@@ -0,0 +1,2 @@",
      "+hello",
      "+world",
      "diff --git a/old.txt b/old.txt",
      "deleted file mode 100644",
      "--- a/old.txt",
      "+++ /dev/null",
      "@@ -1,1 +0,0 @@",
      "-gone",
    ].join("\n"),
  });

  assert.match(output, /created nested\/new\.txt \(\+2 -0\)/);
  assert.match(output, /deleted old\.txt \(-1\)/);
  assert.equal(await readFile(join(root, "nested", "new.txt"), "utf8"), "hello\nworld\n");
  await assert.rejects(readFile(join(root, "old.txt"), "utf8"));
});

test("patch accepts a fenced diff and reports hunks applied at an offset", async (t) => {
  const root = await workspace(t);
  const patch = createPatchTool(createResolver(root));
  await writeFile(join(root, "f.txt"), ["pad", "pad", "alpha", "beta", "gamma", ""].join("\n"));

  const output = await patch.execute({
    diff: [
      "```diff",
      "--- a/f.txt",
      "+++ b/f.txt",
      "@@ -1,3 +1,3 @@",
      " alpha",
      "-beta",
      "+BETA",
      " gamma",
      "```",
    ].join("\n"),
  });

  assert.match(output, /modified f\.txt \(\+1 -1\) \[hunk 1 at offset \+2\]/);
  assert.equal(
    await readFile(join(root, "f.txt"), "utf8"),
    ["pad", "pad", "alpha", "BETA", "gamma", ""].join("\n"),
  );
});

test("patch writes nothing when any hunk in the diff fails", async (t) => {
  const root = await workspace(t);
  const patch = createPatchTool(createResolver(root));
  await writeFile(join(root, "good.txt"), "alpha\nbeta\n");
  await writeFile(join(root, "bad.txt"), "one\ntwo\n");

  await assert.rejects(
    patch.execute({
      diff: [
        "--- a/good.txt",
        "+++ b/good.txt",
        "@@ -1,2 +1,2 @@",
        " alpha",
        "-beta",
        "+BETA",
        "--- a/bad.txt",
        "+++ b/bad.txt",
        "@@ -1,2 +1,2 @@",
        " nothere",
        "-two",
        "+TWO",
      ].join("\n"),
    }),
    /bad\.txt: hunk 1 .* does not match the file\. No files were changed\./,
  );

  assert.equal(await readFile(join(root, "good.txt"), "utf8"), "alpha\nbeta\n");
  assert.equal(await readFile(join(root, "bad.txt"), "utf8"), "one\ntwo\n");
});

test("patch preserves CRLF line endings", async (t) => {
  const root = await workspace(t);
  const patch = createPatchTool(createResolver(root));
  await writeFile(join(root, "crlf.txt"), "one\r\ntwo\r\nthree\r\n");

  await patch.execute({
    diff: [
      "--- a/crlf.txt",
      "+++ b/crlf.txt",
      "@@ -1,3 +1,3 @@",
      " one",
      "-two",
      "+2",
      " three",
    ].join("\n"),
  });

  assert.equal(await readFile(join(root, "crlf.txt"), "utf8"), "one\r\n2\r\nthree\r\n");
});

test("patch honours missing-newline markers in both directions", async (t) => {
  const root = await workspace(t);
  const patch = createPatchTool(createResolver(root));
  await writeFile(join(root, "tail.txt"), "one\ntwo");

  await patch.execute({
    diff: [
      "--- a/tail.txt",
      "+++ b/tail.txt",
      "@@ -1,2 +1,2 @@",
      " one",
      "-two",
      "\\ No newline at end of file",
      "+2",
      "\\ No newline at end of file",
    ].join("\n"),
  });
  assert.equal(await readFile(join(root, "tail.txt"), "utf8"), "one\n2");

  await patch.execute({
    diff: [
      "--- a/tail.txt",
      "+++ b/tail.txt",
      "@@ -1,2 +1,2 @@",
      " one",
      "-2",
      "\\ No newline at end of file",
      "+two",
    ].join("\n"),
  });
  assert.equal(await readFile(join(root, "tail.txt"), "utf8"), "one\ntwo\n");
});

test("patch refuses paths outside the workspace and diffs it cannot parse", async (t) => {
  const root = await workspace(t);
  const patch = createPatchTool(createResolver(root));

  await assert.rejects(
    patch.execute({
      diff: ["--- a/../escape.txt", "+++ b/../escape.txt", "@@ -1,1 +1,1 @@", "-a", "+b"].join("\n"),
    }),
    /escapes the workspace|ENOENT/,
  );
  await assert.rejects(patch.execute({ diff: "not a diff at all" }), /No file diffs found/);
});

test("two sections for the same path build on each other instead of overwriting", async (t) => {
  const root = await workspace(t);
  const patch = createPatchTool(createResolver(root));
  await writeFile(join(root, "a.txt"), ["one", "two", "three", "four", ""].join("\n"));

  const output = await patch.execute({
    diff: [
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,2 +1,2 @@",
      "-one",
      "+ONE",
      " two",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -3,2 +3,2 @@",
      "-three",
      "+THREE",
      " four",
    ].join("\n"),
  });

  assert.equal(output, "modified a.txt (+2 -2)");
  assert.equal(
    await readFile(join(root, "a.txt"), "utf8"),
    ["ONE", "two", "THREE", "four", ""].join("\n"),
  );
});

test("a later section can patch a file an earlier section created", async (t) => {
  const root = await workspace(t);
  const patch = createPatchTool(createResolver(root));

  await patch.execute({
    diff: [
      "--- /dev/null",
      "+++ b/fresh.txt",
      "@@ -0,0 +1,3 @@",
      "+alpha",
      "+beta",
      "+gamma",
      "--- a/fresh.txt",
      "+++ b/fresh.txt",
      "@@ -2,1 +2,1 @@",
      "-beta",
      "+BETA",
    ].join("\n"),
  });

  assert.equal(await readFile(join(root, "fresh.txt"), "utf8"), "alpha\nBETA\ngamma\n");
});

test("patch rejects a diff that both deletes and changes the same path", async (t) => {
  const root = await workspace(t);
  const patch = createPatchTool(createResolver(root));
  await writeFile(join(root, "a.txt"), "one\ntwo\n");

  await assert.rejects(
    patch.execute({
      diff: [
        "--- a/a.txt",
        "+++ /dev/null",
        "@@ -1,2 +0,0 @@",
        "-one",
        "-two",
        "--- a/a.txt",
        "+++ b/a.txt",
        "@@ -1,1 +1,1 @@",
        "-one",
        "+ONE",
      ].join("\n"),
    }),
    /a\.txt: the diff both deletes and changes this file\. No files were changed\./,
  );
  assert.equal(await readFile(join(root, "a.txt"), "utf8"), "one\ntwo\n");

  await assert.rejects(
    patch.execute({
      diff: [
        "--- a/a.txt",
        "+++ b/a.txt",
        "@@ -1,1 +1,1 @@",
        "-one",
        "+ONE",
        "--- a/a.txt",
        "+++ /dev/null",
        "@@ -1,2 +0,0 @@",
        "-ONE",
        "-two",
      ].join("\n"),
    }),
    /both deletes and changes this file/,
  );
  assert.equal(await readFile(join(root, "a.txt"), "utf8"), "one\ntwo\n");
});

test("a failing later section for the same path leaves the file untouched", async (t) => {
  const root = await workspace(t);
  const patch = createPatchTool(createResolver(root));
  await writeFile(join(root, "a.txt"), ["one", "two", "three", ""].join("\n"));

  await assert.rejects(
    patch.execute({
      diff: [
        "--- a/a.txt",
        "+++ b/a.txt",
        "@@ -1,1 +1,1 @@",
        "-one",
        "+ONE",
        "--- a/a.txt",
        "+++ b/a.txt",
        "@@ -3,1 +3,1 @@",
        "-nothere",
        "+THREE",
      ].join("\n"),
    }),
    /a\.txt: hunk 2 .* does not match the file\. No files were changed\./,
  );
  assert.equal(await readFile(join(root, "a.txt"), "utf8"), ["one", "two", "three", ""].join("\n"));
});
