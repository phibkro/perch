# Perch 0.3: chat layout and hosting options

## User request

> Redesign the app to the traditional AI chat app layout: New chat as the main page, sidebar navigation, main content on screen, no bottom navigation, and the chat box at the bottom. Could we add bring your own subscription, mainly OpenCode, and run agents on Cloudflare products? Which products fit?

The target remains a Pixel 8a with GrapheneOS. Preserve the existing native assistant-ui, OMP/Tern path, Pi bridge, artifact readers, host questions, drafts, reconnect behavior, development tools, and prototype signing identity.

## Required behavior

1. Open directly into a blank New chat in the offline demo.
2. Put chat history, artifacts, connection, and settings in a sidebar; use a dismissible drawer on phones and a persistent sidebar on wide screens.
3. Remove bottom navigation. Keep the composer at the bottom for both empty and populated conversations.
4. Create independent demo conversations with unique draft namespaces. Derive a useful sidebar title from the first message without changing the actual message.
5. Preserve drafts and ongoing work when opening another chat. Offline actions must not mutate the frozen session snapshot.
6. Keep real host history authoritative. Current single-session OMP/Pi adapters must not pretend to create remote sessions, clear the transcript, or switch into demo mode merely because New chat was pressed. Explain the boundary and offer explicit choices.
7. Keep artifact preview/source/copy/export, question/editor flows, read-only controls, model selection, theme controls, and reconnect without replay reachable through the new navigation.
8. Verify layout-related state and DOM flows, then provide updated source, standalone preview, and Android builds with version 0.3.0 / version code 3.

## Subscription and cloud scope

Research current primary documentation and make a concrete configuration available where supported. The installed Pi 1.0.4 provider supports OpenCode Go, so provide a private-environment setup example and explain coding-use scope, host-side credentials, provider identity, and Go/Zen billing differences. Do not imply a successful subscription request without one.

Document the Cloudflare products that fit existing CLI execution, conversation coordination, artifacts, credentials, and preview servers. Distinguish Linux-hosted Pi from the experimental Pi Durable integration. Keep a future OpenCode harness adapter and all Cloudflare deployment work explicitly proposed. No account, key, cloud project, or spending authorization was supplied for a deployment.

## Review and evidence

The fixed pre-change baseline is `c38279f936c364149a8184c55635b624776d9960`. This request and document are the current spec source; the previous 0.2 rewrite remains documented separately in [REWRITE-SPEC.md](REWRITE-SPEC.md). The project has no external issue tracker.

Use [DESIGN.md](DESIGN.md), [ARTIFACTS.md](ARTIFACTS.md), [DEVELOPMENT.md](DEVELOPMENT.md), the root agent guide, and the pinned native package contract for review. Record observed checks and remaining physical-device limitations in [VERIFICATION.md](VERIFICATION.md).
