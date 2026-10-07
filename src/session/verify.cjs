/* Local-only protocol/state verification. No user account or external relay. */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const WebSocketServer = require('ws').Server;

const project = path.resolve(__dirname, '../..');
const build = fs.mkdtempSync(path.join(os.tmpdir(), 'perch-session-'));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label, timeout = 8000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error(`Timed out: ${label}`);
    await wait(25);
  }
}

function compile() {
  execFileSync(process.execPath, [path.join(project, 'node_modules/typescript/bin/tsc'),
    'src/session/store.ts', 'src/session/collab.ts', '--outDir', build,
    '--module', 'commonjs', '--target', 'es2022', '--lib', 'es2023,dom',
    '--esModuleInterop', '--skipLibCheck', '--strict'], { cwd: project, stdio: 'pipe' });
}

function startFixture(interactive = false) {
  const key = Buffer.alloc(32, 0x11); // Public synthetic fixture, never a real secret.
  const token = Buffer.alloc(16, 0x33);
  const roomId = 'perch-local-fixture';
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const received = [];
  const sockets = new Set();
  let readOnly = false;
  const timestamp = 1700000000000;
  const entry = { type: 'message', id: 'fixture-message-1', parentId: null, timestamp: new Date(timestamp).toISOString(), message: { role: 'user', content: 'Local synthetic fixture', timestamp } };
  const state = { isStreaming: false, queuedMessageCount: 0, sessionName: 'Local protocol fixture', cwd: '/synthetic/perch-fixture', participants: [{ name: 'Fixture host', role: 'host' }] };
  function seal(frame) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    return Buffer.concat([Buffer.alloc(4), iv, cipher.update(JSON.stringify(frame)), cipher.final(), cipher.getAuthTag()]);
  }
  function open(bytes) {
    const payload = Buffer.from(bytes).subarray(4);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, payload.subarray(0, 12));
    decipher.setAuthTag(payload.subarray(-16));
    return JSON.parse(Buffer.concat([decipher.update(payload.subarray(12, -16)), decipher.final()]).toString());
  }
  function send(socket, frame) { if (socket.readyState === 1) socket.send(seal(frame)); }
  server.on('connection', socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    socket.on('message', bytes => {
      const frame = open(bytes); received.push(frame);
      if (frame.t === 'hello') {
        assert.equal(frame.writeToken, token.toString('base64url'));
        send(socket, { t: 'welcome', proto: frame.proto, header: { type: 'session', id: 'fixture-session', title: 'Fixture', cwd: state.cwd, timestamp: new Date(timestamp).toISOString() }, state, agents: [], entryCount: 2, readOnly });
        send(socket, { t: 'snapshot-chunk', entries: [entry, entry], final: true });
        if (!readOnly) send(socket, { t: 'ui-request', request: { reqId: 9, kind: 'select', title: 'Synthetic host question', options: ['Apply', 'Explain'] } });
      } else if (interactive && frame.t === 'ui-response') {
        setTimeout(() => {
          send(socket, { t: 'ui-request-end', reqId: frame.reqId });
          send(socket, { t: 'entry', entry: { type: 'custom_message', customType: 'fixture-result', id: `fixture-answer-${Date.now()}`, parentId: entry.id, timestamp: new Date().toISOString(), display: true, content: 'The independent local fixture received and decrypted your answer. No external OMP host was contacted.' } });
        }, 500);
      } else if (interactive && frame.t === 'prompt') {
        send(socket, { t: 'entry', entry: { ...entry, id: `fixture-prompt-${Date.now()}`, message: { role: 'user', content: frame.text, timestamp: Date.now() } } });
        send(socket, { t: 'entry', entry: { type: 'custom_message', customType: 'fixture-result', id: `fixture-reply-${Date.now()}`, parentId: entry.id, timestamp: new Date().toISOString(), display: true, content: 'Your prompt made the encrypted round trip to this synthetic loopback fixture. The native app is showing protocol data, not running a model.' } });
      }
    });
  });
  return {
    server, sockets, received, send, setReadOnly(value) { readOnly = value; },
    async link() { if (!server.address()) await new Promise(resolve => server.once('listening', resolve)); return `ws://127.0.0.1:${server.address().port}/r/${roomId}.${Buffer.concat([key, token]).toString('base64url')}`; },
    async close() { for (const socket of sockets) socket.terminate(); await new Promise(resolve => server.close(resolve)); },
  };
}

async function verifyDemo(SessionStore) {
  const store = new SessionStore();
  try {
    assert.equal(store.getSnapshot(), store.getSnapshot(), 'Snapshot is stable between updates');
    store.selectSession('mobile');
    store.sendPrompt('Investigate the composer');
    store.selectSession('design');
    const design = store.getSnapshot().messages.map(m => m.text).join('\n');
    await wait(300);
    assert.equal(store.getSnapshot().messages.map(m => m.text).join('\n'), design, 'Background chunks stay in their own thread');
    store.sendPrompt('Review this design');
    store.interrupt();
    store.selectSession('mobile');
    assert.equal(store.getSnapshot().isWorking, true, 'Interrupting a different thread preserves this job');
    await until(() => store.getSnapshot().pendingQuestion, 'demo choice');
    const choice = store.getSnapshot().pendingQuestion;
    store.answerQuestion('instructions', 'stale-question');
    assert.equal(store.getSnapshot().pendingQuestion.id, choice.id);
    store.answerQuestion('instructions', choice.id);
    const editor = store.getSnapshot().pendingQuestion;
    assert.equal(editor.kind, 'editor');
    store.answerQuestion('fix', choice.id);
    assert.equal(store.getSnapshot().pendingQuestion.id, editor.id);
    store.answerQuestion('Keep large text comfortable', editor.id);
    store.simulateDisconnect();
    const frozen = JSON.stringify(store.getSnapshot().messages);
    await wait(2000);
    assert.equal(JSON.stringify(store.getSnapshot().messages), frozen, 'Disconnected phone retains its last snapshot');
    store.reconnect();
    await until(() => store.getSnapshot().connection.status === 'demo', 'demo reconnect');
    await until(() => !store.getSnapshot().isWorking, 'demo completion');
    assert.equal(store.getSnapshot().messages.filter(m => m.text === 'Keep large text comfortable').length, 1, 'Reconnect never replays the answer');
    assert(store.getSnapshot().tools.some(t => t.detail === '3 simulated layout checks passed'));
    store.sendPrompt('Try again'); store.interrupt();
    const stopped = store.getSnapshot().messages.length;
    await wait(400);
    assert.equal(store.getSnapshot().messages.length, stopped, 'Cancelled timers cannot resume work');
    console.log('PASS demo: independent sessions, stale questions, editor, interrupt, offline catch-up');
  } finally { store.dispose(); }
}

async function verifyNewChat(SessionStore) {
  const store = new SessionStore();
  const fixture = startFixture();
  try {
    const first = store.getSnapshot();
    assert.equal(first.sessions[0].title, 'New chat');
    assert.equal(first.sessions[0].id, first.activeSessionId);
    assert.equal(first.capabilities.sessionCreation, true);
    assert.deepEqual(first.messages, []);
    assert.deepEqual(first.tools, []);
    assert.equal(first.pendingQuestion, null);

    const prompt = 'A long first message\nwith enough words to make the sidebar title shorter than the original prompt';
    store.sendPrompt(prompt);
    const working = store.getSnapshot();
    assert.equal(working.messages[0].text, prompt, 'Only the title normalizes whitespace and truncates');
    assert.equal(working.sessions[0].title, `${Array.from(prompt.replace(/\s+/g, ' ')).slice(0, 55).join('')}…`);
    assert.equal(working.isWorking, true);

    const secondId = store.startNewChat();
    assert(secondId && secondId !== first.activeSessionId);
    assert.equal(store.getSnapshot().activeSessionId, secondId);
    assert.equal(store.getSnapshot().sessions[0].id, secondId, 'Newest chat is first in sidebar history');
    assert.deepEqual(store.getSnapshot().messages, []);
    assert.deepEqual(store.getSnapshot().tools, []);
    assert.equal(store.getSnapshot().pendingQuestion, null);
    await wait(450);
    assert.deepEqual(store.getSnapshot().messages, [], 'An older response cannot stream into New chat');
    store.selectSession(first.activeSessionId);
    assert.equal(store.getSnapshot().isWorking, true, 'Starting a chat preserves work in the previous thread');
    assert(store.getSnapshot().messages.some(m => m.role === 'assistant' && m.text.length));
    store.interrupt();
    store.selectSession(secondId);

    store.simulateDisconnect();
    const offline = store.getSnapshot();
    assert.equal(store.startNewChat(), undefined);
    assert.equal(store.getSnapshot(), offline, 'Offline New chat is a no-op, including published state');
    store.useDemo();
    const reset = store.getSnapshot();
    assert.notEqual(reset.activeSessionId, first.activeSessionId);
    assert.notEqual(reset.activeSessionId, secondId, 'Reset does not reuse the namespace of a prior draft');
    assert.deepEqual(reset.messages, []);

    await store.connectCollab(await fixture.link());
    await until(() => store.getSnapshot().connection.status === 'live' && store.getSnapshot().pendingQuestion, 'single-session host');
    const live = store.getSnapshot();
    const receivedBefore = fixture.received.length;
    assert.equal(live.capabilities.sessionCreation, false);
    assert.equal(store.startNewChat(), undefined);
    assert.equal(store.getSnapshot(), live, 'New chat cannot clear or relabel the connected host transcript');
    await wait(100);
    assert.equal(fixture.received.length, receivedBefore, 'Unsupported session creation sends no host command');
    console.log('PASS New chat: blank startup, first-prompt title, unique draft namespaces, independent work, offline and live-host guards');
  } finally { store.dispose(); await fixture.close(); }
}

async function verifyCollab(createCollabDriver) {
  const fixture = startFixture();
  let driver;
  let state;
  try {
    const link = await fixture.link();
    driver = await createCollabDriver(link, 'Perch test', update => { state = update; });
    assert.equal(fixture.sockets.size, 0, 'Construction performs no network request');
    driver.connect();
    await until(() => state?.connection.status === 'live' && state.pendingQuestion, 'encrypted welcome and question');
    assert.equal(state.messages.length, 1, 'Snapshot duplicate IDs are deduplicated');
    driver.answerQuestion(state.pendingQuestion, '0');
    await until(() => fixture.received.some(f => f.t === 'ui-response'), 'encrypted answer');
    assert.equal(fixture.received.find(f => f.t === 'ui-response').value, 'Apply');
    assert.equal(state.pendingQuestion.answering, true, 'Question remains until host dismissal');
    fixture.send([...fixture.sockets][0], { t: 'ui-request-end', reqId: 9 });
    await until(() => state.pendingQuestion === null, 'authoritative dismissal');
    driver.sendPrompt('A real encrypted local fixture prompt');
    driver.interrupt();
    await until(() => fixture.received.some(f => f.t === 'prompt') && fixture.received.some(f => f.t === 'abort'), 'prompt and abort frames');
    const answersBefore = fixture.received.filter(f => f.t === 'ui-response').length;
    fixture.setReadOnly(true); driver.reconnect();
    await until(() => state?.readOnly && state.connection.status === 'live', 'read-only reconnect');
    assert.equal(state.messages.length, 1, 'Reconnect snapshot replaces and deduplicates history');
    const promptsBefore = fixture.received.filter(f => f.t === 'prompt').length;
    driver.sendPrompt('This must not be sent'); driver.interrupt();
    await wait(200);
    assert.equal(fixture.received.filter(f => f.t === 'prompt').length, promptsBefore, 'View-only prevents writes');
    assert.equal(fixture.received.filter(f => f.t === 'ui-response').length, answersBefore, 'Reconnect does not replay answers');
    console.log('PASS Collab: independent Node/OpenSSL host, encrypted handshake/frames, question acknowledgement, snapshot dedupe, read-only reconnect');
  } finally { driver?.close(); await fixture.close(); }
}

function verifyCollabMessageIdentity(projectCollab) {
  const timestamp = 1700000000000;
  const fence = String.fromCharCode(96).repeat(3);
  const partialText = fence + 'html filename="preview.html"\n<h1>Hello';
  const finalText = partialText + '</h1>\n' + fence;
  const assistant = (text, time = timestamp) => ({ role: 'assistant', content: [{ type: 'text', text }], timestamp: time });
  const entry = (id, message) => ({ type: 'message', id, parentId: null, timestamp: new Date(timestamp).toISOString(), message });
  const snapshot = {
    phase: 'live', endedReason: null, header: { id: 'identity-session' }, entries: [],
    state: { isStreaming: false }, agents: [], progress: new Map(), lifecycle: new Map(),
    stream: null, streamDone: false, activeTools: new Map(), working: false,
    readOnly: false, uiRequest: null, notices: [], loading: null,
  };
  const streaming = projectCollab({ ...snapshot, stream: assistant(partialText), working: true });
  const selectedMessageId = streaming.messages[0].id;
  assert.equal(streaming.messages[0].streaming, true);
  const finalEntry = entry('persisted-assistant', assistant(finalText));
  const completed = projectCollab({ ...snapshot, entries: [finalEntry], stream: finalEntry.message, streamDone: true });
  assert.equal(completed.messages.length, 1, 'Persisted response replaces its streaming ghost');
  assert.equal(completed.messages[0].id, selectedMessageId, 'OMP completion preserves the message identity used by an open artifact');
  assert.equal(completed.messages[0].text, finalText, 'Completion supplies the authoritative full contents');
  assert.equal(!!completed.messages[0].streaming, false, 'Persisted response is no longer streaming');
  const refreshed = projectCollab({ ...snapshot, entries: [finalEntry] });
  assert.deepEqual(refreshed.messages, completed.messages, 'Identity survives a later snapshot without its streaming ghost');
  const otherSession = projectCollab({ ...snapshot, header: { id: 'another-session' }, entries: [finalEntry] });
  assert.notEqual(otherSession.messages[0].id, selectedMessageId, 'Assistant timestamp identities are session-scoped');

  const collidingEntry = entry('same-timestamp-assistant', assistant('A distinct response at the same timestamp.'));
  const missingTimestamp = entry('without-timestamp', { role: 'assistant', content: [{ type: 'text', text: 'Older response without a timestamp.' }] });
  const otherMissingTimestamp = entry('another-without-timestamp', { role: 'assistant', content: [{ type: 'text', text: 'Another older response.' }] });
  const entries = [finalEntry, finalEntry, collidingEntry, missingTimestamp, otherMissingTimestamp];
  const history = projectCollab({ ...snapshot, entries });
  assert.equal(history.messages.length, 4, 'Duplicate entry IDs collapse, but distinct assistant entries all remain');
  assert.equal(new Set(history.messages.map(message => message.id)).size, 4, 'Timestamp collisions and missing timestamps cannot merge distinct responses');
  assert.equal(history.messages[0].id, selectedMessageId, 'Appending a timestamp collision leaves the original identity stable');
  assert.deepEqual(projectCollab({ ...snapshot, entries }).messages, history.messages, 'Historical identities are deterministic on refresh');
  const reorderedLegacy = projectCollab({ ...snapshot, entries: [otherMissingTimestamp, missingTimestamp] });
  assert.equal(reorderedLegacy.messages[0].id, history.messages[3].id, 'Missing timestamps use the persistent entry identity, not position');
  assert.equal(reorderedLegacy.messages[1].id, history.messages[2].id);
  console.log('PASS Collab identity: streaming completion, final snapshot, session scope, timestamp collisions and missing timestamps');
}

async function runVerification() {
  compile();
  const { SessionStore, sessionStore } = require(path.join(build, 'session/store.js'));
  const { createCollabDriver, projectCollab } = require(path.join(build, 'session/collab.js'));
  try {
    verifyCollabMessageIdentity(projectCollab);
    await verifyNewChat(SessionStore);
    await verifyDemo(SessionStore);
    await verifyCollab(createCollabDriver);
  } finally { sessionStore.dispose(); }
}

if (process.argv.includes('--fixture')) {
  fs.rmSync(build, { recursive: true, force: true });
  const fixture = startFixture(true);
  fixture.link().then(link => console.log(`Synthetic local fixture only:\n${link}`));
  const stop = () => fixture.close().then(() => process.exit(0));
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
} else {
  runVerification().then(() => { fs.rmSync(build, { recursive: true, force: true }); }, error => {
    fs.rmSync(build, { recursive: true, force: true });
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
