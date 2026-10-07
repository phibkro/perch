const { assert, wait, until, compile } = require('./helpers.cjs');
const { fixture } = require('./fixture.cjs');

async function main() {
  const code = compile(); const host = await fixture(); let driver; let state; const updates = [];
  const read = update => { state = update; updates.push(update); };
  const count = suffix => host.requests.filter(request => request.method === 'POST' && request.path.endsWith(suffix));
  const connected = label => until(() => state?.connection.status === 'live' && !state.sessionAction, label);
  async function reconnect(label) { driver.reconnect(); await connected(label); }
  try {
    const config = { url: host.url, token: host.token };
    assert.throws(() => code.validateDurableConnection({ ...config, url: 'http://192.168.1.4' }), /https/);
    assert.throws(() => code.validateDurableConnection({ ...config, url: 'http://localhost.example' }), /https/);
    for (const url of ['https://user:secret@host.example', 'https://host.example?token=x', 'https://host.example?', 'https://host.example#', 'https://@host.example']) assert.throws(() => code.validateDurableConnection({ ...config, url }), /separate/);
    assert.throws(() => code.validateDurableConnection({ ...config, token: 'short' }), /32/);
    assert.throws(() => code.validateDurableConnection({ ...config, token: `${host.token}\n` }), /whitespace/);
    assert.equal(code.validateDurableConnection({ ...config, url: ' https://host.example/base/ ' }).url, 'https://host.example/base');

    driver = await code.createDurableDriver(config, read); assert.equal(host.requests.length, 0, 'Construction opens no connection');
    driver.connect(); await connected('Authenticated durable snapshot');
    assert.equal(host.requests[0].path, '/perch/health'); assert(host.requests.every(request => request.authorized && !request.query));
    assert.equal(state.session.id, 'session_one'); assert.equal(state.messages[0].text, 'Saved history for session_one');
    assert.equal(state.availableModels.length, 2); assert(!JSON.stringify(state).includes('do-not-project')); assert.match(state.harness.name, /controlled test provider/);
    assert.equal(state.storedArtifacts.length, 1);

    driver.setModel('other', 'test-model'); await until(() => state.model?.provider === 'other' && state.capabilities.prompt, 'Host model selection');
    driver.sendPrompt('One authorized prompt'); driver.sendPrompt('Duplicate tap');
    await until(() => state.messages.some(message => message.text === 'One authorized prompt') && state.capabilities.prompt, 'Submission snapshot');
    assert.equal(count('/submit').length, 1); assert.equal(host.operations.size, 1);
    const posted = count('/submit').length; await reconnect('Reconnect without a new prompt'); assert.equal(count('/submit').length, posted);

    host.setSubmitMode('accepted-drop'); driver.sendPrompt('Receipt lost after acceptance');
    await until(() => state.messages.some(message => message.text === 'Receipt lost after acceptance') && state.capabilities.prompt, 'Ambiguous acceptance reconciled');
    const acceptedId = count('/submit').at(-1).body.operationId;
    assert(host.requests.some(request => request.path.endsWith(`/operations/${acceptedId}`)), 'Lost receipt is reconciled by operation GET');
    assert.equal(count('/submit').filter(request => request.body.operationId === acceptedId).length, 1, 'Accepted prompt is never replayed');

    host.setSubmitMode('unrecorded-drop'); driver.sendPrompt('Unrecorded original prompt');
    await until(() => state.messages.some(message => message.id.startsWith('durable-notice:')) && state.capabilities.prompt, 'Unknown operation keeps an explicit notice');
    const unknownId = count('/submit').at(-1).body.operationId; const beforeUnknownReconnect = count('/submit').length;
    await reconnect('Unknown operation reconnect'); assert.equal(count('/submit').length, beforeUnknownReconnect, 'Unknown prompt does not auto-submit on reconnect');
    assert(state.messages.some(message => message.id === `durable-notice:${unknownId}`));
    driver.sendPrompt('Unrecorded original prompt');
    await until(() => state.messages.some(message => message.text === 'Unrecorded original prompt') && state.capabilities.prompt, 'Explicit retry with original identity');
    assert.equal(count('/submit').at(-1).body.operationId, unknownId);
    assert.equal(state.messages.filter(message => message.text === 'Unrecorded original prompt').length, 1);
    assert(!state.messages.some(message => message.id === `durable-notice:${unknownId}`));

    const promptGate = host.delay('/perch/sessions/session_one/submit'); driver.sendPrompt('Reconnect while transport is unresolved');
    await until(() => promptGate.started, 'In-flight prompt reached fixture');
    await reconnect('Generation changes during send');
    const inFlightId = count('/submit').at(-1).body.operationId; const inFlightCount = count('/submit').length;
    promptGate.release(); await wait(120); await reconnect('Accepted late operation reconciles');
    assert.equal(count('/submit').length, inFlightCount); assert(host.operations.has(inFlightId));
    assert.equal(state.messages.filter(message => message.text === 'Reconnect while transport is unresolved').length, 1);

    const artifact = state.storedArtifacts[0]; assert.equal(await driver.loadArtifact(artifact), host.artifactText(), 'UTF-8 and BOM bytes round-trip with SHA-256');
    await assert.rejects(() => driver.loadArtifact({ ...artifact, id: '../escape' }), /invalid identifier/);
    await assert.rejects(() => driver.loadArtifact({ ...artifact, sessionId: 'session_two' }), /invalid artifact/);
    await assert.rejects(() => driver.loadArtifact({ ...artifact, sha256: '0'.repeat(64) }), /no longer/);
    host.setArtifactMode('hash'); await assert.rejects(() => driver.loadArtifact(artifact), /integrity/);
    host.setArtifactMode('length'); await assert.rejects(() => driver.loadArtifact(artifact), /integrity/);
    host.setArtifactMode('oversized'); await assert.rejects(() => driver.loadArtifact(artifact), /downloaded/);
    host.setArtifactMode('redirect'); await assert.rejects(() => driver.loadArtifact(artifact), /downloaded/); assert.equal(host.leaked.length, 0, 'Redirect destination receives no request or bearer token');
    host.setArtifactMode('normal');
    const bytes = Buffer.from(host.artifactText()); host.setArtifactBytes(Buffer.from([0xff, 0xfe])); await reconnect('Manifest for invalid UTF-8');
    await assert.rejects(() => driver.loadArtifact(state.storedArtifacts[0]), /UTF-8/);
    host.setArtifactBytes(bytes); await reconnect('Valid artifact restored');

    const artifactGate = host.delay('/perch/sessions/session_one/artifacts/artifact_one');
    const staleArtifact = driver.loadArtifact(state.storedArtifacts[0]); const staleAssertion = assert.rejects(() => staleArtifact, /selected session changed/);
    await until(() => artifactGate.started, 'Artifact download held'); driver.selectSession('session_two');
    await until(() => state.session.id === 'session_two' && !state.sessionAction, 'Session changes before artifact arrives');
    artifactGate.release(); await staleAssertion;
    assert.equal(state.messages[0].text, 'Saved history for session_two');

    driver.selectSession('session_one'); await until(() => state.session.id === 'session_one' && !state.sessionAction, 'Select first session');
    host.setWorking('session_one', true); await reconnect('Working session enables active polling');
    const oldRead = host.delay('/perch/sessions/session_one'); await until(() => oldRead.started, 'Old-session poll held');
    driver.selectSession('session_two'); await until(() => state.session.id === 'session_two' && !state.sessionAction, 'New selection publishes atomically');
    oldRead.release(503); await wait(120);
    assert.equal(state.connection.status, 'live', 'Stale failed read cannot disconnect the new selection'); assert.equal(state.session.id, 'session_two');
    host.setWorking('session_one', false);
    driver.selectSession('session_one'); await until(() => state.session.id === 'session_one' && !state.sessionAction, 'Select original again');
    host.setRecent(['session_two']); await reconnect('Selected history outside recent list');
    assert.equal(state.session.id, 'session_one'); assert(state.sessions.some(session => session.id === 'session_one'));
    const oldState = host.states.get('session_one'); host.states.delete('session_one'); driver.reconnect(); await until(() => state.connection.status === 'offline', 'Unavailable selected session');
    assert.equal(state.session.id, 'session_one'); assert.equal(state.messages[0].text, 'Saved history for session_one');
    host.states.set('session_one', oldState); await reconnect('Recover original selected session');

    host.setCreateMode('accepted-drop'); const createResult = await driver.createSession(); assert.equal(createResult, undefined);
    await until(() => state.connection.status === 'offline', 'Ambiguous create preserves old transcript');
    const createOperation = count('/sessions').at(-1).body.operationId; await reconnect('Recover exact create identity');
    assert.equal(count('/sessions').filter(request => request.body.operationId === createOperation).length, 2);
    assert.equal(host.creates.size, 1); assert.equal(state.session.id, 'created_1'); assert.equal(state.messages.length, 0);
    const secondCreated = await driver.createSession(); assert.equal(secondCreated, 'created_2'); assert.equal(host.creates.size, 2);

    const malformed = host.states.get('created_2'); malformed.storedArtifacts = [{ id: 'oops' }];
    driver.reconnect(); await until(() => state.connection.status === 'offline', 'Malformed metadata fails closed');
    assert.equal(state.session.id, 'created_2'); assert.deepEqual(state.storedArtifacts, []); assert.match(state.connection.error, /invalid/);
    malformed.storedArtifacts = []; await reconnect('Metadata repaired');
    const originalMessages = malformed.messages; malformed.messages = [{ id: 'duplicate', role: 'assistant', text: 'First', createdAt: 1 }, { id: 'duplicate', role: 'assistant', text: 'Second', createdAt: 1 }];
    driver.reconnect(); await until(() => state.connection.status === 'offline', 'Duplicate message IDs rejected');
    assert.deepEqual(state.messages, []); malformed.messages = originalMessages;

    driver.close(); host.setRecent([]);
    const store = new code.SessionStore();
    try {
      await store.connectDurable(config); await until(() => store.getSnapshot().connection.status === 'live', 'Store connects to empty workspace');
      assert.equal(store.getSnapshot().readOnly, false); assert.equal(store.getSnapshot().capabilities.prompt, false); assert.equal(store.getSnapshot().mode, 'durable');
      const beforeEmptySubmit = count('/submit').length; store.sendPrompt('Must not target a placeholder'); await wait(20); assert.equal(count('/submit').length, beforeEmptySubmit);
      const id = await store.createSession(); assert(id); assert.equal(store.getSnapshot().activeSessionId, id);
      store.sendPrompt('Store-issued durable prompt'); await until(() => store.getSnapshot().messages.some(message => message.text === 'Store-issued durable prompt'), 'Store delegates prompt');
      const oldEpoch = store.getSnapshot().connectionEpoch; store.useDemo(); assert.notEqual(store.getSnapshot().connectionEpoch, oldEpoch);
    } finally { store.dispose(); }

    driver = await code.createDurableDriver({ ...config, token: 'wrong-token-that-is-long-enough-for-validation' }, read); driver.connect(); await until(() => state.connection.status === 'error', 'Wrong bearer rejected');
    assert(!JSON.stringify(state).includes(host.token)); assert.match(state.connection.error, /credentials/); driver.close();
    for (const mode of ['wrong', 'oversized', 'redirect']) {
      host.setHealthMode(mode); const before = host.requests.length;
      driver = await code.createDurableDriver(config, read); driver.connect(); await until(() => state.connection.status === 'error', `Handshake rejects ${mode}`);
      assert.deepEqual(host.requests.slice(before).map(request => request.path), ['/perch/health']); driver.close();
    }
    assert.equal(host.leaked.length, 0); assert(!JSON.stringify(updates).includes(host.token));
    console.log('PASS durable driver: bearer auth; bounded/validated snapshots; host models; explicit create/history/select; operation-ID reconciliation and exact deliberate retry; generation/selection guards; scoped UTF-8/SHA-256 artifact downloads; redirect refusal; empty-history store integration.');
  } finally { driver?.close(); await host.close(); code.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
