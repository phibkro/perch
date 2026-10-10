# Remote hosts, approvals, and plan review

Perch uses the **Tern remote connection** to answer supported dialogs in the
OMP process that is already running. The phone shows the host's request and
returns a choice to that request. It does not start another OMP process or
translate an approval into an ordinary chat message.

This is the follow-up to [the 0.7 remote workspace design](REMOTE-WORKSPACE-DESIGN.md).
The source implementation adds native owner requests. Published binary and
runtime evidence are tracked in [VERIFICATION.md](VERIFICATION.md).

## Connecting to a self-hosted Tern

There are two different connection steps:

| Step | Where it happens | Current Perch support |
| --- | --- | --- |
| Add a workspace by HTTPS address and pairing code | Perch | Implemented; the workspace advertises its Tern adapter |
| Attach to an existing OMP pane | Perch's Host sessions | Implemented; no replacement agent starts |
| Add a machine with Tern's Add remote host | The connected Tern desktop window | Use Tern's existing flow; Perch does not yet reproduce it |
| Use a pane on a host already added to that window | Perch through the Tern bridge | The window plugin can discover and address those panes |
| Attach directly from Android to a bare Tern daemon | Perch | Not implemented |

Tern documents that a local window plugin sees local panes and panes on remote
hosts attached to that window. The daemon owns the pane; the window is a replica
and provides the plugin context. Closing the window removes this bridge while
the daemon may keep the agent running. This scope is separate from daemon-only
remote attachment. [Tern architecture][tern-architecture]

For the current implementation:

1. On the machine running the Tern desktop window, install or update the
   [Tern plugin and bridge](../server/tern-remote/README.md).
2. Add the target machine in Tern, if OMP runs elsewhere. Complete Tern's host
   verification and connection setup there.
3. Add the Tern bridge to the [Perch workspace gateway](WORKSPACE-SETUP.md),
   expose that gateway through HTTPS, and keep the Tern window open.
4. Pair the workspace once in Perch. Choose **Tern remote sessions**, then
   **Attach** beside the existing OMP pane.

The phone needs workspace access. Model credentials, SSH setup, and OMP tools
stay on the host. Tern's web distribution is not used by this adapter.

### A future Add remote host screen

The supplied Tern 0.6.0 SDK declares `cx.hosts:add(address)`, `list`, `trust`,
`switch`, and `disconnect`. `add` uses Tern's normal host lifecycle and can remain
pending during first-contact key verification. A native version must show the
actual connection state and fingerprint and send an explicit trust decision;
merely entering an address must not silently trust it. SSH bootstrap and a
phone-to-daemon transport are further work, not consequences of adding a form.
See [the host research](TERN-REMOTE-CONTROLS-RESEARCH.md).

## The native request experience

| Host request | Phone behavior |
| --- | --- |
| Supported OMP tool approval | Shows the complete safety prompt, including the host's proposed arguments, with its Approve and Deny choices |
| OMP plan review | Opens the plan as native Markdown with a Source view, then shows the host's current plan choices and execution strategy |
| Refine plan | Sends that actual choice; after the host closes review, write feedback in the normal composer |
| Supported single-choice selector | Shows the host's title, context, and enabled choices |
| Disabled choice | Remains visible and cannot be submitted |
| Oversized, clipped, or unsupported dialog | Shows a host-action notice and disables native answering |
| General OMP extension editor/input, section annotations, or custom widgets | Remains a host action in this OMP version |

The native sheet never preselects an approval. Selecting an option and pressing
**Send answer** are separate actions. A replacement request or content revision
resets the local selection. Read-only, offline, pending-answer, and unsupported
states disable response controls. Closing the sheet leaves the host request
pending.

The plan's Source tab shows the Markdown sections supplied by OMP's displayed
TSP plan. OMP puts its title in separate dialog metadata and can normalize
section spacing. This preserves the displayed plan content, not the exact bytes
of a plan file on disk. The original file needs a separate file/artifact route.

OMP's stock tool approval runs through its owner selector. Plan review is owned
by `InteractiveMode` and has its own TSP overlay. The public OMP extension emits
approval observations but does not expose an owner resolver for these flows.
Therefore this feature belongs to the Tern adapter; it does not expand the
Collab guest policy or claim that the standalone OMP extension can approve
actions. See [the OMP source research](OMP-OWNER-REQUESTS-RESEARCH.md).

## Protocol and ownership

The existing `perch-remote` version 1 envelope gains optional fields. Older
adapters without them remain valid and advertise no question capability.

| Field | Purpose |
| --- | --- |
| `capabilities.questions` | The adapter supports native request responses |
| `pendingQuestion.id` | Identifies this mounted host request |
| `pendingQuestion.revision` | Changes when the displayed decision content changes |
| `kind`, `category`, `title`, `prompt` | Native presentation without inferring a tool permission from prose |
| `options` | Opaque host choices, labels, descriptions, and disabled state |
| `document` | Bounded plan content and its declared text/Markdown format |
| `actionable`, `notice` | Whether this exact projected request can be answered |

An `answer` command includes the usual operation ID, host epoch, generation,
and known conversation ID, plus `requestId`, `requestRevision`, and the selected
answer. The public gateway accepts those fields only. It does not accept raw
TSP node IDs, arbitrary UI events, terminal input, or commands to close a pane.
The shared schema reserves an editor form for adapters that have a supported
atomic text response; that does not advertise such support for every Tern/OMP
editor.

The plugin keeps the surface, component, and event mapping private. Immediately
before dispatch, it reads Tern's current surface again, compares the request
identity and displayed content, checks the chosen option, and sends the mapped
TSP activation. A consumed request remains blocked across content revisions
until that mounted request disappears or is replaced. The bridge independently
reserves answers and rejects a second operation against an already pending,
forwarded, or uncertain request.

The phone adds the session and request identity to its sheet key. It retains
the response state until a fresh snapshot dismisses or replaces that request.
A forwarding receipt alone does not make the dialog disappear.

## Delivery and concurrency limits

A lost response triggers a receipt GET. Neither reconnect nor reattachment
automatically resends an answer. An unknown outcome remains visibly unconfirmed
and the same request stays locked on the phone. The bridge and plugin also guard
against another device submitting a new operation ID for a consumed request.
These are process-lifetime reservations, not a durable exactly-once guarantee.

`forwarded` means the plugin invoked Tern's event API. It is not proof that OMP
accepted the choice, completed a tool, or persisted a result. The host snapshot
is the source for whether the request remains open.

Tern's surface inspection and event dispatch happen in the same window callback.
However, the OMP TSP activation protocol has no expected-document-revision
precondition. A live OMP process can update a mounted plan before an event sent
from its window replica arrives. The implementation rejects stale state visible
to Tern and old component identities; it cannot claim an atomic comparison and
resolution inside OMP. An upstream owner request API with revision checking
would strengthen that boundary. [Tern session context][tern-session]
[OMP native event protocol][omp-wire]

## Verification seams

Tests extend the existing public boundaries: the native SessionStore against
HTTP, the authenticated workspace gateway, the Tern bridge's device/plugin
routes, and actual upstream OMP/Tern runtimes. They cover identity changes,
disabled and incomplete requests, receipt loss, read-only access, duplicate
submission, and host dismissal. The optional upstream verifier uses isolated
mock model responses and an inert tool; it does not call a paid provider.

The Android build and DOM checks are separate from a physical Pixel/GrapheneOS
trial. Neither a software-rendered Tern fixture nor a web export proves native
keyboard animation, Android process suspension, or a real external SSH route.
See [VERIFICATION.md](VERIFICATION.md) for measured results and remaining checks.

[tern-architecture]: https://docs.stencil.so/tern/concepts/architecture.html
[tern-session]: https://docs.stencil.so/tern/reference/api-window.html#pane-reads-and-trees
[omp-wire]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/packages/wire/src/tsp.ts
