# One workspace connection, deeper OMP integration, and Tern on a phone

Research date: **7 October 2026**. This note separates implemented Perch behavior,
upstream capabilities, and proposed work. It does not record an Android Tern test
or a deployed provisioning service.

## Recommendation

Give the phone **one connection to a workspace**. Let a host service manage its
configured harnesses, provider accounts, sessions, and artifact files. The app
then chooses an available harness and model within that workspace instead of
requiring an independent setup for every adapter.

For OMP, add a host-owned **SDK or RPC integration** for new managed chats. Keep
Collab for joining a session already running in a terminal. For Tern, keep the
host daemon remote: its documented iOS design already works this way. A native
Android Tern client is a separate integration project; the public SDK does not
provide a ready-to-embed Android renderer. [OMP SDK][omp-sdk], [OMP
Collab][omp-collab], [Tern architecture][tern-architecture], [Tern SDK][tern-sdk].

## What one setup should mean

Perch 0.6 implements the first setup slice in the
[workspace gateway](../server/workspace/README.md): authenticated discovery,
one phone credential, and host-side translation to existing local adapters.
Their underlying protocols remain distinct. The broader ownership of session
processes, provider login, and protected OMP artifacts below describes the next
host-service work.

| Place | Setup and ongoing responsibility |
| --- | --- |
| Phone | Choose **Self-hosted** or **Cloud**; pair once; receive safe harness and model catalogs; render chats, questions, and artifacts. |
| Self-hosted machine | Install/start the host service, discover explicitly selected existing harness configuration, authenticate providers, choose workspace directories, and expose the authenticated endpoint. |
| Cloud provisioning service | Use the user's selected Cloudflare account and scoped deployment credentials, provision the selected runtime, install its configuration and secrets, then issue a workspace pairing credential. |
| Workspace service | Own session identity, process lifetime, credential references, capability discovery, model selection, reconnection, and protected artifact downloads. |

The phone does not need provider keys to send a chat through an already
authenticated host. Existing Perch adapters already follow that separation;
their transport configuration is the part that currently differs. See the
[harness boundary](../src/harness/README.md) and [design](DESIGN.md).

A useful common setup result contains a workspace name and identity, its HTTPS
address, one revocable phone credential, and a catalog of enabled harnesses.
Provider records sent to the app should describe availability and supported
authentication actions without returning API keys, OAuth refresh tokens, or raw
provider configuration.

For self-hosting, `bun run setup:host` collects the required choices, checks the
selected existing adapters, starts the gateway, and prints a pairing code. The
phone imports the code; QR generation is not implemented. Adding another
provider later updates its harness's host catalog, without repeating phone
configuration.

For cloud, a single guided setup can have several provider authorization steps.
Those steps cannot be collapsed into one interchangeable credential: an API
key, a browser authorization flow, and infrastructure deployment credentials
serve different purposes. The user should still experience one setup flow,
with progress and a resumable result.

## OMP: capabilities beyond the current Collab view

The public repository was reviewed at **OMP 18.8.0**, commit
`4ef97c8826ee012829a3e756b693a2a16a414f47`. Perch's Collab copy remains pinned to
`3f7276200adf434fda1d97357ccc7fcd344066fe`; this research does not upgrade it.
See [upstream revision][omp-revision] and Perch's
[vendoring record](../THIRD_PARTY_NOTICES.md).

| Capability | Current Perch Collab adapter | Deeper integration available upstream |
| --- | --- | --- |
| Attach to an active terminal chat | Implemented through a Collab invitation. | Retain Collab for this case. |
| Create, reopen, and branch managed chats | Not exposed by the adapter. | SDK `SessionManager`; RPC `new_session`, `open_session`, `switch_session`, `branch`, and `fork`. |
| Choose a configured model | Displays the host's model. | `get_available_models`, `set_model`, and available thinking levels. |
| Stream conversation and tools | Implemented. | Typed message/tool events, optional delta projection, entries, tree, and paged history. |
| Work with subagents | Shows activity; the native UI does not expose every guest command. | Collab already carries transcript reads and chat/kill/revive; RPC adds subscriptions, transcript reads, steering, and cancellation. |
| Questions and approvals | Supported selection/editor forms; some requests require the host. | RPC UI dialogs and opt-in structured multi-question `ask`. |
| Discover commands and control queued work | Not exposed. | Command catalog, steering, follow-up, and queue controls. |
| Provider setup | Completed on the host. | Login-provider discovery and supported OAuth UI callbacks; account-level logout. |
| Stable artifact downloads | Transcript-derived previews for OMP. | A Perch host tool or URI adapter can publish immutable bytes and manifests through the existing artifact contract. This part is proposed. |

Sources for the implemented column are the [adapter
contract](../src/harness/README.md), [session
documentation](../src/session/README.md), and [vendored wire
types](../src/vendor/omp/wire.ts). Upstream capabilities were checked against the
[pinned RPC types][omp-rpc-types], [pinned RPC reference][omp-rpc-source],
[current Collab wire types][omp-wire], and [SDK guide][omp-sdk]. The matrix
describes integration opportunities, not completed Perch features.

### Choose one OMP host interface

**SDK:** best when the workspace service runs on Bun and should supply custom
tools directly. `createAgentSession` discovers configured credentials, tools,
extensions, skills, and context unless the host overrides them. The service can
own persisted sessions and subscribe to their typed events. Concurrent
independent top-level sessions need independent `AgentRegistry` instances.
The current SDK guide requires **Bun 1.3.14 or newer** and explicitly excludes
Node.js; older README wording differs. [SDK guide][omp-sdk].

**RPC:** best when each agent should have its own process or the gateway uses a
different runtime. Spawn `omp --mode rpc-ui` on the host and translate its
structured requests to Perch's native controls. Keep the process and its stdin
alive when the phone disconnects. RPC runs over stdio, so it still needs an
authenticated network service between that process and the phone. [RPC
guide][omp-rpc].

**ACP:** useful for sharing an editor-oriented integration with other agents.
OMP supports session controls, models, modes, permissions, and optional client
filesystem/terminal callbacks. For a remote Perch client, those callbacks
should execute in the host workspace when offered. Advertising a phone-local
filesystem or terminal would change where agent work happens. OMP's documented
ACP launch is a child process over stdio, not a remote listening port.
[ACP guide][omp-acp].

Starting an SDK/RPC session does not attach that process to an independent
interactive OMP process. Treat **Attach existing session** and **New managed
chat** as different operations. A custom extension could expose additional
controls from a running interactive session, but that requires an explicit
bridge with its own lifecycle and authorization. OMP extensions have session
events, tool lifecycle events, model discovery, and command-context session
controls that make such a bridge plausible. [Extension authoring][omp-extensions].

### Preserve the actual protocol semantics

The pinned source contains features and completion rules newer than the website
overview. In 18.8.0, `prompt_result` reports a prompt's outcome/yield;
`session_settled` and `get_state.isSettled` distinguish a session with no queued
or background work left to resume. Use the settled state before recycling a
worker. Negotiate RPC v2 for large logical frames, correlate responses by ID,
and keep processing UI/tool callbacks while commands are pending.
[Pinned RPC reference][omp-rpc-source].

Login callbacks can open an authorization URL and request a non-secret code or
redirect after that URL. Secret input and prompts before the URL remain
unsupported. A returned loopback `launchUrl` belongs to the host machine; a
phone cannot assume its own loopback address reaches that host. Provider setup
therefore needs an explicit remote-browser/device-flow handoff or a host-side
completion step. [Pinned RPC reference][omp-rpc-source].

The gateway should expose only the actions it can safely and faithfully map.
In particular, raw filesystem paths such as RPC `sessionDir` or `sessionPath`
should be resolved from a workspace-owned session ID. A connected phone should
not get an unrestricted filesystem path API merely because the subprocess
protocol accepts paths.

## Artifacts should become a host service

The current OMP adapter can preview complete content found in a transcript or a
known write-tool input. That does not establish that the file exists, that the
write succeeded, or that its current bytes still match that input. Perch's
[artifact contract](ARTIFACTS.md) and [durable
backend](DURABLE-BACKEND.md) already distinguish those cases.

A deeper OMP integration should provide a host-owned `publish_artifact` tool or
equivalent URI callback. The service reads or receives the selected bytes,
validates workspace access, stores an immutable copy, computes its digest, and
commits a session-scoped manifest. The phone keeps using its existing protected
download and preview path. OMP's host-tool and host-URI interfaces provide the
extension points; the persistence and authorization behavior remains Perch's
implementation responsibility. [RPC host callbacks][omp-rpc-types].

This also gives Tern and Perch a useful shared boundary: a desktop Tern plugin
could open the same published output while Perch presents it in its native
artifact reader. Neither client needs to infer file contents from a terminal
screen.

## Could Tern itself run on the phone?

**The remote-client architecture is real.** Tern's daemon owns panes and their
authoritative screens. Windows mirror them, and the host plugins run beside
the panes. Its documented iOS client runs window plugins locally, displays
host-produced blocks and lenses, and runs shells and host plugins on attached
machines. [Architecture][tern-architecture], [support matrix][tern-platforms].

**Android availability is unverified.** The reviewed platform matrix names
macOS, Linux, Windows, iOS, and the web client; it does not list Android. The
product page describes `tern remote serve` over QUIC, an iPhone client, and a
browser client served by `tern web serve`. These establish the intended split,
but do not establish a supported Android APK, Android renderer library, or
GrapheneOS compatibility. [Support matrix][tern-platforms], [Tern
product page][tern-product].

| Approach on the Pixel | Assessment |
| --- | --- |
| Perch native chat connected to host-side OMP/Pi/OpenCode | Closest to the existing app and its artifact experience. Deeper OMP capabilities need a host adapter and native controls. |
| Tern's web client in a browser or an isolated terminal view | Potential way to retain Tern's own UI, once the user's beta includes the matching web distribution. Browser/GPU/input behavior needs a Pixel test. |
| Embed a Tern Android renderer | Potentially the best fidelity; requires an Android build or an explicitly embeddable renderer and a supported remote-client contract from upstream. None was verified in this review. |
| Implement a TSP renderer in React Native | Possible engineering work, with a substantial compatibility surface. The producer SDK is not a drop-in renderer. |
| Run Tern's complete host/runtime on Android | A separate native port and process-hosting project. The SDK's desktop/iOS support matrix does not establish that an ordinary Linux binary runs inside an Android app. |

TSP describes terminal UI in structured messages carried in the pane's PTY
stream; it also works through SSH. It is distinct from the network protocol
used to discover, authenticate to, and mirror an entire Tern daemon. The
published Rust, Python, Go, and TypeScript SDKs help programs **produce** TSP
views. They do not supply Perch's missing mobile renderer or a documented
complete remote-daemon client implementation. [TSP overview][tsp-overview],
[transport][tsp-transport], [SDK repository][tern-sdk].

A compatible renderer must handle more than Markdown nodes: surface lifetime,
tree changes, styles, blobs, acknowledgments, input events, and terminal
fallback behavior. Tern's native editing also reconciles local selection and
IME composition with the program's text state. Implementing a small advertised
subset could be useful; claiming full Tern parity would require much broader
work. [Surfaces][tsp-surfaces], [input and events][tsp-input].

The user's reported missing `tern web serve` distribution remains an unresolved
beta packaging issue. The public plugin SDK cannot provide that application
bundle. Before choosing the embedded-web route, obtain the matching beta web
assets through the existing beta access and verify their supported serving
configuration. No assets or credentials were requested or downloaded from the
user's beta account during this research.

## Suggested implementation order

1. Keep the phone's two setup choices: Self-hosted and Cloud, with Cloudflare
   the initial cloud implementation.
2. Introduce one workspace pairing and catalog boundary. Keep provider setup,
   filesystem selection, and agent process ownership on the host.
3. Add managed OMP through Bun SDK or RPC, starting with sessions, models,
   conversation, supported questions, and the shared artifact service.
4. Retain Collab for live terminal attachment; expose its already-supported
   subagent features where useful.
5. Evaluate Tern as an additional terminal/workspace view once a matching web
   bundle or Android renderer is available. Keep the native artifact experience
   independent of that decision.

This review read official documentation, current pinned upstream source, and
Perch's existing adapters. It did not run OMP 18.8.0, validate provider logins,
test a Tern beta build, or execute an Android remote-renderer prototype.

[omp-revision]: https://github.com/can1357/oh-my-pi/commit/4ef97c8826ee012829a3e756b693a2a16a414f47
[omp-sdk]: https://omp.sh/docs/sdk
[omp-rpc]: https://omp.sh/docs/rpc
[omp-rpc-source]: https://github.com/can1357/oh-my-pi/blob/4ef97c8826ee012829a3e756b693a2a16a414f47/docs/rpc.md
[omp-rpc-types]: https://github.com/can1357/oh-my-pi/blob/4ef97c8826ee012829a3e756b693a2a16a414f47/packages/coding-agent/src/modes/rpc/rpc-types.ts
[omp-wire]: https://github.com/can1357/oh-my-pi/blob/4ef97c8826ee012829a3e756b693a2a16a414f47/packages/wire/src/index.ts
[omp-collab]: https://omp.sh/docs/collab
[omp-acp]: https://omp.sh/docs/acp
[omp-extensions]: https://omp.sh/docs/extension-authoring
[tern-product]: https://stencil.so/tern
[tern-sdk]: https://github.com/stencil-hq/tern-sdk/blob/829750edeff22177e9a55161132bc2759d20bdf0/README.md
[tern-architecture]: https://docs.stencil.so/tern/concepts/architecture.html
[tern-platforms]: https://docs.stencil.so/tern/concepts/support-matrix.html
[tsp-overview]: https://docs.stencil.so/tern/protocol/index.html
[tsp-transport]: https://docs.stencil.so/tern/protocol/transport.html
[tsp-surfaces]: https://docs.stencil.so/tern/protocol/surfaces.html
[tsp-input]: https://docs.stencil.so/tern/protocol/input.html
