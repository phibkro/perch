const assert = require('node:assert/strict');

/** Synthetic wire host. The browser uses the real Perch store and adapters. */
exports.createSessionControlsFixture = function createSessionControlsFixture() {
  const origin = 'https://perch-session-controls.invalid';
  const token = 'synthetic-session-controls-token-not-a-real-credential';
  const calls = [], receipts = new Map();
  let offline = false, revision = 1, pausedSnapshot;
  const health = { protocol: 'perch-remote', version: 1, epoch: 'controls-epoch-one', adapter: 'omp',
    host: { id: 'controls-host', name: 'Synthetic Tern and OMP workspace' }, synchronization: 'snapshot', limitations: ['Synthetic capability composition for UI verification. No agent or model.'] };
  const initialTitle = 'A remote conversation with a deliberately long title for narrow mobile layouts';
  const snapshot = {
    protocol: health.protocol, version: 1, epoch: health.epoch, revision,
    session: { id: 'controls_session', title: initialTitle, pid: 8912, generation: 'controls-generation-one',
      runtimeId: 'controls-runtime-one', conversationId: 'controls-conversation-one',
      project: '/synthetic/workspaces/a-deliberately-long-workspace-directory-for-mobile-layouts', harness: 'omp', status: 'idle',
      model: { provider: 'synthetic-provider-with-a-long-name', id: 'fixture-model', name: 'A deliberately long model display name for narrow mobile screens' } },
    capabilities: { prompt: true, interrupt: true, modelSelection: false, questions: true, thinkingSelection: true, sessionRename: true, focusSession: true },
    readOnly: false, messages: [{ id: 'controls-history', role: 'assistant', createdAt: 1,
      text: 'This is a synthetic host transcript. Session details come through the real Perch remote adapter.' }],
    tools: [], availableModels: [], truncated: false, notices: [],
    insights: {
      context: { tokens: 64000, contextWindow: 200000, percent: 32 },
      thinking: { level: 'medium', availableLevels: ['off', 'medium', 'high'] },
      usage: { input: 1234, output: 456, cacheRead: 7890, cacheWrite: 321, cost: 0.0123, scope: 'current-branch' },
      tools: [
        { name: 'read', description: 'Read a host file.', active: true },
        { name: 'inspect_a_deliberately_long_tool_name_to_check_mobile_wrapping',
          description: 'A long description explains what this host capability does without truncating the information needed to understand it on a narrow screen.', active: false },
      ],
    },
  };
  const alternateTitle = 'Another synthetic host conversation';
  const alternate = structuredClone(snapshot);
  Object.assign(alternate.session, { id: 'controls_alternate', title: alternateTitle, pid: 8914,
    generation: 'alternate-generation', runtimeId: 'alternate-runtime', conversationId: 'alternate-conversation' });
  const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
  const update = () => { snapshot.revision = ++revision; };
  const commands = () => calls.filter(call => call.method === 'POST');
  return {
    origin, token, calls, snapshot, initialTitle, alternateTitle, commands,
    holdNextSnapshot(id) {
      assert.ok(!pausedSnapshot, 'only one intentionally held response at a time');
      let release;
      const promise = new Promise(resolve => { release = resolve; });
      pausedSnapshot = { id, promise, started: false };
      return release;
    },
    isSnapshotHeld() { return !!pausedSnapshot?.started; },
    setOffline(value) { offline = value; },
    patch(change) { change(snapshot); update(); },
    confirmLast() {
      const command = commands().at(-1)?.body; assert.ok(command);
      if (command.type === 'rename-session') snapshot.session.title = command.title;
      else if (command.type === 'set-thinking') snapshot.insights.thinking.level = command.level;
      else assert.equal(command.type, 'focus-session');
      update();
    },
    replaceGeneration() {
      Object.assign(snapshot.session, { generation: 'controls-generation-two', runtimeId: 'controls-runtime-two',
        conversationId: 'controls-conversation-two', title: 'Replacement host conversation', pid: 8913 });
      snapshot.messages = [{ id: 'replacement-history', role: 'assistant', text: 'A replacement host has its own title and draft.', createdAt: 2 }]; update();
    },
    async fetch(value, init = {}) {
      const url = new URL(String(value));
      assert.equal(url.origin, origin); assert.equal(url.search, '');
      assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${token}`);
      const method = init.method || 'GET'; const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ method, path: url.pathname, body });
      if (offline) throw new Error('Synthetic host offline.');
      if (method === 'GET' && url.pathname === '/perch/workspace') return json({ protocol: 'perch-workspace', version: 1,
        workspace: { id: 'controls-workspace', name: health.host.name, deployment: 'self-hosted' }, defaultConnectionId: 'remote',
        connections: [{ id: 'remote', name: 'Synthetic host controls', kind: 'remote', path: '' }] });
      if (method === 'GET' && url.pathname === '/perch/health') return json(health);
      if (method === 'GET' && url.pathname === '/perch/sessions') return json({ protocol: health.protocol, version: 1, epoch: health.epoch, revision, sessions: [snapshot.session, alternate.session] });
      const requestedSnapshot = url.pathname === '/perch/sessions/controls_session' ? snapshot
        : url.pathname === '/perch/sessions/controls_alternate' ? alternate : undefined;
      if (method === 'GET' && requestedSnapshot) {
        if (pausedSnapshot?.id === requestedSnapshot.session.id) {
          pausedSnapshot.started = true; await pausedSnapshot.promise; pausedSnapshot = undefined;
        }
        return json(requestedSnapshot);
      }
      if (method === 'POST' && url.pathname === '/perch/sessions/controls_session/commands') {
        assert.equal(body.epoch, snapshot.epoch); assert.equal(body.generation, snapshot.session.generation);
        assert.equal(body.conversationId, snapshot.session.conversationId); assert.match(body.id, /^op_[A-Za-z0-9_-]+$/);
        assert.equal(snapshot.readOnly, false);
        if (body.type !== 'focus-session') { assert.equal(snapshot.session.status, 'idle'); assert.ok(!snapshot.pendingQuestion); }
        if (body.type === 'set-thinking') {
          assert.equal(snapshot.capabilities.thinkingSelection, true);
          assert.ok(snapshot.insights.thinking.availableLevels.includes(body.level));
          assert.equal(body.provider, snapshot.session.model.provider); assert.equal(body.modelId, snapshot.session.model.id);
        } else if (body.type === 'rename-session') {
          assert.equal(snapshot.capabilities.sessionRename, true); assert.ok(body.title.trim()); assert.ok(body.title.length <= 160);
        } else if (body.type === 'focus-session') assert.equal(snapshot.capabilities.focusSession, true);
        else throw new Error(`Unexpected session-controls command ${body.type}`);
        // Dispatch acknowledgment alone does not change the authoritative values.
        const receipt = { protocol: health.protocol, version: 1, id: body.id, epoch: body.epoch,
          generation: body.generation, conversationId: body.conversationId, sessionId: snapshot.session.id, status: 'forwarded' };
        receipts.set(body.id, receipt); return json(receipt);
      }
      const operation = /^\/perch\/sessions\/controls_session\/operations\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
      if (method === 'GET' && operation) return receipts.has(operation[1]) ? json(receipts.get(operation[1])) : new Response('{}', { status: 404 });
      throw new Error(`Unexpected synthetic route ${method} ${url.pathname}`);
    },
  };
};
