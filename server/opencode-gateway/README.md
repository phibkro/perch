# Perch gateway for OpenCode

This small Node server connects Perch to an existing OpenCode headless server. It keeps the model/provider SDK and the agent loop on the host. It requires Node 22.19 or later and has no bun runtime dependencies.

OpenCode 1.18.35's `/provider` response can include configured provider keys and options. The gateway returns only connected provider IDs, display names, model IDs, and defaults. It also narrows commands, strips upstream error bodies, and projects event payloads to known text fields or change notifications. A separate phone credential authenticates every request. The phone requires a versioned gateway handshake before requesting the catalog; direct connections to raw OpenCode are rejected.

See [docs/OPENCODE.md](../../docs/OPENCODE.md) for setup, protocol, feature boundaries, and observed verification.

## Run

1. Copy `upstream.env.example` and `gateway.env.example` into **two private files outside this checkout**. Replace the upstream password in both files. Set a distinct gateway password with at least 24 characters in the gateway file.
2. Run OpenCode from the workspace you want the agent to use. Load only the upstream environment file into that process. Keep provider login/configuration on the host.
3. Run the gateway with the private gateway environment file:

```sh
node --env-file=/absolute/private/gateway.env server/opencode-gateway/index.mjs
```

The gateway listens on `127.0.0.1:4097` by default and connects to OpenCode on `127.0.0.1:4096`. Put an HTTPS reverse proxy or private HTTPS tunnel in front of the gateway for a remote phone. Preserve Authorization headers and incremental SSE responses. Configure `PERCH_OPENCODE_ORIGINS` only for browser clients you intend to allow.

In Perch, enter the gateway's HTTPS URL, username `perch`, and the gateway password. An optional directory chooses an OpenCode host workspace; otherwise the gateway resolves the upstream server's working directory. Provider API keys and subscription tokens do not belong in this form.

## Checks

```sh
bun run --cwd server/opencode-gateway test
bun install --cwd verification/opencode --frozen-lockfile
bun run --cwd verification/opencode test
bun run --cwd verification/opencode test:integration
```

The integration check launches the pinned actual OpenCode server and gateway with temporary directories and a loopback synthetic model. It requires no model account and does not contact a user's server.
