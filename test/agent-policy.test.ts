import assert from "node:assert/strict";
import test from "node:test";
import {
  ApprovalPolicy,
  commandPrefix,
  formatRules,
  hasUnsafeSyntax,
  isSafeCommand,
  matchesPrefix,
  ruleFor,
  ruleLabel,
} from "../src/agent/policy.js";
import type { ToolCall, ToolDefinition } from "../src/agent/types.js";

const bash: ToolDefinition = {
  name: "bash",
  description: "run a shell command",
  parameters: "command",
  mutates: true,
  execute: async () => "",
};

const write: ToolDefinition = {
  name: "write",
  description: "write a file",
  parameters: "path, content",
  mutates: true,
  execute: async () => "",
};

const read: ToolDefinition = {
  name: "read",
  description: "read a file",
  parameters: "path",
  mutates: false,
  execute: async () => "",
};

function bashCall(command: string): ToolCall {
  return { name: "bash", arguments: { command } };
}

test("the safe-command classifier accepts only read-only allowlist entries", () => {
  for (const command of [
    "ls",
    "ls -la src",
    "pwd",
    "cat README.md",
    "head -n 20 src/cli.ts",
    "tail -n 5 log.txt",
    "wc -l src/cli.ts",
    "grep -n CopilotClient src/client.ts",
    "echo hello",
    "which node",
    "whoami",
    "printenv PATH",
    "stat src/cli.ts",
    "git status",
    "git status --short",
    "git log --oneline -5",
    "git diff HEAD~1",
    "git show HEAD",
    "git rev-parse HEAD",
    "git branch",
    "git branch -a",
    "git branch --list 'feature/*'",
    "git remote",
    "git remote -v",
    "git remote show origin",
    "git remote get-url origin",
    "node --version",
    "pnpm --version",
    "pnpm ls",
    "npm ls",
    "  ls  ",
  ]) {
    assert.equal(isSafeCommand(command), true, `${command} should be safe`);
  }
});

test("the safe-command classifier rejects mutations, unknown verbs, and bare git", () => {
  for (const command of [
    "",
    "   ",
    "rm -rf /",
    "git",
    "git commit -m x",
    "git push",
    "git checkout main",
    "pnpm test",
    "pnpm install",
    "node script.js",
    "lsof -i",
    "catt file",
  ]) {
    assert.equal(isSafeCommand(command), false, `${command} should not be safe`);
  }
});

test("commands that can execute or write through an option are never safe", () => {
  for (const command of [
    // Verified bypasses: each of these ran arbitrary code or wrote a file.
    "env rm -rf victim",
    "find . -exec rm {} +",
    "find . -delete",
    "rg --pre ./script pattern",
    "git diff --output=/outside",
    "git branch -D x",
    "git remote set-url origin https://evil.example",
    // The commands those bypasses relied on are gone from the allowlist.
    "env",
    "find .",
    "rg pattern",
    "tree",
    "date",
    "file src/cli.ts",
    "du -sh .",
    "df -h",
    // The remaining executing and writing options.
    "grep -o pattern file",
    "git log --output /tmp/x",
    "git show --ext-diff",
    "git diff --textconv",
    "git log --extcmd=sh",
    "git status --git-dir=/tmp/x",
    "git status --work-tree /tmp",
    "git status --exec-path=/tmp",
    "git log --upload-pack=sh",
    "git log --receive-pack=sh",
    "git status --config x",
  ]) {
    assert.equal(isSafeCommand(command), false, `${command} should not be safe`);
  }
});

test("git branch and git remote are safe only in their listing forms", () => {
  for (const command of [
    "git branch -d x",
    "git branch -D x",
    "git branch -m old new",
    "git branch -M old new",
    "git branch -c a b",
    "git branch -C a b",
    "git branch -f x HEAD",
    "git branch -u origin/x",
    "git branch --delete x",
    "git branch --move a b",
    "git branch --copy a b",
    "git branch --set-upstream-to=origin/x",
    "git branch --unset-upstream",
    "git branch --edit-description",
    "git branch --force x",
    // A bare name creates or renames unless it is filtering a --list.
    "git branch newbranch",
    "git remote add origin https://evil.example",
    "git remote remove origin",
    "git remote rename a b",
    "git remote set-url origin x",
    "git remote prune origin",
    "git remote -v extra",
  ]) {
    assert.equal(isSafeCommand(command), false, `${command} should not be safe`);
  }
});

test("an environment assignment prefix hides the real command", () => {
  assert.equal(isSafeCommand("FOO=1 rm x"), false);
  assert.equal(isSafeCommand("PATH=/tmp ls"), false);
  assert.equal(isSafeCommand("GIT_PAGER=sh git log"), false);
});

test("control characters and exotic whitespace make a command opaque", () => {
  assert.equal(hasUnsafeSyntax("ls\u00A0-la"), true);
  assert.equal(hasUnsafeSyntax("ls\u2028rm x"), true);
  assert.equal(hasUnsafeSyntax("ls\u0007"), true);
  assert.equal(hasUnsafeSyntax("ls\tsrc"), true);
  assert.equal(hasUnsafeSyntax("ls -la src"), false);
  assert.equal(isSafeCommand("ls\u00A0-la; rm x"), false);
  assert.equal(isSafeCommand("cat\u3000/etc/passwd"), false);
});

test("any shell operator or substitution disqualifies a command", () => {
  for (const command of [
    "ls | sh",
    "ls; rm -rf .",
    "ls & sleep 1",
    "ls && rm x",
    "ls || rm x",
    "cat a > b",
    "cat > file",
    "cat < a",
    "cat <<EOF\nrm x\nEOF",
    "echo `whoami`",
    "echo $(rm -rf .)",
    "echo ${HOME}",
    "ls\nrm x",
    "ls -la; rm x",
  ]) {
    assert.equal(isSafeCommand(command), false, `${command} should be rejected`);
  }
});

test("prefix derivation keeps the subcommand only for the broad command heads", () => {
  assert.equal(commandPrefix("git commit -m 'x'"), "git commit");
  assert.equal(commandPrefix("pnpm test --watch"), "pnpm test");
  assert.equal(commandPrefix("npm run build"), "npm run");
  assert.equal(commandPrefix("docker compose up"), "docker compose");
  assert.equal(commandPrefix("node --version"), "node --version");
  assert.equal(commandPrefix("rm -rf build"), "rm");
  assert.equal(commandPrefix("git"), "git");
  assert.equal(commandPrefix("   "), "");
});

test("a prefix rule matches only at a word boundary", () => {
  assert.equal(matchesPrefix("git commit", "git commit"), true);
  assert.equal(matchesPrefix("git commit -m 'x'", "git commit"), true);
  assert.equal(matchesPrefix("  git commit --amend", "git commit"), true);
  assert.equal(matchesPrefix("git commitx", "git commit"), false);
  assert.equal(matchesPrefix("git commit-tree", "git commit"), false);
  assert.equal(matchesPrefix("git push", "git commit"), false);
  assert.equal(matchesPrefix("rm -rf .", "rmdir"), false);
  assert.equal(matchesPrefix("anything", ""), false);
});

test("a prefix rule never covers a command that chains onto something else", () => {
  for (const command of [
    "pnpm test && rm -rf x",
    "pnpm test; rm -rf x",
    "pnpm test | sh",
    "pnpm test `id`",
    "pnpm test $(id)",
    "pnpm test ${EVIL}",
    "pnpm test > /etc/hosts",
    "pnpm test < /etc/passwd",
    "pnpm test\nrm -rf x",
    "pnpm test\u00A0&& rm x",
  ]) {
    assert.equal(matchesPrefix(command, "pnpm test"), false, `${command} should not match`);
  }
  // The plain forms still match.
  assert.equal(matchesPrefix("pnpm test --watch src", "pnpm test"), true);
});

test("a learned command rule does not leak across tools", () => {
  const jobStart: ToolDefinition = {
    name: "job_start",
    description: "start a background job",
    parameters: "command",
    mutates: true,
    execute: async () => "",
  };
  const policy = new ApprovalPolicy();
  const bashRule = ruleFor({ name: "bash", arguments: { command: "pnpm build" } }, bash);
  assert.ok(bashRule !== undefined);
  policy.learn(bashRule);

  assert.equal(policy.decide(bashCall("pnpm build"), bash), "allow");
  // The same command through the background job runner still asks.
  assert.equal(
    policy.decide({ name: "job_start", arguments: { command: "pnpm build" } }, jobStart),
    "ask",
  );

  const jobRule = ruleFor({ name: "job_start", arguments: { command: "pnpm dev --host" } }, jobStart);
  assert.deepEqual(jobRule, { kind: "command", tool: "job_start", prefix: "pnpm dev" });
  assert.equal(ruleLabel(jobRule), 'job_start "pnpm dev …"');
  policy.learn(jobRule);
  assert.equal(
    policy.decide({ name: "job_start", arguments: { command: "pnpm dev --host" } }, jobStart),
    "allow",
  );
  assert.equal(policy.decide(bashCall("pnpm dev --host"), bash), "ask");
});

test("decide auto-approves safe commands until the classifier is turned off", () => {
  const policy = new ApprovalPolicy();
  assert.equal(policy.decide(bashCall("git status"), bash), "allow");
  assert.equal(policy.decide(bashCall("git commit -m x"), bash), "ask");
  assert.equal(policy.decide({ name: "read", arguments: {} }, read), "allow");
  assert.equal(policy.decide({ name: "write", arguments: { path: "a" } }, write), "ask");

  policy.setAutoApproveSafeCommands(false);
  assert.equal(policy.decide(bashCall("git status"), bash), "ask");
  assert.equal(policy.rules().autoApproveSafeCommands, false);

  const off = new ApprovalPolicy({ autoApproveSafeCommands: false });
  assert.equal(off.decide(bashCall("ls"), bash), "ask");
});

test("learned rules allow later calls and clear together", () => {
  const policy = new ApprovalPolicy();
  policy.allowCommandPrefix("git commit");
  policy.allowTool("write");

  assert.equal(policy.decide(bashCall("git commit -m 'ship'"), bash), "allow");
  assert.equal(policy.decide(bashCall("git commitx"), bash), "ask");
  assert.equal(policy.decide(bashCall("git push"), bash), "ask");
  assert.equal(policy.decide({ name: "write", arguments: { path: "a" } }, write), "allow");
  assert.deepEqual(policy.rules().tools, ["write"]);
  assert.deepEqual(policy.rules().commandPrefixes, [{ tool: "bash", prefix: "git commit" }]);

  // Duplicates and whitespace noise collapse into one rule.
  policy.allowCommandPrefix("  git   commit ");
  assert.deepEqual(policy.rules().commandPrefixes, [{ tool: "bash", prefix: "git commit" }]);

  policy.clear();
  assert.equal(policy.decide(bashCall("git commit -m 'ship'"), bash), "ask");
  assert.deepEqual(policy.rules().tools, []);
});

test("an always-allow answer learns a command prefix for bash and a name otherwise", () => {
  const commandRule = ruleFor(bashCall("pnpm test --watch"), bash);
  assert.deepEqual(commandRule, { kind: "command", tool: "bash", prefix: "pnpm test" });
  assert.equal(ruleLabel(commandRule), 'bash "pnpm test …"');

  const toolRule = ruleFor({ name: "write", arguments: { path: "a" } }, write);
  assert.deepEqual(toolRule, { kind: "tool", name: "write" });
  assert.equal(ruleLabel(toolRule), "write");

  // A bash call with no usable command has no rule to learn at all: a tool-wide
  // "always allow bash" would grant every command the model can write.
  assert.equal(ruleFor({ name: "bash", arguments: {} }, bash), undefined);
  assert.equal(ruleFor(bashCall(""), bash), undefined);
  assert.equal(ruleFor(bashCall("   "), bash), undefined);
  assert.equal(ruleFor({ name: "bash", arguments: { command: 42 } }, bash), undefined);
  assert.equal(
    ruleFor(
      { name: "job_start", arguments: {} },
      { ...bash, name: "job_start" },
    ),
    undefined,
  );

  const policy = new ApprovalPolicy();
  assert.ok(commandRule !== undefined);
  policy.learn(commandRule);
  assert.equal(policy.decide(bashCall("pnpm test"), bash), "allow");
});

test("the permissions listing names every active rule", () => {
  const empty = formatRules(new ApprovalPolicy().rules());
  assert.match(empty, /Safe-command auto-approval: on/);
  assert.match(empty, /Always-allowed tools: none/);
  assert.match(empty, /Always-allowed commands: none/);

  const policy = new ApprovalPolicy({ autoApproveSafeCommands: false });
  policy.allowTool("write");
  policy.allowCommandPrefix("git commit");
  policy.allowCommandPrefix("pnpm dev", "job_start");
  const listed = formatRules(policy.rules());
  assert.match(listed, /Safe-command auto-approval: off/);
  assert.match(listed, /Always-allowed tools: write/);
  // Each command rule names the tool it was learned for.
  assert.match(listed, /Always-allowed commands: bash "git commit …", job_start "pnpm dev …"/);
});
