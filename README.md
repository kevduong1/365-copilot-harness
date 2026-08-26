# M365 Copilot Browser Harness

An experimental TypeScript bridge that treats the Microsoft 365 Copilot chat website as a model backend. It provides:

- a `CopilotClient` library with streaming and non-streaming sends;
- an interactive terminal REPL; and
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

## Interactive REPL

```sh
pnpm cli
```

Enter a prompt to stream a response. `/new` starts a clean Copilot conversation, and `/quit` exits. Multi-line content sent through the library or HTTP server is inserted without typing it character by character.

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

const client = await CopilotClient.launch();
try {
  for await (const delta of client.send("Reply with exactly PONG")) {
    process.stdout.write(delta);
  }
  await client.newChat();
  const answer = await client.sendAndWait("Hello");
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
| `RESPONSE_TIMEOUT_MS` | `300000` | Overall response deadline |
| `STABILITY_DEBOUNCE_MS` | `1500` | Required DOM quiet time after generation stops |
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
- This MVP has no tool-calling protocol and returns prose/Markdown only.
- Streaming is derived by polling and diffing rendered Markdown. If Copilot rewrites an earlier portion, the authoritative full response is emitted at completion.
- One Chrome profile supports one in-flight request. There is intentionally no parallel browser execution.
- Headful Chrome is the default because it is generally less brittle. Automation may be restricted by Microsoft policy or your organization's terms; confirm that your use is permitted.
