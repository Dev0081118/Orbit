# REA investigation and reconstruction boundaries

Inspected 20 October 2026. This is a bounded, read-only source/package investigation, not a full decompilation or a claim to reproduce OpenAI's model. Installed applications, the REA checkout, credentials, and conversation databases were not modified or accessed for user data.

## Result

A local conversational application can recreate common interaction patterns and use an independently available model. The inspected client does not provide the server model weights, training recipe, complete inference architecture, or intelligence of the user-described Astra model. Those remain unavailable from this investigation. UI resemblance and local functionality must not be presented as model equivalence.

## Method and evidence identity

REA skill read: `/Users/divyarajsinhrana/rea/.agents/skills/reverse-engineer-anything/SKILL.md`, metadata version 42. Its staged investigation and observation/inference/unknown separation guided this work. REA MCP tools were not exposed; the supplied checkout had no compiled `dist` or `node_modules`. The published REA 6.7.0 CLI was temporarily acquired and its command surface was verified. Its doctor stalled during dependency preparation, and the requested `analyze-javascript-application` run later failed on an npm registry timeout before emitting Evidence. **No REA application-analysis result is claimed.** Ordinary bounded filesystem inspection parsed the shipped ASAR header and read three selected JavaScript members. Evidence labels below are report-local IDs, not REA Evidence IDs.

| ID | Source and bounded observation |
| --- | --- |
| E1 | `/Users/divyarajsinhrana/rea/package.json`: package `rea-agents`, version `6.6.0`, MIT, CLI entry `scripts/rea.mjs`, TypeScript/JavaScript project. |
| E2 | `/Users/divyarajsinhrana/rea/docs/architecture.mermaid`; `src/composition/reverseEngineering.ts`; `src/composition/javascriptRecovery.ts`: CLI/MCP adapter layers, application workflows, explicit provider composition, evidence ledger and provider-specific native/browser/JavaScript capabilities. These are REA's architecture, not ChatGPT's. |
| E3 | `/Applications/ChatGPT.app/Contents/Info.plist`: display name ChatGPT, bundle ID `com.openai.codex`, version `26.1007.30912`, build `20156`, Chromium `155.0.8059.40`. Framework inventory includes `Codex Framework.framework`. The installed target is specifically a Codex-backed, ChatGPT-branded build. |
| E4 | `/Applications/ChatGPT.app/Contents/Resources/app.asar`: 567,757,587 bytes; 21,089 file entries. SHA-256 `75e397e2280dde93b70a85aa926f4282c728eacc84dfeb15ba7fb6ddd84628af`. Header SHA-256 `0ba43368dc2f01fcf2a29c8e02f30cc6bb879ce268c8672734504f791526ce50`. Top-level entries `.vite`, `native-menu-locales`, `node_modules`, `package.json`, `webview`. |
| E5 | ASAR member `package.json`: package `openai-codex-electron`; entry `.vite/build/early-bootstrap.js`; declared dependencies include `better-sqlite3`, `node-pty`, `ws`, `vscode-jsonrpc`, `app-server-manager`, `app-server-types`, `browser-api`, and `git-worker`. Declared dependencies alone do not establish their execution or data schema. |
| E6 | ASAR member `.vite/build/early-bootstrap.js` (3,304 bytes): imports Electron; configures Chromium feature switches; initializes network permissions; conditionally loads the bootstrap module. |
| E7 | ASAR member `.vite/build/preload.js` (6,909 bytes): exposes an `electronBridge` through Electron `contextBridge`; forwards view messages via `ipcRenderer`; includes worker message subscriptions, theme updates, initial sidebar bootstrap, file drag support, shared object updates, and chunked-message acknowledgement. This establishes shipped bridge code, not observed runtime behavior. |
| E8 | ASAR member `.vite/build/sandbox-preload.js` (2,102 bytes): validates sandbox origins and initialization IDs and forwards named MCP application message ports. This is a separate embedded-content boundary. |
| E9 | All 21,089 ASAR entry names checked for `.gguf`, `.safetensors`, `.pt`, `.pth`, and `.onnx` suffixes: no matches. This bounded filename search does not rule out differently named assets, models outside the ASAR, remote models, or unrelated local models. |

Scratch inventory and the three inspected code members are retained under `work/rea-inspection/` in this task's workspace for audit. The replacement application does not need or reuse those code members.

## Findings

**Observed, high confidence:** this shipped client has an Electron/Chromium shell, packaged webview assets, a main/preload/renderer communication boundary, and a dedicated embedded-app sandbox bridge (E3–E8). It also ships supporting native resources and a Codex CLI resource directory. We did not execute these resources.

**Inferred, moderate confidence:** separating the interface from host services permits chat rendering, filesystem/workspace operations, background work, and embedded tools to evolve independently. The selected bridge code supports that interpretation. Package names suggest storage, terminal, JSON-RPC, and app-server responsibilities, but neither their full call graph nor private service schemas were reconstructed (E5–E8). Orbit uses the public Codex app-server schema shipped with the installed CLI rather than guessing that protocol.

**Unknown:** Astra's weights, parameter count, quantization, model topology, training data, training process, server routing, inference infrastructure, system prompts, complete tool orchestration, and performance characteristics. No local source/package inspection here establishes these. The word Astra in the request is not proof of a publicly downloadable model or a particular architecture.

**Unknown:** exact current production ChatGPT behavior and full feature parity. No logged-in session, user history, network interception, live runtime traces, or production service tests were used. This installed artifact is not evidence for every ChatGPT client version.

## Reconstruction decisions for a 16 GB Apple-silicon Mac

The following are engineering choices for the new application, not recovered OpenAI implementation details:

- Use a lightweight local web interface and a loopback backend for conversations, streaming, persistence, and an independently supplied local inference runtime. Avoid bundling another large browser runtime initially.
- Make model/runtime availability explicit. Never simulate successful inference when the model is missing or the runtime is offline.
- Start with a quantized small model and permit a larger model as a deliberate choice. Keep one generation active at a time; bound context and output; support cancellation and model unloading.
- Retain conversation history separately from the active inference context. A long visible history must not silently imply the entire history is included in each prompt.
- Keep local-chat uploads and saved memory as data. For coding mode, grant tool access only to a user-selected workspace through Codex's workspace-write sandbox and reject escalation outside it.

Memory feasibility follows arithmetic before benchmarking: raw 4-bit weights require approximately `parameter_count / 2` bytes. A 4-billion-parameter model is about 2 GB of raw weights, an 8-billion model about 4 GB, a 32-billion model about 16 GB, and a 70-billion model about 35 GB. These are decimal, idealized weight-only values; actual files and resident memory add quantization metadata, activations, KV cache, buffers, runtime, application, and macOS usage. Therefore a 32B or 70B dense model cannot be assumed to run fully resident and smoothly within a shared 16 GB machine. Sparse activation reduces some computation but does not automatically eliminate the memory required to hold expert weights. Context length can materially increase memory use.

Smoothness and answer quality require measurement on the actual configured model and machine. A bounded benchmark should record warm/cold first-token latency, generation tokens per second, model/context configuration, memory pressure, and stop responsiveness. No hardware throughput or model-quality result is established by this static investigation.

## Completion checklist

| Question | Status |
| --- | --- |
| What is the supplied REA project and how should it be used? | Answered at source/architecture level. Runtime not built or executed. |
| What is the installed client artifact? | Answered for the exact bundle/version and ASAR hash above. |
| What client boundaries are evidenced? | Partially answered: bootstrap, preload/IPC, packaged renderer, sandbox. Full application graph unexamined. |
| Can this reveal or clone Astra's model? | Unresolved/unavailable from inspected evidence; no model reconstruction claimed. |
| What can be reconstructed locally? | Common chat UX, independent local inference, and an official ChatGPT-powered Codex coding loop with selected-workspace tools. |
| Does a large model run smoothly on this M4 16 GB? | Requires model-specific runtime measurements; cannot be certified from static package analysis. |
