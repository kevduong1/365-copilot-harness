import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createWorkspaceTools } from "../src/agent/tools.js";

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
