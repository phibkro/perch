# Perch 0.5 durable backend: measured results

**The connected backend recovered unfinished chats and saved artifacts after an
actual process kill and deletion of its local runtime data.** The fresh runtime
resumed through alarms before a client reconnected. This establishes the local
PiHarness/celld path used by Perch. Real R2, multi-node operation, and a physical
Pixel remain separate deployment and device checks.

## What was exercised

| Component | Implementation under test |
| --- | --- |
| Mobile state | Actual Perch SessionStore and durable HTTP driver |
| HTTP service | Actual token authentication, origin policy, catalog, and session routes |
| Durable harness | Agents SDK 0.26.0 PiHarness and Lifecycle |
| Continuation | Pi Durable, Pi AI, and Chord 1.0.4 |
| Runtime | celld 0.6.1, Node 24.19.0 tooling |
| Artifact storage | Actual `ARTIFACTS` bucket binding in celld's local dev backing store |
| Model | Controlled local fixture; no external inference account |

The final Bun recovery run completed on **7 October 2026, 07:49:30.948–07:50:35.284 UTC**.
Its nine check groups passed. The raw result is
[latest.json](../verification/durable-runtime/results/latest.json).

## Recovery experiment

The setup first created a normal chat through the phone's actual store. A proxy
accepted its submit request and deliberately dropped the receipt. The driver
reconciled the original operation ID; it did not submit a second prompt. Pi then
saved Markdown, HTML, and TypeScript files. The actual phone loader checked their
UTF-8 byte lengths and SHA-256 hashes. Another workspace could not open either
the chat or its files.

A new client reopened the history, persisted model choice, and file references.
A separate running chat verified that the phone's Stop command reaches and aborts
the active Pi operation.

The crash stage created two unfinished chats:

| Chat | Interruption boundary | Queued work |
| --- | --- | --- |
| Upload recovery | Artifact bytes stored; visible manifest not yet committed | One follow-up prompt |
| Model recovery | Committed partial response; model request still unfinished | One follow-up prompt |

The runner killed the celld development supervisor with SIGKILL and observed its
listener close. The Linux child runtime was stopped by parent-death signaling.
It removed `.celld/dev/runtime`, while retaining the development backing object
store and its sidecars. This prevented the next start from succeeding merely
because the old runtime's local execution files remained.

After restart, alarm activation reopened both chats. All four accepted operations
finished **before any client session request**. The interrupted response remained
visible as an interrupted partial, followed by its resumed answer. The queued
follow-ups then completed. This is continuation from persisted state; it is not a
claim that an arbitrary network connection or model stream survives a crash.

The upload ran twice across the interruption, with the same memoized artifact
identity, timestamp, hash, and bytes. The final session exposed one manifest.
A fresh client downloaded both the original completed files and the recovered
file. Switching workspace credentials invalidated an older file reference.

## Passed check groups

| Check | Result |
| --- | --- |
| Authentication, browser origins, and isolated workspace catalogs | Passed |
| Real SessionStore creation and lost-receipt reconciliation | Passed |
| Verified Markdown, HTML, and code downloads; cross-workspace denial | Passed |
| Fresh client restores history, model choice, and files | Passed |
| Phone Stop interrupts the actual Pi run | Passed |
| Real upload and model interruption boundaries, with queued input | Passed |
| Fresh runtime completes both chats through alarms alone | Passed |
| Replayed upload converges; recovered submissions stay deduplicated | Passed |
| Fresh client reopens artifacts after cache deletion; old credentials lose scope | Passed |

## Production provider adapter smoke

A separate run loaded the production worker, with explicit model configuration
and a host-held API key. Pi's actual OpenAI-completions adapter sent two HTTP
requests to a local model fixture: the first requested `write_artifact`; the
second produced the final assistant answer after the tool result. The real
client downloaded and verified the generated Markdown file.

This check passed at **07:50:41.840–07:50:43.694 UTC** on 7 October 2026. The health
endpoint identified the production service (`synthetic: false`), while the test
report correctly records `syntheticModel: true` for the controlled inference
endpoint. No production account or paid model was used. See
[production-provider.json](../verification/durable-runtime/results/production-provider.json).

## App, source, and reader checks

App TypeScript, the existing OMP/demo state verifier, the independent durable
driver/store fixture, and the artifact boundary verifier passed. Thirteen backend
unit tests passed, including projection against the actual phone validator and
artifact identity model. The final backend bundle also built successfully.

The exported 0.5 application passed the full DOM smoke test. Its controlled
fixtures handled 66 OpenCode requests, 18 Pi Durable requests, and five artifact
downloads. The test covered empty-catalog creation, sending through the rendered
composer, lazy file loading, loading-state action gates, Markdown copy equality,
code highlighting, a same-length corrupted HTML response, Retry, script-toggle
reset, and clearing old artifacts on session changes. There were no JavaScript
runtime errors or external network attempts. jsdom's known Tailwind stylesheet
parsing limitation was recorded separately; this is not a visual browser test.

The final standalone web export is 8,569,021 bytes with all seven JavaScript
chunks inlined. A focused follow-up passed after adding the four connection tabs'
selected accessibility state. After migrating package management to Bun 1.4.2,
the application was exported again and passed the full DOM fixture. Its complete
dependency notices are embedded in an inert HTML template; a DOM parse confirmed
the exact notice text, one complete inline application payload, and no external
scripts or stylesheets.

The final local standalone Android build passed through Bun with lint enabled. Its binary is
`dev.perch.assistant`, version `0.5.0`, version code `5`, and contains only
`arm64-v8a` native libraries. The 47,736,890-byte APK preserves the prototype
signer; ZIP alignment and every LOAD segment in all 21 native libraries passed
the 16 KB checks. Its embedded JavaScript bundle matches the generated bundle
byte for byte. Its 1,069,848-byte dependency notice asset also matches the
committed bytes exactly. Application source, configuration and assets match
published commit `44bc088014567ce16db4399b741dac9a06e97652`.

That warm build took 81 seconds, with 26 Gradle tasks executed and 849 up to date.
The positive CI packaging command also verified the clean source tree, final
notice asset and complete binary. That timing is not a cold CI benchmark. See
[ANDROID-BUILD.md](ANDROID-BUILD.md) for the complete build and checksum record.
No device execution is implied by these binary checks.

The initial pre-notice APK was replaced after these checks. The verified local
APK has SHA-256
`4389a727cde3d69cc8581d7736ff3933bfefea88d459ca5e722980eb47b59bc3`.

The final distributed APK comes from the successful first
[GitHub workflow](https://github.com/phibkro/perch/actions/runs/37590202398),
which built the same commit and published
[v0.5.0](https://github.com/phibkro/perch/releases/tag/v0.5.0). The 47,736,738-byte
published APK has SHA-256
`2f43af6ab3788e4387e71a9293124ec8492218fb513d1cd64829b3ff1bfe235e`.
All three release assets were downloaded and matched their published digests;
the checksum file and metadata agree on the APK and its source. The application
bundle and notices also match the verified local build exactly. Hosted native
compilation took 12 minutes 15 seconds; the complete workflow took 14 minutes
32 seconds. The APK supplied alongside this guide is that published binary.

## Corrections made before delivery

- Stop sends an untargeted abort, so Pi cancels the active operation instead of
  looking for a newly generated, nonexistent operation ID.
- Expected HTTP failures are caught inside the Lifecycle request boundary;
  startup failures are sanitized instead of exposing framework stack traces.
- Labels reject control characters; provider-supplied tool names are normalized.
- Bounded snapshot projection prevents malformed or oversized output from
  invalidating the phone's last good state. Full stored files are unaffected.
- Tool results without a real tool task get distinct host-derived slot identities.
- Streaming assistant identity remains stable on completion, so a selected
  derived artifact does not disappear when the final entry is committed.

The test observer also changed to watch all persisted admission IDs after a
restart. Sampling only currently pending work could miss an operation that had
already completed, causing a false timeout. This changed the observation logic,
not the backend's recovery behavior. [REVIEW.md](REVIEW.md) records the findings.

## Practical limits

This slice supports configured OpenAI-completions compatible model endpoints;
it does not make every Pi provider or subscription available automatically.
Tools installed by this backend currently consist of `write_artifact`. Adding
shell, browser, external messaging, or other effects requires deliberate tool
and replay policies. A deduplicated submission is not a general guarantee that
all model requests or outside effects execute once.

The phone polls snapshots and keeps tokens, drafts, and unresolved operation IDs
in memory. It has no background notification service, offline artifact cache,
persistent outbox, or credential vault. Workspace access has no per-user roles.
The host has prototype admission limits and no deletion/retention service.

Each stored artifact is limited to 2,000,000 UTF-8 bytes. Display fields are
limited to 2,000,000 characters; the encoded phone snapshot is limited to 10 MiB.
Recent conversation text has priority over tool output. Any text truncation or
older-row omission is explicit; manifests and stored file bytes remain complete.
The full host transcript has no older-history pagination in the phone yet.

A deployment still needs an authenticated HTTPS address, configured inference,
and qualification of its actual persistence mode. For celld, the logical
`ARTIFACTS` binding uses `r2/<bucket_name>/` inside the fleet bucket; celld owns
its internal SQLite-state object layout. Cloudflare DO storage is managed by the
platform, with a separate R2 binding for artifact bytes. No deployment, real R2
write, fleet failover, Pixel 8a/GrapheneOS trial, or iOS build was performed here.

## Reproduce and configure

Follow [DURABLE-BACKEND.md](DURABLE-BACKEND.md) for the app and backend setup,
[the protocol spec](DURABLE-BACKEND-SPEC.md) for the HTTP contract, and
[the runtime verification guide](../verification/durable-runtime/README.md) for
the exact commands and evidence format.

Primary runtime documentation:

- [Cloudflare PiHarness](https://developers.cloudflare.com/agents/harnesses/pi/)
- [celld runtime, bindings, and persistence modes](https://celld.dev/docs)
