# Tern beta qualification

Observed on **2026-10-10** with Bun **1.4.2** and the user's separately supplied
Tern **0.6.0 (`0e39682`)** for Linux x86-64. The beta is not part of this repository.

## Results

| Check | Result |
| --- | --- |
| Loopback bridge tests | 20 passed, 0 failed, 167 assertions |
| Actual Tern + production Luau plugin + synthetic TSP child | Passed |
| Pure request mapper in actual Tern Luau VM | 10 checks passed; 9 protocol-valid examples |
| Actual OMP owner callbacks with protocol recorder | 7 checks passed on installed OMP 18.8.7 |
| Actual Tern + production plugin/bridge + actual OMP | 7 checks passed; one original process and canonical OMP session |
| Actual Tern surface read of a 65 KB plan | Read-only; answer rejected; zero approval events; 11-check regression passed |
| Paid provider calls | Zero; all OMP responses use the stock local mock provider |
| Tern loopback remote daemon | Blocked by this execution environment's Unix socket restriction |
| Native shared health, catalog, snapshot, and receipt parsers | Passed at both boundaries |
| Existing conversation | Two messages read before any phone command |
| Prompt delivery | One atomic native `send`, with the exact Unicode and multiline text |
| Host continuity | The same child PID received the prompt and interrupt |
| Conversation update | Four messages read from Tern after the synthetic reply |
| Phone reconnect / duplicate command ID | No second `send` event |
| Non-ready composer | Rejected without an additional `send` |
| Interrupt | One Ctrl-C event, without ending the child |

The actual-beta check uses Tern's documented deterministic headless fixture mode
with software rendering. It installs the unchanged production plugin into an
isolated temporary fixture tree. A small local Python program speaks TSP through
Tern's real PTY and records only synthetic send/interrupt events. A bounded test
control loop advances the headless owner thread while asynchronous plugin HTTP
callbacks run. The production plugin does not use Tern's control endpoint.

The ordinary bridge suite also verifies credential separation, rejection of
browser origins, stale epochs and pane generations, independent window
registrations, unknown outcomes without replay, read-only controls, bounded
snapshots, stable identifiable artifact rows, and the 1,024-entry receipt limit.
The new request checks cover exact current choices, stale requests/revisions,
disabled or incomplete context, changed requests before queue delivery, and
fresh-id replay rejection after pending, forwarded, or unknown answers.
Setup tests reject public file modes, symlinks, and checkout-local secret paths.
The ownership test presents a different current user while reading a real file;
the execution environment does not permit changing file ownership with `chown`.

## Runtime finding incorporated in the plugin

A generic dock editor marked `sendable` was insufficient for Tern's `ask` API.
The native composer must sit beneath the normal **`omp.editor`** role in the
**`omp.session`** surface's dock. The synthetic fixture now reproduces that
structure, and the production readiness check requires it before calling `ask`.
It excludes OMP's bash/Python composer roles and arbitrary modal inputs.

Validation and API invocation run synchronously with no intervening yield.
Validation failure reports `rejected`. An exception after invocation begins
reports `unknown`; it cannot establish that no input reached the host. The
bridge never automatically resubmits either outcome.

## Actual owner requests

The real OMP verifier installs one in-memory `AgentSession` with an inert
extension tool and the stock mock provider. It exercises the installed native
backend and `InteractiveMode`; it does not replace the approval or plan
callbacks. Its protocol recorder captures the actual approval picker, selector
fallback, plan sheet, hook input, and hook editor trees used by the pure mapper
regressions.

The full chain launches that actual OMP runtime inside an actual Tern PTY and
uses only the production plugin and bridge for phone commands. The recorded
flow:

1. Reads the first owner tool approval and submits Deny. The tool does not run.
2. Reads a new, identical approval. An old request is rejected; the new Approve
   executes the inert tool exactly once.
3. Reads the owner's plan and selects Refine through the real plan handler.
4. Sends a separate Unicode and multiline feedback message through the restored
   ordinary composer.
5. Reviews the reopened plan and chooses Approve and keep context. The stock
   mock provider continues in the original session.
6. Reads duplicate receipts and reconnects without another tool execution.

The final strengthened run compares the displayed heading and every plan body
line against the actual plan file, normalizing only blank-line separation
between OMP's Markdown sections. It also compares the reopened document with
the first projection. This creates one process/session, makes six local
mock-provider calls, and checks that every owner event has the original PID and
the same nonempty canonical OMP session id. That test-only
observation does **not** imply the public Tern snapshot provides a canonical
OMP conversation id.

The child uses OMP's public `setTerminalHeadless(false)` test override and
`PI_TUI_NATIVE=1` before startup. OMP otherwise suppresses real terminal I/O and
native probes under `PI_TEST_RUNTIME`. The fixture asserts successful native
negotiation before starting a model turn.

### Request projection and guard evidence

The pure mapper runs unchanged in Tern's Luau VM with captured stock OMP trees
at the `cx.session:surface` boundary. It checks full approval context and exact
host item targeting; new component identities; plan revisions and disabled
options; capped/oversized plans; covering modals; filtered and checkbox pickers;
unsupported extension editors; timed/multi-part selectors; long titles; the
selected execution model's separate detail; and an existing annotation chooser.
All displayed decision data and exact private routing data enter the revision
fingerprint. A changed revision does not unlock an already submitted request.

The `--oversized` synthetic Tern variant adds a 65 KB plan to the real native
surface. Its 11-check run verifies that the production mapper returns it as
read-only through the actual SDK read path, the bridge rejects an answer, and
no `activate` event reaches the PTY. The ordinary prompt, updated transcript,
reconnect, non-ready prompt, and interrupt checks pass in the same run.

Stock OMP `ui.input` and `ui.editor` fields have `sendable:false`. They remain
read-only in Perch. The plan's Refine option returns to the ordinary composer;
it does not create a dedicated feedback editor request. Plan strategy changes
and section annotation editing remain host controls.

Upstream `activate` contains no expected-document-revision guard. Perch checks
the fresh Tern replica and invokes its API within one callback, but cannot make
that a cross-process compare-and-resolve in OMP. A successful `forwarded`
receipt proves API dispatch, not persisted external effects or exactly-once
execution.

### Runtime restrictions observed

The optional `--loopback` check calls Tern's documented `remote loopback` fixture
to attach a real daemon, then would verify host membership and prompt/interrupt
routing. It was blocked before attachment by `Operation not permitted` when
Tern tried to create `/tmp/tern-loopback-…/daemon.sock`. No remote host, SSH, or
tunnel runtime success is claimed. The production host-location mapping follows
the generated `ManagedHost.panes` API and Tern's documented window boundary.

Some initial software-rendered test attempts exceeded Tern's 50 ms plugin load
or fetch-callback budget and disabled the plugin until reload. The fixture
launchers now default to `LP_NUM_THREADS=1`, which limits Mesa llvmpipe's render
workers without changing rendering semantics or Tern's deadline. Mesa normally
uses the visible CPU-core count, which can oversubscribe a container's smaller
quota; this was a plausible source of timing pressure, not a proven diagnosis
of every timeout. The strengthened full owner chain and the oversized-plan
check passed with one worker. This does not establish timing reliability under
every scheduling condition. The adapter reports an unavailable window instead
of resubmitting an uncertain command. No production deadline is disabled or
raised. [Mesa environment variable reference](https://docs.mesa3d.org/envvars.html#envvar-LP_NUM_THREADS).

## Repeat the checks

From the Perch checkout:

```sh
bun test server/tern-remote/test/bridge.test.mjs
TERN_BIN=/path/to/tern bun server/tern-remote/test/verify-tern.mjs
TERN_BIN=/path/to/tern bun server/tern-remote/test/verify-request-mapper.mjs
bun server/tern-remote/test/verify-omp-owner-requests.mjs
TERN_BIN=/path/to/tern bun server/tern-remote/test/verify-tern-omp-owner.mjs
TERN_BIN=/path/to/tern bun server/tern-remote/test/verify-tern.mjs --oversized

# Optional; requires local Unix sockets and the daemon path to be available.
TERN_BIN=/path/to/tern bun server/tern-remote/test/verify-tern.mjs --loopback
```

The synthetic Tern check needs Python 3 and a Tern build supporting
`serve --control` and fixture plugins. The owner checks use the separately
installed pinned OMP runtime under `server/omp-remote/upstream`, or the isolated
runtime directory supplied in `PERCH_OMP_RUNTIME`. Each creates and deletes its
own temporary configuration, process, control endpoint, and snapshots. Provider
credentials are unnecessary. `PERCH_TERN_KEEP_FAILURE=1` retains a failed
full-chain fixture for diagnosis; `PERCH_TERN_PROFILE=1` adds stage timings only
to its temporary plugin copy.

## Evidence fingerprints

| Supplied or generated input | SHA-256 |
| --- | --- |
| `Tern-0.6.0-linux-x86_64.tar.gz` | `1378582b53e63469ea4c85d8fc7f62ecda1072b4c3381bd67e1dc1e3ff8c8db7` |
| Extracted `tern` binary | `30fb234233c013b8f669eb101cbaf4114392a8b65296747d264595dbd8d4a175` |
| `tern plugin types` declaration file | `dfb4c9f419dd8a37bd9305c46c8422299b7376b4b5da27c1684bc74637790bbe` |

The fixture's TSP structure was checked against OMP source revision
`b07a1c146d0d12cfc855a2c65d52f892ef319040`, including the native backend,
editor node properties, and custom editor role hierarchy. Execution verification
uses the installed OMP 18.8.7 package. That package and the source checkout share
a version label but differ in some newer selector options; the captured runtime
fixtures establish the shapes actually tested.

## What this establishes and what remains

The production plugin loads and uses the supplied beta's actual Luau callbacks,
agent inspection methods, structured transcript extraction, atomic native send,
owner decision events, and interrupt pathway. The bridge exchanges snapshots accepted by Perch's
native protocol and keeps read/reconnect operations from replaying a command.

This is **not** a test of a restored user desktop, a paid-provider turn, model
credentials, a remote network tunnel, or physical Android keyboard and lifecycle
behavior. The window must remain connected for inspection. Tern supplies no
canonical OMP conversation ID, entry IDs, or transcript timestamps; bounded view
IDs remain conservative and ambiguous history changes may require reopening an
artifact. The adapter adds no execution checkpoint, daemon recovery, or restart
mechanism for Tern/OMP.
