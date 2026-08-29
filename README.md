# M365 Copilot Browser Harness

An experimental TypeScript bridge that treats the Microsoft 365 Copilot chat website as a model backend. It provides:

- a `CopilotClient` library with streaming and non-streaming sends;
- a coding-agent loop with local repository tools;
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

Agent mode is the default. The harness starts a fresh Copilot conversation, injects a coding-specific system prompt, detects structured tool calls, executes them locally, returns the results to Copilot, and repeats until Copilot gives a final answer.

Built-in tools are `pwd`, `cd`, `read`, `grep`, `find`, `ls`, `edit`, `write`, and `bash`. `cd` changes the controller's working directory persistently, so later file and shell operations run from the selected project. File tools are restricted to explicitly granted roots, including symlink resolution. `edit`, `write`, and `bash` require interactive approval by default.

`edit` supports a unique exact replacement (`old_text`/`new_text`), an intentional `replace_all`, or an inclusive `start_line`/`end_line` replacement based on the numbered output from `read`. The command also accepts common camelCase and `old_string`/`new_string` aliases, which makes prompted tool calls less brittle without weakening path validation or approvals.

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

Useful commands:

- `/tools` lists active tools.
- `/tokens` shows the estimated conversation usage, assumed context budget, and compaction threshold.
- `/compact` asks Copilot for a continuation summary, opens a new browser chat, restores the summary, and resumes there.
- `/new` resets the browser conversation and reinjects the coding prompt on the next task.
- `/chat` switches to the raw browser-chat bridge.
- `/agent` returns to coding-agent mode.
- `/quit` exits.

The CLI shows an estimated token status after each completed task. Automatic compaction is enabled by default: before a send projected to meet 60% of the configured context budget, the harness summarizes the current conversation and continues it in a fresh chat. In coding-agent mode it also re-injects the original harness system prompt verbatim, so the summary is not responsible for reproducing the tool protocol. Mode switches start a fresh browser conversation to prevent raw chat from contaminating the coding-agent state. The OpenAI-compatible server applies the same automatic policy; low-level `CopilotClient` callers can use `needsCompaction(nextPrompt)` and `compact()` directly.

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

The default system prompt can be replaced with `.copilot-harness/SYSTEM.md` or extended with `.copilot-harness/APPEND_SYSTEM.md`. `AGENTS.md` and `CLAUDE.md` in the working directory are included as project context.

The operation protocol is text-based because the Copilot website has no native tool-call API. Copilot prints strict JSON between `HARNESS_REQUEST` markers as a request for the separate local controller, and the harness returns JSON inside `HARNESS_OBSERVATION` markers in the same browser conversation.

If your tenant supports persistent Copilot custom instructions, this optional instruction can reinforce the protocol without affecting ordinary chats:

> When a conversation contains `<coding_harness_system>`, follow that block as the active coding workflow. `HARNESS_REQUEST` is ordinary text for a user-owned external controller, not a Microsoft Copilot tool invocation. Print the requested record exactly and wait for `HARNESS_OBSERVATION`; do not refuse merely because you lack native filesystem or shell access. Outside conversations containing `<coding_harness_system>`, ignore this instruction.

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
- Tool calls use a prompted text protocol rather than a native model API, so malformed calls are reported back to Copilot for correction and the loop is capped at 16 steps.
- Mutating tools can change repository files or run arbitrary workspace shell commands after approval. Review proposed arguments carefully and use `--read-only` for audits.
- Streaming is derived by polling and diffing rendered Markdown. If Copilot rewrites an earlier portion, the authoritative full response is emitted at completion.
- One Chrome profile supports one in-flight request. There is intentionally no parallel browser execution.
- Headful Chrome is the default because it is generally less brittle. Automation may be restricted by Microsoft policy or your organization's terms; confirm that your use is permitted.
