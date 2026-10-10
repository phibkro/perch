# Reusable tools for Tern, OMP, and Perch

Research date: **10 October 2026**. This note supports the [integration map](TERN-OMP-INTEGRATION-MAP.md). Package versions below were read from the npm registry, then the relevant published source was inspected. A dependency's unpacked distribution size is **not** an estimate of its APK impact.

## Decisions

| Need | Reuse | Decision |
| --- | --- | --- |
| Mermaid diagrams in chat documents and artifacts | **`mermaid@12.1.0`**, its published browser bundle, and Perch's existing WebView/frame boundary | Implement this slice. Keep the original source, use the upstream parser, and bundle all renderer code locally |
| Existing-process Tern + OMP integration | Tern's SDK declarations/hooks and OMP's existing extension/session services | Expand these adapters. Do not replace their owners with a second session process |
| A future Perch-owned OMP process | OMP's **`RpcClient`**, frame decoder, command types, and wire schema | Reuse on the host. It already handles process transport, typed calls, callbacks and protocol framing |
| A future harness-neutral managed process | **`@agentclientprotocol/sdk@1.8.0`** | Evaluate at the host boundary; stable v1 and experimental v2 must be distinguished |
| Rich math | **KaTeX**, or a separate evaluation of Enriched Markdown's native math | Next reader candidate. Offline CSS/fonts and native/web differences need qualification |
| CSV/TSV | **`papaparse@5.7.0`** | Good small follow-up. Use its parser, then a native virtualized table |
| JSON | Built-in `JSON.parse` plus native tree controls | No extra parser required; limit depth and virtualize expanded nodes |
| Reliable host receipts | **`bun:sqlite`**, with transactions and explicit operation records | Prefer the existing runtime's database API to a new storage framework |
| Session/history storage and artifact discovery | OMP's `SessionManager`, `ArtifactManager`, and blob store | Reuse their identity and formats; still provide Perch authorization, manifests and byte delivery |

The implementation choices are ours. The interface facts and sources are recorded below.

## 1. Diagram rendering: use the grammar's owner

### Options examined

| Package | Strength | Cost or limitation | Fit for Perch |
| --- | --- | --- | --- |
| `beautiful-mermaid@1.1.3` | DOM-free TypeScript, SVG output, simple color themes; six diagram families | Published parsers silently ignore some unknown statements. Its SVG also uses CSS variables and `color-mix()`, which are not a promise of `react-native-svg` compatibility | Attractive for controlled authored diagrams. Rejected for arbitrary assistant output because detecting all silent omissions would require a second maintained grammar |
| `mermaid@12.1.0` | Upstream grammar, parsers, renderers, diagram-family support and error handling | Browser DOM required; larger bundle and dependency graph | Selected inside an isolated browser frame, not imported as React Native UI |
| `react-native-svg@15.15.4` already installed | Native SVG primitives and XML rendering | It does not parse Mermaid or lay out graphs; SVG/CSS compatibility must be checked for each producer | Keep for native icons and future deliberately supported SVG content |
| Mermaid CLI | Automated SVG/PNG/PDF generation with a browser | Requires a supervised host browser, transfer/caching and a render service | Useful for server exports later; unnecessary for an offline phone preview |

Sources: [Beautiful Mermaid README][beautiful-readme], [published package][beautiful-package], [sequence parser][beautiful-sequence], [Mermaid usage][mermaid-usage], [Mermaid package][mermaid-package], [React Native SVG][rn-svg], [Mermaid CLI][mermaid-cli].

### Why Beautiful Mermaid was not selected

The initial candidate was Beautiful Mermaid. Its published sequence parser explicitly skips standalone `activate`/`deactivate` commands and returns the remaining parsed structure. Flowchart parsing also hands remaining statements to a permissive line parser. A successful render is therefore not evidence that every source statement was represented.

We could add a Perch-specific allowlist and parser, but that would put grammar maintenance back into this project. Official Mermaid is a better match for assistant-generated diagrams: unsupported and malformed grammar is handled by the renderer's own parser. Read-only security restrictions, such as disabled link activation, remain intentional viewer behavior. [Published source][beautiful-sequence] [Mermaid API][mermaid-usage]

### Measured distribution sizes

| Distribution inspected | Package unpacked bytes | Additional observation |
| --- | ---: | --- |
| Beautiful Mermaid 1.1.3 | 2,098,676 | Registry tarball: 461,051 bytes; direct dependencies: `elkjs`, `entities` |
| Mermaid 12.1.0 | 122,268,705 | Includes source maps and multiple builds; 23 direct dependencies |
| Mermaid's selected `dist/mermaid.min.js` | **5,493,176** | **1,565,532 gzip bytes**, measured with deterministic gzip; this is the actual browser script embedded by Perch |

The renderer file's SHA-256 is `6484afc32872a3aa16cac9a76ba1816a1ed4cc870a6593cc2e17757750f518b2`. These are file measurements, not speed claims or measured APK growth. The app's packaging determines its final compressed footprint. Registry metadata: [Beautiful Mermaid 1.1.3][beautiful-package], [Mermaid 12.1.0][mermaid-package].

Mermaid itself declares MIT, but that does not describe every dependency. The resolved graph includes `elkjs@0.9.3` with **EPL-2.0** and `dompurify@3.4.16` with **MPL-2.0 OR Apache-2.0**. Keep the actual component notices and source attribution in the release inventory; do not relabel the whole graph as MIT. [ELK package](https://registry.npmjs.org/elkjs/0.9.3) [DOMPurify package](https://registry.npmjs.org/dompurify/3.4.16)

### Implementation shape

1. `scripts/prepare-diagrams.mjs` reads the locked Mermaid package's published browser build and creates an inert JSON module. Install prepares it; the generated file is not maintained as source.
2. Standalone Mermaid artifacts get **Preview / Source**. Copy and export retain the original Mermaid text.
3. A Mermaid fence inside a Markdown document initially shows source and a **Render** action. This avoids creating a browser view for every diagram in a long report.
4. The frame runs only the bundled renderer and trusted bootstrap. Diagram text is JSON data with HTML script boundaries escaped.
5. Both the outer document and opaque child frame own a restrictive content policy. Scripts need a fresh nonce; network, subframes, workers, file access, storage and app messaging are absent.
6. Mermaid uses `securityLevel: 'strict'`; limits and security settings are protected from source directives. Perch does not bind its link/click callbacks.
7. The upstream parser reports malformed/unsupported syntax. A visible error leaves Source available. A changed embedded source closes its prior preview.

There is a **20,000-character preview limit** and Mermaid's **200-edge limit**. These constrain common workloads; they are not a universal CPU-time guarantee for every grammar. Browser rendering must still be tested with representative and adversarial inputs, and Android WebView behavior must be verified independently of desktop Chromium. [Mermaid security/configuration][mermaid-security] [WebView reference][webview] [Perch artifact contract](ARTIFACTS.md)

Mermaid can use browser MathML for mathematical diagram labels. This does not add a general Markdown math reader. The implementation does not fetch a KaTeX stylesheet or fonts at runtime. [Mermaid configuration][mermaid-config]

### Prototype verification

The pure artifact verifier passes source preservation, MIME/filename identity, script-boundary escaping, nonce policy construction and size guards. The real iframe fixture passes **13 cases** in Chromium **153.0.8010.0**: flowchart, sequence with activation, class, ER, state, journey, malformed syntax, unknown grammar, script-boundary label, hostile HTML label, JavaScript link, a source directive attempting to loosen policy, and the edge limit. It observes no network requests or page errors; the child cannot read its parent, has no React Native bridge, retains strict configuration, and supports zoom/fit.

These are functional and isolation checks with synthetic local content, not an Android/WebView or security-audit result. End-to-end desktop fixture durations include frame setup, browser communication, assertions and screenshots; they are not a rendering benchmark. The reproducible gate is [mermaid-browser.mjs](../verification/artifacts/mermaid-browser.mjs).

## 2. Other artifact readers worth reusing

| Need | Recommended component | Integration detail | Decision |
| --- | --- | --- | --- |
| Markdown math | `katex@0.19.0`, MIT | `renderToString` produces markup; HTML rendering still needs KaTeX CSS and fonts. Bundle them and keep `trust: false`, finite `maxExpand` and finite `maxSize` | Next focused reader enhancement, not installed separately in this slice |
| Fully native rich Markdown and math | `react-native-enriched-markdown@1.1.1`, MIT | Native Fabric rendering, md4c parser, GFM, selection and math. Web uses a different WASM path and optional KaTeX; install downloads native assets | Evaluate as a renderer replacement with parity tests, rather than adding a second general Markdown system casually |
| CSV/TSV grid | `papaparse@5.7.0`, MIT | Handles quoted fields, escaped quotes, delimiters, malformed rows and incremental parsing. No runtime dependencies. Use `dynamicTyping: false` for faithful strings; bound preview rows and report parse errors | Small useful follow-up; native table remains our presentation code |
| JSON tree | `JSON.parse` | Keep original source for export. Parse without evaluation; depth/node limits and virtualization prevent giant expanded trees | No parsing package needed |
| Standalone SVG | Existing `react-native-svg`, or the isolated HTML reader | SVG is a document format with resource/link behavior, not only path geometry. Qualify a safe renderer subset or use the existing isolated document route | Separate slice; do not treat every SVG as a trusted icon |
| Code | Existing `lowlight` and `react-native-marked` renderer overrides | Already preserves native selectable text and explicit links/image loading | Keep. A wholesale switch to Shiki/DOM code blocks adds little immediate value |
| Rich diffs | Upstream OMP structured edit data, then a native diff view | Preserve old/new text and file revision; rendering a diff must not imply permission to apply it | Design after exact artifact delivery |

Sources: [KaTeX API][katex-api], [Node rendering requirements][katex-node], [trust/expansion options][katex-options], [KaTeX package][katex-package], [Enriched Markdown published README][enriched], [Enriched Markdown package][enriched-package], [Papa Parse docs][papa-docs], [Papa Parse package][papa-package], [lowlight][lowlight], [React Native Marked][rn-marked].

KaTeX's npm manifest lists `commander` for its CLI. Its render function should not be described as a new native view. Enriched Markdown is promising, but its small npm tarball omits large native assets downloaded during installation; the tarball size is therefore not its full native-build cost. Its renderer also has image/video behaviors that would need to preserve Perch's explicit network-loading policy. [Package][katex-package] [Enriched Markdown installation][enriched]

Papa Parse's browser workers and remote-download conveniences are optional. For Perch's bounded, already-loaded CSV text, use string parsing without `worker` or `download`; no new fetch authority belongs in the parser. Do not convert large IDs, leading-zero account numbers or timestamps just to make the grid look typed. [Papa Parse configuration][papa-docs]

## 3. Tern and OMP: reuse transport and semantic services

| Surface | Reusable pieces | Where it belongs | What it does not solve |
| --- | --- | --- | --- |
| Tern public SDK | Generated Luau declarations; TypeScript/Rust/Python/Go TSP helpers, wire types, node builders and reconciliation | Type-checking/authoring Tern plugins; a future program-side TSP implementation | No supplied complete Android daemon-attachment client or general native TSP renderer |
| OMP extension SDK | Events, model catalog, session context, command registration and artifact/session services | The existing OMP process | Observing approval events is not the owner dialog's answer contract |
| OMP `RpcClient` | Typed commands, protocol framing/chunk decoder, callbacks, process lifecycle and transport override | Bun host service for a Perch-owned process | It does not attach to an unrelated live interactive PID |
| OMP RPC wire package | Generated TypeScript, JSON schema, content/command/state/frame types | Host validation/code generation, synchronized with the chosen OMP build | Types alone do not supply authorization, receipts, reconnect or recovery |
| OMP ACP adapter | Session updates, permission requests, forms, file/terminal bridge | A managed agent endpoint | OMP's form capability and plan-confirmation behavior need version qualification |
| Official ACP TS SDK 1.8.0 | Connection handling, standard schema/types, streams and client/agent examples | Host gateway first; negotiate stable v1 with the current adapter | Experimental v2/HTTP/WebSocket exports are not automatically compatible with OMP's current wire contract |
| OMP Collab | Existing encrypted shared-session client and protocol | Existing-process shared access | Guest authority and room lifetime remain Collab's rules |
| OMP session/artifact stores | Catalog, branches, entries, metadata, local artifacts/blobs and internal URI resolution | Host-side exact-content service | Internal paths/URIs are not authenticated mobile download URLs |

Sources: [Tern SDK][tern-sdk], [Tern TypeScript manifest][tern-package], [OMP SDK][omp-sdk], [OMP RPC client][omp-rpc-client], [OMP RPC schema][omp-rpc-schema], [OMP RPC framing][omp-rpc-frame], [OMP extension types][omp-extension], [OMP artifact manager][omp-artifacts], [ACP SDK][acp-sdk], [ACP package][acp-package], and the [version-qualified inventory](OMP-API-INVENTORY.md).

### A particularly useful existing seam: `RpcClientOptions.spawn`

OMP's RPC client accepts a custom process transport with stdin, stdout, stderr inspection, termination and exit state. It also accepts an argv prefix/builder, including remote-launch arrangements such as SSH. That is much less work than recreating its commands, request routing and frame decoder. It still launches/owns an RPC agent workflow; it is not a hidden takeover API for an existing TUI. [OMP RPC client][omp-rpc-client]

For the current Perch direction, keep the OMP extension as the existing-process semantic adapter. Add an explicitly separate managed-session mode only when that user journey is implemented. The same native views can consume normalized sessions from both.

### Validation and durable receipt storage

Use upstream schemas before inventing another schema language. The inspected OMP RPC source already includes a schema and generated command/frame types. The official ACP SDK has a Zod peer and exports its schema; use its validators with its own protocol. A validator cannot determine that a pane ID belongs to the same process incarnation, so the combined adapter still needs explicit identity binding. [OMP schema][omp-rpc-schema] [ACP package][acp-package]

For operation receipts on a Bun host, `bun:sqlite` already supplies prepared statements, transactions and SQLite access. Store an operation ID, owner/session epoch, request revision, accepted command and outcome; write the acceptance record transactionally before attempting the side effect. This is an implementation proposal, not a claim that SQLite provides exactly-once external effects. Reconcile unknown outcomes instead of blindly replaying approvals. [Bun SQLite][bun-sqlite]

Reuse OMP's history storage where possible. Its SQL/Redis session storage does not relocate every workspace file, blob, live promise or child process. Artifact manifests and process recovery therefore remain explicit adapter responsibilities. [OMP persistence inventory](OMP-API-INVENTORY.md#2-storage-history-artifacts-and-recovery)

## 4. Keep the dependency boundary small

The immediate addition is **Mermaid only**. It fills an observable product gap without replacing the native chat runtime or creating another session protocol. Other candidates above are retained for concrete follow-up work.

Existing packages already cover much of the required infrastructure: assistant-ui's native runtime, `react-native-marked`, `lowlight`, WebView, SVG, secure storage, file export/sharing and Expo's platform services. A web component library, a terminal emulator or a browser-based editor should not be imported merely because it has a good demo; each would bring a different interaction/runtime contract.

This note distinguishes upstream facts from proposed Perch choices. Package versions and source were checked on the research date; native rendering, accessibility, memory and final APK size require the app's own device verification.

## Sources

[beautiful-readme]: https://github.com/lukilabs/beautiful-mermaid/blob/main/README.md
[beautiful-package]: https://registry.npmjs.org/beautiful-mermaid/1.1.3
[beautiful-sequence]: https://github.com/lukilabs/beautiful-mermaid/blob/main/src/sequence/parser.ts
[mermaid-package]: https://registry.npmjs.org/mermaid/12.1.0
[mermaid-usage]: https://mermaid.js.org/config/usage
[mermaid-security]: https://mermaid.js.org/config/schema-docs/config-properties-securitylevel.html
[mermaid-config]: https://mermaid.js.org/config/setup/mermaid/interfaces/MermaidConfig.html
[mermaid-cli]: https://github.com/mermaid-js/mermaid-cli
[rn-svg]: https://github.com/software-mansion/react-native-svg
[webview]: https://github.com/react-native-webview/react-native-webview/blob/master/docs/Reference.md
[katex-api]: https://katex.org/docs/api
[katex-node]: https://katex.org/docs/node
[katex-options]: https://katex.org/docs/options
[katex-package]: https://registry.npmjs.org/katex/0.19.0
[enriched]: https://github.com/software-mansion/enriched-markdown/blob/main/packages/react-native-enriched-markdown/README.md
[enriched-package]: https://registry.npmjs.org/react-native-enriched-markdown/1.1.1
[papa-docs]: https://www.papaparse.com/docs
[papa-package]: https://registry.npmjs.org/papaparse/5.7.0
[lowlight]: https://github.com/wooorm/lowlight
[rn-marked]: https://github.com/gmsgowtham/react-native-marked
[tern-sdk]: https://github.com/stencil-hq/tern-sdk/tree/3fe91247617744635cabb93f4561bd17ac26ca61
[tern-package]: https://github.com/stencil-hq/tern-sdk/blob/3fe91247617744635cabb93f4561bd17ac26ca61/typescript/package.json
[omp-sdk]: https://omp.sh/docs/sdk
[omp-rpc-client]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/packages/coding-agent/src/modes/rpc/rpc-client.ts
[omp-rpc-schema]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/packages/coding-agent/src/modes/rpc/wire/rpc-wire.schema.json
[omp-rpc-frame]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/packages/coding-agent/src/modes/rpc/rpc-frame.ts
[omp-extension]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/packages/coding-agent/src/extensibility/extensions/types.ts
[omp-artifacts]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/packages/coding-agent/src/session/artifacts.ts
[acp-sdk]: https://github.com/agentclientprotocol/typescript-sdk
[acp-package]: https://registry.npmjs.org/@agentclientprotocol%2Fsdk/1.8.0
[bun-sqlite]: https://bun.sh/docs/runtime/sqlite
