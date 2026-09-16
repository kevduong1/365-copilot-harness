# Installing and setting up copilot365

`copilot365` is a local TypeScript CLI that uses an existing Google Chrome session to talk to Microsoft 365 Copilot. Microsoft credentials are entered in the browser; copilot365 does not receive or store your password.

## Requirements

- Node.js 24 or newer
- pnpm 10.19 or newer
- Google Chrome
- A Microsoft account with access to [Microsoft 365 Copilot](https://m365.cloud.microsoft/chat)
- Git

On Windows, install [Git for Windows](https://gitforwindows.org/) and use Windows Terminal or another VT-capable terminal. Git Bash is recommended because the coding agent's shell tools use POSIX command conventions.

## Install

Clone the repository and enter it:

```sh
git clone https://github.com/kevduong1/365-copilot-harness.git
cd 365-copilot-harness
```

Confirm Node.js and pnpm are available:

```sh
node --version
pnpm --version
```

If pnpm is not installed, enable the package-manager shim supplied with Node.js and activate the version used by this project:

```sh
corepack enable
corepack prepare pnpm@10.19.0 --activate
```

Install dependencies:

```sh
pnpm install
```

## Sign in

Run the login flow:

```sh
pnpm copilot365 login
```

A visible Chrome window opens. Complete Microsoft SSO and MFA manually. When the Copilot chat input appears, copilot365 confirms the login and closes Chrome. That close is expected.

The authenticated browser profile is saved in `.data/profile/` and the cookie snapshot is saved in `.data/storage-state.json`. Both paths are ignored by Git and contain credentials. Do not share or commit them.

If a later command reports that you are not logged in, repeat `pnpm copilot365 login`.

## Start copilot365

Launch the interactive coding-agent terminal:

```sh
pnpm copilot365
```

Start in another repository with `--cwd`:

```sh
pnpm copilot365 --cwd /path/to/project
```

Grant access to additional repositories with `--add-dir`:

```sh
pnpm copilot365 --add-dir /path/to/another-project
```

Use print mode for a one-shot task or a script:

```sh
pnpm copilot365 --read-only --print "Inspect this repository and summarize how it works"
```

Use `--read-only` for audits. Use `--yes` only when you intend to automatically approve mutating tools for the current process.

## Optional HTTP server

Start the OpenAI-compatible local server:

```sh
pnpm server
```

It listens on `127.0.0.1:8787`. The endpoint is `http://127.0.0.1:8787/v1`, with `POST /v1/chat/completions` and `GET /v1/models`. Set `PORT` to use another port.

## Verify the installation

Run the project checks:

```sh
pnpm typecheck
pnpm test
```

To diagnose changed Copilot page selectors after signing in, run:

```sh
pnpm spike
```

This writes temporary browser diagnostics under `.data/` and captures a selector probe in `spike.png`.

## Useful configuration

The most common environment variables are:

| Variable | Default | Purpose |
| --- | --- | --- |
| `COPILOT_URL` | `https://m365.cloud.microsoft/chat` | Copilot chat URL |
| `PROFILE_DIR` | `.data/profile` | Persistent Chrome profile directory |
| `SESSION_STATE_PATH` | `.data/storage-state.json` | Saved session state |
| `PORT` | `8787` | Local HTTP server port |
| `HEADLESS` | unset | Set to `1` to experiment with headless Chrome |

See the [README](README.md#configuration) for the complete configuration table and CLI details.

## Troubleshooting

- If Chrome opens to a login page, run `pnpm copilot365 login` and complete SSO/MFA.
- If the chat input is not detected after a successful login, confirm that the account can open the Copilot chat URL and run `pnpm spike` to inspect the current page selectors.
- If the terminal layout is broken, use a larger VT-capable terminal. Set `NO_COLOR=1` for a text-only color mode.
- If dependencies are stale or incomplete, run `pnpm install` again with Node.js 24 or newer.
