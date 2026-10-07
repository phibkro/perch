# Generated artifacts

An artifact has an identity, a type, a filename, and a source. Content is either present or referenced by an immutable server manifest. It can be read without scrolling through the conversation.

| Content | Preview | Source/export |
| --- | --- | --- |
| Markdown | Native headings, lists, quotes, tables, links, images, code blocks | Original Markdown |
| HTML | Sandboxed page, inline CSS, optional inline JavaScript | Original HTML |
| Code | Native highlighting, horizontal scrolling or wrapping | Original extracted code |

Common languages use lowlight/highlight.js. Unknown languages display as plain source. Mermaid and diffs are source/highlighting formats, not rendered diagrams or side-by-side diff editors. React/TSX projects are not compiled inside the reader.

## Discovery and identity

- Assistant fences such as `html filename="preview.html"` become separate artifacts.
- Backtick and tilde fences work. Filename metadata supports `filename`, `file`, `path`, or `title`.
- Long/structured answers become Markdown documents. Any answer can also be opened manually.
- A supported `write` tool with complete `path` and `content` input provides a file artifact.
- A “file written” log is not file content. Partial edits are not reconstructed into fictional complete files.

Host path prefixes are removed before export. Perch never reads a server path because generated text mentions it.

IDs combine message/tool identity with fence position. Selection survives streaming updates. HTML updates visually during streaming; interaction stays off until generation completes. Changing artifact resets its interaction toggle.

## Stored files

Pi Durable supplies `StoredArtifact` manifests in the session snapshot. Their
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

## HTML isolation

Generated markup is encoded as the `srcdoc` of an inner iframe. The frame has an opaque origin and no permission to navigate its parent, open popups, submit forms, or access its parent's document. Its trusted outer document owns the frame policy and contains no user tokens, transcript, or application objects.

The policy precedes generated content. It blocks remote script/style dependencies, network APIs, frames, workers, plugins, and remote media. Inline CSS and embedded data images are allowed. Scripts start disabled; the interaction toggle permits inline scripts without enabling same-origin access or dynamic code evaluation.

Native uses React Native WebView. File access, shared/third-party cookies, persistent DOM storage, automatic window opening, and mixed content are disabled. The app supplies no `onMessage` handler or injected app API. Navigation permits local preview documents and anchors.

Web puts the trusted outer document in another sandboxed iframe, also without same-origin access. The outer frame policy is intended to block remote navigation as well as dependencies.

Policy construction is tested. This environment could not run a browser or attached Android device, so browser/WebView enforcement has not been empirically validated here. This is not a claim of a security audit or a general-purpose hostile-code execution service.

## Markdown, source, and limits

Markdown becomes native components. Embedded HTML remains text. Links open supported HTTP(S)/mailto destinations only after a tap. Remote images require an explicit load action; embedded bitmap images render directly.

Highlighting creates native Text spans and never evaluates code. Rendering is capped at 200,000 characters with a notice. Highlighting stops above 50,000 characters. Oversized HTML offers Source and Export instead of a broken truncated page.

Copy/export always use complete artifact content. Native export writes a cache file and opens the system share sheet. Web export creates a downloadable Blob. Neither publishes a file to a server.

## Verification

```sh
bun run verify:artifacts
```

The verifier checks extraction, streaming identity, filename boundaries, content preservation, policy construction, stored MIME mapping, unloaded-content gates, cancellation, and scope changes. The durable driver fixture checks protected downloads, integrity, malformed UTF-8 and redirects. The real Pi integration fixture exercises a write tool and artifact-rich model output using synthetic local data.

## Primary references

- [react-native-marked](https://github.com/gmsgowtham/react-native-marked)
- [lowlight](https://github.com/wooorm/lowlight)
- [WebView reference](https://github.com/react-native-webview/react-native-webview/blob/master/docs/Reference.md)
- [HTML iframe standard](https://html.spec.whatwg.org/multipage/iframe-embed-object.html)
- [CSP Level 3](https://www.w3.org/TR/CSP/)
- [Expo FileSystem](https://docs.expo.dev/versions/latest/sdk/filesystem/)
- [Expo Sharing](https://docs.expo.dev/versions/latest/sdk/sharing/)
