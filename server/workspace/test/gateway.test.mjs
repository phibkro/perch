import { afterEach, expect, test } from 'bun:test';
import { fixture as durableFixture } from '../../../verification/durable/fixture.cjs';
import { parseManifest } from '../../../src/workspace/protocol.ts';
import { MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, probeConnection } from '../gateway.mjs';
import { createGateway as openCodeGateway, configuration as openCodeConfiguration } from '../../opencode-gateway/index.mjs';
import { basic, client, gateway, json, OMP_INVITE, OPENCODE_PASSWORD, PI_TOKEN, piFixture, until, WORKSPACE_TOKEN } from './helpers.mjs';

const handles = [];
afterEach(async () => { for (const handle of handles.splice(0).reverse()) await handle.close(); });
const keep = value => { handles.push(value); return value; };
const durableConnection = upstream => ({ id: 'durable', name: 'Durable', kind: 'durable', upstream: { url: upstream.url, token: upstream.token } });
const post = value => ({ method: 'POST', body: JSON.stringify(value), headers: { 'Content-Type': 'application/json' } });

test('one authenticated manifest exposes all adapters without exposing their private credentials', async () => {
  const upstream = keep(await durableFixture()); const pi = keep(piFixture());
  const handle = keep(gateway([durableConnection(upstream), pi.connection,
    { id: 'opencode', name: 'OpenCode', kind: 'opencode', upstream: { url: 'http://127.0.0.1:4097', username: 'perch', password: OPENCODE_PASSWORD } },
    { id: 'omp', name: 'Existing OMP', kind: 'omp', collabLink: OMP_INVITE }], { publicUrl: 'https://host.example.com/perch' }));
  const denied = await handle.request('/perch/workspace', { headers: { Authorization: 'Bearer wrong' } });
  expect(denied.status).toBe(401); expect(await denied.text()).not.toContain(OMP_INVITE);
  const response = await handle.request('/perch/workspace'); const text = await response.text();
  const manifest = parseManifest(JSON.parse(text));
  expect(manifest.connections.map(item => item.kind)).toEqual(['durable', 'pi', 'opencode', 'omp']);
  expect(manifest.connections[1].path).toBe('/harness/pi'); expect(text).toContain(OMP_INVITE);
  for (const secret of [upstream.token, PI_TOKEN, OPENCODE_PASSWORD, WORKSPACE_TOKEN]) expect(text).not.toContain(secret);
  expect(text).not.toContain('upstream'); expect(response.headers.get('cache-control')).toBe('no-store');
  expect(upstream.requests).toHaveLength(0); expect(pi.opened).toBe(0);
});

test('authentication, browser origins, route and query restrictions act before adapter commands', async () => {
  const upstream = keep(await durableFixture()); const handle = keep(gateway([durableConnection(upstream)]));
  const prefix = '/harness/durable';
  expect((await handle.request(prefix + '/perch/sessions', { headers: { Authorization: 'Bearer bad' } })).status).toBe(401);
  expect((await handle.request(prefix + '/perch/sessions', { headers: { Origin: 'https://evil.example' } })).status).toBe(403);
  expect((await handle.request(prefix + '/admin')).status).toBe(404);
  expect((await handle.request(prefix + '/perch/sessions/%2Fsecret')).status).toBe(400);
  expect((await handle.request('/perch/workspace?token=' + WORKSPACE_TOKEN)).status).toBe(404);
  expect(upstream.requests).toHaveLength(0);
  const preflight = await handle.request(prefix + '/perch/sessions', { method: 'OPTIONS', headers: {
    Authorization: '', Origin: 'https://phone.example.com', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, content-type' } });
  expect(preflight.status).toBe(204); expect(preflight.headers.get('access-control-allow-origin')).toBe('https://phone.example.com');
  expect((await handle.request(prefix + '/perch/sessions?url=http://evil.example')).status).toBe(400);
  expect(upstream.requests.every(item => item.path === '/perch/health')).toBe(true);
  expect((await handle.request(prefix + '/perch/sessions', post({ operationId: 'create_one' }))).status).toBe(200);
  expect(upstream.requests.every(item => item.authorized)).toBe(true);
  expect((await handle.request(prefix + '/perch/sessions', { method: 'POST', body: '{broken', headers: { 'Content-Type': 'application/json' } })).status).toBe(400);
  expect((await handle.request(prefix + '/perch/sessions', { method: 'POST', body: '{}', headers: { 'Content-Type': 'text/plain' } })).status).toBe(415);
  expect((await handle.request(prefix + '/perch/sessions', post({ large: 'a'.repeat(MAX_REQUEST_BYTES) }))).status).toBe(413);
  expect(upstream.creates.size).toBe(1);
});

test('Durable health exposes display metadata and artifacts preserve their exact bytes', async () => {
  const upstream = keep(await durableFixture()); const handle = keep(gateway([durableConnection(upstream)]));
  const health = await (await handle.request('/harness/durable/perch/health')).text();
  expect(health).not.toContain('do-not-project'); expect(health).not.toContain('apiKey');
  const artifact = await handle.request('/harness/durable/perch/sessions/session_one/artifacts/artifact_one');
  expect(Buffer.from(await artifact.arrayBuffer())).toEqual(Buffer.from(upstream.artifactText()));
  expect(artifact.headers.get('content-type')).toBe('application/octet-stream');
  expect(artifact.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'");
  expect(upstream.requests.every(item => item.authorized)).toBe(true);
});

test('lost submission responses are not replayed; redirects and oversized artifacts never escape the host boundary', async () => {
  const upstream = keep(await durableFixture()); const handle = keep(gateway([durableConnection(upstream)]));
  upstream.setSubmitMode('accepted-drop');
  const result = await handle.request('/harness/durable/perch/sessions/session_one/submit', post({ operationId: 'ambiguous_one', text: 'Exactly once' }));
  expect(result.status).toBe(502); expect(await result.text()).toContain('no request was replayed');
  expect(upstream.operations.size).toBe(1); expect(upstream.requests.filter(item => item.path.endsWith('/submit'))).toHaveLength(1);
  const receipt = await handle.request('/harness/durable/perch/sessions/session_one/operations/ambiguous_one');
  expect((await receipt.json()).status).toBe('done');
  upstream.setArtifactMode('redirect');
  expect((await handle.request('/harness/durable/perch/sessions/session_one/artifacts/artifact_one')).status).toBe(502);
  expect(upstream.leaked).toHaveLength(0);
  upstream.setArtifactMode('oversized');
  expect((await handle.request('/harness/durable/perch/sessions/session_one/artifacts/artifact_one')).status).toBe(413);
  upstream.setHealthMode('wrong');
  expect((await handle.request('/harness/durable/perch/health')).status).toBe(502);
});

test('OpenCode chains through the existing gateway, scopes its directory and strips provider secrets and unsupported commands', async () => {
  const rawRequests = []; const directory = '/home/user/project';
  const raw = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const url = new URL(request.url); const text = request.method === 'POST' ? await request.text() : '';
    const body = text ? JSON.parse(text) : undefined;
    rawRequests.push({ path: url.pathname, query: url.searchParams, authorization: request.headers.get('authorization'), body });
    if (url.pathname === '/global/health') return json({ healthy: true, version: '1.18.35' });
    if (url.pathname === '/path') return json({ directory });
    if (url.pathname === '/provider') return json({ all: [{ id: 'local', name: 'Local', apiKey: 'private-provider-key', options: { token: 'secret' }, models: { model: { id: 'model', name: 'Test', apiKey: 'private-provider-key' } } }], connected: ['local'], default: { local: 'model' } });
    if (url.pathname.endsWith('/prompt_async')) return new Response(null, { status: 204 });
    return json([]);
  } }); keep({ close: () => raw.stop(true) });
  const oldGateway = openCodeGateway(openCodeConfiguration({ OPENCODE_URL: `http://127.0.0.1:${raw.port}`, PERCH_OPENCODE_PORT: '0', PERCH_OPENCODE_PASSWORD: OPENCODE_PASSWORD, OPENCODE_SERVER_PASSWORD: 'raw-server-private-password' }));
  await new Promise(resolve => oldGateway.listen(0, '127.0.0.1', resolve));
  keep({ close: () => new Promise(resolve => { oldGateway.closeAllConnections(); oldGateway.close(resolve); }) });
  const handle = keep(gateway([{ id: 'code', name: 'OpenCode', kind: 'opencode', upstream: { url: `http://127.0.0.1:${oldGateway.address().port}`, username: 'perch', password: OPENCODE_PASSWORD } }]));
  const headers = { Authorization: basic('perch', WORKSPACE_TOKEN) };
  expect((await handle.request('/harness/code/provider')).status).toBe(401);
  const catalog = await (await handle.request('/harness/code/provider', { headers })).text();
  expect(catalog).toContain('model'); expect(catalog).not.toContain('private-provider-key'); expect(catalog).not.toContain('options');
  expect((await handle.request('/harness/code/session?directory=%2Fother', { headers })).status).toBe(403);
  expect((await handle.request('/harness/code/session?roots=false', { headers })).status).toBe(400);
  expect((await handle.request('/harness/code/session?limit=201', { headers })).status).toBe(400);
  expect((await handle.request('/harness/code/session?roots=true&limit=200', { headers })).status).toBe(200);
  expect((await handle.request('/harness/code/session/ses_one/prompt_async', { ...post({ parts: [{ type: 'text', text: 'Hello' }], model: { providerID: 'local', modelID: 'model' }, system: 'not-exposed' }), headers: { ...headers, 'Content-Type': 'application/json' } })).status).toBe(204);
  expect((await handle.request('/harness/code/session/ses_one/abort', { method: 'POST', headers })).status).toBe(200);
  expect((await handle.request('/harness/code/config', { headers })).status).toBe(404);
  const prompt = rawRequests.find(item => item.path.endsWith('/prompt_async'));
  expect(prompt.body).toEqual({ parts: [{ type: 'text', text: 'Hello' }], model: { providerID: 'local', modelID: 'model' } });
  expect(rawRequests.find(item => item.path.endsWith('/abort')).body).toBeUndefined();
  expect(rawRequests.every(item => item.authorization === basic('opencode', 'raw-server-private-password'))).toBe(true);
  expect(rawRequests.filter(item => !['/global/health', '/path'].includes(item.path)).every(item => item.query.get('directory') === directory)).toBe(true);
});

test('only an OpenCode abort can omit both its request body and Content-Type', async () => {
  const requests = [];
  const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/perch/health') return json({ protocol: 'perch-opencode', version: 1, healthy: true, upstreamVersion: '1.18.35', directory: '/workspace' });
    requests.push({ path, body: await request.text(), type: request.headers.get('content-type'), authorization: request.headers.get('authorization') });
    return json(true);
  } }); keep({ close: () => upstream.stop(true) });
  const handle = keep(gateway([{ id: 'code', name: 'Code', kind: 'opencode', upstream: { url: `http://127.0.0.1:${upstream.port}`, username: 'perch', password: OPENCODE_PASSWORD } }]));
  const headers = { Authorization: basic('perch', WORKSPACE_TOKEN) }; const abort = '/harness/code/session/ses_one/abort';
  expect((await handle.request(abort, { method: 'POST', headers })).status).toBe(200);
  expect(requests).toEqual([{ path: '/session/ses_one/abort', body: '', type: null, authorization: basic('perch', OPENCODE_PASSWORD) }]);
  for (const path of ['/session', '/session/ses_one/prompt_async', '/permission/req_one/reply', '/question/req_one/reply']) {
    expect((await handle.request('/harness/code' + path, { method: 'POST', headers })).status).toBe(415);
  }
  expect((await handle.request(abort, { method: 'POST', headers, body: new TextEncoder().encode('{}') })).status).toBe(415);
  expect((await handle.request(abort, { method: 'POST', headers: { ...headers, 'Content-Type': 'text/plain' }, body: 'unexpected' })).status).toBe(415);
  expect((await handle.request(abort, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{broken' })).status).toBe(400);
  expect(requests).toHaveLength(1);
});

test('OpenCode rejects raw servers, bounds responses, sanitizes errors and cancels live event streams', async () => {
  let mode = 'raw'; let eventCancelled = false; let eventController;
  const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/perch/health') return json(mode === 'raw' ? { healthy: true } : { protocol: 'perch-opencode', version: 1, healthy: true, upstreamVersion: '1.18.35', directory: '/workspace', secret: OPENCODE_PASSWORD });
    if (mode === 'error') return json({ secret: OPENCODE_PASSWORD }, { status: 401, headers: { 'Set-Cookie': 'session=secret', 'WWW-Authenticate': 'secret' } });
    if (mode === 'large') return new Response(new Uint8Array(MAX_RESPONSE_BYTES + 1), { headers: { 'Content-Type': 'application/json' } });
    if (path === '/event') return new Response(new ReadableStream({
      start(controller) { eventController = controller; controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected"}\n\n')); },
      cancel() { eventCancelled = true; },
    }), { headers: { 'Content-Type': 'text/event-stream' } });
    return json([]);
  } }); keep({ close: () => upstream.stop(true) });
  const handle = keep(gateway([{ id: 'code', name: 'Code', kind: 'opencode', upstream: { url: `http://127.0.0.1:${upstream.port}`, username: 'perch', password: OPENCODE_PASSWORD } }]));
  const headers = { Authorization: basic('perch', WORKSPACE_TOKEN) };
  expect((await handle.request('/harness/code/provider', { headers })).status).toBe(502);
  mode = 'error'; const failed = await handle.request('/harness/code/provider', { headers });
  expect(failed.status).toBe(401); expect(await failed.text()).not.toContain(OPENCODE_PASSWORD); expect(failed.headers.has('set-cookie')).toBe(false); expect(failed.headers.has('www-authenticate')).toBe(false);
  mode = 'large'; expect((await handle.request('/harness/code/provider', { headers })).status).toBe(413);
  mode = 'normal'; const abort = new AbortController();
  const response = await handle.request('/harness/code/event', { headers, signal: abort.signal }); const reader = response.body.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('server.connected');
  eventController.enqueue(new TextEncoder().encode('data: {"type":"perch.invalidate"}\n\n'));
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('perch.invalidate');
  abort.abort(); await reader.cancel().catch(() => {});
  await until(() => eventCancelled, 'upstream SSE cancellation');
});

test('Pi authenticates before upstream contact, translates only hello credentials and preserves command IDs', async () => {
  const pi = keep(piFixture()); const handle = keep(gateway([pi.connection]));
  const url = handle.base.replace('http:', 'ws:') + '/harness/pi';
  const denied = keep(await client(url)); denied.send({ type: 'hello', protocol: 1, token: 'wrong' });
  await until(() => denied.closeEvent, 'bad-token socket close'); expect(denied.closeEvent.code).toBe(4401); expect(pi.opened).toBe(0);
  const phone = keep(await client(url)); phone.send({ type: 'hello', protocol: 1, token: WORKSPACE_TOKEN, secret: 'extra-hello-field' });
  expect(typeof phone.socket.pause).toBe('function'); expect(typeof phone.socket.resume).toBe('function');
  await until(() => phone.frames.length === 1, 'Pi snapshot'); expect(phone.frames[0].type).toBe('snapshot');
  phone.send({ type: 'prompt', id: 'request_one', text: 'Hello Pi', extra: 'not-forwarded' });
  await until(() => phone.frames.some(item => item.type === 'ack'), 'Pi acknowledgement');
  expect(pi.frames).toEqual([{ type: 'hello', protocol: 1, token: PI_TOKEN }, { type: 'prompt', id: 'request_one', text: 'Hello Pi' }]);
  phone.close(); await until(() => pi.closed === 1, 'Pi guest detach');
  expect((await probeConnection(pi.connection)).status).toBe('verified');
  expect(pi.frames.filter(item => item.type === 'prompt')).toHaveLength(1);
});

test('Pi never sends the host token through a WebSocket redirect', async () => {
  const sink = keep(piFixture()); let requests = 0;
  const redirect = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { requests++; return new Response(null, { status: 302, headers: { Location: sink.connection.upstream.url } }); } });
  keep({ close: () => redirect.stop(true) });
  await expect(probeConnection({ ...sink.connection, upstream: { url: `ws://127.0.0.1:${redirect.port}/session`, token: PI_TOKEN } }, 1000)).rejects.toThrow('handshake failed');
  expect(requests).toBe(1); expect(sink.opened).toBe(0); expect(sink.frames).toHaveLength(0);
});
