# Perch 0.2 implementation brief

## User requirements

The current request, paraphrased:

> Set up the development-tool shortlist and rewrite the app with assistant-ui. The goal is a model and harness agnostic AI chat app, with better previews of generated Markdown, HTML, and code. Target Tern and OMP first, and Pi for self-hosted models.

The established device is a Pixel 8a with GrapheneOS. The existing source is an Expo/React Native OMP prototype. Preserve its connection, read-only and question behavior, recoverable drafts, and signing key.

## Implementation scope

1. Use actual native assistant-ui elements over the authoritative store.
2. Separate harness identity, model metadata, capabilities, transport, and presentation.
3. Preserve OMP Collab for the initial Tern/OMP route.
4. Include a runnable authenticated Pi RPC bridge using host-configured models.
5. Provide a dedicated Markdown/HTML/code workspace with source, copy, and export.
6. Set up Expo skills/MCP, a development client, agent-device, Maestro, EAS profiles/workflows, and optional update configuration.
7. Verify locally available flows and deliver source, standalone preview, and Android builds.

No account authentication, physical device, or private host configuration was supplied. Prepare runnable setup without inventing connections or claiming device/host tests.

## Behavioral requirements

- The host owns execution; the phone does not wrap it in another agent loop.
- The model/provider is separate from the harness.
- Actions obey connection state, capabilities, and read-only access.
- Reconnect refreshes state without replaying prompts.
- Answers refer to the displayed question. OMP answers stay pending until host dismissal; Pi's unacknowledged UI-response protocol must distinguish forwarding from proof of processing.
- Drafts remain session-scoped. Restoring submitted text does not send it.
- Generated content remains separate from app execution and credentials.
- Demonstrations are visibly synthetic and need no model/server.

## Review baseline

The restored 0.1 baseline is `cbe44e395b6e0b909f75dc6485851b6bc33e7ec0`. The user request and this brief are the spec source. This local project has no external issue tracker.
