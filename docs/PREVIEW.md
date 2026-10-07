# Standalone browser preview

Run from the project root:

```sh
node scripts/export-preview.mjs
```

This re-exports the actual Expo web application and creates
`../outputs/perch-prototype.html`. Open that file directly in a modern browser.
The synthetic session demo works without a server or internet connection.

The 0.4 preview opens on New chat with the composer at the bottom. Use the menu
to open chat history, Artifacts, or Connection & settings; at wider widths the
sidebar stays visible. Preview artifacts and Try an agent open the seeded
example conversations. New chat creates another independent demo thread.

For a different destination:

```sh
node scripts/export-preview.mjs --output /path/to/perch-prototype.html
```

`--skip-export` is available when `dist-web` has just been rebuilt from the current
source. Normal use should keep the export step.

The normal command clears only its generated `dist-web` directory before building.
Chunk inlining follows references from the current HTML entry, so even
`--skip-export` ignores stale bundles left by an earlier Expo export.

The preview is the app's production web build, including its real React Native
Web screens, native assistant-ui web implementations, artifact workspace, demo
session store, and OMP Collab/Pi bridge/OpenCode gateway clients. It is not a second mockup.
Android Jetpack Compose / iOS SwiftUI controls use the existing web equivalents
in this preview; install the native application to see the actual platform controls.

The exporter combines the ordered Metro runtime/common/entry scripts, reachable
lazy adapter chunks, and startup in dependency-safe order. It inlines exported assets and transports
JavaScript as base64 so HTML script-closing strings cannot corrupt the payload.
Nothing is loaded from a CDN. Test-fixture URLs and verification tooling are not
part of the app bundle.

The demo starts without network activity. All three real adapters remain included;
connecting requires an explicit user-supplied connection, a reachable host/relay,
and a browser that permits the required WebCrypto/WebSocket APIs from the file's
origin. The Pi bridge also requires an explicitly configured browser Origin
allowlist; see its README. OpenCode uses streaming fetch through its gateway,
which also requires an explicit browser-origin setting. Offline or
failed live connections never pretend to succeed. The normal Expo web deployment
over HTTPS remains the preferred environment for real browser connections.

Composer drafts are scoped to their mode and session. For a submitted live
message, Restore text makes the recoverable text available for editing; it never
resends automatically. Check the host transcript before retrying because local
submission is not proof that the host received or completed the message.

No native Android behavior, background socket survival, or notification delivery
is implied by a browser preview. The preview does not contain credentials or a
working account connection.

The bundled JavaScript and bootstrap were checked for syntax and external asset
references. Browser rendering could not be verified in this execution environment;
no visual-test or native-device result is implied by the HTML artifact.

The offline DOM integration harness exercises the actual exported app with
external network access denied. Its OpenCode routes use an entirely in-memory
HTTP/SSE fixture; unknown requests are rejected. jsdom needs explicit CSSOM and data-only browser API
shims for Uniwind/assistant-ui; those do not validate CSS layout, browser sandbox
enforcement, or native behavior. HTML artifact iframe declarations are inspected
as data, not executed as a browser security test.
