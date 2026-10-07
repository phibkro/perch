# Durable client verification

Run `npm --prefix verification/durable test` after the root `bun install --frozen-lockfile`.
The runner compiles the actual driver and session store, then connects them to an
independent HTTP fixture bound only to loopback. It makes no model, cloud, or
user-host requests. Fixture tokens are public test data.

The checks cover authentication headers and credential-safe failures, strict
handshake and snapshot projection, model identity, empty-history creation,
authoritative session changes, active polling, lost receipts, unknown operations,
generation changes during delivery, and exact-ID creation recovery. An unknown
prompt is not posted again by reconnect; deliberately submitting the same text
reuses the original operation ID held in this driver instance.

Artifact checks use a real Node SHA-256 digest and include multibyte UTF-8 and a
leading BOM, invalid UTF-8 with a valid checksum, wrong bytes, oversized streams,
stale session selection, forged manifests, and redirect destinations that must
receive no request. Malformed and duplicate metadata cannot replace the last
valid snapshot.

Android/iOS bundle `expo/fetch` and `expo-crypto`; these tests execute the Node/web
implementations. A successful build verifies native module resolution, while
actual device networking and rendering remain separate checks. This fixture does
not establish celld, PiHarness, R2, or multi-node recovery behavior; those belong
to the backend integration runner.

Tokens and unconfirmed operation identities live only in driver memory. Explicit
reconnect preserves them; killing the app process does not. The driver polls at
750 ms while the selected session reports work and 6 seconds while idle. A full
snapshot is authoritative; no local agent loop or delta replay is involved.
