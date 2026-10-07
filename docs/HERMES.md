# Hermes Agent as a Perch harness

Research date: **2026-10-07**. This evaluates **NousResearch Hermes Agent**, the assistant application in [NousResearch/hermes-agent][repo], not the Hermes model family or unrelated projects with the same name.

Source revision: [`0e37a439bda15ef3c28a4d20593964d7c6a527a6`][commit], committed **2026-10-07 at 03:09:21 UTC**. Implementation links below are pinned to that revision. The official documentation links describe the live documentation read on the research date and can change. The repository's `pyproject.toml` uses a placeholder package version, so the commit is the useful version identifier for this assessment. [Package metadata][package]

**Method:** read the official documentation, inspected a shallow checkout of the official source, and compared it with Perch's [design](DESIGN.md), [session types](../src/session/types.ts), [session contract](../src/session/README.md), and [harness boundary](../src/harness/README.md). No Hermes runtime, model calls, tool executions, crash experiment, mobile connection, or Cloudflare deployment was run. This is a source-backed feasibility assessment, not an implemented or verified adapter.

## Recommendation

**Yes: Hermes is a credible host for Perch and already exposes official interfaces for third-party clients.** It supplies the agent loop, provider selection, tools, persistent conversations, memory, skills, scheduling, and several recovery mechanisms. Perch can remain a native Expo/assistant-ui client that projects host state. The new work would be a Hermes driver and connection/authentication path within Perch's existing harness boundary. The official integration guide explicitly distinguishes the rich TUI gateway, HTTP API, ACP, and direct Python use. [Integration guide][integration]

**Prefer the TUI gateway over authenticated WebSocket for a full Perch integration.** Its protocol exposes structured tool activity, interactive server requests, live-session snapshots, replay cursors, model options, and session management. Use the dashboard backend that hosts that WebSocket endpoint; the word “TUI” does not restrict the protocol to terminal clients. This is a recommendation from the documented protocol and Perch's current contract, not a demonstrated mobile integration. [Integration guide][integration] [WebSocket transport][ws] [Dashboard hosting][dashboard]

**HTTP Runs is the strongest alternative for a smaller first connection.** It offers independent background runs, SSE, status/control endpoints, tool approvals, and optional durable admission deduplication. Its live tool feed is less expressive and its default toolset omits the general `clarify` interaction. A Runs-based driver should advertise those limits. Neither choice establishes arbitrary tool execution with exactly-once effects or a persistent instruction pointer that resumes after any crash. Those are separate requirements from retaining chat history and restarting an interrupted task. [API guide][api-guide] [Runs implementation][runs] [Toolsets][toolsets]

This research does not replace the proposed Pi Durable foundation recorded in [DESIGN.md](DESIGN.md). Hermes is a substantial existing assistant product; choosing it would favor its integrated behavior and protocols. The recovery requirements in that proposal still need to be checked against the specific Hermes transport and execution path selected.

## Which official interface fits?

| Interface | What it provides | Fit for Perch |
| --- | --- | --- |
| **TUI gateway: JSON-RPC over WebSocket or stdio** | Prompting, structured live tools, approvals and clarification requests, active/saved sessions, history, model selection, interruption, steering, snapshots, and bounded replay. | Recommended for the rich native client. Use WebSocket through the dashboard backend; implement its authentication, request lifecycle, and history reconciliation. |
| **HTTP Runs: `/v1/runs` plus SSE and Sessions REST** | Detached execution, a run ID, status, stop/steer/approval endpoints, history resources, and optional persisted `Idempotency-Key` reservation. | Good smaller integration when detached execution and ambiguous-submit recovery matter more than full interactive and live-tool parity. |
| **Responses: `/v1/responses`** | OpenAI-compatible streaming, server-executed tools, structured function-call/output items, and continuation through response IDs or named conversations. | Useful for existing Responses clients. Its response store is bounded; it is not the complete session/control protocol by itself. |
| **Chat Completions: `/v1/chat/completions`** | A familiar OpenAI-compatible completion endpoint, normally with caller-supplied message history. | Suitable for compatibility clients. A Perch adapter would still need richer session, control, and reconciliation features. |
| **ACP: `hermes acp`** | An official editor-facing protocol over stdio, with session/model operations and permission interaction. | Reasonable where an ACP bridge already exists. Perch would need a remote transport and protocol translation; it has no existing ACP runtime. |
| **Python: `AIAgent`** | Direct calls such as `chat` and `run_conversation` with the same core agent. | Useful for a custom host service. The service author takes on transport, authentication, lifecycle, and recovery integration. The official guide does not offer a supported standalone wheel/sdist install contract. |
| **Custom messaging platform adapter/plugin** | Routes incoming events through the gateway and implements platform delivery. | Could reuse messaging-origin routing, cron delivery, and gateway recovery. It is a larger host-side integration than consuming the existing rich-client protocol. |

These interfaces are official parts of the same agent application. They do not share identical lifecycle or persistence guarantees. Sources: [integration guide][integration], [API guide][api-guide], [ACP internals][acp], [Python guide][python], and [platform adapter guide][platform-adapters].

## Mapping Hermes to Perch's contract

Perch currently consumes a `CollabDriver` and authoritative `CollabUpdate` snapshots. The adapter owns protocol translation, authentication, capability decisions, and reconnect. The phone must not run Hermes tools or start a second model loop. That existing boundary is compatible with Hermes's host-side agent execution. [Perch contract](../src/harness/README.md) [Integration guide][integration]

| Perch responsibility | TUI gateway mapping | HTTP mapping and qualifications |
| --- | --- | --- |
| Send prompt | `prompt.submit`; background submission is also available. | `POST /v1/runs`, normally with a server-owned `session_id`. Use a stable admission key when supported. |
| Stream assistant work | Message/reasoning/status events; snapshot `inflight` preserves the current turn's projected text. | Runs SSE contains deltas and terminal status. Responses has its own OpenAI-compatible event format. |
| Live tool cards | `tool.start`/`tool.complete` carry a tool identity, structured arguments, and structured result. Text previews have separate limits. | Runs `tool.started`/`tool.completed` expose tool name, preview, duration/error metadata. At this revision they do **not** carry a tool-call ID or full arguments/result. |
| Pending question | Server requests include `approval` and `clarify`, with explicit IDs and cancellation. | Runs supports `approval.request` and `/v1/runs/{run_id}/approval`; its default toolset excludes `clarify`. Approval support does not imply arbitrary editor/secret interaction. |
| Interrupt | `session.interrupt`. | `POST /v1/runs/{run_id}/stop`; stopping is cooperative, and status remains transitional until the executor exits. |
| Steer | `session.steer`. | `POST /v1/runs/{run_id}/steer`. Advertise only after the Perch driver implements the behavior. |
| Remote sessions | Saved `session.list`, live `session.active_list`, create/resume/activate/close/history/branch methods. | Sessions REST lists, creates, reads, updates, forks, and supplies messages. A session selection is an authoritative history change, not a local thread rename. |
| Model inventory and selection | `model.options`; `/model` through `command.dispatch`, or the supported `config.set` model path. | `/api/model/options`; request runtime options and `POST /api/sessions/{session_id}/model` for an acknowledged persisted session model lock. `/v1/models` is only the compatibility inventory. |
| Attachments and file contents | Image byte attachment operations exist; full write-tool inputs may supply artifact content. Dashboard file routes can fetch retained files. | Image input is supported on documented Chat/Responses/session routes. Do not assume every input type works on Runs. Generic `input_file`/`file_id` support is not provided by the documented OpenAI-compatible API. |

Sources: [protocol guide][integration], [event contracts][events], [tool event implementation][tool-progress], [Runs handlers][runs], [server-request contracts][requests], [model switching][config-set], [HTTP routes and model lock][api-source], [image attachment contracts][prompt-voice], and [API guide][api-guide].

### Questions need an exact lifecycle

After `gateway.ready`, a WebSocket client that handles server requests must advertise `client.capabilities` with `server_requests: true`. Hermes sends a JSON-RPC request such as `approval` or `clarify`; the response uses the same request ID. The gateway withdraws an answered, timed-out, or cancelled request with `request.cancel`. `session.resume`, `session.activate`, and `session.events.since` include `open_requests`, so reconnect can restore a still-live question. These pending request objects are process memory; that reconnect behavior does not make them crash-persistent futures. [Integration guide][integration] [Server request handling][request-runtime]

Perch's current `PendingQuestion` represents one choice or editor question. Hermes clarification can contain several questions and multi-selection. The driver would need an explicit sequence/aggregation policy or an unsupported-question state for cases outside that contract. Credential, sudo, vault, and desktop-specific requests need their own treatment; an ordinary text editor question is not automatically a safe password UI. Unsupported JSON-RPC methods should receive the defined error rather than leave the host waiting. [Question contracts][requests] [Perch types](../src/session/types.ts)

HTTP Runs **does support approvals**, including approval events and a waiting status. Send the exact `request_id` with the decision; a stale decision can conflict. This is narrower than the TUI server-request set. The capability flag at the inspected source revision is `run_approval_response`, while the documentation uses `run_approval` and the endpoint map also names that route. A driver should negotiate the deployed capability response and endpoint map and test its chosen version, rather than copy a feature name from one documentation paragraph. [Runs approval handler][runs] [Capabilities and routes][api-source] [API guide][api-guide]

### History, identity, and artifacts require reconciliation

Hermes distinguishes a live runtime session ID from stored/session-key identities and may advance the persisted session through compression. Snapshots include the relevant identity information. Perch should publish the replacement session identity and transcript together and retain draft namespaces until the host confirms that transition. A process-local active list cannot replace the saved session list. [Session contracts][session-contracts] [Perch session contract](../src/session/README.md)

The SQLite schema has stable logical message/tool-call identities, but not every client projection includes them. The TUI history projection includes physical row IDs for messages and tool-call IDs/arguments for tool rows, yet omits most historical tool-result content. The API-server message projection is also selective. The dashboard's authenticated session-messages route supplies a richer database-derived history. Live tool events, compact history, and full stored messages therefore cannot be treated as interchangeable representations. Validate identity across reconnect, compression, and repeated parallel tool names before deriving stable Perch message/tool/artifact IDs. [Session storage guide][session-storage] [TUI history projection][history-source] [API message projection][api-source] [Dashboard messages][dashboard-sessions]

The TUI tool events are promising for Perch's existing artifact rule: a recognized write operation's **complete input** can provide filename/content, independently of whether the write succeeded. The event's capped preview is not that content. HTTP Runs only supplies preview metadata in its live tool events, so a Runs adapter needs authoritative history or a file read before presenting complete artifacts. Repeated uses of the same tool name cannot reliably establish occurrence identity by themselves. [Tool events][tool-progress] [Runs event fields][runs] [Perch artifact boundary](../src/harness/README.md)

For retained files, dashboard routes include text preview, data-URL reads, and `/api/fs/download`, with path/profile/session checks and backend-aware file access. They can supply actual bytes, but do not establish immutable artifact IDs, revision history, or an object-store retention policy. Text previews can be truncated. The API's `/v1/artifacts/upload` and download routes serve the **browser-control transport**: the inspected store is temporary, one-shot, size/MIME limited, and normally expires after five minutes. They should not be mistaken for a permanent general artifact service. [Dashboard file routes][dashboard-files] [Browser artifact store][browser-artifacts]

## Reconnect and restart are different operations

### TUI WebSocket: restore the live session, then reconcile

Hermes buffers a bounded per-session event ring in memory. At this revision the defaults include 512 events and 4 MiB per session, with process-wide bounds. Events have a sequence and a process epoch. `session.events.since` can replay within that retained window and reports truncation. A changed epoch or missed window requires a fresh history/live snapshot, including `inflight` and `open_requests`; replay is not a durable event log. [Replay implementation][replay] [Integration guide][integration]

A socket disconnect does not universally stop work. Regular sessions default to `close_on_disconnect: false`. When the final client leaves, the runtime parks its transport and checks orphaned sessions after a grace interval. At this revision the default grace is 20 seconds and the stale-activity threshold is 600 seconds. An active delegation or a running turn with fresh activity defers cleanup; an idle session can be reaped, and a stale running turn is interrupted and eventually reaped. Explicit `close_on_disconnect` changes this behavior. It would be incorrect to describe the default as either “all turns stop after 20 seconds” or “every detached session runs forever.” [Disconnect lifecycle][lifecycle] [Gateway defaults][tui-server]

The adapter should first reattach/resume and hydrate host state. Perch's existing rule remains useful: a lost connection must not implicitly resend a prompt, answer, model change, or session creation. TUI replay and crash markers do not prove durable acceptance of every client submission. [Perch delivery contract](../src/harness/README.md) [Replay implementation][replay] [Turn markers][turn-markers]

### TUI cold resume can itself start a continuation

The TUI gateway has more crash recovery than a plain history loader. It writes a best-effort interrupted-turn marker under `$HERMES_HOME/desktop/interrupted_turns.json`. On a **cold `session.resume`**, an eligible recent marker can start a new continuation turn. Defaults at the pinned revision are `desktop.auto_continue.enabled: true`, a 15-minute freshness window, and two attempts. The implementation checks marker ownership and session admission, excludes paths whose separate state machine owns recovery, and clears disabled/stale/exhausted markers. [Auto-continuation implementation][auto-continue] [Marker implementation][turn-markers]

This is a **new model turn** using recovered context and an instruction to inspect work already completed before continuing. It is not restoration of the old Python stack, an exact tool program counter, or the old pending approval object. Marker writes are best effort, so absence of a marker is not proof that no request ever began. [Auto-continuation implementation][auto-continue] [Marker implementation][turn-markers]

For Perch, this needs an intentional host policy. “Reconnect without resending” can still lead to host-initiated work when cold resume triggers auto-continuation. The UI should show the returned recovery state, and the product should decide whether to keep that host default or disable it and require a deliberate continuation. This is an integration decision, not a claim that Perch currently offers such a setting.

### HTTP Runs: admission survives more than the event stream

`POST /v1/runs` owns a background task independently of an SSE subscriber. Disconnecting from `/v1/runs/{run_id}/events` does not stop that task. The events endpoint accepts `Last-Event-ID` or `last_seq` and reports `replay.truncated` when necessary. At this revision its ring retains 1,000 events **in memory**. Unsubscribed transports are eligible for cleanup once they are more than five minutes old, even if a run remains active; status and control continue separately. [Runs implementation][runs] [API stream cleanup][api-source]

With an explicit `Idempotency-Key`, Hermes reserves `(scope, key)` transactionally in `$HERMES_HOME/runs_idempotency.db` before starting a run. The same request fingerprint reuses the original run; a different payload under the same key conflicts. The retention contract is 24 hours for the ordinary terminal records, rather than the unrelated five-minute in-memory deduplication described for some OpenAI-compatible requests. The store retains the fingerprint and public status, **not the request body or an executable continuation**. A run without a key has no corresponding durable admission reservation. [Runs idempotency store][run-store] [Runs admission/recovery][runs]

The store can fall back to process memory when durable storage cannot open. `/v1/capabilities` exposes whether Runs idempotency is durable. A client or host that depends on durable admission must check that value and keep the database on persistent storage. After an owning process dies, a retained active run is reconciled to **`interrupted`**; retrying its original key returns that run rather than silently restarting execution. A new deliberate continuation is a new action. [Run store][run-store] [Runs restart handling][runs]

For a future Runs driver, persist the run ID, original admission key, and exact submission identity locally before relying on recovery. Then reconcile status/history after an ambiguous network result. This would extend Perch's present in-memory connection behavior; it is not implemented by this document. It does not authorize automatic replay of other mutations or a new key after an uncertain tool effect.

The session convenience stream has different semantics: the inspected `/api/sessions/{session_id}/chat/stream` handler interrupts and drains its turn after the client disconnects. Use the independent Runs lifecycle if phone disconnection should leave that HTTP task running. Do not assume every endpoint named “stream” shares the Runs behavior. [Session streaming handler][api-source]

## What is actually durable?

Durability below assumes the relevant storage survives, can be reopened consistently, and is assigned to the intended Hermes profile. A process restart and a replacement container with an empty filesystem are different failures.

| State or execution path | What survives / recovers | What that does not guarantee |
| --- | --- | --- |
| **Conversation and tool transcript** | SQLite `state.db` stores sessions, messages, tool history, usage, and lineage; compression retains storage relationships. | All live deltas, pending threads/futures, or every projection's IDs survive unchanged. |
| **Memory and skills** | Memory files under `memories/` and skill files under `skills/` survive with the profile directory. | Model weights changed, every experience was learned, or a skill is a durable running job. |
| **Responses continuity** | The response store can use `response_store.db` for response/conversation continuation. | Unlimited retention: this source has a 100-response LRU bound and can fall back to memory. |
| **Keyed HTTP Runs** | Admission reservation and status can survive in `runs_idempotency.db`; dead-owner runs become interrupted. | A submitted run automatically resumes its old executor after restart, or its SSE stream is durable. |
| **TUI interrupted turn** | A fresh, eligible marker can cause cold resume to start bounded auto-continuation. | Guaranteed marker admission, restoration of exact execution state, or preserved approval waits. |
| **Ordinary messaging gateway turn** | Durable interrupted-turn markers, delivery state, and startup recovery can continue eligible unreplied turns or finish owed delivery. | Every API/TUI job follows the same recovery path, or every third-party delivery is exactly once. |
| **Cron definitions and occurrences** | Persisted jobs and an execution ledger retain schedules and execution outcomes; dispatch/recovery rules avoid several duplicate windows. | Every missed occurrence is replayed, or an abandoned execution with uncertain effects is automatically retried. |
| **Working files and remote tools** | Files survive according to the host volume or selected remote execution backend. | Saving chat history also saves every remote sandbox, browser state, subprocess, or output file. |

Sources: [session storage][session-storage], [memory guide][memory], [API stores][api-source], [Runs store][run-store], [TUI recovery][auto-continue], [gateway startup][gateway-startup], [cron internals][cron-guide], [execution ledger][cron-executions], and [terminal backends][terminal-backends].

### The core records tool intent and results, with an unavoidable effect window

The inspected agent stages the assistant tool-call message and flushes it to the session database **before executing tool side effects**. A failed persistence step prevents that batch from proceeding. After execution, tool results are appended and flushed **before** the completion callback projects them to the client. These are meaningful recovery boundaries; Hermes is doing more than writing a final conversation transcript after a whole turn completes. [Tool-round ordering][tool-round] [Tool executor][tool-executor] [Session persistence][session-persistence]

There remains a failure window between an external side effect and its recorded result. A command may finish, a service may accept a request, or a file may change before Hermes commits the corresponding completion. The executor explicitly represents some unfinished tool outcomes with an unknown effect disposition. Restoring a database, replaying a transcript, or sending a recovery prompt cannot prove that repeating such an effect is safe. Any requirement for exactly-once effects needs tool-specific idempotency or reconciliation with the system that owns the effect. This conclusion follows from the inspected execution order. [Tool executor][tool-executor]

Provider retries, fallback, and backoff are also present in the running agent. They improve transient request handling, but do not by themselves establish a persisted retry continuation or a universal provider/tool idempotency contract across process death. [API error/retry handling][api-errors] [Retry helpers][retry-utils]

### Ordinary messaging recovery is real, and has conditions

On gateway startup, the messaging path reconciles durable turn markers and unreplied work. Eligible recent interruptions can schedule a new recovery turn; ownership, suspended-session, origin/adapter readiness, freshness, and restart-loop guards apply. If a final reply was persisted but not delivered, the recovery path can use delivery bookkeeping instead of asking the model to redo the work. Repeated restart failures can suspend recovery. [Gateway lifecycle guide][gateway-lifecycle] [Startup implementation][gateway-startup] [Completion delivery guide][delivery-guide]

This path serves ordinary gateway-origin conversations. The API Runs executor has its own interrupted-run behavior, and the TUI has its separate cold-resume marker behavior. “Hermes resumes after restart” needs to name which of these paths is meant. Conversely, saying that all Hermes work is simply abandoned on restart would omit implemented recovery. [Gateway startup][gateway-startup] [Runs][runs] [TUI recovery][auto-continue]

### Cron persists schedules and tracks uncertain executions

Cron job definitions live in `$HERMES_HOME/cron/jobs.json`; each firing uses a fresh agent session with a self-contained task and persistent memory available. The scheduler does not simply reuse an interactive chat's complete context or clarification UI. The API also exposes job-management routes, separate from the chat/run contract. [Cron guide][cron-guide] [Cron jobs source][cron-jobs] [Job API handlers][api-source]

The execution ledger in `$HERMES_HOME/cron/executions.db` records states such as claimed, running, completed, failed, and unknown. Abandoned executions with uncertain effects are reconciled to **unknown**, not indiscriminately queued for retry. Occurrence bookkeeping advances schedules and preserves a pending slot to cover a pre-dispatch gap; completed scheduled occurrences can be recognized. Missed-run handling uses grace/catch-up policies instead of replaying every missed tick. A separate worker may outlive a gateway-process restart on the same host, but that does not establish recovery after destruction of its container or remote environment. [Execution ledger][cron-executions] [Occurrence rules][cron-occurrences] [Cron internals][cron-guide]

## Hosting and the Cloudflare boundary

Hermes is a Python application with host processes and tool backends. The current source comments and installation instructions target **Python 3.14**; the metadata range `>=3.11,<3.15` also permits older installations to pass through the updater and should not be read as an equivalent current support promise for every version. The official Docker layout separates the immutable application under `/opt/hermes` from writable `HERMES_HOME` under `/opt/data`. The project also documents non-Linux installations, so “Linux-only application” would overstate the requirement. [Package metadata][package] [Installation][installation] [Docker guide][docker]

The inspected built-in terminal execution backends are **local, Docker, Singularity, Modal, Daytona, Vercel Sandbox, and SSH**, with an extension point for additional environment plugins. A remote terminal backend changes where commands and files execute; it does not automatically move the Python agent, gateway, SQLite state, or scheduler into that environment. [Backend registry][terminal-backends] [Environment plugin guide][environment-plugin]

No built-in Cloudflare terminal backend or official Hermes-on-Cloudflare host recipe was found in the inspected canonical hosting/integration documentation and backend registry. Hermes skills for deploying generated Workers/sites, and community Cloudflare inference/search integrations, do not establish such a host recipe. Running the Python service in a suitable Cloudflare-managed container would therefore be an infrastructure integration to validate, not an official Hermes compatibility guarantee established by these sources. See [the Cloudflare assessment](ASSISTANT-CLOUDFLARE.md) for platform-side execution and persistence constraints.

For any container host, preserve the **resolved profile home and required workspaces**, not only `state.db`. That includes whichever memory/skill files, response/run stores, cron stores, crash markers, configuration, and generated files the selected features use. Remote backend files have their own lifecycle. Use a consistent SQLite backup mechanism: Hermes's backup helper uses SQLite's backup API specifically to include committed data still present in WAL; copying only the main database file while it is live can miss that data. Object storage can hold a backup, but does not make an arbitrary live SQLite file safe for concurrent replicas. [Docker guide][docker] [SQLite backup helper][backup-sqlite] [Session storage][session-storage] [Memory guide][memory]

## Smallest useful validation before implementation

The source supports an integration decision, but the following checks would resolve the material uncertainties for a real Perch driver:

1. **Choose one transport and pin it.** For the recommended TUI route, verify the dashboard authentication/ticket handshake from Expo and record the gateway capability response. For Runs, require the expected endpoints and inspect `runs_idempotency.durable`.
2. **Exercise native interaction with controlled fixtures.** Verify an approval, a text clarification, a multi-question/unsupported request, host cancellation, stale answers, interruption, and steering. The test must check host acknowledgment and resulting state, not just that the phone wrote bytes.
3. **Disconnect and reconnect during useful work.** Check snapshot/replay truncation, a changed process epoch, cold-resume auto-continuation, phone backgrounding, and a pending request. Confirm that the adapter never manufactures a resend after ambiguous submission.
4. **Inspect recovery around real boundaries using harmless effects.** Stop the process after a tool intent is persisted and after an observable local effect but before its result is recorded. Check the resulting transcript, effect disposition, transport-specific recovery, and persisted Runs status. Source inspection alone is not a crash-test result.
5. **Verify complete artifacts and stable history.** Use a large write, two concurrent calls to the same tool, compression, a process restart, and an actual downloaded file. Verify bytes and identity separately from preview text and success status.

No app adapter, new server service, deployment, or runtime test is included in this research. A future implementation can stay inside Perch's existing host/driver/session-store boundary while making these supported capabilities and recovery conditions explicit.

## Primary sources

### Official documentation

- [Programmatic integration][integration]
- [API server][api-guide]
- [ACP internals][acp]
- [Python library use][python]
- [Web dashboard][dashboard]
- [Adding platform adapters][platform-adapters]
- [Session storage][session-storage]
- [Memory][memory]
- [Gateway session lifecycle][gateway-lifecycle]
- [Completion backlog delivery][delivery-guide]
- [Cron internals][cron-guide]
- [Installation][installation]
- [Docker][docker]
- [Terminal environment plugins][environment-plugin]

### Pinned implementation

Implementation links throughout this document point to the inspected commit. The decisive paths are `gateway/platforms/api_server*.py`, `tui_gateway/`, `agent/turn_tool_round.py`, `agent/tool_executor.py`, `agent/session_persistence.py`, `gateway/run_startup.py`, `cron/`, and the dashboard file/session routers. The repository copy was read; upstream tests and runtime behavior were not executed.

[repo]: https://github.com/NousResearch/hermes-agent
[commit]: https://github.com/NousResearch/hermes-agent/commit/0e37a439bda15ef3c28a4d20593964d7c6a527a6
[integration]: https://hermes-agent.nousresearch.com/docs/developer-guide/programmatic-integration
[api-guide]: https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server
[acp]: https://hermes-agent.nousresearch.com/docs/developer-guide/acp-internals
[python]: https://hermes-agent.nousresearch.com/docs/guides/python-library
[dashboard]: https://hermes-agent.nousresearch.com/docs/user-guide/features/web-dashboard
[platform-adapters]: https://hermes-agent.nousresearch.com/docs/developer-guide/adding-platform-adapters
[session-storage]: https://hermes-agent.nousresearch.com/docs/developer-guide/session-storage
[memory]: https://hermes-agent.nousresearch.com/docs/user-guide/features/memory
[gateway-lifecycle]: https://hermes-agent.nousresearch.com/docs/developer-guide/gateway-session-lifecycle
[delivery-guide]: https://hermes-agent.nousresearch.com/docs/developer-guide/completion-backlog-delivery
[cron-guide]: https://hermes-agent.nousresearch.com/docs/developer-guide/cron-internals
[installation]: https://hermes-agent.nousresearch.com/docs/getting-started/installation
[docker]: https://hermes-agent.nousresearch.com/docs/user-guide/docker
[environment-plugin]: https://hermes-agent.nousresearch.com/docs/developer-guide/terminal-environment-plugin
[package]: https://github.com/NousResearch/hermes-agent/blob/0e37a439bda15ef3c28a4d20593964d7c6a527a6/pyproject.toml
[ws]: https://github.com/NousResearch/hermes-agent/blob/0e37a439bda15ef3c28a4d20593964d7c6a527a6/tui_gateway/ws.py
[events]: https://github.com/NousResearch/hermes-agent/blob/0e37a439bda15ef3c28a4d20593964d7c6a527a6/tui_gateway/contracts/events.py
[tool-progress]: https://github.com/NousResearch/hermes-agent/blob/0e37a439bda15ef3c28a4d20593964d7c6a527a6/tui_gateway/tool_progress.py
[requests]: https://github.com/NousResearch/hermes-agent/blob/0e37a439bda15ef3c28a4d20593964d7c6a527a6/tui_gateway/contracts/server_requests.py
[request-runtime]: https://github.com/NousResearch/hermes-agent/blob/0e37a439bda15ef3c28a4d20593964d7c6a527a6/tui_gateway/server_requests.py
[session-contracts]: https://github.com/NousResearch/hermes-agent/blob/0e37a439bda15ef3c28a4d20593964d7c6a527a6/tui_gateway/contracts/sessions.py
[config-set]: https://github.com/NousResearch/hermes-agent/blob/0e37a439bda15ef3c28a4d20593964d7c6a527a6/tui_gateway/methods_config_set.py
[prompt-voice]: https://github.com/NousResearch/hermes-agent/blob/0e37a439bda15ef3c28a4d20593964d7c6a527a6/tui_gateway/contracts/prompt_voice.py
[history-source]: https://github.com/NousResearch/hermes-agent/blob/0e37a439bda15ef3c28a4d20593964d7c6a527a6/tui_gateway/session_history.py
[replay]: https://github.com/NousResearch/hermes-agent/blob/0e37a439bda15ef3c28a4d20593964d7c6a527a6/tui_gateway/event_replay.py
[lifecycle]: https://github.com/NousResearch/hermes-agent/blob/0e37a439bda15ef3c28a4d20593964d7c6a527a6/tui_gateway/session_lifecycle.py
[tui-server]: https://github.com/NousResearch/hermes-agent/blob/0e37a439bda15ef3c28a4d20593964d7c6a527a6/tui_gateway/server.py
[auto-continue]: https://github.com/NousResearch/hermes-agent/blob/0e37a439bda15ef3c28a4d20593964d7c6a527a6/tui_gateway/session_auto_continue.py
[turn-markers]: https://github.com/NousResearch/hermes-agent/blob/0e37a439bda15ef3c28a4d20593964d7c6a527a6/tui_gateway/turn_marker.py
[api-source]: https://github.com/NousResearch/hermes-agent/blob/0e37a439bda15ef3c28a4d20593964d7c6a527a6/gateway/platforms/api_server.py
[runs]: https://github.com/NousResearch/hermes-agent/blob/0e37a439bda15ef3c28a4d20593964d7c6a527a6/gateway/platforms/api_server_runs.py
[run-store]: https://github.com/NousResearch/hermes-agent/blob/0e37a439bda15ef3c28a4d20593964d7c6a527a6/gateway/platforms/api_server_run_idempotency.py
[toolsets]: https://github.com/NousResearch/hermes-agent/blob/0e37a439bda15ef3c28a4d20593964d7c6a527a6/toolsets.py
[dashboard-sessions]: https://github.com/NousResearch/hermes-agent/blob/0e37a439bda15ef3c28a4d20593964d7c6a527a6/hermes_cli/web_routers/sessions.py
[dashboard-files]: https://github.com/NousResearch/hermes-agent/blob/0e37a439bda15ef3c28a4d20593964d7c6a527a6/hermes_cli/web_routers/files.py
[browser-artifacts]: https://github.com/NousResearch/hermes-agent/blob/0e37a439bda15ef3c28a4d20593964d7c6a527a6/gateway/browser_control_artifacts.py
[tool-round]: https://github.com/NousResearch/hermes-agent/blob/0e37a439bda15ef3c28a4d20593964d7c6a527a6/agent/turn_tool_round.py
[tool-executor]: https://github.com/NousResearch/hermes-agent/blob/0e37a439bda15ef3c28a4d20593964d7c6a527a6/agent/tool_executor.py
[session-persistence]: https://github.com/NousResearch/hermes-agent/blob/0e37a439bda15ef3c28a4d20593964d7c6a527a6/agent/session_persistence.py
[api-errors]: https://github.com/NousResearch/hermes-agent/blob/0e37a439bda15ef3c28a4d20593964d7c6a527a6/agent/turn_api_error.py
[retry-utils]: https://github.com/NousResearch/hermes-agent/blob/0e37a439bda15ef3c28a4d20593964d7c6a527a6/agent/retry_utils.py
[gateway-startup]: https://github.com/NousResearch/hermes-agent/blob/0e37a439bda15ef3c28a4d20593964d7c6a527a6/gateway/run_startup.py
[cron-jobs]: https://github.com/NousResearch/hermes-agent/blob/0e37a439bda15ef3c28a4d20593964d7c6a527a6/cron/jobs.py
[cron-executions]: https://github.com/NousResearch/hermes-agent/blob/0e37a439bda15ef3c28a4d20593964d7c6a527a6/cron/executions.py
[cron-occurrences]: https://github.com/NousResearch/hermes-agent/blob/0e37a439bda15ef3c28a4d20593964d7c6a527a6/cron/occurrences.py
[terminal-backends]: https://github.com/NousResearch/hermes-agent/blob/0e37a439bda15ef3c28a4d20593964d7c6a527a6/tools/terminal_tool_backends.py
[backup-sqlite]: https://github.com/NousResearch/hermes-agent/blob/0e37a439bda15ef3c28a4d20593964d7c6a527a6/hermes_cli/backup_sqlite.py
