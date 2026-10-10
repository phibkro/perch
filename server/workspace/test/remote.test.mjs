import { afterEach, expect, test } from 'bun:test';
import { createServer } from 'node:http';
import { MAX_REMOTE_BYTES, parseRemoteCatalog, parseRemoteHealth, parseRemoteReceipt, parseRemoteSnapshot } from '../../../src/harness/remote.ts';
import { parseManifest } from '../../../src/workspace/protocol.ts';
import { gateway, WORKSPACE_TOKEN } from './helpers.mjs';

const TOKEN = 'public-test-remote-adapter-token-32-characters';
const envelope = { protocol: 'perch-remote', version: 1, epoch: 'original-host-epoch' };
const identity = { id: 'existing-omp', generation: 'original-process', runtimeId: 'runtime-42', conversationId: 'saved-conversation',
  title: 'Existing OMP', project: '/project', status: 'idle', harness: 'omp', pid: 42 };
const handles = [];
const keep = value => { handles.push(value); return value; };
afterEach(async () => { for (const handle of handles.splice(0).reverse()) await handle.close(); });
const post = value => ({ method: 'POST', body: JSON.stringify(value), headers: { 'Content-Type': 'application/json' } });
const command = { id: 'phone-command', epoch: envelope.epoch, generation: identity.generation,
  conversationId: identity.conversationId, type: 'prompt', text: 'Review this code' };

async function fixture() {
  const requests = []; const operations = new Map(); let epoch = envelope.epoch;
  let mode = 'normal'; let writes = 0;
  const server = createServer((request, response) => {
    void (async () => {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined;
      requests.push({ method: request.method, path: request.url, authorization: request.headers.authorization, body });
      const json = (value, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
      if (request.headers.authorization !== `Bearer ${TOKEN}`) return json({ error: TOKEN }, 401);
      if (request.url === '/perch/health') return json({ ...envelope, epoch, host: { id: 'host-one', name: 'Development host' },
        adapter: 'omp', synchronization: 'snapshot', limitations: ['Public extension fixture'], secret: TOKEN });
      if (request.url === '/perch/sessions') {
        if (mode === 'oversized') {
          response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': MAX_REMOTE_BYTES + 1 });
          response.end('{}'); return;
        }
        return json({ ...envelope, epoch, revision: 1, sessions: [identity] });
      }
      if (request.url === '/perch/sessions/existing-omp') return json({ ...envelope, epoch, revision: 1,
        session: identity, capabilities: { prompt: true, interrupt: true, modelSelection: false }, readOnly: false,
        messages: [{ id: 'saved-message', role: 'assistant', text: 'Existing history', createdAt: 1 }], tools: [], availableModels: [],
        truncated: false, notices: [] });
      if (request.url === '/perch/sessions/existing-omp/commands') {
        if (body.epoch !== epoch || body.generation !== identity.generation || body.conversationId !== identity.conversationId) return json({}, 409);
        writes++;
        operations.set(body.id, { ...envelope, epoch, id: body.id, sessionId: identity.id, generation: identity.generation,
          conversationId: identity.conversationId, status: 'forwarded' });
        if (mode === 'accepted-drop') { response.destroy(); return; }
        return json(operations.get(body.id));
      }
      const operationId = request.url.match(/^\/perch\/sessions\/existing-omp\/operations\/([A-Za-z0-9_-]+)$/)?.[1];
      if (operationId) return json(operations.get(operationId) ?? {}, operations.has(operationId) ? 200 : 404);
      return json({}, 404);
    })().catch(() => response.destroy());
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return keep({ requests, operations, get writes() { return writes; },
    mode: value => { mode = value; }, restart: () => { epoch = 'replacement-host-epoch'; },
    connection: { id: 'remote', name: 'Host sessions', kind: 'remote', upstream: { url: `http://127.0.0.1:${server.address().port}`, token: TOKEN } },
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) });
}

test('paired remote discovery and attachment preserve host identity without exposing adapter credentials', async () => {
  const upstream = await fixture(); const handle = keep(gateway([upstream.connection]));
  const rawManifest = await (await handle.request('/perch/workspace')).text();
  expect(parseManifest(JSON.parse(rawManifest)).connections).toEqual([{ id: 'remote', name: 'Host sessions', kind: 'remote', path: '/harness/remote' }]);
  for (const secret of [TOKEN, WORKSPACE_TOKEN]) expect(rawManifest).not.toContain(secret);
  expect(upstream.requests).toHaveLength(0);

  const rawHealth = await (await handle.request('/harness/remote/perch/health')).text();
  expect(rawHealth).not.toContain(TOKEN); expect(parseRemoteHealth(JSON.parse(rawHealth)).epoch).toBe('original-host-epoch');
  const catalog = parseRemoteCatalog(await (await handle.request('/harness/remote/perch/sessions')).json());
  expect(catalog.sessions[0].pid).toBe(42);
  const snapshot = parseRemoteSnapshot(await (await handle.request('/harness/remote/perch/sessions/existing-omp')).json());
  expect(snapshot.messages[0].text).toBe('Existing history'); expect(snapshot.session).toEqual(catalog.sessions[0]);
  expect(upstream.writes).toBe(0);
  expect(upstream.requests.every(request => request.authorization === `Bearer ${TOKEN}`)).toBe(true);

  upstream.restart();
  const newHealth = parseRemoteHealth(await (await handle.request('/harness/remote/perch/health')).json());
  expect(newHealth.epoch).toBe('replacement-host-epoch'); // Reconnect cannot use the old cached handshake.
  expect((await handle.request('/harness/remote/perch/sessions/existing-omp/commands', post(command))).status).toBe(409);
  expect(upstream.writes).toBe(0);
});

test('remote routes refuse raw control, unsupported commands, cross-origin access and oversized snapshots', async () => {
  const upstream = await fixture(); const handle = keep(gateway([upstream.connection]));
  const prefix = '/harness/remote';
  expect((await handle.request(prefix + '/perch/sessions', { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401);
  expect((await handle.request(prefix + '/perch/sessions', { headers: { Origin: 'https://untrusted.example' } })).status).toBe(403);
  for (const path of ['/tern/frames', '/tern/commands', '/ctl', '/perch/sessions/existing-omp/files', '/perch/sessions/existing-omp/terminate']) {
    expect((await handle.request(prefix + path)).status).toBe(404);
  }
  expect(upstream.requests).toHaveLength(0);
  expect((await handle.request(prefix + '/perch/sessions', post({}))).status).toBe(404);
  expect((await handle.request(prefix + '/perch/sessions?url=https://untrusted.example')).status).toBe(400);
  for (const value of [{ ...command, type: 'shell', text: 'uname' }, { ...command, rawInput: 'rm' }, { ...command, text: 'x'.repeat(100_001) }]) {
    expect((await handle.request(prefix + '/perch/sessions/existing-omp/commands', post(value))).status).toBe(400);
  }
  expect(upstream.writes).toBe(0);
  expect(upstream.requests.every(request => request.path === '/perch/health')).toBe(true);
  upstream.mode('oversized');
  expect((await handle.request(prefix + '/perch/sessions')).status).toBe(413);
});

test('a transport drop after forwarding is reconciled through a read, with exactly one gateway POST', async () => {
  const upstream = await fixture(); const handle = keep(gateway([upstream.connection]));
  upstream.mode('accepted-drop');
  const response = await handle.request('/harness/remote/perch/sessions/existing-omp/commands', post(command));
  expect(response.status).toBe(502); expect(await response.text()).toContain('no request was replayed');
  const receipt = parseRemoteReceipt(await (await handle.request('/harness/remote/perch/sessions/existing-omp/operations/phone-command')).json());
  expect(receipt.status).toBe('forwarded'); expect(receipt.conversationId).toBe('saved-conversation');
  expect(upstream.writes).toBe(1);
  expect(upstream.requests.filter(request => request.method === 'POST')).toHaveLength(1);
  await handle.request('/harness/remote/perch/health'); await handle.request('/harness/remote/perch/sessions/existing-omp');
  expect(upstream.writes).toBe(1);
});
