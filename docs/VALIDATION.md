# Validation

Orbit 3 is validated at three layers.

## Automated application tests

`npm test` covers settings constraints, context accounting, document retrieval, NDJSON streaming, SQLite durability, HTTP request validation, local generation behavior, export/import, handoff preparation, secret warnings, schema validation, traversal and symlink rejection, risky-operation classification, cancellation, apply/revert, Gemini and ChatGPT provider routing, image attachment metadata, and local generated-image import.

## Static checks

`node --check public/app.js` and `node --check server.mjs` verify JavaScript syntax. The native application build script compiles the Swift launcher, copies the web and server resources, writes application metadata, and applies local ad-hoc signing.

## Behavioral boundary

The verified Gemini/ChatGPT workflow covers provider selection, prompt preparation, exact review, response import, local changes, commands, verification, provider-aware follow-up, and revert. Live hosted answers are account and service dependent and are not part of automated testing. Orbit does not claim to bypass provider limits, provide premium features, reproduce proprietary weights, or guarantee model correctness.

Offline performance measurements in `BENCHMARK.json` are retained as observations from the tested Mac and model build. They are not guarantees for every machine or workload.
