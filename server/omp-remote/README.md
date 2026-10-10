# Attach Perch to the OMP process in your terminal

This prototype is an **OMP extension loaded into the existing agent process**.
The terminal and phone use the same agent, tools, provider configuration, and
host transcript. The extension exposes a protected loopback HTTP projection;
Perch's workspace gateway gives the phone access through its existing pairing.

**Qualified upstream:** OMP **18.8.7**, source commit
[`b07a1c146d0d12cfc855a2c65d52f892ef319040`](https://github.com/can1357/oh-my-pi/tree/b07a1c146d0d12cfc855a2c65d52f892ef319040).
The extension uses public APIs. It does not construct another `AgentSession`,
launch RPC, copy a session file into another process, or require Collab.

## What works

| In Perch | On the host |
| --- | --- |
| Discover a live session | Advertises its runtime, process ID, project, current conversation, status, and model |
| Attach and read | Projects recent branch history and its current streamed assistant text |
| Send a message | Calls this process's public `sendUserMessage` API |
| Interrupt | Calls this session's `abort`; the OMP process remains alive |
| Change model while idle | Selects from `ctx.models.list()` using `setModel`; credentials stay on the host |
| Change thinking while idle | Uses the current model's declared effort choices and public `setThinkingLevel`; OMP applies its own session ceiling |
| Rename while idle | Awaits public `setSessionName`; the phone displays the host-confirmed title |
| Inspect context and usage | Reads `getContextUsage` and reported assistant usage on the current branch; cost is reported USD, not subscription quota |
| Inspect tools | Shows names, descriptions and active status from `getAllTools/getActiveTools`; schemas and provider configuration stay on the host |
| Read generated artifacts | Markdown/code answers, complete `write` inputs, and captured saved-file revisions after supported built-in writes on Linux |
| Reconnect | Reads fresh snapshots and command receipts; no prompt is automatically resent |
| Observe a host decision | Shows an outstanding tool approval; answer it in the terminal |

The phone's **Detach** only ends its connection. Desktop `/new`, branch,
compaction, and tree navigation change the advertised session generation and
invalidate commands from the old view. The loopback listener survives those
transitions. Exiting OMP closes it.

### Captured files

The extension observes a built-in `write` start and successful completion. It
checks public tool provenance before capturing a regular UTF-8 file inside the
canonical project directory. A similarly named extension tool, failed write,
arbitrary chat path, or download request cannot authorize a file read.

The current capture implementation requires Linux `/proc/self/fd` to verify
the opened descriptor's actual path. Final symlinks, escapes, binary content,
unsupported formats, and files above **2,000,000 bytes** are skipped. It keeps
at most **32 revisions / 8 MiB** without evicting advertised files. Each file is
an immutable copy observed after completion, not a live view of a changing path.
The registry is memory-only and clears on conversation/generation transitions
or process exit. Historical files are not rediscovered by reading old chat paths.

Downloads use `/perch/sessions/{sessionId}/artifacts/{opaqueId}` and the existing
paired gateway. Perch verifies exact byte length, SHA-256, and UTF-8 before its
normal artifact reader receives content. See [artifact policy](../../docs/ARTIFACTS.md).

## Prepare the host

Use the complete Perch checkout and Bun 1.4.2. The extension has no additional
runtime dependencies: OMP supplies its API and Bun supplies HTTP and crypto.
OMP must already have its provider login or model configuration.

From the Perch checkout:

```sh
bun server/omp-remote/setup.mjs --name "OMP in my project"
```

This creates `~/.config/perch/omp-remote.json` with a new random adapter token,
opaque identities, and the default port **4781**. POSIX permissions are `0600`.
The setup command reuses an existing valid file and does not print its token.
Use `--config /absolute/private/file.json`, `--host-name`, or `--port` for another
instance. Credentials must remain outside the checkout.

Then start OMP in the project terminal, including a pane inside Tern:

```sh
PERCH_OMP_CONFIG=/home/you/.config/perch/omp-remote.json \
  omp --extension /absolute/path/to/perch/server/omp-remote/extension.ts
```

Replace the two example paths with your actual paths. `--extension` and `-e`
are accepted by the pinned OMP CLI. To use the default configuration location,
omit the `PERCH_OMP_CONFIG` assignment.

Load the extension when starting an owner OMP session. An independently running
TUI without this extension cannot be instrumented retroactively by this server.
Do not use an OMP Collab guest process as an owner adapter. Multiple OMP terminal
processes need separate configurations, IDs, and loopback ports.

## Pair the phone once

Run `bun run setup:host` from the Perch checkout, choose **OMP remote**, and enter
the local listener `http://127.0.0.1:4781` and the adapter token from the private
file. The gateway listens on `127.0.0.1:4780`; your existing HTTPS reverse proxy
makes that workspace reachable by the phone.

For a private unattended workspace configuration, the connection entry is:

```json
{
  "id": "omp-owner",
  "name": "OMP in my project",
  "kind": "remote",
  "upstream": {
    "url": "http://127.0.0.1:4781",
    "token": "ADAPTER_TOKEN_FROM_PRIVATE_FILE"
  }
}
```

Perch receives the separate workspace pairing credential. It never needs the
model provider keys or this upstream adapter token. After pairing, choose the
workspace, select the advertised session, and attach. Opening the catalog does
not submit a prompt or silently attach to the first session.

## Protocol and lifecycle

The shared contract is [src/harness/remote.ts](../../src/harness/remote.ts).
Every endpoint requires `Authorization: Bearer <adapter-token>`. The listener
binds only to `127.0.0.1`. Browser origins are rejected here; browser clients use
the workspace gateway's origin policy. Query parameters, arbitrary destinations,
raw terminal writes, extension invocations, and unsupported command fields are
rejected.

| Endpoint | Meaning |
| --- | --- |
| `GET /perch/health` | Adapter version, host identity, epoch, and limitations |
| `GET /perch/sessions` | One current main OMP session; no automatic attachment |
| `GET /perch/sessions/{id}` | Bounded authoritative history plus a short-lived streaming overlay |
| `POST /perch/sessions/{id}/commands` | Identity-bound prompt, interrupt, or model command |
| `GET /perch/sessions/{id}/operations/{id}` | Original receipt, or HTTP 404 when none is known |

`runtimeId` identifies this configured adapter. `generation` changes on host
history transitions. `conversationId` comes from
`ctx.sessionManager.getSessionId()`, which identifies the transcript; OMP's
provider/cache session identity is not substituted. A new extension instance
has a new `epoch`. Revisions order snapshot responses within that epoch; this
prototype does not advertise a resumable event journal.

Command IDs are reserved before dispatch and bound to the exact command and
session identity. Reusing an ID with different input is rejected. An accepted
duplicate returns its receipt without invoking OMP again. The in-memory ledger
holds at most **4,096** commands per extension epoch. When full, it blocks new
commands instead of forgetting old IDs and allowing them to run twice.

**`forwarded` is an admission boundary, not tool completion.** OMP's public
`sendUserMessage` and `abort` methods return `void`; the TUI can report a later
admission error locally. The receipt does not claim that a model answered, a
tool succeeded, or history was persisted. A missing receipt (HTTP 404) also does
not prove that a previous command did nothing. Inspect current host state;
never turn a reconnect into a retry.

There is a brief admission guard before OMP reports `agent_start`. It prevents
two simultaneous phone prompts from accidentally becoming an implicit steer.
Public transition hooks also block changing the host conversation while prompt
admission or asynchronous model selection is in progress. If an admission error
occurs before any settling event, Perch disables another prompt and explains
the uncertainty. After checking the idle host, use **`/perch-remote-reset`** in
OMP and confirm the reset. This clears that guard and changes the generation;
it does not cancel or resend the old prompt. Phone reconnection cannot clear it.

Snapshots are capped at **500 messages**, **500 tools**, **256,000 characters per
text field**, **10,000 model metadata rows**, and **2,000,000 encoded bytes**.
Older or oversized content is explicitly marked as omitted or truncated.
Messages and tool results share one source-order budget: the latest tool output
is retained ahead of older conversation rows when the response is too large.
Complete `write` input is included only when it fits; partial file contents are
never advertised as an exact artifact. Persisted host messages replace event
overlays. Compaction and other observed history transitions clear overlays so a
deleted answer cannot reappear from a cached event.

## Verification

The dependency-free HTTP/configuration suite:

```sh
cd server/omp-remote
bun test ./test
```

The opt-in upstream verifier has its own pinned package and lockfile. It is
separate from Android app dependencies and never needs provider credentials:

```sh
cd server/omp-remote/upstream
bun install --frozen-lockfile --ignore-scripts --no-optional
bun ../verify-upstream.mjs
bun ../verify-upstream.mjs --interactive
```

For an already installed isolated runtime, set `PERCH_OMP_RUNTIME` to the
absolute directory containing its `package.json` and `node_modules`. The
verifier refuses versions other than 18.8.7.

Both modes create **one real upstream AgentSession**, install this extension,
and replace the provider stream with OMP's own deterministic in-memory mock.
They verify existing history, prompt admission, duplicate receipt handling,
reconnect without replay, active interruption, host model selection, real
`/new`, and shutdown. The interactive mode also uses OMP's **actual
InteractiveMode and extension UI controller**, confirming the phone-originated
answer appears in its captured terminal output. The terminal recorder does not
emulate a VT grid or measure a physical screen.

See [verification-results.json](verification-results.json) for the recorded
versions, boundaries, and results. These checks do not run Tern, contact a live
provider, test Android background behavior, or prove physical Pixel rendering.

## Remaining work

The adapter does not implement a terminal emulator, TSP pane rendering,
headless Tern daemon attachment, all TUI dialogs, native approval answers,
branch controls, or process-crash recovery. It projects the current main OMP
session; subagent extension events cannot replace that identity. A Tern workspace
adapter can provide the surrounding pane and tab context through the same
mobile protocol while retaining its own capability limits.

The grounding design is [Remote workspace design](../../docs/REMOTE-WORKSPACE-DESIGN.md).
The public API basis is [OMP extension authoring](https://omp.sh/docs/extension-authoring),
with exact [extension types](https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/packages/coding-agent/src/extensibility/extensions/types.ts)
and [TUI extension bindings](https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/packages/coding-agent/src/modes/controllers/extension-ui-controller.ts).
