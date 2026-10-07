# Durable backend slice

Accepted scope, 7 October 2026: implement a protected PiHarness backend, connect
native Perch chat/history, and open persisted artifact references through the
existing Markdown, code, and isolated HTML readers. Keep existing adapters.

## HTTP contract

All routes are under `/perch`. All require `Authorization: Bearer TOKEN`, except
bounded CORS preflight. Authentication fails closed when configuration is absent.
`PERCH_TOKENS` is a server-secret JSON object mapping workspace IDs to distinct
tokens of at least 32 characters. Workspace identity comes only from this
configuration, never from a caller header, query, body, or session identifier.
Named cells and blob keys are scoped to that identity. No provider secret is
returned by any endpoint. Native no-Origin requests are accepted; browser
origins require an explicit allowlist. Redirects must not forward credentials.

| Method and route | Request | Response |
|---|---|---|
| GET `/health` | — | `DurableHealth`, including only safe model descriptors |
| GET `/sessions` | — | `{sessions: SessionSummary[]}` |
| POST `/sessions` | `{operationId,title?}` | `{session,accepted}`; repeated identity is idempotent |
| GET `/sessions/:id` | — | `DurableSnapshot` |
| POST `/sessions/:id/submit` | `{operationId,text}` | PiHarness receipt normalized to `DurableReceipt` |
| GET `/sessions/:id/operations/:operationId` | — | `{operationId,status}` or 404 |
| POST `/sessions/:id/abort` | `{operationId?}` | `{ok:true}` |
| POST `/sessions/:id/model` | `{provider,modelId}` | `{ok:true}`; allow configured models only |
| GET `/sessions/:id/artifacts/:artifactId` | — | Exact bytes, protected by the same workspace/session boundary |

Unknown sessions return 404 without creating them. Request bodies and artifact
sizes are bounded. IDs use a conservative bounded alphabet. Mutations must not
silently replace a request that reuses an operation ID with different input.
The exact exported types/constants live in `src/harness/durable.ts`.

`DurableSnapshot.state` follows Perch's existing `HarnessUpdate`, with
`harness.id = pi-durable`, `transport = durable-http`, and `storedArtifacts`.
The server projects Pi entries into stable UI message/tool IDs and includes a
committed in-progress partial. The client treats each snapshot as authoritative.
It may poll while connected; a full snapshot always repairs a reconnect. The
client never invokes tools or starts a second model loop. Questions, attachments,
and steering remain unadvertised in this slice.

## Persistence and tools

Use one workspace catalog cell and one PiHarness cell per top-level session.
The catalog persists session identities and idempotent create operations. The
session persists submissions, transcripts, model selection, and artifact
manifests. PiHarness/Lifecycle handle reopening and alarms as in the verified
experiment. Only the tools intentionally installed by this backend are enabled.

Implement a replay-safe `write_artifact` tool for Markdown, HTML, and code. Use
a durable memo for artifact identity. Write immutable, hash-addressed bytes to
the `ARTIFACTS` R2-style binding before committing the manifest in cell SQLite.
A repeated identical write converges; partial object uploads/manifest commits
must not create a misleading successful record. Text files are capped at two
million UTF-8 bytes. Do not expose arbitrary server paths or remote download URLs.

Download responses force attachment/plain-byte handling and `nosniff`; generated
HTML never becomes a privileged document at the API origin. The client verifies
the returned byte length and SHA-256 before opening it in the existing reader.
The native HTML isolation and script-toggle behavior remain unchanged.

## Provider and test boundaries

Model/provider configuration remains host-owned. Start with an explicitly
configured OpenAI-compatible Pi provider for self-hosted models and compatible
services; use the published Pi API and keep the registry boundary replaceable.
Missing configuration is an error, with no synthetic fallback. Integration tests
inject a controlled provider through a separate test entry point, while using the
real authentication, cells, PiHarness, storage, tool, and API implementation.

The native connection accepts the backend URL and token. Submission IDs survive
network retries/reconnect inside the driver. Ambiguous acceptance is reconciled
by operation ID; no reconnect invents a new prompt. App-process restart persistence
and saved credentials must be described according to what is actually implemented.

## Acceptance checks

1. Missing/wrong credentials and cross-workspace session/artifact access fail.
2. Create/list/select sessions and send a real harness request through the driver.
3. Retry one operation ID without duplicate input; reject different input with it.
4. Reconnect from a new client and hydrate the persisted transcript and manifest.
5. Fetch an artifact through authentication; verify bytes/hash and renderer type.
6. Kill celld, discard local runtime data, and recover accepted work plus artifacts
   from celld's development object store. Keep real R2 claims separate.
7. Run affected adapter/store/artifact checks and native/web build gates. Review
   auth, redirect, source/reader isolation, and stale-response boundaries.
