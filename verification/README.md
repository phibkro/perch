# Offline preview verification

This checks the real exported app with a DOM emulator. It does not start a browser or validate CSS, layout, keyboards or native controls.

```sh
bun install --cwd verification --frozen-lockfile
node verification/dom-smoke.cjs ../outputs/perch-prototype.html
```

For a focused follow-up after changing only connection-tab semantics, append
`--connection-only`. This checks startup, the default tab, and exactly one
selected accessibility state across all four tabs. It does not replace the
full smoke test above.

The script denies external resource loading and network APIs. It exercises the real exported bundle, including:

- Startup, streamed demo replies and expandable tool output.
- Choice and text editor questions, offline catch-up and separate session drafts.
- The assistant-ui composer Send and Stop actions.
- Markdown artifact preview, source and copy using a test-only clipboard.
- HTML preview element configuration and its explicit interaction toggle.
- TypeScript syntax spans, selectable-text declarations, wrapping and complete-answer documents.
- OpenCode connection fields, host history, new chats, provider/model selection,
  custom-answer questions, and separate drafts when switching hosts.
- Pi Durable connection fields and an initially empty host catalog, followed by
  explicit chat creation and submission through the rendered composer.
- Saved artifact references attached to their producing tool cards. Listing
  manifests does not download files; selecting one starts its authenticated load.
- Loading-state copy/export gates, Markdown/source/copy byte equality, code
  rendering, and a corrupted HTML download followed by the reader's Retry action.
- Real SHA-256 verification through Node WebCrypto, using exact fixture bytes.
  Successfully loaded HTML shares the existing sandbox and script-toggle policy.
- Durable session changes clear the old artifact view; revisiting history
  restores references and requires an explicit new selection to fetch a file.

It accepts a different preview HTML path as a positional argument. Clipboard writes are captured in memory; no system clipboard or downloads are used.

The harness supplies missing Web Streams, encoding, WebCrypto, and request/response data containers, plus structural CSSOM shims for Uniwind. Fetch can reach only explicitly enabled, in-memory OpenCode and Pi Durable fixtures. Unknown URLs and every other network-capable API remain denied; no sockets, real hosts, models, buckets, or user credentials are involved. Held responses and one same-length corrupted file exercise the reader's visible pending/error/retry states while the real exported driver verifies the returned bytes.

jsdom cannot parse the generated Tailwind `@layer` stylesheet; the report separates that known `cssLimitations` entry from JavaScript runtime errors. DOM checks inspect declared HTML sandbox, CSP and referrer attributes; they do not prove that a browser enforces them. A declared selectable style likewise does not test selection gestures. Real browser and Android checks remain necessary for visual layout, keyboard behavior, touch input, WebView isolation and native rendering. The separate durable backend checks establish host behavior; this script checks client UI wiring against a controlled protocol fixture.
