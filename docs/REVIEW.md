# Perch review

## Perch 0.5

Independent source review examined the connected durable backend, driver,
artifact reader, and shared projection boundary against baseline `3580c747`,
[DURABLE-BACKEND-SPEC.md](DURABLE-BACKEND-SPEC.md), and the documented host-authority
and native-reader invariants. This was a focused implementation review, not a
claim that the older two-axis review workflow was repeated. Findings were
corrected before the final actual-runtime and export checks.

| Finding | Disposition and evidence |
| --- | --- |
| P1: Stop supplied a new operation ID that matched no active Pi operation | Fixed. Send `{}` for untargeted abort. The actual driver → backend → Pi run stops and exposes an interrupted response. |
| P2: U+007F in a catalog/model/artifact label passed server validation but failed the strict phone projection | Fixed. Reject control characters at server input/config boundaries. Focused backend tests cover the labels. |
| P2: Malformed tool labels and very large model/tool output could poison an authoritative snapshot | Fixed. Normalize display labels, cap fields at 2,000,000 characters, and budget encoded JSON to 10 MiB. Tests include UTF-8/escapes and preserve manifests. |
| P2: Multiple unavailable tools belonging to one generation task could collapse into one card | Fixed. Use distinct host entry/content slots where there is no real tool task ID. Verify distinct tool rows through the phone validator. |
| P2: A partial assistant response changed identity when the final entry arrived, losing derived-artifact selection | Fixed. Read one published ConversationView and use generation task plus message ordinal for live and committed rows. Test the actual artifact identity derivation. |
| Integration finding: Lifecycle converted thrown expected HTTP errors into stack-bearing 500 responses | Fixed. Handle expected failures within `onRequest` and sanitize initialization failures. Conflicts remain checked outside the Pi commit callback under the exclusive request boundary. |
| UI verification finding: The four connection tabs lacked the selected web accessibility attribute | Fixed. Preserve native accessibility state and add the web selected attribute. Focused exported-DOM follow-up passes for all four choices. |

The artifact review retained lazy, authenticated loading; manifest identity,
length, SHA-256, and UTF-8 validation; credential/session generation guards; and
HTML execution permission scoped to the loaded file. The API forces attachment
byte handling, so generated HTML is not a privileged document on the API origin.
The production entry remains separate from the synthetic provider fixture.

The recovery observer initially sampled only operations still pending after
restart. A fast operation could finish before that sample and never emit the
observer's completion evidence. The verifier now watches all persisted admission
IDs, resolving a false timeout without changing production recovery code.

App types, driver/store and artifact checks, 13 backend unit tests, the final
9-group celld run, the production provider smoke, and exported DOM checks passed.
The independent documentation audit also corrected clean-install test
prerequisites and the distinct production-report filename. Remaining deployment,
provider-account, and physical-device limitations are explicit in
[VERIFICATION.md](VERIFICATION.md) and
[DURABLE-BACKEND-RESULTS.md](DURABLE-BACKEND-RESULTS.md).

## Perch 0.4

Two independent source reviews compared baseline `4c2d41e` with candidate `0e9bb15`, using [MODULAR-ASSISTANT-SPEC.md](MODULAR-ASSISTANT-SPEC.md), the root agent guide, the documented session/artifact boundaries, and the installed native assistant-ui contract. The Spec reviewer reproduced both reported races with an in-memory transport. Review was separate from the final runtime, DOM, and Android delivery gates.

### Standards

| Finding | Disposition |
| --- | --- |
| P2: Reconnect could select a newer chat when the active chat fell outside the latest 200 history rows, contrary to the documented selected-transcript guarantee | Fixed. Reconnect retains the active ID and reads its history directly. An unavailable selected chat leaves the last transcript visible and reports the failure. |
| Heuristic: `connectOpenCode` adds a third copy of the store's connection lifecycle | Retained as a nonblocking maintenance recommendation. The protocol constructors remain separate, with matching generation guards and focused lifecycle tests. A shared installation helper can accompany the next adapter; this review found no defect caused by the duplication. |

No additional substantiated documented-standard violation was found. Native external-store authority, credential projection, question handling, and known-write artifact boundaries remain intact.

### Spec

| Finding | Disposition |
| --- | --- |
| P2: Reconnect could silently change the selected conversation, violating “Create and select remote sessions explicitly” | Fixed by preserving and directly verifying the selected session, including a regression where it is omitted from the recent list. An authoritative 404 also preserves the prior transcript. |
| P2: An old background read could fail after a successful session switch and disconnect the newer selection, violating “Guard pending transitions and stale callbacks” | Fixed. Snapshot rejection now uses the same connection, selection, and request-sequence guard as successful publication. A regression delays an old chat's read, switches chats, then returns HTTP 503; the new chat stays live. |

No further missing requirement or scope creep was identified within the stated implementation. Provider counts distinguish definitions/catalog entries from tested accounts, and the Pi Durable experiment explicitly excludes a mobile adapter and Cloudflare deployment.

The focused OpenCode protocol/store tests, actual 1.18.35 integration, and app types passed after the corrections. The final export/DOM and APK evidence is recorded in [VERIFICATION.md](VERIFICATION.md) and [ANDROID-BUILD.md](ANDROID-BUILD.md).

Standards: one correctness finding resolved, one nonblocking heuristic retained. Spec: two correctness findings resolved. Both axes reported the same reconnect issue independently.

## Perch 0.3

Two independent source reviews compared `c38279f` with candidate `e0ffa50`, using [CHAT-LAYOUT-SPEC.md](CHAT-LAYOUT-SPEC.md), the root agent guide, and the documented native/runtime/artifact boundaries. Both reviews were read-only; reported test and build results remain separate evidence.

### Standards

| Finding | Disposition |
| --- | --- |
| P3: Missing model metadata fell back to the harness name, contrary to the documented model/harness distinction | Fixed. The header now says **Host-configured model** when the host omits model metadata. |
| Heuristic: The model picker had a 24-pixel minimum height beside 44-pixel controls | Fixed. Its actual minimum height is now 44 pixels, increasing the touch target without overlapping adjacent controls. |
| Heuristic: `onPreviewArtifacts` selected the example conversation, making its name misleading | Fixed. The callback is named `onOpenArtifactExample`. |

The review found no additional blocking keyboard, draft, artifact-isolation, or host-authority regression. Runtime authority, capability guards, registry provenance, and artifact policies remain intact.

### Spec

No actionable finding. Blank startup, the phone drawer and wide sidebar, removal of bottom navigation, a composer after flexible content, separate demo threads/drafts, and the live-host New chat boundary match the request. OpenCode Go configuration is concrete; the direct OpenCode adapter and Cloudflare deployment remain explicitly proposed. Updated builds and verification records are delivery gates, not presumed review results.

During DOM verification, an immediate first-input case exposed an earlier passive-effect draft synchronization race. Both sync effects now run as layout effects, before interaction. The no-delay first-input case and the complete 45-check flow pass.

Native delivery checks later caught stale Android binary resource/package outputs despite a successful Gradle exit. Targeted regeneration produced correct binaries. The build helper now verifies the final binary identity before announcing success; the actual stale APK is rejected and both corrected variants pass. Root reviewed the helper after implementation. Details are in [ANDROID-BUILD.md](ANDROID-BUILD.md).

Standards: one documented deviation and two heuristics resolved. Spec: zero actionable findings. Physical keyboard, font scaling, drawer geometry, and WebView enforcement still require device validation.

## Perch 0.2

The implementation was reviewed along separate Standards and Spec axes against
the restored 0.1 baseline, `cbe44e3`. The first implementation commit was
`3d51f51`; corrections are in `fe8518a` and `7a14dfe`.
The review used local source, installed dependency code, and focused synthetic
fixtures. It did not use a browser, physical phone, private host, or cloud model.

### Standards

| Finding | Disposition |
| --- | --- |
| P1: HTML script permission could carry into the first render of another artifact | Fixed. Permission is now keyed to artifact identity and disabled while streaming. The artifact verifier covers default denial, exact identity, new selection, and streaming. |
| P2: Arbitrary tool-log fences could become purported file contents | Fixed. Artifact extraction from tools requires full known write input. A negative fixture prevents log snippets being promoted to files. |
| P2: Expo MCP development launching resolved the standalone application ID | Fixed. The launcher explicitly builds/opens the debug variant with its separate development application ID. |

One heuristic remains: **Duplicated Code** in the OMP and Pi connection lifecycle
methods in `src/session/store.ts`. Their reset, generation guard, attachment,
and failure paths could share a helper when further adapters are added. This is a
maintenance recommendation, not an observed correctness defect or a documented
standard violation. Existing lifecycle behavior is covered by the adapter tests.

The reviewed native/tooling scripts had no additional blocking source defect
after those corrections. Build/device verification is reported separately.

### Spec

| Finding | Disposition |
| --- | --- |
| P1: The default Pi bridge rejected React Native Android's endpoint-derived Origin | Fixed. Absent Origin, explicit allowlist, or normalized matching Host authority is accepted. Token authentication still gates all snapshots. Local tests cover native-equivalent Origin, TLS proxy/default-port normalization, foreign Origin rejection and wrong-token denial. |
| P2: Persisting an OMP response changed its identity and ejected its open artifact | Fixed. Streaming and persisted assistant messages share the OMP session/timestamp identity, with disambiguation for collisions and deterministic fallback for missing timestamps. The projection regression covers completion and subsequent snapshots. |

Model metadata, harness execution, and presentation are separated as requested.
The scope includes actual assistant-ui elements, OMP/Pi transports, artifact
readers, and the tooling setup. The disclosed absence of a physical device,
account authentication, a private host, and browser enforcement testing is not
reported as completed work.

Standards: three defects resolved, one maintenance recommendation remains.
Spec: two defects resolved, no remaining defect identified by this review.
