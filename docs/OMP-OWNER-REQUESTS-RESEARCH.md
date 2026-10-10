# OMP owner requests from a phone

**Reviewed:** 10 October 2026. **Decision:** use Tern's targeted native surface
events to answer the request already open in OMP. The direct Perch OMP extension
continues to expose only its documented public controls.

## What is possible

OMP's TUI owns tool approvals and plan review. Both have structured TSP controls.
Perch can project those controls into a native phone sheet and send the selected
choice back to the same component in the same OMP process. This is separate from
the Collab guest connection and does not require changing the tool approval
policy. [Sources: native event router][backend], [tool approval wrapper][wrapper],
[plan review component][plan].

Current Collab documentation says full-control guests can answer shared selection
and editor requests. A missing approval in a particular relay/client combination
does not prove that every Collab build forbids all approvals. The inspected stock
tool approval uses a Collab-aware selector; the plan review overlay uses its own
owner interface. Perch's new path targets that existing owner surface directly.
[Source: Collab permissions and shared questions](https://omp.sh/docs/collab).

| Request | Existing OMP owner interface | Mobile response supported by this slice |
| --- | --- | --- |
| Tool approval | Native selector with Approve and Deny | Choose one advertised option |
| Plan review | Plan document and plan strategy choices | Choose one advertised plan action |
| Ordinary single-choice dialog | Native hook selector | Choose an advertised option |
| Rich extension editor | Hook editor with a nested field | Unsupported: this build sets `sendable: false` |
| Simple extension input | Hook input with a nested input | Unsupported: this build sets `sendable: false` |
| Plan section annotations | Stateful annotation editor and section controls | Separate work |
| Multiple questions or checkbox selection | Ask dialog with navigation and review | Separate work |

The two text-input limits were reproduced against the installed OMP 18.8.7
package. Sending an atomic TSP `send` to those fields did not resolve their
promises. An ordinary chat composer is a different component and supports atomic
send. [Sources: Input][input], [HookEditor][editor], [CustomEditor][composer].

## Why an extension observer is insufficient

The public extension API provides `tool_approval_requested` and
`tool_approval_resolved` events. The request event reports session ID, tool-call
ID, tool name, reason and approval mode. Its handler does not return the user's
decision and cannot resolve the stock dialog. `ctx.ui` lets an extension create
dialogs; it is not an advertised subscription or middleware API for all host
dialogs. [Sources: extension declarations][types], [extension authoring guide][extensions].

The tool wrapper applies the configured policy to the effective tool arguments,
emits the request event, and then awaits
`uiContext.select(safetyPrompt, ["Approve", "Deny"])`. Only the approved return
value allows execution. The prompt can include tool-specific details and pending
provider safety checks; the narrower observation event is not enough to
reconstruct that display. An extension should not manufacture a second approval
or replace the policy with an unconditional allow. [Sources: wrapper][wrapper],
[prompt formatting][approval].

Native plan review follows another path. `InteractiveMode.handlePlanApproval`
loads the plan, prepares execution strategies, and awaits `showPlanReview`.
That method owns a `PlanReviewOverlay` and its pending promise. Intercepting
`ctx.ui.select` would still miss this flow. [Source: InteractiveMode][interactive].

## The native targets

OMP's native reconciler allocates a distinct base ID for each component
instance. Descendants append their key path. A replacement dialog gets a new
base even if its title and options are identical. Perch should treat the complete
surface and node identifiers as opaque, and retain the Perch pane generation
around them. [Source: reconciler][reconcile].

| Surface | Target | Response |
| --- | --- | --- |
| Plain hook selector | Hoisted `picker`, for example `s.^picker` | `activate` with the picker item ID, such as `1` |
| Fallback hook selector | `list` under `omp.overlay.hook-select` | `activate` with the complete list item wire ID |
| Plan review | `list` with role `omp.plan.options` | `activate` with the complete plan item wire ID |

The caret in a hoisted picker ID is meaningful. A parser that accepts only
`s.picker` misses the actual `s.^picker` emitted by the tested runtime. Picker
items are data IDs; ordinary list items are nodes. OMP's router normalizes these
two representations before invoking the component's handler.
[Sources: native picker][picker], [router][backend].

The HookSelector picker has no special approval role. Its tested shape includes
`noun: "options"`, `layout: "rows"`, `preview: "none"`, a title, an optional
subtitle, items, and confirm/close actions. Perch must recognize a bounded
documented shape, rather than treat every TSP picker as a user question. In the
fallback representation, the root carries `omp.overlay.hook-select` and the
list's items retain their original numeric index keys. [Source: HookSelector][selector].

## Plan review preserves the host's meaning

The tested plan panel provides these choices:

- Approve and execute.
- Approve and compact context.
- Approve and keep context, with current context usage in the label.
- Refine plan.
- Save and quit.

The host decides which options are disabled. Its model strategy tabs can change
which model executes the approved plan. Even when the phone does not edit those
tabs, their selected value must be visible or included in the request's guarded
state. The phone should not invent its own meanings for the options.
[Sources: InteractiveMode][interactive], [PlanReviewOverlay][plan].

**Refine plan is not a text-input request.** With no existing annotations,
selecting it closes the review and asks the user to enter a follow-up prompt.
Perch can then show the ordinary composer after a fresh host snapshot confirms
that the dialog has gone. Feedback is a separate explicit prompt; it is not
silently appended to the choice response. [Source: InteractiveMode][interactive].

The native plan body is described as Markdown sections. Joining those sections
produces a useful review document, but does not prove byte-for-byte identity with
the plan file on disk. Label this as the host's displayed plan. Exact file export
needs a separate content-addressed file route. [Source: plan body description][plan].

## Request identity and acknowledgement

The Perch request contains a local request ID, revision, category, title, prompt,
advertised options and, for plans, a display document. The response contains the
request ID, displayed revision and option ID. The phone never supplies arbitrary
TSP node IDs or event objects. These are Perch design decisions, implemented at
the bridge and native adapter boundary.

Before dispatch, the Tern plugin reads the current surface again and compares
the request's component identity and complete displayed state. It rejects a
changed request, disabled choice, clipped preview, duplicate submission or
expired pane generation. It reserves the decision before calling
`cx.session:event`. Reconnect reads a forwarding receipt and does not resend.
[Implementation: requests mapper](../server/tern-remote/plugin/requests.luau),
[remote protocol](../src/harness/remote.ts).

This is **not an atomic upstream compare-and-resolve operation**. TSP `activate`
does not carry an expected document revision. A host action could change the
same overlay between the plugin's read and the OMP process consuming the event.
Distinct component IDs protect against replaced dialogs, and fresh comparison
rejects already observed changes, but neither proves that a plan cannot change
inside that final process boundary. An upstream request ID plus revision-aware
resolver would close that gap. [Sources: TSP event type][wire], [event router][backend].

A `forwarded` receipt means the native event was dispatched. Completion remains
host-owned. It does not prove tool success, durable plan persistence, or exactly
once external effects after a host crash.

## Verification

### Stock OMP renderer and owner callbacks

The optional verifier uses the installed OMP 18.8.7 SDK, stock InteractiveMode,
stock native renderer, stock selectors, real tool approval wrapper and upstream
in-memory mock model. The protocol terminal records actual TSP frames and applies
them with OMP's reference document. It does not emulate a Tern window.

```sh
cd server/omp-remote/upstream
bun install --frozen-lockfile --ignore-scripts --no-optional
cd ../../..
bun server/tern-remote/test/verify-omp-owner-requests.mjs
```

Observed checks:

- Deny resolves the existing native tool selector; the inert tool does not run.
- A second identical request has a new component ID. The old event cannot
  approve it. Its own Approve executes the inert tool once.
- The fallback selector accepts complete list/item IDs and rejects a disabled
  option.
- Refine resolves the real plan handler, closes the review, keeps plan mode
  enabled, and makes no additional provider call.
- The 103-character known plan file becomes an 87-character displayed body,
  because the title is moved to the sheet header and the body is sectioned.
  Exact expected body text and both SHA-256 values are recorded in the fixture.
- Both rich editor and simple input advertise `sendable: false` and ignore
  atomic send.

The run creates one AgentSession, makes four in-memory model calls and makes no
paid provider calls. It records both successful and unsupported interfaces in
[the generated fixtures](../server/tern-remote/test/fixtures/omp-owner-requests.json).
This fixture contains seven current checks, including both unsupported text-input
surfaces.

### Production bridge through actual Tern and OMP

The separate [actual-host verifier](../server/tern-remote/test/verify-tern-omp-owner.mjs)
passed through Tern 0.6.0 (`0e39682`), the production Perch Tern plugin and HTTP
bridge, and the installed OMP 18.8.7 process in Tern's real PTY. The child used
stock InteractiveMode, native TSP rendering, the real approval wrapper, and the
same upstream in-memory mock provider used by the isolated verification.

The HTTP flow denied the first tool request with zero executions, rejected an
answer to that stale request, and approved the next identical request with one
inert tool execution. It then selected Refine plan, waited for a fresh snapshot
with the ordinary composer available, and sent the explicit multiline feedback
`Phone feedback 🦜\nKeep the plan focused.`. The host received that text unchanged.
The reopened plan accepted Approve and keep context and continued the same
conversation. Duplicate command receipt lookups and reconnect reads did not
repeat the tool execution.

The run used one AgentSession and one OMP PID, made six in-memory model calls,
and made zero paid provider calls. This qualifies the complete host integration
path through the production HTTP boundary. It ran in a headless Tern test window;
physical Android interaction and restoration of a user's existing desktop window
remain separate checks. It also retains the TSP revision and forwarding limits
described above.

After installing the pinned OMP dependency as shown above, run the host verifier
with a locally available Tern binary:

```sh
TERN_BIN=/path/to/tern \
PERCH_OMP_OWNER_RESULT=/tmp/perch-tern-omp-owner-results.json \
bun server/tern-remote/test/verify-tern-omp-owner.mjs
```

The [fixture child](../server/tern-remote/test/omp-owner-child.mjs) keeps
`PI_TEST_RUNTIME=1` for model and session isolation. It uses the public
`setTerminalHeadless(false)` override and `PI_TUI_NATIVE=1` setting to enable real
terminal I/O and native support probing. Those are independent gates in OMP's
test runtime; both must be enabled before this fixture can qualify a real TSP
connection. The child waits for native rendering before it opens the first
approval.

## Version qualification

Runtime evidence is pinned by `server/omp-remote/upstream/bun.lock` and verifies
the installed package version before running. Source review also used upstream
commit `b07a1c146d0d12cfc855a2c65d52f892ef319040`. That checkout reports the same
version but contains later source edits, including an `inline` HookSelector
option absent from the installed package. The exercised runtime, generated
fixtures and lockfile take precedence over assuming that the matching version
string guarantees identical code.

[extensions]: https://omp.sh/docs/extension-authoring
[types]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/packages/coding-agent/src/extensibility/extensions/types.ts
[wrapper]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/packages/coding-agent/src/extensibility/extensions/wrapper.ts
[approval]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/packages/coding-agent/src/tools/approval.ts
[interactive]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/packages/coding-agent/src/modes/interactive-mode.ts
[plan]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/packages/tui/src/overlays/plan-review-overlay.ts
[selector]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/packages/tui/src/overlays/hook-selector.ts
[reconcile]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/packages/tui/src/native/reconcile.ts
[backend]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/packages/tui/src/native/backend.ts
[picker]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/packages/tui/src/native/picker.ts
[input]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/packages/tui/src/components/input.ts
[editor]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/packages/tui/src/overlays/hook-editor.ts
[composer]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/packages/tui/src/prompt/custom-editor.ts
[wire]: https://github.com/can1357/oh-my-pi/blob/b07a1c146d0d12cfc855a2c65d52f892ef319040/packages/wire/src/tsp.ts
