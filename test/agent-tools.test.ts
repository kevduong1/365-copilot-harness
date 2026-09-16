import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { config } from "../src/config.js";
import {
  closeAllJobs,
  createWorkspaceTools,
  getRetainedOutput,
  setRipgrepAvailability,
} from "../src/agent/tools.js";

/** Forces the pure-Node search path for the body of a test. */
async function withoutRipgrep<T>(run: () => Promise<T>): Promise<T> {
  setRipgrepAvailability(false);
  try {
    return await run();
  } finally {
    setRipgrepAvailability(undefined);
  }
}

test("workspace read and grep tools inspect files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "copilot-tools-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "example.ts"), "first\nconst CopilotClient = true;\nthird\n");
  const tools = await createWorkspaceTools(root);
  const read = tools.find((tool) => tool.name === "read");
  const grep = tools.find((tool) => tool.name === "grep");
  assert.ok(read && grep);

  assert.match(await read.execute({ path: "src/example.ts", offset: 2, limit: 1 }), /2: const CopilotClient/);
  assert.match(await grep.execute({ pattern: "CopilotClient", path: "src" }), /src\/example\.ts:2:/);
});

test("workspace tools reject paths outside the root", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "copilot-tools-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tools = await createWorkspaceTools(root);
  const read = tools.find((tool) => tool.name === "read");
  assert.ok(read);

  await assert.rejects(read.execute({ path: "../outside.txt" }), /escapes the workspace/);
});

test("additional roots and cd provide persistent access to another project", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "copilot-tools-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const first = join(parent, "first");
  const second = join(parent, "second");
  await mkdir(first);
  await mkdir(join(second, "src"), { recursive: true });
  await writeFile(join(second, "src", "other.ts"), "export const elsewhere = true;\n");

  const tools = await createWorkspaceTools(first, { allowedRoots: [second] });
  const pwd = tools.find((tool) => tool.name === "pwd");
  const cd = tools.find((tool) => tool.name === "cd");
  const read = tools.find((tool) => tool.name === "read");
  const grep = tools.find((tool) => tool.name === "grep");
  assert.ok(pwd && cd && read && grep);

  assert.match(await pwd.execute({}), new RegExp(second.replaceAll("/", "\\/")));
  assert.match(await cd.execute({ path: second }), /Current working directory: .*\/second$/);
  assert.match(await read.execute({ path: "src/other.ts" }), /elsewhere = true/);
  assert.match(await grep.execute({ pattern: "elsewhere", path: "." }), /src\/other\.ts:1:/);
});

test("cd rejects an ungranted directory and symlinks outside granted roots", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "copilot-tools-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "root");
  const outside = join(parent, "outside");
  await mkdir(root);
  await mkdir(outside);
  await symlink(outside, join(root, "escape"));
  const tools = await createWorkspaceTools(root);
  const cd = tools.find((tool) => tool.name === "cd");
  assert.ok(cd);

  await assert.rejects(cd.execute({ path: outside }), /escapes the workspace/);
  await assert.rejects(cd.execute({ path: "escape" }), /resolves outside the workspace/);
});

test("edit requires a unique match", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "copilot-tools-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "duplicate.txt"), "same\nsame\n");
  const tools = await createWorkspaceTools(root);
  const edit = tools.find((tool) => tool.name === "edit");
  assert.ok(edit);

  await assert.rejects(
    edit.execute({ path: "duplicate.txt", old_text: "same", new_text: "different" }),
    /more than once/,
  );
});

test("edit supports line ranges from numbered read output", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "copilot-tools-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "lines.txt");
  await writeFile(path, "one\ntwo\nthree\nfour\n");
  const tools = await createWorkspaceTools(root);
  const edit = tools.find((tool) => tool.name === "edit");
  assert.ok(edit);

  assert.match(
    await edit.execute({
      path: "lines.txt",
      start_line: 2,
      end_line: 3,
      new_text: "replacement\nlines",
    }),
    /lines 2-3/,
  );
  assert.equal(await readFile(path, "utf8"), "one\nreplacement\nlines\nfour\n");
});

test("edit accepts common aliases and intentional replace-all", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "copilot-tools-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "aliases.txt");
  await writeFile(path, "old old old\n");
  const tools = await createWorkspaceTools(root);
  const edit = tools.find((tool) => tool.name === "edit");
  assert.ok(edit);

  assert.match(
    await edit.execute({
      path: "aliases.txt",
      oldString: "old",
      newString: "new",
      replaceAll: true,
    }),
    /3 replacements/,
  );
  assert.equal(await readFile(path, "utf8"), "new new new\n");
});

test("invalid line edits leave the file unchanged", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "copilot-tools-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "unchanged.txt");
  await writeFile(path, "one\ntwo\n");
  const tools = await createWorkspaceTools(root);
  const edit = tools.find((tool) => tool.name === "edit");
  assert.ok(edit);

  await assert.rejects(
    edit.execute({ path: "unchanged.txt", startLine: 5, newText: "bad" }),
    /exceeds/,
  );
  assert.equal(await readFile(path, "utf8"), "one\ntwo\n");
});

test("bash timeout returns the captured output instead of throwing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "copilot-tools-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tools = await createWorkspaceTools(root);
  const bash = tools.find((tool) => tool.name === "bash")!;
  const started = Date.now();

  const output = await bash.execute({
    command: "echo partial; trap '' TERM; sleep 10 & wait",
    timeout_ms: 500,
  });
  assert.match(output, /exit_code: timeout/);
  assert.match(output, /timed_out after 500ms/);
  assert.match(output, /partial/);
  assert.ok(Date.now() - started < 5_000);
});

test("bash accepts stdin, a cwd, and strips ANSI escapes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "copilot-tools-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "nested", "marker.txt"), "here\n");
  const tools = await createWorkspaceTools(root);
  const bash = tools.find((tool) => tool.name === "bash")!;

  const piped = await bash.execute({ command: "cat", stdin: "from stdin\n" });
  assert.match(piped, /from stdin/);

  const listed = await bash.execute({ command: "ls", cwd: "nested" });
  assert.match(listed, /marker\.txt/);

  const colored = await bash.execute({ command: "printf '\\033[31mred\\033[0m\\n'" });
  assert.match(colored, /stdout:\nred/);
  assert.doesNotMatch(colored, /\u001B\[/);
});

test("bash rejects a cwd outside the workspace and a non-directory cwd", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "copilot-tools-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "file.txt"), "x\n");
  const tools = await createWorkspaceTools(root);
  const bash = tools.find((tool) => tool.name === "bash")!;

  await assert.rejects(bash.execute({ command: "pwd", cwd: "../" }), /escapes the workspace/);
  await assert.rejects(bash.execute({ command: "pwd", cwd: "file.txt" }), /is not a directory/);
});

test("bash honours an abort signal and reports partial output", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "copilot-tools-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tools = await createWorkspaceTools(root);
  const bash = tools.find((tool) => tool.name === "bash")!;
  const controller = new AbortController();
  const started = Date.now();

  const pending = bash.execute(
    { command: "echo started; sleep 10", timeout_ms: 30_000 },
    { signal: controller.signal },
  );
  setTimeout(() => controller.abort(), 300);
  const output = await pending;

  assert.match(output, /exit_code: aborted/);
  assert.match(output, /started/);
  assert.ok(Date.now() - started < 5_000);
});

test("bash keeps the head and tail of oversized output and retains the rest", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "copilot-tools-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tools = await createWorkspaceTools(root);
  const bash = tools.find((tool) => tool.name === "bash")!;
  const read = tools.find((tool) => tool.name === "read")!;
  const lines = Math.ceil(config.toolOutputMaxChars / 4);

  const output = await bash.execute({
    command: `awk 'BEGIN { for (i = 1; i <= ${lines}; i++) print "L" i }'`,
    timeout_ms: 60_000,
  });

  assert.match(output, /stdout:\nL1\n/);
  assert.match(output, /characters omitted …/);
  assert.match(output, new RegExp(`L${lines}\\b`));
  const reference = /harness:\/\/output\/(\d+)/.exec(output);
  assert.ok(reference, "expected a retained output reference");
  const retained = getRetainedOutput(tools, Number(reference[1]));
  assert.ok(retained?.startsWith("L1\n"));
  assert.ok(retained?.trimEnd().endsWith(`L${lines}`));

  const paged = await read.execute({ path: `harness://output/${reference[1]}`, offset: 2, limit: 2 });
  assert.match(paged, /2: L2\n3: L3/);
  assert.match(paged, /more lines/);
});

test("retained outputs are private to the tool set that produced them", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "copilot-tools-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filler = (label: string): string =>
    `${Array.from({ length: 2_000 }, (_, index) => `${label} ${index + 1} 0123456789`).join("\n")}\n`;
  await writeFile(join(root, "alpha.txt"), filler("alpha"));
  await writeFile(join(root, "beta.txt"), filler("beta"));

  const first = await createWorkspaceTools(root, { jobs: false });
  const second = await createWorkspaceTools(root, { jobs: false });
  const firstRead = first.find((tool) => tool.name === "read")!;
  const secondRead = second.find((tool) => tool.name === "read")!;

  const firstOutput = await firstRead.execute({ path: "alpha.txt", limit: 2_000 });
  const firstReference = /harness:\/\/output\/(\d+)/.exec(firstOutput);
  assert.ok(firstReference, "expected the oversized read to be retained");
  const firstId = Number(firstReference[1]);

  assert.ok(getRetainedOutput(first, firstId)?.includes("alpha 1 "));
  assert.equal(getRetainedOutput(second, firstId), undefined);
  assert.match(
    await firstRead.execute({ path: `harness://output/${firstId}`, limit: 1 }),
    /1: alpha\.txt/,
  );
  await assert.rejects(
    secondRead.execute({ path: `harness://output/${firstId}` }),
    /no longer retained/,
  );

  // Each tool set numbers from 1, so the same id resolves to different content.
  const secondOutput = await secondRead.execute({ path: "beta.txt", limit: 2_000 });
  const secondReference = /harness:\/\/output\/(\d+)/.exec(secondOutput);
  assert.ok(secondReference);
  assert.equal(Number(secondReference[1]), firstId);
  assert.ok(getRetainedOutput(second, firstId)?.includes("beta 1 "));
  assert.doesNotMatch(getRetainedOutput(first, firstId) ?? "", /beta 1 /);
});

test("read rejects binary files, oversized lines aside", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "copilot-tools-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "binary.bin"), Buffer.from([0x50, 0x4b, 0x00, 0x03, 0x04]));
  const tools = await createWorkspaceTools(root);
  const read = tools.find((tool) => tool.name === "read")!;

  await assert.rejects(read.execute({ path: "binary.bin" }), /looks binary/);
});

test("read truncates very long lines", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "copilot-tools-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "long.txt"), `${"a".repeat(5_000)}\nshort\n`);
  const tools = await createWorkspaceTools(root);
  const read = tools.find((tool) => tool.name === "read")!;

  const output = await read.execute({ path: "long.txt" });
  assert.match(output, /… \(line truncated\)/);
  assert.ok(output.length < 4_000);
  assert.match(output, /2: short/);
});

test("read reports a missing retained output clearly", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "copilot-tools-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tools = await createWorkspaceTools(root);
  const read = tools.find((tool) => tool.name === "read")!;

  await assert.rejects(
    read.execute({ path: "harness://output/999999" }),
    /no longer retained/,
  );
});

test("grep and find work without ripgrep on PATH", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "copilot-tools-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "src", "deep"), { recursive: true });
  await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
  await mkdir(join(root, ".git"), { recursive: true });
  await writeFile(join(root, ".gitignore"), "ignored/\n*.log\n");
  await mkdir(join(root, "ignored"));
  await writeFile(join(root, "ignored", "hidden.ts"), "needle\n");
  await writeFile(join(root, "noisy.log"), "needle\n");
  await writeFile(join(root, "node_modules", "pkg", "index.js"), "needle\n");
  await writeFile(join(root, ".git", "config"), "needle\n");
  await writeFile(join(root, "src", "a.ts"), "alpha\nneedle here\nomega\n");
  await writeFile(join(root, "src", "deep", "b.md"), "needle in markdown\n");

  await withoutRipgrep(async () => {
    const tools = await createWorkspaceTools(root);
    const grep = tools.find((tool) => tool.name === "grep")!;
    const find = tools.find((tool) => tool.name === "find")!;

    const matches = await grep.execute({ pattern: "needle" });
    assert.match(matches, /^src\/a\.ts:2:1:needle here$/m);
    assert.match(matches, /^src\/deep\/b\.md:1:1:needle in markdown$/m);
    assert.doesNotMatch(matches, /node_modules/);
    assert.doesNotMatch(matches, /\.git\//);
    assert.doesNotMatch(matches, /ignored\//);
    assert.doesNotMatch(matches, /noisy\.log/);

    const globbed = await grep.execute({ pattern: "needle", glob: "*.ts" });
    assert.match(globbed, /src\/a\.ts:2:1:/);
    assert.doesNotMatch(globbed, /b\.md/);

    const files = await find.execute({});
    assert.match(files, /^src\/a\.ts$/m);
    assert.match(files, /^src\/deep\/b\.md$/m);
    assert.doesNotMatch(files, /node_modules/);

    const markdown = await find.execute({ glob: "*.md" });
    assert.equal(markdown, "src/deep/b.md");

    assert.equal(await grep.execute({ pattern: "nothing-here" }), "No matches");
  });
});

test("grep options work on the fallback path", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "copilot-tools-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "a.txt"), "one\nNEEDLE\nthree\nfour\n");
  await writeFile(join(root, "b.txt"), "axb\nliteral a.b\n");

  await withoutRipgrep(async () => {
    const tools = await createWorkspaceTools(root);
    const grep = tools.find((tool) => tool.name === "grep")!;

    assert.equal(await grep.execute({ pattern: "needle" }), "No matches");
    assert.match(await grep.execute({ pattern: "needle", ignore_case: true }), /a\.txt:2:1:NEEDLE/);

    const asRegex = await grep.execute({ pattern: "a.b", path: "b.txt" });
    assert.match(asRegex, /b\.txt:1:1:axb/);
    const fixed = await grep.execute({ pattern: "a.b", fixed_strings: true, path: "b.txt" });
    assert.equal(fixed, "b.txt:2:9:literal a.b");

    const contextual = await grep.execute({ pattern: "NEEDLE", context: 1 });
    assert.match(contextual, /a\.txt-1-one/);
    assert.match(contextual, /a\.txt:2:1:NEEDLE/);
    assert.match(contextual, /a\.txt-3-three/);
    assert.doesNotMatch(contextual, /four/);

    assert.equal(await grep.execute({ pattern: "NEEDLE", files_only: true }), "a.txt");
    assert.equal(
      await grep.execute({ pattern: "nope", files_only: true }),
      "No matching files",
    );

    const limited = await grep.execute({ pattern: ".", path: "a.txt", max_results: 2 });
    assert.match(limited, /… 2 more matches/);
  });
});

test("grep options work through ripgrep when it is installed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "copilot-tools-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "a.txt"), "one\nNEEDLE\nthree\n");
  const tools = await createWorkspaceTools(root);
  const grep = tools.find((tool) => tool.name === "grep")!;

  // Identical assertions on whichever path this machine takes; the fallback is
  // exercised explicitly above.
  assert.match(await grep.execute({ pattern: "needle", ignore_case: true }), /a\.txt:2:1:NEEDLE/);
  assert.equal(await grep.execute({ pattern: "NEEDLE", files_only: true }), "a.txt");
  const contextual = await grep.execute({ pattern: "NEEDLE", context: 1 });
  assert.match(contextual, /a\.txt-1-one/);
  assert.match(contextual, /a\.txt:2:1:NEEDLE/);
});

test("edit retries whitespace-tolerantly and preserves the file indentation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "copilot-tools-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "indented.ts");
  await writeFile(path, "function outer() {\n    const value = 1;\n    return value;\n}\n");
  const tools = await createWorkspaceTools(root);
  const edit = tools.find((tool) => tool.name === "edit")!;

  const output = await edit.execute({
    path: "indented.ts",
    old_text: "const value = 1;\nreturn value;",
    new_text: "const value = 2;\nreturn value;",
  });
  assert.match(output, /matched ignoring indentation/);
  assert.equal(
    await readFile(path, "utf8"),
    "function outer() {\n    const value = 2;\n    return value;\n}\n",
  );
});

test("edit tolerates trailing whitespace differences", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "copilot-tools-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "trailing.txt");
  await writeFile(path, "alpha   \nbeta\n");
  const tools = await createWorkspaceTools(root);
  const edit = tools.find((tool) => tool.name === "edit")!;

  const output = await edit.execute({
    path: "trailing.txt",
    old_text: "alpha\nbeta",
    new_text: "gamma\ndelta",
  });
  assert.match(output, /matched ignoring trailing whitespace/);
  assert.equal(await readFile(path, "utf8"), "gamma\ndelta\n");
});

test("edit preserves CRLF line endings", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "copilot-tools-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "windows.txt");
  await writeFile(path, "one\r\ntwo\r\nthree\r\n");
  const tools = await createWorkspaceTools(root);
  const edit = tools.find((tool) => tool.name === "edit")!;

  await edit.execute({ path: "windows.txt", old_text: "two", new_text: "second" });
  assert.equal(await readFile(path, "utf8"), "one\r\nsecond\r\nthree\r\n");

  await edit.execute({ path: "windows.txt", start_line: 3, new_text: "third" });
  assert.equal(await readFile(path, "utf8"), "one\r\nsecond\r\nthird\r\n");
});

test("edit returns a numbered snippet of the changed region", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "copilot-tools-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "snippet.txt");
  await writeFile(path, "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n");
  const tools = await createWorkspaceTools(root);
  const edit = tools.find((tool) => tool.name === "edit")!;

  const output = await edit.execute({ path: "snippet.txt", old_text: "5", new_text: "five" });
  assert.match(output, /^2: 2$/m);
  assert.match(output, /^5: five$/m);
  assert.match(output, /^8: 8$/m);
  assert.doesNotMatch(output, /^1: 1$/m);

  const ranged = await edit.execute({ path: "snippet.txt", start_line: 1, new_text: "one" });
  assert.match(ranged, /^1: one$/m);
  assert.match(ranged, /^4: 4$/m);
});

test("edit still reports an unfindable old_text", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "copilot-tools-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "plain.txt"), "alpha\n");
  const tools = await createWorkspaceTools(root);
  const edit = tools.find((tool) => tool.name === "edit")!;

  await assert.rejects(
    edit.execute({ path: "plain.txt", old_text: "omega", new_text: "x" }),
    /old_text was not found/,
  );
});

test("write reports creation, overwriting, and refuses binary files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "copilot-tools-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tools = await createWorkspaceTools(root);
  const write = tools.find((tool) => tool.name === "write")!;

  assert.match(await write.execute({ path: "new.txt", content: "hello\n" }), /^Created new\.txt \(6 characters\)/);
  assert.match(
    await write.execute({ path: "new.txt", content: "hi\n" }),
    /^Overwrote new\.txt \(3 characters; previous file was 6 bytes\)/,
  );

  await writeFile(join(root, "blob.bin"), Buffer.from([1, 0, 2, 3]));
  await assert.rejects(
    write.execute({ path: "blob.bin", content: "text" }),
    /looks binary; pass force=true/,
  );
  assert.match(
    await write.execute({ path: "blob.bin", content: "text", force: true }),
    /^Overwrote blob\.bin/,
  );
  assert.equal(await readFile(join(root, "blob.bin"), "utf8"), "text");
});

test("workspace tools include patch and background jobs and report cd changes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "copilot-tools-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "nested"));
  const seen: string[] = [];
  const tools = await createWorkspaceTools(root, { onDirectoryChange: (cwd) => seen.push(cwd) });
  const names = tools.map((tool) => tool.name);
  for (const name of ["patch", "job_start", "job_output", "job_wait", "job_kill", "job_list"]) {
    assert.ok(names.includes(name), `${name} should be registered`);
  }

  const cd = tools.find((tool) => tool.name === "cd");
  assert.ok(cd);
  await cd.execute({ path: "nested" });
  assert.equal(seen.length, 1);
  assert.match(seen[0] ?? "", /nested$/);

  const start = tools.find((tool) => tool.name === "job_start");
  const list = tools.find((tool) => tool.name === "job_list");
  assert.ok(start && list);
  assert.match(await start.execute({ command: "sleep 30" }), /job/i);
  await closeAllJobs();
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  assert.doesNotMatch(await list.execute({}), /running/);
});

test("workspace tools can omit the job operations", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "copilot-tools-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tools = await createWorkspaceTools(root, { jobs: false });
  assert.ok(!tools.some((tool) => tool.name.startsWith("job_")));
  assert.ok(tools.some((tool) => tool.name === "patch"));
});
