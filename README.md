# M365 Copilot Browser Harness

An experimental TypeScript bridge that treats the Microsoft 365 Copilot chat website as a model backend. It provides:

- a `CopilotClient` library with streaming and non-streaming sends;
- a coding-agent loop with local repository tools;
- on-demand Agent Skills in the same `SKILL.md` layout GitHub Copilot uses;
- subagent orchestration: the agent delegates tasks to fresh Copilot conversations in separate browser tabs while the CLI tracks their state;
- estimated conversation-token accounting and automatic context compaction;
- an interactive agent/chat terminal; and
- an OpenAI-compatible `/v1/chat/completions` HTTP shim.

It drives your installed Google Chrome through Playwright. Microsoft credentials stay in a local persistent browser profile; the project does not accept or store a password itself.

## Requirements

- Node.js 24 or newer
- pnpm
- Google Chrome
- an account with access to Microsoft 365 Copilot chat

Install dependencies:

```sh
pnpm install
```

## First login

```sh
pnpm cli login
```

A visible Chrome window opens. Complete SSO and MFA manually. When the Copilot chat input is visible, the command confirms login and closes Chrome. That close is expected. Session data is retained under `.data/profile/`, with an explicit cookie snapshot in `.data/storage-state.json`; both are ignored by Git and should be treated as credentials.

Normal commands fail with a clear error if the saved session is no longer authenticated. Run `pnpm cli login` again to refresh it.

## Coding agent CLI

```sh
pnpm cli
```

Interactive mode is a fullscreen TUI with an original Waypoint navigation theme: a responsive triangle-and-compass mark, matte neutral-black surfaces, a blue interaction hierarchy, conversation scrollback, a rounded composer, slash-command and `@` file menus, permission cards, and a tasks pane for subagents. Unicode-capable terminals get the full visual treatment, while limited terminals use compact ASCII marks and `NO_COLOR` is respected. Set `TUI_TRANSPARENT=1` to keep the terminal's configured background instead of painting the matte base. It drives the existing Copilot browser backend; `--print` still runs headlessly.

Agent mode is the default. The harness starts a fresh Copilot conversation, injects a coding-specific system prompt, detects structured tool calls, executes them locally, returns the results to Copilot, and repeats until Copilot gives a final answer.

Built-in tools are `pwd`, `cd`, `read`, `grep`, `find`, `ls`, `edit`, `patch`, `write`, `bash`, the background job operations `job_start`, `job_output`, `job_wait`, `job_kill`, and `job_list`, `skill` (on-demand skills, described below), and `agent` (subagent delegation, described below). `cd` changes the controller's working directory persistently, so later file and shell operations run from the selected project. File tools are restricted to explicitly granted roots, including symlink resolution. `edit`, `patch`, `write`, `bash`, `job_start`, and `job_kill` require interactive approval by default, subject to the permission rules described below.

`edit` supports a unique exact replacement (`old_text`/`new_text`), an intentional `replace_all`, or an inclusive `start_line`/`end_line` replacement based on the numbered output from `read`. The command also accepts common camelCase and `old_string`/`new_string` aliases, which makes prompted tool calls less brittle without weakening path validation or approvals. When `old_text` does not match exactly, `edit` retries ignoring trailing whitespace and then ignoring indentation (as long as the match stays unique), re-indents the replacement to match the file, preserves CRLF line endings, and returns a numbered snippet of the changed region so the model can verify without another read.

`patch` applies a unified diff across one or more files in a single round trip. Hunks are matched by their context rather than by `@@` line numbers, trailing whitespace is ignored, `/dev/null` creates or deletes files, and the whole diff is rejected before anything is written if any hunk fails to match. Because every tool call is a slow browser round trip, the system prompt steers Copilot toward `patch` for changes that span several places.

### Terminal capabilities

`bash` runs commands through your login shell (`$SHELL`, falling back to `/bin/zsh` or `/bin/bash`) with `NO_COLOR`, `TERM=dumb`, and pagers disabled, and strips ANSI escapes from the output. It accepts `stdin` and a `cwd` inside a granted root. A command that hits its timeout, or is cancelled from the TUI, no longer loses its output: the observation reports `exit_code: timeout` or `exit_code: aborted` together with everything captured so far.

Long output is trimmed head and tail rather than head only, so the end of a failing test run survives. The cap is `TOOL_OUTPUT_MAX_CHARS` (default 24,000 characters, sized for Copilot's small context window). The complete text of the last 20 trimmed outputs is retained in memory and referenced as `harness://output/<id>`; `read` accepts that path with `offset` and `limit`, so the model can page through the full output without the controller writing files.

Long-lived processes run as background jobs. `job_start` launches a dev server, watcher, or slow test suite in its own process group and returns immediately; `job_output` returns the status and any output since the previous read; `job_wait` blocks until exit or a timeout; `job_kill` stops the process group; `job_list` shows every job. Output is kept in a bounded buffer per job, and all jobs are killed when the CLI exits.

`grep` and `find` use ripgrep when it is installed and otherwise fall back to a built-in walker that skips `.git`, `node_modules`, and root `.gitignore` entries, with the same `file:line:col:text` output. `grep` also accepts `ignore_case`, `fixed_strings`, `context`, and `files_only`. `read` rejects binary files, refuses files above 50 MB, and truncates individual lines longer than 2,000 characters.

### Permissions

The permission card offers three answers: allow once, decline, or always allow. "Always allow" learns a session rule: for `bash` and `job_start` it is a command prefix such as `git commit` or `pnpm test` (the first word, plus the subcommand for `git`, `pnpm`, `npm`, `yarn`, `cargo`, `go`, `docker`, `make`, and `node`), scoped to the tool that learned it, and for other tools it is the tool name. Prefix rules match only at word boundaries and only for commands with no shell operators, so `git commit` never covers `git commitx` or `git commit && rm -rf x`. A shell call with a blank command never offers an always-allow option.

A conservative built-in classifier auto-approves read-only shell commands: a single command with no pipes, redirects, chaining, substitutions, environment assignments, or control characters, whose first word is in a small allowlist (`ls`, `cat`, `head`, `tail`, `wc`, `echo`, `which`, `whoami`, `printenv`, `stat`, `grep`, `git status`, `git log`, `git diff`, `git show`, `git branch`, `git rev-parse`, `git remote`, and version or listing flags for `node`, `pnpm`, and `npm`). Arguments are checked too: flags that write or execute, such as `--output`, `-o`, `--ext-diff`, `-c`, `-exec`, or `-delete`, and mutating forms of `git branch` or `git remote` are never auto-approved, and commands that can run other programs (`env`, `find`, `rg`) are deliberately absent. Pass `--no-safe-auto` to ask for those too. `/permissions` prints the active rules, `/permissions clear` forgets session rules, and `/permissions safe on|off` toggles the classifier. Print mode applies the same policy: without `--yes` only safe commands run.

The harness protocol is also more forgiving. Requests wrapped in Markdown code fences, `args`/`params`/`input` in place of `arguments`, missing argument objects, trailing commas, smart quotes, and raw newlines inside JSON strings are all repaired before a protocol error is reported, and a JSON array of requests runs each in order. Observations echo only a compact summary of each call's arguments, so a large `write` or `patch` no longer costs its payload twice.

Start directly in another repository:

```sh
pnpm cli --cwd /Users/kevin/repos/ai/.talos-worktrees/atc-gan/test
```

To let one session move between this repository and other projects, grant one or more additional roots. The coding agent can then call `cd` itself:

```sh
pnpm cli --add-dir /Users/kevin/repos/ai
pnpm cli --add-dir /Users/kevin/repos/ai --add-dir /Users/kevin/repos/another-project
```

An additional grant includes its descendants. Without `--add-dir`, attempts to read paths outside `--cwd` (or the launch directory) remain blocked. Prefer granting the narrowest directory that covers the task.

Useful commands inside the TUI:

- Type `/` for the command menu. `/tools` lists active tools. `/skills` lists discovered skills, and `/skill <name> [request]` asks the agent to apply one.
- Start a line with `!` to run a shell command locally in the agent's current working directory. The output appears in the scrollback and is never sent to Copilot.
- `/permissions` (alias `/rules`) shows the session's approval rules; `/permissions clear` and `/permissions safe on|off` adjust them.
- `/agents` or `Ctrl+G` lists every subagent spawned this session with its status, steps, estimated tokens, and whether its tab is still open.
- `/context` (alias `/tokens`) shows the estimated conversation usage, assumed context budget, and compaction threshold.
- `/compact` asks Copilot for a continuation summary, opens a new browser chat, restores the summary, and resumes there.
- `/new` (or `Ctrl+N` twice) resets the browser conversation and reinjects the coding prompt on the next task.
- `/chat` switches to the raw browser-chat bridge. `/agent` returns to coding-agent mode. `Shift+Tab` cycles agent / always-approve / chat.
- Mutating tools open a permission card (`1` allow once, `2` decline, `3` always allow this rule). `Ctrl+O` or `/always-approve` skips those prompts entirely. `Esc` cancels a running turn, aborting the current shell command and any running subagents.
- `Ctrl+P` or `?` opens the command palette. `Ctrl+X` shows keyboard shortcuts. `/quit` or `Ctrl+Q` twice exits.

The CLI shows an estimated token chip in the TUI status bar after each completed task. Automatic compaction is enabled by default: before a send projected to meet 60% of the configured context budget, the harness summarizes the current conversation and continues it in a fresh chat. In coding-agent mode it also re-injects the original harness system prompt verbatim, so the summary is not responsible for reproducing the tool protocol. Mode switches start a fresh browser conversation to prevent raw chat from contaminating the coding-agent state. The OpenAI-compatible server applies the same automatic policy; low-level `CopilotClient` callers can use `needsCompaction(nextPrompt)` and `compact()` directly.

Microsoft does not expose the selected model's tokenizer, the hidden prompt overhead, or a stable M365 Copilot Chat context-window size. The counter is therefore a conservative local estimate, not Microsoft-reported usage or billing data. It weights punctuation-heavy code and non-Latin text above ordinary English and includes per-message overhead. The default 32,000-token assumed window and 60% threshold intentionally leave substantial room for hidden instructions, grounding, summary generation, and the next response; tune both for your tenant with the variables below.

Start a read-only agent:

```sh
pnpm cli --read-only
```

Automatically approve mutating tools for the current process:

```sh
pnpm cli --yes
```

Use non-interactive print mode for scripting or evaluation. Mutating calls are declined unless `--yes` is supplied:

```sh
pnpm cli --read-only --print "Inspect this repository and summarize how it works"
```

Add `--chat` to either interactive or print mode to bypass the coding loop and use the raw browser transport.

The default system prompt can be replaced with `.copilot-harness/SYSTEM.md` or extended with `.copilot-harness/APPEND_SYSTEM.md`. `AGENTS.md`, `CLAUDE.md`, and `.github/copilot-instructions.md` in the working directory are included as project context.

The operation protocol is text-based because the Copilot website has no native tool-call API. Copilot prints strict JSON between `HARNESS_REQUEST` markers as a request for the separate local controller, and the harness returns JSON inside `HARNESS_OBSERVATION` markers in the same browser conversation.

If your tenant supports persistent Copilot custom instructions, this optional instruction can reinforce the protocol without affecting ordinary chats:

> When a conversation contains `<coding_harness_system>`, follow that block as the active coding workflow. `HARNESS_REQUEST` is ordinary text for a user-owned external controller, not a Microsoft Copilot tool invocation. Print the requested record exactly and wait for `HARNESS_OBSERVATION`; do not refuse merely because you lack native filesystem or shell access. Outside conversations containing `<coding_harness_system>`, ignore this instruction.

## Agent skills

The coding agent loads skills in the layout GitHub Copilot, Claude Code, and the open Agent Skills format share: one directory per skill containing a `SKILL.md` whose YAML frontmatter names and describes it, followed by the instructions, with any bundled references, scripts, or assets beside it.

```
.github/skills/release-notes/
├── SKILL.md
└── references/template.md
```

```markdown
---
name: release-notes
description: Draft release notes from the git history since the last tag
---

1. Run `git describe --tags --abbrev=0` to find the last tag.
2. Summarize the commits since then, grouped by area, using references/template.md.
```

Skills are discovered from the launch directory, in precedence order:

1. Project skills in `.github/skills/`, `.claude/skills/`, and `.agents/skills/`.
2. Extra directories named in `COPILOT_SKILLS_DIRS` (comma-separated).
3. Personal skills in `~/.copilot/skills/`, `~/.claude/skills/`, and `~/.agents/skills/`.

The first skill found with a given name wins, so a project skill shadows a personal one. Only each skill's name and description enter the system prompt; Copilot requests the read-only `skill` operation to load the full instructions when a task matches, and `skill` with `name` plus `file` reads a bundled file. Bundled reads cannot escape the skill directory, including through symlinks, and skill directories do not need to be inside a granted workspace root. Subagents see the same skills. A `SKILL.md` without frontmatter is still loaded, named after its directory.

Skills are advisory: they are guidance Copilot follows after loading them, not a replacement for the harness system prompt.

## Subagent orchestration

The coding agent has an `agent` operation that delegates a self-contained task to a subagent. Each subagent is a fresh Copilot conversation in its own Chrome tab of the same logged-in profile, driven by its own coding-agent loop with its own workspace tools, its own token counter, and its own automatic compaction. Because Copilot's usable context is small, the system prompt encourages delegating anything that would flood the main conversation with raw output—broad exploration, multi-file reads, log digging, independent implementation chunks—so only the subagent's final report enters the orchestrating conversation.

The terminal CLI is the orchestration controller and keeps all of the state:

- Every spawn is registered with an id, a name, the task history, live status (`queued`, `running`, `completed`, `failed`), step count, and estimated token usage. `/agents` prints the registry; records survive tab closure.
- Subagent activity streams to the terminal prefixed with its id, e.g. `[agent#2 tool] grep "login"`, alongside `[agent#2] started/completed/failed` lifecycle lines.
- Several `agent` requests printed in one response run in parallel, bounded by `SUBAGENT_MAX_CONCURRENT`. Chrome is launched with background-throttling disabled so hidden tabs keep streaming.
- A finished subagent's tab stays open for follow-up tasks (the model passes `agent_id`), reusing the context it already built. Beyond `SUBAGENT_MAX_IDLE_TABS`, the stalest idle tab is closed automatically.
- Approvals still flow through the CLI: subagents inherit `--read-only` and the interactive approval prompt (or `--yes`), and concurrent approval requests are serialized so prompts never interleave.

Subagents get a role preamble instructing them to return a self-contained report and cannot delegate further; orchestration depth is one. Each subagent has an independent working directory, so a `cd` inside a subagent never moves the main agent.

Library use:

```ts
import { CodingAgent, SubagentManager, createOrchestratorTools } from "./src/index.js";

const manager = new SubagentManager({ openSession: () => client.newTabSession(), cwd: process.cwd() });
const agent = new CodingAgent(client, {
  tools: await createOrchestratorTools(manager, process.cwd()),
});
```

## OpenAI-compatible server

```sh
pnpm server
```

The server listens only on `127.0.0.1:8787`. It exposes `GET /v1/models` and `POST /v1/chat/completions`.

Non-streaming example:

```sh
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"copilot-browser","messages":[{"role":"user","content":"Reply with exactly PONG"}]}'
```

Streaming example:

```sh
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"Write one sentence"}],"stream":true}'
```

Requests are serialized because one browser tab represents one conversation. The server sends only the newest user message and lets the browser retain context. It starts a new browser conversation when request history diverges from the preceding request. Send `X-New-Chat: true` to force a reset. A changed system message is prepended to the next user prompt.

The server uses the same local estimator for its OpenAI-shaped `usage` fields and automatically compacts an extending browser conversation at the configured threshold. If a send or compaction leaves browser state ambiguous, the next request is forced into a clean chat.

## Library API

```ts
import { CopilotClient } from "./src/index.js";
import { CodingAgent } from "./src/index.js";

const client = await CopilotClient.launch();
try {
  const agent = new CodingAgent(client, {
    cwd: process.cwd(),
    allowedRoots: ["/Users/kevin/repos/ai"],
    readOnly: true,
  });
  const answer = await agent.run("Inspect this repository and summarize its architecture");
  console.log(answer);
  console.log(client.getTokenUsage());
  await agent.compact(); // summarize, open a new browser chat, and restore coding context
} finally {
  await client.close();
}
```

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `COPILOT_URL` | `https://m365.cloud.microsoft/chat` | Chat page to open |
| `PROFILE_DIR` | `.data/profile` | Persistent Chrome user-data directory |
| `SESSION_STATE_PATH` | `.data/storage-state.json` | Cookie snapshot used across Chrome restarts |
| `HEADLESS` | unset | Set to `1` to experiment with headless Chrome |
| `NEW_CHAT_SETTLE_MS` | `3000` | Delay after opening a new chat before filling its composer |
| `PROMPT_SETTLE_MS` | `750` | Delay after filling the rich-text composer before clicking Send |
| `RESPONSE_TIMEOUT_MS` | `300000` | Overall response deadline |
| `STABILITY_DEBOUNCE_MS` | `1500` | Required DOM quiet time after generation stops |
| `COMPLETION_FALLBACK_MS` | `10000` | DOM-idle fallback when M365 exposes no completion control |
| `POLL_INTERVAL_MS` | `250` | Streaming DOM poll cadence |
| `CONTEXT_WINDOW_TOKENS` | `32000` | Assumed context budget used only for local estimates and compaction decisions |
| `AUTO_COMPACT` | `true` | Set to `0` or `false` to disable threshold-triggered compaction |
| `AUTO_COMPACT_PERCENT` | `60` | Percentage of the assumed context budget that triggers compaction before the next send |
| `COMPACTION_SUMMARY_TOKENS` | `4000` | Requested maximum size of a generated continuation summary |
| `SUBAGENT_MAX_CONCURRENT` | `2` | Subagent conversations allowed to generate at the same time |
| `SUBAGENT_MAX_IDLE_TABS` | `2` | Finished subagent tabs kept open for follow-ups before the stalest is closed |
| `SUBAGENT_MAX_STEPS` | `16` | Tool-loop step limit inside one subagent task |
| `TOOL_OUTPUT_MAX_CHARS` | `24000` | Head-plus-tail cap on any single tool output; the full text stays readable at `harness://output/<id>` |
| `TUI_TRANSPARENT` | unset | Set to `1` to preserve the terminal's default background behind base TUI cells |
| `PORT` | `8787` | HTTP server port |

## Selector discovery

Copilot's DOM is not a stable API. All target-specific locators live in `src/selectors.ts`. After logging in, run:

```sh
pnpm spike
pnpm spike --send "Reply with exactly PONG"
```

The command temporarily fills the composer with an unsubmitted probe so state-dependent controls such as Send are rendered. It then lists candidate controls, writes `.data/aria-snapshot.yml`, captures `spike.png`, and clears the probe. With `--send`, it subsequently exercises a streaming round trip. Use those artifacts to refine `src/selectors.ts` when Microsoft changes the UI.

## Development checks

```sh
pnpm typecheck
pnpm test
```

## Known limits

- Browser selectors can drift without notice and must be calibrated against a live authenticated tenant.
- Copilot prompt limits are much smaller than API context windows. A rejected or truncated prompt raises `PromptTooLargeError`.
- Token counts and compaction thresholds are estimates because M365 does not expose its tokenizer, model choice, hidden context, or usage. Existing messages already open in the browser before the harness starts are not counted.
- Compaction is lossy by nature. The prompt emphasizes goals, decisions, exact state, completed work, pending steps, and protocols, but critical information should still live in the repository or another durable artifact.
- Tool calls use a prompted text protocol rather than a native model API. Common formatting mistakes are repaired automatically; anything else is reported back to Copilot for correction, and the loop is capped at 16 steps.
- Mutating tools can change repository files or run arbitrary workspace shell commands after approval. Review proposed arguments carefully, prefer narrow "always allow" rules, and use `--read-only` for audits. The safe-command classifier is deliberately small; it never auto-approves commands with shell operators.
- Streaming is derived by polling and diffing rendered Markdown. If Copilot rewrites an earlier portion, the authoritative full response is emitted at completion.
- Each tab is one conversation with one in-flight request. Parallelism comes only from subagent tabs, is bounded by `SUBAGENT_MAX_CONCURRENT`, and shares a single Microsoft account, so concurrent generations may hit tenant rate limits; lower the limit to `1` to serialize subagents.
- Headful Chrome is the default because it is generally less brittle. Automation may be restricted by Microsoft policy or your organization's terms; confirm that your use is permitted.
