# Third-party notices

## Oh My Pi Collab client and wire types

Copyright (c) 2025 Mario Zechner.
Copyright (c) 2025–2026 Can Bölük.
Copyright (c) 2026 Stencil Labs, Inc.

MIT licensed. The complete upstream license is in `src/vendor/omp/LICENSE`.

Upstream: https://github.com/can1357/oh-my-pi

Pinned commit: `3f7276200adf434fda1d97357ccc7fcd344066fe`.

Vendored sources:

- `packages/collab-web/src/lib/client.ts`
- `packages/collab-web/src/lib/socket.ts`
- `packages/collab-web/src/lib/link.ts`
- `packages/collab-web/src/lib/codec.ts` as `codec.web.reference.ts`
- `packages/wire/src/index.ts` as `wire.ts`

Local changes:

- Imports use the vendored wire types; unrelated stream/TSP re-exports are omitted.
- Bun-specific timer types use `ReturnType<typeof setTimeout>`.
- `Promise.withResolvers` uses a standard Promise constructor for portability.
- `codec.ts` re-exports the upstream WebCrypto implementation. Metro uses the new
  `codec.native.ts` adapter on Android/iOS, backed by Expo native AES-GCM with the
  identical OMP envelope format. No upstream encryption algorithm is replaced.
- Tool/approval questions stay pending until the authoritative host dismisses
  them, instead of being optimistically dismissed when the guest sends an answer.
- Commands are bound to the connection on which they were submitted. Unsent
  commands are reported as errors and are never queued for a later reconnect.

The native app's session projection and synthetic demo are Perch prototype code.
Perch is not affiliated with or endorsed by the OMP or Tern maintainers.

## assistant-ui native registry

Native registry elements are copied from the MIT-licensed assistant-ui project
at commit `78557063f8b70c540ca0b1e07eca5cc4fe0216d7`.
The complete license and provenance are in `src/chat/registry/LICENSE` and
`src/chat/registry/UPSTREAM.md`. Perch supplies its own external-store
projection, component slots, theme, and artifact workspace.

## Development skills and dependencies

Official Expo skills are copied into `.agents/` with revision and provenance.
They are development instructions and do not enter the mobile bundle.

Official assistant-ui skills are copied unmodified from
`https://github.com/assistant-ui/skills` at commit
`139674dc888ee076982b6726e8e6f5d0fe0b5f67` into `.agents/skills/`.
All 17 skills retain their MIT frontmatter declarations. The upstream README,
including its MIT declaration, is preserved as
`.agents/skills/ASSISTANT_UI_UPSTREAM_README.md`; upstream has no separate
LICENSE file. Revision and per-file hashes are in
`.agents/skills/ASSISTANT_UI_PROVENANCE.json`. These skills and their references
are development guidance and do not enter the mobile bundle.

The APK also carries `assets/third-party-notices.txt`, generated from Bun's
locked production package graph and these vendored runtime sources.
It copies full license and NOTICE files, including nested notices, and includes
reviewed supplements where an npm tarball omits its shared upstream license.
The inventory is deliberately broader than the mobile bundle: production
dependencies can include build tools and web adapters. It does not claim that
every listed package, development skill, or bridge enters the APK. Native
Android dependencies can also retain their own notices in APK metadata.

After `bun install --frozen-lockfile`, regenerate with
`bun scripts/generate-third-party-notices.mjs`; CI checks the committed asset
with the same command plus `--check`. The helper uses Bun's native JSONC parser
to read `bun.lock`, walks production and peer dependency edges, and verifies
the package versions that the installed module layout resolves. A stale nested
package cannot silently change the notice inventory. Missing required packages,
unknown licenses, unresolved full text, changed supplement checksums, and
dependencies that disagree with the lockfile fail the check. Optional peers
that are absent from the lockfile are excluded. Pinned supplements and their
upstream Git blob IDs
are in `scripts/third-party-license-supplements.json`. Version mappings must be
reviewed when affected packages change. The one metadata-only fallback for
`structured-headers@0.4.1` is identified in the generated entry: the package
declares MIT and its author but supplies no separate copyright notice. The
generator preserves that attribution and adds the standard MIT permission and
warranty text without inventing a copyright holder or date.

The inventory uses package identities rather than physical installation paths.
Platform-specific Lightning CSS and Tailwind Oxide compiler bindings run on the
build host and are represented by the full licenses of their portable parent
packages. Their optional binary and WASM subtrees do not enter this inventory.
This avoids changes caused only by operating system, libc, or package hoisting.
The migration from npm preserved all 581 remaining package notice texts exactly;
the eight removed GNU/musl binding rows had license text identical to their
included parent packages. The generator pins and checks those shared license
hashes. No mobile runtime package was removed from the notice inventory.

App, tooling, and bridge dependency versions are pinned in separate lockfiles.

## Isolated integration and recovery experiments

The OpenCode integration fixture pins the MIT-licensed `opencode-ai` package at
version `1.18.35`, corresponding to upstream commit
`53d1eabb61e21162157817bf677da0a4ad3332e3` in
`https://github.com/anomalyco/opencode`. Its server is installed under the
verification package when requested; neither its binary nor SDK is copied into
the mobile app or the source archive. The adapter and host gateway are Perch code.

The Pi Durable experiment pins `@earendil-works/pi-durable`,
`@earendil-works/pi-ai`, and `@earendil-works/chord` at `1.0.4` in its own package
and lockfile. Their installed distributions retain their upstream licenses.
These test-only dependencies do not enter the mobile bundle.
