# Set up Perch once per workspace

Perch 0.6 adds two setup choices: **Self-hosted** and **Cloud**. Cloud uses your
Cloudflare account. Both finish with one pairing code. Once paired, the phone
discovers the workspace's available harnesses and lets you switch between them
in **Connection & settings**, without entering their credentials again.

The host owns model access, agent processes, files, and chat history. Perch owns
the native conversation and artifact readers. One connection does not move a
conversation from one harness into another.

## On the phone

1. Open **Connect a workspace**.
2. Choose **Self-hosted** or **Cloud** to see the appropriate setup instructions.
3. Paste the `perch://pair#…` code from the completed host setup and select
   **Join workspace**. An existing code can be pasted immediately; its host
   identifies the deployment automatically.
4. Open **Connection & settings** to choose another advertised assistant. Use
   the chat's model picker for models configured on that assistant's host.

The installed Android/iOS app saves up to eight workspace connections through
Expo SecureStore. Reopen one from **Saved workspaces** after restarting. Opening
the app or the setup screen alone does not contact a saved host. The browser
preview keeps these records only for its current visit. [SecureStore][securestore]

**Forget** removes the connection from this device and leaves its host data in
place. Provider keys and infrastructure credentials are never part of the
pairing code. Drafts and unresolved submission identities remain memory-only;
saving a workspace does not make a pending prompt persistent or replay it.

If an older host has no workspace endpoint, **Advanced connection** retains the
existing Pi Durable, OMP Collab, Pi bridge, and OpenCode gateway forms. Those
direct connections retain their previous memory-only credential behavior.

## Self-hosted

Run the setup on the computer or server where the agents live:

```sh
git clone https://github.com/phibkro/perch.git
cd perch
bun install --frozen-lockfile
bun run setup:host
```

Use Bun **1.4.2** and a supported Node runtime; Node **24** is used by the release
workflow. If the repository is already present, update that checkout instead of
cloning another copy.

The workspace setup prepares a private host configuration and checks the local
adapters you select. It then produces the one phone pairing code. The gateway
uses a separate workspace token and keeps each adapter's upstream credentials
on the host. See [the host gateway guide](../server/workspace/README.md) for
its configuration, start command, and verification modes.

### Existing host adapters

The first version of this setup connects already-configured local adapters.
Installing a harness, authorizing its providers, arranging HTTPS, and supervising
its processes remain host tasks. The gateway does not silently install software
or sign in to a provider for you.

| Assistant | Prepare on the host | What Perch can use |
| --- | --- | --- |
| Pi Durable | [Durable backend](DURABLE-BACKEND.md), with its model configuration and persistence bindings | Durable chats, model choice, protected artifact files |
| Pi | [Pi RPC bridge](../server/pi-bridge/README.md), with the selected Pi profile | The bridge's existing agent session, models, and supported questions |
| OpenCode | [OpenCode and the Perch OpenCode gateway](OPENCODE.md) | Host history, new chats, configured models, supported approvals |
| OMP | An active OMP `/collab` invitation | The shared terminal session, including one inside Tern |

Run the workspace gateway behind your HTTPS endpoint. The local upstreams use
literal loopback addresses; a phone never receives their private tokens or
model endpoints. A physical phone's `localhost` is the phone itself, so its
pairing code needs the host's reachable HTTPS address. HTTP is accepted only
for loopback development.

OMP invitations are a separate capability. A phone receives the selected
invitation through authenticated discovery and connects using OMP's encrypted
Collab protocol. Revoking the workspace token prevents later discovery; stopping
an already-shared OMP invitation requires stopping or rotating that OMP share.

## Cloud: Cloudflare

From the same checkout, run:

```sh
bun run setup:cloud
```

The runner is designed to collect configuration on your computer, show the
resource plan, and require an explicit apply action before provisioning. It
uses Cloudflare's own login or an account-scoped token. A headless computer can
use Wrangler's device login and let you approve the displayed code in the
browser on your phone. [Wrangler login][wrangler-login]

The cloud workspace uses these resources:

| Resource | Responsibility |
| --- | --- |
| Worker | Authenticated workspace discovery, chat API, and protected file downloads |
| SQLite Durable Objects | Workspace catalog and Pi Durable conversation state |
| R2 bucket | Immutable generated artifact bytes |
| Worker secrets | Workspace access token and selected model-provider credentials |

R2 and Durable Objects are accessed through Worker bindings. This path needs
neither an R2 S3 access-key pair nor a Durable Object password. An external
self-hosted process that uses R2 through its S3 API is a different setup.
[R2 bindings][r2-bindings] [Durable Object authorization][do-permissions]

### Credentials to prepare

| Choice | Needed input | Destination |
| --- | --- | --- |
| Cloudflare | Account selection and Wrangler OAuth **or** an account-scoped API token | Local setup runner |
| OpenCode Go | Your Go API key and the model you want to use | Worker secret / host provider configuration |
| Anthropic | Your Anthropic **API key** and model | Worker secret / host provider configuration |
| OpenAI API | Your OpenAI Platform **API key** and model | Worker secret / host provider configuration |
| Compatible endpoint | Its reachable API URL, model, and key, or explicit keyless access | Host provider configuration |
| Perch | Nothing to invent: setup generates a workspace token | Host and paired device |

Only configure the providers you want. The durable backend supports the
OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages API families.
The OpenCode Go configuration preserves its Go endpoint, identifies Perch as a
coding-agent client, and supplies a stable conversation header. Actual access
still depends on the selected model, key, and account entitlement.
[OpenCode Go][opencode-go]

For an API-token deployment, creating a new Worker requires **Admin at the
Workers product scope**; subsequent deployments can use **Editor for that
Worker**. Creating its R2 bucket separately requires
`Workers R2 Storage Write`. A `workers.dev` endpoint avoids custom-domain and
DNS setup. Durable Objects inherit their implementing Worker's authorization.
[Worker permissions][workers-permissions] [R2 create API][r2-create]
[Durable Object authorization][do-permissions]

The runner must verify the deployed authenticated endpoint before printing a
successful pairing result. Its local plan and protocol tests do not establish
that a real Cloudflare account has been deployed, that a provider key works, or
that remote R2 persistence has been qualified. Those results require the actual
account and deployment. See [the Cloudflare setup guide](CLOUD-SETUP.md) for the
private configuration format, required permissions, offline plan, and resumable
apply commands. [Cloud setup research](WORKSPACE-SETUP-RESEARCH.md) records the
provider and platform decisions.

### Subscription sign-ins

Subscription access cannot be represented by one universal API key field.

- **OpenCode Go** supplies a subscription API key and explicitly supports other
  compatible coding agents. Use that key through the Go configuration.
  [OpenCode Go][opencode-go]
- **Claude subscriptions** belong to Claude Code's own supported login.
  Anthropic permits users to sign in to an unmodified Claude Code binary hosted
  by another platform, but prohibits other applications from collecting or
  routing Claude subscription OAuth credentials. Perch's Anthropic provider
  input therefore means an API key. A hosted Claude Code harness is a separate
  future integration. [Anthropic authentication][anthropic-auth]
- **Codex with ChatGPT** has a documented host-owned device login. A client can
  present its verification URL and user code while Codex retains the tokens.
  That needs a full host harness, rather than pasting a Codex token into the
  durable backend's API-key field. This release does not implement that login
  UI or a Codex app-server adapter. [Codex app-server][codex-server]

OpenAI also documents a newer Sign in with ChatGPT integration for eligible
open-source/self-hosted applications. Its grant, runtime, refresh, and deployment
conditions need their own implementation. It is not enabled merely by supporting
the Responses API. [Sign in with ChatGPT][siwc]

Full Pi CLI, OMP, OpenCode, or Codex processes require an ordinary process host
or a cloud Linux runtime. The initial Cloudflare runner deploys Perch's Pi
Durable Worker backend; it does not provision those additional harnesses or
make their files durable automatically.

## Deeper OMP and Tern integration

OMP's current Bun SDK and RPC interfaces offer session creation/history,
branching, model selection, structured UI requests, provider-login callbacks,
and more subagent controls. A host adapter can bring those into the same
workspace contract. Collab remains the implemented route for attaching to an
already-running OMP terminal; creating a new SDK/RPC process does not attach to
that terminal. [OMP SDK][omp-sdk] [OMP RPC][omp-rpc]

Tern already documents a remote-client model on iOS: shells and host plugins run
on attached hosts. Its reviewed platform matrix does not list Android, and its
public TSP SDK does not provide a drop-in Android renderer. The missing beta
`tern web serve` distribution remains an upstream packaging/access issue.
See [the detailed OMP/Tern integration note](HARNESS-INTEGRATION-RESEARCH.md)
for the verified capabilities and proposed next adapter.

## What was checked

The app includes bounded, authenticated workspace discovery; same-origin
connector paths; private secure-store records; saved-profile reopening; and
credential removal. Tests exercise all four connector routes, rejected path
escapes, interrupted secure-store writes/removals, stale discovery responses,
and model/credential separation. A rendered Expo export additionally exercises
the two setup choices, Advanced fallback, real client adapters against synthetic
host responses, artifact reads, saved reopening, and Forget.

The keyboard fix is measured against the installed React Native component and
has a physical-device test flow. Neither that layout seam nor DOM emulation is
a Pixel keyboard-animation test. See [the keyboard regression
record](KEYBOARD-REGRESSION.md) and [verification notes](VERIFICATION.md).

[securestore]: https://docs.expo.dev/versions/latest/sdk/securestore/
[wrangler-login]: https://developers.cloudflare.com/workers/wrangler/commands/general/#login
[r2-bindings]: https://developers.cloudflare.com/r2/api/workers/workers-api-usage/
[workers-permissions]: https://developers.cloudflare.com/workers/authorization/workers/
[do-permissions]: https://developers.cloudflare.com/workers/authorization/durable-objects/
[r2-create]: https://developers.cloudflare.com/api/resources/r2/subresources/buckets/methods/create/
[opencode-go]: https://opencode.ai/docs/go/
[anthropic-auth]: https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use
[codex-server]: https://developers.openai.com/codex/app-server/
[siwc]: https://developers.openai.com/siwc/token-sharing-open-source
[omp-sdk]: https://omp.sh/docs/sdk
[omp-rpc]: https://omp.sh/docs/rpc
