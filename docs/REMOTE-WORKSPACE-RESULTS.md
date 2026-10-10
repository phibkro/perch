# Remote workspace prototype: implementation and evidence

**Perch 0.7.0 / Android version code 8 — 10 October 2026.**

The [grounding design](REMOTE-WORKSPACE-DESIGN.md) was written before this
implementation. The delivered first slice lets the native app discover a
configured host, attach explicitly to an existing session, read its conversation
and artifacts, send or interrupt work, and reconnect without replaying a prompt.
The original process owns the agent and conversation throughout.

This record distinguishes the native client, controlled protocol tests, actual
upstream runtime tests, and device checks. Passing one boundary does not establish
the others.

## Delivered behaviour

| Capability | OMP extension | Tern window plugin |
| --- | --- | --- |
| Existing session discovery | Current main OMP session, process ID and conversation ID | Agent panes across up to eight registered windows |
| Native Attach / Detach | Supported | Supported |
| Recent conversation | Host branch history plus a bounded streaming overlay | Bounded structured transcript from Tern |
| Prompt / Interrupt | Public APIs in the original OMP process | Targeted native agent APIs for a compatible OMP surface |
| Model selection | Host-advertised models, while idle | Remains a host action |
| Artifacts | Existing readers, including complete bounded write inputs | Existing readers for rendered conversation text |
| Reconnect | Identity checks, fresh snapshots and receipt reads | Identity checks, fresh snapshots and receipt reads |
| Host conversation changes | Known transcript identity and generation changes | Canonical OMP conversation identity is unavailable |
| Approvals and custom host UI | Host decision notices; answers remain on the host | Unsupported views are stated; unavailable composer disables send |

The app retains its New chat home, sidebar, bottom composer and artifact readers.
A remote connection first opens **Host sessions**. It does not choose the first
row, create another agent process, or submit a prompt. Attachment shows the
selected runtime and its identity, activity and limitations. Detach returns to
the browser and leaves host work running.

Remote drafts and artifact selection are scoped by the known host epoch,
generation and conversation identity. A replacement instance requires a new
attachment. Tern's missing canonical conversation identity remains visible as
a limitation; the client does not invent one by matching titles.

## Implementation map

| Area | Source |
| --- | --- |
| Shared bounded protocol | [src/harness/remote.ts](../src/harness/remote.ts) |
| Native session driver | [src/session/remote.ts](../src/session/remote.ts) |
| Host browser and attachment details | [src/ui/RemoteSessions.tsx](../src/ui/RemoteSessions.tsx) |
| Pairing and restricted routing | [Workspace gateway](../server/workspace/README.md) |
| OMP adapter and host instructions | [server/omp-remote](../server/omp-remote/README.md) |
| Tern adapter and host instructions | [server/tern-remote](../server/tern-remote/README.md) |

The new `remote` connection kind fits the existing workspace manifest. Both
adapters use `perch-remote` version 1 and advertise snapshot synchronization.
The gateway translates the workspace credential into a separate local adapter
credential and permits only the documented session routes. Private Tern plugin
exchanges and general host control APIs are not public gateway routes.

`forwarded` means the adapter invoked the same-process interface. It does not
mean a model turn finished or a tool effect was persisted. Unknown outcomes stay
unknown. Command IDs are reserved before dispatch; their bounded ledgers reject
new IDs when full instead of evicting old identities and allowing a duplicate.

## Actual upstream checks

### OMP 18.8.7

The optional verifier pins OMP **18.8.7** and records reviewed source commit
`b07a1c146d0d12cfc855a2c65d52f892ef319040`. Its own
[package and Bun lockfile](../server/omp-remote/upstream/package.json) are separate
from the phone's dependencies. Frozen installation passed.

Two verifier modes passed: the actual SDK session with OMP's non-interactive
extension runner, and the stock **InteractiveMode with its extension UI
controller**. Each created one real upstream AgentSession and made four calls to
OMP's deterministic in-memory mock provider. No paid provider call occurred.

The checks observed existing history, phone-originated prompt admission,
deduplication, receipt-only reconnect, interruption of an active turn, model
selection in that session, a real host `/new` transition, and listener shutdown
when OMP disposed the session. The phone-originated answer also appeared in the
stock TUI's captured terminal output. Interactive verification ran again after
the projection review corrections.

The terminal used an output recorder supplied through OMP's terminal option.
It was not a VT emulator or a physical display. See the complete machine-readable
[OMP verification record](../server/omp-remote/verification-results.json).

### Tern 0.6.0 beta

The supplied Linux binary reports **Tern 0.6.0 (`0e39682`)**. Its generated
plugin declarations confirmed the window, transcript, surface and agent APIs.
The binary is not redistributed with Perch.

The actual beta ran the production Luau plugin in its documented deterministic
headless fixture environment. A local synthetic program spoke TSP over a real
PTY. The check observed an existing transcript, delivered a Unicode prompt once,
read the updated transcript, retained the same child process, reconnected without
replay, rejected a prompt when the native composer was unavailable, and sent
Ctrl-C without ending the program.

Qualification exposed two integration details incorporated into the plugin:
normal exchanges chain asynchronous HTTP callbacks with a short server-held
response, and a send-ready editor must belong to the normal `omp.editor`
wrapper. The plugin validates that surface and invokes `ask` in the same
synchronous callback, avoiding Tern's deferred prompt queue.

This was an actual Tern/plugin/PTY test with a synthetic peer. It did not run a
real OMP model turn inside Tern, restore the user's desktop, or contact a phone.
The OMP and Tern upstream checks are separate pieces of evidence; they are not
an end-to-end Pixel → Tern → real provider run.

See the [Tern qualification record](../server/tern-remote/VERIFICATION.md) and
[machine-readable results](../server/tern-remote/verification-results.json) for
binary and declaration hashes, exact commands and the final post-review run.

## Native and regression checks

| Check | Observed result |
| --- | --- |
| Application TypeScript | Passed |
| Native remote driver | 7 tests / 78 assertions; actual SessionStore with a loopback HTTP fixture |
| Workspace driver and integration | 14 tests / 116 assertions |
| Workspace gateway and setup | 16 tests / 177 assertions, including the new remote routes |
| OMP remote HTTP/configuration | 16 tests / 121 assertions |
| Tern remote HTTP/configuration | 16 tests / 133 assertions |
| Actual exported-app DOM | 113 checks passed; 13 remote fixture requests |
| Existing keyboard regression | All five installed-component layout cases passed |
| Existing session and artifact verifiers | Passed |
| OpenCode and Pi Durable client verifiers | Passed |
| Durable backend and production bundle | 29 tests passed; production bundle succeeded |
| Release/runtime guards and artifact handoff | 17 Node tests and six Python tests passed |
| Version, signer and dependency notices | Preflight passed; 0.7.0/code 8 and 581 packaged dependency identities |

The remote driver checks explicit selection, same-process reads after a new
client connects, host replacement, stale asynchronous results, detach races,
lost command replies, receipt reconciliation, redirects and response limits.
The gateway fixture drops a real HTTP command response after recording it and
then returns its receipt. Reconnect reads that receipt without another POST.

The DOM runner executes the exported Expo application with controlled transports.
It exercises the actual Attach/Detach controls, runtime metadata, composer,
independent drafts, replacement identities and artifact readers. Its full run
made 71 OpenCode and 23 durable fixture requests, read five durable artifacts,
and reported no JavaScript errors or outside network attempts. One known jsdom
CSS parser limitation is recorded separately. The preview contained all eight
JavaScript chunks and was 8,641,137 bytes.

Neither DOM emulation nor the keyboard component fixture measures native
painting, IME animation, touch gestures or Android background networking.
The combined `bun run verify:remote` command passed after all review corrections:
39 tests, 332 assertions, no failures.

## Review against the grounding design

The change was reviewed against baseline
`4f32bd6169a62937b1c139812d43908e3110db52` on separate Standards and Spec axes.

### Standards

- Tern originally changed every presentation ID when any capped transcript row
  changed. Bounded row reconciliation now preserves uniquely identifiable rows,
  anchored final-assistant growth and related tool IDs. Ambiguous rows receive
  new IDs. A regression covers streaming and a shifted transcript window.
- An absent OMP receipt originally acquired the current conversation identity.
  It now returns HTTP 404 so the client can mark the old outcome unknown and
  continue refreshing the catalog after a host session change.

The Standards reviewer rechecked both corrections and found them resolved.

### Spec

- Tern's local listener needed the documented browser-origin rejection.
- Tern's credential locations needed the same ownership and repository-placement
  checks used by the OMP adapter.
- OMP's response-budget eviction favoured old messages over new tool output.
  It now compares source recency across both collections. The regression keeps
  the latest 100,000-character tool result while removing older large messages.

The review found no additional scope creep or first-slice lifecycle gap. Tern
dispatch exceptions are also treated conservatively: preflight failures can be
rejected, while an error after invoking the native interface has an unknown
effect unless the host establishes otherwise.

The Spec reviewer rechecked all three corrections and found them resolved,
including credential paths reached through linked ancestors. No original
Standards or Spec finding remains open.

The full gate caught a NodeNext type-import extension omission in the shared
protocol. Correcting the erased type import restored the standalone artifact
verifier; both that verifier and the application typecheck passed afterward.

## Repeat the checks and try a host

From a Perch checkout with its locked dependencies installed:

```sh
bun run typecheck
bun run verify:keyboard
bun run verify
bun run verify:artifacts
bun run verify:workspaces
bun run verify:remote
bun run --cwd server/workspace test
```

The real OMP verifier has an isolated optional dependency install; the real Tern
verifier needs the compatible beta binary. Exact commands and their boundaries
are in the respective adapter READMEs. Neither verifier needs a provider key.

For a real host, start with the OMP extension for conversation identity and
model control. Add the Tern plugin when pane and workspace context is useful.
Install/configure the selected adapter on the host, add it with
`bun run setup:host`, run the workspace gateway behind the host's HTTPS endpoint,
and pair the phone once. In Perch, select the connection and then **Attach**.
See [workspace setup](WORKSPACE-SETUP.md) for the complete path.

## Release and remaining qualification

The [Perch 0.7.0 prerelease](https://github.com/phibkro/perch/releases/tag/v0.7.0)
was published at **03:58:34 UTC on 10 October 2026**. All three jobs in
[workflow 38021389970](https://github.com/phibkro/perch/actions/runs/38021389970)
passed on attempt 1, from source commit
`f717410d6f415e1e8ec359f1402a23fff50d0030` and tree
`bd435e231cbaa8434e883056c72051c115670af5`. Native compilation and enabled lint
took 15 minutes 55 seconds.

The [ARM64 APK](https://github.com/phibkro/perch/releases/download/v0.7.0/perch-prototype-arm64.apk)
is **47,822,986 bytes**, version **0.7.0 / code 8**, with package
`dev.perch.assistant` and the preserved prototype signer. Its SHA-256 is
`55566a3a7f33f2ed25724bcc5fa00b8c73855965ab8f00767ca170a1db984fa4`.

Independent download verification passed at **04:00:21 UTC**: all GitHub asset
digests and checksums matched, as did source/tag/run provenance, actual package
and version, the v2 signature and signer, embedded bundle and notices, ZIP
alignment and all 21 ARM64 native libraries. Full CI and independent binary
results are recorded in [Android build verification](ANDROID-BUILD.md).

The remaining device trial is to install the resulting APK on the Pixel 8a,
attach to the user's host, type while the GrapheneOS keyboard is visible, inspect
an artifact, lock and reopen the phone during host work, and confirm that the
same process and latest conversation reappear without another submission.

Native TSP widgets, a real VT terminal, host approval answers, arbitrary file
fetches, explicit OMP/Tern identity linking and attachment independent of a Tern
window remain subsequent milestones. This adapter does not checkpoint a running
host, persist command receipts across its crash, or inherit Pi Durable's recovery
contract. No Cloudflare resources were provisioned for this slice.
