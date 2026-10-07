# Perch pi bridge

A self-hosted, authenticated WebSocket service around one real `pi --mode rpc` subprocess. The process continues working while phones disconnect. A reconnect receives a fresh normalized snapshot and does not replay commands. This bridge creates/owns its pi process; it does not attach to an independently running pi terminal.

The package pins **`@earendil-works/pi-coding-agent` 1.0.4**. The old `@mariozechner/pi-coding-agent` package is deprecated. The RPC and provider contracts were checked against the installed package and current official sources:

- [RPC mode](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md)
- [Commands](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc-commands.md)
- [JSON events](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/json.md)
- [Extension UI](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc-extension-ui.md)
- [Models and compatible endpoints](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md)

## Run

Use Node 22.19 or newer, then from this directory:

```sh
bun install --frozen-lockfile
# Configure/login to pi on the server, if not already configured:
bun run pi

# Supply these through your process manager or a private environment file.
export PERCH_BRIDGE_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')"
export PI_CWD=/srv/projects/my-workspace
bun run start
```

The token is not logged. Transfer it to the phone's separate token field through your own private channel. It is not a model API key. The bridge uses the server's normal pi configuration and authentication; it does not force a provider, call a hosted gateway, or put provider keys in the app.

The listener defaults to `127.0.0.1:8787`. Put it behind your own trusted TLS reverse proxy and connect the phone to **`wss://your-host/session`**. Preserve the `/session` path, WebSocket upgrade, and external `Host` header. The bridge's authentication happens in its first WebSocket message, so proxy access logs do not contain the token. Plain `ws://` is accepted by the client only for `localhost`, `127.0.0.1` or `::1` development.

`GET /health` exposes only readiness/protocol status. React Native Android sends an HTTP(S) Origin derived from the WebSocket URL. The bridge accepts absent Origin or an HTTP(S) Origin whose normalized authority matches the request's Host. Other origins require an explicit allowlist, for example `PERCH_ALLOWED_ORIGINS=http://localhost:8081` for Expo web. If a reverse proxy rewrites Host, explicitly allow the external endpoint's origin, such as `https://your-host`. An allowed Origin is not authentication: the token is always required before a snapshot is sent.

| Variable | Meaning |
| --- | --- |
| `PERCH_BRIDGE_TOKEN` | Required random shared secret, at least 24 characters |
| `PI_CWD` | Agent workspace; defaults to the bridge's current working directory |
| `PI_ARGS_JSON` | JSON array of server-selected pi CLI arguments; the bridge adds `--mode rpc` |
| `PI_BIN` | Optional existing pi executable; default is this package's pinned CLI |
| `PERCH_BRIDGE_HOST` / `PERCH_BRIDGE_PORT` | Listener; defaults `127.0.0.1` / `8787` |
| `PERCH_ALLOWED_ORIGINS` | Additional exact allowed origins; same-authority HTTP(S) origins already work |
| `PI_CODING_AGENT_DIR` | Pi's own configuration directory override |

Normal pi session behavior applies. A phone disconnect does not stop the process. For the same session after a **bridge restart**, use pi's documented `--session-id <UUID>` or `--session <path>` in `PI_ARGS_JSON`; without a resume choice, a fresh process normally starts a new session. Configure project trust and enabled tools with pi's own flags/settings. This service intentionally does not override them. An authenticated client can prompt the configured agent and therefore use its enabled tools.

## OpenCode Go subscription

You can use your own OpenCode Go subscription through this bridge's existing Pi harness. Pi 1.0.4 includes the `opencode-go` provider; no additional adapter or `models.json` entry is needed. OpenCode's [Go documentation](https://opencode.ai/docs/go/#where-can-i-use-it) lists current Pi builds as validated clients. Go is intended for coding-agent traffic, so this configuration provides a coding subscription rather than an unrestricted general-chat entitlement.

The [example environment file](opencode-go.env.example) selects a model present in both the installed Pi catalog and OpenCode's [published Go catalog](https://opencode.ai/docs/go/#endpoints), checked on 2026-10-07:

| Setting | Value |
| --- | --- |
| Pi provider | `opencode-go` |
| Model | `glm-5.3-flash` |
| API format | `openai-completions` |
| Provider base URL | `https://opencode.ai/zen/go/v1` |
| Provider credential | `OPENCODE_API_KEY` on the server |

After `bun install --frozen-lockfile`, copy the example outside the checkout before adding credentials:

```sh
mkdir -p "$HOME/.config/perch"
install -m 600 opencode-go.env.example "$HOME/.config/perch/opencode-go.env"
```

Edit that private copy. Replace `OPENCODE_API_KEY` with the key from your [OpenCode account](https://opencode.ai/auth), `PERCH_BRIDGE_TOKEN` with a separate random token of at least 24 characters, and `PI_CWD` with an existing agent workspace. The token-generation command in [Run](#run) creates a suitable bridge token. The example's short token placeholder deliberately fails the bridge's startup check.

Start from this directory with the private file explicitly loaded:

```sh
node --env-file="$HOME/.config/perch/opencode-go.env" --import tsx server.ts
```

The bridge does not automatically load an `.env` file. A process manager can supply the same variables and run `bun run start` instead. The key stays on the server; the phone receives only the bridge URL and its separate token. Pi prefers an already stored provider credential over the environment key. If you use multiple accounts, select the intended Pi profile with `PI_CODING_AGENT_DIR` or update that profile's Go credential through Pi.

The pinned Pi packages supply their own `User-Agent`, stable `x-opencode-session`, and `x-opencode-client: pi` headers. No custom header override is needed. Keep the host's advertised model selection; this example establishes configuration compatibility, not model quality or subscription entitlement.

### Go and Zen use different billing paths

**Go** is the subscription provider, with model IDs under `opencode-go` and API paths under `/zen/go/v1`. **Zen** uses per-request credits, with Pi provider `opencode` and paths under `/zen/v1`. They share the `OPENCODE_API_KEY` environment-variable name, so keep `--provider opencode-go` when selecting Go. See [Go setup](https://opencode.ai/docs/go/#how-it-works) and [Zen setup](https://opencode.ai/docs/zen/#how-it-works).

Go's optional [Use balance setting](https://opencode.ai/docs/go/#usage-beyond-limits) can consume Zen credits after subscription limits. Configure that choice in the OpenCode console; Perch does not enable it or silently switch providers.

The example was checked without a model request: environment-file parsing, the installed provider/model metadata, API-key resolution, and Pi's session-header functions. Live subscription access and remote connectivity still require your account and host.

## Self-hosted models

Configure a compatible endpoint in the server's pi `models.json` (normally `~/.pi/agent/models.json`), for example an unauthenticated local Ollama endpoint:

```json
{
  "providers": {
    "local": {
      "baseUrl": "http://127.0.0.1:11434/v1",
      "api": "openai-completions",
      "apiKey": "local",
      "models": [{ "id": "your-installed-model-id" }]
    }
  }
}
```

`local` is a public dummy key for an endpoint that ignores authentication, not a credential. For an authenticated endpoint, use pi's documented environment-variable interpolation for its actual API key. Select the model in pi, or set `PI_ARGS_JSON='["--provider","local","--model","your-installed-model-id"]'`. The phone can then choose among models returned by the host. Reliable coding/tool workflows still depend on the selected model's tool-calling support; accepting an OpenAI-compatible URL alone does not establish that capability.

## Protocol and behavior

`src/harness/protocol.ts` defines **Perch bridge protocol v1**. It is our normalized app protocol, not AG-UI, TSP, OMP Collab, or pi's RPC protocol. Client commands are a small allowlist: prompt, interrupt, answer, and select an already configured model. Clients cannot supply a process command, cwd, file path to read, provider URL, or API key through this interface.

- Authentication precedes snapshots. Token comparison uses constant-time fixed-length digests; tokens never enter the URL or snapshot.
- `message_start`/delta-only `message_update`/authoritative `message_end` become native transcript messages. Only `agent_settled` marks a run done; `agent_end` may be followed by retry/queued work.
- Tools remain unknown until an actual execution event/result establishes their outcome. Full `write` arguments can become preview artifacts, with their tool status retained separately.
- Choice, confirmation, text input and editor dialogs use exact request IDs. Custom terminal components are not portable. Pi has no UI-response acknowledgment; we clear a question after its response has been written successfully to stdin, not after a fabricated host acknowledgment.
- Interrupt clears queued messages before aborting, because pi's `abort` can otherwise leave queued work to continue.
- Prompt acknowledgments mean pi accepted/queued/handled the command. They do not mean the run succeeded. Provider errors and aborts remain events/messages.
- The server owns history while the phone is offline. Snapshots have a server epoch and monotonic revision. Rejoining hydrates current state. No action is automatically retried.
- RPC framing splits only on LF and drains stdout continuously; valid Unicode line/paragraph separators inside strings are preserved. Subprocess writes honor pipe backpressure.

This is an initial single-session service with one shared token, a maximum of 16 concurrent sockets, 16 commands/second per socket, and 6 MiB snapshot frames. It sends coalesced full snapshots rather than a scalable paginated event log. A larger snapshot is rejected explicitly; it is not silently truncated. There is no multiuser authorization, push notification service, background wake-up, attachment upload, session browser, arbitrary file preview, or terminal renderer. The server sees the pi session in plaintext; TLS protects the phone-to-server connection. OMP's separate end-to-end Collab encryption is unchanged.

## Verify without an external model

```sh
bun run typecheck
bun run test
```

The integration test launches the installed pi CLI with a temporary isolated config/workspace, an explicitly loaded test extension, and a synthetic **loopback OpenAI-compatible model**. The actual pi runtime performs a write tool call; its next response streams Markdown, HTML and TypeScript artifacts. The test also verifies token rejection, model selection, choice/editor responses, stale IDs, question reconnect, an active-run reconnect, interrupt, no prompt replay, and switching the public store back to demo. It removes its temporary files and closes the subprocess and both local servers.

This validates transport/runtime integration, not real-model output quality or a physical Android network path. It performs no request to a user's host or an external inference provider. `fixtures/questions.ts` is loaded only by this test, never by normal startup.
