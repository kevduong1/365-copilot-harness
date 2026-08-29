# M365 Copilot Browser Harness — Phase 1 MVP Plan

> Historical design document. The implementation now includes the coding-agent phase, token estimation, and context compaction; see `README.md` for current behavior and configuration.

## Context

Goal: build a coding/agentic harness (Hermes/pi-style) whose "model backend" is not an API but the **M365 Copilot chat web UI**, driven by browser automation. Prompts are typed into the chat input, responses are scraped from the DOM.

Phase 1 is **only the browser bridge**: a clean `send(prompt) → response` primitive plus an interactive REPL and an OpenAI-compatible HTTP shim. A later phase can fork the pi coding harness (or similar) and point it at this as if it were a model provider.

## Stack decision: TypeScript + Playwright (Rust considered, rejected)

- Playwright has no official Rust bindings; the Rust options (`chromiumoxide`, `headless_chrome`, `thirtyfour`) are raw-CDP/WebDriver level — no auto-waiting locators, no codegen, weak docs. Scraping a dynamic React SPA like Copilot is exactly where Playwright's locator engine earns its keep.
- Performance is irrelevant here: every round-trip is dominated by Copilot generating a response (seconds to minutes). The driver is never the bottleneck.
- pi (the likely phase-2 fork target) is TypeScript, so a TS library embeds directly.

Stack: **Node 24, pnpm, TypeScript (strict, ESM), Playwright (chromium/chrome channel), Hono (HTTP shim), turndown (HTML→markdown), tsx (runner)**.

## Repo layout

Single package for the MVP (split into workspace packages later if needed):

```
365-copilot-harness/
  package.json            # scripts: cli, server, spike, typecheck
  tsconfig.json           # strict, ESM, NodeNext
  .gitignore              # .data/, node_modules/, dist/
  src/
    config.ts             # URLs, timeouts, profile dir, env overrides
    browser.ts            # launchPersistentContext, login helper
    adapter.ts            # ChatAdapter interface (target-agnostic)
    copilot.ts            # M365CopilotAdapter: send/scrape logic
    selectors.ts          # ALL Copilot DOM selectors in one place
    extract.ts            # DOM HTML → markdown (turndown, code blocks)
    queue.ts              # single-flight mutex
    client.ts             # CopilotClient: browser + adapter + queue composed
    cli.ts                # interactive REPL + `login` subcommand
    server.ts             # OpenAI-compatible /v1/chat/completions
    spike.ts              # throwaway selector-discovery script
    index.ts              # library entry: exports CopilotClient, ChatAdapter
  .data/profile/          # persistent Chromium user-data-dir (gitignored)
  README.md
```

---

## Implementation details

### 1. Config (`src/config.ts`)

```ts
export const config = {
  copilotUrl: process.env.COPILOT_URL ?? "https://m365.cloud.microsoft/chat",
  loginUrlPattern: /login\.microsoftonline\.com|login\.live\.com/,
  profileDir: process.env.PROFILE_DIR ?? ".data/profile",
  headless: process.env.HEADLESS === "1",         // default headful
  responseTimeoutMs: Number(process.env.RESPONSE_TIMEOUT_MS ?? 300_000),
  stabilityDebounceMs: 1_500,   // response considered done after this much DOM quiet
  pollIntervalMs: 250,          // streaming poll cadence
  serverPort: Number(process.env.PORT ?? 8787),
};
```

### 2. Browser session (`src/browser.ts`)

- `openSession(): Promise<{ context: BrowserContext; page: Page }>` using
  `chromium.launchPersistentContext(config.profileDir, { headless, channel: "chrome", viewport: null, args: ["--disable-blink-features=AutomationControlled"] })`.
  Persistent profile = manual Microsoft SSO/MFA once, cookies survive restarts.
- `ensureLoggedIn(page)`: navigate to `copilotUrl`, wait for either the chat input (success) or a URL matching `loginUrlPattern` (needs login). If login needed and running under `cli login`, print instructions and **wait indefinitely** for the chat input to appear (user completes SSO by hand); otherwise throw a clear `NotLoggedInError("run: pnpm cli login")`.
- Headful is the default even in normal operation — more robust against bot detection; `HEADLESS=1` exists as an experiment flag.
- Graceful shutdown: close context on SIGINT so the profile isn't corrupted.

### 3. Adapter interface (`src/adapter.ts`)

Keeps the harness target-agnostic (Copilot today, anything later):

```ts
export interface ChatAdapter {
  ensureReady(): Promise<void>;                    // navigated, logged in, input visible
  newChat(): Promise<void>;                        // fresh conversation
  send(prompt: string): AsyncIterable<string>;     // streamed markdown deltas
  sendAndWait(prompt: string): Promise<string>;    // full final markdown
}
```

### 4. Selectors (`src/selectors.ts`)

Every DOM touchpoint lives here — the single file to fix when Microsoft ships a redesign. Prefer role/ARIA locators over class names:

```ts
export const sel = {
  chatInput: (page: Page) => page.getByRole("textbox").last(),      // refine in spike
  sendButton: (page: Page) => page.getByRole("button", { name: /send/i }),
  stopButton: (page: Page) => page.getByRole("button", { name: /stop/i }),
  newChatButton: (page: Page) => page.getByRole("button", { name: /new chat/i }),
  assistantMessages: (page: Page) => page.locator('[data-testid*="message"]'), // refine in spike
};
```

> These are best guesses. Milestone 3 (selector spike) replaces them with verified locators from the live, logged-in UI.

### 5. Copilot adapter (`src/copilot.ts`) — the core of the project

**Sending a prompt:**
1. `ensureReady()` — page on copilot URL, input visible.
2. Record `before = await assistantMessages.count()`.
3. Insert the prompt. Do **not** `type()` char-by-char (agentic prompts are large):
   - Try `locator.fill(prompt)` on the contenteditable first.
   - Fallback: clipboard injection — `page.evaluate(t => navigator.clipboard.writeText(t), prompt)` then focus input + `Meta/Control+V`.
   - Normalize newlines: Copilot treats Enter as submit, so paste (not keystrokes) is what preserves multi-line prompts.
4. Submit via Enter (or click send button if Enter proves unreliable).

**Detecting the response (the hard part) — two-signal approach:**
1. *Started*: wait until `assistantMessages.count() > before` (a new assistant node exists).
2. *Finished*: primary signal = stop-generating button disappears / send button re-enables. Then apply a **stability debounce**: poll the last assistant node's `innerHTML`; done when unchanged for `stabilityDebounceMs` (Copilot appends citations/formatting after streaming ends). Overall deadline: `responseTimeoutMs`.

**Streaming (`send`)**: poll the growing last-message node every `pollIntervalMs`, extract text, diff against the previous snapshot, `yield` the suffix delta. Naive prefix-diff is fine for MVP (if the node's text is rewritten rather than appended, fall back to yielding the full text once at the end). No MutationObserver plumbing needed initially.

**`sendAndWait`**: drain `send()`, but return the final markdown from `extract.ts` (not the concatenated deltas) so formatting is authoritative.

**`newChat()`**: click new-chat button, wait for empty message list + input focused.

**Error handling**: one retry on send failure (re-focus input, re-paste); timeout throws `ResponseTimeoutError` carrying whatever partial text was scraped.

### 6. Extraction (`src/extract.ts`)

`innerText` mangles code — unacceptable for a coding harness. Instead:
- Take the completed assistant node's `innerHTML`.
- Convert with **turndown**, with custom rules:
  - `<pre>`/`<code>` blocks → fenced code blocks, preserving the language hint if Copilot exposes one (class or header label on the block).
  - Strip citation superscripts / reference chips to plain text or drop them.
  - Tables → GFM tables (turndown-plugin-gfm).

### 7. Single-flight queue (`src/queue.ts`)

One browser = one conversation = one in-flight prompt. A minimal promise mutex:

```ts
export class Mutex {
  private tail = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> { /* chain onto tail */ }
}
```

Concurrent HTTP requests queue; no parallelism in phase 1 by design.

### 8. Client (`src/client.ts` + `src/index.ts`)

`CopilotClient` composes browser + adapter + mutex and is the library surface phase 2 embeds:

```ts
const client = await CopilotClient.launch();     // opens browser, ensures login
for await (const delta of client.send("...")) process.stdout.write(delta);
await client.newChat();
await client.close();
```

### 9. CLI REPL (`src/cli.ts`)

Primary dev/debug tool. `pnpm cli`:
- Subcommand `login`: headful launch, navigate, wait for manual SSO, confirm, exit.
- Default: readline REPL — type a prompt, deltas stream to stdout; commands `/new`, `/quit`.

### 10. OpenAI-compatible shim (`src/server.ts`)

`pnpm server` → Hono on `localhost:8787`:
- `POST /v1/chat/completions` accepting `{ model?, messages, stream? }`.
- **Message mapping**: send the last `user` message to the browser. If a `system` message is present and differs from the previously seen one, prepend it to the prompt text. Conversation continuity lives browser-side:
  - `X-New-Chat: true` header forces `newChat()`.
  - Heuristic: if the request's message history does not extend the previous request's history, call `newChat()` first.
- `stream: true` → SSE in OpenAI delta format (`data: {"choices":[{"delta":{"content":"..."}}]}` … `data: [DONE]`); `stream: false` → single completion JSON. Fabricate `id`/`usage` fields (usage = rough char/4 estimate).
- `GET /v1/models` returning one fake model (`copilot-browser`) so off-the-shelf clients don't choke.
- All requests serialized through the mutex.

This makes phase 2 trivial: point any harness's OpenAI base URL at `http://localhost:8787/v1`.

### 11. Selector spike (`src/spike.ts`)

Throwaway discovery script, run logged-in: dumps the accessibility tree (`page.accessibility.snapshot()` / ARIA snapshot), lists candidate textboxes/buttons, and screenshots the chat surface. Optionally sends a test prompt while logging DOM mutations on the message container. Output feeds directly into `selectors.ts`. *(The real selectors cannot be known until we're inside the live, authenticated UI — this step is where guesses become facts.)*

---

## Milestones (build order)

1. **Scaffold** — pnpm init, TS strict ESM, Playwright + chrome channel installed, `.gitignore`, scripts (`cli`, `server`, `spike`, `typecheck`) wired via tsx.
2. **Session + login** — persistent context launches; `pnpm cli login` completes manual SSO; relaunch is already authenticated.
3. **Selector spike** — run `spike.ts` against the live UI; land verified locators in `selectors.ts`.
4. **Round-trip** — `sendAndWait("Reply with exactly: PONG")` returns `PONG`.
5. **Streaming + extraction hardening** — delta polling, turndown code-block fidelity, stability debounce, timeouts, retry.
6. **CLI REPL** on top of `CopilotClient`.
7. **HTTP shim** with SSE; verified with `curl`.
8. **README** — setup, login flow, env vars, known limits.

## Risks / known limits (documented, accepted for MVP)

- **Selector drift**: Copilot's DOM changes without notice — hence everything centralized in `selectors.ts`, role/ARIA locators preferred.
- **Prompt size limits**: Copilot's input caps characters far below API context windows; agentic harnesses send huge prompts. Phase 1 surfaces a clear `PromptTooLargeError`; phase 2 needs prompt budgeting/summarization.
- **No tool-calling protocol**: Copilot returns prose/markdown only. Phase 2 must have the harness instruct Copilot to emit parseable fenced blocks for tool calls. Out of scope now.
- **Rate limiting / bot detection**: headful + human-paced interaction mitigates; not solvable if Microsoft blocks automation. Automating a work account may sit outside M365 ToS — user's call.
- **Single concurrency** by design (one browser, one chat).

## Verification

- `pnpm cli login` → complete SSO manually → relaunch `pnpm cli` → no login redirect.
- REPL: `Reply with exactly the word PONG` → streamed output prints `PONG`.
- Code fidelity: ask for a Python fibonacci function → response contains a proper fenced code block with language hint, not flattened text.
- Multi-turn: second REPL message references the first ("shorten your last answer") → context held; `/new` → context dropped.
- Shim: `curl -N localhost:8787/v1/chat/completions -d '{"messages":[{"role":"user","content":"hi"}],"stream":true}'` → valid OpenAI-format SSE deltas ending in `[DONE]`.
