# Actual PiHarness and celld verification

This runner connects the real Perch SessionStore and durable driver to the real
backend on celld. It verifies persisted state and artifact recovery, separately
from the independent HTTP driver fixture and DOM integration checks.

## Run

Use Node 22.19 or newer and celld 0.6.1. From the repository root:

```sh
bun install --frozen-lockfile
bun install --cwd server/pi-durable --frozen-lockfile
bun run --cwd server/pi-durable test
CELLD_BIN=/absolute/path/to/celld node verification/durable-runtime/verify.mjs
CELLD_BIN=/absolute/path/to/celld node verification/durable-runtime/verify.mjs --production-provider
```

If celld is already on PATH, omit `CELLD_BIN`. The runner bundles the client and
worker itself with the backend's pinned esbuild. It creates isolated run folders
under `.runs`, binds only loopback HTTP endpoints, uses public fixture tokens,
and stops its child process after each run. It neither deploys a service nor
connects to a user's account or paid model.

On a small shared machine, stop heavy concurrent builds before running the crash
scenario. celld's cgroup memory protection can evict a runtime under unrelated
Gradle pressure. Leave the protection enabled and give the test enough memory.

Startup now requires both celld's `/.well-known/celld/health` readiness response
and Perch's authenticated health response. An application can answer health
requests while celld refuses to admit restored cells. The runner records runtime
readiness and cgroup usage at each start. If the supervisor exits, the runner
reports its exit and bounded logs immediately instead of waiting for alarm events.

The 7 October Bun migration check exposed that distinction: a restart reported
`memory_headroom: false` at 7,118,413,824 cgroup bytes out of 8,589,934,592, despite
only 2,746,085,376 working-set bytes and no OOM kill. The alarm records remained
in the backing store, but celld's readiness returned 503 and its supervisor
stopped. With competing work stopped, the unchanged scenario passed all nine
checks; a restart sample had 5,472,075,776 cgroup bytes and
`memory_headroom: true`. No dependency change or memory-protection override was
needed. See [the admission comparison](results/resource-admission.json).

The focused regression test covers a healthy app behind a runtime that returns
503, and a supervisor exit with the readiness diagnosis:

```sh
node --test verification/durable-runtime/runtime-health.test.mjs
```

## Recovery mode

`fixture-worker.mjs` imports the production backend factory and substitutes only
a deterministic Pi provider and observation hooks. Authentication, routing,
workspace catalogs, SessionData, PiHarness, Lifecycle, SQLite, the artifact tool,
and the bucket binding remain the actual implementation.

The runner verifies workspace isolation, real client creation/submission,
lost-receipt reconciliation, model choice and history on a fresh client, exact
Markdown/HTML/code downloads, and Stop against a running Pi task. It then starts
two unfinished sessions, each with a queued follow-up. One pauses after uploading
artifact bytes but before committing the visible manifest. The other pauses with
a committed partial model response.

The runner sends SIGKILL to the celld dev supervisor, verifies that its listener
closes, and deletes the run's `.celld/dev/runtime` directory. The dev object
store (`.celld/dev/objects.sqlite3` and its sidecars) remains. Linux parent-death
signaling stops the child runtime with the supervisor. After restart, no session
HTTP request is allowed to trigger recovery: alarm activation must finish all
four accepted operations first. Observation uses persisted admission IDs so fast
completion cannot be missed by a late sample of only pending operations.

Finally, a fresh client reopens both original and recovered artifacts. Two upload
attempts must converge on the same memoized artifact ID, timestamp, hash, bytes,
and single manifest. Repeated operation IDs must not create duplicate user input;
changing workspace credentials must invalidate the old artifact reference.

## Production provider mode

`--production-provider` loads `server/pi-durable/src/worker.mjs` with explicit
`PERCH_MODELS` and host credentials. Pi's real OpenAI-completions adapter talks to
a controlled local HTTP/SSE model endpoint, invokes the real `write_artifact`
tool, and finishes a response. The actual client downloads the saved file.
The report records `productionEntry: true` and `syntheticModel: true`: the adapter
and service are production code, while inference remains a fixture.

## Evidence and limits

- `results/latest.json`: recovery checks, observation events, request log,
  process-kill evidence, and baseline/recovered normalized snapshots.
- `results/production-provider.json`: production entry, provider HTTP requests,
  protected artifact download, and normalized client state.
- `results/resource-admission.json`: measured memory admission during the failed
  restart and the unchanged successful rerun.
- `.runs/<run>/`: local compiled inputs and runtime logs; ignored by Git.
- `DURABLE_RESULTS=/absolute/file.json`: optional override of the result path.

The checked-in reports passed on 7 October 2026; see
[the measured results](../../docs/DURABLE-BACKEND-RESULTS.md). These tests prove
recovery from celld's **local development backing store**. They do not establish
R2/S3 durability, power-loss acknowledgment guarantees, multi-node takeover,
Cloudflare deployment, production inference reliability, or physical phone
behavior. Client process restarts also discard the memory-only pending-ID map;
the host's persisted history and operation records remain authoritative.
