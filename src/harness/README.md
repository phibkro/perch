# Harness boundary

Perch is a native chat client. It does not run a model or an agent harness on the phone.

`SessionStore` exposes the same `subscribe` / `getSnapshot` interface to the UI for all connectors. The UI consumes normalized messages, tool activity, pending questions, agents, connection state, and explicit adapter capabilities. The selected harness and the selected model/provider are separate metadata. Missing model metadata means the host has not supplied it.

| Connector | Runtime owner | Transport | Implemented |
| --- | --- | --- | --- |
| Demo | Synthetic in-memory host | None | Independent conversations, streamed text, questions, interrupt, disconnect/reconnect, sample artifacts |
| OMP | Your existing OMP session, including one running in Tern | Existing encrypted OMP Collab protocol | Read/write or view-only join, live transcript/tools/subagents, supported choice/editor questions, interruption, snapshot reconnect |
| pi | One long-lived process owned by our self-hosted bridge | Perch v1 snapshots over authenticated WebSocket; pi JSONL RPC behind it | Streaming, tools, choice/confirm/input/editor questions, interruption, reconnect, server-configured model selection |
| Pi Durable | Per-workspace catalog and per-chat PiHarness cell | Authenticated HTTPS snapshots and immutable downloads | Remote history/create/select, idempotent prompt, abort, configured model choice, durable artifact references |
| OpenCode | Your headless OpenCode server | Authenticated HTTPS via the included host gateway; SSE notifications and authoritative reads | Remote history/create/select, host models, messages/tools, supported permission/questions, abort, reconnect |
| Remote OMP | The original OMP process with its extension loaded | Authenticated Perch remote snapshots | Explicit attachment, history, prompt/interrupt, host models; owner dialogs stay unsupported |
| Remote Tern | Existing OMP panes in a connected Tern window | Authenticated Perch remote snapshots and private window plugin | Explicit attachment, prompt/interrupt, supported owner approvals and plan choices, bounded plan reader, remote-host location |

The OMP transport and cryptography remain in `src/vendor/omp`; the presentation components do not receive the Collab room key. Pi, OpenCode, and Pi Durable keep connection secrets inside their drivers. No connector begins networking before an explicit connection submission. Calling `useDemo` or disposing the store invalidates callbacks from an older connection.

## Public contract

```ts
sessionStore.connectCollab(inviteLink, displayName);
sessionStore.connectPi({ url: 'wss://your-host/session', token }, displayName);
sessionStore.connectDurable({ url: 'https://your-durable-host', token });
sessionStore.connectOpenCode({ url: 'https://your-gateway', username: 'perch', password });
sessionStore.connectRemote({ url: 'https://your-workspace/harness/tern', token });
await sessionStore.createSession(); // Host identity, or a new demo identity.
sessionStore.selectSession(sessionId); // Only when the adapter supports it.
sessionStore.sendPrompt(text);
sessionStore.interrupt();
sessionStore.answerQuestion(answer, displayedQuestionId);
sessionStore.setModel(provider, modelId); // Only if the adapter exposes modelSelection.
sessionStore.reconnect();
sessionStore.useDemo();
```

`capabilities` describes implemented features, not permission to issue a command now. Also check `readOnly`, connection state, `sessionAction`, the session's status, and pending questions. OpenCode and Pi Durable support remote session creation/selection; Pi and OMP remain single-session adapters. `steer` and attachments remain false. The Pi bridge uses Pi's documented streaming behavior if a run starts concurrently with a submitted prompt; that does not advertise a separate steering feature.

Models are not guessed from provider names or prompt text. OMP reports its current host model when available. The pi bridge exposes sanitized descriptors from `get_state` and `get_available_models`; `setModel` accepts only a model already configured on that host. Provider keys, API base URLs and model setup remain server-side.

OpenCode's raw provider endpoint can include keys. The included gateway projects only safe catalog fields, and the mobile adapter verifies `/perch/health` before requesting the catalog. Do not replace this with a direct call to a raw OpenCode `/provider` endpoint. Provider/model IDs remain unmodified so host-specific custom providers still work.

Artifacts are a separate presentation layer. Text fences can be extracted from any harness's assistant messages. A `ToolActivity.artifact` is emitted only for a recognized `write` tool's complete `path`/`filePath` and `content` input; a proposed write is not proof that a file exists, so its tool outcome remains separate. Logs, partial edits and success messages are not used to guess file contents.

## Delivery and reconnect

OMP questions remain visible until the host ends their request. pi RPC does not acknowledge `extension_ui_response`: the bridge removes a question after its complete response is successfully written to pi's stdin. That means **forwarded**, not proof that the extension processed the value. Stale or superseded IDs are rejected. Timed pi questions expire using the duration supplied by pi. Generic terminal-only custom UI is unsupported.

No connector automatically resends a prompt, answer, or model change after reconnecting. Pi Durable may replay an unresolved creation with its original idempotency key; the other connectors do not retry session creation. OMP hydrates the upstream replica. The Pi bridge remains the state owner while the phone disconnects and sends its latest snapshot on rejoin. OpenCode refreshes sessions and the selected transcript from the host. A send alone does not prove host receipt; inspect the transcript before retrying. The app retains drafts/recoverable text independently.

`HarnessUpdate.storedArtifacts` contains immutable durable manifests. The driver fetches their bytes only through its authenticated session-scoped route. The store rechecks the active session and connection epoch before handing content to a reader. Successful integrity verification is required for copy, export, and preview.

`HarnessUpdate.sessions` is an optional remote list, with `session` identifying the active authoritative transcript. `sessionAction` marks a pending create or switch. A driver publishes replacement identity and transcript together; the store keeps drafts in the old namespace until that update. A stale response from an earlier connection cannot become current state.

## Verification

- `node src/session/verify.cjs`: independent OpenSSL OMP host fixture, encryption, read-only join, stale questions, acknowledgment, history deduplication, separate demo threads, cancellation and offline catch-up.
- `npm --prefix server/pi-bridge test`: the real pinned pi process, an isolated temporary workspace, and an OpenAI-compatible loopback SSE fixture; no user host or external model is contacted.
- `bun run --cwd server/pi-bridge typecheck`: independent server/shared-protocol types.
- `npm --prefix verification/opencode test`: independent protocol fixture and actual session-store lifecycle checks.
- `npm --prefix server/opencode-gateway test`: gateway credential, route, event, origin, and command boundaries.
- `bun run --cwd verification/opencode test:integration`: real pinned OpenCode, actual gateway, isolated synthetic provider, and driver checks.
- `npm --prefix verification/durable test`: independent HTTP protocol and real SessionStore checks, including lost receipts and protected artifact validation.
- `CELLD_BIN=/path/to/celld node verification/durable-runtime/verify.mjs`: actual PiHarness/celld backend, phone driver, artifact binding, and crash/cache recovery.
- `npm --prefix experiments/pi-durable test`: real process kill/reopen for durable core recovery; separate from the phone adapters.

See [the pi bridge](../../server/pi-bridge/README.md) for setup and scope. The
[Tern request adapter](../../docs/REMOTE-REQUESTS.md) maps supported host controls;
it is not a general terminal or TSP renderer. Choose that connection for native
owner approvals and plan review; OMP Collab retains its existing guest scope.
