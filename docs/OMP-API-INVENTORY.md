# OMP integration API inventory

> **Version note:** This inventory records the pinned pre-0.9 baseline.
> [Perch 0.9 additions](TERN-OMP-0.9.md) cover the new session controls,
> captured file downloads, pane focus and diagrams.
> [Runtime qualification](RUNTIME-QUALIFICATION-2026-10-10.md) adds the supplied
> Tern 0.7 and OMP executable evidence.

Reviewed on **10 October 2026** for Perch's native mobile client. This inventory
maps the upstream integration contracts. Perch's shipped request behavior is
recorded separately in [REMOTE-REQUESTS.md](REMOTE-REQUESTS.md) and the
[OMP owner-request investigation](OMP-OWNER-REQUESTS-RESEARCH.md). For the
cross-layer implementation status, start with the
[Tern + OMP integration map](TERN-OMP-INTEGRATION-MAP.md).

## Reading this map

**An API available to an OMP host is not automatically an API of an already
running OMP terminal session.** This distinction determines whether Perch can
adopt a feature through its current bridge or needs a different host runtime.

| Route | Where it runs | Existing interactive OMP process? | What the phone would need |
| --- | --- | --- | --- |
| Tern TSP surface | OMP renders semantic terminal nodes; a Tern plugin reads them and dispatches events | **Yes** | Perch's existing Tern adapter; native projections for each supported control |
| OMP extension | TS/JS factory loaded inside the user's OMP process | **Yes** | A host extension and authenticated transport; only its documented live context/actions are available |
| Collab | Encrypted WebSocket session replication, controlled by the original OMP host | **Yes** | A Collab guest implementation and an appropriately scoped link |
| SDK | `createAgentSession()` inside a Bun/TypeScript host | **No automatic attachment** | A service that owns the AgentSession and exposes a mobile protocol |
| RPC / RPC UI | `omp --mode rpc` or `omp --mode rpc-ui`, JSONL over stdio | **No automatic attachment** | A host process supervisor, protocol implementation and mobile transport |
| ACP | `omp acp`, ACP JSON-RPC over stdio | **No automatic attachment** | An ACP host with permissions, elicitations and the desired optional capabilities |
| Stored session / export | Files or an explicitly supplied storage backend | **History only** | A reader/importer; opening history does not recover the live process or its promises |

Sources: [SDK][sdk-doc], [RPC reference][rpc-doc], [ACP implementation][acp],
[Collab][collab-doc], [extension types][ext-types], [TSP grammar][tsp].

### Evidence and version boundary

- Source inspected: OMP commit
  **`b07a1c146d0d12cfc855a2c65d52f892ef319040`**, which reports **18.8.7**.
- Perch's exercised dependency is the separately installed **18.8.7** package
  pinned by `server/omp-remote/upstream/bun.lock`. A matching version string
  does not mean these two trees are identical. The earlier runtime tests found
  a HookSelector option in the checkout that was absent from the installed
  package. [Runtime qualification](OMP-OWNER-REQUESTS-RESEARCH.md#version-qualification).
- Official live documentation checked: [SDK](https://omp.sh/docs/sdk),
  [RPC](https://omp.sh/docs/rpc), [ACP](https://omp.sh/docs/acp),
  [extension authoring](https://omp.sh/docs/extension-authoring), and
  [Collab](https://omp.sh/docs/collab). These are rolling documentation, not a
  substitute for the host's version/capability handshake.
- Current upstream `main` was separately compared at
  **`d46bd42f39e82d41b4a04c022fb94e595bd8c3c8`**, a commit dated
  **12:55:26 UTC on 10 October 2026** in the GitHub API. The pinned checkout and installed runtime
  were not changed. Relevant differences are listed below.
- Counts below were computed from the pinned source: **67 RPC command names**,
  **48 extension event names**, and **42 TSP node kinds**. These are different
  layers with overlapping features; adding their counts would not measure
  Perch feature coverage. [Command schema][rpc-schema], [extension types][ext-types],
  [TSP grammar][tsp].
- This inventory is a source and documentation audit. It does not claim that
  previously unimplemented Perch routes were exercised on a physical phone.

**Availability terms:** *available* means an upstream contract exists;
*conditional* means mode, capability, state or implementation restrictions
apply; *blocked on this route* means that particular contract cannot perform
the requested action. It does not mean the feature can never be built.

### Changes between the exercised baseline and current upstream main

The SDK entry points, AgentSession, SessionManager, RPC command schema/mode,
ACP mode, ExtensionAPI types/runner, Collab and native event backend have no
changes between the two revisions. The **67 / 48 / 42** inventories therefore
also describe current main for those surfaces. The ACP no-form plan fallback
described in section 4 is unchanged. This is a bounded source comparison,
not a runtime qualification of current main. [Compared revisions][current-diff].

| Newly available or changed on current main | Exact change | Integration consequence |
| --- | --- | --- |
| Extra instruction filenames | `cfgContextFilesExtra`, setting `contextFiles.extra`; `ContextFile.additive`; `loadCustomContextFiles`; exported `boundSettings()` | A host can load additional named context files alongside built-ins; config-file setting, not a new mobile endpoint |
| Native code preview | `TspCodeProps.preview` | Native reader may need to distinguish preview from full displayed code |
| Native tool header | `TspToolProps.command`, `NativeToolHead.command` | Original command can be offered for explicit copy |
| Native tool disclosure | `TspToolProps.preview` and `NativeToolView.preview` add `"children"` | Child ANSI/code blocks can own their own preview bounds |
| Native tool renderer context | `RenderResultOptions.elapsedMs`, `cancelled` | Better duration and abandoned-call indicators |
| Native run presentation | `runFoot`, `runInput`, `runOutput`, `runBox`, `RunState`, `RunFootInput`, `RUN_INPUT_PREVIEW_LINES` | More semantic input/output/status grouping for shell/eval |
| Annotation editing | `TextReviewOverlayResult.editedText`; external-editor callbacks and source replacement | Edited source and its notes must stay aligned; local file review keeps frozen-diff semantics |
| Usage presentation | `ProviderCard.notes`; more precise native footnotes for absent quota data | Avoid interpreting missing usage reports as unlimited allowance |

Sources: [current context settings][current-context],
[current TSP types][current-tsp], [current tool renderer][current-renderer],
[current run presentation][current-native-view],
[current annotations][current-annotations], [current usage view][current-usage].

## 1. SDK: a service that owns OMP

The public entry package is `@oh-my-pi/pi-coding-agent`. Its main exports include
SDK construction/discovery, `AgentSession`, `SessionManager`, storage adapters,
auth/model configuration, extension/custom-tool contracts, run modes, task
execution, tool types, and UI helpers. It also publishes many deep source
subpaths. **A deep export is not evidence of a stable mobile wire API.** Prefer
the documented host contracts and isolate version-specific adapters.
[Package exports][package], [main barrel][index].

### Construction and configuration

| Surface | Exact entry points / options | What Perch could build | Conditions |
| --- | --- | --- | --- |
| Session construction | `createAgentSession(options)`; `CreateAgentSessionOptions`, `CreateAgentSessionResult` | Start an OMP conversation in a self-hosted service | Owns a new runtime; does not attach to a TUI process |
| Workspace | `cwd`, `additionalDirectories`, `agentDir`, `workspaceTree` | Project picker and allowed workspace roots | Host filesystem paths, not phone paths |
| Persistence | `sessionManager` | Durable conversation/history service | Artifacts, files and process state need separate treatment |
| Credential/model wiring | `authStorage`, `modelRegistry`, `getApiKey`, `oauthAccountPools`, `credentialSourceSessionId` | Use the host's provider credentials and account pools | Auth storage and registry must be consistently wired; do not return credentials as model-list data |
| Model selection | `model`, `modelPattern`, `scopedModels`, `thinkingLevel`, `thinkingLevelCeiling`, `openAIServiceTier` | Provider/model/effort controls | Available models reflect host auth and discovery |
| Routing | `prewalk`, `deferredPrewalk`, `planYolo`, retry fallback options | Separate planning and execution models | `planYolo` explicitly changes approval behavior; it is not a remote approval resolver |
| Prompt composition | `systemPrompt`, `systemPromptTemplate`, `customSystemPrompt`, `appendSystemPrompt`, `titleSystemPrompt` | Workspace policy and tailored assistant roles | Distinct replacement/append semantics |
| Provider identity/cache | `providerSessionId`, `providerPromptCacheKey`, `providerPromptCacheKeySource`, cache-warming/service-tier resolvers | Stable provider conversation/cache identity across owned runs | Does not preserve an in-flight network request |
| Tools | `customTools`, `toolNames`, `restrictToolNames`, `allowRestrictedCustomTools` | App-connected tools | `toolNames` alone is not an allowlist; restricted custom tools need explicit opt-in |
| Extensions | `extensions`, `additionalExtensionPaths`, `disableExtensionDiscovery`, prepared-extension options | Reuse configured integrations in a managed agent | Factory/session ownership matters |
| Discovery inputs | `skills`, `rules`, `contextFiles`, `promptTemplates`, `slashCommands` | Host-owned capability catalog | Omission uses discovery; explicit values override discovery |
| MCP/LSP | `enableMCP`, `mcpManager`, `mcpTools`, `enableLsp`, `lspReadOnly` | Coding tools and external services | Dependencies and credentials remain on the executing host |
| UI bridge | `hasUI`, `interactivePrompts`; returned `setToolUIContext(ui, hasUI)` | Native question dialogs in a service-owned session | Tool UI and extension-runner UI are distinct wiring points; enabling a flag does not implement the UI |
| Settings / telemetry | `settings`, `eventBus`, `subagentEventBus`, `telemetry`, `deadline` | Configuration, progress and trace export | OpenTelemetry requires an installed host SDK; events are not durable by themselves |
| Child orchestration | `agentRegistry`, `agentId`, `agentName`, `parentAgentId`, `taskDepth`, `parentTaskPrefix`, `outputSchema`, `outputSchemaMode`, `requireYieldTool`, `bindProcessState` | Multi-agent workspaces and structured results | Give independent top-level sessions separate AgentRegistry instances |

Sources for this table: [SDK guide][sdk-doc], [SDK declarations and implementation][sdk],
[AgentSession types][session-types].

Discovery helpers include `discoverAuthStorage`, `discoverExtensions`,
`discoverSessionExtensionPaths`, `loadSessionExtensions`,
`loadCliExtensionProviders`, `discoverSkills`, `discoverContextFiles`,
`discoverPromptTemplates`, `discoverSlashCommands`, `discoverCustomTSCommands`,
`discoverMCPServers`, and `buildSystemPrompt`. The returned session result also
contains extension load errors/results, optional `mcpManager`, model fallback
notice, LSP startup states, buses, and `startBackgroundModelDiscovery()`.
[SDK source][sdk].

### Session control, state and output

All rows in this table are available on a **host-owned `AgentSession`**. They are
not automatically exposed to a general extension's context or to Collab guests.

| Area | Representative public class members | Native client opportunity |
| --- | --- | --- |
| Prompt and interruption | `prompt`, `steer`, `followUp`, `sendUserMessage`, `abort`, `retry` | Send, steer, follow up, stop and retry |
| Queued input | `getQueuedMessages`, `removeQueuedMessage`, `takeQueuedMessage`, `promoteQueuedMessage`, `popLastQueuedMessage`, `clearQueue`; steering/follow-up/interrupt mode setters | Editable queue with explicit delivery timing |
| Streaming | `subscribe`, `subscribeRunState`, `activeToolExecutionUpdates`, `subscribeCommandMetadataChanged` | Text/thinking/tool progress; live command menu |
| Lifecycle | `waitForIdle`, `waitForAdmittedSubmissions`, `settleAsyncWork`, `beginDispose`, `dispose`, `addDisposer` | Background service lifecycle and controlled shutdown |
| History | `messages`, `getImageAttachments`, `buildDisplaySessionContext`, `buildTranscriptSessionContext`, `getLastAssistantMessage`, `getLastAssistantText` | Rich timeline and attachment views |
| Session identity | `sessionId`, `sessionFile`, `sessionName`, `state`, `isStreaming`, `isAborting`, `isSessionTransitioning` | Correct identity and state indicators |
| New / restored conversations | `newSession`, `switchSession`, `freshSession`, `resetSessionContext`, `fork`, `branch`, `navigateTree`, `moveSession` | Session browser, forks and branch explorer |
| Titles / discovery refresh | `setSessionName`, `renameTitle`, `generateTitle`, `reload`, `refreshSkillsAndCommands` | Rename and refresh integrations |
| Models | `getAvailableModels`, `setModel`, `cycleModel`, `setScopedModels`, `resolveRoleModel`, `resolveRoleModelWithThinking`, role-model cycling | Provider, model and role selection |
| Thinking / service tiers | `setThinkingLevel`, `cycleThinkingLevel`, `getAvailableThinkingLevels`, `getAvailableEffortSelectors`, `setServiceTierFamily`, fast/slow mode getters/setters | Model-specific reasoning and latency controls |
| Tools | `getAllToolInfos`, `getAllToolNames`, `getActiveToolNames`, `getToolByName`, `setActiveToolsByName`, `refreshMCPTools`, `refreshRpcHostTools` | Capability catalog and host-mediated tool selection |
| Context maintenance | `compact`, `abortCompaction`, `setAutoCompactionEnabled`, `dropImages`, `shake`, `setCacheWarmingMode`, `handoff`, `abortHandoff` | Context meter, compaction and handoff actions |
| Reliability | `setAutoRetryEnabled`, `abortRetry`, `isRetrying`, `retryAttempt`, `cacheWarmingStatus`, `emitNotice` | Explain retry and maintenance pauses |
| Plan / goal / vibe state | `getPlanModeState`, `setPlanModeState`, `preparePlanForReview`, `peekPlanProposalHandler`, `setPlanProposalHandler`, plan reference methods; goal/vibe state and context methods | A host-owned plan workflow |
| Task lists | `getTodoPhases`, `setTodoPhases`, workpool yield methods | Task board with host state |
| Background jobs | `getAsyncJobSnapshot`, `inspectAsyncJob`, `cancelAsyncJob`, `hasPendingAsyncWork`, `asyncJobManager` | Running jobs, inspect/cancel, delivery status |
| Shell / evaluation | `executeBash`, `abortBash`, `executePython`, `abortEval`, result-recording methods | A deliberate remote command surface |
| Side turns / agent messages | `runEphemeralTurn`, `deliverIrcMessage`, `drainPendingIrcInboxMessages`, `waitForIrcReplies`, `branchFromBtw` | Side questions and agent collaboration |
| Usage / cost | `getSessionStats`, `getContextUsage`, `getContextBreakdown`, `fetchUsageReports`, usage-limit state, account listing/pinning | Context, cost and provider allowance views |
| Export | `exportToHtml`, `formatSessionAsText`, archive/LLM-request dump methods, `flushToDisk` | Downloadable conversation and diagnostics |
| Advisors | advisor configuration/status/history/cost methods, `setAdvisorEnabled`, `getAdvisorAgent` | Advisor activity panel |
| Client IO | `setClientBridge`, `clientBridge` | Route supported files/terminals/permissions to a host |

Source: [AgentSession class][session]. Lower-level members used by OMP's own
mode controllers should be version-pinned behind the host adapter. In
particular, installing a plan handler in a session one owns is a different
operation from resolving an already open `InteractiveMode` plan dialog.

### Stream events and completion semantics

Core event families are `agent_start/end`, `turn_start/end`,
`message_start/update/end`, and `tool_execution_start/update/end`. Assistant
updates carry text, thinking and tool-call deltas. Session events add
compaction, retry, fallback, model/effort changes, configuration warnings,
advisor cost/yield, TTSR, todo reminders/clear, IRC messages, notices, goals,
queue updates and cache warming. [Event union][session-events].

`agent_end` does not invariably mean finished: `isTerminal: false` denotes a
possible continuation. `yielded` and `awaitingAsyncWork` further distinguish
maintenance and background-result waits. Event listeners are notifications;
an async listener is not a backpressure mechanism. A mobile bridge must retain
its own ordered event/snapshot state. [SDK event contract][sdk-doc],
[event union][session-events].

## 2. Storage, history, artifacts and recovery

| Surface | API | What it gives Perch | What it does not give |
| --- | --- | --- | --- |
| Creation / open / discovery | `SessionManager.create`, `inMemory`, `open`, `continueRecent`, `list`, `listAll`, `listForPicker`, `listAllForPicker`, `forkFrom`, relocation helpers | Host conversation catalog and restored history | An attachment to another live process |
| Identity / metadata | `getSessionId`, `getSessionFile`, `getSessionDir`, `getCwd`, `getHeader`, `getSessionName`, `setSessionName`, title-change listener | Stable session identity, title and location | A network endpoint |
| Tree reads | `getEntries`, `getEntry`, `getChildren`, `getBranch`, `getBranchView`, `getTree`, `getLeafId`, `getLabel`, `buildSessionContext` | Full branching history | Terminal UI state or pending promise reconstruction |
| Tree mutations | `appendMessage`, `appendCustomEntry`, mode/model/thinking/tier entries, labels, `branch`, `branchWithSummary`, `createBranchedSession` | Durable metadata and branches | Permission to bypass AgentSession lifecycle hooks; prefer AgentSession for live transitions |
| Workspace roots | `getAdditionalDirectories`, add/remove/set directory methods | Multiple host roots | Automatic phone file synchronization |
| Drafts | `saveDraft`, `consumeDraft` | Restorable composer draft | Pending modal response recovery |
| Persistence lifecycle | `ensureOnDisk`, `flush`, `flushSync`, `close`, `seal`, `onPersistenceError`, `onPersistenceNotice`, `recoverPersistenceFromCurrentState` | Explicit persistence/error boundary | File writes do not imply fsync or power-loss durability |
| Backends | `FileSessionStorage`, `MemorySessionStorage`, `SqlSessionStorage`, `RedisSessionStorage`, `IndexedSessionStorage`, `SessionStorageBackend` | File, memory, PostgreSQL/MySQL/SQLite or Redis transcripts; custom backend seam | SQL/Redis transcript storage does not move artifact/image data |
| Cross-writer safety | `claimSession`, publish locks, expected-size write guards; `SessionWriteConflictError` | Protection for cooperating local writers / backend mutations | A general distributed lease, object-store checkpoint or exactly-once external effects |
| Artifact store | `ArtifactManager`; `SessionManager.getArtifactManager`, `allocateArtifactPath`, `saveArtifact`, `getArtifactPath`, `getArtifactsDir` | Original host tool outputs and generated-file references | An authenticated mobile download endpoint |
| Blob store | `SessionManager.putBlob`, `putBlobSync`, blob-backed transcript content | Image and binary attachment storage | Automatic off-host blob replication |
| Export / import | HTML export, session dump formats/loaders/migrations, CLI resume/continue/fork/import options | Offline readers and migrations | Resume from the instruction pointer of a killed agent |

Sources: [SessionManager][manager], [storage contract][storage],
[indexed backend contract][indexed-storage], [SQL example][sql-example],
[Redis example][redis-example], [artifacts][artifacts],
[session operations][session-ops].

**Recovery boundary:** storage can reconstruct conversation state, model/effort
records, custom entries, branches and referenced artifacts when those files
also survive. It does not serialize JavaScript promises, a pending stock
approval, PTY processes, live tool connections, in-flight provider streams or
every background job. An R2-backed design needs an owner/lease, checkpoint
publication, artifact/blob synchronization and a restart policy outside these
interfaces. The upstream SQL/Redis examples explicitly leave tool artifacts and
image blobs in local storage. [SQL example][sql-example], [Redis example][redis-example],
[storage contract][storage].

## 3. RPC: all 67 commands

RPC is a **custom JSONL stdio protocol**, not JSON-RPC 2.0. It controls the
subprocess started in that mode. The canonical machine-readable schema already
describes all commands and shared wire types; Perch should generate or reuse
types rather than duplicate them by hand. TypeScript, Python, Rust and Go
clients are included upstream. [RPC reference][rpc-doc], [wire schema][rpc-schema].

| Command group | Exact wire `type` values | Possible Perch interface |
| --- | --- | --- |
| Protocol | `negotiate_protocol` | Version negotiation and transport limits |
| Prompt / queue | `prompt`, `steer`, `follow_up`, `remove_queued_message`, `promote_queued_message`, `abort`, `abort_and_prompt`, `abort_and_restore_queue` | Composer, interruption and editable queue |
| Session open | `new_session`, `open_session`, `switch_session` | New chat and host history |
| State / modes | `get_state`, `set_fast_mode`, `set_slow_mode`, `goal` | Session state, fast/slow controls, goal lifecycle |
| Rich questions | `set_ask_dialog` | Opt into an entire multi-question ask form |
| Command / history discovery | `get_available_commands`, `get_entries`, `get_tree` | Slash-command picker and conversation tree |
| Todo state | `set_todos` | Native task list |
| Host integration | `set_host_tools`, `set_host_uri_schemes` | Mobile/host service tools and virtual resources |
| Subagents | `set_subagent_subscription`, `get_subagents`, `get_subagent_messages`, `cancel_subagent`, `steer_subagent` | Agent roster, progress, transcripts, steer/cancel |
| Event volume | `set_event_filter` | Select event types; full or delta message updates |
| Live voice | `live_start`, `live_stop`, `live_mute` | Control the host machine's live voice runtime |
| Models | `set_model`, `cycle_model`, `get_available_models` | Dynamic host model catalog |
| Thinking | `set_thinking_level`, `cycle_thinking_level`, `get_available_thinking_levels` | Supported reasoning effort choices |
| Queue policy | `set_steering_mode`, `set_follow_up_mode`, `set_interrupt_mode` | All-at-once / one-at-a-time and immediate/wait controls |
| Context | `compact`, `set_auto_compaction`, `set_cache_warming` | Context maintenance controls |
| Retry | `set_auto_retry`, `abort_retry` | Retry policy and cancellation |
| Shell | `bash`, `abort_bash` | Explicit host command execution |
| Session details / export | `get_session_stats`, `export_html`, `get_last_assistant_text`, `set_session_name`, `handoff` | Usage, export, title and handoff |
| Branching | `branch`, `fork`, `get_branch_messages` | Branch/fork operations |
| Messages | `get_messages`, `get_messages_page` | Stable paged history |
| Provider authentication | `get_login_providers`, `login`, `get_logout_accounts`, `logout` | Host-mediated OAuth/account management |
| Composer assistance | `predict_word`, `predict_word_feedback` | Ghost-text predictions with acceptance feedback |
| Side questions | `btw`, `btw_cancel`, `get_btw_history` | Side conversation/history |

Source for every command: [canonical 67-command table][rpc-commands]. These
names describe upstream RPC availability; implementing one does not grant a
Collab guest that permission or control an unrelated TUI process.

### RPC callbacks and unsolicited frames

| Surface | Frames / methods | Meaning and limit |
| --- | --- | --- |
| UI questions | `extension_ui_request`: `select`, `confirm`, `input`, `editor`, opt-in `ask`, `cancel`; `extension_ui_response` | Actual request/response channel in this RPC process; responses correlate by request ID |
| UI presentation | `notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`, `open_url` | Native host renders its own equivalents; component factories do not cross the wire |
| Tools supplied by host | `host_tool_call`, `host_tool_cancel`; `host_tool_update`, `host_tool_result` | Agent invokes a host-owned tool; cancellation/progress use the same channel |
| URI schemes supplied by host | `host_uri_request`, `host_uri_cancel`; `host_uri_result` | Agent reads/writes the host's virtual resource; **not** a generic client-to-agent file-download command |
| Conversation events | AgentSession event frames | Stream text, thinking, tools and state changes |
| Lifecycle | `ready`, `response`, `prompt_result`, `session_settled` | Admission and completion are separate; IDs matter |
| Discovery / state notices | `available_commands_update`, `command_output`, `session_info_update`, `config_update`, `extension_error` | Commands and local side-channel output |
| Subagent observation | `subagent_lifecycle`, `subagent_progress`, `subagent_event` | Subscription level controls volume |
| Side questions | `btw_delta`, `btw_record` | Incremental and completed side answers |
| Voice | `live_phase`, `live_levels`, `live_transcript`, `live_end` | State/transcript of **host** microphone/speaker session; no phone PCM/media upload transport here |
| Large frames | `rpc_chunk`, `rpc_frame_error` | Lossless bounded v2 framing or explicit overflow |

Sources: [RPC reference][rpc-doc], [wire definitions][rpc-wire],
[live voice implementation][rpc-live].

### RPC limitations that affect the product

| Boundary | Observed contract | Consequence |
| --- | --- | --- |
| UI modes | `rpc-ui` enables tool UI; extension runner UI remains a separate switch | Choose mode and bridge deliberately |
| `--no-ui` | Extensions receive no-op UI. Tool approvals use the extension runner and fail closed when interactive approval is required. `rpc-ui --no-ui` can still emit tool ask dialogs | It cannot be used to obtain stock approval controls while disabling the corresponding runner UI |
| `ask` | Opt-in `set_ask_dialog` sends all questions, choices, descriptions/previews, multi-select and recommended indices | Better native form opportunity than replaying a TUI picker |
| `ask` timeout | Timeout selects each question's recommended choice, otherwise its first option | UI must clearly preserve actual timeout semantics; this is separate from tool approval |
| UI factories | Custom terminal components, header/footer/editor factories, raw keys, autocomplete composition, theme switching and expansion are unsupported | Recreate native presentation from data; arbitrary terminal code is not portable |
| OAuth | Authorization URL and non-secret input supported; secret prompts and input before URL are rejected | Some providers still need host terminal setup; loopback redirects need a phone/host-aware flow |
| MCP auth | Interactive MCP auth handler is not installed in RPC modes | Provider login support is not equivalent to MCP login support |
| Full TUI plan review | No dedicated `answer_plan`/plan-review command among the 67; InteractiveMode owns that overlay | RPC does not automatically expose the existing desktop plan dialog |
| Host URIs | `read`/whole-content `write`; `edit` does not target host URI schemes; scheme registrations are process-wide | Useful virtual filesystem seam with narrower write semantics |
| Paging | Stable cursors tied to session/leaf/count, `session_busy` and `stale_cursor` errors | Restart stale walks; do not silently concatenate different snapshots |
| Framing | v1 physical frames 1 MiB; negotiated v2 chunks up to 64 MiB logical output; input remains unchunked | Negotiate limits; page histories and store large artifacts separately |
| Disconnect | Closing stdin rejects pending callbacks, drains and disposes the session | A network gateway must keep the subprocess alive independently of a phone socket if reconnect is desired |

Source: [RPC reference and implementation][rpc-doc].

## 4. ACP: standardized host-owned conversations

OMP's ACP implementation is substantial. It is a useful alternative for a new
Perch-managed runtime; it is not an attachment protocol for a live terminal
process. Standard names below are ACP methods, with OMP's corresponding host
methods in parentheses. [ACP source][acp], [official ACP guide](https://omp.sh/docs/acp).

| Surface | Methods / capability | Mobile opportunity | Boundary |
| --- | --- | --- | --- |
| Negotiation | `initialize`, `authenticate`; `agentCapabilities` | Discover supported behavior | Auth methods use existing OMP credentials or optional terminal setup |
| Session lifecycle | `session/new`, `session/load`, `session/list`, `session/resume`, fork, close | Persistent chat browser | Fork uses `unstable_forkSession` in inspected SDK; negotiate version |
| Turns | `session/prompt`, `session/cancel`, `session/update` | Native streamed chat | Normal ACP process ownership |
| Modes | `session/set_mode` | Default / Plan | Plan mode must be enabled in host settings |
| Model / effort | `session/set_config_option`: mode, model, thinking | Model and reasoning controls | Invalid or unsupported values reject |
| Attachments | `promptCapabilities.image`, `embeddedContext` | Image/text/context attachments | Host/client must implement matching content representation |
| Files | `fs/read_text_file`, `fs/write_text_file` through `ClientBridge` | Unsaved editor buffers, file previews/editor | Unsupported capability falls back to OMP's host filesystem |
| Terminals | `terminal/*`; create/output/wait/kill/release handle | Native command output panel | Runs where the ACP host implements it, not automatically on the phone |
| Operation permission | `session/request_permission`; allow/reject once/always | Explicit shell/delete/move approval | Category choices cached only in-session; cancellation/unknown response fail closed |
| Extension/tool forms | `elicitation.form` via `unstable_createElicitation` | `select`, `confirm`, `input`, `editor`, optional `askDialog` | Client must advertise and render forms; absent form support returns defaults for ordinary extension methods |
| Plan proposal | Plan handler installed on entry to plan mode; agent `write xd://propose` | Approve/refine plan | Current source uses a 12-line preview; important no-form fallback below |
| Tasks | `session/update` plan entries mapped from todo results | Task progress list | ACP `plan` updates are task-list state, distinct from approval of the plan document |
| Slash commands | Available command updates | Host text command menu | TUI-only commands such as `/plan`, `/login`, `/quit` omitted |
| MCP | Client-supplied stdio / HTTP / SSE MCP servers | App-managed tool connections | OMP deliberately does not discover its on-disk MCP config for ACP sessions |
| OMP-specific methods | `_omp/sessions/listAll`, `_omp/projects/list`, `_omp/chats/byCwd`, `_omp/usage`, `_omp/extensions`, `_omp/extensions/toggle`; speech catalog extension | Project browser, usage and integration catalog | Implementation-specific extension methods; not portable ACP guarantees |
| UI decoration | Widgets, editor control, custom components, themes, terminal input | No direct native equivalent | Inert in ACP's extension UI context; host owns presentation |

Sources: [ACP implementation][acp], [ACP event mapping][acp-events],
[ClientBridge contract][client-bridge], [permission gate][acp-permissions].

### Important ACP plan boundary in the inspected build

The implementation is more conditional than a broad statement that every
missing approval UI fails closed would imply:

1. Entering Plan through `setSessionMode` or the mode config option installs
   a plan-proposal callback.
2. The agent writes its plan title to `xd://propose`. The resolution-device
   dispatcher calls that callback after the plan file is prepared.
3. `#requestAcpPlanApprovalChoice` checks `clientCapabilities.elicitation.form`.
   **Without form support it returns `true` immediately.** This behavior is
   present in both the pinned checkout and Perch's installed 18.8.7 source.
4. The true result exits plan mode and sets the plan reference. There is no
   separate explicit approve-plan client command required on that path.
5. When forms are supported, the user sees the title and **first 12 plan lines**
   plus an ellipsis if needed. Only the explicit Approve selection succeeds;
   cancellation, dismissal and Refine retain plan mode.

This is a **plan-mode transition behavior**, not a bypass of every subsequent
tool permission. The independent ACP `requestPermission` gate still applies
to the operations it covers. Before adopting ACP for Perch, require form
support, provide full-plan retrieval/review, and check the actual host build's
fallback behavior. [Exact ACP handler][acp], [agent proposal dispatch][resolve],
[separate permission gate][acp-permissions].

The official [ACP documentation](https://omp.sh/docs/acp) correctly distinguishes
cancel/decline from approval when a prompt is presented, but does not document
this no-form fallback. Treat that omission as a version-specific source finding.

## 5. Extensions: integration with an existing OMP process

An extension factory receives `ExtensionAPI`; handlers get `ExtensionContext`;
commands additionally get `ExtensionCommandContext`. The injected `pi.pi` is
the package's exports, **not a reference to the live AgentSession**. The session
manager in the general handler context is read-only. [Extension types][ext-types].

### Registration and actions

| Extension point | API | Example for Perch | Limit |
| --- | --- | --- | --- |
| Subscribe | `on(event, handler)` | Publish host lifecycle/tool state | Handler return semantics differ by event |
| Tools | `registerTool` | Let OMP create a structured artifact or request phone input | A local tool callback, not automatic phone transport |
| File fallbacks | `registerFileWriteFallback`, `registerFileDeleteFallback` | Route permission-denied host writes through an authorized helper | Runs only on the specified permission-error/fallback path |
| Commands | `registerCommand`, `getCommands` | `/perch` setup or session actions | Session-changing helpers belong to command context |
| Shortcuts / flags | `registerShortcut`, `registerFlag`, `getFlag` | Host pairing shortcut; bridge enable flag | Desktop keybindings do not become phone buttons automatically |
| Extension metadata | `setLabel` | Friendly integration label | Labels the extension in the inspected implementation; the declared entry-label overload is inactive |
| Message rendering | `registerMessageRenderer` | Rich host display for app-created message kinds | Renderer code is terminal-side |
| Thinking rendering | `registerAssistantThinkingRenderer` | Specialized thinking display | Presentation only; not extra model reasoning visibility |
| Composer shape | `registerComposerShape` | A custom host composer | Native Perch needs its own presentation |
| Messages | `sendMessage`, `sendUserMessage` | Prompt/steer/follow-up/aside delivery | Delivery timing/attribution must be explicit; arbitrary text is not an approval answer |
| Session metadata | `appendEntry`, `getSessionName`, `setSessionName` | Durable bridge metadata and names | `appendEntry` does not resolve live dialogs |
| Tool selection | `getActiveTools`, `getAllTools`, `setActiveTools` | Host tool catalog and enablement | Host policy still controls execution |
| Model / effort / tier | `setModel`, `getThinkingLevel`, `setThinkingLevel`, `getServiceTiers`, `setServiceTier` | Model/effort controls using existing credentials | In-flight request settings are not rewritten |
| Providers | `registerProvider`, `unregisterProvider` | Custom/self-hosted model endpoint; OAuth/usage provider | Host runtime owns secrets and implementations |
| Process helpers | `exec`, `logger` | Host diagnostics and startup | Extensions run in-process without isolation |
| Inter-extension bus | `events` | Integrate host subsystems | Process-local pub/sub; persistence/remote delivery separate |

Sources: [extension guide][ext-doc], [complete interface][ext-types].

The `setLabel(entryIdOrLabel, label?)` declaration also advertises setting a
session-entry label. The pinned `ConcreteExtensionAPI.setLabel(label)` only
assigns `this.extension.label`, and runner initialization does not wire
`runtime.setLabel`. Treat the entry-label overload as declared but inactive in
this implementation. [Declaration][ext-types], [concrete implementation][ext-loader],
[runtime wiring][ext-runner].

Provider registration accepts base URL, API type, static models, headers,
`streamSimple`, OAuth login/refresh/key/model-rewrite hooks, a usage provider,
and `fetchDynamicModels`. This is enough to make Perch's host catalog follow
OMP's supported providers and custom endpoints without duplicating each
provider API in the phone. [ProviderConfig][ext-types].

### Handler and command contexts

| Context | Available surface | Example |
| --- | --- | --- |
| Environment | `cwd`, `mode`, `hasUI`, `agent`, `isProjectTrusted`, optional `localProtocolOptions` | Label origin and main/subagent ownership |
| History | Read-only `sessionManager` | Bootstrap a complete transcript after reconnect |
| Models | `model`, `modelRegistry`; `models.list/current/resolve/family` | Available models and role resolution |
| State / interruption | `isIdle`, `hasPendingMessages`, `abort`, `getContextUsage`, `getSystemPrompt` | Correct stop/idle/context indicators |
| Context maintenance | `compact` with completion/error hooks and one-off compaction mode | Compaction button |
| Background observation | `getAsyncJobSnapshot` | Job activity badge |
| Optional side turns / memory | `runEphemeralTurn`, `memory` | Side question or memory browser |
| Registered-tool-only helpers | Optional `addAdditionalContext`, `invokeTool` | Trusted extra context or delegation to the native built-in of the same name; not an arbitrary tool invoker |
| Managed timers | `setInterval`, `setTimeout`, `clearTimer` | Bridge heartbeat with error containment and cleanup |
| Shutdown | `shutdown` | Deliberate stop-session operation |
| Command-only transitions | `waitForIdle`, `newSession`, `switchSession`, `branch`, `navigateTree`, `reload` | Host command implementing session browser actions |

Source: [ExtensionContext / ExtensionCommandContext][ext-types]. The current
`isProjectTrusted()` contract always returns true; it is not an authorization
decision Perch should reuse for remote operations. [Extension guide][ext-doc].

### All 48 extension events

| Family | Event names | Can a handler change behavior? |
| --- | --- | --- |
| Discovery | `resources_discover` | Declared and runner method exists, but no AgentSession call sites in inspected source; do not build a feature that depends on it firing |
| Session lifecycle | `session_start`, `session_before_switch`, `session_switch`, `session_before_branch`, `session_branch`, `session_before_compact`, `session.compacting`, `session_compact`, `session_shutdown`, `session_before_tree`, `session_tree` | Specific before-events can cancel or replace summaries/compaction; others notify |
| Input / preparation | `input`, `before_agent_start`, `context` | Transform/handle input, provide prompt/context overrides under their contracts |
| Provider boundary | `before_provider_request`, `after_provider_response` | First may replace payload; second observes response metadata; provider must invoke the callbacks |
| Runs / turns | `agent_start`, `agent_end`, `session_stop`, `turn_start`, `turn_end` | `session_stop` can request/block continuation; `agent_end` itself is notification-only |
| Messages | `message_start`, `message_update`, `message_end`, `assistant_message` | First three notify; `assistant_message` may rewrite finalized text within strict content-shape constraints |
| Tool policy / result | `tool_call`, `tool_result` | Block/revise validated arguments; modify result; attach passive context |
| Tool execution | `tool_execution_start`, `tool_execution_update`, `tool_execution_end` | Observation |
| Stock approvals | `tool_approval_requested`, `tool_approval_resolved` | **Observation only; no approval result returned to the stock pending dialog** |
| Subagent admission | `before_subagent_spawn` | Block or route model patterns before spawn |
| Maintenance | `auto_compaction_start`, `auto_compaction_end`, `auto_retry_start`, `auto_retry_end`, `retry_fallback_applied`, `retry_fallback_succeeded`, `cache_warming_decision` | Mostly observation; cache-warming decision may override within its deadline |
| Policy / goals | `ttsr_triggered`, `todo_reminder`, `goal_updated`, `credential_disabled` | Observation |
| User shell/eval | `user_bash`, `user_python` | Can override the command result |
| MCP | `mcp_notification` | Observe notifications after manager handling; may trigger follow-up actions |

Sources: [event declarations][ext-types], [event behavior guide][ext-doc],
[runner][ext-runner]. These names are complete for the inspected
`ExtensionAPI.on` declarations. Hook/provider semantics are not interchangeable:
`tool_call` does not intercept every direct browser/computer prelude operation,
and finalized-text rewriting cannot retract bytes already streamed to a client.
[Hook boundaries][hooks-doc], [extension event behavior][ext-doc].

### UI methods and mode support

| `ctx.ui` method / family | Interactive TUI | RPC | ACP |
| --- | --- | --- | --- |
| `select`, `confirm`, `input`, `editor` | Available | Request/response if runner UI enabled | Form elicitation if advertised |
| `askDialog` | Available where installed | Tool ask can opt into full wire form; check active UI context | Form bridge where installed |
| `notify` | Available | Event | Debug notification |
| `setStatus`, string-array `setWidget` | Available; widget has display bounds | Presentation event | Inert |
| Component-factory `setWidget`, `custom` | TUI component rendering | Unsupported | Unsupported |
| `setEditorText`, `pasteToEditor`, `getEditorText` | Available | Set event; paste falls back to set; get returns empty string | Inert |
| `setEditorComponent` | Available for a `CustomEditor` subclass | Unsupported | Unsupported |
| `addAutocompleteProvider` | Available; composes host editor provider | Inert | Inert |
| `setWorkingMessage` | Available | Inert | Inert |
| `setTitle` | Available | Opt-in `PI_RPC_EMIT_TITLE` | Inert |
| `setHeader`, `setFooter` | **No-op in inspected interactive controller despite declared methods** | No-op | No-op |
| `onTerminalInput` | Raw host input listener | Unsupported | Unsupported |
| Theme query/switch | Interactive support, including named themes | No live theme switching | Inert |
| `getToolsExpanded`, `setToolsExpanded` | Host expansion state | Inert | Inert |

Sources: [UI contract][ext-types], [UI mode matrix][ext-doc],
[interactive UI controller][ui-controller], [RPC UI implementation][rpc-mode],
[ACP UI implementation][acp]. `hasUI` only means a non-stub context is installed;
it does not promise support for every UI method.

## 6. Collab: the original process with deliberately limited guest powers

| Surface | Available capability | Constraint relevant to Perch |
| --- | --- | --- |
| Connect | Join link, encrypted WebSocket; host/guest APIs and wire types | Link grants read or read/write; do not infer privilege from UI |
| Replication | `welcome`, `snapshot-chunk`, `entry`, `event`, `state` | Live and stored conversation state; oversized entries can be reduced |
| Prompt / stop | Guest `prompt`, `abort` | Full-control guests only; host startup/transitions can temporarily refuse input |
| Agent Hub | `agents`, `bus`, `agent-cmd`, `fetch-transcript`, `transcript` | Full-control can chat/kill/revive; view-only can read; advisors excluded |
| Questions | `ui-request`, `ui-request-end`, `ui-response` | Current contract shares select/editor requests with writable guests; first response or cancellation settles all presentations |
| Stock tool approvals | Approval wrapper uses the shared selector in the inspected TUI | A blanket statement that Collab never carries approvals is incorrect; client/build must render them |
| Plan review overlay | No corresponding owner plan-review wire contract found | Not the same as shared select/editor; current Tern route reaches the owner surface |
| Session/machine commands | Model, compact, resume, branch, host bash/eval, skill commands | **Host-only under Collab guest permissions** |
| Local host discovery | `omp collab list --json`; `omp collab link <instanceId> [--view] --json` | Enables a single self-hosted catalog without copying links manually |
| Registry IPC | Private local socket/named pipe: `snapshot`, `link` | Per-host token; generation-bound link; not a remotely exposed daemon API |
| Lifecycle | Rooms track session identity and rotate on transitions | Old room links cannot transparently mutate a successor session |
| Hosted relay | Content-blind encrypted frames | Published production Go relay/binaries unavailable in inspected docs |
| Development relay | Source-available WebSocket stand-in | Omits production web/share/health service; not a full production distribution |
| Browser guest | `packages/collab-web` | Useful UI/wire reuse reference; not itself a native Perch integration |

Sources: [Collab guide and permissions][collab-doc], [protocol][collab-protocol],
[host][collab-host], [private registry][collab-registry],
[approval wrapper][approval-wrapper].

View-only is a real authority boundary. Adding buttons to Perch cannot turn a
view link into control, change the host-only command allowlist, or make a
missing owner dialog appear on a protocol that does not publish it.

## 7. TSP: OMP's semantic terminal surface

TSP gives a terminal a structured document rather than only an ANSI screen.
OMP's native renderer negotiates it, emits semantic nodes, and consumes
targeted events. Perch can project this through Tern's window API.
[Wire grammar][tsp], [native backend][native-backend], [reconciler][reconcile].

### All 42 node kinds

| Group | Kinds | Possible native presentation |
| --- | --- | --- |
| Layout | `col`, `row`, `card`, `section`, `rule`, `spacer`, `rows` | Sections/cards and responsive layouts |
| Rich content | `text`, `md`, `code`, `diff`, `ansi`, `math`, `image`, `kv`, `table`, `tree` | Artifact reader, diffs, tables and trees |
| Small indicators | `badge`, `kbd`, `icon`, `spinner`, `shimmer`, `elapsed`, `progress`, `rate` | Status and progress |
| Selection / input | `list`, `item`, `tabs`, `editor`, `input`, `picker`, `prefs` | Native choices, tabs, forms and settings |
| Surface chrome | `status`, `seg`, `overlay`, `toast` | Request sheets, status and notices |
| Agent/task semantics | `tool`, `checklist`, `agent`, `chart`, `meter`, `effort` | Tool details, task checklist, agent roster, metrics and effort controls |

Source: [TSP_KINDS][tsp]. This is the OMP-side wire vocabulary. A particular
Tern beta may advertise a subset, and a node being visible does not guarantee
that an arbitrary phone action has a corresponding host callback.

The current public Tern SDK declares 44 kinds; `block` and `el` are absent from
both the inspected OMP baseline and current main. This is vocabulary drift,
not two extra OMP features. OMP's `NativeContext.supports(kind)` and
`feature(name)` read the terminal hello; component descriptions such as
HookSelector fall back when `picker` is absent. Under `TERM_PROGRAM=tern`,
OMP can start optimistically using its own vocabulary before the real hello;
`confirm(hello)` then invalidates/re-describes components if vocabularies differ.
Arbitrary custom components must still implement their own fallbacks.
[Native backend][native-backend], [HookSelector][selector],
[public Tern wire vocabulary][tern-current-wire].

### Operations and events

| Direction / layer | Surface | Meaning |
| --- | --- | --- |
| Negotiation | `hello` versions/kinds/features, APC limit, credits, theme/motion/cell metadata | Capability-driven native rendering |
| Program to terminal | Open/adopt surface; inline/screen modes; close/keep; theme palette; blob query/transfer | Document and binary lifecycle |
| Document updates | `add`, `set`, `text`, `splice`, `move`, `del`, `settle`, `focus`, `reveal`, `scroll`, `suspend`, `resume` | Atomic per-surface frame with sequence number |
| Regions | `main`, `dock`, `layer` | Transcript, composer/status and overlay areas |
| Choice/navigation | `toggle`, `select`, `activate`, `action`, `change` | Address an existing component and item/action |
| Text editing | `edit` with UTF-16 range/cursor and observed `len`; `undo`; `focus` | Structured edits if component handler supports them |
| Atomic prompt | `send` with full text | Only negotiated `send` and a live node with `sendable: true`; this event has no attachment/image payload |
| Environment/control | `ack`, `resize`, `theme`, `motion`, `visible`, `error`, `gone` | Flow control, rendering environment and lifecycle |

Source: [TSP wire contract][tsp]. Frame sequence numbers order the rendered
document. They are **not** an expected-plan-revision argument to `activate`.

### Actual OMP owner controls and limits

| Owner UI | Structured route | Current integration implication |
| --- | --- | --- |
| Main composer | Native `send` when advertised | Atomic prompt without emulated typing |
| Tool approval | HookSelector's native hoisted picker or fallback list | Perch 0.8 answers recognized Approve/Deny through the actual owner callback |
| Simple single choice | Same selector shapes | Project bounded, complete, enabled choices |
| Plan review | `omp.plan.options` list in owner overlay; title/body/strategy detail | Perch 0.8 displays and answers enabled plan choices |
| Refine plan | Existing plan action | Returns to normal composer for an explicit follow-up; not an editor response |
| Model/strategy tabs | TSP tabs/select or component action | Potential addition; currently selected model must remain visible to approve meaningfully |
| General input/editor | Edit-capable native field, but tested `sendable: false` | Atomic `send` does not resolve these dialogs in tested 18.8.7; needs a supported submit route or upstream change |
| Plan annotations | Stateful section annotation UI, editor and chooser | Additional mapping required; Perch deliberately treats these contexts as unsupported |
| Multi-question / multi-select ask | TUI has navigation/review state | Additional typed mapping/state model required; do not flatten into a simple approval |
| Arbitrary custom TUI | Component must provide a native description/event implementation or have a fallback | No automatic guarantee of full structured mobile fidelity |
| Replaced dialog | Distinct reconciler component instance ID | Old events can be prevented from selecting a replacement |
| Same-component content race | `activate` has no expected-content revision | Fresh checks help, but strict atomic compare-and-resolve needs an upstream resolver contract |
| Exact file bytes | Displayed Markdown sections | Requires a separate original-file route; displayed plan text is not proof of byte identity |

Sources: [owner request research and live evidence](OMP-OWNER-REQUESTS-RESEARCH.md),
[HookSelector][selector], [plan overlay][plan-overlay], [composer][composer],
[input][input], [hook editor][editor], [event router][native-backend].

## 8. Tools, skills, MCP, settings and reusable host features

These are useful integration surfaces even when they do not directly change
the phone transport. The host can keep its established capability environment
while Perch renders the resulting data and requests.

| Surface | Contract / entry point | Example / limitation |
| --- | --- | --- |
| Built-in tool registry | `createTools`, tool definitions, `AgentSession.getAllToolInfos`, `getToolByName` | Native tool catalog; preserve tool schemas and source metadata |
| Custom tools | `CustomTool`, `ToolDefinition`, `execute(toolCallId, params, onUpdate, ctx, signal)` | Host function with partial/final results and cancellation |
| Tool metadata | `approval`, `hidden`, `loadMode`, `deferrable`, `readsSkillUris`, MCP-origin metadata | Correct tool admission/display; a hidden tool is not an access-control mechanism |
| Tool rendering | `renderCall`, `renderResult`; native call/result descriptors | Host rich tool output; custom JS renderer does not run in React Native automatically |
| Legacy custom-tool bridge | SDK/discovery converts custom tools into extensions | Some declared callbacks (`formatApprovalDetails`, `describeCall`, `describeResult`) are not propagated on that adapter path; direct adapter differs |
| Tool invocation from extensions | `ctx.invokeTool` in tool execution context | Delegate only to the native built-in of the same name as the registered tool; preserve approval/cancellation behavior |
| Hooks | `HookAPI`, `HookContext`; legacy factories loaded via current extension runner | Reuse policy hooks; do not confuse legacy standalone wrapper semantics with current execution |
| Skills | `Skill`, skill discovery/loading; `/skill:` and `skill://` | Skill picker/inspection and host invocation |
| Prompt templates / slash commands | Prompt-template and file-command discovery; custom TS commands | Searchable command palette |
| Context / instructions | Context-file discovery, rules, system-prompt construction | Workspace grounding with source provenance |
| TTSR rules | Rule capability and runtime triggers | Conditional host reminders/policy; display when injected |
| Plugins / marketplaces | Discovery and package installation/configuration subsystem | One host-managed integration package; loading code is a separate operation from browsing metadata |
| Capability discovery registry | `defineCapability`, `registerProvider`, `loadCapability`, provider enable/disable and metadata | Unify skills/hooks/MCP/commands from source formats; these discovery providers are not model providers |
| Settings registry | Typed handles via `lookup`, `all`; handle `get`, `override`, `clearOverride`, `isConfigured`, `provenance`, `listen` | Typed host settings UI with provenance; removed string-path methods should not be recreated |
| Config approval | `CfgApprovalHost`, `setCfgApprovalHost`, `cfg://` writes | Host-owned approval of agent-requested settings changes; process-wide host integration, not an extension observer resolver |
| MCP connect/lifecycle | `MCPManager`, `discoverMCPServers`, config loader/writer, connect/disconnect/reconnect, startup and connection listeners | Host tool-server catalog and connection health |
| MCP tools | `getTools`, refresh methods, tool bridge/cache | Reuse remote tools with source metadata |
| MCP resources | `getServerResources`, `readServerResource`, resource/templates refresh | Native resource browser and previews |
| MCP prompts | `getServerPrompts`, `executePrompt`, prompt refresh | Prompt picker |
| MCP notifications | `addNotificationListener`, catalog/tool/resource/prompt listeners; extension `mcp_notification` | Update data or trigger host follow-ups |
| MCP reverse requests | `ping`, `roots/list` in built-in request handler | Sampling and MCP elicitation requests are not implemented by that handler; unknown methods reject with `-32601`. ACP form elicitation is a different protocol surface |
| MCP transports/auth | stdio, Streamable HTTP, legacy HTTP+SSE; OAuth/auth-handler support | Hosts manage credentials/reconnect; RPC/ACP-specific limitations still apply |
| Subagents | Task executor/types, `AgentRegistry`, lifecycle/event bus, spawn hook | Roster, task results, model routing and cancellation |
| Background jobs | `AsyncJobManager`, session job snapshot/inspect/cancel | Job dashboard; session-owned deliveries and cancellation are not crash recovery |
| Supervised daemons | Local daemon broker protocol: start/list/logs/wait/send/stop/restart/mode/describe | Potential host service/process panel; local broker is not a general remote OMP-session API |
| Diagnostics | Logs, OpenTelemetry, stats, notices, export/dump | Debug view and trace attachment |
| Base AI library | `@oh-my-pi/pi-ai`: stream/complete, API registry, auth, usage, embeddings, images, speech/transcription, video, rerank | Reuse model transport outside coding harness; not full OMP session control |
| Agent core | `@oh-my-pi/pi-agent-core`: Agent, agent loop, tools, compaction, replay, telemetry | Lower-level owned runtime; omits coding-agent policy/discovery/UI unless assembled |

Sources: [custom tools][custom-tools-doc], [extension guide][ext-doc],
[hook guide][hooks-doc], [capability registry][capabilities],
[MCP public API][mcp-doc], [MCP manager][mcp-manager],
[MCP client request handler][mcp-client],
[config approval][cfg], [async jobs][async-jobs], [daemon wire][daemon],
[AI exports][ai-index], [agent-core exports][core-index].

### Internal resource URLs

OMP's router resolves resources in host context. The inspected implementation
includes handlers for `artifact://`, `attachment://`, `local://`, `agent://`,
`history://`, `skill://`, `rule://`, `mcp://`, `omp://`, `proc://`, `ssh://`,
`cfg://`, `xd://`, memory/vault/security resources, and issue/PR/conflict
resources. Scheme policies distinguish file/virtual/remote/device backing and
workspace/sandbox/coordination/device writes. [Router/types][url-types],
[handler exports][urls].

These are **host resolvers**, not links Android can fetch as HTTPS. An artifact
bridge should resolve a selected, session-scoped resource on the host and serve
its bytes with explicit metadata. Forwarding arbitrary `cfg://` or `xd://`
paths as though they were passive artifact URLs would mix reads with actions.

## 9. What is blocked, versus simply not implemented

| Desired capability | Classification | Reason / viable path |
| --- | --- | --- |
| Resolve stock TUI approvals from `tool_approval_requested` | **Blocked through that event contract** | It observes, does not return a decision; use actual owner surface or a host-owned UI bridge |
| Resolve stock TUI plan review by replying to a general extension dialog | **Blocked through that contract** | InteractiveMode owns a separate callback/overlay |
| Attach RPC/ACP/SDK to an arbitrary existing TUI PID | **No advertised attach API** | Existing-process paths are extension, Collab or TSP; opening a session file is different |
| Full-control operations through a Collab view link | **Blocked by authority** | Need an authorized control link; UI changes cannot confer authority |
| Model/compact/resume/branch through current Collab guest commands | **Blocked by current guest contract** | Use owner host path or extend upstream with appropriate authorization |
| Native all-widget TSP renderer | **Implementable, substantial** | 42 kinds plus state, capabilities and event handlers; custom components may still need fallback |
| Full multi-question ask on phone | **Implementable** | Explicit RPC/ACP form route or more TSP mapping |
| Rich editor atomic submit through TSP `send` on tested stock field | **Blocked on current component capability** | `sendable` is false; text editing alone does not resolve promise |
| Plan model/strategy selection and section annotations | **Not yet mapped in Perch** | Upstream owner widgets exist; preserve their state and response semantics |
| Strict atomic stale-plan rejection at OMP consumer | **Needs upstream contract** | Native `activate` has no expected-document revision |
| Exactly-once tool effects after host crash | **Not supplied by these APIs** | Needs durable operation records and effect-specific reconciliation/idempotence |
| Resume stored conversation in a new process | **Available** | SessionManager/SDK/RPC/ACP can restore history with dependencies |
| Restore every suspended tool/dialog/process from SQL/R2 | **Not supplied by SessionStorage** | Storage serializes data, not live runtime resources |
| Original files and large artifacts | **Implementable host route** | ArtifactManager/BlobStore/router provide source access; add authenticated content transfer |
| Phone audio through RPC `live_start` | **Not that API's behavior** | It uses host audio devices; add media transport or a phone-owned voice client |
| Run full Bun/OMP package inside Expo/Hermes | **Not a supported direct deployment target** | Published coding-agent depends on Bun/native host facilities; keep remote host or do a separate runtime port |
| Native rendering of arbitrary TS terminal component code | **No automatic portability contract** | Project semantic data or implement a terminal fallback |
| Host catalog and remote onboarding | **Implementable** | Tern/Perch host catalog or Collab local registry, with one authenticated phone connection |

Sources: the route-specific tables above; [owner requests](OMP-OWNER-REQUESTS-RESEARCH.md),
[extension types][ext-types], [Collab permissions][collab-doc], [TSP][tsp],
[session storage][storage], [package dependencies][package].

## 10. Recommended use in Perch

For the current objective, keep **Tern + the existing OMP process** as the main
path. Add native projections for its structured owner UI incrementally. Use an
OMP extension alongside it for semantic information that TSP should not be
forced to carry: full session trees, rich artifact metadata, model catalogs,
tool capabilities, job state and event-driven refresh. Route every action to
the process that owns the corresponding state. This is an architectural
recommendation based on the boundaries above, not a newly tested feature.

Keep RPC/ACP as a separate **Perch-managed OMP runtime** option. RPC has the
widest explicit OMP-specific control surface; ACP offers reusable standard
client contracts, including files, terminals and forms. Neither should be
presented as silently taking over the user's already running TUI. ACP plan
review needs the form/full-document qualification described above before it
matches Perch's current plan-review expectations.

## Primary source index

GitHub links pin the appropriate reviewed revision rather than the moving
`main` branch.

[current-diff]: https://github.com/can1357/oh-my-pi/compare/b07a1c146d0d12cfc855a2c65d52f892ef319040...d46bd42f39e82d41b4a04c022fb94e595bd8c3c8
[current-context]: https://github.com/can1357/oh-my-pi/blob/d46bd42f39e82d41b4a04c022fb94e595bd8c3c8/packages/coding-agent/src/session/context-settings.ts
[current-tsp]: https://github.com/can1357/oh-my-pi/blob/d46bd42f39e82d41b4a04c022fb94e595bd8c3c8/packages/wire/src/tsp.ts
[current-renderer]: https://github.com/can1357/oh-my-pi/blob/d46bd42f39e82d41b4a04c022fb94e595bd8c3c8/packages/tui/src/tools/renderer.ts
[current-native-view]: https://github.com/can1357/oh-my-pi/blob/d46bd42f39e82d41b4a04c022fb94e595bd8c3c8/packages/tui/src/tools/native-view.ts
[current-annotations]: https://github.com/can1357/oh-my-pi/blob/d46bd42f39e82d41b4a04c022fb94e595bd8c3c8/packages/tui/src/overlays/annotation-types.ts
[current-usage]: https://github.com/can1357/oh-my-pi/blob/d46bd42f39e82d41b4a04c022fb94e595bd8c3c8/packages/tui/src/overlays/usage-dashboard.ts
[tern-current-wire]: https://github.com/stencil-hq/tern-sdk/blob/3fe91247617744635cabb93f4561bd17ac26ca61/typescript/src/wire.ts

[package]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/packages/coding-agent/package.json
[index]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/packages/coding-agent/src/index.ts
[sdk]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/packages/coding-agent/src/sdk.ts
[sdk-doc]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/docs/sdk.md
[session]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/packages/coding-agent/src/session/agent-session.ts
[session-types]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/packages/coding-agent/src/session/agent-session-types.ts
[session-events]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/packages/coding-agent/src/session/agent-session-events.ts
[manager]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/packages/coding-agent/src/session/session-manager.ts
[storage]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/packages/coding-agent/src/session/session-storage.ts
[indexed-storage]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/packages/coding-agent/src/session/indexed-session-storage.ts
[sql-example]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/packages/coding-agent/examples/sdk/13-sql-sessions.ts
[redis-example]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/packages/coding-agent/examples/sdk/12-redis-sessions.ts
[artifacts]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/packages/coding-agent/src/session/artifacts.ts
[session-ops]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/docs/session-operations-export-share-fork-resume.md
[rpc-doc]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/docs/rpc.md
[rpc-mode]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/packages/coding-agent/src/modes/rpc/rpc-mode.ts
[rpc-schema]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/packages/coding-agent/src/modes/rpc/wire/rpc-wire.schema.json
[rpc-commands]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/packages/coding-agent/src/modes/rpc/wire/commands.ts
[rpc-wire]: https://github.com/can1357/oh-my-pi/tree/b07a1c146d0d12cfc855a2c65d52f892ef319040/packages/coding-agent/src/modes/rpc/wire
[rpc-live]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/packages/coding-agent/src/modes/rpc/rpc-live.ts
[acp]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/packages/coding-agent/src/modes/acp/acp-agent.ts
[acp-events]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/packages/coding-agent/src/modes/acp/acp-event-mapper.ts
[client-bridge]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/packages/coding-agent/src/session/client-bridge.ts
[acp-permissions]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/packages/coding-agent/src/session/acp-permission-gate.ts
[resolve]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/packages/coding-agent/src/tools/resolve.ts
[ext-types]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/packages/coding-agent/src/extensibility/extensions/types.ts
[ext-loader]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/packages/coding-agent/src/extensibility/extensions/loader.ts
[ext-doc]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/docs/extensions.md
[ext-runner]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/packages/coding-agent/src/extensibility/extensions/runner.ts
[ui-controller]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/packages/coding-agent/src/modes/controllers/extension-ui-controller.ts
[approval-wrapper]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/packages/coding-agent/src/extensibility/extensions/wrapper.ts
[collab-doc]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/docs/collab.md
[collab-protocol]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/packages/coding-agent/src/collab/protocol.ts
[collab-host]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/packages/coding-agent/src/collab/host.ts
[collab-registry]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/packages/coding-agent/src/collab/registry.ts
[tsp]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/packages/wire/src/tsp.ts
[native-backend]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/packages/tui/src/native/backend.ts
[reconcile]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/packages/tui/src/native/reconcile.ts
[selector]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/packages/tui/src/overlays/hook-selector.ts
[plan-overlay]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/packages/tui/src/overlays/plan-review-overlay.ts
[composer]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/packages/tui/src/prompt/custom-editor.ts
[input]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/packages/tui/src/components/input.ts
[editor]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/packages/tui/src/overlays/hook-editor.ts
[custom-tools-doc]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/docs/custom-tools.md
[hooks-doc]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/docs/hooks.md
[capabilities]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/packages/coding-agent/src/capability/index.ts
[mcp-doc]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/docs/mcp-runtime-lifecycle.md
[mcp-manager]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/packages/coding-agent/src/mcp/manager.ts
[mcp-client]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/packages/coding-agent/src/mcp/client.ts
[cfg]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/packages/coding-agent/src/internal-urls/cfg-protocol.ts
[async-jobs]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/packages/coding-agent/src/async/job-manager.ts
[daemon]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/packages/coding-agent/src/launch/protocol.ts
[ai-index]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/packages/ai/src/index.ts
[core-index]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/packages/agent/src/index.ts
[url-types]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/packages/coding-agent/src/internal-urls/types.ts
[urls]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/packages/coding-agent/src/internal-urls/index.ts
