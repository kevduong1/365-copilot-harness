# M365 Copilot Browser Harness

An experimental TypeScript bridge that treats the Microsoft 365 Copilot chat website as a model backend. It provides:

- a `CopilotClient` library with streaming and non-streaming sends;
- a coding-agent loop with local repository tools;
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

Built-in tools are `read`, `grep`, `find`, `ls`, `edit`, `write`, and `bash`. File tools are restricted to the current working directory, including symlink resolution. `edit`, `write`, and `bash` require interactive approval by default.

Useful commands:

- `/tools` lists active tools.
- `/new` resets the browser conversation and reinjects the coding prompt on the next task.
- `/chat` switches to the raw browser-chat bridge.
- `/agent` returns to coding-agent mode.
- `/quit` exits.

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

## Library API

```ts
import { CopilotClient } from "./src/index.js";
import { CodingAgent } from "./src/index.js";

const client = await CopilotClient.launch();
try {
  const agent = new CodingAgent(client, { cwd: process.cwd(), readOnly: true });
  const answer = await agent.run("Inspect this repository and summarize its architecture");
  console.log(answer);
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
- Tool calls use a prompted text protocol rather than a native model API, so malformed calls are reported back to Copilot for correction and the loop is capped at 16 steps.
- Mutating tools can change repository files or run arbitrary workspace shell commands after approval. Review proposed arguments carefully and use `--read-only` for audits.
- Streaming is derived by polling and diffing rendered Markdown. If Copilot rewrites an earlier portion, the authoritative full response is emitted at completion.
- One Chrome profile supports one in-flight request. There is intentionally no parallel browser execution.
- Headful Chrome is the default because it is generally less brittle. Automation may be restricted by Microsoft policy or your organization's terms; confirm that your use is permitted.
