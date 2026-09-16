import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import test from "node:test";
import { JobManager, createJobTools } from "../src/agent/jobs.js";
import type { PathResolver } from "../src/agent/tools.js";
import type { ToolDefinition } from "../src/agent/types.js";

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

interface TestContext {
  after: (fn: () => unknown) => void;
}

async function createManager(
  t: TestContext,
  options: { maxJobs?: number; maxBufferChars?: number } = {},
): Promise<{ root: string; manager: JobManager }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "copilot-jobs-")));
  const manager = new JobManager({ resolver: createResolver(root), shell: "/bin/sh", ...options });
  t.after(async () => {
    await manager.closeAll();
    await rm(root, { recursive: true, force: true });
  });
  return { root, manager };
}

function tool(tools: ToolDefinition[], name: string): ToolDefinition {
  const found = tools.find((candidate) => candidate.name === name);
  assert.ok(found, `missing tool ${name}`);
  return found;
}

/** Waits for a condition, polling briefly; keeps tests well under a second. */
async function until(
  check: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 15));
  }
}

test("a job reports only new output on each read and its exit code when it finishes", async (t) => {
  const { root, manager } = await createManager(t);
  const record = await manager.start(
    "printf 'first\\n'; while [ ! -f go ]; do sleep 0.02; done; printf 'second\\n'; exit 3",
    "demo",
  );
  assert.equal(record.name, "demo");
  assert.equal(record.status, "running");
  assert.ok(record.pid !== undefined);

  let seen = "";
  await until(
    () => {
      seen += manager.read(record.id).text;
      return seen.includes("first");
    },
    "first line",
  );
  assert.ok(!seen.includes("second"));
  assert.equal(manager.read(record.id).hasNew, false);

  await writeFile(join(root, "go"), "");
  const finished = await manager.wait(record.id, 5_000);
  assert.equal(finished.status, "exited");
  assert.equal(finished.exitCode, 3);
  assert.ok(finished.endedAt !== undefined);

  const tail = manager.read(record.id);
  assert.match(tail.text, /second/);
  assert.ok(!tail.text.includes("first"));
  assert.match(manager.read(record.id, { all: true }).text, /first\nsecond/);
});

test("job output is stripped of ANSI escapes and bounded by tail", async (t) => {
  const { manager } = await createManager(t);
  const record = await manager.start(
    "printf '\\033[31mred\\033[0m\\n'; for i in 1 2 3 4 5; do printf 'line%s\\n' \"$i\"; done",
  );
  await manager.wait(record.id, 5_000);

  const full = manager.read(record.id, { all: true });
  assert.equal(full.text, "red\nline1\nline2\nline3\nline4\nline5\n");

  const bounded = manager.read(record.id, { all: true, tail: 2 });
  assert.equal(bounded.text, "line4\nline5\n");
  assert.equal(bounded.omittedLines, 4);
});

test("the ring buffer drops the oldest output and reports how much was lost", async (t) => {
  const { manager } = await createManager(t, { maxBufferChars: 50 });
  const record = await manager.start("for i in $(seq 1 40); do printf 'line%s\\n' \"$i\"; done");
  await manager.wait(record.id, 5_000);

  const output = manager.read(record.id);
  assert.equal(output.text.length, 50);
  assert.ok(output.text.endsWith("line40\n"));
  assert.ok(output.droppedChars > 200, `expected dropped characters, got ${output.droppedChars}`);
  assert.ok(!output.text.includes("line1\n"));
});

test("a job runs in a requested directory inside the workspace", async (t) => {
  const { root, manager } = await createManager(t);
  await mkdir(join(root, "sub"));
  const record = await manager.start("pwd", undefined, "sub");
  await manager.wait(record.id, 5_000);
  assert.equal(record.cwd, join(root, "sub"));
  assert.match(manager.read(record.id, { all: true }).text, /\/sub\n$/);
  await assert.rejects(manager.start("pwd", undefined, "../elsewhere"), /escapes the workspace|ENOENT/);
});

test("killing a job stops it and closeAll stops everything still running", async (t) => {
  const { manager } = await createManager(t);
  const first = await manager.start("sleep 30");
  const second = await manager.start("sleep 30");

  const killed = await manager.kill(first.id);
  assert.equal(killed.status, "killed");
  assert.equal(killed.signal, "SIGTERM");

  assert.equal(manager.get(second.id).status, "running");
  await manager.closeAll();
  assert.equal(manager.get(second.id).status, "killed");
  assert.equal(manager.list().length, 2);
});

test("starting more jobs than the limit fails with a hint to kill one", async (t) => {
  const { manager } = await createManager(t, { maxJobs: 1 });
  await manager.start("sleep 30");
  await assert.rejects(manager.start("sleep 30"), /Too many background jobs.*job_kill/s);

  await manager.closeAll();
  const replacement = await manager.start("printf 'ok\\n'");
  await manager.wait(replacement.id, 5_000);
  assert.equal(replacement.status, "exited");
});

test("unknown job ids and empty commands are rejected", async (t) => {
  const { manager } = await createManager(t);
  assert.throws(() => manager.get(9), /No background job #9/);
  await assert.rejects(manager.start("   "), /command must be a non-empty string/);
});

test("job tools expose start, output, wait, kill, and list", async (t) => {
  const { root, manager } = await createManager(t);
  const tools = createJobTools(manager);
  assert.deepEqual(
    tools.map((definition) => definition.name),
    ["job_start", "job_output", "job_wait", "job_kill", "job_list"],
  );
  assert.equal(tool(tools, "job_start").parameters, "command, name?, cwd?");
  assert.equal(tool(tools, "job_output").parameters, "id, tail?=200, all?=false");
  assert.equal(tool(tools, "job_start").mutates, true);
  assert.equal(tool(tools, "job_output").mutates, false);

  const started = await tool(tools, "job_start").execute({
    command: "printf 'hello\\n'; while [ ! -f go ]; do sleep 0.02; done; printf 'bye\\n'",
    name: "watcher",
  });
  assert.match(started, /Started job #1 \(watcher\), pid \d+/);

  let seen = "";
  await until(
    async () => {
      seen += await tool(tools, "job_output").execute({ id: "#1" });
      return seen.includes("hello");
    },
    "hello from the job",
  );
  assert.match(seen, /#1 watcher — running \(pid \d+/);

  const waited = await tool(tools, "job_wait").execute({ id: 1, timeout_ms: 200 });
  assert.match(waited, /still running after 200ms/);

  await writeFile(join(root, "go"), "");
  const finished = await tool(tools, "job_wait").execute({ id: 1, timeout_ms: 5_000 });
  assert.match(finished, /#1 watcher — exited 0/);
  assert.match(finished, /bye/);

  assert.match(
    await tool(tools, "job_output").execute({ id: 1 }),
    /\(no new output since the last read\)/,
  );
  assert.match(await tool(tools, "job_list").execute({}), /#1\texited 0\twatcher\t/);
});

test("job_kill through the tools reports the killed status", async (t) => {
  const { manager } = await createManager(t);
  const tools = createJobTools(manager);
  await tool(tools, "job_start").execute({ command: "sleep 30", name: "sleeper" });
  const output = await tool(tools, "job_kill").execute({ id: 1, signal: "sigterm" });
  assert.match(output, /#1 sleeper — killed \(SIGTERM\)/);
  await assert.rejects(tool(tools, "job_kill").execute({ id: 1, signal: "SIGNOPE" }), /signal must be one of/);
});

test("job_wait honours an abort signal", async (t) => {
  const { manager } = await createManager(t);
  const tools = createJobTools(manager);
  await tool(tools, "job_start").execute({ command: "sleep 30" });
  const controller = new AbortController();
  const pending = tool(tools, "job_wait").execute({ id: 1 }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /aborted/i);
});

test("job_list says so when nothing has been started", async (t) => {
  const { manager } = await createManager(t);
  assert.equal(await tool(createJobTools(manager), "job_list").execute({}), "No background jobs");
});

test("an unterminated window title does not swallow the output after it", async (t) => {
  const { manager } = await createManager(t);
  const record = await manager.start(
    "printf '\\033]0;t \\033[31m FAILED: 3 tests \\007\\n'; printf '\\033]0;title\\007done\\n'",
  );
  await manager.wait(record.id, 5_000);

  const text = manager.read(record.id, { all: true }).text;
  assert.ok(text.includes("FAILED: 3 tests"), `lost output: ${JSON.stringify(text)}`);
  assert.ok(text.includes("done"), `lost output: ${JSON.stringify(text)}`);
  assert.ok(!text.includes("title"), `kept a window title: ${JSON.stringify(text)}`);
});
