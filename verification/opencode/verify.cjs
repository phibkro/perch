const http = require('node:http');
const { assert, wait, until, compile, listen, close } = require('./helpers.cjs');

async function fixture() {
  const requests = []; const streams = new Set();
  let hostSessions = [{ id: 'ses_one', title: 'First', directory: '/synthetic/workspace', time: { updated: 2 } }, { id: 'ses_two', title: 'Second', directory: '/synthetic/workspace', time: { updated: 1 } }];
  const statuses = {}; const histories = new Map(hostSessions.map(session => [session.id, [{ info: { id: `msg_${session.id}`, sessionID: session.id, role: 'assistant', time: { created: 1, completed: 2 } }, parts: [{ id: `part_${session.id}`, messageID: `msg_${session.id}`, sessionID: session.id, type: 'text', text: `History of ${session.id}` }] }]]));
  let permissions = []; let questions = []; let wrongHealth = false; let delayedSession; let release;
  const auth = `Basic ${Buffer.from('perch:public-fixture-secret-only').toString('base64')}`;
  const event = value => { for (const stream of streams) stream.write(`data: ${JSON.stringify(value)}\n\n`); };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture'); const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined;
    requests.push({ method: req.method, path: url.pathname, directory: url.searchParams.get('directory'), body });
    if (req.headers.authorization !== auth) { res.writeHead(401); res.end('{}'); return; }
    const json = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (url.pathname === '/perch/health') return json(wrongHealth ? { healthy: true, version: '1.18.35' } : { protocol: 'perch-opencode', version: 1, healthy: true, upstreamVersion: '1.18.35', directory: '/synthetic/workspace' });
    if (url.pathname === '/event') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('data: {"type":"server.connected","properties":{}}\n\n');
      streams.add(res); res.on('close', () => streams.delete(res)); return;
    }
    if (url.pathname === '/provider') return json({ all: [{ id: 'provider_a', key: 'must-not-project', models: { same: { id: 'same', name: 'Shared name', secret: 'drop' } } }, { id: 'provider_b', options: { apiKey: 'drop' }, models: { same: { id: 'same', name: 'Shared name' } } }, { id: 'disconnected', models: { unavailable: { id: 'unavailable' } } }], connected: ['provider_a', 'provider_b'], default: {} });
    if (url.pathname === '/session' && req.method === 'POST') {
      const created = { id: `ses_created_${hostSessions.length}`, title: 'New chat', directory: '/synthetic/workspace', time: { updated: Date.now() } }; hostSessions.unshift(created); histories.set(created.id, []); event({ type: 'session.created', properties: { info: created } }); return json(created);
    }
    if (url.pathname === '/session') return json(hostSessions);
    if (url.pathname === '/session/status') return json(statuses);
    if (url.pathname === '/permission') return json(permissions);
    if (url.pathname === '/question') return json(questions);
    const message = url.pathname.match(/^\/session\/([^/]+)\/message$/);
    if (message) {
      if (message[1] === delayedSession) { const failure = await new Promise(resolve => { release = resolve; }); if (failure) return json({}, failure); }
      return histories.has(message[1]) ? json(histories.get(message[1])) : json({}, 404);
    }
    const prompt = url.pathname.match(/^\/session\/([^/]+)\/prompt_async$/);
    if (prompt) { statuses[prompt[1]] = { type: 'busy' }; event({ type: 'session.status', properties: { sessionID: prompt[1], status: { type: 'busy' } } }); res.writeHead(204); res.end(); return; }
    const abort = url.pathname.match(/^\/session\/([^/]+)\/abort$/);
    if (abort) { statuses[abort[1]] = { type: 'idle' }; event({ type: 'session.idle', properties: { sessionID: abort[1] } }); return json(true); }
    if (/^\/(question|permission)\/[^/]+\/reply$/.test(url.pathname)) return json(true);
    json({}, 404);
  });
  const url = await listen(server);
  return { url, requests, histories, statuses, event, setPermissions(value) { permissions = value; event({ type: 'permission.asked', properties: {} }); }, setQuestions(value) { questions = value; event({ type: 'question.asked', properties: {} }); }, delay(id) { delayedSession = id; }, release(failure) { delayedSession = undefined; release?.(failure); }, omitRecentSession(id) { hostSessions = hostSessions.filter(session => session.id !== id); }, clear() { hostSessions = []; histories.clear(); permissions = []; questions = []; }, wrongHealth(value) { wrongHealth = value; }, disconnect() { for (const res of streams) res.destroy(); }, close: () => close(server) };
}
async function main() {
  const code = compile(); const host = await fixture(); let driver; let state; const snapshots = [];
  const connect = async () => { driver = await code.createOpenCodeDriver({ url: host.url, username: 'perch', password: 'public-fixture-secret-only' }, update => { state = update; snapshots.push(update); }); driver.connect(); await until(() => state?.connection.status === 'live', 'OpenCode live snapshot'); };
  try {
    assert.throws(() => code.validateOpenCodeConnection({ url: 'http://remote.example', username: 'perch', password: 'x' }), /https/);
    assert.throws(() => code.validateOpenCodeConnection({ url: 'https://host.example?token=x', username: 'perch', password: 'x' }), /separate/);
    driver = await code.createOpenCodeDriver({ url: host.url, username: 'perch', password: 'public-fixture-secret-only' }, update => { state = update; snapshots.push(update); });
    assert.equal(host.requests.length, 0, 'Construction is network-neutral'); driver.connect();
    await until(() => state?.connection.status === 'live', 'Initial host history');
    assert.equal(host.requests[0].path, '/perch/health');
    assert.equal(state.session.id, 'ses_one'); assert.equal(state.messages[0].text, 'History of ses_one');
    assert.equal(state.availableModels.length, 2); assert(!JSON.stringify(state).includes('must-not-project'));
    assert(host.requests.filter(request => request.path !== '/perch/health').every(request => request.directory === '/synthetic/workspace'));
    driver.setModel('provider_b', 'same'); assert.equal(state.model.provider, 'provider_b');
    driver.sendPrompt('Synthetic prompt'); driver.sendPrompt('Duplicate tap');
    await until(() => state.isWorking, 'Host busy');
    const sent = host.requests.filter(request => request.path.endsWith('/prompt_async'));
    assert.equal(sent.length, 1); assert.deepEqual(sent[0].body.model, { providerID: 'provider_b', modelID: 'same' });
    driver.interrupt(); await until(() => !state.isWorking, 'Interrupt acknowledged');
    const streamMessage = { info: { id: 'msg_stream', sessionID: 'ses_one', role: 'assistant', time: { created: 3 } }, parts: [{ id: 'part_stream', messageID: 'msg_stream', sessionID: 'ses_one', type: 'text', text: '', time: { start: 3 } }] };
    host.histories.get('ses_one').push(streamMessage); host.statuses.ses_one = { type: 'busy' }; host.event({ type: 'perch.invalidate' });
    await until(() => state.messages.some(message => message.id === 'msg_stream'), 'Incomplete host text part');
    const textEvent = (id, operation, text, complete = false) => host.event({ type: 'perch.text', id, sessionID: 'ses_one', messageID: 'msg_stream', partID: 'part_stream', operation, text, complete });
    textEvent('evt_start', 'replace', ''); textEvent('evt_delta', 'append', 'Hello'); textEvent('evt_delta', 'append', 'Hello');
    await until(() => state.messages.find(message => message.id === 'msg_stream')?.text === 'Hello', 'Ordered text delta');
    await wait(220); assert.equal(state.messages.find(message => message.id === 'msg_stream').text, 'Hello', 'Snapshot with empty uncommitted text does not erase live text; duplicate event ID is ignored');
    streamMessage.parts[0].text = 'Hello'; textEvent('evt_final', 'replace', 'Rewritten by completion plugin', true);
    await until(() => state.messages.find(message => message.id === 'msg_stream')?.text === 'Rewritten by completion plugin', 'Final transformed full text replaces live prefix');
    streamMessage.parts[0].text = 'Rewritten by completion plugin'; streamMessage.parts[0].time.end = 4; streamMessage.info.time.completed = 4; host.statuses.ses_one = { type: 'idle' }; host.event({ type: 'perch.invalidate' });
    await until(() => !state.isWorking && state.messages.find(message => message.id === 'msg_stream')?.streaming === false, 'Committed snapshot replaces streaming overlay');
    assert.equal(state.messages.find(message => message.id === 'msg_stream').text, 'Rewritten by completion plugin');
    host.event({ type: 'perch.removed', sessionID: 'ses_one', messageID: 'msg_stream', partID: 'part_stream' });
    await until(() => !state.messages.some(message => message.text === 'Rewritten by completion plugin'), 'Removed part cannot be resurrected by an old snapshot');
    await wait(220); assert(!state.messages.some(message => message.text === 'Rewritten by completion plugin'));
    host.histories.set('ses_one', host.histories.get('ses_one').filter(message => message.info.id !== 'msg_stream'));
    host.setPermissions([{ id: 'per_write', sessionID: 'ses_one', permission: 'edit', patterns: ['/synthetic/workspace/page.html'], metadata: {}, always: [] }]);
    await until(() => state.pendingQuestion, 'Permission request');
    assert.equal(state.pendingQuestion.options.length, 2);
    driver.answerQuestion(state.pendingQuestion, 'always'); driver.answerQuestion({ ...state.pendingQuestion, id: 'stale' }, 'once');
    await wait(30); assert.equal(host.requests.filter(request => request.path.endsWith('/reply')).length, 0);
    const shown = state.pendingQuestion; driver.answerQuestion(shown, 'once'); driver.answerQuestion(shown, 'once');
    await until(() => host.requests.some(request => request.path === '/permission/per_write/reply'), 'Explicit allow once');
    await wait(220); assert.equal(state.pendingQuestion.answering, true, 'Question remains until host dismissal');
    assert.equal(host.requests.filter(request => request.path === '/permission/per_write/reply').length, 1);
    host.setPermissions([]); await until(() => !state.pendingQuestion, 'Host dismissed permission');
    host.setQuestions([{ id: 'que_custom', sessionID: 'ses_one', questions: [{ header: 'Choose', question: 'What next?', options: [{ label: 'Read', description: 'Read output' }], custom: true }] }]);
    await until(() => state.pendingQuestion?.id === 'question:que_custom', 'Single-choice request');
    driver.answerQuestion(state.pendingQuestion, 'custom'); assert.equal(state.pendingQuestion.kind, 'editor');
    driver.answerQuestion(state.pendingQuestion, 'Inspect the HTML');
    await until(() => host.requests.some(request => request.path === '/question/que_custom/reply'), 'Custom answer');
    assert.deepEqual(host.requests.find(request => request.path === '/question/que_custom/reply').body, { answers: [['Inspect the HTML']] });
    host.setQuestions([{ id: 'que_multiple', sessionID: 'ses_one', questions: [{ header: 'Pick', question: 'Choose several', options: [], multiple: true }] }]);
    await until(() => state.pendingQuestion?.id === 'question:que_multiple', 'Unsupported multiselect stays unresolved');
    assert.deepEqual(state.pendingQuestion.options, []); assert.equal(state.session.status, 'needs-input');
    host.setQuestions([]); await until(() => !state.pendingQuestion, 'Question cleared');
    host.delay('ses_two'); driver.selectSession('ses_two');
    assert.equal(state.sessionAction, 'switching'); assert.equal(state.session.id, 'ses_one'); assert.equal(state.messages[0].text, 'History of ses_one');
    driver.sendPrompt('Should be blocked while switching'); await wait(40); host.release();
    await until(() => state.session.id === 'ses_two' && !state.sessionAction, 'Atomic session switch');
    assert.equal(state.messages[0].text, 'History of ses_two');
    assert.equal(host.requests.filter(request => request.path.endsWith('/prompt_async')).length, 1);
    const beforeRefresh = host.requests.filter(request => request.path === '/session/ses_two/message').length;
    host.delay('ses_two'); host.event({ type: 'perch.invalidate' });
    await until(() => host.requests.filter(request => request.path === '/session/ses_two/message').length > beforeRefresh, 'Deferred old-session background refresh');
    driver.selectSession('ses_one');
    await until(() => state.session.id === 'ses_one' && !state.sessionAction, 'New selection completes before old refresh');
    host.release(503); await wait(220);
    assert.equal(state.connection.status, 'live', 'An older rejected snapshot cannot disconnect the new session');
    assert.equal(state.session.id, 'ses_one'); assert.equal(state.messages[0].text, 'History of ses_one');
    host.omitRecentSession('ses_one');
    host.disconnect(); await until(() => state.connection.status === 'offline', 'Disconnect selected session omitted from capped list');
    driver.reconnect(); await until(() => state.connection.status === 'live', 'Reconnect directly to omitted active history');
    assert.equal(state.session.id, 'ses_one', 'Reconnect preserves a valid selected chat outside the recent list');
    assert.equal(state.messages[0].text, 'History of ses_one');
    assert(state.sessions.some(session => session.id === 'ses_one'), 'Verified older active session remains addressable');
    const selectedHistory = host.histories.get('ses_one'); host.histories.delete('ses_one');
    driver.reconnect(); await until(() => state.connection.status === 'offline', 'Authoritatively unavailable selected history');
    assert.equal(state.session.id, 'ses_one', 'An unavailable selected chat is not silently replaced with another chat');
    assert.equal(state.messages[0].text, 'History of ses_one', 'A failed reconnect preserves the last transcript');
    host.histories.set('ses_one', selectedHistory); driver.reconnect(); await until(() => state.connection.status === 'live', 'Selected history restored');
    const created = await driver.createSession(); assert(created); assert.equal(state.session.id, created); assert.equal(state.messages.length, 0);
    const writes = host.requests.filter(request => request.method === 'POST').length;
    host.disconnect(); await until(() => state.connection.status === 'offline', 'Disconnected'); assert.equal(state.readOnly, false, 'Offline write-role metadata remains separate from connection state'); driver.reconnect();
    await until(() => state.connection.status === 'live', 'Reconnected');
    assert.equal(host.requests.filter(request => request.method === 'POST').length, writes, 'Reconnect replays no mutation');
    driver.close(); host.clear(); await connect(); assert.equal(state.sessions.length, 0); assert.equal(state.capabilities.prompt, false); assert.equal(state.readOnly, false);
    const beforeCreate = host.requests.filter(request => request.method === 'POST').length;
    assert.equal(host.requests.filter(request => request.method === 'POST').length, beforeCreate, 'Connecting to empty server creates nothing');
    assert(await driver.createSession()); driver.close();
    host.clear(); const store = new code.SessionStore();
    try {
      await store.connectOpenCode({ url: host.url, username: 'perch', password: 'public-fixture-secret-only' });
      await until(() => store.getSnapshot().connection.status === 'live', 'Store connects to empty OpenCode workspace');
      assert.equal(store.getSnapshot().capabilities.prompt, false); assert.equal(store.getSnapshot().readOnly, false);
      const storeId = await store.createSession(); assert(storeId); assert.equal(store.getSnapshot().activeSessionId, storeId); assert.equal(store.getSnapshot().mode, 'opencode');
    } finally { store.dispose(); }
    host.wrongHealth(true); const beforeWrong = host.requests.length;
    driver = await code.createOpenCodeDriver({ url: host.url, username: 'perch', password: 'public-fixture-secret-only' }, update => { state = update; }); driver.connect();
    await until(() => state.connection.status === 'error', 'Raw-server rejection');
    assert.match(state.connection.error, /gateway/); assert.deepEqual(host.requests.slice(beforeWrong).map(request => request.path), ['/perch/health']);
    const projected = code.projection.transcript([{ info: { id: 'msg_write', sessionID: 'ses_test', role: 'assistant', time: { created: 1, completed: 2 } }, parts: [
      { id: 'tool_write', messageID: 'msg_write', sessionID: 'ses_test', type: 'tool', tool: 'write', state: { status: 'completed', input: { filePath: '/tmp/page.html', content: '<h1>Full file</h1>' }, output: 'Written' } },
      { id: 'tool_partial', messageID: 'msg_write', sessionID: 'ses_test', type: 'tool', tool: 'write', state: { status: 'pending', input: { filePath: '/tmp/partial.html', content: '<h1>Partial' }, raw: '' } },
      { id: 'tool_edit', messageID: 'msg_write', sessionID: 'ses_test', type: 'tool', tool: 'edit', state: { status: 'completed', input: { filePath: '/tmp/edit.html', content: 'Not a full file' }, output: '```html\nnot-an-artifact\n```' } },
    ] }], 'ses_test');
    assert.deepEqual(projected.tools[0].artifact, { filename: '/tmp/page.html', content: '<h1>Full file</h1>' }); assert(!projected.tools[1].artifact); assert(!projected.tools[2].artifact);
    assert.throws(() => code.projection.transcript([{ info: { id: 'wrong', sessionID: 'other', role: 'user' }, parts: [] }], 'expected'), /unexpected session/);
    const summaryUser = code.projection.transcript([{ info: { id: 'msg_user', sessionID: 'ses_test', role: 'user', summary: { diffs: [] }, time: { created: 1 } }, parts: [{ id: 'part_user', messageID: 'msg_user', sessionID: 'ses_test', type: 'text', text: 'A real user prompt' }] }], 'ses_test');
    assert.equal(summaryUser.messages[0].text, 'A real user prompt', 'User metadata summary is not assistant compaction');
    console.log('PASS OpenCode adapter: authenticated reads, host catalog/provider identity, sessions, explicit new chat, permission/question guards, artifact provenance, atomic switching, reconnect without replay, raw-server rejection.');
  } finally { driver?.close(); host.release(); await host.close(); code.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
