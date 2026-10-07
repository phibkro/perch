# Perch workspace gateway

Pair a phone once with a self-hosted workspace, then select its configured Pi,
Pi Durable, OpenCode, or existing OMP connection in Perch. The workspace gateway
holds each local adapter's credential and gives the phone a separate workspace
token. Provider credentials remain in the existing harness configuration.

This package runs with **Bun 1.4.2**, has no additional dependencies, and imports
Perch's shared protocol validators. Run it from a complete Perch checkout.
The phone workflow is in [Workspace setup](../../docs/WORKSPACE-SETUP.md).

## Prepare the host

Start the adapters you want to use on this machine:

| Connection | Existing service to prepare | Credential used by this gateway |
| --- | --- | --- |
| Pi | [Perch Pi bridge](../pi-bridge/README.md), usually `ws://127.0.0.1:8787/session` | Bridge token |
| Pi Durable | [Durable backend](../pi-durable/README.md), with its persistence and model configuration | Backend bearer token |
| OpenCode | [Perch OpenCode gateway](../opencode-gateway/README.md), usually `http://127.0.0.1:4097`, in front of OpenCode | Gateway username/password |
| OMP | An active OMP Collab share, created in the terminal session to attach | Full or view-only invitation |

The workspace gateway requires literal `127.0.0.1` or `[::1]` upstream addresses.
Use the Perch bridges shown above: a raw Pi JSONL process or a raw OpenCode server
does not implement those bridge handshakes. OMP sharing is a separate direct
connection whose invitation is delivered through authenticated discovery.

Provide a reachable HTTPS address that forwards to the gateway's default
listener, **`127.0.0.1:4780`**. Your reverse proxy must preserve the URL path and
support WebSocket upgrades and unbuffered SSE responses. A public base such as
`https://perch.example.com` or `https://example.com/perch` is supported. The latter
expects `/perch/perch/workspace` and `/perch/harness/...` to reach the gateway
without stripping the `/perch` prefix.

The current setup connects existing services. Harness installation, provider
login, HTTPS provisioning, and service supervision are host prerequisites.

## Run setup once

From the Perch checkout:

```sh
bun run setup:host
```

The interactive runner asks for a workspace name, its reachable HTTPS address,
the existing adapters to include, and their local connection details. Adapter
tokens, OpenCode passwords, and OMP invitations use hidden terminal input.

It then:

1. Validates all configuration and checks the local adapters without a model
   request. Pi must return an authenticated snapshot; HTTP adapters must pass
   their specific health handshake. OMP's invitation is checked locally for
   valid format; the phone verifies live sharing when it joins.
2. Saves a new random workspace token and the configuration to
   `~/.config/perch/workspace.json`, with owner-only permissions on POSIX.
   It refuses to overwrite an existing configuration or save credentials inside
   the Perch checkout.
3. Starts the gateway in the foreground and prints one
   `perch://pair#...` code. On the phone, choose **Self-hosted**, paste the code,
   and join the workspace.

An existing configuration is reused on later runs, including its workspace
identity and token. If any local check fails, no pairing code is issued and a
new partial configuration is not saved. If the listener cannot start, no
successful pairing result is printed.

The pairing code contains the workspace URL and access token in its fragment.
Treat it as an access credential. This release supports pasting the code into
Perch; the runner does not generate a QR image or install operating-system link
handling.

The checks above test local services. Joining from the phone is what verifies
the HTTPS endpoint and network path. A physical phone's `localhost` refers to
that phone. Loopback HTTP is supported only for local development.

### Commands

| Command | Effect |
| --- | --- |
| `bun run setup:host` | Create or reuse the default configuration, check local adapters, start the gateway, and print pairing |
| `bun run setup:host --config /private/workspace.json` | Use a different private configuration path |
| `bun run setup:host --config /private/workspace.json --from /private/setup.json` | Create a new workspace from a private setup input, then check and start it |
| `bun run setup:host --check` | Check the existing configuration and local adapters; exit without changing credentials or printing pairing |
| `bun run setup:host --pair` | Check the existing local adapters and print the existing pairing code; leave gateway startup to your service manager |
| `bun run workspace:serve --config /private/workspace.json` | Run an existing configuration without printing its pairing credential |

`--check` and `--pair` require an existing configuration. `--from` cannot be
combined with either. There are no flags for secret values.

For unattended startup, run `workspace:serve` under your existing service
manager, with an absolute Bun path and the Perch checkout as the working
directory. Its logs contain the listener address, not the pairing code. Keep
the upstream adapters supervised separately. Stopping the gateway closes its
guest connections; it does not stop an independently running harness process.

## Private setup file

Use this alternative when an interactive terminal is unavailable or a workspace
needs several connections of the same kind. Create the file outside the checkout
with owner-only permissions before adding secrets. For example:

```json
{
  "name": "Home workspace",
  "publicUrl": "https://perch.example.com",
  "listen": { "hostname": "127.0.0.1", "port": 4780 },
  "allowedOrigins": [],
  "defaultConnectionId": "pi",
  "connections": [
    {
      "id": "pi",
      "name": "Pi in my project",
      "kind": "pi",
      "upstream": {
        "url": "ws://127.0.0.1:8787/session",
        "token": "REPLACE_WITH_EXISTING_BRIDGE_TOKEN"
      }
    },
    {
      "id": "opencode",
      "name": "OpenCode",
      "kind": "opencode",
      "upstream": {
        "url": "http://127.0.0.1:4097",
        "username": "perch",
        "password": "REPLACE_WITH_EXISTING_GATEWAY_PASSWORD"
      }
    }
  ]
}
```

The setup input accepts `name`, `publicUrl`, and `connections`; optional fields
are `workspaceId`, `defaultConnectionId`, `listen`, and `allowedOrigins`. The
output configuration additionally contains protocol version, deployment type,
and the generated workspace token. Do not paste provider API keys into these
adapter credential fields.

Use a `durable` connection with `upstream: {"url":"http://127.0.0.1:8788",
"token":"YOUR_EXISTING_BACKEND_TOKEN"}` for a backend on that address. An OMP
entry uses `{"id":"omp","name":"My OMP terminal","kind":"omp",
"collabLink":"YOUR_EXISTING_INVITATION"}` instead of `upstream`.

To add or remove an adapter later, edit the `connections` array in the saved
private configuration, keep `defaultConnectionId` valid, run `--check`, and
restart the gateway. Reopen the saved workspace in Perch to refresh discovery.
The phone's pairing credential remains the same. Up to 16 connections can be
advertised; paths and names are validated by the same contract as the phone.

## Protocol and access boundary

`GET <base>/perch/workspace` requires `Authorization: Bearer <workspace-token>`.
The manifest contains workspace identity, a default connection, and relative
connector paths. It never includes local upstream URLs or adapter/provider
credentials. The deliberate exception is an OMP invitation, a separate secret
capability delivered only to an authenticated phone.

| Phone connection | Gateway behavior |
| --- | --- |
| Durable at `/harness/<id>` | Accept workspace bearer token; use the backend token on the configured loopback URL |
| Pi at `/harness/<id>` | Authenticate the first WebSocket `hello`; open the local bridge only after authentication; substitute the local bridge token |
| OpenCode at `/harness/<id>` | Accept Basic `perch:<workspace-token>`; use the gateway's own credentials and fixed host directory |
| OMP invitation | Advertise the invitation; the phone uses the existing encrypted Collab client |

HTTP routes are restricted to the existing adapters' chat, history, model,
question, receipt, and artifact operations. Client-supplied destinations are
not accepted. OpenCode directory overrides, redirects, unexpected browser
origins, and unsupported methods are rejected. Native requests can omit Origin;
web clients must match the public origin or an exact `allowedOrigins` entry.

Commands are bounded to 512 KiB, ordinary HTTP responses to 12 MiB, and durable
artifact bytes to 2,000,000 bytes. Artifact responses retain exact bytes and use
download headers, `nosniff`, and a restrictive CSP. The mobile artifact reader
continues to verify the immutable manifest's length and hash. SSE streams use
backpressure and cancel upstream when the phone disconnects. Pi uses the
existing bridge frame limits, command IDs, and acknowledgements.

The gateway never retries a submitted command. If a response is lost, the
existing driver retains its recovery behavior; Pi Durable can inspect operation
receipts. A workspace token grants access to all connections in its manifest.
For token rotation, replace it with a new random token in the private config,
restart the gateway, then pair devices again. An OMP invitation already received
by a device has its own lifetime: stop or rotate that OMP share separately.

The gateway centralizes setup and transport. Session persistence, background
agent execution, and stored artifacts still depend on the selected harness and
its backend. A deeper OMP SDK/RPC adapter and a Tern Android client are discussed
in [the integration research](../../docs/HARNESS-INTEGRATION-RESEARCH.md).

## Verification

```sh
cd server/workspace
bun test ./test
```

The suite uses real loopback HTTP and WebSocket servers, the existing OpenCode
gateway, a deterministic Durable backend fixture, and actual setup subprocesses.
It verifies credential replacement, discovery secrecy, directory restrictions,
bounded bodies, lost receipts without replay, exact artifact bytes, SSE
cancellation, WebSocket redirect refusal, and private configuration reuse.
Ambient HTTP proxy variables are exercised in a separate process so local
adapter credentials cannot be accidentally sent to a proxy.

These tests do not log in to a provider, call a model, deploy infrastructure, or
claim physical-device network verification.
