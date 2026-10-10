# Perch 0.7

**A native AI workspace with replaceable models, harnesses, and hosting.**

Perch connects a phone to an agent running on your own host. The chat uses native **assistant-ui** components. Generated Markdown, HTML, and code open in a dedicated artifact workspace with preview, source, copy, and export.

Choose **Self-hosted** or **Cloud**, pair one workspace, then switch between the assistants it advertises. Cloud defaults to Cloudflare. Available connections are **OMP and Tern remote sessions**, **Pi Durable**, **OMP Collab**, the **Pi RPC bridge**, and **OpenCode through its included gateway**. The phone renders the conversation and artifacts; the host owns provider configuration and tool execution.

The current target is a Pixel 8a running GrapheneOS. The project uses Expo 57, React Native, native assistant-ui, and Uniwind. Platform action buttons use Expo UI. iOS shares the application source but has not been built or device-tested.

## Chat first

The app opens on **New chat** with the composer at the bottom. The sidebar contains chats, artifacts, connections, and settings. It stays visible on wide screens and opens from the menu on a phone. There is no bottom navigation bar.

The demo supports separate new conversations and drafts. Its first message becomes the chat title. Pi Durable and OpenCode add real remote history and New chat. During a session change, the current transcript stays visible until the replacement is ready. OMP Collab, the OMP extension, and the Pi bridge expose their current host session. The Tern remote browser lists existing agent panes. Creating a new process or conversation through these connections remains a host action.

## Try the artifact demo

1. Choose **Preview artifacts** on New chat, or open **A workspace you can preview** from the sidebar.
2. Open **mobile-workspace.md** to read the rendered report and table.
3. Open **workspace-card.html** to inspect its visual layout. Enable interaction to try its self-contained button.
4. Open **connection-label.ts** for highlighted source. Try line wrapping, Copy, and Export.
5. Open **Mobile companion** to try a streamed conversation, tool activity, and a host question.

The demo is synthetic, clearly labelled, and works without a server. It does not call a model or create files on a host. An explicit connection action is required before a real network session starts.

## Run the app

Use a supported Node version; Node 24 is a convenient common choice for the app and development tools.

```sh
bun install --frozen-lockfile
bun run web
```

To develop on Android:

```sh
bun run tools:install
bun run tools:doctor
bun run dev:android
```

To build a standalone APK or a separate development client:

```sh
bun run apk
bun run apk:development
```

The standalone app keeps the original package ID and prototype signing key so it can update earlier versions. The development app has a separate identity and can be installed alongside it. See [DEVELOPMENT.md](docs/DEVELOPMENT.md) for SDK setup, Expo MCP, agent-device, Maestro, EAS profiles, and output locations.

Development CLIs are pinned separately in `tooling/` so they do not become application dependencies. EAS services and Expo MCP still require your own account connection. Local builds and the demo do not.

Install dependencies with **Bun 1.4.2** and the committed `bun.lock` files.
Use `bun install --frozen-lockfile`, followed by `bun run dev:android` or
`bun run apk`. Keep Node 24 installed for the Expo, Android, and agent runtimes.
The project uses Bun's hoisted dependency layout for React Native compatibility.

## Build and update through GitHub

The [GitHub release guide](docs/GITHUB-RELEASES.md) describes the Android CI and
Obtainium update channel. GitHub Actions runs source checks and builds the ARM64
APK with pinned actions, an explicit Android toolchain, and reusable Gradle
caches. Trusted version tags publish an explicitly labelled prototype prerelease
with `perch-prototype-arm64.apk`, checksums, and binary verification metadata.

Add the published repository to Obtainium, include prereleases, and select the
stable ARM64 asset. Releases preserve the existing prototype package and signing
identity so later builds can update the installed app. This identity uses the
included development key; a private production signing identity is a separate
distribution decision. The guide distinguishes configured automation from an
observed hosted build.

## One workspace setup

Follow [the workspace setup guide](docs/WORKSPACE-SETUP.md). On the host, use
`bun run setup:host` to prepare a gateway for your existing local adapters, or
`bun run setup:cloud` for the guided Cloudflare backend deployment. Both produce
one private pairing code for **Connect a workspace**. Cloud setup reviews its
resource plan before an explicit apply action; it does not deploy merely by
opening the phone app.

The installed app saves workspace access with Expo SecureStore. Reopen a saved
workspace without entering its credentials again, and choose its assistant in
**Connection & settings**. Provider and infrastructure keys stay on the host.
The browser preview keeps access only for its current visit. The first self-hosted
setup requires the selected harnesses/adapters to be installed and running; it
does not automate their provider logins.

The Android keyboard fix from 0.5.1 is included: the composer and input sheets
explicitly avoid the keyboard. See [the regression record](docs/KEYBOARD-REGRESSION.md)
for automated layout evidence and the physical-device flow.

## Advanced: connect Pi Durable directly

[Pi Durable setup](docs/DURABLE-BACKEND.md) connects the phone to Perch's own persistent backend. It uses actual PiHarness/Lifecycle, one SQLite cell per chat, and a separate bucket binding for artifact bytes.

1. Build and configure `server/pi-durable` with a workspace token and a supported host model.
2. Start the backend through your Workers-compatible runtime and expose a remote endpoint with HTTPS.
3. In Perch, choose **Connect a workspace → Advanced connection → Pi Durable**, then enter that endpoint and workspace token. A current backend also supports the shared pairing flow.
4. Choose **New chat**. Generated files saved by `write_artifact` open in Artifacts and can be reopened after reconnecting.

Model keys stay on the backend. Workspace tokens authorize that workspace's sessions and files. The production entry has no demo-model fallback. Its configured API families are OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages, including the required conversation headers for OpenCode Go. This is a smaller set than the full Pi RPC provider catalog; subscription OAuth is a separate host integration.

## Attach to OMP or Tern remote sessions

Perch 0.7 adds a native host session browser with explicit **Attach** and
**Detach**. It observes an existing host runtime, keeps the existing artifact
readers, and never launches another agent to imitate your current session.

- [OMP extension](server/omp-remote/README.md): runs inside the original OMP
  process and exposes its conversation, prompt/interrupt controls and advertised
  model selection through the public extension API.
- [Tern plugin and bridge](server/tern-remote/README.md): discovers supported
  agent panes through an attached Tern window and exposes bounded native
  transcripts and targeted agent controls. It does not need Tern's web assets.

Configure the adapter on your host, add it through `bun run setup:host` (choices
5 or 6), and pair the workspace once. Open the remote connection on the phone,
then choose a running session. **Detach** leaves the host running. Reconnect
reads the latest snapshot and any forwarding receipts without resending work.
New host generations require another explicit attachment.

This first slice uses periodic snapshots. Full TSP widgets, a VT terminal view,
shared host dialogs and daemon-only Tern access are subsequent milestones.
[The grounding design](docs/REMOTE-WORKSPACE-DESIGN.md) separates those phases;
[the verification record](docs/REMOTE-WORKSPACE-RESULTS.md) states the runtime
evidence and remaining device checks.

## Connect OMP with Collab

1. Start OMP in your Tern workspace and run OMP's `/collab` command.
2. Open **Connect a workspace → Advanced connection → OMP Collab** from the sidebar in Perch, or include the invitation in your shared workspace's host configuration.
3. Paste the complete Collab link and enter your participant name.
4. Choose **Join workspace**.

Perch uses OMP's encrypted Collab guest protocol. It waits for the protocol handshake and synchronized snapshot before showing the session as live. View-only links remain view-only. The pinned upstream client is identified in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

This route uses OMP's existing interface inside Tern and does not depend on Tern bundling its web distribution. It does not render Tern terminal panes, TSP surfaces, or plugin windows.

## Connect Pi to your models

```sh
bun install --cwd server/pi-bridge --frozen-lockfile
```

Follow [the Pi bridge guide](server/pi-bridge/README.md) to select a working directory, configure a token, and expose the bridge through the shared workspace gateway or directly over WSS. For a direct connection, use **Connect a workspace → Advanced connection → pi bridge**.

The bridge starts a real `pi --mode rpc` subprocess. It uses your host's Pi configuration, including self-hosted providers. The phone receives host-reported model metadata and lets you select among the models the host advertises. Reconnecting attaches to the same bridge process instead of replaying a prompt.

## Connect OpenCode

Follow [the OpenCode guide](docs/OPENCODE.md) to run your server behind `server/opencode-gateway/`, then include that gateway in the shared workspace setup. For a direct connection, use **Connect a workspace → Advanced connection → OpenCode**. Enter the gateway's HTTPS address, username, and password. Model providers and supported subscription logins are configured on the OpenCode host.

The gateway exposes only the session APIs Perch needs and removes provider credentials from the catalog. The app requires its versioned handshake before requesting models; a raw OpenCode endpoint is rejected. The source and tests pin OpenCode 1.18.35.

## Providers and the durable foundation

Model search and provider filters use the connected host's catalog, with virtualized rows. A selection is a provider/model pair. The [reproducible provider audit](docs/PROVIDERS.md) records **41 Pi and 71 OMP provider definitions with bundled chat models**. OMP's raw catalog contains 72 IDs; one has no matching provider definition and is excluded from that headline. The definition-backed sets contain **83 literal IDs in their union**, or **78 groups after five documented naming mappings**. These counts do not establish account access or test every route. Pi, Pi Durable, OpenCode, and the OMP extension expose phone model selection; the OMP Collab adapter reports the host's selection.

The included Pi version has an OpenCode Go provider. [Configure your subscription on the host](server/pi-bridge/README.md#opencode-go-subscription) using the supplied [environment example](server/pi-bridge/opencode-go.env.example). Go is intended for coding-agent traffic; a configured provider does not establish an account's entitlement. No subscription request was made during verification.

[Pi Durable](docs/PI-DURABLE.md) is the basis for Perch's own persistent assistant: the same durable core can use Node SQLite at home or PiHarness in Cloudflare Durable Objects. The isolated experiment kills real processes and verifies safe-tool replay, unsafe-tool interruption, and model recovery. Perch supplies the mobile backend through `server/pi-durable`, and 0.6 adds its Cloudflare setup runner. [Cloudflare hosting](docs/CLOUDFLARE.md) discusses additional Linux/Sandbox capabilities, which that runner does not provision. No live Cloudflare deployment has been performed during development.

[OpenClaw and Hermes](docs/ASSISTANT-INTEGRATIONS.md) are researched future assistant backends. The proposed adapters use their native client APIs to preserve sessions, decisions, memory, and artifacts. OpenClaw has an experimental Cloudflare Containers template; Hermes would need a custom Linux deployment. Their recovery guarantees depend on the selected transport and preserved state. Neither adapter is included in 0.7.

[Pi Durable on celld with R2](docs/PI-CELLD.md) explores a self-hosted persistent-agent route: celld owns cell storage, ownership, and wake-up; Pi owns continuation and tool replay. The existing PiHarness adapter now passes [real celld recovery checks](docs/PI-CELLD-RESULTS.md), including alarm-driven continuation after removing all local runtime data while work is unfinished. The [durable backend](docs/DURABLE-BACKEND.md) adds the mobile protocol and stored artifact downloads. R2 and multi-node failover remain separate deployment checks. The earlier [runnable experiment](experiments/pi-celld/README.md) preserves the recovery evidence that led to this composition.

## Implemented behavior

| Area | Current behavior |
| --- | --- |
| Chat | Native assistant-ui Thread, Message, Composer, and tool-call elements over an external store |
| Harness boundary | Separate harness/model metadata, capabilities, and transport adapters |
| Workspace setup | Self-hosted/Cloud choices, one authenticated discovery endpoint, saved native access, harness switching, Advanced fallback |
| Remote sessions | Host catalog, explicit attach/detach, same-process OMP extension and Tern plugin bridge, prompt/interrupt, receipts, identity-aware reconnect, OMP model choice |
| OMP Collab | Encrypted Collab, prompt, interrupt, supported host questions, synchronized reconnect |
| Pi Durable | Authenticated workspace, persistent history/create/select, idempotent submissions, model choice, abort, authoritative reconnect, stored artifact downloads |
| Pi | Authenticated bridge, real RPC process, prompt, interrupt, supported extension questions, model selection, reconnect |
| OpenCode | Authenticated host gateway, remote chat history/create/select, host-connected models, streaming, tools, supported decisions, abort, snapshot reconnect |
| Model chooser | Host metadata, local search, provider filters, virtualized rows, provider/model identity |
| Markdown | Native reader with headings, tables, links, quotes, and selectable text |
| HTML | Separate sandboxed document with inline styling; optional inline interaction |
| Code | Syntax highlighting, horizontal scrolling or wrapping, complete-content copy and export |
| File discovery | Durable server manifests, fenced assistant outputs, and complete contents from known write-tool inputs |
| Device flow | New chat home, phone drawer/wide-screen sidebar, bottom composer, session-specific drafts, light/dark appearance, recoverable submitted text |
| Development | Expo dev client, local Expo and assistant-ui skills, MCP configs, agent-device, Maestro, EAS profiles and manual workflows |

The host owns execution and history. A disconnected phone does not mean the agent stopped. Reconnect refreshes the host snapshot and never silently resends a prompt. **Restore text** returns the last submitted message to the composer without sending it.

Paired workspace credentials are saved in native secure storage. Direct Advanced credentials, drafts, and unresolved submission IDs stay in memory and reset when the app restarts. Durable server chats and files remain on the host; reopen your saved workspace and inspect history after restarting the phone. Attachment upload, durable offline history, background notifications, voice, and arbitrary Tern/plugin interfaces remain future work. Controls follow the adapter's implemented capabilities.

HTML starts with scripts disabled. Its preview uses an opaque-origin inner frame, restrictive content policies, and no application bridge. Self-contained pages work best. Source files remain intact for export. See [ARTIFACTS.md](docs/ARTIFACTS.md) for rendering boundaries and verification limits.

## Verify and explore

```sh
bun install --frozen-lockfile
bun run typecheck
bun run verify
bun run verify:artifacts
bun run verify:remote
bun run --cwd verification/durable test
bun install --cwd server/pi-durable --frozen-lockfile
bun run --cwd server/pi-durable test
bun run --cwd server/pi-durable build
bun install --cwd server/pi-bridge --frozen-lockfile
bun run --cwd server/pi-bridge typecheck
bun run --cwd server/pi-bridge test
bun run --cwd server/opencode-gateway test
bun install --cwd verification/opencode --frozen-lockfile
bun run --cwd verification/opencode test
bun run --cwd verification/opencode test:integration
bun install --cwd experiments/pi-durable --frozen-lockfile --ignore-scripts
bun run --cwd experiments/pi-durable test
node docs/provider-audit/audit.mjs --verify
bun run preview:export
```

| Path | Responsibility |
| --- | --- |
| `App.tsx` | Chat shell, sidebar/history, artifacts, and connection navigation |
| `src/chat/` | Native assistant-ui runtime adapter and editable registry elements |
| `src/session/` | Session authority, demo, remote-session and OMP/Pi/OpenCode/Pi Durable drivers |
| `src/workspace/` | Pairing, bounded discovery, saved access, and harness selection |
| `src/harness/` | Capabilities, bridge protocol, and known write-file extraction |
| `src/artifacts/` | Artifact model, native readers, isolated HTML, export |
| `server/pi-durable/` | Authenticated durable sessions, configured model runtime, immutable artifact storage |
| `server/workspace/` | Shared self-hosted endpoint and private upstream-credential translation |
| `server/omp-remote/` | Public OMP extension, same-process session snapshots and forwarding receipts |
| `server/tern-remote/` | Window plugin, local bridge and bounded Tern agent access |
| `scripts/setup-cloudflare.mjs` | Guided, reviewed Cloudflare backend provisioning |
| `verification/durable-runtime/` | Actual mobile store + celld crash/cache-removal integration |
| `server/pi-bridge/` | Pi process, RPC translation, authenticated WebSocket server |
| `server/opencode-gateway/` | Restricted OpenCode routes and credential-free provider catalog |
| `experiments/pi-durable/` | Isolated real SQLite/process recovery experiment |
| `experiments/pi-celld/` | Real PiHarness/celld process, alarm, and backing-store recovery checks |
| `docs/provider-audit/` | Reproducible versioned catalog counts and primary-source hashes |
| `tooling/` | Pinned development CLIs and environment checks |
| `.maestro/` | Device interaction flows |
| `.eas/` | Optional manually triggered hosted workflows |

See [DESIGN.md](docs/DESIGN.md) for architectural decisions and [VERIFICATION.md](docs/VERIFICATION.md) for observed checks.

## Primary references

- [Native assistant-ui](https://www.assistant-ui.com/docs/react-native)
- [Expo development builds](https://docs.expo.dev/develop/development-builds/introduction/)
- [OMP Collab](https://omp.sh/docs/collab)
- [Pi](https://github.com/earendil-works/pi)
- [Tern Plugin SDK](https://docs.stencil.so/tern/)
- [React Native Markdown renderer](https://github.com/gmsgowtham/react-native-marked)
- [React Native WebView](https://github.com/react-native-webview/react-native-webview)
