const assert = require('node:assert/strict');

/** In-memory remote HTTP responses for the exported UI. No socket or model. */
exports.createRemoteFixture = function createRemoteFixture(blocked) {
  const origin = 'https://perch-remote.invalid';
  const token = 'synthetic-remote-workspace-device-token-32-characters';
  const calls = [], snapshots = new Map(), receipts = new Map();
  let enabled = false, revision = 1;
  const health = { protocol: 'perch-remote', version: 1, host: { id: 'remote-dom-host', name: 'Synthetic remote workspace' }, adapter: 'omp', epoch: 'remote-dom-epoch', synchronization: 'snapshot', limitations: ['In-memory protocol fixture; no model or real host.'] };
  for (const [id, title, pid] of [['remote_one', 'First remote session', 4761], ['remote_two', 'Second remote session', 4762]]) snapshots.set(id, {
    protocol: health.protocol, version: 1, epoch: health.epoch, revision,
    session: { id, title, pid, generation: 'generation-one', runtimeId: `runtime-${id}`, conversationId: `conversation-${id}`, project: '/synthetic/remote-workspace', harness: 'omp', status: 'idle', model: { provider: 'fixture', id: 'remote-model', name: 'Controlled remote model' } },
    capabilities: { prompt: true, interrupt: true, modelSelection: false }, readOnly: false,
    messages: [{ id: `${id}-history`, role: 'assistant', text: `${title}: existing synthetic host transcript.`, createdAt: 1 }], tools: [], availableModels: [], truncated: false, notices: [],
  });
  const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
  const update = () => { revision++; for (const snapshot of snapshots.values()) snapshot.revision = revision; };
  return {
    origin, token, calls, snapshots, enable() { enabled = true; },
    matches(value) { try { return enabled && new URL(String(value)).origin === origin; } catch { return false; } },
    replaceGeneration(id) {
      const snapshot = snapshots.get(id); assert.ok(snapshot);
      Object.assign(snapshot.session, { generation: 'generation-two', runtimeId: `replacement-${id}`, conversationId: `replacement-chat-${id}`, pid: snapshot.session.pid + 100, status: 'idle' });
      snapshot.messages = [{ id: `${id}-replacement`, role: 'assistant', text: 'A replacement runtime has its own host history.', createdAt: 3 }]; update();
    },
    async fetch(value, init = {}) {
      const url = new URL(String(value)); const method = init.method || 'GET'; const headers = new Headers(init.headers);
      assert.equal(headers.get('authorization'), `Bearer ${token}`, 'remote UI uses the paired workspace device credential');
      assert.equal(init.redirect, 'error'); assert.equal(url.search, ''); assert.equal(url.username, ''); assert.equal(url.password, '');
      const body = init.body ? JSON.parse(init.body) : undefined; calls.push({ method, path: url.pathname, body });
      if (method === 'GET' && url.pathname === '/perch/workspace') return json({ protocol: 'perch-workspace', version: 1, workspace: { id: 'remote-dom-workspace', name: health.host.name, deployment: 'self-hosted' }, defaultConnectionId: 'remote', connections: [{ id: 'remote', name: 'Host sessions', kind: 'remote', path: '' }] });
      if (method === 'GET' && url.pathname === '/perch/health') return json(health);
      if (method === 'GET' && url.pathname === '/perch/sessions') return json({ protocol: health.protocol, version: 1, epoch: health.epoch, revision, sessions: [...snapshots.values()].map(snapshot => snapshot.session) });
      const route = /^\/perch\/sessions\/([A-Za-z0-9_-]+)(?:\/(commands|operations)(?:\/([A-Za-z0-9_-]+))?)?$/.exec(url.pathname);
      const snapshot = route && snapshots.get(route[1]);
      if (snapshot && method === 'GET' && !route[2]) return json(snapshot);
      if (snapshot && method === 'POST' && route[2] === 'commands') {
        assert.equal(body.epoch, health.epoch); assert.equal(body.generation, snapshot.session.generation); assert.equal(body.conversationId, snapshot.session.conversationId);
        assert.match(body.id, /^op_[A-Za-z0-9_-]+$/);
        if (!receipts.has(body.id)) {
          if (body.type === 'prompt') {
            assert.equal(snapshot.session.status, 'idle');
            snapshot.messages.push({ id: body.id, role: 'user', text: body.text, createdAt: 2 }, { id: `${body.id}-reply`, role: 'assistant', text: 'Remote controlled reply. This existing fixture runtime is still working; no model was called.', createdAt: 3 });
            snapshot.session.status = 'working';
          } else if (body.type === 'interrupt') snapshot.session.status = 'idle';
          else throw new Error('Unexpected DOM fixture remote command.');
          receipts.set(body.id, { protocol: health.protocol, version: 1, id: body.id, epoch: body.epoch, generation: body.generation, conversationId: body.conversationId, sessionId: snapshot.session.id, status: 'forwarded' }); update();
        }
        return json(receipts.get(body.id));
      }
      if (snapshot && method === 'GET' && route[2] === 'operations') return receipts.has(route[3]) ? json(receipts.get(route[3])) : new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
      blocked.push(`unimplemented-remote-fixture:${method}:${url.pathname}`);
      throw Error(`Unimplemented synthetic remote route: ${method} ${url.pathname}`);
    },
  };
};
