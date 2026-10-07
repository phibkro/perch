# PiHarness on celld: runnable recovery experiment

**Verified 7 October 2026: both runs passed all nine checks.** The official
PiHarness and Lifecycle packages run inside an actual celld cell. The second
run deletes all local runtime data while work is unfinished, retains celld's
development object store, and observes alarm-driven completion after restart.

This is an isolated backend experiment. The model and external tool observer
are controlled fixtures. SQLite, Pi scheduling, PiHarness, celld, checkpoint
restoration, process termination, and alarm delivery are real. No model key or
cloud account is used. The mobile application is unchanged.

## Run

Use Linux, Node 22.19 or newer, and **celld 0.6.1**. Node 24.19.0 was used for the
recorded runs. From this directory:

```sh
bun install --frozen-lockfile
bun run build
CELLD_BIN=/absolute/path/to/celld bun run test
CELLD_BIN=/absolute/path/to/celld bun run test --fresh-cache-on-crash
```

The runner selects its own loopback ports, starts celld, forces a crash, and
stops its processes when done. `CELLD_ESBUILD` defaults to this experiment's
installed esbuild. It creates disposable state under `.runs/` and writes
`results/local-dev.json` or `results/fresh-cache-pending.json`. Set
`PROBE_RESULTS` to retain a differently named report. Re-running replaces the
chosen report and leaves prior disposable run directories for investigation.

The Linux runner relies on celld's parent-death behavior: killing the development
supervisor kills its child node. It verifies that the node listener has closed
before starting a replacement. The test does not send a graceful shutdown.

### Install the exact tested Linux binary

The download digest below was checked against the official release:

```sh
mkdir -p .tools
curl --fail --location \
  https://github.com/denoland/celld/releases/download/v0.6.1/celld-x86_64-unknown-linux-gnu.gz \
  --output .tools/celld.gz
sha256sum .tools/celld.gz
```

Expected SHA-256:

```text
79a8253cff5d4e8a4a9f7a2611e393390f7fe9025f00e88467875b007c44866b
```

After the digest matches:

```sh
gzip --decompress --stdout .tools/celld.gz > .tools/celld
chmod +x .tools/celld
.tools/celld --version
CELLD_BIN="$PWD/.tools/celld" bun run test --fresh-cache-on-crash
```

## What is exercised

| Session | Crash point and expected result |
|---|---|
| Completed | A committed tool and transcript reopen without another tool attempt |
| Safe tool | Crash after document bytes are written; repeat the tool with the same memoized artifact ID |
| Unsafe tool | Crash after an external effect; record interruption without automatically executing that call again |
| Model stream | Crash after a partial is committed; retain an aborted entry and retry inference |
| Lost receipt | A proxy drops a committed submission's HTTP receipt; retry its stable ID without duplicate admission |

The four unfinished sessions each also contain a queued follow-up. After the
crash, the runner calls no session endpoint until all eight operations have
settled. Boot events must identify `alarm` as the activation cause. Result
inspection then checks empty queues, two user entries per interrupted session,
stable provider session identity, artifact identity, and exact document bytes.

The `--fresh-cache-on-crash` variant removes `.celld/dev/runtime` before this
alarm-only recovery. Both variants later remove it again after completion and
compare all five restored transcripts. The backing `objects.sqlite3` store and
its SQLite sidecars remain. `celld dev --clean` would delete that backing store
too and is deliberately not used.

## Evidence and limits

- [Full results and interpretation](../../docs/PI-CELLD-RESULTS.md).
- [Compact machine-readable summary](results/summary.json).
- [Ordinary restart evidence](results/local-dev.json).
- [Unfinished-work restore evidence](results/fresh-cache-pending.json).
- [Exact runtime provenance](results/runtime-provenance.json).
- [Prepared external bucket lab](bucket-lab/README.md).

The probe attaches result waiters during startup. PiHarness calls `pi.resume()`
before those waiters are attached; Pi's wait method also idempotently nudges the
scheduler. No monitor submits or replaces input. This tests the complete
composition and alarm recovery; it does not claim a variant with no waiters.

**Unverified:** real R2/S3, multiple simultaneous celld nodes, physical host or
power loss, real model providers, OAuth, Linux workspaces, and mobile reconnect.
The external observer survives celld and stores fixture artifact bytes locally.
That checks identity and replay behavior, not R2 artifact persistence. The unsafe
fixture's model chooses not to request a new action, so it is not an exactly-once
guarantee for arbitrary external effects.

The worker is deliberately a loopback test fixture with synthetic routes. The
external-bucket runbook includes the recorded MinIO environment blocker; its
production S3 procedure has not been executed.
