# OpenClaw as a Perch assistant host

**Research and implementation recommendation · 7 October 2026**

**OpenClaw is a credible full assistant host for Perch. Use its operator Gateway WebSocket protocol for a future adapter.** It already supplies assistant identities, workspaces, memory, sessions, tools, approvals, and automation. This is a different product choice from assembling Perch's own assistant around Pi Durable. Both can fit the existing harness boundary; neither belongs inside the phone's rendering runtime. [1][2][3]

This review uses the latest stable release returned by GitHub on this date: **OpenClaw v2026.9.8**, published **3 October 2026**, commit **`fc23bc864e4553c2d215e479eeec47b67a0bf943`**. All OpenClaw source links below are pinned to that commit. The operator wire version is **4**; the narrower older-node/probe compatibility window does not apply to a normal Perch operator client. This is source and documentation review, not a live Gateway, restart, provider, or Expo integration test. No adapter was added. [4][5]

## What Perch would connect to

OpenClaw separates four concerns: a provider authenticates and supplies models; a selected model performs inference; an agent runtime owns the model/tool loop; and OpenClaw owns the surrounding assistant and channel/session services. A configured assistant has its own workspace and bootstrap instructions, including `SOUL.md`, `IDENTITY.md`, `USER.md`, and optional `MEMORY.md`. Changing a provider does not move that assistant's identity or stored conversations to another harness. [1][3]

The current embedded runtime is OpenClaw-owned. Its architecture documentation says external agent framework packages have been internalized; the legacy runtime alias `pi` normalizes to `openclaw`. `@earendil-works/pi-tui` remains a terminal toolkit dependency. Therefore, older descriptions of “Pi inside OpenClaw” do not establish that this release runs Pi CLI or `@earendil-works/pi-durable`, or exposes either package's protocol. OpenClaw also supports other runtime backends with distinct ownership and compatibility boundaries. [1][6]

The [Pi Durable evaluation](PI-DURABLE.md) remains relevant when Perch should own the assistant implementation, storage/execution interfaces, and tool replay policy. OpenClaw is the more complete assistant application to connect to; Pi Durable is a foundation for building one. That is an implementation tradeoff, not a claim that OpenClaw lacks persistence.

### Gateway protocol versus compatible HTTP

| Surface | Actual contract | Fit for Perch |
| --- | --- | --- |
| Operator Gateway WebSocket | Authenticated RPC plus events for agents, sessions, models, chat, tools, approvals, files, and artifacts. `hello-ok.features` advertises methods/events. | Preferred full client integration. |
| `/v1/chat/completions` | Optional, disabled by default; executes a normal Gateway agent run. Its `model` selects an **agent target** such as `openclaw/<agentId>`. `/v1/models` lists agent targets, not the backend model catalog. | Useful for software expecting this API, but it does not provide the full operator client surface. |
| `/v1/responses` | Separately enabled compatibility surface with SSE, inputs/files, client function-tool continuation, and session continuation. | Additional compatibility, not a replacement for session discovery and operator events. |

A Chat Completions request creates a new session by default. A stable `user` value can route requests to one conversation; `x-openclaw-session-key` offers explicit routing with reserved-namespace restrictions. Shared-secret HTTP bearer authentication grants broad operator authority; the official documentation specifically recommends paired-device Gateway access for native mobile clients. Do not implement this as a raw model provider in assistant-ui or assume `model: openclaw/...` names a provider model. [2][7][8]

## Capability mapping to the current Perch contract

The following is a proposed adapter mapping, not implemented capability advertising. Perch's existing [session types](../src/session/types.ts) and [harness contract](../src/harness/README.md) already accommodate most conversation behavior.

| Perch surface | OpenClaw integration | Implementation consequence |
| --- | --- | --- |
| Harness / assistant identity | `agents.list`, `agent.identity.get`; effective model/runtime metadata | Add an explicit OpenClaw harness/transport identity. Keep assistant, harness, and provider/model metadata distinct. |
| Session list and selection | `sessions.list` / `sessions.subscribe`; selected `sessions.messages.subscribe`; `chat.history` or `chat.startup` | Publish the new identity and transcript together. Track **agent ID + session key + session ID/generation**; `global` alone does not identify its owner. |
| New chat | `sessions.create` | Supported by the host. Initial model overrides persist with the new entry; creation can still succeed with `runStarted: false` and `runError` for its initial prompt. Preserve the returned session and draft. |
| Model picker | `models.list` with selected session context; `sessions.patch` model override | Use host-advertised provider/model identity and policy. `model-selection-policy` exposes `manualSelectionAllowed`; availability and permission are separate. Avoid raw configuration/auth endpoints. |
| Prompt and streaming | `chat.send` with a stable `idempotencyKey`; `chat` events | Use the display-projected chat stream for text. An authoritative snapshot already contains its delta; do not append both. Honor replacement and empty-retraction events. |
| Tool progress and agents | Structured `agent`, `session.tool`, lifecycle/session events | Advertise `tool-events` only after implementing it; otherwise the host can silently omit live tool events. Preserve run/tool identities and unknown/interrupted outcomes. Do not infer successful file writes. |
| Interrupt / steering | `chat.abort`; `chat.send.queueMode` including `steer`, `followup`, `collect`, `interrupt` | Abort the selected exact run when known. Disconnect is not abort. Steering is a separate capability; a running tool can continue through steering. |
| Approval decisions | `approval.get/resolve/history`, exec/plugin approval list and events | Map supported explicit decisions to a native pending sheet. Canonical host verdicts are first-answer-wins. Backfill pending requests after reconnect and never replay a stale answer. |
| Interactive questions | `question.list/get/resolve` and requested/resolved events | The schema permits up to three questions, multiselect, “other,” secret input, and URLs. Perch's single choice/editor sheet covers only a subset; unsupported requests must remain explicit rather than be silently flattened. |
| Attachments | `chat.send.attachments`, connection attachment policy | Host support exists. Perch still needs picker/upload/state UI. Validate decoded size **and** base64-expanded frame size, and handle model/MIME rejection. |
| Files and artifacts | `sessions.files.list/get`, confined `agents.workspace.list/get`; `artifacts.list/get/download` | Existing derived Markdown/code artifacts still work. Downloadable host artifacts need remote IDs, bytes/URL fetching, access checks, and loading state. |
| Widgets / Canvas / A2UI | `show_widget`, hosted widget documents, session dashboards, optional plugin surfaces | Separate rendering integration. Do not advertise `inline-widgets` before implementing the host contract and isolation boundary. |

Sources: session/create/send semantics [9][10]; identity/files/artifacts [11]; model policy [12]; event projection [13]; approvals/scopes/questions [14][15][16]; attachments and reconnect [2]; widgets [17][18].

The existing `Message.text` and `ToolActivity.artifact` fields do not represent every image, remote document, widget, or multi-question request. The first adapter should preserve supported content and give an explicit fallback for the rest. A richer artifact/question model is separate work; the host having a feature does not make it an implemented Perch capability.

Use the reference projection helpers when assigning display identities. A history record's `__openclaw.id` and sequence can belong to several projected rows, so the transcript entry ID alone is not a unique React/assistant-ui row key. Preserve sibling rows and stable per-row identity rather than deduplicating solely by transcript ID. [2]

## Authentication and connection lifecycle

Use `role: "operator"`, not `node`. A node advertises commands the Gateway can invoke on that device; ordinary chat presentation does not require that authority. The reference client has a browser-safe entrypoint that separates its protocol engine from Node transport/TLS dependencies and accepts host-provided device identity, signing, and token storage. This is a useful Expo starting point, but React Native/Hermes compatibility has not been exercised. [2][19]

The intended pairing flow is:

1. Create and persist an Ed25519 device identity, scoped with credentials to the configured Gateway.
2. Wait for `connect.challenge`. Validate its timestamp, use that server timestamp for `signedAt`, and sign the challenge-bound payload with the reference helpers.
3. Send protocol-v4 `connect` with bootstrap authentication, requested scopes, and implemented capabilities.
4. If pairing is required, display the exact request and structured recovery guidance. An authorized operator approves it on the host.
5. Store the issued device token and approved grant; subsequent connections use that device identity/token. Use the current `hello-ok.auth.scopes` to govern actions. [2][20]

A full chat-and-artifact client can request `operator.read`, `operator.write`, and, when implemented, `operator.approvals` and `operator.questions`. Narrow session scopes exist, but artifact APIs require broader `operator.read`. Method scope is only one gate: session access, ownership, reviewer binding, and current runtime policy also matter. Perch must handle denied actions even when a method is present. Pairing and administrative scopes should be requested only for features that need them. [15]

Perch currently retains secrets in memory. Persistent device identity and secure token storage therefore need explicit implementation before claiming a durable mobile connection. Foreground reconnect should resubscribe and reconcile the host, while Android process suspension and notification delivery remain device/infrastructure work.

## Durability: what the current release actually guarantees

OpenClaw now has substantive recovery. Comparing it with Pi Durable as “session files versus durable execution” would be inaccurate.

| Boundary | Verified current behavior | Limit relevant to Perch |
| --- | --- | --- |
| Memory | Workspace Markdown stores profile, long-term facts, and daily notes; memory plugins provide search and consolidation. | Saved knowledge is separate from execution state. Context injection is budgeted; memory does not mean every prior token is supplied on every turn. |
| Conversation storage | Active session rows and transcripts are in a per-agent SQLite database. Legacy JSONL files remain for migration/archive/import/export uses. | Preserve the database and workspace with the deployment's supported backup/restore path. |
| Phone loses its socket | Accepted host work is not cancelled. Reconnect can hydrate history and the current `inFlightRun`; session activity can include an exact active-run set. | A disconnected phone is not evidence of a stopped or completed task. |
| Gateway restart/crash | Main-session admission/recovery markers and startup scans identify eligible interrupted turns. Recovery dispatches a continuation from the stored transcript. | This is reconstruction and model reconciliation, not restoration of a process stack or universal replay of the interrupted tool. |
| Interrupted tools | Missing outcomes are not treated as success. Recovery can restrict tools to restart-safe operations; Full Access has broader reconciliation behavior. Read-only Code Mode has an explicit reconstructable path. | General interrupted calls are not automatically replayed. External effects still need outcome inspection/idempotency. |
| Subagents / other runtimes | Native subagent records survive and interruption is settled to the parent; ACP-managed work has its own resume owner. | Do not infer identical recovery across every configured backend. |
| Scheduled work | SQLite persists schedules/run receipts; scheduler startup re-arms work and applies catch-up policy. `cron.run` returns queued-run identity; `cron.runs` supplies outcome. | Overdue agent jobs are rescheduled rather than executed inside startup. Scheduling needs a running/woken host; cron is not a Pi Durable task continuation. |
| Delivery and approvals | Outbound delivery queues and canonical approval records are durable. Terminal approval history is retained for 30 days. | Recorded approval truth does not restore an old tool process or ephemeral handle; pending/waiting/rejected/committed are distinct states. |
| Terminals | Gateway terminal PTYs are process-local. | Restart ends their commands and scrollback ownership; history persistence does not keep a shell alive. |

Sources: memory and storage [3][21]; reconnect [2][13]; restart and its exclusions [22]; cron [23]; approvals [14].

Recovery is bounded. The documented main-session recovery cycle has three charged automatic dispatch attempts; exhaustion can tombstone a session for inspection/replacement. Some inputs and provenance classes use specialized admission paths. This is enough to reject the claim that OpenClaw merely reloads a transcript, but it is not a blanket guarantee that all work or external effects are exactly once. [22]

### Three different replay mechanisms

**Text/event catch-up.** A tail history response may contain `deltaCursor`. Reuse it with `chat.history` or `chat.startup`; the result is either an append delta or `kind: "reset"`, requiring a fresh tail. The implementation bounds catch-up to **200 raw events and 1,000,000 bytes**, and resets for incompatible history projections. This is separate from the outer WebSocket sequence and per-run `agent.payload.seq`. Track per-run sequence, discard duplicates, and reload authoritative history after a gap. It is not a replay service for every ephemeral tool event. [2][9][24]

**Input custody.** `chat.send` requires an idempotency key. History can expose accepted pending inputs and exact `inputReceipts` queried by run IDs. A started acknowledgment alone does not prove a transcript row; `messageSeq` is supplied only with a committed user-turn receipt. The official Control UI retains text/attachments in an outbox, checks receipts after reconnect, and re-admits eligible interrupted inputs under fresh authority. Already-consumed and cancelled inputs must not be sent again. Perch has not implemented this outbox protocol; retain its existing no-automatic-mutation-replay rule until it does. [9][10][22]

**Session creation.** The source's `sessions.create` idempotency wrapper is a per-Gateway-context **WeakMap**, keyed by authenticated principal/device and request identity. Successful receipts expire after **five minutes**; this is not a durable, cross-restart creation ledger. Preserve Perch's explicit ambiguous-create recovery: refresh the host list and find the authoritative session before retrying. [25]

## Artifacts and interactive presentation

OpenClaw's artifact API is more useful than guessing files from tool logs. It exposes transcript-derived metadata and downloads scoped to an explicit session or run; `messageRole: "assistant"` excludes uploads and raw tool observations. A run ID alone does not establish assistant-generated output. Some sources deliberately return `download.mode: "unsupported"`; preview-only IDs are not downloadable artifact IDs. [11][26]

Managed images have stable artifact references. Inline payloads can download as base64 over WebSocket or through short-lived HTTP grants. HTTP grants require a reachable Gateway HTTPS route as well as WebSocket access, and inline grants are bound to the live connection and artifact. Keep stable references, request fresh authority when needed, and never embed reusable Gateway credentials in artifact URLs. [2][26]

This supplies a concrete artifact-download adapter, not a general immutable object store with Perch-owned revision history. Perch must decide when to retain/export bytes independently of host transcript retention.

Current Canvas is also more specific than older A2UI examples suggest. `show_widget` supplies hosted interactive documents in isolated frames/webviews; it is capability-gated. A2UI renders on session dashboards. The macOS Canvas panel is a render-only document presenter and no longer accepts A2UI push/reset. Deprecated `canvasHostUrl` fields are replaced by scoped plugin surfaces. Reusing Perch's HTML reader without the widget protocol would omit capabilities and interactions; enabling a Gateway bridge in that reader would change its current isolation contract. Treat this as an explicit later adapter. [17][18][20]

## Recommended implementation order

1. **Prove a narrow operator adapter:** pinned protocol/client combination, Expo transport and Ed25519 pairing, session list/select/create, authoritative history, prompt, streaming tools, and exact-run abort. Keep assistant-ui's external-store ownership unchanged.
2. **Add decisions and reconnect recovery:** supported approval/question sheets, authoritative backfill, stable row IDs, generation fencing, cursor-reset handling, and explicit ambiguous-send UX. Add durable mobile input custody only after receipt reconciliation is verified.
3. **Add downloaded artifacts:** host IDs and provenance, full-byte retrieval, image/document readers, and export. Keep generated widget/dashboard support separately capability-gated.
4. **Validate the chosen host's crash and storage lifecycle:** a successful Gateway reconnect alone does not prove tool effects, final delivery, backup currency, or recovery completion.

The official client guide pins published `@openclaw/gateway-client` and `@openclaw/gateway-protocol` **2026.8.1**, while this review pins Gateway **2026.9.8**. Package versions and wire version are different contracts; additive v4 fields and capabilities still evolve. Test the actual dependency/Gateway pair, rather than assume wire-v4 compatibility alone proves every feature. [2][5]

OpenClaw's release requires **Node `>=24.16.0 <25 || >=26.1.0`**. This finding does not establish a native Workers/Durable Objects runtime. Its Cloudflare deployment, process supervision, storage replication, and wake behavior need to be evaluated as a hosting arrangement for that application; do not infer PiHarness semantics merely from a deployment using Durable Objects. [27]

Remaining checks are concrete: native signing/secure storage; protocol-version and additive-field handling; midstream reconnect and session reset; pairing/token revocation; raced approval resolution; interrupted tool and cron outcomes; and download behavior across reconnect. No full OpenClaw install or hypothetical crash experiment was performed for this note.

## Primary sources

The following source documents and implementations were inspected at `fc23bc864e4553c2d215e479eeec47b67a0bf943`, unless a release page is named.

1. [Agent runtimes](https://github.com/openclaw/openclaw/blob/fc23bc864e4553c2d215e479eeec47b67a0bf943/docs/concepts/agent-runtimes.md).
2. [Building a Gateway client](https://github.com/openclaw/openclaw/blob/fc23bc864e4553c2d215e479eeec47b67a0bf943/docs/gateway/clients.md).
3. [Agent workspace/runtime and SQLite session contract](https://github.com/openclaw/openclaw/blob/fc23bc864e4553c2d215e479eeec47b67a0bf943/docs/concepts/agent.md).
4. [Release v2026.9.8](https://github.com/openclaw/openclaw/releases/tag/v2026.9.8).
5. [Wire-version constants](https://github.com/openclaw/openclaw/blob/fc23bc864e4553c2d215e479eeec47b67a0bf943/packages/gateway-protocol/src/version.ts).
6. [Agent runtime architecture and legacy Pi alias](https://github.com/openclaw/openclaw/blob/fc23bc864e4553c2d215e479eeec47b67a0bf943/docs/agent-runtime-architecture.md).
7. [OpenAI-compatible HTTP API](https://github.com/openclaw/openclaw/blob/fc23bc864e4553c2d215e479eeec47b67a0bf943/docs/gateway/openai-http-api.md).
8. [OpenResponses HTTP API](https://github.com/openclaw/openclaw/blob/fc23bc864e4553c2d215e479eeec47b67a0bf943/docs/gateway/openresponses-http-api.md).
9. [Session-control RPCs](https://github.com/openclaw/openclaw/blob/fc23bc864e4553c2d215e479eeec47b67a0bf943/docs/gateway/protocol/rpc-session-control.md).
10. [Chat, accepted-input, cursor, and abort schemas](https://github.com/openclaw/openclaw/blob/fc23bc864e4553c2d215e479eeec47b67a0bf943/packages/gateway-protocol/src/schema/logs-chat.ts).
11. [Agent, workspace, and artifact RPCs](https://github.com/openclaw/openclaw/blob/fc23bc864e4553c2d215e479eeec47b67a0bf943/docs/gateway/protocol/rpc-talk-config-and-agents.md).
12. [Model catalog views and selection policy](https://github.com/openclaw/openclaw/blob/fc23bc864e4553c2d215e479eeec47b67a0bf943/docs/gateway/protocol/operator-methods.md).
13. [Session subscription and event projections](https://github.com/openclaw/openclaw/blob/fc23bc864e4553c2d215e479eeec47b67a0bf943/docs/gateway/protocol/rpc-bootstrap-and-events.md).
14. [Durable approvals and automation RPCs](https://github.com/openclaw/openclaw/blob/fc23bc864e4553c2d215e479eeec47b67a0bf943/docs/gateway/protocol/rpc-devices-nodes-and-approvals.md).
15. [Operator scopes and ownership gates](https://github.com/openclaw/openclaw/blob/fc23bc864e4553c2d215e479eeec47b67a0bf943/docs/gateway/operator-scopes.md).
16. [Question schemas](https://github.com/openclaw/openclaw/blob/fc23bc864e4553c2d215e479eeec47b67a0bf943/packages/gateway-protocol/src/schema/questions.ts).
17. [Show widget](https://github.com/openclaw/openclaw/blob/fc23bc864e4553c2d215e479eeec47b67a0bf943/docs/tools/show-widget.md).
18. [Canvas widget panel and A2UI boundary](https://github.com/openclaw/openclaw/blob/fc23bc864e4553c2d215e479eeec47b67a0bf943/docs/platforms/mac/canvas.md).
19. [Browser-safe client entrypoint](https://github.com/openclaw/openclaw/blob/fc23bc864e4553c2d215e479eeec47b67a0bf943/packages/gateway-client/src/browser.ts) and [injected signing/token lifecycle](https://github.com/openclaw/openclaw/blob/fc23bc864e4553c2d215e479eeec47b67a0bf943/packages/gateway-client/src/browser-device-auth.ts).
20. [Handshake](https://github.com/openclaw/openclaw/blob/fc23bc864e4553c2d215e479eeec47b67a0bf943/docs/gateway/protocol/handshake.md) and [device authentication](https://github.com/openclaw/openclaw/blob/fc23bc864e4553c2d215e479eeec47b67a0bf943/docs/gateway/protocol/auth.md).
21. [Memory overview](https://github.com/openclaw/openclaw/blob/fc23bc864e4553c2d215e479eeec47b67a0bf943/docs/concepts/memory.md).
22. [Restart recovery, admission, reconciliation, and exclusions](https://github.com/openclaw/openclaw/blob/fc23bc864e4553c2d215e479eeec47b67a0bf943/docs/gateway/restart-recovery.md).
23. [Automation runtime and recovery](https://github.com/openclaw/openclaw/blob/fc23bc864e4553c2d215e479eeec47b67a0bf943/docs/automation/cron-jobs/how-it-works.md).
24. [Bounded transcript delta implementation](https://github.com/openclaw/openclaw/blob/fc23bc864e4553c2d215e479eeec47b67a0bf943/src/gateway/server-methods/chat-history-delta.ts).
25. [Session-create idempotency implementation](https://github.com/openclaw/openclaw/blob/fc23bc864e4553c2d215e479eeec47b67a0bf943/src/gateway/server-methods/session-create-idempotency.ts) and [retention constants](https://github.com/openclaw/openclaw/blob/fc23bc864e4553c2d215e479eeec47b67a0bf943/packages/gateway-protocol/src/schema/sessions-create.ts).
26. [Artifact schemas](https://github.com/openclaw/openclaw/blob/fc23bc864e4553c2d215e479eeec47b67a0bf943/packages/gateway-protocol/src/schema/artifacts.ts) and [download implementation](https://github.com/openclaw/openclaw/blob/fc23bc864e4553c2d215e479eeec47b67a0bf943/src/gateway/server-methods/artifacts.ts).
27. [Release package/runtime requirements](https://github.com/openclaw/openclaw/blob/fc23bc864e4553c2d215e479eeec47b67a0bf943/package.json).
