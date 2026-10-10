# Perch 0.8 integration audit: Tern and OMP

**Audit date:** 10 October 2026. **Product:** Perch 0.8.0 / Android code 9.

This report checks the implementation in a clean checkout at
[`3f2fef0bc6457dd8eee7f2359867beaa5fd974e4`](https://github.com/phibkro/perch/commit/3f2fef0bc6457dd8eee7f2359867beaa5fd974e4).
That commit only adds release evidence to the Android source release,
[`61bf8cbfb39409b590f84ad3c38b4ff324683d51`](https://github.com/phibkro/perch/commit/61bf8cbfb39409b590f84ad3c38b4ff324683d51).
The runtime qualifications cover supplied Tern **0.6.0 (`0e39682`)** and OMP
**18.8.7**. The separately reviewed OMP source is
`b07a1c146d0d12cfc855a2c65d52f892ef319040`.

This is the **Perch implementation** part of the integration inventory. It does
not treat every API in the upstream Tern or OMP SDK as a Perch feature. It reads
the current adapters, shared contracts, UI projections, and recorded verification;
it does not claim a new physical-device or live-provider test.

## Status vocabulary

| Status | Meaning |
| --- | --- |
| **Supported** | An active Perch driver and UI path exist. Check the separate verification scope before assuming device or external-host qualification. |
| **Partial** | The path exists with the stated subset, bounds, or weaker semantics. |
| **Unimplemented** | Perch does not expose it. This alone says nothing about whether upstream could support it. |
| **Blocked on this route** | The selected public interface lacks the required semantics in the tested version. Another route or upstream change may make it possible. |
| **Incompatible promise** | The claim would require changing ownership, authority, or recovery assumptions, rather than merely exposing another method. |
| **Unverified** | The code or SDK permits an intended use, but the recorded tests do not establish it in the relevant environment. |

## 1. Three different routes reach OMP

| Route | Owner and transport | Main strength | Main limitation |
| --- | --- | --- | --- |
| **Tern remote** | Existing OMP process in an open Tern window; private Luau window plugin exchanges snapshots with a loopback bridge; Perch uses authenticated HTTP through its workspace gateway | Existing-pane attachment, native owner approvals and plan choices | Requires the window; bounded rendered transcript; no canonical OMP conversation identity or model catalog |
| **OMP remote extension** | Extension runs inside the original OMP process and exposes its own loopback HTTP adapter | Canonical session identity, host model selection, current-branch history, complete write-tool inputs | Public extension does not resolve stock owner approval/plan dialogs |
| **OMP Collab** | Existing OMP share, encrypted guest WebSocket protocol | Live transcript, supported guest selector/editor requests, subagent summaries, view-only shares | One shared session; no owner plan-review interface, model selector, or host-session browser in Perch |

The workspace can advertise these as separate connection choices. Perch has one
active driver. **It does not currently fuse Tern and the in-process extension
into one session connection.** A Tern pane is not automatically linked to an OMP
extension's canonical session. Switching sources replaces the active driver;
the host retains its work. [Workspace manager][workspace-manager]
[Session store][store] [Remote driver][remote-driver]

### Capability comparison

| User capability | Tern remote | OMP remote extension | OMP Collab |
| --- | --- | --- | --- |
| Pair one workspace and reuse saved device access | Supported | Supported | Supported; workspace supplies a Collab invitation |
| Join an already-running process | Supported | Supported, if that process loads the extension | Supported, if it has an active share |
| List available sessions | Partial: detected agent panes in connected windows | Partial: the one instrumented main process per adapter | Unimplemented: invitation selects one session |
| Attach without creating a replacement process | Supported | Supported | Supported |
| Detach without abort or process termination | Supported | Supported | Closing the guest connection leaves host work running |
| Create, resume, delete, rename, branch, or navigate the host session tree | Unimplemented | Unimplemented; lifecycle observations are present | Unimplemented |
| Add/trust/disconnect a remote machine from Android | Unimplemented | Not this adapter's concern | Not this adapter's concern |
| Use agent panes on a machine already connected to the Tern window | Implemented SDK path; real external SSH route unverified | Expose that machine's extension through a configured gateway | Host's location is independent of Collab |
| Read transcript | Partial, recent rendered view | Partial, current branch plus streaming tail | Partial native projection of the synchronized share |
| Stream current assistant text | Partial: polling snapshots | Partial: lifecycle events retained and polled | Supported: upstream stream frames |
| Send ordinary text prompt | Supported when idle and native OMP composer is ready | Supported when idle and admission is clear | Supported; native UI only submits when idle |
| Interrupt current work | Supported via native agent interrupt | Supported via `context.abort()` | Supported via `abort` |
| Steer or enqueue a follow-up while working | Unimplemented | Unimplemented | Unimplemented in Perch UI |
| Answer recognized OMP tool approval | Supported through known owner picker shapes | Blocked on this extension route | Partial: only approvals actually exposed as supported shared selectors |
| Read and answer OMP owner plan review | Supported subset | Blocked on this extension route | Unimplemented; guest request shape has no plan document |
| Answer ordinary single-choice request | Partial: supported native options picker; conservative fallback handling | Unimplemented | Supported for shared single-select |
| Answer shared text editor | Blocked for the tested stock TSP editor/input shapes | Unimplemented | Supported for shared editor |
| View subagent task/status summary | Unimplemented: remote driver emits `agents: []` | Unimplemented: bridge only observes main-agent context | Supported |
| Read or control subagent conversation | Unimplemented | Unimplemented | Unimplemented in Perch; helper methods are already vendored |
| Show current model | Partial: Tern's display string only | Supported: provider, ID, name | Supported: host state metadata |
| Select model using host credentials | Unimplemented | Supported for advertised provider/model pairs while idle | Unimplemented |
| Upload image/file/audio attachment | Unimplemented | Unimplemented | Unimplemented |
| Display actual message attachments | No attachment projection | No attachment projection | Images become a visible unsupported-image placeholder |
| Show thinking, token usage, cost, context budget | No dedicated projection | No dedicated projection | Wire contains some of it, but Perch drops it |
| Markdown/HTML/code artifacts from assistant text | Supported within transcript bounds | Supported within snapshot bounds | Supported |
| Exact complete `write` tool input as artifact | Unavailable from current Tern tool-summary projection | Supported for recognized complete `write(path, content)` input | Supported for recognized complete `write(path, content)` input |
| Download arbitrary original host file | Unimplemented | Unimplemented | Unimplemented |
| Continue host work when phone disconnects | Supported while host survives | Supported while process survives | Supported while host survives |
| Restore in-flight OMP execution after process/host death | Unimplemented | Unimplemented | Unimplemented |

Sources: [Tern plugin][tern-plugin], [Tern bridge][tern-bridge],
[OMP extension][omp-extension], [OMP bridge][omp-bridge],
[OMP projection][omp-projection], [Collab adapter][collab-driver],
[capabilities][capabilities], [native chat projection][chat-projection].

## 2. Perch's public integration boundary

### Native `SessionStore`

The app uses one external store (`subscribe` and `getSnapshot`) for all harnesses.
The following calls are relevant to Tern/OMP. They are actual methods, but their
availability still depends on the current adapter, permissions, connection, and
session status. [Session types][session-types] [Session store][store]

| Method | Effect or limit |
| --- | --- |
| `connectRemote({ url, token })` | Authenticates a Tern or OMP remote adapter, reads its catalog, and initially selects no transcript |
| `connectCollab(inviteLink, displayName)` | Joins one encrypted OMP share |
| `selectSession(id)` | Selects a catalog entry on the remote route; no new harness starts |
| `detachSession()` | Clears a remote attachment and returns to catalog observation; no host interrupt |
| `sendPrompt(text)` | Sends text only; the native composer is limited to 12,000 characters even though the remote command contract permits 100,000 |
| `interrupt()` | Separate supported host interrupt action |
| `answerQuestion(answer, displayedQuestionId)` | Answers the exact current native question; response semantics differ by route |
| `setModel(provider, modelId)` | Implemented for OMP remote, absent from Tern/Collab |
| `reconnect()` | Re-reads host state; no automatic prompt/answer/model replay |
| `createSession()` | Exists in the cross-harness store, but Tern and OMP adapters do not advertise it |
| `loadArtifact(reference)` | Exists for stored-artifact adapters, currently Pi Durable; neither Tern nor OMP implements it |

The snapshot has text messages, tools, a **single** pending question, agent
summaries, model descriptors, session list, and connection/read-only flags.
It has no native fields for thinking blocks, usage, cost, session-tree edges,
file browser, terminal grid, arbitrary TSP tree, command palette, or inbox of
multiple outstanding requests. `steer` and `attachments` are false for all
these routes. Registry components or types alone do not enable a feature.
[Session types][session-types] [Capabilities][capabilities]

### Workspace discovery

`GET /perch/workspace` returns `perch-workspace` version 1, with workspace identity,
deployment label, default connection, and connections. Remote connections carry
a relative path; OMP Collab connections carry the invitation. Provider and local
adapter credentials remain behind the gateway. Saved workspace credentials use
native SecureStore; Advanced direct connections remain in memory.

The current manifest permits **16 connections**, and the phone can retain
**eight saved workspaces**. Remote credentials require HTTPS except loopback;
the gateway has a fixed operation allowlist and does not provide an arbitrary
HTTP proxy. [Workspace protocol][workspace-protocol]
[Workspace manager][workspace-manager] [Gateway][gateway]

### Remote HTTP contract

Both remote adapters implement **`perch-remote` version 1**, which is Perch's
projection protocol, not TSP or OMP RPC. Paths below are relative to the selected
adapter's gateway mount. [Remote schema][remote-schema]

| HTTP operation | Response / allowed command |
| --- | --- |
| `GET /perch/health` | Protocol/version, adapter kind, host identity, adapter epoch, snapshot synchronization, explicit limitations |
| `GET /perch/sessions` | Revision and current catalog entries |
| `GET /perch/sessions/:sessionId` | Bounded authoritative snapshot with capabilities, read-only state, messages, tools, models, optional question, and notices |
| `POST /perch/sessions/:sessionId/commands` | `prompt`, `interrupt`, `set-model`, or `answer`, subject to the adapter's actual capabilities |
| `GET /perch/sessions/:sessionId/operations/:operationId` | Receipt lookup: `pending`, `forwarded`, `rejected`, or `unknown` |

Commands carry operation ID, host epoch, runtime generation, and canonical
conversation ID **when supplied by the adapter**. Answer adds request ID,
displayed-content revision, and opaque selected option ID. Public commands reject
undeclared fields; they do not accept raw TSP targets/events or terminal input.
Tern explicitly rejects a supplied canonical `conversationId` because it cannot
verify one. [Remote schema][remote-schema] [Tern bridge][tern-bridge]

The client limits responses to 6 MiB, commands to 128 KiB, prompts/answers to
100,000 characters, catalogs to 256 sessions, and model catalogs to 10,000 rows.
The actual upstream projections usually impose smaller limits.
[Remote schema][remote-schema]

### Internal Tern bridge contract

These routes are private to the local plugin; the workspace gateway does not
publish them. [Tern bridge][tern-bridge]

| Operation | Purpose |
| --- | --- |
| `POST /tern/register` | Registers a fresh window-plugin connection under a separate plugin credential |
| `POST /tern/exchange` | Sends monotonically sequenced agent catalog, one inspected pane, and delivery receipts; receives the next pane to inspect and at most one command |

There can be up to eight registered windows and 32 captured agent entries per
window. A window retains **one inspected pane transcript at a time**, not a
workspace-wide live transcript cache. The phone similarly displays one attached
session and one request. Several phones watching different panes in the same
window do not have independent continuous streams. There is no fairness or
workspace-wide request-inbox claim. Normal exchanges are held for 750 ms, with a
10-second window lease; command delivery has a 5-second deadline.
[Tern bridge][tern-bridge] [Tern plugin][tern-plugin]

## 3. Upstream calls Perch actually uses

### Tern window SDK

| SDK method / event | Perch use |
| --- | --- |
| `cx.agents:list()` | Detect agent panes, state, CWD, model label, delivery error |
| `cx.agents:transcript(pane, { last = 64 })` | Recent rendered transcript and tool summaries |
| `cx.agents:ask(pane, text)` | Submit one ordinary prompt to a ready native OMP composer |
| `cx.agents:interrupt(pane)` | Interrupt without terminating the pane |
| `cx.session:pane(id)` | Read pane title and containing tab |
| `cx.session:sessions()` and `tabs()` | Resolve workspace/tab display names |
| `cx.hosts:list()` | Resolve a pane's owning host through each host's explicit `panes` membership |
| `cx.session:surface(...)` | Read bounded OMP composer and decision regions |
| `cx.session:event(pane, event)` | Submit only internally mapped supported owner activation |
| `window_start` | Load private configuration, register plugin |
| `command_started`, `command_finished` | Change Perch pane generation and invalidate request mapping |
| `pane_closed` | Remove pane/request identity |
| `tern.fetch`, `tern.json`, `tern.fs.read`, `tern.timer`, logging | Local authenticated exchange, serialization, configuration, reconnect |

No `cx.hosts:add`, `trust`, `switch`, or `disconnect` call exists in the production
plugin. No pane spawn, split, focus, close, terminal resize, keyboard injection,
filesystem read, or raw surface endpoint is exposed to the phone. The host can
offer more APIs than this adapter uses. [Tern plugin][tern-plugin]
[Request mapper][request-mapper]

### OMP public extension API

| SDK member / event | Perch use |
| --- | --- |
| `session_start`, `session_shutdown` | Start/close the main-process listener |
| `session_switch`, `session_branch`, `session_tree`, `session_compact` | Observe desktop transitions and invalidate remote generation |
| `session_before_switch/branch/tree/compact` | Cancel a desktop transition while a Perch async mutation or uncertain prompt admission is being guarded |
| `agent_start`, `agent_end` | Admission and running-state reconciliation |
| `message_start/update/end` | Observe current assistant stream |
| `tool_execution_start/update/end` | Tool status/output and recognized complete write inputs |
| `tool_approval_requested/resolved` | Observe pending tool-decision state; these events are not answer resolvers |
| `api.sendUserMessage(text)` | Enter the existing OMP conversation |
| `context.abort()` | Abort current work, keep process alive |
| `context.models.list/current`, `context.model` | Host-configured model catalog/current choice |
| `api.setModel(model)` | Change to one advertised model using host credentials |
| `context.sessionManager.getSessionId/getSessionName/getCwd/getBranch` | Canonical current conversation and active-branch history |
| `context.agent.kind` | Accept main-agent events only; subagents cannot replace the parent session |
| `context.isIdle/hasPendingMessages` | Admission guards |
| `api.registerCommand('perch-remote-reset', ...)` | Explicit host-only recovery for uncertain prompt admission, with `context.ui.confirm/notify` |

The listener exposes **one current main process**, not every saved conversation
or every running OMP process on the machine. Host tree transitions are observed,
but the phone cannot initiate them. Stock approval events are deliberately not
repurposed into an auto-approve hook. [OMP extension][omp-extension]
[OMP bridge][omp-bridge]

### OMP Collab guest library

| Upstream member / frame | Perch use |
| --- | --- |
| `GuestClient.connect/close/subscribe/getSnapshot` | Connection and synchronized replica |
| `sendPrompt`, `sendAbort`, `sendUiResponse` | Plain prompt, interrupt, supported shared question answer |
| Welcome, snapshot chunks, entry, event, state | Synchronize one shared conversation |
| Agents and subagent progress/lifecycle bus | Project shallow subagent summaries |
| UI request / UI request end | Shared single-select/editor request with authoritative dismissal |
| Error / bye | Native connection and notice states |
| `sendAgentCmd` with `chat`, `kill` or `revive` | **Vendored but not wired** to Perch's driver/store/UI |
| `fetchTranscript(agentId, fromByte)` | **Vendored but not wired**; upstream library already has cursor/timeout handling |
| Prompt `images` wire field | **Type present, not wired**; vendored `sendPrompt` accepts only text |
| Thinking, redacted thinking, usage, cost, queued-state metadata | **Type/data present, not projected** as native features |
| UI cancellation via missing response value | Guest method permits it, but Perch has no explicit Cancel-request command; closing the sheet only closes the phone view |

The guest selector wire has labels/descriptions, initial index, checkbox markers,
and checked indices. Perch handles a single returned label. Checkbox requests are
explicitly delegated to the host. A shared editor uses a string response and
prefill. The generic UI does not show a structured plan document because Collab's
request shape does not supply one. [Collab driver][collab-driver]
[Vendored guest client][guest-client] [Vendored wire types][guest-wire]

## 4. Exact owner-request support

The Tern path reads structured owner UI. It recognizes specific semantic roles
and the tested stock options picker. It is **not a general permission service or
universal TSP renderer**. [Request mapper][request-mapper]

| Request shape or operation | Current behavior |
| --- | --- |
| Stock native `Approve` / `Deny` picker | Supported; full bounded displayed prompt and explicit native choice |
| Tested fallback hook selector | Only the verified unmarked Approve/Deny pair is actionable; arbitrary fallback selectors stay on host |
| Native unfiltered single-choice options picker | Supported if shape, options, actions, and bounds match |
| `omp.overlay.planReview` | Shows prompt, displayed Markdown body, selected strategy, resolved model detail, enabled options |
| Plan Approve / keep context / other currently enabled exposed choice | Sends the selected actual owner option; no hard-coded replacement plan action |
| Plan Refine | Selects the owner Refine action; the next feedback is a separate ordinary prompt in the normal composer |
| Change execution strategy from phone | Unimplemented; current selection is displayed, but the strategy control is not exposed |
| Disabled choices | Displayed and rejected locally and by host mapping |
| General hook editor/input | Read-only notice; tested stock controls advertise `sendable: false` and ignore atomic send |
| Plan section feedback or annotation chooser | Read-only while that interface is mounted |
| Filtered/multiple-choice/timed/multi-part picker | Read-only host action |
| More than one decision or a covering modal | Read-only host action |
| Too many options, omitted nodes, clipped or oversized request | Read-only host action; incomplete preview cannot authorize an answer |
| Custom extension TSP widget | Unimplemented unless it matches a supported tested semantic shape |
| Dismiss/cancel request from phone | No dedicated operation; select a supplied owner option if one represents cancellation |

The mapper reads `layer` and `dock` separately with up to 2,000 nodes, depth 48,
and a 64,000-character SDK text budget per read. It conservatively requires the
merged decision view to contain under **60,000 UTF-8 bytes across all scalar
strings**, no omitted-node marker, and at most 64 valid options. This is not a
promise that every 60 KB plan fits: labels and other surface content share the
complete-view budget. The protocol's 200,000-character document limit does not
override this smaller mapper boundary. [Request mapper][request-mapper]

The phone never preselects an approval. Selection and Send answer are separate.
Request identity includes credential/session scope, host request ID, and display
revision. The selected answer resets on a replacement or revised view. Offline,
read-only, disabled, unsupported, sending, forwarded, and uncertain states disable
response controls. [Native question UI][question-ui] [Remote driver][remote-driver]

### Concurrency boundary

Before invocation the plugin re-reads the current Tern surface, checks request
identity/revision and the selected enabled option, then issues the mapped
`{ ev: 'activate', sf, id, item }`. TSP has no expected-document-revision
precondition at the OMP receiver. **An observed stale Tern view is rejected;
atomic compare-and-resolve inside OMP is not established.** A live process can
change its mounted plan between replica inspection and event delivery.
[Request mapper][request-mapper] [Owner-request design][request-design]

The phone, bridge, and plugin retain process-lifetime reservations. Lost replies
trigger receipt reads rather than command resubmission. A request remains locked
across changed content revisions until the host dismisses/replaces it. This is
not durable exactly-once execution: host/plugin restart loses reservations, and
`forwarded` establishes API invocation rather than the completed effect.
[Remote driver][remote-driver] [Tern bridge][tern-bridge]

The current ledgers are deliberately bounded: 1,024 operation records per Tern
bridge epoch, 4,096 per OMP extension epoch, and 64 unresolved actions/answer
reservations in a phone driver. The host ledgers have no eviction or durable
rollover route. Once full they block new operation IDs; reconnecting the phone
does not clear the host ledger. This is an operational limit to address in a
long-running deployment, not a claim that waiting alone reclaims entries.
[Tern bridge][tern-bridge] [OMP bridge][omp-bridge]
[Remote driver][remote-driver]

## 5. Transcript, model, and artifact fidelity

### Read fidelity

| Property | Tern remote | OMP remote extension | Collab |
| --- | --- | --- | --- |
| Canonical conversation ID | Missing | Present | Present in share/session header |
| Canonical message IDs | Missing; bounded reconciliation makes presentation IDs | Derived from OMP message timestamp, role, ordinal | Host entry IDs plus stable assistant stream identity |
| Timestamps | Unavailable; projected as zero | Host timestamps | Host timestamps |
| History scope | Last 64 rendered rows; no history paging | Current branch; at most 500 recent messages/tools, about 2 MB snapshot | Host's synchronized share; native projection omits unsupported entry/content types |
| Text/output bounds | 160,000-byte aggregate recent-text budget; 64,000 bytes per row, 8,000 bytes per tool output | 256,000-character display text cap, 500 rows, overall serialized 2,000,000-byte budget | Native projection does not impose the same remote limits; transport/library handles share synchronization |
| System/custom entries | Rendered transcript roles supplied by Tern | User/assistant/developer message entries only; developer maps to system | User/assistant plus displayed custom messages; tool results separately |
| Thinking/image blocks | No dedicated extraction | Omitted by text-only block projection | Thinking omitted; images replaced by placeholder |
| Tool details | Name, target, status, bounded rendered output | Recognized arguments and output; otherwise plain cards | Name/status/output/intent; raw input mostly not shown |
| Native chronology | Messages and tool activities remain separate lists; chat projection appends tool cards after text rows | Same | Same |

Sources: [Tern plugin][tern-plugin], [Tern bridge][tern-bridge],
[OMP projection][omp-projection], [Collab adapter][collab-driver],
[native chat projection][chat-projection].

A process-generation guard cannot distinguish every OMP conversation transition
inside one unchanged Tern process because that route does not carry canonical
conversation ID or subscribe to OMP session transitions. The OMP extension has
the stronger identity boundary. The combined runtime test verified the canonical
ID **inside its test recorder**; that does not mean Tern's public Perch snapshot
suddenly carries that ID. [Tern bridge][tern-bridge]
[OMP bridge][omp-bridge] [Runtime evidence][tern-evidence]

### Model fidelity

Tern reports a display string as both model `id` and `name`, without provider.
It advertises no catalog and rejects `set-model`. OMP remote sanitizes
`context.models.list()` into provider/ID/name descriptors, periodically refreshes
them, and only selects a model advertised by that host. Collab displays current
model metadata but supplies no model picker.

None of these paths is a phone-side provider login or a guarantee that every
catalog model is authenticated, subscribed, healthy, or valid for the current
task. No Perch model switch moves the conversation to a different harness.
[Tern bridge][tern-bridge] [OMP bridge][omp-bridge]
[Native model picker][model-picker] [Collab adapter][collab-driver]

### Artifact fidelity

There are only three artifact kinds in the app: `markdown`, `html`, and `code`.
The presence of `react-native-svg`, an image picker dependency, or richer
assistant-ui registry components does not create additional input transports or
readers. [Artifact types][artifact-types] [Artifact model][artifact-model]

| Content / format | Renderer actually available | How Tern can supply it | How OMP remote / Collab can supply it |
| --- | --- | --- | --- |
| Markdown / GFM prose | Native headings, lists, emphasis, strikethrough, tables, links, code; source view | Assistant text/fences; separate displayed plan document | Assistant text/fences or complete recognized write input |
| GFM task lists | Chat's custom tokenizer preserves checkbox glyphs; the artifact/plan reader does not use that customization | Text can arrive, but do not promise identical task-checkbox fidelity between chat and document reader | Same rendering distinction |
| Mermaid | Source only; no diagram engine | Mermaid fenced text | Fenced text or complete `.mmd` write content |
| LaTeX / math | No math renderer or KaTeX/MathJax integration; syntax remains text/code | Text only | Text only |
| MDX | Classified with Markdown; no JSX evaluation | Text/fences | Text/fences/write input |
| HTML | Isolated document, inline CSS, optional inline JS after streaming ends | Complete HTML visible in an assistant fence | Assistant fence or complete HTML write input |
| SVG | `.svg`/SVG fences are XML-highlighted source; no dedicated image preview. Inline SVG in an HTML artifact can use the HTML renderer | Source fence, or inline SVG included in an HTML fence | Same, plus a complete SVG or HTML write input |
| JSON | Highlighted code, no collapsible object/tree view | Fence | Fence/write input |
| CSV / TSV | Plain source; no grid/table data reader | Fence | Fence/write input |
| Diff | Highlighted source; no split view, patch application, or edit reconstruction | Rendered text/fence | Text/fence; arbitrary partial edit arguments do not become complete files |
| Code in common languages | Native lowlight spans, wrap or horizontal scroll; never evaluated | Fence | Fence/write input |
| React/TSX or multiple files | Source only; no compiler, dependency install, project runner, or multi-file preview server | Text/fences | Text/fences/write input |
| Bitmap images | PNG/JPEG/GIF/WebP data images inside Markdown; explicit tap for HTTP(S) Markdown images | A Markdown link/data URI if it survives text limits; no message-image projection | Same Markdown path; ordinary message image blocks are omitted by OMP remote or become Collab placeholders |
| PDF / office documents / archives / arbitrary binary | No reader or binary artifact transport on these routes | Unimplemented | Unimplemented |
| Audio/video | No dedicated media artifact type or upload/download route | Unimplemented | Unimplemented |
| Embedded media inside HTML | Policy permits data/blob media; this is not a media-file transport. Native playback policy still applies | Only if included in the received HTML source | Same |

This matrix is grounded in [MarkdownPreview][markdown-reader],
[chat MarkdownText][chat-markdown], [CodePreview][code-reader],
[HTML policy][html-policy], [native WebView][html-reader], and the adapter
projections cited above. Source classification and byte availability are
separate questions from renderer support.

| Artifact operation | Current support |
| --- | --- |
| Open a long/structured assistant answer as Markdown | Supported on all routes |
| Extract fenced Markdown, HTML, and code blocks | Supported; backtick/tilde fences, filename metadata, stable source-position identity within the available transcript |
| Open complete recognized `write(path, content)` input | OMP remote and Collab; this is proposed file content, with tool outcome separate |
| Read the original file that a log says was written | Unimplemented; no inferred filesystem access |
| Reconstruct a file from partial edits/diffs | Unimplemented; no invented complete file |
| Read the displayed plan | Tern native plan reader, Preview and Source |
| Export the exact original plan file | Unimplemented by the plan route; displayed plan can separate title and normalize blank lines |
| Host file manifests and integrity-checked downloads | Implemented for Pi Durable only; absent from Tern/OMP remote and Collab |
| Native Markdown tables/headings/lists/links/code | Supported |
| Remote Markdown images | Explicit load action; supported link/image policy applies |
| HTML page with inline CSS | Supported within isolated reader policy |
| Inline HTML JavaScript | Explicit interaction toggle after generation completes; remote dependencies/network remain blocked |
| Code highlighting and source wrap/horizontal scroll | Supported for recognized languages; unknown languages are plain source |
| Mermaid diagram rendering | Unimplemented; Mermaid is source/code |
| Side-by-side or applied diff | Unimplemented; diff is source/highlighting |
| Compile/run React/TSX or a multi-file project preview | Unimplemented |
| PDF, office file, audio/video artifact transport | Unimplemented for these adapters |
| Copy/export complete available artifact bytes | Supported; native cache file and system share sheet, not publication |
| Persistent artifact revisions/cross-message file version history | Unimplemented |

The HTML interaction toggle is scoped to the selected artifact, resets on
selection changes, and stays off while content streams. Its opaque-origin inner
iframe has no same-origin permission, app message bridge, token, or transcript.
The declared policy blocks network APIs, remote scripts/styles/media, workers,
nested frames, popups, parent navigation, and form submission. Native file access,
shared cookies, persistent DOM storage, and mixed content are disabled. Inline
CSS, permitted embedded resources, and opted-in inline scripts can work; generated
HTML cannot call Perch tools. These are implemented policy boundaries, with
browser/WebView enforcement still requiring physical-browser/device validation.
[HTML policy][html-policy] [Native WebView][html-reader]
[Artifact design][artifact-design]

Readers cap rendering at 200,000 characters and highlighting at 50,000.
Oversized HTML stays available as source/export instead of rendering a truncated
page. Copy/export uses complete **received artifact content**; it cannot restore
text omitted upstream. Tern-derived artifacts may be incomplete because Tern's
transcript is bounded. [Artifact model][artifact-model]
[Artifact design][artifact-design] [OMP projection][omp-projection]
[Collab adapter][collab-driver]

Export writes a **text** cache file and opens the system share sheet. HTML and
Markdown use their corresponding MIME types; other code/source formats use
`text/plain` with the selected filename. There is no binary export reconstruction,
server-side publication, or export-cache cleanup service. Downloading an original
host file would require the missing authenticated artifact route first.
[Native export][artifact-export] [Artifact design][artifact-design]

## 6. What requires a change, and what cannot be promised

### Missing Perch plumbing, not established upstream impossibility

These are unimplemented here: native Tern Add remote host/trust UI, pane/session
management, subagent conversation controls, model selection through the Tern
route, thinking/usage/context display, attachments, file download, rich Mermaid
and diff views, history paging, global approval inbox, push notifications, and
session-tree navigation. The upstream inventories must identify the correct SDK
and version for each. They should not be labeled impossible merely because the
remote protocol currently has four commands.

### Blocked by the tested route or version

| Desired guarantee | Actual boundary |
| --- | --- |
| Resolve stock owner approvals/plans through the unmodified OMP remote extension | Extension observes approval lifecycle but lacks the stock owner resolver; use Tern's owner route or add supported upstream integration |
| Atomically submit arbitrary stock OMP rich/simple editor through TSP Send | Tested stock editors advertise `sendable: false` and ignore atomic Send; keyboard automation is a different weaker interaction contract |
| Atomically approve exactly the plan revision seen by the phone | TSP activation lacks an upstream expected-revision precondition |
| Recover canonical session IDs or complete original file bytes from Tern's rendered transcript alone | Required data is absent from that projection; add a semantic OMP/file channel |
| Continue this window plugin after closing its Tern window | Plugin lifecycle belongs to the window; a daemon/direct transport requires a separate implementation |
| Answer a view-only share | Host permission forbids mutation; this is intentional access control, not missing UI |

### Incompatible promises under current ownership

- An OMP RPC/ACP process created by a new adapter is not automatically the
  already-running desktop OMP process. A new controller may provide more APIs
  but changes process ownership unless explicitly integrated into that owner.
- Keeping the phone disconnected while the host works is not crash recovery.
  OMP history storage does not preserve arbitrary live process stacks, open tools,
  provider calls, or in-memory command receipts.
- Tern/OMP on arbitrary infrastructure is not made durable by the existing Pi
  Durable connector. `server/pi-bridge` owns a **Pi** RPC process; it does not
  attach to OMP/Tern. The durable backend is separately implemented and does not
  upgrade these existing desktop sessions.
- No transport can by itself guarantee exactly-once arbitrary external tool
  effects after an ambiguous failure. Durable operation records still require
  effect-specific idempotency or reconciliation.
- Pixels or ANSI output can support inferred controls through OCR or terminal
  automation. They do not by themselves provide authoritative request identity,
  handlers, or revisions, or guarantee equivalent native behavior. TSP or an
  explicit semantic API is needed for that stronger contract.

These distinguish architectural reasoning from an assertion that future
engineering is forbidden. [Session ownership design][request-design]
[Remote workspace design][remote-design] [Pi bridge][pi-bridge]

## 7. Verification boundaries

| Evidence | Recorded result | What it does not establish |
| --- | --- | --- |
| Native remote protocol/driver | 13 tests / 121 assertions | Physical Android networking/layout |
| Tern HTTP bridge | 20 tests / 167 assertions | Real external Tern host transport |
| OMP remote bridge | Release suite: 17 tests / 127 assertions | User provider credentials or every extension |
| Workspace gateway/setup | 17 tests / 184 assertions | User reverse proxy/network configuration |
| Workspace drivers/integration | 14 tests / 116 assertions | Live user host |
| Rendered app | 141 DOM checks, no JS errors/outside requests | Native layout, keyboard animation, WebView enforcement |
| Actual OMP owner recorder | Seven checks, one session, four mock calls, one inert tool | Tern or phone transport |
| Actual Tern request mapper | Ten checks, nine valid protocol examples | Every custom TSP UI |
| Actual Tern + actual OMP + production plugin/bridge | Seven flows: denial, replacement approval, Refine, explicit Unicode feedback, reopened plan approval, unchanged PID/session, no replay | Physical Pixel or live paid provider |
| Actual Tern capped-plan fixture | 11 checks; 65 KB plan remains read-only, no activation | Large-plan pagination or original-file transport |
| Android APK release | All three hosted jobs and independent downloaded-binary inspection passed | Install/startup/upgrade and real GrapheneOS behavior |
| External remote daemon/SSH trial | Blocked by environment Unix-socket restriction before attachment | No actual remote network success is claimed |

The detailed evidence files are [Tern results][tern-evidence],
[Tern verification notes][tern-verification], [OMP results][omp-evidence],
[release verification][verification], and [Android binary evidence][android].
The older OMP-specific JSON records 16/121 unit checks from its earlier run; the
0.8 release-wide record adds the explicit owner-answer rejection test and records
17/127. These are different recorded suites, not competing current totals.

The final software-rendered Tern fixture used `LP_NUM_THREADS=1`. Initial
unbounded-renderer attempts sometimes exceeded Tern's unchanged 50 ms window
callback budget. Successful final fixtures do not establish timing reliability
under every host load. [Tern verification notes][tern-verification]

## Source index

All source links below are pinned to the audited commit. This avoids confusing
future upstream or Perch changes with the 0.8 behavior described here.

[store]: https://github.com/phibkro/perch/blob/3f2fef0bc6457dd8eee7f2359867beaa5fd974e4/src/session/store.ts
[session-types]: https://github.com/phibkro/perch/blob/3f2fef0bc6457dd8eee7f2359867beaa5fd974e4/src/session/types.ts
[capabilities]: https://github.com/phibkro/perch/blob/3f2fef0bc6457dd8eee7f2359867beaa5fd974e4/src/harness/capabilities.ts
[remote-driver]: https://github.com/phibkro/perch/blob/3f2fef0bc6457dd8eee7f2359867beaa5fd974e4/src/session/remote.ts
[remote-schema]: https://github.com/phibkro/perch/blob/3f2fef0bc6457dd8eee7f2359867beaa5fd974e4/src/harness/remote.ts
[workspace-protocol]: https://github.com/phibkro/perch/blob/3f2fef0bc6457dd8eee7f2359867beaa5fd974e4/src/workspace/protocol.ts
[workspace-manager]: https://github.com/phibkro/perch/blob/3f2fef0bc6457dd8eee7f2359867beaa5fd974e4/src/workspace/manager.ts
[gateway]: https://github.com/phibkro/perch/blob/3f2fef0bc6457dd8eee7f2359867beaa5fd974e4/server/workspace/gateway.mjs
[tern-plugin]: https://github.com/phibkro/perch/blob/3f2fef0bc6457dd8eee7f2359867beaa5fd974e4/server/tern-remote/plugin/window.luau
[request-mapper]: https://github.com/phibkro/perch/blob/3f2fef0bc6457dd8eee7f2359867beaa5fd974e4/server/tern-remote/plugin/requests.luau
[tern-bridge]: https://github.com/phibkro/perch/blob/3f2fef0bc6457dd8eee7f2359867beaa5fd974e4/server/tern-remote/bridge.mjs
[omp-extension]: https://github.com/phibkro/perch/blob/3f2fef0bc6457dd8eee7f2359867beaa5fd974e4/server/omp-remote/extension.ts
[omp-bridge]: https://github.com/phibkro/perch/blob/3f2fef0bc6457dd8eee7f2359867beaa5fd974e4/server/omp-remote/bridge.mjs
[omp-projection]: https://github.com/phibkro/perch/blob/3f2fef0bc6457dd8eee7f2359867beaa5fd974e4/server/omp-remote/projection.mjs
[collab-driver]: https://github.com/phibkro/perch/blob/3f2fef0bc6457dd8eee7f2359867beaa5fd974e4/src/session/collab.ts
[guest-client]: https://github.com/phibkro/perch/blob/3f2fef0bc6457dd8eee7f2359867beaa5fd974e4/src/vendor/omp/client.ts
[guest-wire]: https://github.com/phibkro/perch/blob/3f2fef0bc6457dd8eee7f2359867beaa5fd974e4/src/vendor/omp/wire.ts
[chat-projection]: https://github.com/phibkro/perch/blob/3f2fef0bc6457dd8eee7f2359867beaa5fd974e4/src/chat/projection.ts
[question-ui]: https://github.com/phibkro/perch/blob/3f2fef0bc6457dd8eee7f2359867beaa5fd974e4/src/ui/QuestionContent.tsx
[model-picker]: https://github.com/phibkro/perch/blob/3f2fef0bc6457dd8eee7f2359867beaa5fd974e4/src/ui/ModelPicker.tsx
[artifact-model]: https://github.com/phibkro/perch/blob/3f2fef0bc6457dd8eee7f2359867beaa5fd974e4/src/artifacts/model.ts
[artifact-types]: https://github.com/phibkro/perch/blob/3f2fef0bc6457dd8eee7f2359867beaa5fd974e4/src/artifacts/types.ts
[markdown-reader]: https://github.com/phibkro/perch/blob/3f2fef0bc6457dd8eee7f2359867beaa5fd974e4/src/artifacts/MarkdownPreview.tsx
[chat-markdown]: https://github.com/phibkro/perch/blob/3f2fef0bc6457dd8eee7f2359867beaa5fd974e4/src/chat/registry/components/assistant-ui/elements/markdown-text.tsx
[code-reader]: https://github.com/phibkro/perch/blob/3f2fef0bc6457dd8eee7f2359867beaa5fd974e4/src/artifacts/CodePreview.tsx
[html-policy]: https://github.com/phibkro/perch/blob/3f2fef0bc6457dd8eee7f2359867beaa5fd974e4/src/artifacts/html.ts
[html-reader]: https://github.com/phibkro/perch/blob/3f2fef0bc6457dd8eee7f2359867beaa5fd974e4/src/artifacts/HtmlPreview.tsx
[artifact-export]: https://github.com/phibkro/perch/blob/3f2fef0bc6457dd8eee7f2359867beaa5fd974e4/src/artifacts/export.ts
[artifact-design]: https://github.com/phibkro/perch/blob/3f2fef0bc6457dd8eee7f2359867beaa5fd974e4/docs/ARTIFACTS.md
[request-design]: https://github.com/phibkro/perch/blob/3f2fef0bc6457dd8eee7f2359867beaa5fd974e4/docs/REMOTE-REQUESTS.md
[remote-design]: https://github.com/phibkro/perch/blob/3f2fef0bc6457dd8eee7f2359867beaa5fd974e4/docs/REMOTE-WORKSPACE-DESIGN.md
[pi-bridge]: https://github.com/phibkro/perch/blob/3f2fef0bc6457dd8eee7f2359867beaa5fd974e4/server/pi-bridge/README.md
[tern-evidence]: https://github.com/phibkro/perch/blob/3f2fef0bc6457dd8eee7f2359867beaa5fd974e4/server/tern-remote/verification-results.json
[tern-verification]: https://github.com/phibkro/perch/blob/3f2fef0bc6457dd8eee7f2359867beaa5fd974e4/server/tern-remote/VERIFICATION.md
[omp-evidence]: https://github.com/phibkro/perch/blob/3f2fef0bc6457dd8eee7f2359867beaa5fd974e4/server/omp-remote/verification-results.json
[verification]: https://github.com/phibkro/perch/blob/3f2fef0bc6457dd8eee7f2359867beaa5fd974e4/docs/VERIFICATION.md
[android]: https://github.com/phibkro/perch/blob/3f2fef0bc6457dd8eee7f2359867beaa5fd974e4/docs/ANDROID-BUILD.md
