const http = require('node:http');
const { createHash } = require('node:crypto');
const { listen, close } = require('./helpers.cjs');
const token = 'public-durable-fixture-token-at-least-32-characters';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const capabilities = { prompt: true, interrupt: true, questions: false, steer: false, attachments: false, modelSelection: true, sessionSelection: true, sessionCreation: true };
const models = [{ id: 'test-model', provider: 'local', name: 'Controlled fixture' }, { id: 'test-model', provider: 'other', name: 'Another fixture' }];
function state(id, title) {
  return { harness: { id: 'pi-durable', name: 'Pi Durable', transport: 'durable-http', version: '1.0.4' }, capabilities, connection: { status: 'live', label: 'Connected' }, session: { id, title, project: 'Controlled workspace', status: 'idle' }, model: models[0], availableModels: models, messages: [{ id: `history_${id}`, role: 'assistant', text: `Saved history for ${id}`, createdAt: 1 }], tools: [], agents: [], pendingQuestion: null, isWorking: false, readOnly: false, storedArtifacts: [] };
}
async function fixture() {
  const requests = []; const leaked = []; const gates = new Map();
  const states = new Map([['session_one', state('session_one', 'First')], ['session_two', state('session_two', 'Second')]]);
  let recent = ['session_one', 'session_two']; const operations = new Map(); const creates = new Map();
  let submitMode = 'accept'; let createMode = 'accept'; let artifactMode = 'normal'; let healthMode = 'normal';
  let artifactBytes = Buffer.from('\ufeff# Æ🙂 report\n\nPersisted Markdown bytes.\n');
  function addArtifact() {
    const artifact = { id: 'artifact_one', sessionId: 'session_one', filename: 'report.md', title: 'Saved report', mimeType: 'text/markdown', language: 'markdown', bytes: artifactBytes.length, sha256: hash(artifactBytes), createdAt: 2, sourceId: 'task_write' };
    states.get('session_one').storedArtifacts = [artifact]; return artifact;
  }
  addArtifact();
  const sink = http.createServer((req, res) => { leaked.push({ path: req.url, authorization: req.headers.authorization }); res.end('Unexpected redirect target'); });
  const sinkUrl = await listen(sink);
  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url, 'http://fixture'); const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined;
      requests.push({ method: req.method, path: url.pathname, query: url.search, authorized: req.headers.authorization === `Bearer ${token}`, body });
      const json = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
      if (req.headers.authorization !== `Bearer ${token}`) return json({ error: `should-never-reach-ui:${token}` }, 401);
      const gate = gates.get(url.pathname);
      if (gate) { gates.delete(url.pathname); gate.started = true; const status = await gate.promise; if (status) return json({ serverDetail: 'do-not-project' }, status); }
      if (url.pathname === '/perch/health') {
        if (healthMode === 'redirect') { res.writeHead(302, { Location: `${sinkUrl}/health` }); return res.end(); }
        if (healthMode === 'oversized') { res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': 13 * 1024 * 1024 }); return res.end('{}'); }
        return json({ service: healthMode === 'wrong' ? 'something-else' : 'perch-durable', protocol: 1, harness: { name: 'Pi Durable', version: '1.0.4' }, models: models.map(model => ({ ...model, apiKey: 'do-not-project' })), synthetic: true, secret: 'do-not-project' });
      }
      if (url.pathname === '/perch/sessions' && req.method === 'GET') return json({ sessions: recent.map(id => states.get(id).session) });
      if (url.pathname === '/perch/sessions' && req.method === 'POST') {
        let session = creates.get(body.operationId); const accepted = !session;
        if (!session) { const id = `created_${creates.size + 1}`; const created = state(id, 'New chat'); created.messages = []; states.set(id, created); recent.unshift(id); session = created.session; creates.set(body.operationId, session); }
        if (createMode === 'accepted-drop') { createMode = 'accept'; return res.destroy(); }
        return json({ session, accepted });
      }
      const match = url.pathname.match(/^\/perch\/sessions\/([A-Za-z0-9_-]+)(.*)$/);
      if (!match || !states.has(match[1])) return json({}, 404);
      const id = match[1]; const suffix = match[2]; const selected = states.get(id);
      const sessionOperations = [...operations.values()].filter(operation => operation.sessionId === id).map(({ operationId, status }) => ({ operationId, status }));
      if (!suffix) return json({ protocol: 1, state: selected, operations: sessionOperations });
      if (suffix === '/submit') {
        if (submitMode === 'unrecorded-drop') { submitMode = 'accept'; return res.destroy(); }
        const old = operations.get(body.operationId);
        if (old && (old.sessionId !== id || old.text !== body.text)) return json({}, 409);
        if (!old) {
          operations.set(body.operationId, { operationId: body.operationId, sessionId: id, text: body.text, status: 'done' });
          selected.messages.push({ id: `input_${body.operationId}`, role: 'user', text: body.text, createdAt: Date.now() });
          selected.messages.push({ id: `answer_${body.operationId}`, role: 'assistant', text: 'Controlled reply', createdAt: Date.now() });
        }
        if (submitMode === 'accepted-drop') { submitMode = 'accept'; return res.destroy(); }
        return json({ session: id, operationId: body.operationId, accepted: !old });
      }
      if (suffix.startsWith('/operations/')) {
        const operationId = suffix.slice('/operations/'.length); const operation = operations.get(operationId);
        return operation?.sessionId === id ? json({ operationId, status: operation.status }) : json({}, 404);
      }
      if (suffix === '/model') { selected.model = models.find(model => model.provider === body.provider && model.id === body.modelId); return json({ ok: true }); }
      if (suffix === '/abort') { selected.isWorking = false; selected.session.status = 'idle'; return json({ ok: true }); }
      if (suffix === '/artifacts/artifact_one' && id === 'session_one') {
        if (artifactMode === 'redirect') { res.writeHead(302, { Location: `${sinkUrl}/artifact` }); return res.end(); }
        let bytes = artifactBytes;
        if (artifactMode === 'hash') { bytes = Buffer.from(artifactBytes); bytes[bytes.length - 1] ^= 1; }
        if (artifactMode === 'length') bytes = bytes.subarray(0, bytes.length - 1);
        if (artifactMode === 'oversized') bytes = Buffer.alloc(2_000_001, 97);
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment', 'X-Content-Type-Options': 'nosniff' });
        return res.end(bytes);
      }
      json({}, 404);
    })().catch(() => { if (!res.destroyed) { res.writeHead(500); res.end('{}'); } });
  });
  const url = await listen(server);
  const allGates = [];
  return {
    url, token, requests, states, operations, creates, leaked,
    setSubmitMode(value) { submitMode = value; }, setCreateMode(value) { createMode = value; }, setArtifactMode(value) { artifactMode = value; }, setHealthMode(value) { healthMode = value; },
    setWorking(id, working) { states.get(id).isWorking = working; states.get(id).session.status = working ? 'working' : 'idle'; },
    setArtifactBytes(value) { artifactBytes = value; return addArtifact(); },
    artifactText() { return artifactBytes.toString('utf8'); },
    setRecent(value) { recent = value; },
    delay(path) { let release; const promise = new Promise(resolve => { release = resolve; }); const gate = { started: false, promise, release }; gates.set(path, gate); allGates.push(gate); return gate; },
    async close() { for (const gate of allGates) gate.release(); await close(server); await close(sink); },
  };
}
module.exports = { fixture };
