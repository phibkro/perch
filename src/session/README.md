# Session layer

`sessionStore` is exported from `src/session/index.ts`. Its stable `subscribe` and
`getSnapshot` functions can be passed directly to React `useSyncExternalStore`.
All display data comes from an immutable published snapshot. Treat returned data
as read-only. Actions are bound methods and may be passed as callbacks.

The snapshot also carries harness metadata, host-reported model metadata, and
explicit adapter capabilities. The UI does not assume every connection is OMP.
See [the harness contract](../harness/README.md) for the shared boundary.

## Workspace pairing

`src/workspace` sits above these driver connection methods. It discovers the
available harnesses from one authenticated workspace endpoint and supplies the
selected connection to this store. Native SecureStore retains paired workspace
access; individual drivers still keep their active credentials in closures.
Advanced direct connections retain their memory-only behavior. The workspace
manager does not own another transcript, send prompts, or replay pending actions.
See [the setup guide](../../docs/WORKSPACE-SETUP.md).

## Demo

The default mode is `demo`, visibly identified in `snapshot.mode` and connection
labels. Every session has its own synthetic history and independent work token.
No files, commands, model calls, credentials, or network connections are involved.

The app starts with an empty New chat. `startNewChat()` prepends a new blank
thread, selects it, and returns its unique ID. It preserves work in other demo
threads. The first prompt supplies a whitespace-normalized, shortened sidebar
title; message contents remain complete. This action is a no-op while offline
or connected to a real host. `useDemo()` resets to another fresh blank identity.

1. Open Mobile companion from the sidebar and send a prompt.
2. Watch a synthetic diagnosis stream, followed by tool progress.
3. Answer the single-choice question; Add instructions opens a text editor question.
4. Apply fix and rerun simulates three passing checks.
5. Interrupt cancels only the selected thread's work.
6. Disconnect freezes the phone snapshot while simulated host work continues.
7. Reconnect hydrates the latest host state without resending any action.

Pass `answerQuestion(answer, displayedQuestion.id)` to reject stale sheets. Select
answers use the option ID, not its label. Editor answers use the text. A repeated
answer, unknown option, cancelled request, or stale request ID is a no-op. Don't
clear composer text when controls are disabled: normal demo prompts are accepted
only when the active session is idle and connected. Live send controls must also
respect `readOnly`.

## Real OMP Collab

`connectCollab(link, displayName)` is the explicit opt-in. Merely opening the app
or a connect sheet never contacts the relay. The link is held in memory only.
It is never written to storage, logs, or analytics. No credentials are bundled.

The adapter uses pinned upstream OMP GuestClient, link grammar, session store,
and encrypted relay transport. It becomes `live` only after the host's welcome
and complete snapshot. It does not fall back to a demo after failures.

Android/iOS choose `codec.native.ts` through Metro resolution. This uses
`expo-crypto` native AES-256-GCM, retaining OMP's 12-byte IV plus ciphertext and
16-byte tag. Web/Node use the upstream WebCrypto codec. The native adapter checks
encryption and decryption byte-for-byte against a public Node/OpenSSL reference
vector, then runs a room-key round trip before opening a socket. This checks
codec compatibility, not end-to-end compatibility with a user's host.

Supported presentation: text transcript, streamed assistant text, plain tool
cards, host subagents, single-select and text-editor questions, prompt and abort.
View-only links disable all writes. A submitted question remains visible with
`answering: true` until the host ends or replaces it; reconnect clears pending
local answer state and fetches host state. Unsent commands are never queued for
a later connection. An already transmitted command may still run on the host.

Prototype limits: no attachment picker/preview, syntax-rich tool renderers,
subagent transcript UI, checkbox picker, session discovery service, push service,
or guarantee of background sockets. A live connection covers the one session in
the submitted link. A multi-selection request is explicitly delegated to the
host terminal. Starting/resuming/model-switching host sessions is not exposed by
this Collab client. Tern's renderer and TSP client are not implemented here.

See `THIRD_PARTY_NOTICES.md` for the exact upstream commit and local changes.

## Real pi

`connectPi({ url, token }, displayName)` explicitly connects to our authenticated
self-hosted pi bridge. The driver's token stays separate from the URL. Direct
tokens remain in memory; paired workspace access is saved by the workspace
manager. The bridge owns a long-lived pi RPC process and preserves its work across
phone disconnects. Model/provider settings and credentials stay on the host.
`setModel(provider, modelId)` selects only a server-configured model while idle.
No prompt or answer is replayed automatically. Pi's UI-response protocol has no
host acknowledgment; a question is cleared only after successful stdin write by
the bridge, which means forwarded rather than confirmed processed.

See [pi bridge setup and tests](../../server/pi-bridge/README.md). This connector
does not attach to an existing independent pi terminal process. The offline demo
also includes a separate artifact conversation with Markdown, HTML and code.

## Real OpenCode

`connectOpenCode({ url, username, password, directory? })` connects to the included
OpenCode gateway. It verifies `/perch/health` before fetching model metadata. The
gateway sanitizes the raw server catalog and only exposes the adapter's routes;
provider credentials are not part of the client configuration.

`createSession()` returns a promise for the selected new host ID. For the demo it
wraps `startNewChat()`. A failed or superseded request returns no ID. Never replay
an ambiguous create automatically: inspect the refreshed host list first.
`selectSession(id)` delegates when the host exposes that capability.

`sessions` carries OpenCode's remote list. `sessionAction` marks an in-progress
creation or selection; the previous session ID and transcript remain paired
until the new snapshot arrives. Send, answer, model, and interrupt actions are
guarded during that transition. Host work in another conversation is not stopped
by selecting a different one.

Model changes select a host-advertised provider/model pair for the next prompt.
SSE notifications schedule authoritative reads instead of replaying deltas into
a second store. Reconnect refreshes state and does not resend mutations. Read
[OpenCode setup and verification](../../docs/OPENCODE.md) for supported decisions,
server version, and remaining boundaries.

## Pi Durable

`connectDurable({url, token})` verifies the protected `/perch/health` contract,
then loads the workspace catalog and one authoritative session snapshot. An empty
workspace is connected and writable but has prompt support disabled until the
user chooses New chat. HTTP is allowed only for loopback; remote hosts use HTTPS.

The driver polls every 750 ms while working and every six seconds while idle.
Each submission has a stable operation ID. If its receipt is lost, the driver
looks up that ID; it never automatically sends a prompt again. A deliberate retry
of the same unresolved text reuses the original ID. If creation's receipt is lost,
each explicit reconnect can replay the same pending idempotent create ID, because
the catalog has no separate operation lookup. It never invents a replacement ID
for that pending create. Temporary identities remain in memory. Paired workspace
access is persisted separately by the workspace manager; an Advanced direct
connection token remains memory-only.

`storedArtifacts` contains immutable, bounded manifests. `loadArtifact(reference)`
requires current session membership, then verifies protected download length,
SHA-256 and UTF-8. It rejects stale results after a credential or session change.
`connectionEpoch` changes with the credential scope, even when the next workspace
uses the same session ID. App keys its drafts and readers by this epoch.

Phone disconnect does not abort host work. A new phone process must reconnect and
inspect server history; it has no durable outbox, stored credentials, or offline
transcript cache. The backend advertises no attachment, steering, or question UI.
See [the durable backend guide](../../docs/DURABLE-BACKEND.md).

## Remote host sessions

`connectRemote({url, token})` authenticates a Perch remote adapter and reads its
session catalog. It opens no transcript until `selectSession(id)` is called.
The empty selection uses `activeSessionId: ''`, an empty transcript, and no prompt
capability. The adapter can run next to an existing OMP process or bridge a Tern
window. It never creates another harness on behalf of the phone.

An attachment binds the host epoch, runtime ID, generation and, when available,
conversation ID. The catalog and transcript become visible together after
validation. Reconnect reads health again and observes the same identity. An
adapter restart, replaced runtime, desktop conversation switch, or ended session
returns to the catalog for a new explicit selection. Draft and artifact view keys
include the remote epoch, generation and conversation, so old content cannot be
mistaken for the new session.

`detachSession()` clears the phone's selected view and continues reading the host
catalog. It sends no interrupt or termination command. `interrupt()` is a separate
capability-guarded action against the selected running session. A fresh phone
process must pair or open a saved workspace, then select a session again.

Each mutation carries a command ID and the current attachment identity. A lost
response triggers a receipt lookup. Reconnect never reposts a command. An unknown
receipt remains visible; sending the same unresolved text is blocked until its
receipt is resolved. `forwarded` acknowledges dispatch to the existing host
interface, not a completed model turn. These receipt IDs remain in phone memory.

The first version polls full bounded snapshots every 750 ms while working and
every three seconds while idle. It does not claim a lossless event stream or
complete history. The host reports truncation, available controls, and model
metadata. The existing native assistant-ui projection and derived artifact
readers consume that state. Shared dialogs, native TSP surfaces, terminal byte
streams, stored file references, and process crash recovery are separate work.

Run `bun test verification/remote` for real loopback HTTP tests through the public
store/driver boundary. No model call or user host is involved. See the
[remote workspace design](../../docs/REMOTE-WORKSPACE-DESIGN.md) for identity,
authority and milestone decisions.

## Verification

Run `node src/session/verify.cjs` from the project root. It compiles the session
layer into a temporary directory and exercises blank startup, new-chat identity,
offline/live-host creation guards, thread isolation, stale sheets,
the editor branch, interruption, offline catch-up, and an encrypted WebSocket
exchange against an independent Node/OpenSSL host bound only to loopback. The
fixture checks hello/snapshot handling, duplicate entry IDs, authoritative
question dismissal, prompt/abort, read-only permissions, and reconnect without
answer replay. It never contacts a public relay or a user's host.

For a browser UI check, `node src/session/verify.cjs --fixture` prints a synthetic
localhost Collab link. This is a protocol fixture, not an OMP session or a model.
Stop it with Ctrl+C. Native Android still requires a device/emulator check.
