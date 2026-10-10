# Remote integration verification

`driver.test.ts` and `requests.test.ts` exercise the remote protocol and request
projection. `dom-fixture.cjs` supplies synthetic remote responses to the existing
[`dom-smoke.cjs`](../dom-smoke.cjs) exported-app checks.

## Session controls in a real browser

`session-controls-browser.cjs` loads a current standalone Expo preview in
Chromium at 412 × 844 pixels. It pairs and attaches through Perch's actual
workspace manager, remote driver, session store and rendered components.
`session-controls-fixture.cjs` supplies in-memory protocol responses. Unknown
origins are blocked; no real host, credentials, subscription or model is used.

Build the current preview, then run:

```sh
bun run preview:export -- --output verification-output/current-preview.html
node verification/remote/session-controls-browser.cjs \
  verification-output/current-preview.html \
  --output verification-output/session-controls-browser
```

The runner uses an installed `playwright` module and its Chromium by default.
When using a separate tooling installation, set `PERCH_PLAYWRIGHT_MODULE` to the
absolute path of that module's `index.mjs` and `PERCH_CHROMIUM_EXECUTABLE` to its
Chromium executable. These are development dependencies, not app bundle assets.

The fixture verifies:

- A bottom composer and light/dark shell at phone width.
- Only advertised thinking options and controls.
- Context, current-branch usage, and expandable tools with long labels.
- Scoped title/thinking/focus commands; no optimistic host values.
- View-only, working, pending-question, session-opening and offline mutation guards.
- Advertised Tern pane focus remains available during work and questions.
- Explicit reconnection without replay.
- Removed capabilities hiding actions while metadata stays visible.
- A replaced generation requiring attachment and clearing the old title draft.

The output directory contains screenshots and `result.json`, including the tested
HTML's SHA-256 and Expo preview metadata. A failed run saves
`failure.json`, the visible DOM text and a screenshot when possible.

This validates browser behavior. It does not emulate Android Compose, the Android
keyboard, physical touch, native font scaling or a real Tern/OMP process.
