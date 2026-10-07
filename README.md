# Perch 0.5

**A native AI workspace with replaceable models, harnesses, and hosting.**

Perch connects a phone to an agent running on your own host. The chat uses native **assistant-ui** components. Generated Markdown, HTML, and code open in a dedicated artifact workspace with preview, source, copy, and export.

The connections are **Pi Durable**, **OMP Collab**, including OMP running inside Tern, a **Pi RPC bridge**, and **OpenCode through the included host gateway**. The phone renders the conversation and artifacts; the host owns provider configuration and tool execution. A server address can point to your hardware or a cloud host.

The current target is a Pixel 8a running GrapheneOS. The project uses Expo 57, React Native, native assistant-ui, and Uniwind. Platform action buttons use Expo UI. iOS shares the application source but has not been built or device-tested.

## Chat first

The app opens on **New chat** with the composer at the bottom. The sidebar contains chats, artifacts, connections, and settings. It stays visible on wide screens and opens from the menu on a phone. There is no bottom navigation bar.

The demo supports separate new conversations and drafts. Its first message becomes the chat title. Pi Durable and OpenCode add real remote history and New chat. During a session change, the current transcript stays visible until the replacement is ready. Current OMP and Pi connections each expose one host session: **New chat** explains how to connect another session and leaves the current transcript intact.

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
npm ci
npm run web
```

To develop on Android:

```sh
npm run tools:install
npm run tools:doctor
npm run dev:android
```

To build a standalone APK or a separate development client:

```sh
npm run apk
npm run apk:development
```

The standalone app keeps the original package ID and prototype signing key so it can update earlier versions. The development app has a separate identity and can be installed alongside it. See [DEVELOPMENT.md](docs/DEVELOPMENT.md) for SDK setup, Expo MCP, agent-device, Maestro, EAS profiles, and output locations.

Development CLIs are pinned separately in `tooling/` so they do not become application dependencies. EAS services and Expo MCP still require your own account connection. Local builds and the demo do not.

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

## Connect Pi Durable

[Pi Durable setup](docs/DURABLE-BACKEND.md) connects the phone to Perch's own persistent backend. It uses actual PiHarness/Lifecycle, one SQLite cell per chat, and a separate bucket binding for artifact bytes.

1. Build and configure `server/pi-durable` with a workspace token and an OpenAI-compatible host model.
2. Start the backend through your Workers-compatible runtime and expose a remote endpoint with HTTPS.
3. In Perch, choose **Connect a workspace → Pi Durable**, then enter that endpoint and workspace token.
4. Choose **New chat**. Generated files saved by `write_artifact` open in Artifacts and can be reopened after reconnecting.

Model keys stay on the backend. Workspace tokens authorize that workspace's sessions and files. The production entry has no demo-model fallback. The first provider implementation targets explicitly configured OpenAI-completions-compatible endpoints; it does not yet expose every provider in the Pi RPC catalog.

## Connect OMP in Tern

1. Start OMP in your Tern workspace and run OMP's `/collab` command.
2. Open **Connect a workspace → OMP Collab** from the sidebar in Perch.
3. Paste the complete Collab link and enter your participant name.
4. Choose **Join workspace**.

Perch uses OMP's encrypted Collab guest protocol. It waits for the protocol handshake and synchronized snapshot before showing the session as live. View-only links remain view-only. The pinned upstream client is identified in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

This route uses OMP's existing interface inside Tern and does not depend on Tern bundling its web distribution. It does not render Tern terminal panes, TSP surfaces, or plugin windows.

## Connect Pi to your models

```sh
npm ci --prefix server/pi-bridge
```

Follow [the Pi bridge guide](server/pi-bridge/README.md) to select a working directory, configure a token, and expose the bridge to your phone over WSS. Use **Connect a workspace → pi bridge** in the sidebar to enter its address and token.

The bridge starts a real `pi --mode rpc` subprocess. It uses your host's Pi configuration, including self-hosted providers. The phone receives host-reported model metadata and lets you select among the models the host advertises. Reconnecting attaches to the same bridge process instead of replaying a prompt.

## Connect OpenCode

Follow [the OpenCode guide](docs/OPENCODE.md) to run your server behind `server/opencode-gateway/`, then use **Connect a workspace → OpenCode**. Enter the gateway's HTTPS address, username, and password. Model providers and subscriptions are configured on the OpenCode host.

The gateway exposes only the session APIs Perch needs and removes provider credentials from the catalog. The app requires its versioned handshake before requesting models; a raw OpenCode endpoint is rejected. The source and tests pin OpenCode 1.18.35.

## Providers and the durable foundation

Model search and provider filters use the connected host's catalog, with virtualized rows. A selection is a provider/model pair. The [reproducible provider audit](docs/PROVIDERS.md) records **41 Pi and 71 OMP provider definitions with bundled chat models**. OMP's raw catalog contains 72 IDs; one has no matching provider definition and is excluded from that headline. The definition-backed sets contain **83 literal IDs in their union**, or **78 groups after five documented naming mappings**. These counts do not establish account access or test every route. Pi, Pi Durable, and OpenCode expose phone model selection; the current OMP Collab adapter reports the host's selection.

The included Pi version has an OpenCode Go provider. [Configure your subscription on the host](server/pi-bridge/README.md#opencode-go-subscription) using the supplied [environment example](server/pi-bridge/opencode-go.env.example). Go is intended for coding-agent traffic; a configured provider does not establish an account's entitlement. No subscription request was made during verification.

[Pi Durable](docs/PI-DURABLE.md) is the recommended basis for Perch's own persistent assistant: the same durable core can use Node SQLite at home or PiHarness in Cloudflare Durable Objects. The isolated experiment kills real processes and verifies safe-tool replay, unsafe-tool interruption, and model recovery. Perch 0.5 now supplies a mobile backend through `server/pi-durable`. [Cloudflare hosting](docs/CLOUDFLARE.md) describes the proposed Worker/DO/R2 setup with Sandbox for Linux work and richer project previews. No cloud resource has been deployed.

[OpenClaw and Hermes](docs/ASSISTANT-INTEGRATIONS.md) are researched future assistant backends. The proposed adapters use their native client APIs to preserve sessions, decisions, memory, and artifacts. OpenClaw has an experimental Cloudflare Containers template; Hermes would need a custom Linux deployment. Their recovery guarantees depend on the selected transport and preserved state. Neither adapter is included in 0.5.

[Pi Durable on celld with R2](docs/PI-CELLD.md) explores a self-hosted persistent-agent route: celld owns cell storage, ownership, and wake-up; Pi owns continuation and tool replay. The existing PiHarness adapter now passes [real celld recovery checks](docs/PI-CELLD-RESULTS.md), including alarm-driven continuation after removing all local runtime data while work is unfinished. The [durable backend](docs/DURABLE-BACKEND.md) adds the mobile protocol and stored artifact downloads. R2 and multi-node failover remain separate deployment checks. The earlier [runnable experiment](experiments/pi-celld/README.md) preserves the recovery evidence that led to this composition.

## Implemented behavior

| Area | Current behavior |
| --- | --- |
| Chat | Native assistant-ui Thread, Message, Composer, and tool-call elements over an external store |
| Harness boundary | Separate harness/model metadata, capabilities, and transport adapters |
| OMP | Encrypted Collab, prompt, interrupt, supported host questions, synchronized reconnect |
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

Phone secrets, drafts, and unresolved submission IDs currently stay in memory and reset when the app restarts. Durable server chats and files remain on the host; reconnect and inspect history after restarting the phone. Attachment upload, durable offline history, background notifications, voice, and arbitrary Tern/plugin interfaces remain future work. Controls follow the adapter's implemented capabilities.

HTML starts with scripts disabled. Its preview uses an opaque-origin inner frame, restrictive content policies, and no application bridge. Self-contained pages work best. Source files remain intact for export. See [ARTIFACTS.md](docs/ARTIFACTS.md) for rendering boundaries and verification limits.

## Verify and explore

```sh
npm ci
npm run typecheck
npm run verify
npm run verify:artifacts
npm test --prefix verification/durable
npm ci --prefix server/pi-durable
npm test --prefix server/pi-durable
npm run build --prefix server/pi-durable
npm ci --prefix server/pi-bridge
npm run typecheck --prefix server/pi-bridge
npm test --prefix server/pi-bridge
npm test --prefix server/opencode-gateway
npm ci --prefix verification/opencode
npm test --prefix verification/opencode
npm run test:integration --prefix verification/opencode
npm ci --ignore-scripts --prefix experiments/pi-durable
npm test --prefix experiments/pi-durable
node docs/provider-audit/audit.mjs --verify
npm run preview:export
```

| Path | Responsibility |
| --- | --- |
| `App.tsx` | Chat shell, sidebar/history, artifacts, and connection navigation |
| `src/chat/` | Native assistant-ui runtime adapter and editable registry elements |
| `src/session/` | Session authority, demo, OMP/Pi/OpenCode/Pi Durable connection drivers |
| `src/harness/` | Capabilities, bridge protocol, and known write-file extraction |
| `src/artifacts/` | Artifact model, native readers, isolated HTML, export |
| `server/pi-durable/` | Authenticated durable sessions, configured model runtime, immutable artifact storage |
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
