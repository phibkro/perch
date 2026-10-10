# Tern beta qualification

Observed on **2026-10-10** with Bun **1.4.2** and the user's separately supplied
Tern **0.6.0 (`0e39682`)** for Linux x86-64. The beta is not part of this repository.

## Results

| Check | Result |
| --- | --- |
| Loopback bridge tests | 16 passed, 0 failed, 133 assertions |
| Actual Tern + production Luau plugin + synthetic TSP child | Passed |
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

## Repeat the checks

From the Perch checkout:

```sh
bun test server/tern-remote/test/bridge.test.mjs
TERN_BIN=/path/to/tern bun server/tern-remote/test/verify-tern.mjs
```

The latter command needs Python 3 and a Tern build supporting `serve --control`
and fixture plugins. It creates and deletes its own temporary configuration,
process, control endpoint, and snapshots. Provider credentials are unnecessary.

## Evidence fingerprints

| Supplied or generated input | SHA-256 |
| --- | --- |
| `Tern-0.6.0-linux-x86_64.tar.gz` | `1378582b53e63469ea4c85d8fc7f62ecda1072b4c3381bd67e1dc1e3ff8c8db7` |
| Extracted `tern` binary | `30fb234233c013b8f669eb101cbaf4114392a8b65296747d264595dbd8d4a175` |
| `tern plugin types` declaration file | `dfb4c9f419dd8a37bd9305c46c8422299b7376b4b5da27c1684bc74637790bbe` |

The fixture's TSP structure was checked against OMP source revision
`b07a1c146d0d12cfc855a2c65d52f892ef319040`, including the native backend,
editor node properties, and custom editor role hierarchy. That source review is
not an execution test of OMP itself.

## What this establishes and what remains

The production plugin loads and uses the supplied beta's actual Luau callbacks,
agent inspection methods, structured transcript extraction, atomic native send,
and interrupt pathway. The bridge exchanges snapshots accepted by Perch's
native protocol and keeps read/reconnect operations from replaying a command.

This is **not** a test of a restored user desktop, a real OMP/model turn, model
credentials, a remote network tunnel, or physical Android keyboard and lifecycle
behavior. The window must remain connected for inspection. Tern supplies no
canonical OMP conversation ID, entry IDs, or transcript timestamps; bounded view
IDs remain conservative and ambiguous history changes may require reopening an
artifact. The adapter adds no execution checkpoint, daemon recovery, or restart
mechanism for Tern/OMP.
