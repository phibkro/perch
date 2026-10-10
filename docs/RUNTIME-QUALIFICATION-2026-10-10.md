# Tern 0.7 and the uploaded OMP executable

Date: 10 October 2026. This records runtime checks against the two user-supplied
Linux x86-64 binaries. The compatibility baseline is Perch commit
`bbf754f83116f7b6c442302f429db944c0b1e87a`. The OMP executable check also exercises
the subsequent session controls and captured-file delivery in this working tree.

## Versions and file identity

| Supplied component | Observed version | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| `Tern-0.7.0-linux-x86_64.tar.gz` | Archive for Tern 0.7 | 66,254,584 | `88302c10df1192c909cb24b773063820bbec909ef4a7171025065a1a7a53aa20` |
| Tern executable from that archive | `tern 0.7.0 (9ca00e4)` | 159,412,944 | `d996802aab2fe3c4be6b9a1afe098e705760f391f25f935b4f0d01f58828b1f9` |
| `omp-linux-x64` | `omp/18.8.7` | 258,102,752 | `b87f9835a0acdbb81bbbad8273aa2d999b608a208598421a9584cffeb3139a8a` |
| Declarations emitted by Tern 0.7 | `tern plugin types` output | 89,027 | `fe56ffbe90cb74f1df59e82d58e81203b3dbb803a17c10fb1b25849363783fb2` |

The archive was checked for absolute/traversal paths, device entries and links
before extraction. It contains only `tern/` and `tern/tern`. The full executable
length and SHA-256 were verified before runtime qualification. No supplied binary
was added to the Perch repository or used to replace the installed OMP package.

## What passed

| Check | Actual runtime exercised | Result |
| --- | --- | --- |
| Existing owner-request integration verifier | **New Tern 0.7**, installed OMP 18.8.7 SDK runtime, actual PTY and stock OMP UI | Passed |
| Uploaded executable integration verifier | **Uploaded OMP 18.8.7 executable**, RPC-UI owner, production Perch OMP extension | Passed |
| Explicit pane focus and duplicate receipts | **New Tern 0.7**, production Luau plugin, synthetic TSP child | Passed |
| Captured-file registry | Production registry and the existing shared manifest parser | 12 tests passed, including all 71 supported extension aliases |
| Tern-generated SDK | **New Tern 0.7** executable | Emitted successfully; compared with supplied 0.6 declarations |
| Tern theme and identity inspection | **New Tern 0.7** headless window and a small observation plugin | Settings, computed styles and local window identity read successfully |
| Tern web client delivery | **New Tern 0.7** `web serve` | Listener starts; web assets remain unavailable |
| Headless loopback remote-daemon identity | **New Tern 0.7** developer fixture | Blocked by this execution environment's Unix-socket restriction |

### New Tern, existing real OMP owner flow

The existing
[`verify-tern-omp-owner.mjs`](../server/tern-remote/test/verify-tern-omp-owner.mjs)
ran without changing the production plugin or its request mappings:

1. Perch discovered the actual OMP process in a Tern PTY.
2. A Perch HTTP **Deny** resolved the stock tool approval without executing the
   inert fixture tool.
3. An answer to a previous identical request was rejected. **Approve** for the
   current request executed the tool once.
4. The complete displayed plan heading and body reached Perch.
5. **Refine plan** returned to the real composer. Explicit Unicode feedback
   entered the original conversation.
6. **Approve and keep context** continued that conversation.
7. Duplicate receipt lookups and reconnect reads did not repeat effects.

All owner events had the same process ID and canonical OMP conversation ID.
There were six in-memory mock-provider calls, zero paid-provider calls and one
inert tool execution. This qualifies Tern 0.7 against the installed SDK runtime;
it does not claim that this specific flow ran the newly uploaded OMP executable.

Two earlier attempts did not produce a catalog. Retained diagnostics established
that Tern had disabled the plugin for exceeding its **50 ms load budget**. A
quiet run passed with the same plugin and unchanged budget. The container uses
llvmpipe software rendering. The failed attempts remain an environment-sensitive
startup qualification limit rather than evidence of a changed request schema.

The additional [`verify-tern.mjs --focus`](../server/tern-remote/test/verify-tern.mjs)
check passed against the updated production plugin in a quiet run. An explicit
Perch command focused the intended real Tern pane. After the fixture moved to
another pane, duplicate command receipts and reconnect reads left focus there.
The existing atomic Unicode prompt, same-process identity, non-ready rejection
and interrupt checks also passed. This check uses a synthetic TSP child, not a
model or a second real OMP owner session. During a concurrent export, the first
attempt exceeded the same plugin load budget before any focus command.

### Uploaded OMP executable and the production extension

The separate
[`verify-executable.mjs`](../server/omp-remote/test/verify-executable.mjs)
launches the supplied executable with an isolated profile and workspace. It loads
the production Perch extension and one explicit fixture extension. The fixture
registers an inert approval-gated tool and a model served by a deterministic
OpenAI-compatible HTTP endpoint on loopback. It does not instantiate a second
AgentSession through the installed SDK.

The verified flow covers:

- The production extension loading in the uploaded executable.
- An authenticated Perch catalog containing the actual CLI PID and canonical
  conversation identity.
- Perch prompts reaching that owner process.
- The actual RPC-UI owner callback denying one tool request and approving the
  next; the tool executes once.
- Duplicate command receipts and reconnect reads without replay.
- Perch interrupt stopping an active turn while preserving the owner process.
- A subsequent prompt completing in the same conversation.
- A Unicode session title, a model-declared thinking level, and rejection of a
  thinking command whose model no longer matches the command's target.
- A context estimate with the fixture model's 32,768-token window and an active
  tool catalog from the owner API.
- Public `sourceInfo.source === 'builtin'` for OMP's stock `write` tool.
- A successful stock HTML file write followed by a captured manifest and an
  authenticated download through its opaque artifact ID. The downloaded bytes,
  SHA-256 and ETag match the saved CRLF and Unicode content.
- The captured download retaining the original bytes after an independent edit
  to the source file. Repeating the prompt receipt does not execute `write` again.

This flow made eight requests to the synthetic loopback provider, zero paid
provider requests, one inert tool execution and one stock file write. The owner
approvals were answered through RPC-UI in the verifier. **Perch's direct OMP
extension still has no resolver for stock owner approvals.** The Tern request
route retains that separate responsibility.

### Captured-file boundaries

The [registry](../server/omp-remote/artifacts.mjs) stores copied UTF-8 file
revisions after the bridge observes a successful built-in `write` event. Each
file is limited to 2,000,000 bytes; the registry retains at most 32 files and
8 MiB of copied bytes. Its [tests](../server/omp-remote/test/artifacts.test.mjs)
cover quotas, exact bytes, immutable downloads, generation resets, symlink and
workspace containment, and compatibility with the shared `StoredArtifact`
parser for every supported extension.

Downloads select an already captured opaque ID; they cannot request an arbitrary
host path. Capture checks the canonical workspace and the opened descriptor's
path before and after reading. This implementation requires Linux `/proc`
descriptor paths; other hosts skip capture when they cannot prove containment.
Final symlinks, nonregular files, unsupported formats and invalid UTF-8 are
rejected. SVG is offered as XML source, not an executable image preview.

The cache is in memory. Session generation changes, including a reset of the
same conversation, invalidate its entries and fence pending captures. A process
restart discards the cache. A capture records the stable file revision observed
after tool success; it does not establish the file's contents at the exact
instant the tool completed if another process also writes that file.

### Reproduce the opt-in checks

Use separately installed executables. The verifiers create and remove isolated
fixture profiles; the supplied binaries are not bundled in the repository.

```sh
OMP_BIN=/absolute/path/to/omp-linux-x64 \
  bun server/omp-remote/test/verify-executable.mjs

TERN_BIN=/absolute/path/to/tern \
  bun server/tern-remote/test/verify-tern-omp-owner.mjs

TERN_BIN=/absolute/path/to/tern \
  bun server/tern-remote/test/verify-tern.mjs --focus

bun test server/omp-remote/test/artifacts.test.mjs
```

`PERCH_OMP_EXECUTABLE_RESULT` can select a JSON result file. Set
`PERCH_OMP_EXECUTABLE_KEEP_FAILURE=1` only when retaining the private fixture
diagnostics is useful. The Tern owner verifier requires the existing optional
OMP SDK fixture dependency; the uploaded-executable verifier does not.

## Tern 0.7 SDK changes now present in the supplied binary

The new declaration dump includes the additions previously seen only in the
current public SDK:

| Declaration | Meaning | Qualification here |
| --- | --- | --- |
| `cx.whiteboard:open/read/edit` | Shape-based whiteboard access | Present in the binary's generated SDK; individual operations not exercised |
| `cx.layout:park/unpark` and `PaneInfo.parked` | Keep a pane's program running outside a tab layout | Present in the generated SDK; parking behavior not exercised |
| `BlockDef.features` with `edit` and `undo` | Native editing events for custom block fields | Present in the generated SDK; custom block editing not exercised |
| `PaneKind` adds `canvas` and `carly` | More native pane categories | Present in the generated SDK |
| `ExportWait` | Named callback-safe export wait marker | Present in the generated SDK |

The dump also clarifies the distinction between `cx.canvas` persistent UI panels
and `cx.whiteboard` shape-based pages, and the validation of canvas updates.
These declarations do not make arbitrary custom UI or whiteboards available in
Perch automatically.

## Visual evidence

A real Tern 0.7 headless window reported the following defaults and computed
styles. These are an observed fixture state, not a copy of the user's personal
Tern settings.

| Property | Observed value |
| --- | --- |
| Effective dark theme | `titanium` |
| Effective light theme | `light` |
| UI font | `Geist, system-ui, "SF Pro Text", system-ui, sans-serif` |
| Common UI font size | 13.5 px |
| Terminal font | BerkeleyMono Nerd Font, 13 px |
| UI density | Compact |
| Light foreground example | `rgb(59, 59, 59)` |
| Light muted foreground example | `rgb(108, 108, 108)` |
| Accent control example | `rgb(83, 121, 121)` |

The runtime lists dedicated stylesheets for OMP's composer, tools, pickers,
panels and reader/spine/console chat layouts. Its computed-style dump provides
font, foreground and background evidence for individual elements. Font names
are visual references; no fonts were extracted from the proprietary binary or
bundled into Perch by this qualification.

## Remaining integration limits

### The archive still does not provide the web distribution

`tern web serve` successfully starts a local HTTP listener. Authenticated
requests to both `/` and `/index.html` return **404**, with this diagnostic:

> No web client here: build it with `just tern-web`, or pass --assets DIR.

A running listener alone therefore does not establish that the Tern web client
is present.

### A safe pane-to-OMP binding was not established here

The local headless fixture exposes a window-side pane number and host identity
through the plugin API. Its child process does not receive `TERN_PANE` or
`TERN_PANE_SOCKET`, and `tern whoami --json` correctly rejects that context.
The fixture also reports that its window file-open listener could not start.

The attempted loopback remote-daemon fixture fails with an operating-system
permission error before it supplies the missing daemon identity chain. This
prevents qualifying a raw remote-pane ID to window-pane ID mapping in this
environment. It is not evidence that a regular daemon-backed desktop session
lacks these identities.

Perch must continue to require an explicit, validated binding before combining
Tern owner controls with an OMP canonical conversation. Matching a title, PID,
working directory, transcript or unverified inherited environment value does
not establish that binding.

### Device and recovery scope

These checks do not exercise a physical Android device, the user's real remote
host, provider subscriptions, process crash recovery or arbitrary custom TSP
widgets. TSP event dispatch also does not supply an atomic expected-plan-revision
guard or durable confirmation of external effects.

See the [combined integration map](TERN-OMP-INTEGRATION-MAP.md) and
[Perch implementation audit](PERCH-INTEGRATION-AUDIT.md) for the broader surface
and ownership boundaries.
