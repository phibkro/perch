# Pi Durable recovery experiment

**Local experiment, verified 7 October 2026.** This uses the real Pi Durable harness and its real Node SQLite storage. It is not connected to Perch's mobile UI or deployed to Cloudflare.

## Run

Use Node 22.19 or newer (verified with Node 24.19.0):

```sh
cd experiments/pi-durable
bun install --frozen-lockfile --ignore-scripts
bun run test
```

The package and lock pin `@earendil-works/pi-durable`, `@earendil-works/pi-ai`, and `@earendil-works/chord` to **1.0.4**. Dependencies stay inside this experiment. The test uses a synthetic provider implemented in memory; it cannot make a model request, requires no key, and replaces `fetch` with a throwing function. Child processes inherit only `PATH` and a Node warning setting.

## What the tests prove

Each scenario launches a Node child, waits for a specific committed state, sends **SIGKILL**, then starts another child against the same SQLite file.

| Interruption | Observed recovery |
| --- | --- |
| Whole-file artifact write, marked replay-safe | The tool runs twice, retains the same memoized artifact ID, and leaves one exact document. One final tool result appears in the transcript. |
| Append-like external effect, left unsafe | The effect occurs once. Recovery does not execute that call again; it gives the model an interrupted result that says the tool may have partially run. |
| Streaming model response | The committed partial survives reopening, becomes an aborted assistant entry, and a new synthetic model request completes the operation. |

All three also verify that:

- Retrying the same two request IDs returns the original submission IDs and produces exactly two user entries.
- The second input remains queued across the kill and is later answered.
- The conversation ID and provider-facing session identity survive reopening.
- A snapshot reads the recovered state before scheduling starts.

`test/worker.mjs` contains the deterministic model and tool. `test/recovery.test.mjs` owns process termination and assertions. The fixture hangs deliberately at the interruption point; it is not an application entry point. Each test has a timeout and removes its temporary files after closing child processes.

## Practical limits

These are **three recovery scenarios**, not a benchmark or a proof of every possible crash boundary. The unsafe scenario's synthetic model chooses not to issue a new tool call; a real model could choose differently. External APIs still need stable operation keys or reconciliation when repeating an effect would matter.

The test confirms process-crash behavior, not power-loss durability. Pi's Node SQLite adapter uses WAL with `synchronous = NORMAL`; the upstream README notes that the newest commits may be lost on host or power failure.

Cloudflare's SQLite adapter, `PiHarness`, alarms, eviction, account isolation, OAuth, sandbox restoration, and preview hosting are **not executed by this experiment**. Their documented behavior and the proposed Perch integration are evaluated in [Pi Durable versus Pi in a container](../../docs/PI-DURABLE.md).

Observed result: **3 tests passed, 0 failed**. No provider, Cloudflare, or other external service was contacted during the tests.
