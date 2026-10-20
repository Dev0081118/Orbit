# Orbit 3

Orbit is a private Mac workspace with two clear modes:

- **Project** lets you choose the official Gemini Free or ChatGPT Free website for reasoning and uses Orbit for reviewed, local file operations, commands, verification, and revert.
- **Offline** runs Qwen locally through Ollama for private everyday chat with no account or internet after the model is installed.

Orbit never asks for or stores Google/OpenAI cookies, passwords, browser storage, or private web tokens. The handoff is user-controlled: Orbit prepares a bounded prompt, you review and copy it into the selected provider, then paste its structured result back into Orbit.

## Run on macOS

Requirements: macOS 13 or newer, Apple silicon, Node.js 24 or newer, and Ollama for Offline mode.

```bash
./Launch.command
```

To build the native application bundle:

```bash
zsh scripts/build-desktop.sh
open Orbit.app
```

The generated app is locally ad-hoc signed. It is designed for the Mac that builds it and is not notarized for public distribution.

## Project mode with Gemini Free or ChatGPT Free

1. Choose **Project**, then select a project folder.
2. Add optional text, code, or image reference files with the attachment button.
3. In Settings, choose **Gemini Free** or **ChatGPT Free**, then describe the result and press Send.
4. Review the exact outbound prompt. Secret-like values are flagged, and image attachments are listed for manual upload.
5. Select **Copy & open**, paste the prompt into the official provider page, and add any listed images.
6. Paste the provider's `orbit-response-v1` JSON into **Import result**.
7. Review operations and commands, then apply them locally.

Orbit supports `mkdir`, `write`, `replace`, `delete`, and command operations. Paths must remain inside the selected workspace. Deletion, dependency installation, network access, shell interpreters, and destructive commands require an explicit approval checkbox. Before changing files, Orbit stores snapshots so **Revert task** can restore the earlier state.

If a task needs another reasoning round, **Continue in Gemini/ChatGPT** packages bounded command output, errors, and remaining work for the same provider conversation. Downloaded generated images can be added to the project with **Import generated image**.

Free-plan availability, quotas, uploads, and image features are controlled by Google and OpenAI and may vary by account or region. Orbit does not automate either website or bypass its limits.

## Offline mode

Offline mode uses `qwen3:4b-q4_K_M` by default, with an optional 8B model. It supports local chat, attached text documents, adjustable context, longer output limits, and explicit continuation. It does not edit a project; all project work belongs in Project mode.

The local inference endpoint is `127.0.0.1:11435`. Orbit listens on `127.0.0.1:3210` and rejects untrusted Host and Origin values.

## Architecture

- `server.mjs` owns the loopback HTTP API and coordinates storage, inference, handoff validation, and execution.
- `lib/handoff.mjs` selects bounded context, detects likely secrets, validates structured provider responses, enforces workspace boundaries, applies operations, runs commands, and restores snapshots.
- `lib/store.mjs` persists chats, attachments, handoff tasks, command output, verification state, and file snapshots in SQLite.
- `lib/context.mjs` builds bounded local-model context and retrieves relevant attachment excerpts.
- `public/` contains the responsive desktop interface.
- `native/` and `scripts/build-desktop.sh` package the WKWebView Mac application.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/VALIDATION.md](docs/VALIDATION.md), and [docs/REA-FINDINGS.md](docs/REA-FINDINGS.md) for design and verification details.

## Test

```bash
npm test
```

The suite covers storage, context limits, local streaming, handoff schema validation, traversal and symlink defenses, risky-operation approval, cancellation, file apply/revert, image attachment metadata, generated-asset import, and HTTP security.

## Privacy and limitations

Project source leaves the Mac only after you review and copy the prepared prompt into Gemini or ChatGPT. Commands and file changes execute locally. Treat generated changes like any code review: inspect important diffs and keep version control or backups.

Orbit is an independent project and is not affiliated with Google, Gemini, OpenAI, ChatGPT, or Codex. It recreates a focused project-agent workflow; it does not contain proprietary model weights or claim complete product parity.
