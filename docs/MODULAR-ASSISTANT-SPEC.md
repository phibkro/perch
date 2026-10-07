# Perch 0.4: models, harnesses, and hosting

## User goal

Build a modular assistant where the user can change provider/model, choose a harness when needed, and use self-hosted or cloud infrastructure. Make agent work easy to follow and its generated artifacts comfortable to consume. Audit how much Pi/OMP provider coverage we can reuse, and compare Pi Durable with Pi running in a Cloudflare container.

The previous accepted next step was an OpenCode server adapter for real remote history and New chat. Preserve the native assistant-ui chat, sidebar, bottom composer, existing OMP/Pi connections, and artifact readers. Target remains Pixel 8a / GrapheneOS.

## Required implementation

1. Add an OpenCode HTTP/SSE driver behind the existing shared harness contract. Keep provider keys on the host. Require authenticated HTTPS remotely; loopback HTTP is for local development.
2. Project real OpenCode sessions, history, model metadata, messages, tool activity, supported permission/questions, and interruption. Derive artifacts from assistant content or complete known write inputs, never inferred logs or arbitrary filesystem reads.
3. Create and select remote sessions explicitly. Retain the old transcript until the replacement snapshot is authoritative. Guard pending transitions and stale callbacks. Reconnecting must not resend mutations or silently retry ambiguous session creation.
4. Add searchable, provider-filtered, virtualized host model selection. The identity is the provider plus model ID. Do not impose an app-side provider allowlist.
5. Preserve OMP and Pi's current single-session capabilities. Connecting another harness does not promise automatic transcript, tool state, or plugin migration.
6. Keep infrastructure behind the selected server address. Do not add a nonfunctional cloud provisioning switch or claim a deployment.
7. Audit exact Pi and OMP catalogs reproducibly; distinguish namespaces, models, aliases, dynamic providers, host configuration, transport support, and tested accounts.
8. Compare Pi Durable's real recovery semantics with the CLI. Verify an isolated durable core with process crashes and synthetic model/tools; distinguish this from Cloudflare runtime tests and a mobile integration.
9. Deliver 0.4.0 / Android version code 4, updated source, preview, Android builds, and findings.

## Evidence boundaries

The fixed baseline is `4c2d41e932fbca2f00984f848640e3ae035d05e8`. This request and spec are the authority; the project has no external issue tracker. Relevant standards remain the root agent guide, DESIGN, ARTIFACTS, DEVELOPMENT, and the installed native assistant-ui contract.

Use real local OpenCode and Pi Durable runtimes where possible with synthetic inference. No user model account, cloud deployment, physical Pixel, or native WebView test is implied. Record checks and limits in VERIFICATION and the focused guides.
