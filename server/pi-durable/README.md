# Perch durable backend

A protected HTTP backend using the actual PiHarness adapter, Pi Durable SQLite
storage, and Lifecycle alarms. One workspace catalog cell owns session identities;
one session cell owns each Pi conversation. The mobile app receives normalized
authoritative snapshots and authenticated artifact bytes.

## Run and configure

Requires Node 22.19 or later to build. Dependencies are pinned: Agents SDK 0.26.0,
Pi Durable/Pi AI/Chord 1.0.4. Install inside this directory; these packages do not
belong in the native app bundle.

For the guided Cloudflare path, run `bun run setup:cloud` from the repository
root. It selects the account, models, and credentials on the host, reviews the
plan, and provisions only after a typed confirmation. It then prints one private
workspace pairing code. `--plan --config /private/config.json` saves a plan
without Cloudflare authentication or provisioning; `--apply` enables explicit
noninteractive use. See [Cloud setup](../../docs/CLOUD-SETUP.md) for credential
requirements, private configuration, ownership checks, and recovery. The runner
uses pinned Wrangler 4.148.0 and performs no model inference itself.

Install the root app dependencies once as well: the unit regressions compile the
actual phone validator and artifact model, whose dependencies live at the root.
From the repository root:

```sh
bun install --frozen-lockfile
bun install --cwd server/pi-durable --frozen-lockfile
bun run --cwd server/pi-durable test
bun run --cwd server/pi-durable build
cd server/pi-durable
cp wrangler.example.jsonc wrangler.jsonc
cp .dev.vars.example .dev.vars
```

Edit the copied configuration before starting your Workers-compatible runtime.
With celld installed, use `bun run dev` (which supplies the local esbuild on PATH); its development
object store is a local simulation of bucket persistence. For an actual celld
fleet, configure its qualified S3/R2 backing store separately and choose
`CELLD_DURABILITY=bucket` when acknowledgment must include bucket durability.
The `ARTIFACTS` binding is a separate logical namespace. On celld it uses
`r2/<bucket_name>/` inside the same fleet bucket; on Cloudflare it binds the
configured R2 bucket alongside managed DO storage.

No deployment, provisioning, model call, or credential discovery happens during
build or unit tests. The production entry has no synthetic fallback.

| Server setting | Meaning |
|---|---|
| `PERCH_TOKENS` | Secret JSON object mapping workspace IDs to distinct random bearer tokens, at least 32 characters each |
| `PERCH_ALLOWED_ORIGINS` | JSON array of exact allowed browser origins; default `[]`. Native requests without Origin work. |
| `PERCH_MODELS` | Secret JSON array of explicitly configured model descriptors. The first is the new-session default. |
| `PERCH_WORKSPACE_NAME` | Safe display name for discovery, at most 120 characters; default `Perch workspace` |
| `PERCH_DEPLOYMENT` | `self-hosted` (default) or `cloudflare`; explicitly set by cloud setup |
| `PERCH_CATALOGS` | SQLite DO namespace bound to `PerchCatalog` |
| `PERCH_SESSIONS` | SQLite DO namespace bound to `PerchSession` |
| `ARTIFACTS` | R2-style bucket binding supporting conditional `put` and `get` |

A model descriptor has `provider`, `id`, `name`, `baseUrl`, `contextWindow`, and
`maxTokens`. Supply either `apiKey` or explicit `keyless: true`; `reasoning` is
optional. The optional `api` is `openai-completions` (the backward-compatible
default), `openai-responses`, or `anthropic-messages`. Models under the same
provider share credentials but retain their own API-family endpoint roots.
This version uses Pi's actual lazy implementations for those three APIs.
Provider IDs are host-defined. Only
`provider`, `id`, and `name` leave the server. Cost tracking is not exposed; the
adapter's zero cost metadata does not claim a service is free.

The cloud wizard can select OpenCode Go, Anthropic API, OpenAI API, and a custom
compatible HTTPS endpoint. Its catalog helper is setup-only and does not enter
the Worker bundle. For `opencode-go`, requests include Perch's User-Agent and
Pi's durable provider-session ID in `x-opencode-session`, preserving conversation
identity through eviction and changing it when Pi forks. Go's Anthropic root is
`https://opencode.ai/zen/go`; its Completions/Responses root ends in `/v1`.
The SDK supplies the remaining path. OAuth login, consumer subscription-token
import, and credential refresh are not installed by these API descriptors.
Known Claude OAuth tokens and non-API tokens for direct OpenAI are rejected.

Keep token and model settings in the runtime's secret mechanism. With Cloudflare,
use secret bindings; do not add secrets to the checked-in `vars` object. With
celld, supply them through its supported secret/config injection. The sample
`.dev.vars` is for development and is ignored by Git. The mobile client accepts
HTTP only for loopback development. Remote hosts, including private-LAN homelab
addresses, require HTTPS; expose the API through TLS ingress before connecting
from the phone. The backend-to-model connection is configured separately.

## HTTP API

All paths start with `/perch` and require `Authorization: Bearer TOKEN`, except
bounded CORS preflight. Use `Content-Type: application/json` for POST bodies.
Workspace identity is derived from the verified token. There is no caller-owned
workspace parameter. The exact shared types are in `src/harness/durable.ts` at
the repository root.

| Method/path | Input or result |
|---|---|
| `GET /workspace` | Authenticated `perch-workspace` discovery: workspace identity/name/deployment and one `durable` connection |
| `GET /health` | Service/protocol version, safe models, explicit synthetic flag |
| `GET /sessions` | `{sessions}` |
| `POST /sessions` | `{operationId,title?}` → `{session,accepted}` |
| `GET /sessions/:id` | Authoritative `DurableSnapshot` |
| `POST /sessions/:id/submit` | `{operationId,text}` → durable receipt |
| `GET /sessions/:id/operations/:operationId` | Operation status or 404 |
| `POST /sessions/:id/abort` | `{operationId?}`; omitted ID stops the whole session |
| `POST /sessions/:id/model` | `{provider,modelId}`; configured choices, idle session only |
| `GET /sessions/:id/artifacts/:id` | Exact authenticated bytes with attachment/nosniff headers |

Creation and submissions must use stable operation IDs. Reusing a key with a
different title/prompt returns 409. Retrying an already admitted submission
returns the same identity with `accepted:false`. Submissions are reserved in a
Pi app document before admission; reopening reconciles an interrupted reservation
using that same ID. Status comes from Pi's own persisted admission record.

Limits: 100,000 prompt characters; 500,000 request bytes; 2,000 sessions per
workspace; 2,000 submissions and 1,000 artifacts per session; 2,000,000 UTF-8
bytes per artifact. IDs use `[A-Za-z0-9][A-Za-z0-9_-]{0,127}`. Capacity limits
return explicit errors. This slice has no retention/deletion or compaction UI.

Snapshots include committed in-progress text, tool states, model choice, and
stored artifact manifests. Polling and reconnects replace the projected view;
they do not send new user input. Catalog status is a cached summary updated on
admission and completion; the selected session snapshot is authoritative.

## Artifact persistence

`write_artifact` accepts a complete `kind` (`markdown`, `html`, `code`), safe
`filename`, `title`, `content`, and optional `language`. It durably memoizes its ID
and creation time, uploads under a workspace/session/SHA-256 key, then commits
the manifest through Pi's own document transaction. Existing objects are never
overwritten; an identical retry verifies their bytes. A crash can leave an
unreferenced blob, but cannot produce a successful manifest before upload.

Downloads verify size and SHA-256 before responding and force an attachment with
`application/octet-stream`, `nosniff`, and a restrictive CSP. HTML is opened only
by the app's existing isolated renderer. No arbitrary filesystem path, remote
download URL, or provider credential enters the artifact API. No shell/browser
execution is installed by this backend.

## Test entry points

`src/backend.mjs` exports `createBackend({createRuntime,synthetic,...hooks})`.
`createRuntime(env, session?)` synchronously returns:

```js
{ models, defaultModel: { provider, id }, safeModels: [{ provider, id, name }],
  registry, settings }
```

The optional registry is augmented with the production artifact tool. Calls for
health/configuration have no session argument. A provider closure in an actual
cell can read `session.metadata`, `session.bootId`, and `session.activatedBy`.
Export the returned `PerchCatalog`, `PerchSession`, and `fetch` from a separate
test worker. Compile it with `node build.mjs path/to/test-worker.mjs dist/test.mjs`.

Test hooks are awaited: `onSessionStart(session)` observes completed startup;
`onArtifactStored(session,manifest)` runs after durable object bytes and before
the manifest commit; `onArtifactCommitted(session,manifest)` runs after that
commit. A test can stop or hold these points without altering production auth,
PiHarness, SQLite, artifact tools, or the external HTTP contract.

`bun run test` covers auth/CORS, limits, provider configuration and all three
actual API converters with controlled streaming responses, Go session identity,
workspace discovery, provisioning failure paths, private setup files, snapshot
projection, and immutable artifact retries. No real credential is needed.
Runtime recovery evidence belongs in
the repository's verification directory; these unit tests do not prove R2 or
multi-node behavior.

## Primary implementation references

- [PiHarness storage and alarm integration](https://developers.cloudflare.com/agents/harnesses/pi/)
- [Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable)
- [Pi AI custom providers](https://github.com/earendil-works/pi/tree/main/packages/ai)
- [celld storage and ownership guarantees](https://celld.dev/docs)
- [celld DO-compatible APIs](https://celld.dev/docs)

## Phone projection limits

The projector reads one published Pi ConversationView, preserving the identity
of a live assistant message when it becomes a committed entry. Tool labels are
bounded display values; actual tool task IDs identify stored artifact sources.
Each display text field is limited to 2,000,000 characters, and a snapshot is
limited to 10 MiB of encoded JSON, including UTF-8 and escapes. Newest conversation
text takes priority over tool output. Truncated text and omitted older rows carry
explicit notices; the host transcript and complete artifact manifests are retained.
The phone currently has no older-history pagination. Admission limits are 2,000
sessions per workspace, 2,000 submit operation IDs per session, and 1,000 artifacts
per session.

The connected recovery and production provider checks are documented in
[the runtime verification guide](../../verification/durable-runtime/README.md)
and [the measured results](../../docs/DURABLE-BACKEND-RESULTS.md).
