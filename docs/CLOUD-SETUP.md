# Set up a Cloudflare workspace

Run one guided setup on a computer or server, then paste its pairing code into
Perch. The phone receives one workspace URL and a generated access token. Account
administration and model credentials stay on the host and in Worker secrets.

This setup deploys **Pi Durable on Workers**, two SQLite Durable Object classes,
and one R2 bucket for artifacts. It uses the existing production Perch backend.
It does not install the OpenCode CLI, OMP, Tern, Codex, or a Linux sandbox.
For those host adapters, use the [workspace setup guide](WORKSPACE-SETUP.md).

Moving the provisioning step into Perch's mobile setup is a proposed next
iteration. [The Alchemy runtime design](ALCHEMY-RUNTIME.md) explains an
app-triggered Bun job on Cloudflare, deployment state, and the limits of running
the stock deployment engine inside a Worker. The commands below use the
implemented 0.6 setup runner.

## First setup

From the Perch checkout, with Node 22.19+ and Bun installed:

```sh
bun run setup:cloud
```

The runner installs missing pinned backend dependencies and uses
`bun x wrangler@4.148.0`; it adds no packages to the phone application.

1. Approve Cloudflare's device login if Wrangler is not already authenticated.
   You can open its verification URL and enter its device code on your phone.
2. Choose the account, Worker name, R2 bucket, and workspace name.
3. Choose a provider and one or more model IDs from the installed Pi catalog.
   Enter that provider's key at the hidden prompt. Add another provider if needed.
4. Review the account, named resources, endpoints, and models. Type the Worker
   name to apply; pressing Enter saves the plan and stops.
5. The runner creates the named bucket, deploys code and secrets together, then
   checks authenticated health, workspace discovery, and the SQLite catalog.
6. In Perch, open **Connect a workspace → Cloud**, paste the `perch://pair#…`
   code, and connect. When already connected, use **Switch workspace** instead.

The first configured model is the default for new sessions. Catalog entries
describe supported API formats; they do not verify your account's model access.
Setup makes no inference call. After pairing, send a small message and ask for
a Markdown artifact to check provider access and artifact storage on your account.

R2 must be activated on the selected account. Its Workers service must also have
a `workers.dev` subdomain; if absent, the runner asks you to enable one in the
Cloudflare dashboard before retrying. It does not change DNS or custom domains.

## Credentials to prepare

| Item | Where it is supplied | Required for |
|---|---|---|
| Cloudflare account grant | Existing Wrangler login, device login, or `CLOUDFLARE_API_TOKEN` from a protected host/CI environment | Creating/updating the Worker and R2 bucket |
| Account ID | Selected from Wrangler's accounts, or entered manually for a scoped token | Choosing the account that owns the resources |
| OpenCode Go API key | Hidden prompt, private key file, or protected environment variable | Go models selected for this workspace |
| Anthropic Console API key | Hidden prompt, private key file, or protected environment variable | Direct Anthropic Messages API |
| OpenAI platform API key | Hidden prompt, private key file, or protected environment variable | Direct OpenAI Responses API |
| Compatible endpoint API key | Same host mechanisms, or explicit `keyless: true` | A separately hosted HTTPS model service |
| Perch workspace token | Generated automatically and preserved on reruns | Phone access to this workspace |

Only selected providers need credentials. R2 is accessed by a Worker binding, so
this flow needs **no S3 access-key pair**. Durable Objects need no separate
password. An external celld deployment using S3-compatible persistence has its
own host credentials and is a different setup. See Cloudflare's
[R2 Worker binding guide](https://developers.cloudflare.com/r2/api/workers/workers-api-usage/).

### Cloudflare permissions

For a new Worker, Cloudflare's current authorization guide requires **Workers
Admin at product scope**. An existing Worker can use **Editor at that Worker
scope** for code and secrets. Its Durable Objects inherit the implementing
Worker's authorization. The R2 create operation accepts **Workers R2 Storage
Write**; the grant must also permit the runner's bucket and Worker-settings
preflight reads. A bucket-scoped object access key cannot create a bucket.

Use the current [Workers authorization guide](https://developers.cloudflare.com/workers/authorization/workers/),
[Durable Objects authorization guide](https://developers.cloudflare.com/workers/authorization/durable-objects/),
and [R2 create-bucket API](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/methods/create/)
when creating a scoped grant. Some API references still list the legacy Workers
Scripts Read/Write permission names. Account role assignment, OAuth grants, and
API-token scope must all permit the requested operation; this release has not
been exercised against a real account to qualify an exact minimal token recipe.

The runner does not require user-profile or account-list access when
`CLOUDFLARE_API_TOKEN` is supplied: enter the known account ID instead. It checks
the selected account's actual resources before mutations. It rejects global
API-key/email authentication in favor of OAuth or a scoped API token.

### Go, Anthropic, and ChatGPT subscriptions

**Go works through its documented third-party coding-agent API.** Its model
catalog chooses Completions, Messages, or Responses as appropriate. Perch sends
its own User-Agent and Pi's persisted provider-session ID through
`x-opencode-session`. Messages uses the base `https://opencode.ai/zen/go`, while
Completions and Responses use `https://opencode.ai/zen/go/v1`; the respective SDK
adds the final request path. See [OpenCode Go](https://opencode.ai/docs/go/).

**The Anthropic option uses an API key.** Claude Pro/Max OAuth credentials are
not interchangeable with API keys in a third-party application. This runner
does not import them. Hosting unmodified Claude Code with its own supported user
login is a separate harness integration, covered by Anthropic's
[credential-use rules](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use).

**Codex/ChatGPT login remains host-owned.** OpenCode and Codex have their own
documented sign-in flows, but deploying Pi's API converters does not install
those flows, credential refresh, or a Codex adapter. This wizard therefore
offers the OpenAI API option and rejects subscription tokens in that slot.
OpenAI's newer [Sign in with ChatGPT for open-source apps](https://developers.openai.com/siwc/token-sharing-open-source/)
is a separate integration with OAuth and inference requirements; it is not
implemented by this release. See the [research note](WORKSPACE-SETUP-RESEARCH.md)
for the distinction and the remaining hosted-app eligibility questions.

## Plan without deploying

For automation or an offline review, create a private JSON file **outside the
checkout**. Set its file mode to `600`. Example structure:

```json
{
  "accountId": "REPLACE_WITH_32_HEXADECIMAL_CHARACTERS",
  "workerName": "perch-personal",
  "bucketName": "perch-personal-artifacts",
  "workspaceId": "personal",
  "workspaceName": "My cloud workspace",
  "models": [
    {
      "provider": "opencode-go",
      "id": "glm-5.3-flash",
      "name": "GLM 5.3 Flash",
      "api": "openai-completions",
      "baseUrl": "https://opencode.ai/zen/go/v1",
      "apiKeyEnv": "OPENCODE_API_KEY",
      "contextWindow": 32768,
      "maxTokens": 4096
    }
  ]
}
```

The example uses conservative host token limits; the interactive catalog uses
Pi's declared limits. Replace account and model settings for your deployment.
Model keys can use exactly one of `apiKeyEnv`, an absolute `apiKeyFile`, or a
literal `apiKey` in the private file. Key files also require mode `600`.
An explicitly public, compatible service may use `keyless: true` instead.

```sh
bun run setup:cloud --plan --config /private/perch-cloud.json
```

`--plan` validates, generates the private workspace token, saves resumable
configuration, and prints a redacted review. It does not authenticate with
Cloudflare, provision resources, or contact a model provider. Missing local
backend dependencies may still be downloaded through Bun. For a plan with no
provider credential at all, use a custom HTTPS model descriptor with explicit
`keyless: true`.

Apply that saved plan interactively:

```sh
bun run setup:cloud
```

For automation, supply the existing Cloudflare grant through the protected
environment and explicitly pass `--apply`:

```sh
bun run setup:cloud --apply --config /private/perch-cloud.json
```

No key is accepted in a CLI argument. A noninteractive invocation without
`--apply` saves the review and stops. A terminal invocation also asks you to
type the Worker name, even when `--apply` is present.

| Flag | Effect |
|---|---|
| `--state-dir /private/another-workspace` | Keep a separate workspace's identity and credentials |
| `--config /private/config.json` | Load/update the selected model configuration; preserve the existing workspace token |
| `--wrangler /absolute/path/to/wrangler` | Use an already installed Wrangler 4.148.0 executable |
| `--reuse-bucket` | Explicitly adopt the named existing bucket after reviewing its use |
| `--help` | Print options without installing packages or accessing credentials |

## Reruns and recovery

The default directory is `~/.config/perch/cloudflare`, mode `700`. Its private
files are mode `600`: `state.json`, `secrets.json`, `wrangler.json`, and, after a
verified deployment, `pairing.txt`. Keep a protected backup of this directory.
It contains provider keys and the workspace access token in plaintext at rest
on your host; file permissions protect it, not application-level encryption.

Reruns preserve the generated token, installation ID, and resource names. The
runner checks a Worker ownership marker before updating it and refuses an
unrelated existing Worker. An existing bucket requires previous successful
creation recorded in the state or explicit `--reuse-bucket`. Changing account,
Worker, bucket, or workspace ID requires a separate state directory.

If creation succeeded but its response was lost, inspect the named bucket in
Cloudflare, then rerun with `--reuse-bucket` if it is the intended bucket. If
deployment or health verification fails, the runner retains the resumable state
and reports the failure. It issues a new pairing code only after verification.
It does not roll back or delete resources on failure.

The local lock prevents concurrent runs using one state directory. If a process
was terminated and left `setup.lock`, first verify that no setup is running,
then remove that lock. Use one operator/process for a given workspace; the
ownership marker is not a distributed provisioning lock.

Wrangler receives model and workspace credentials through a private
`--secrets-file` and deploys them with the code in one upload. Child-command logs
and telemetry are disabled. Account-token output is captured only in memory;
it is never copied into Perch state or printed. Cloudflare error bodies are
redacted because services can repeat input values in diagnostics. See
[Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
and [Wrangler device login](https://developers.cloudflare.com/workers/wrangler/commands/general/#login).

## Verification for this release

Observed locally on 2026-10-07:

- 29 backend tests pass, including all three real Pi API streaming converters,
  mixed Go API roots, session-header continuity, discovery, private-file rules,
  provisioning ordering, ownership/adoption checks, and explicit failure paths.
- The CLI's help and `--plan` execute with no Cloudflare authentication or
  provider key. The plan regression removes all executable search paths to
  prove that it does not invoke Wrangler when dependencies are already present.
- The production Worker builds. Actual Wrangler 4.148.0 accepts the generated
  config and atomic secret upload under `deploy --dry-run`; upload size is
  2,533.40 KiB, 453.31 KiB gzipped.

No real account was provisioned and no real model credential was supplied in
this work. Exact account permissions, provider entitlement, real R2 artifact
I/O, and recovery on Cloudflare still need a deployment on the owner's account.
The existing [durable-runtime evidence](DURABLE-BACKEND-RESULTS.md) covers the
separate environments described there and is not a Cloudflare deployment claim.
