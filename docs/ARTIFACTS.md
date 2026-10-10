# Generated artifacts

An artifact has an identity, a type, a filename, and a source. Content is either present or referenced by an immutable server manifest. It can be read without scrolling through the conversation.

| Content | Preview | Source/export |
| --- | --- | --- |
| Markdown | Native headings, lists, quotes, tables, links, images, code blocks | Original Markdown |
| Mermaid | Offline diagram with fit/zoom controls; embedded Markdown diagrams open on demand | Original Mermaid |
| HTML | Sandboxed page, inline CSS, optional inline JavaScript | Original HTML |
| Code | Native highlighting, horizontal scrolling or wrapping | Original extracted code |

Common languages use lowlight/highlight.js. Unknown languages display as plain source. Diffs are highlighted source, without a side-by-side editor. React/TSX projects are not compiled inside the reader.

## Discovery and identity

- Assistant fences such as `html filename="preview.html"` become separate artifacts.
- Backtick and tilde fences work. Filename metadata supports `filename`, `file`, `path`, or `title`.
- Long/structured answers become Markdown documents. Any answer can also be opened manually.
- A supported `write` tool with complete `path` and `content` input provides a file artifact.
- A “file written” log is not file content. Partial edits are not reconstructed into fictional complete files.

Host path prefixes are removed before export. Perch never reads a server path because generated text mentions it.

IDs combine message/tool identity with fence position. Selection survives streaming updates. HTML updates visually during streaming; interaction stays off until generation completes. Changing artifact resets its interaction toggle.

## Stored files

Pi Durable and the OMP remote extension supply `StoredArtifact` manifests in the session snapshot. Their
identity includes session, artifact ID, and SHA-256 revision. A descriptor has no
content until selected. Only recognized Markdown or HTML MIME types enable those
readers; an extension cannot turn plain text into executable HTML.

The workspace loads the selected artifact through `SessionStore.loadArtifact`.
The driver accepts a current manifest, builds a scoped route itself, sends the
workspace token, and checks byte length, SHA-256 and strict UTF-8. It refuses
redirects and arbitrary artifact URLs. The server independently checks the same
bytes and returns a download with `nosniff` and attachment headers.

Loading and failed states expose no preview, copy, export, or script toggle. A
retry starts a fresh read. Changing session, credential epoch, manifest metadata,
or loader immediately hides old bytes and discards late responses. A valid empty
file is distinct from an unloaded file. Reader downloads are memory-only. An
explicit native export creates a filesystem cache file for the share sheet;
that file can outlive the app process until the operating system clears it.
Perch has no persistent reader cache or export-cache cleanup service.

### OMP file snapshots

On Linux, the OMP extension captures supported regular UTF-8 files after a
successful **built-in `write`** event. It verifies tool provenance, project
containment and the opened file descriptor; paths from generated text or an
HTTP request do not trigger reads. The bounded cache holds up to 32 revisions,
2,000,000 bytes per file and 8 MiB total. It copies the observed bytes and never
silently evicts an advertised revision. A later edit of the original file does
not change a captured artifact.

The phone labels these **Host file snapshot**. They are cleared when the OMP
conversation/generation changes or the process exits; this route is not durable
object storage. Unsupported formats, symlinks, workspace escapes, malformed
UTF-8, and oversized files have no captured-file manifest. SVG remains source;
only explicit HTML MIME enables the HTML reader. Existing transcript artifacts
can still be available independently. See the [OMP adapter](../server/omp-remote/README.md).

## HTML isolation

Generated markup is encoded as the `srcdoc` of an inner iframe. The frame has an opaque origin and no permission to navigate its parent, open popups, submit forms, or access its parent's document. Its trusted outer document owns the frame policy and contains no user tokens, transcript, or application objects.

The policy precedes generated content. It blocks remote script/style dependencies, network APIs, frames, workers, plugins, and remote media. Inline CSS and embedded data images are allowed. Scripts start disabled; the interaction toggle permits inline scripts without enabling same-origin access or dynamic code evaluation.

Native uses React Native WebView. File access, shared/third-party cookies, persistent DOM storage, automatic window opening, and mixed content are disabled. The app supplies no `onMessage` handler or injected app API. Navigation permits local preview documents and anchors.

Web puts the trusted outer document in another sandboxed iframe, also without same-origin access. The outer frame policy is intended to block remote navigation as well as dependencies.

Policy construction is tested. The original HTML preview's Android WebView enforcement has not been physically verified. The separate Mermaid browser fixture described below exercises its real opaque iframe boundary. These checks are not a claim of a security audit or a general-purpose hostile-code execution service.

## Mermaid diagrams

Mermaid fences, `mmd` fences, `.mmd` write artifacts and recognized Mermaid text manifests can be opened as diagrams. Standalone artifacts have Preview and Source tabs. A Mermaid fence inside a Markdown document begins as source with a Render action, so a long report does not create a browser instance for every diagram. A changed source closes an embedded preview. Standalone streaming artifacts wait for completion before rendering.

The renderer is the official **Mermaid 12.1.0** browser build. `bun install` prepares an inert local module through `scripts/prepare-diagrams.mjs`; `bun run prepare:diagrams` rebuilds it explicitly. No renderer script, stylesheet or icon pack is downloaded when a diagram opens. The generated module is ignored by Git and is recreated from the locked dependency. The upstream bundle includes its source notices and is covered by the production dependency notice inventory.

Mermaid runs inside an opaque child frame with a trusted outer policy, matching the HTML reader's ownership pattern. Only the trusted renderer and bootstrap receive a fresh script nonce. Diagram input is serialized as data with script boundaries escaped. There is no `onMessage` handler or injected native API. Network access, file access, storage, nested frames, workers, plugins and popups remain disabled. Source directives cannot replace the configured security level, limits or trusted theme. Click callbacks are not bound and rendered links are made inert.

The upstream parser is responsible for grammar validation. Invalid or unsupported source produces a visible error; Perch does not silently discard unfamiliar syntax with a partial parser. Rendering is limited to **20,000 source characters** and Mermaid's **200-edge limit**. These are preview bounds, not a universal execution-time guarantee. Source, copy and export still use the complete original content. Fit and zoom affect only the preview.

Mermaid's browser MathML support may render mathematical diagram labels. General Markdown math, externally loaded icon packs, rendered-SVG export and arbitrary native TSP trees are separate features.

## Markdown, source, and limits

Markdown becomes native components. Embedded HTML remains text. Links open supported HTTP(S)/mailto destinations only after a tap. Remote images require an explicit load action; embedded bitmap images render directly.

Highlighting creates native Text spans and never evaluates code. Rendering is capped at 200,000 characters with a notice. Highlighting stops above 50,000 characters. Oversized HTML offers Source and Export instead of a broken truncated page.

Copy/export always use complete artifact content. Native export writes a cache file and opens the system share sheet. Web export creates a downloadable Blob. Neither publishes a file to a server.

## Verification

```sh
bun run verify:artifacts
```

The verifier checks extraction, streaming identity, filename boundaries, content preservation, policy construction, stored MIME mapping, unloaded-content gates, cancellation, and scope changes. The durable driver fixture checks protected downloads, integrity, malformed UTF-8 and redirects. The real Pi integration fixture exercises a write tool and artifact-rich model output using synthetic local data.

`verification/artifacts/mermaid-browser.mjs` uses an installed Playwright/Chromium pair to test the actual nested iframe with valid diagram families, malformed/unknown grammar, a diagram above the edge limit, script-boundary and HTML labels, JavaScript links, source configuration directives, zoom and blocked network access. It also verifies that the child cannot read its parent and has no React Native bridge. `PERCH_PLAYWRIGHT_MODULE` and `PERCH_CHROMIUM_PATH` can select existing local tools; the test does not download them. Desktop Chromium results do not establish Android WebView performance, touch behavior or accessibility.

## Primary references

- [react-native-marked](https://github.com/gmsgowtham/react-native-marked)
- [lowlight](https://github.com/wooorm/lowlight)
- [Mermaid API and security](https://mermaid.js.org/config/usage)
- [Package reuse research](INTEGRATION-REUSE-RESEARCH.md)
- [WebView reference](https://github.com/react-native-webview/react-native-webview/blob/master/docs/Reference.md)
- [HTML iframe standard](https://html.spec.whatwg.org/multipage/iframe-embed-object.html)
- [CSP Level 3](https://www.w3.org/TR/CSP/)
- [Expo FileSystem](https://docs.expo.dev/versions/latest/sdk/filesystem/)
- [Expo Sharing](https://docs.expo.dev/versions/latest/sdk/sharing/)
