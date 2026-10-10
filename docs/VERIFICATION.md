# Perch verification

## Perch 0.7: native remote sessions

Perch 0.7.0 / Android code 8 adds a native host-session browser, explicit
attachment, an extension inside the original OMP process, and a Tern window
plugin with a protected loopback bridge. The
[grounding design](REMOTE-WORKSPACE-DESIGN.md) defines the first slice; the
[complete results](REMOTE-WORKSPACE-RESULTS.md) record its implementation,
review corrections, repeatable commands and remaining limits.

The native remote driver passed seven tests / 78 assertions against an actual
loopback HTTP fixture. Workspace driver/integration checks passed 14 tests /
116 assertions, and workspace gateway/setup checks passed 16 tests / 177
assertions. The rendered Expo export passed 113 DOM checks, including the actual
Attach/Detach controls, host metadata, separate drafts and reconnect without
another prompt POST. The full run reported no JavaScript errors or outside
network attempts; the known jsdom CSS parser limitation remains separate.

Stronger host checks exercised the real upstream implementations. OMP 18.8.7's
actual AgentSession and stock InteractiveMode passed with one session and four
in-memory mock-provider calls per verifier mode. The phone-originated answer
appeared in captured TUI output. The supplied Tern 0.6.0 (`0e39682`) beta ran the
production Luau plugin and a synthetic TSP peer in a real PTY, covering Unicode
send, current transcript reads, same-process reconnect, unavailable-composer
rejection and Ctrl-C without process exit. These are separate controlled tests,
not a Pixel-to-live-provider run. No paid model calls were made.

App types, the existing session/artifact and OpenCode/Durable client verifiers,
all five keyboard-layout cases, 29 durable backend tests, and the backend's
production build passed. Release/runtime guards passed 17 Node tests and six
Python handoff tests; version/signing preflight and all 581 packaged dependency
notices passed. The new `verify:remote` suite is included in the Android workflow.

The adapters' READMEs and verification records describe precise coverage and
limits. Native TSP/VT rendering, shared host-dialog answers, window-independent
Tern attachment, live-provider integration and physical Pixel/GrapheneOS
suspend-resume remain subsequent work. Android binary evidence is recorded in
[ANDROID-BUILD.md](ANDROID-BUILD.md).

## Perch 0.6: one workspace setup

Perch 0.6.0 / Android code 7 includes the published keyboard fix and adds saved
native workspace pairing, two setup choices, host-side discovery and credential
translation, and the Cloudflare setup runner. Checks below ran on 7 October
2026 against the implementation. Physical device and real-account checks are
listed separately from source and controlled protocol evidence.

| Check | Result | What it establishes |
| --- | --- | --- |
| App TypeScript | Passed | Native setup, workspace state, and existing assistant-ui integration compile |
| Native keyboard regression | Passed, five cases | The installed React Native layout contract retains the 0.5.1 correction |
| Workspace protocol and storage | Passed, 10 tests / 62 assertions | Strict pairing/discovery, bounded manifests, same-origin paths, saved credentials, deletion failure recovery, identity checks, stale discovery, and no prompt replay |
| Real workspace-to-driver integration | Passed, four tests / 54 assertions | Actual WorkspaceManager, discovery, Bun gateway, and Durable/Pi/OpenCode drivers; host history, model identity, streaming, lost-receipt reconciliation, bodyless OpenCode Stop, rejected pairing, clean disconnects, and no prompt replay |
| Host gateway and setup | Passed, 13 tests / 140 assertions | Actual loopback HTTP/WebSocket transport, credential substitution, private configuration, no redirects/replay, OpenCode directory scope, bodyless abort compatibility, exact artifact bytes, SSE cancellation, and ambient proxy isolation |
| Durable backend, providers, and cloud setup | Passed, 29 tests | Existing backend contracts plus actual Pi converters for Chat Completions, Responses, and Anthropic Messages; OpenCode Go headers; authenticated discovery; provisioning failures and private resumable state |
| Production backend bundle | Passed | Pinned Pi Durable backend compiles with all three configured API families |
| Actual Wrangler packaging | Passed | Wrangler 4.148.0 accepted generated config, secrets file, strict mode, both SQLite DO bindings, and R2 in a credential-free deploy dry-run; no resources were created |
| Fresh web export | Passed | 8,603,641-byte standalone preview with all seven JavaScript chunks and exact dependency notices |
| Full rendered-app DOM fixture | Passed | New chat, sidebar, composer, artifacts, existing OpenCode flows, one-code durable pairing, saved reopen, harness chooser, and Forget; 66 OpenCode and 23 durable requests, five artifact downloads, zero JavaScript errors or outside network attempts |
| Existing protocol/artifact gates | Passed | OMP/demo verifier, artifact boundary verifier, OpenCode fixtures, and durable driver fixtures remain valid |
| Version and packaged notices | Passed | All version locations agree on 0.6.0/code 7; prototype signer and 581 dependency notices are preserved |
| Hosted Android build and publication | Passed, first attempt | All three jobs succeeded; lint-enabled ARM64 build, binary gate, trusted artifact handoff, exact source tag, and published prerelease |
| Independent release download verification | Passed | All three GitHub digests and SHA256SUMS match; actual APK identity, preserved signer, SDK/ABI, bundle/notices, and 16 KB ZIP/native ELF alignment verified |
| Physical Pixel / GrapheneOS or iOS | Not performed | Actual keyboard painting/animation, native networking, secure-store lifecycle, and file sharing require a device |
| Real Cloudflare provisioning, provider entitlement, or R2 recovery | Not performed | No account credential or real inference request was used; dry-run packaging and local fixtures do not establish those results |

The DOM runner uses the actual exported application with controlled transport
responses. It verifies rendered structure and interaction, not native layout or
browser enforcement; jsdom reports one known CSS parser limitation. The native
keyboard fixture likewise verifies layout logic rather than a physical IME.

[The 0.6 workflow](https://github.com/phibkro/perch/actions/runs/37598249819)
passed all three jobs on its first attempt, from commit
`a78c4f976426dc24eb691ede260fc72839c66007`, tree
`f46ac138564e0596ad25f985c291c5c49cdbae7d`. The
[0.6.0 prerelease](https://github.com/phibkro/perch/releases/tag/v0.6.0)
was published at 09:24:10 UTC on 7 October 2026. Source checks took 46 seconds;
the native job took 17 minutes, including 15 minutes 56 seconds for compile/lint.
Publication took 18 seconds. The complete workflow took 18 minutes 16 seconds.

All three release assets were downloaded and independently verified at
09:25:42 UTC. The APK is 47,793,490 bytes, with SHA-256
`8111032dfa12381868b6c2ee016beacaa20ddeedde007c4c91b74b16d046f34a`.
It is `dev.perch.assistant` 0.6.0/code 7, non-debuggable and ARM64-only, with
SDK levels 24/36/36 and the preserved signing certificate. Its 6,458,840-byte
application bundle matches the release metadata; CI also checked it against
the generated build bundle. Packaged notices match the exact released source
blob. APK v2 signing, duplicate-entry, ZIP alignment, and all 21 native ELF
alignment checks passed. No additional local 0.6 native build was required.
See [ANDROID-BUILD.md](ANDROID-BUILD.md) for the binary record.

The new integration gates caught and fixed two transport issues before release.
Bun 1.4.2's ambient proxy behavior required explicit direct HTTP agents for
both the gateway and host doctor; a separate-process check confirms that local
adapter credentials never reach the configured test proxy. The OpenCode driver's
bodyless Stop request also required a narrow gateway exception. Every other
POST still requires valid JSON, and the real driver's Stop now passes through
both gateway layers.

Self-hosted setup requires existing local adapters and a reachable HTTPS reverse
proxy. Its doctor checks local adapters without calling a model. It validates
an OMP invitation's format; the phone verifies the live share. The Cloudflare
runner deploys Pi Durable's Worker backend, not a Linux CLI harness. New OMP
SDK/RPC, Codex subscription login, and a Tern Android renderer are researched
directions rather than implemented adapters in this release.

### Repeat the 0.6 setup checks

```sh
bun run typecheck
bun run verify:keyboard
bun run verify:workspaces
bun run --cwd server/workspace test
bun run --cwd server/pi-durable test
bun run --cwd server/pi-durable build
bun run preview:export
node verification/dom-smoke.cjs ../outputs/perch-prototype.html
```

## Perch 0.5.1: Android keyboard hotfix

On 7 October 2026, the installed 0.5.0 app was reported to leave the composer
behind the keyboard on a Pixel 8a running GrapheneOS. The hotfix explicitly
enables Android keyboard avoidance in the native thread and shared input sheet.
It preserves the existing header and safe-area offsets, dependency versions,
and prototype signer. The app version is 0.5.1 with Android version code 6.

`bun run verify:keyboard` reproduces the failure before the change and passes
afterward. It executes the installed native React Native component with Perch's
actual JSX configuration and controlled layout/keyboard events. All five cases
pass: Android portrait, landscape, an already-resized Android window, iOS
header/home-indicator insets, and the Android input sheet. The checks include
layout feedback, increased keyboard-panel height, and dismissal restoration.
The command now runs in the GitHub source-check job.

App TypeScript, the version/signing preflight, all 15 release-guard tests, six
artifact-handoff tests, and actionlint passed locally. The focused
device flow and updated smoke flow check the draft before hiding the keyboard
and capture screenshots. No Android device or emulator was available, so these
flows have not been executed. Native animation, live rotation, and actual Pixel
painting remain device checks.

[The 0.5.1 workflow](https://github.com/phibkro/perch/actions/runs/37594858477)
passed all three jobs on its first attempt, from commit
`58eae30b3763d19076f7b954c16ecfb99fddbbf7`. The
[prerelease](https://github.com/phibkro/perch/releases/tag/v0.5.1) was published
at 08:49:49 UTC on 7 October 2026. The overall run took 13 minutes 43 seconds;
the native build step took 11 minutes 16 seconds with restored caches.
All three published assets were downloaded and verified against the workflow,
source, GitHub digests, and checksum file at 08:51:46 UTC. The APK is
47,736,870 bytes, with SHA-256
`bee88a99cace76c547fa6bbec43f13b7f021110fe41324dfea4511ea31152d75`.
Package/version, preserved signer, SDK levels, ARM64 ABI, non-debuggable status,
embedded bundle/notices, ZIP alignment, and all 21 native ELF files passed.
See [KEYBOARD-REGRESSION.md](KEYBOARD-REGRESSION.md) for the failing output,
test boundary, and device commands.

## Perch 0.5: connected durable backend

The final 0.5 source and runtime checks ran on 7 October 2026. This release adds
the actual PiHarness backend, native durable driver, and stored artifact reader.
The table below records checks run for this change. The older 0.4 record is
preserved separately; an unchanged historical check is not a newly executed gate.
Native binary evidence is recorded in [ANDROID-BUILD.md](ANDROID-BUILD.md).

| Check | Result | What it establishes |
| --- | --- | --- |
| App TypeScript | Passed | Durable capability/state additions, native assistant-ui integration, and reader APIs typecheck |
| OMP/demo state verifier | Passed | Existing encrypted independent-host protocol and demo state guards remain valid |
| Durable driver/store fixture | Passed | Explicit connection, strict projection, authoritative history, operation-ID reconciliation, redirects, stale results, and artifact byte verification |
| Artifact boundary verifier | Passed | Derived/stored identity, filename and MIME handling, lazy loading and full-content gates |
| Backend unit tests | Passed, 13 tests | Auth/configuration, operation conflicts, file manifests, label bounds, stable live/committed identities, and snapshot budgets against the actual phone validator |
| Backend production bundle | Passed | Pinned PiHarness service and provider compile for the Workers-compatible runtime |
| Actual celld recovery | Passed, 9 groups | Real SessionStore → HTTP → PiHarness; Stop, lost receipt, two interrupted chats, alarm-only resumption after runtime-data deletion, and exact recovered artifact identity |
| Production provider adapter | Passed | Actual production worker and Pi OpenAI-completions adapter make two controlled HTTP requests, execute the real artifact tool, and serve verified output |
| Final web export | Passed | 8,569,021-byte standalone application, rebuilt through Bun with all seven JavaScript chunks inlined and dependency notices embedded as inert text |
| Full DOM integration | Passed | Existing chat/OpenCode flows plus durable creation, composer, lazy artifacts, corruption/retry, source/copy, and session isolation; 66 OpenCode and 18 durable fixture requests, five artifact downloads |
| Focused connection DOM check | Passed | Default Pi Durable tab and exactly one selected accessibility state across all four tabs |
| Final local Android APK | Passed | Bun-driven, lint-enabled standalone build; 0.5.0/code 5, ARM64, preserved signer, current embedded bundle and notices, ZIP and native ELF alignment verified; positive CI packaging gate |
| First GitHub build and release | Passed, first attempt | Frozen Bun installs, source gates, cold Android build, binary verification, protected artifact handoff, exact version tag and published prerelease |
| Published downloads | Passed | All three release assets downloaded and checked against GitHub digests; APK and metadata match SHA256SUMS, source identity and workflow provenance; embedded bundle and notices verified |
| Real R2/S3, Cloudflare deployment, or fleet failover | Not performed | The backing store in the recovery test is celld's local dev object store |
| Physical Pixel / GrapheneOS or iOS | Not performed | Native networking, keyboard/layout, file sharing, and WebView enforcement require device execution |
| User host or real provider account | Not performed | Both runtime modes use controlled local inference and public fixture tokens |

The final Bun recovery report completed at 07:50:35.284 UTC, and the production adapter report
at 07:50:43.694 UTC. [DURABLE-BACKEND-RESULTS.md](DURABLE-BACKEND-RESULTS.md) explains
the process kill, retained backing store, alarm-only recovery proof, and test
boundaries. The raw reports live in `verification/durable-runtime/results`.

The final local standalone APK completed at 08:00:04.690 UTC. It is 47,736,890 bytes,
with SHA-256
`4389a727cde3d69cc8581d7736ff3933bfefea88d459ca5e722980eb47b59bc3`.
Its application source, native configuration and assets match published commit
`44bc088014567ce16db4399b741dac9a06e97652`. The packaging gate verified the
clean source tree and the exact embedded bundle and notice bytes. That warm
build took 81 seconds, with 875 Gradle tasks: 26 executed and 849 up to date.
This is a local cache-reuse timing, not a cold CI estimate.
Only the standalone 0.5 APK was built. The development APK remains the earlier
0.4 build.

The canonical delivery is now the **GitHub-built APK**, published in
[v0.5.0](https://github.com/phibkro/perch/releases/tag/v0.5.0). It is 47,736,738
bytes, with SHA-256
`2f43af6ab3788e4387e71a9293124ec8492218fb513d1cd64829b3ff1bfe235e`.
The first [hosted workflow](https://github.com/phibkro/perch/actions/runs/37590202398)
took 14 minutes 32 seconds overall; its native build step took 12 minutes
15 seconds. The APK was downloaded again and its complete bytes matched the
published checksum. It shares the local build's exact application bundle and
dependency notice bytes. These are separately built APKs with separate hashes.

### Bun migration

Bun 1.4.2 now manages all ten runnable packages. Eight dependency-bearing
packages have committed text lockfiles; the two dependency-free packages need
no generated lockfile. All nine old npm lockfiles were replaced, and the root,
backend, verification, experiments, and development-tool packages use the
hoisted linker. Expo, React Native, and existing server scripts still run under
Node 24.

Every frozen Bun install passed. The dependency audit preserved all 698 root
lockfile identities, all 667 installed Linux package identities, and all 1,548
shared resolution edges. Obsolete nested npm directories were removed after
the audit caught them shadowing Bun's intended module layout. No dependency
upgrade was part of this migration.

The app, artifact, durable-driver, backend, Pi bridge, gateway, OpenCode protocol,
and real OpenCode integration checks passed after migration. The fresh Expo
export also passed the full DOM fixture with 66 OpenCode requests, 18 durable
requests, and five verified artifact downloads. There were no JavaScript errors
or outside network attempts; the known jsdom CSS parser limit remains separate.

The actual celld recovery and production-provider checks also passed after the
migration. An earlier restart was refused at 7.12 GB of total cgroup usage despite
retained alarms and no OOM kill; the unchanged scenario recovered with sufficient
headroom. The verifier now checks celld readiness as well as app health and
reports supervisor exits immediately. Two focused regression tests passed and
run in CI. The recovery assertions and runtime memory protections are unchanged;
see [resource-admission.json](../verification/durable-runtime/results/resource-admission.json).

The Bun-native notice generator checks the locked production graph and actual
resolved versions. Its 581 retained package notices match the reviewed license
texts exactly; eight duplicate host compiler binding rows are represented by
their portable parent licenses. The standalone preview contains the exact
1,069,848-byte notice asset, whose SHA-256 is
`685cc1f116afc3c4a0875c2d29555f51f34aa801f4c5941a0fed22c906aa2f54`.

The release workflow passed actionlint 1.7.12, 15 Node release-guard tests,
two runtime-readiness tests and six Python artifact-handoff tests. A Bun invocation fixture confirmed that
explicit Node scripts retain Node 24.19.0. Version-only release-helper changes
leave `bun.lock` unchanged and pass a frozen install. See
[GITHUB-RELEASES.md](GITHUB-RELEASES.md) for the release and Obtainium workflow.

### Repeat the 0.5 checks

```sh
bun install --frozen-lockfile
bun install --cwd server/pi-durable --frozen-lockfile
bun run typecheck
bun run verify
bun run verify:artifacts
bun run --cwd verification/durable test
bun run --cwd server/pi-durable test
bun run --cwd server/pi-durable build
CELLD_BIN=/absolute/path/to/celld node verification/durable-runtime/verify.mjs
CELLD_BIN=/absolute/path/to/celld node verification/durable-runtime/verify.mjs --production-provider
bun run preview:export
bun install --cwd verification --frozen-lockfile
node verification/dom-smoke.cjs ../outputs/perch-prototype.html
bun run apk
```

Keep heavy Android compilation separate from the memory-sensitive celld test.
The full DOM fixture denies outside network/resource access and uses real
WebCrypto to verify controlled file bytes. It records jsdom's known Tailwind
stylesheet parsing limitation separately. It does not test visual layout,
gestures, Android background behavior, or browser/WebView sandbox enforcement.

### Device follow-up

On the Pixel, verify HTTPS connection/token entry, New chat and the model picker,
keyboard/composer layout, live output and Stop, locking/reopening the app, remote
history, and saved Markdown/HTML/code preview, copying, and export. Check that
HTML interaction is initially disabled and remains scoped to the selected file.
After an app-process restart, re-enter the token and inspect host history: phone
credentials and unresolved operation IDs are intentionally memory-only.

The included Maestro demo flows clear app data; their earlier syntax checks do
not constitute a device run for 0.5. Production provisioning and durable object
store qualification are also independent of the phone build.

## Historical Perch 0.4 evidence

The following record describes the earlier 0.4 scope. Its statements about an
unimplemented durable phone adapter were correct for that version; 0.5 replaces
that boundary with the connected service above.

The 0.4 checks cover the OpenCode gateway/adapter, remote conversations, provider-aware model chooser, the existing chat/artifact flows, and the isolated Pi Durable experiment. The final source gates ran on 7 October 2026. Unchanged development-tool and upstream-skill checks retain the evidence recorded during the 0.2 tooling setup. Native build details are tracked in [ANDROID-BUILD.md](ANDROID-BUILD.md).

### Observed checks

| Check | Result | What it establishes |
| --- | --- | --- |
| App TypeScript | Passed | Native assistant-ui, artifacts, state and app APIs typecheck |
| Bridge TypeScript | Passed | The separately packaged Pi service typechecks |
| OMP protocol/state verifier | Passed | Encrypted independent fixture, synchronization, question dismissal, read-only and reconnect guards |
| Demo state verifier | Passed | Blank startup, distinct new/reset chat IDs, first-prompt titles, session isolation, offline/live-host creation guards, stale questions, editor flow, interruption and offline catch-up |
| Artifact boundary verifier | Passed | Content/filename extraction, streaming identity and HTML policy construction |
| Real Pi runtime integration | Passed | Pinned Pi process, synthetic loopback model, actual write tool, model changes, extension questions, reconnect and abort |
| Android-equivalent Pi handshake | Passed | Native endpoint Origin accepted; unrelated Origin rejected; allowed Origin still requires a correct token |
| OpenCode gateway | Passed | Provider-key removal, separate upstream/phone headers, route/body/origin restrictions, and sanitized text-event projection |
| OpenCode protocol and store | Passed | Host catalog identity, atomic remote switching/creation, pending questions, final-text reconciliation, removals, reconnect without replay, and raw-server rejection |
| Actual OpenCode 1.18.35 | Passed | Two remote chats, selected model, incremental text, explicit permission before a real HTML write, artifact projection, question response, interruption, and reconnect |
| Provider audit | Passed | Hash-pinned inputs and saved counts: Pi 41 definitions / 1,537 chat routes; OMP 71 / 5,417 pinned and 71 / 5,428 current snapshot |
| Pi Durable 1.0.4 | Passed, 3 scenarios | Real SQLite process-crash recovery for a safe tool, an unsafe tool, and a model request; stable input and artifact identity |
| PiHarness 0.26.0 on celld 0.6.1 | Passed, 2 runs with 9 verification groups each | Actual process death, alarm-only recovery, safe/unsafe tool policy, model interruption, lost-receipt deduplication, and restored pending work after deleting local runtime data; development object store only |
| Production web export | Passed | Current application and dependencies bundle for web |
| Standalone preview packaging | Passed | 7,465,432-byte actual app; six JavaScript chunks including all three adapters, plus CSS/assets |
| Offline DOM integration | Passed, 76 checks | Existing 45 chat/artifact checks, 26 connection/catalog/model/remote-session checks, and five same-ID custom-answer checks; zero external network attempts or runtime/console errors |
| OpenCode Go configuration | Passed offline | Pinned Pi provider/model/base URL, environment parsing, credential precedence, and session headers; no subscription/model request |
| Development CLIs | Passed | agent-device, Maestro, EAS and Java respond with pinned versions |
| Local MCP discovery | Passed | agent-device and Maestro initialize and list tools |
| Project agent skills | Passed | Eight Expo and 17 assistant-ui skills match their recorded hashes; all 107 assistant-ui skill/reference files match upstream and 437 relative links resolve |
| Maestro syntax | Passed | Both device flows parse; no device execution claimed |
| EAS profile schema | Passed locally | Installed CLI accepts eas.json configuration |
| Hosted workflow validation | Blocked by missing account | No Expo login/project was supplied; no hosted job ran |
| Standalone Android APK | Passed | 0.4.0/code 4; ARM64 package, current embedded bundle, preserved signer, ZIP and native ELF alignment verified |
| Development Android APK | Passed | 0.4.0-dev/code 4; separate debug package, no main bundle/Metro required, preserved signer, ARM64 and alignment verified |
| Final binary identity guard | Passed | Both final binary manifests match app.json; the guard previously rejected a real stale APK |
| Real browser visual inspection | Not performed | Local Chromium could not start and browser security policy blocked the local preview |
| Pixel 8a / GrapheneOS execution | Not performed | ADB reported no connected device |
| User's OMP, Pi, or OpenCode host | Not performed | No private host/link/token was supplied |
| External provider account / subscription | Not performed | Catalog source support is distinct from authenticated access |
| Pi Durable mobile transport / Cloudflare / R2 | Not implemented or deployed | Local celld tests cover PiHarness recovery and alarms; hosted Cloudflare, R2, fleet failover, provider credentials, and a phone adapter remain unverified |
| iOS build/device | Not performed | No Apple build/device workflow was run |

The development-client variant needs Metro. The standalone APK embeds JavaScript. Consult [ANDROID-BUILD.md](ANDROID-BUILD.md) for actual package IDs, versions, ABI, signatures, alignment, and build evidence.

### Repeat the local checks

```sh
npm ci
npm run typecheck
npm run verify
npm run verify:artifacts
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
npm ci --prefix verification
node verification/dom-smoke.cjs ../outputs/perch-prototype.html
```

### What the fixtures actually do

The OMP verifier implements a separate Node/OpenSSL host on loopback. It encrypts/decrypts actual guest frames and verifies handshake, synchronized snapshots, deduplication, prompt/abort, pending answers until explicit host dismissal, view-only access, and reconnect without answer replay. It does not contact a public relay. This tests the web/default crypto codec; the native codec performs a reference-vector check before connection on a device.

The Pi verifier starts the actual pinned Pi CLI with a temporary configuration/workspace, a deliberately loaded test extension, and a synthetic OpenAI-compatible SSE server on loopback. Pi performs a real write tool call, whose bytes are checked. The test checks streamed artifact output, a configured model change, extension choice/editor dialogs, reconnect to pending questions and a running turn, abort, no replay, and removal of the bridge token from the agent subprocess environment. No user's host or external inference provider is used.

Pi handshake coverage now includes the endpoint-derived Origin sent by React Native Android, HTTPS proxy authority/default-port normalization, unrelated browser origins, and incorrect-token rejection before any snapshot. It models the header using a local WebSocket client; it is not a physical phone network test.

The OpenCode fixture starts the actual pinned 1.18.35 server, the included gateway, and the application driver in a temporary workspace. A synthetic local model requests a real write tool and question tool. The test confirms that the file does not exist before Allow once, inspects its exact bytes and artifact content after completion, exercises interruption, and checks that replacing the driver does not issue another model request. It proves that the raw upstream provider catalog contains the synthetic key while the gateway and phone snapshot do not. The separate protocol tests cover state transitions, stale responses, text replacement/removal, unsupported questions, and empty-server creation through the actual store. See [OPENCODE.md](OPENCODE.md).

The durable tests kill actual child processes with SIGKILL and reopen their SQLite database. All three scenarios preserve queued input, deduplicate two retried request IDs, and retain the provider session identity. A safe file write reuses its memoized artifact ID; an unsafe effect is not replayed as the same call; an interrupted model request preserves an aborted partial and starts again. This is process-crash evidence, not power-failure or Cloudflare runtime evidence. See [the experiment](../experiments/pi-durable/README.md).

### DOM verification limits

The DOM harness executes the actual standalone export with external network/resource access denied. OpenCode uses entirely in-memory HTTP/SSE responses; unknown URLs are rejected. The final run used 66 fixture requests and made zero external network attempts. It checks New chat startup, immediate first input, sidebar open/close/backdrop dismissal, history selection, mobile/wide-screen branch selection, new-chat draft isolation and first-prompt titles. It also checks assistant-ui Send/Stop and composer clearing, streamed tool/question/editor flows, offline freeze/catch-up, separate drafts, Markdown preview/source and exact copying, HTML frame declarations/interaction toggle, TypeScript syntax spans/wrapping, and complete-answer documents.

New checks cover masked OpenCode credentials and clearing them on a harness change, the gateway handshake, a 122-model catalog with search/provider filters and partial initial row mounting, identical model IDs under different providers, remote creation/selection, and draft isolation between two hosts reusing a session ID. A question retains the same ID while changing from choice to custom-text editor: the editor must start empty, send no early reply, then submit the exact typed text once and wait for host dismissal.

jsdom requires explicit CSSOM, Web Streams, and request/response data-container shims. It cannot parse Tailwind's generated `@layer` stylesheet; this known limitation is reported separately from JavaScript errors. Clipboard writes are captured by a test stub. The harness simulates CSS modal-animation completion so dismissed drawers leave the test DOM; this does not measure animation or native presentation.

These checks do not evaluate CSS layout, color contrast, keyboard overlap, selection gestures, Android lifecycle behavior, native export/share sheets, or browser/WebView enforcement of HTML sandbox/CSP rules. An iframe declaration is not proof of browser enforcement. No screenshot or real-device claim is made.

### Review and corrections

The 0.4 source was reviewed against `4c2d41e` and [MODULAR-ASSISTANT-SPEC.md](MODULAR-ASSISTANT-SPEC.md). Final review dispositions are recorded in [REVIEW.md](REVIEW.md). Review corrections retain an active conversation outside the latest 200 rows during reconnect and ignore a superseded background failure after a newer chat loads. Focused regressions, the actual OpenCode integration, and app types passed after these changes.

The real OpenCode fixture exposed two protocol assumptions before delivery: user-message summary objects must remain visible, and live text needs a bounded event overlay because intermediate text is not yet persisted in history. The implementation now gives final host text authority, including plugin rewrites, and guards older snapshots and text removals. A same-ID choice/editor transition also clears the earlier choice value explicitly.

The final DOM fixture was corrected to expect OpenCode's default `POST /session` body `{}` rather than a fixed title. This was a test expectation change; no application defect was found by that final run.

The 0.3 layout was reviewed against `c38279f` and [CHAT-LAYOUT-SPEC.md](CHAT-LAYOUT-SPEC.md). The review led to an explicit host-configured model fallback, a larger model-picker touch target, and a clearer example-navigation callback name. The Spec review found no actionable gaps. Immediate-input DOM coverage also caught a draft-sync race; subscribing through layout effects resolved it.

The original rewrite was reviewed against the restored 0.1 baseline and [REWRITE-SPEC.md](REWRITE-SPEC.md), with separate Standards and Spec axes. Material findings were corrected with focused regression coverage:

- HTML interaction permission is attached to the selected artifact ID, preventing a new artifact from inheriting a previous artifact's enabled-script state on its first render.
- Arbitrary tool-output fences no longer become file artifacts; full known write inputs remain supported.
- The Pi bridge accepts React Native's endpoint Origin without weakening mandatory token authentication.
- OMP assistant identities remain stable when a streamed response becomes a persisted entry, so an open artifact stays selected.
- The Expo MCP development launcher targets the separate development app package explicitly.

The complete review findings and their disposition are in [REVIEW.md](REVIEW.md). Native build evidence is recorded separately in [ANDROID-BUILD.md](ANDROID-BUILD.md).

### Device trial

The first Pixel run should exercise New chat with the keyboard, drawer/back navigation, switching drafts, the question sheet, artifact reader, code selection, file export, HTML interaction/isolation, and resume after locking. Add an actual OpenCode gateway connection, a large model picker, streamed text, and remote creation/selection to that trial. The included Maestro flows automate the synthetic demo and clear app data for a known starting state; do not run them over a session you want to keep.

Account-bound tooling setup and device instructions are in [DEVELOPMENT.md](DEVELOPMENT.md).
