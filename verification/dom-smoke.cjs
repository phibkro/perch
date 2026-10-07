const nodeUtil = require('node:util');
const nodeCrypto = require('node:crypto');
const webStreams = require('node:stream/web');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { JSDOM, VirtualConsole, ResourceLoader } = require('jsdom');
const errors = [], cssLimitations = [], logs = [], blocked = [], checks = [], copied = [];

/** Synthetic OpenCode protocol responses, entirely in memory. This fixture does
 * not open a socket, authenticate against a real host, or call a model. Unknown
 * URLs are denied; there is deliberately no fallback to Node's real fetch. */
function createOpenCodeFixture({ origin, title, providers, password }) {
  const directory = '/synthetic/perch';
  const authorization = `Basic ${Buffer.from(`fixture-user:${password}`).toString('base64')}`;
  const calls = [], streams = new Set(), transcripts = new Map(), pendingQuestions = [];
  let enabled = false, revision = 10, created = 0;
  const sessions = [
    { id: 'fixture-plan', title, directory, time: { updated: 10 }, model: { providerID: providers[0], id: 'shared' } },
    { id: 'fixture-notes', title: 'Fixture notes', directory, time: { updated: 9 }, model: { providerID: providers.at(-1), id: 'shared' } },
  ];
  const entry = (sessionID, role, content, model, suffix) => {
    const id = `${sessionID}-${suffix}`;
    return { info: { id, sessionID, role, time: { created: ++revision, ...(role === 'assistant' ? { completed: revision } : {}) }, ...(role === 'user' ? { model: { providerID: model.provider, modelID: model.id } } : { providerID: model.provider, modelID: model.id }) }, parts: [{ id: `${id}-text`, sessionID, messageID: id, type: 'text', text: content }] };
  };
  for (const session of sessions) transcripts.set(session.id, [entry(session.id, 'assistant', `${session.title}: synthetic host history.`, { provider: session.model.providerID, id: 'shared' }, 'seed')]);
  const catalog = {
    connected: providers, default: {},
    all: [...providers.map(provider => ({ id: provider, models: {
      shared: { id: 'shared', name: 'Shared assistant' },
      ...Object.fromEntries(Array.from({ length: providers.length > 1 ? 60 : 0 }, (_, index) => {
        const number = String(index).padStart(3, '0');
        return [`synthetic-${number}`, { id: `synthetic-${number}`, name: `Synthetic ${number}` }];
      })),
    } })), { id: 'unconnected', models: { hidden: { id: 'hidden', name: 'Unavailable model' } } }],
  };
  const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
  const emit = event => { for (const stream of streams) stream.enqueue(new nodeUtil.TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)); };
  return {
    origin, directory, calls, get created() { return created; }, enable() { enabled = true; },
    askCustomQuestion(sessionID) {
      const question = { id: 'fixture-custom-question', sessionID, questions: [{ header: 'Fixture decision', question: 'How should the synthetic host continue?', custom: true, multiple: false, options: [{ label: 'Keep current plan', description: 'Use the existing approach.' }] }] };
      pendingQuestions.push(question); emit({ type: 'question.asked', properties: question });
      return question.id;
    },
    matches(value) { try { return enabled && new URL(String(value)).origin === origin; } catch { return false; } },
    async fetch(value, init = {}) {
      const url = new URL(String(value)), method = init.method || 'GET';
      const headers = new Headers(init.headers);
      assert.equal(headers.get('authorization'), authorization, 'synthetic server receives the configured Basic credentials');
      assert.equal(url.searchParams.get('directory'), directory, 'synthetic requests keep the configured workspace directory');
      assert.equal(url.username, ''); assert.equal(url.password, '');
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ method, path: url.pathname, body });
      if (method === 'GET' && url.pathname === '/perch/health') return json({ protocol: 'perch-opencode', version: 1, healthy: true, upstreamVersion: 'synthetic-dom-fixture', directory });
      if (method === 'GET' && url.pathname === '/provider') return json(catalog);
      if (method === 'GET' && url.pathname === '/event') {
        let controller;
        const body = new webStreams.ReadableStream({
          start(stream) { controller = stream; streams.add(stream); stream.enqueue(new nodeUtil.TextEncoder().encode('data: {"type":"server.connected","properties":{}}\n\n')); },
          cancel() { streams.delete(controller); },
        });
        init.signal?.addEventListener('abort', () => { if (streams.delete(controller)) controller.close(); }, { once: true });
        return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
      }
      if (method === 'GET' && url.pathname === '/session') return json(sessions);
      if (method === 'GET' && url.pathname === '/session/status') return json(Object.fromEntries(sessions.map(session => [session.id, { type: 'idle' }])));
      if (method === 'GET' && url.pathname === '/permission') return json([]);
      if (method === 'GET' && url.pathname === '/question') return json(pendingQuestions);
      const reply = url.pathname.match(/^\/question\/([^/]+)\/reply$/);
      if (method === 'POST' && reply) {
        const index = pendingQuestions.findIndex(question => question.id === reply[1]);
        assert.notEqual(index, -1, 'synthetic question is still pending');
        const [question] = pendingQuestions.splice(index, 1);
        emit({ type: 'question.replied', properties: { sessionID: question.sessionID, requestID: question.id, answers: body.answers } });
        return json(true);
      }
      if (method === 'POST' && url.pathname === '/session') {
        assert.deepEqual(body, {});
        const session = { id: `fixture-created-${++created}`, title: 'New chat', directory, time: { updated: ++revision } };
        sessions.unshift(session); transcripts.set(session.id, []); return json(session);
      }
      const transcript = url.pathname.match(/^\/session\/([^/]+)\/message$/);
      if (method === 'GET' && transcript && transcripts.has(transcript[1])) return json(transcripts.get(transcript[1]));
      const prompt = url.pathname.match(/^\/session\/([^/]+)\/prompt_async$/);
      if (method === 'POST' && prompt && transcripts.has(prompt[1])) {
        const model = { provider: body.model?.providerID || providers[0], id: body.model?.modelID || 'shared' };
        const content = body.parts.map(part => part.text).join('\n');
        transcripts.get(prompt[1]).push(entry(prompt[1], 'user', content, model, `user-${revision}`), entry(prompt[1], 'assistant', 'Synthetic OpenCode response. No model was called.', model, `reply-${revision}`));
        emit({ type: 'message.updated', properties: {} });
        return new Response(null, { status: 204 });
      }
      blocked.push(`unimplemented-fixture:${method}:${url.pathname}`);
      throw Error(`Unimplemented synthetic OpenCode route: ${method} ${url.pathname}`);
    },
  };
}
const openCode = createOpenCodeFixture({ origin: 'https://perch-opencode.invalid', title: 'Fixture planning', providers: ['alpha', 'beta'], password: 'fixture-password' });
const secondOpenCode = createOpenCodeFixture({ origin: 'https://perch-second-host.invalid', title: 'Second host planning', providers: ['delta'], password: 'second-fixture-password' });

/** Durable HTTP wire fixture only. The exported app still performs its actual
 * manifest projection, authenticated requests, byte/hash checks, and rendering.
 * Held responses expose loading UI without introducing a real network path. */
function createDurableFixture() {
  const origin = 'https://perch-durable.invalid';
  const token = 'synthetic-durable-workspace-token-32-characters';
  const calls = [], sessions = [], transcripts = new Map(), operations = new Map();
  const held = new Map(), corruptOnce = new Set();
  const models = [{ provider: 'fixture', id: 'controlled', name: 'Controlled fixture model' }];
  const capabilities = { prompt: true, interrupt: true, questions: false, steer: false, attachments: false, modelSelection: true, sessionSelection: true, sessionCreation: true };
  const files = [
    { id: 'saved-markdown', filename: 'saved-report.md', title: 'Saved report', mimeType: 'text/markdown', language: 'markdown', sourceId: 'tool:fixture-write-md',
      content: '# Durable fixture document\n\nExact saved Markdown with æ, ø, and å.\n\n- Read after reconnect\n- Keep the original bytes\n' },
    { id: 'saved-html', filename: 'saved-page.html', title: 'Saved page', mimeType: 'text/html', language: 'html', sourceId: 'tool:fixture-write-html',
      content: '<!doctype html><html><body><h1>Durable saved page</h1><button onclick="this.textContent=\'Clicked\'">Hello</button><script>document.body.dataset.fixture = "inline";</script></body></html>' },
    { id: 'saved-code', filename: 'saved-example.ts', title: 'Saved code', mimeType: 'text/plain', language: 'typescript', sourceId: 'tool:fixture-write-code',
      content: 'export const durableFixture = (name: string): string => `Hello, ${name}`;\n' },
  ];
  let enabled = false, created = 0;
  const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
  const manifests = sessionId => files.map(({ content, ...metadata }) => ({ ...metadata, sessionId, bytes: Buffer.byteLength(content), sha256: nodeCrypto.createHash('sha256').update(content).digest('hex'), createdAt: 42 }));
  const snapshot = session => {
    const messages = transcripts.get(session.id);
    return { protocol: 1, operations: [...operations.values()].filter(operation => operation.sessionId === session.id).map(({ operationId, status }) => ({ operationId, status })), state: {
      harness: { id: 'pi-durable', name: 'Pi Durable', transport: 'durable-http', version: 'synthetic-dom-fixture' },
      capabilities, connection: { status: 'live', label: 'Synthetic durable fixture' }, session, model: models[0], availableModels: models,
      messages, tools: messages.length ? files.map(file => ({ id: file.sourceId.slice('tool:'.length), name: 'write_artifact', label: `Save ${file.filename}`, detail: 'Saved by the in-memory protocol fixture.', status: 'done' })) : [],
      storedArtifacts: messages.length ? manifests(session.id) : [], pendingQuestion: null, agents: [], isWorking: false, readOnly: false,
    } };
  };
  return {
    origin, token, calls, files, get created() { return created; }, enable() { enabled = true; },
    hold(id) { let release; const promise = new Promise(resolve => { release = resolve; }); held.set(id, { promise, release }); },
    release(id) { const gate = held.get(id); assert.ok(gate, 'held artifact response exists'); held.delete(id); gate.release(); },
    corruptNext(id) { corruptOnce.add(id); },
    artifactCalls() { return calls.filter(call => call.path.includes('/artifacts/')); },
    matches(value) { try { return enabled && new URL(String(value)).origin === origin; } catch { return false; } },
    async fetch(value, init = {}) {
      const url = new URL(String(value)), method = init.method || 'GET';
      assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${token}`, 'durable UI uses its configured workspace token');
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ method, path: url.pathname, body });
      if (method === 'GET' && url.pathname === '/perch/health') return json({ service: 'perch-durable', protocol: 1, harness: { name: 'Pi Durable', version: 'synthetic-dom-fixture' }, models, synthetic: true });
      if (method === 'GET' && url.pathname === '/perch/sessions') return json({ sessions });
      if (method === 'POST' && url.pathname === '/perch/sessions') {
        assert.match(body.operationId, /^op_[A-Za-z0-9_-]+$/);
        const session = { id: `durable-fixture-${++created}`, title: 'New chat', project: 'Synthetic durable workspace', status: 'idle' };
        sessions.unshift(session); transcripts.set(session.id, []);
        return json({ session, accepted: true });
      }
      const route = url.pathname.match(/^\/perch\/sessions\/([^/]+)(?:\/(submit|artifacts)(?:\/([^/]+))?)?$/);
      const session = route && sessions.find(candidate => candidate.id === route[1]);
      if (session && method === 'GET' && !route[2]) return json(snapshot(session));
      if (session && method === 'POST' && route[2] === 'submit') {
        assert.equal(transcripts.get(session.id).length, 0, 'fixture expects one submitted prompt per chat');
        session.title = 'Saved fixture workspace';
        transcripts.get(session.id).push({ id: 'durable-user', role: 'user', text: body.text, createdAt: 40 }, { id: 'durable-answer', role: 'assistant', text: 'Your saved fixture files are ready.', createdAt: 41 });
        operations.set(body.operationId, { operationId: body.operationId, sessionId: session.id, status: 'done' });
        return json({ operationId: body.operationId, session: session.id, accepted: true });
      }
      if (session && method === 'GET' && route[2] === 'artifacts') {
        const file = files.find(candidate => candidate.id === route[3]);
        assert.ok(file && transcripts.get(session.id).length, 'requested artifact belongs to the selected fixture session');
        const gate = held.get(file.id); if (gate) await gate.promise;
        const bytes = Buffer.from(file.content);
        if (corruptOnce.delete(file.id)) bytes[0] ^= 1; // Same length; SHA-256 must catch it.
        return new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.length), 'X-Content-Type-Options': 'nosniff' } });
      }
      blocked.push(`unimplemented-durable-fixture:${method}:${url.pathname}`);
      throw Error(`Unimplemented synthetic durable route: ${method} ${url.pathname}`);
    },
  };
}
const durable = createDurableFixture();

class NoResources extends ResourceLoader {
  fetch(url) { blocked.push(`resource:${url}`); return null; }
}
const vc = new VirtualConsole();
vc.on('jsdomError', e => {
  if (e.type === 'css parsing') cssLimitations.push(e.message);
  else errors.push(String(e.stack || e));
});
for (const k of ['warn', 'error']) vc.on(k, (...a) => logs.push([k, ...a.map(String)]));
const previewPath = process.argv.slice(2).find(argument => !argument.startsWith('--')) || require('node:path').resolve(__dirname, '../../outputs/perch-prototype.html');
const dom = new JSDOM(fs.readFileSync(previewPath, 'utf8'), {
  runScripts: 'dangerously', resources: new NoResources(), virtualConsole: vc, pretendToBeVisual: true,
  beforeParse(w) {
    w.TextEncoder = nodeUtil.TextEncoder; w.TextDecoder = nodeUtil.TextDecoder;
    // Node WebCrypto supplies real SHA-256 for the web driver's integrity check.
    Object.defineProperty(w, 'crypto', { value: nodeCrypto.webcrypto });
    // These dimensions select responsive branches; jsdom still does not lay out pixels.
    w.visualViewport = { width: 412, height: 844, scale: 1,
      addEventListener: (...args) => w.addEventListener(...args),
      removeEventListener: (...args) => w.removeEventListener(...args),
    };
    Object.assign(w, webStreams);
    // Data containers only; the optional fetch fixture below has no network path.
    w.Response = globalThis.Response; w.Request = globalThis.Request; w.Headers = globalThis.Headers;
    // jsdom uses plain arrays for rule lists and omits this browser constructor.
    // These shims let Uniwind initialize; they do not validate CSS or layout.
    w.CSSRuleList = class { static [Symbol.hasInstance](value) { return Array.isArray(value); } };
    w.CSS = { ...(w.CSS || {}), supports: () => false,
      escape: value => String(value).replace(/[^a-zA-Z0-9_-]/g, character => `\\${character.codePointAt(0).toString(16)} `).replace(/^([0-9])/, character => `\\3${character} `),
    };
    Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: async value => { copied.push(value); } } });
    const deny = k => function () { blocked.push(k); throw Error(`${k} disabled in DOM test`); };
    for (const k of ['XMLHttpRequest', 'WebSocket', 'EventSource', 'Worker', 'SharedWorker']) w[k] = deny(k);
    w.fetch = (url, init) => {
      const fixture = [openCode, secondOpenCode, durable].find(candidate => candidate.matches(url));
      return fixture ? fixture.fetch(url, init) : deny('fetch')();
    };
    w.navigator.sendBeacon = deny('sendBeacon');
    w.matchMedia = q => ({ matches: false, media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
    w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
    w.scrollTo = () => {};
  },
});
const doc = dom.window.document, pause = ms => new Promise(r => setTimeout(r, ms));
const text = () => [...doc.querySelectorAll('body > div')].map(e => e.textContent).join('\n');
const byLabel = l => doc.querySelector(`[aria-label="${l}"]`);
const byText = t => [...doc.querySelectorAll('button,[role=button]')].find(x => x.textContent.trim() === t);
const byTab = t => [...doc.querySelectorAll('[role=tab]')].find(x => x.textContent.trim() === t);
async function waitFor(test, label, timeout = 16000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (errors.length) throw Error(`Runtime error while waiting for ${label}`);
    if (test()) { checks.push(label); return; }
    await pause(60);
  }
  throw Error(`Timed out: ${label}`);
}
async function press(el) {
  assert.ok(el, 'control exists'); el.click(); await pause(90);
  // jsdom never runs CSS keyframes. Complete the React Native Web modal's
  // transition explicitly; this verifies dismissal state, not its animation.
  for (const element of doc.querySelectorAll('div')) {
    const style = dom.window.getComputedStyle(element);
    if (style.position === 'fixed' && style.animationDuration === '300ms') {
      element.dispatchEvent(new dom.window.Event('animationend', { bubbles: true }));
    }
  }
  await pause(30);
}
async function showSidebar() {
  if (!doc.querySelector('[data-testid="chat-sidebar"]')) await press(byLabel('Open sidebar'));
}
async function openHistory(title) {
  await showSidebar(); await press(byLabel(`Open ${title}`));
}
async function input(el, value) {
  assert.ok(el, 'input exists');
  el.focus();
  const prototype = el.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value').set.call(el, value);
  el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await pause(90);
}
(async () => {
  try {
    await waitFor(() => doc.querySelector('[data-testid="new-chat-welcome"]') && byLabel('Message to assistant'), 'startup opens an empty New chat with a composer');
    if (process.argv.includes('--connection-only')) {
      await press(byLabel('Connect a workspace'));
      await waitFor(() => byTab('Pi Durable') && byLabel('Pi Durable access token'), 'connection sheet defaults to Pi Durable');
      const tabs = ['Pi Durable', 'OMP Collab', 'pi bridge', 'OpenCode'];
      assert.equal(byTab('Pi Durable').getAttribute('aria-selected'), 'true');
      for (const selected of ['OMP Collab', 'pi bridge', 'OpenCode', 'Pi Durable']) {
        await press(byTab(selected));
        for (const label of tabs) assert.equal(byTab(label).getAttribute('aria-selected'), String(label === selected));
      }
      checks.push('all four connection tabs expose exactly one selected accessibility state');
      assert.deepEqual(errors, []); assert.deepEqual(logs.filter(entry => entry[0] === 'error'), []); assert.deepEqual(blocked, []);
      assert.equal(openCode.calls.length + secondOpenCode.calls.length + durable.calls.length, 0);
      console.log(JSON.stringify({ result: 'PASS (focused connection DOM check only; no network)', checks, errors, cssLimitations, logs, blocked }, null, 2));
      return;
    }
    assert.equal(byLabel('Message to assistant').value, '');
    assert.ok(text().includes('What would you like to do?'));
    assert.equal(doc.querySelector('[role="tab"]'), null);
    assert.equal(byLabel('Sessions'), null);
    const dock = doc.querySelector('[data-testid="chat-composer-dock"]');
    assert.equal(dock.parentElement.lastElementChild, dock);
    checks.push('composer is the thread footer and no bottom navigation is rendered (structure only)');
    await input(byLabel('Message to assistant'), 'A fresh chat draft');
    assert.notEqual(byLabel('Send message').getAttribute('aria-disabled'), 'true', 'typing reaches the composer runtime before navigation');
    await showSidebar();
    await waitFor(() => doc.querySelector('[data-testid="mobile-sidebar"]'), 'phone menu opens a modal sidebar');
    assert.ok(byLabel('Open Mobile companion')); assert.ok(byLabel('Open A workspace you can preview'));
    const firstChat = byLabel('Open New chat').getAttribute('data-testid');
    await press(byLabel('Close sidebar'));
    await waitFor(() => !doc.querySelector('[data-testid="mobile-sidebar"]'), 'sidebar close button returns to the chat');
    assert.equal(byLabel('Message to assistant').value, 'A fresh chat draft');
    await showSidebar(); await press(byLabel('Dismiss sidebar'));
    await waitFor(() => !doc.querySelector('[data-testid="mobile-sidebar"]'), 'sidebar backdrop dismisses the drawer');
    await press(byLabel('Start a new chat'));
    await waitFor(() => byLabel('Message to assistant').value === '', 'New chat creates an independent empty draft');
    await showSidebar(); await press(doc.querySelector(`[data-testid="${firstChat}"]`));
    assert.equal(byLabel('Message to assistant').value, 'A fresh chat draft'); checks.push('history restores the previous New chat draft');
    await input(byLabel('Message to assistant'), 'Plan a calm morning'); await press(byLabel('Send message'));
    await waitFor(() => doc.querySelector('[data-testid="chat-header"]').textContent.includes('Plan a calm morning'), 'first prompt becomes the new chat title');
    await waitFor(() => byLabel('Stop generating'), 'new chat starts the assistant-ui run'); await press(byLabel('Stop generating'));

    // Exercise the persistent branch with the same live UI state.
    dom.window.visualViewport.width = 1200; dom.window.dispatchEvent(new dom.window.Event('resize')); await pause(150);
    assert.ok(doc.querySelector('[data-testid="chat-sidebar"]')); assert.equal(byLabel('Open sidebar'), null);
    checks.push('wide layout exposes persistent history without a drawer button');
    dom.window.visualViewport.width = 412; dom.window.dispatchEvent(new dom.window.Event('resize')); await pause(150);
    assert.equal(doc.querySelector('[data-testid="chat-sidebar"]'), null);
    checks.push('phone layout returns to a closed drawer');

    await openHistory('Mobile companion'); await waitFor(() => byText('Try a demo turn'), 'history selection opens the existing conversation');
    assert.equal(doc.querySelector('[data-testid="mobile-sidebar"]'), null); checks.push('history selection closes the drawer');
    await press(byText('Try a demo turn')); await waitFor(() => text().includes('writing'), 'rendered streaming indicator');
    await waitFor(() => byLabel('Answer agent question'), 'question banner after demo stream');
    await press(byLabel('Expand Inspect composer layout')); assert.ok(text().includes('Keyboard inset: 24 px')); checks.push('tool card expands to output');
    await press(byLabel('Answer agent question')); await waitFor(() => byLabel('Add instructions'), 'choice modal opens');
    await press(byLabel('Add instructions')); assert.equal(doc.querySelector('[data-testid="send-answer"]').disabled, false); checks.push('choice enables answer submission');
    await press(doc.querySelector('[data-testid="send-answer"]')); await pause(150);
    await press(byLabel('Answer agent question')); await waitFor(() => byLabel('Answer to agent'), 'choice leads to editor question');
    await input(byLabel('Answer to agent'), 'Keep the composer above the keyboard.');
    const sendAnswer = doc.querySelector('[data-testid="send-answer"]'); assert.equal(sendAnswer.disabled, false); await press(sendAnswer);
    await waitFor(() => !byLabel('Answer to agent'), 'editor answer closes modal');
    await showSidebar(); await press(byLabel('Connection'));
    await waitFor(() => byText('Simulate a connection drop'), 'connection screen'); await press(byText('Simulate a connection drop'));
    await waitFor(() => byText('Retry'), 'offline demo banner'); const frozen = text(); await pause(2600);
    assert.equal(text(), frozen); checks.push('offline DOM snapshot remains frozen');
    await press(byText('Retry')); await waitFor(() => !byText('Retry'), 'reconnect exits offline state');
    await waitFor(() => text().includes('Your real workspace has not been changed.'), 'reconnect catches up to demo completion');
    await input(byLabel('Message to assistant'), 'Draft retained across screens');
    await openHistory('A calmer mobile workspace'); assert.equal(byLabel('Message to assistant').value, ''); checks.push('second session has separate draft');
    await openHistory('Mobile companion');
    assert.equal(byLabel('Message to assistant').value, 'Draft retained across screens'); checks.push('first session draft restored after navigation');

    await input(byLabel('Message to assistant'), 'A message through the assistant-ui composer');
    assert.notEqual(byLabel('Send message').getAttribute('aria-disabled'), 'true');
    await press(byLabel('Send message'));
    await waitFor(() => text().includes('A message through the assistant-ui composer'), 'assistant-ui composer submits into the authoritative transcript');
    assert.equal(byLabel('Message to assistant').value, ''); checks.push('assistant-ui composer clears a sent draft');
    await waitFor(() => byLabel('Stop generating'), 'assistant-ui exposes interruption while working');
    await press(byLabel('Stop generating'));
    await waitFor(() => text().includes('Demo work interrupted.'), 'assistant-ui interruption reaches the demo host');

    await openHistory('A workspace you can preview');
    await waitFor(() => byLabel('Open artifact mobile-workspace.md'), 'artifact cards are attached to the assistant message');
    await press(byLabel('Open artifact mobile-workspace.md'));
    await waitFor(() => doc.querySelector('[data-testid="artifact-markdown"]'), 'Markdown artifact opens in the document workspace');
    assert.ok(text().includes('A calmer mobile workspace')); checks.push('Markdown content is rendered');
    await press(byLabel('Artifact source'));
    await waitFor(() => byLabel('Source code, markdown'), 'Markdown source tab exposes original text');
    assert.ok(byLabel('Source code, markdown').textContent.startsWith('# A calmer mobile workspace'));
    await press(byLabel('Copy artifact'));
    await waitFor(() => copied.length > 0, 'Copy artifact uses the stubbed clipboard');
    assert.equal(copied.at(-1), byLabel('Source code, markdown').textContent); checks.push('copied artifact matches complete source');
    await press(byLabel('Back to artifacts'));
    await press(byLabel('Open artifact workspace-card.html'));
    await waitFor(() => doc.querySelector('iframe[data-testid="artifact-html"]'), 'HTML artifact creates a separate preview element');
    let frame = doc.querySelector('iframe[data-testid="artifact-html"]');
    assert.equal(frame.getAttribute('sandbox'), '');
    assert.equal(frame.getAttribute('referrerpolicy'), 'no-referrer');
    assert.ok(frame.getAttribute('srcdoc').includes('Content-Security-Policy'));
    assert.ok(frame.getAttribute('srcdoc').includes("default-src 'none'"));
    checks.push('HTML preview declares sandbox, no-referrer and restrictive CSP (attributes only)');
    await press(byLabel('HTML interaction'));
    frame = doc.querySelector('iframe[data-testid="artifact-html"]');
    assert.equal(frame.getAttribute('sandbox'), 'allow-scripts');
    assert.ok(!frame.getAttribute('sandbox').includes('allow-same-origin'));
    checks.push('HTML interaction changes only the declared script sandbox allowance');
    await press(byLabel('Artifact source'));
    assert.ok(byLabel('Source code, html').textContent.includes('<!doctype html>'));
    checks.push('HTML source remains inspectable as text');
    await press(byLabel('Back to artifacts')); await press(byLabel('Open artifact connection-label.ts'));
    await waitFor(() => byLabel('Source code, typescript'), 'TypeScript artifact opens as source');
    const code = byLabel('Source code, typescript');
    assert.ok(code.textContent.includes('export function connectionLabel'));
    assert.ok(code.querySelector('span[style*="color"]'), 'syntax tokens are rendered into text spans');
    // React Native Web emits selectable native Text using userSelect: text.
    assert.equal(dom.window.getComputedStyle(code).userSelect, 'text', 'source declares selectable Text semantics');
    checks.push('TypeScript syntax tokens and selectable-text semantics are present');
    await press(byLabel('Toggle line wrapping')); checks.push('source wrapping toggle responds');
    await press(byLabel('Back to chat'));
    await press(byText('Open as document'));
    await waitFor(() => doc.querySelector('[data-testid="artifact-markdown"]'), 'complete assistant answer opens as a document');

    // The original demo/artifact flow never touches a transport. Everything
    // below runs the real phone adapter against an in-memory protocol fixture.
    assert.equal(openCode.calls.length + secondOpenCode.calls.length, 0);
    await press(byLabel('Back to chat')); await showSidebar(); await press(byText('Connect a workspace'));
    await waitFor(() => byTab('OpenCode'), 'connection sheet includes a separate OpenCode tab');
    assert.ok(byTab('OMP Collab')); assert.ok(byTab('pi bridge')); assert.ok(byTab('Pi Durable'));
    assert.ok(byLabel('Durable server URL')); assert.equal(byLabel('Pi Durable access token').type, 'password');
    assert.equal(byLabel('Participant name'), null);
    checks.push('Pi Durable is the default connection tab with separate URL and masked access token');
    await press(byTab('OpenCode'));
    assert.ok(byLabel('OpenCode server URL')); assert.ok(byLabel('OpenCode workspace directory'));
    assert.equal(byLabel('OpenCode username').value, 'perch');
    assert.equal(byLabel('OpenCode server password').type, 'password');
    assert.equal(byLabel('Participant name'), null);
    assert.equal(doc.querySelector('[data-testid="join-session"]').disabled, true);
    checks.push('OpenCode shows server Basic-auth fields and an optional host directory');
    await input(byLabel('OpenCode server URL'), openCode.origin);
    await input(byLabel('OpenCode server password'), 'fixture-password');
    await input(byLabel('OpenCode workspace directory'), openCode.directory);
    await press(byTab('pi bridge'));
    assert.equal(byLabel('pi bridge access token').value, '');
    await press(byTab('OpenCode'));
    assert.equal(byLabel('OpenCode server URL').value, '');
    assert.equal(byLabel('OpenCode server password').value, '');
    assert.equal(byLabel('OpenCode workspace directory').value, '');
    checks.push('switching harness tabs clears the endpoint, password and directory');
    await input(byLabel('OpenCode server URL'), openCode.origin);
    await input(byLabel('OpenCode username'), 'fixture-user');
    await input(byLabel('OpenCode server password'), 'fixture-password');
    await input(byLabel('OpenCode workspace directory'), openCode.directory);
    openCode.enable();
    await press(doc.querySelector('[data-testid="join-session"]'));
    await waitFor(() => doc.querySelector('[data-testid="chat-header"]').textContent.includes('Fixture planning') && byLabel('Choose a model'), 'synthetic OpenCode gateway connection loads the host chat and catalog');
    assert.equal(openCode.calls[0].path, '/perch/health');
    assert.ok(openCode.calls.some(call => call.path === '/provider'));
    assert.ok(text().includes('Fixture planning: synthetic host history.'));
    checks.push('phone adapter checks gateway identity before loading synthetic display metadata');
    await input(byLabel('Message to assistant'), 'Planning-only draft');
    await openHistory('Fixture notes');
    await waitFor(() => text().includes('Fixture notes: synthetic host history.'), 'OpenCode sidebar selection loads the other host transcript');
    assert.equal(byLabel('Message to assistant').value, '');
    await input(byLabel('Message to assistant'), 'Notes-only draft');
    await openHistory('Fixture planning');
    await waitFor(() => byLabel('Message to assistant').value === 'Planning-only draft', 'OpenCode session drafts stay independent when navigating host history');

    await press(byLabel('Choose a model'));
    await waitFor(() => byLabel('Search models and providers') && doc.querySelector('[role="radio"]'), 'model picker opens the synthetic connected-provider catalog');
    assert.ok(text().includes('122 of 122 models'));
    assert.equal(byLabel('Filter provider unconnected'), null);
    const initialRows = doc.querySelectorAll('[role="radio"]').length;
    assert.ok(initialRows > 0 && initialRows < 122, 'initial virtualized list renders only a subset of the synthetic catalog');
    checks.push('catalog lists connected providers and initially renders fewer rows than its full size (DOM only)');
    await input(byLabel('Search models and providers'), 'shared');
    await waitFor(() => doc.querySelectorAll('[role="radio"]').length === 2, 'model search exposes matching names across providers');
    assert.equal(byLabel('Shared assistant · alpha').getAttribute('aria-checked'), 'true');
    assert.equal(byLabel('Shared assistant · beta').getAttribute('aria-checked'), 'false');
    checks.push('duplicate model IDs remain distinct by provider and only the selected pair is checked');
    await press(byLabel('Filter provider beta'));
    assert.equal(byLabel('Filter provider beta').getAttribute('aria-selected'), 'true');
    assert.equal(doc.querySelectorAll('[role="radio"]').length, 1);
    assert.equal(byLabel('Shared assistant · alpha'), null);
    checks.push('provider filter narrows the current model search');
    await input(byLabel('Search models and providers'), '  BETA   synthetic 059  ');
    await waitFor(() => byLabel('Synthetic 059 · beta'), 'case-insensitive multiword search finds a model outside the initial rendered rows');
    assert.equal(doc.querySelectorAll('[role="radio"]').length, 1);
    await input(byLabel('Search models and providers'), 'no-such-model');
    await waitFor(() => text().includes('No matching models.'), 'model search presents an explicit empty result');
    await input(byLabel('Search models and providers'), 'shared');
    await press(byLabel('Shared assistant · beta'));
    await waitFor(() => !byLabel('Search models and providers'), 'selecting a model closes the picker');
    assert.equal(openCode.calls.filter(call => call.method === 'POST').length, 0, 'choosing a model does not submit a prompt');
    await press(byLabel('Choose a model'));
    await input(byLabel('Search models and providers'), 'shared');
    assert.equal(byLabel('Shared assistant · alpha').getAttribute('aria-checked'), 'false');
    assert.equal(byLabel('Shared assistant · beta').getAttribute('aria-checked'), 'true');
    checks.push('reopening the picker preserves the complete selected provider/model pair');
    await press(byLabel('Close sheet'));
    await input(byLabel('Message to assistant'), 'Use the selected provider'); await press(byLabel('Send message'));
    await waitFor(() => text().includes('Synthetic OpenCode response. No model was called.'), 'synthetic OpenCode prompt response reaches the native chat surface');
    const prompts = openCode.calls.filter(call => call.path.endsWith('/prompt_async'));
    assert.equal(prompts.length, 1);
    assert.deepEqual(prompts[0].body.model, { providerID: 'beta', modelID: 'shared' });
    checks.push('the next prompt carries the selected provider/model identity once');

    // OpenCode keeps the request ID while its custom-answer choice changes the
    // presented question from radio choices to an editor. The choice sentinel
    // must never become the editor draft or be submitted as the user's answer.
    const questionID = openCode.askCustomQuestion('fixture-plan');
    const questionReplies = () => openCode.calls.filter(call => call.method === 'POST' && call.path === `/question/${questionID}/reply`);
    await waitFor(() => byLabel('Answer agent question'), 'synthetic OpenCode custom-answer question reaches the chat');
    await press(byLabel('Answer agent question'));
    await press(byLabel('Write an answer'));
    await press(doc.querySelector('[data-testid="send-answer"]'));
    await waitFor(() => byLabel('Answer to agent'), 'same-ID OpenCode choice changes into a text editor');
    assert.equal(byLabel('Answer to agent').value, '');
    assert.equal(doc.querySelector('[data-testid="send-answer"]').disabled, true);
    assert.equal(questionReplies().length, 0);
    checks.push('same-ID custom editor starts empty and does not submit the choice sentinel');
    const typedAnswer = 'Keep only the instructions I typed.';
    await input(byLabel('Answer to agent'), typedAnswer);
    await press(doc.querySelector('[data-testid="send-answer"]'));
    await waitFor(() => !byLabel('Answer to agent') && !byLabel('Answer agent question'), 'host acknowledgement closes the custom-answer editor');
    assert.equal(questionReplies().length, 1);
    assert.deepEqual(questionReplies()[0].body, { answers: [[typedAnswer]] });
    checks.push('custom question sends only the typed text exactly once');

    await press(byLabel('Start a new chat'));
    await waitFor(() => doc.querySelector('[data-testid="new-chat-welcome"]') && byLabel('Message to assistant').value === '', 'OpenCode New chat opens the freshly created host session');
    assert.equal(openCode.created, 1);
    await input(byLabel('Message to assistant'), 'New-host-chat draft');
    await openHistory('Fixture notes');
    await waitFor(() => byLabel('Message to assistant').value === 'Notes-only draft', 'creating an OpenCode chat preserves the other remote drafts');
    await openHistory('New chat');
    await waitFor(() => byLabel('Message to assistant').value === 'New-host-chat draft', 'created OpenCode chat can be reopened from host history');

    // A second in-memory host deliberately reuses a session ID. Its catalog and
    // draft state must replace the first connection rather than merge with it.
    await openHistory('Fixture planning');
    await input(byLabel('Message to assistant'), 'Private first-host draft');
    await showSidebar(); await press(byText('Switch workspace'));
    await input(byLabel('OpenCode server URL'), secondOpenCode.origin);
    await input(byLabel('OpenCode server password'), 'second-fixture-password');
    await input(byLabel('OpenCode workspace directory'), secondOpenCode.directory);
    secondOpenCode.enable();
    await press(doc.querySelector('[data-testid="join-session"]'));
    await waitFor(() => doc.querySelector('[data-testid="chat-header"]').textContent.includes('Second host planning'), 'switching to another synthetic host replaces the active workspace');
    assert.equal(byLabel('Message to assistant').value, '');
    checks.push('same session IDs on different hosts do not reuse the previous connection draft');
    await press(byLabel('Choose a model'));
    await waitFor(() => byLabel('Shared assistant · delta'), 'model picker uses the second host catalog');
    assert.ok(text().includes('1 of 1 models'));
    assert.equal(byLabel('Filter provider alpha'), null); assert.equal(byLabel('Filter provider beta'), null);
    assert.equal(byLabel('Shared assistant · delta').getAttribute('aria-checked'), 'true');
    checks.push('catalog metadata and selected provider/model remain scoped to the connected host');
    await press(byLabel('Close sheet'));
    await showSidebar(); await press(byLabel('Connection')); await press(byText('Restart the demo'));
    await waitFor(() => doc.querySelector('[data-testid="new-chat-welcome"]') && !byLabel('Choose a model'), 'returning to demo detaches the synthetic host');

    // Exercise the connected durable reader through rendered controls, not by
    // calling its driver directly. Files are fetched only after selection.
    assert.equal(durable.calls.length, 0);
    await showSidebar(); await press(byText('Connect a workspace')); await press(byTab('Pi Durable'));
    assert.equal(byLabel('Durable server URL').value, '');
    assert.equal(byLabel('Pi Durable access token').value, '');
    assert.equal(doc.querySelector('[data-testid="join-session"]').disabled, true);
    await input(byLabel('Durable server URL'), durable.origin);
    await input(byLabel('Pi Durable access token'), durable.token);
    durable.enable(); await press(doc.querySelector('[data-testid="join-session"]'));
    await waitFor(() => !byLabel('Pi Durable access token') && text().includes('Your workspace is connected. Start your first chat.'), 'empty Pi Durable host opens the connected New chat welcome');
    assert.equal(durable.calls[0].path, '/perch/health');
    assert.equal(durable.created, 0, 'connection does not silently create a durable session');
    assert.equal(durable.artifactCalls().length, 0);
    assert.equal(byLabel('Message to assistant').value, '');
    assert.equal(byLabel('Choose a model'), null);
    await press(byLabel('Start a new chat'));
    await waitFor(() => durable.created === 1 && byLabel('Choose a model'), 'Pi Durable New chat creates and selects a host session');
    await input(byLabel('Message to assistant'), 'Create saved files for the durable UI fixture.');
    await press(byLabel('Send message'));
    await waitFor(() => text().includes('Your saved fixture files are ready.') && byLabel('Expand Save saved-report.md'), 'durable submission hydrates host messages and artifact-producing tool cards');
    assert.equal(byLabel('Message to assistant').value, '');
    assert.equal(durable.calls.filter(call => call.path.endsWith('/submit')).length, 1);
    assert.equal(durable.artifactCalls().length, 0, 'polling a manifest never eagerly downloads its content');
    await press(byLabel('Expand Save saved-report.md'));
    await waitFor(() => byLabel('Open artifact saved-report.md'), 'stored source identity attaches the file to its actual tool card');
    const copiedBeforeDurable = copied.length;
    durable.hold('saved-markdown'); await press(byLabel('Open artifact saved-report.md'));
    await waitFor(() => text().includes('Opening saved artifact…') && durable.artifactCalls().length === 1, 'selecting a saved Markdown file starts its lazy download');
    assert.equal(durable.artifactCalls()[0].path, '/perch/sessions/durable-fixture-1/artifacts/saved-markdown');
    assert.ok(text().includes('bytes · Saved on host'));
    assert.equal(doc.querySelector('[data-testid="artifact-markdown"]'), null);
    assert.equal(byLabel('Copy artifact').getAttribute('aria-disabled'), 'true');
    assert.equal(byLabel('Export artifact').getAttribute('aria-disabled'), 'true');
    await press(byLabel('Copy artifact')); assert.equal(copied.length, copiedBeforeDurable);
    checks.push('an unloaded reference shows saved byte metadata and disables render/copy/export');
    durable.release('saved-markdown');
    await waitFor(() => doc.querySelector('[data-testid="artifact-markdown"]') && text().includes('Durable fixture document'), 'authenticated saved Markdown passes real SHA-256 verification and renders');
    await press(byLabel('Artifact source'));
    await waitFor(() => byLabel('Source code, markdown'), 'saved Markdown exposes its original source');
    assert.equal(byLabel('Source code, markdown').textContent, durable.files[0].content);
    await press(byLabel('Copy artifact'));
    await waitFor(() => copied.length === copiedBeforeDurable + 1, 'saved artifact copy reaches the clipboard only after successful loading');
    assert.equal(copied.at(-1), durable.files[0].content);
    assert.equal(durable.artifactCalls().length, 1, 'source and copy reuse the current verified bytes');

    await press(byLabel('Back to artifacts'));
    assert.ok(byLabel('Open artifact saved-example.ts')); assert.ok(byLabel('Open artifact saved-page.html'));
    assert.equal(durable.artifactCalls().length, 1, 'the artifact list does not download unselected files');
    await press(byLabel('Open artifact saved-example.ts'));
    await waitFor(() => byLabel('Source code, typescript'), 'saved TypeScript opens in the existing code reader');
    assert.equal(byLabel('Source code, typescript').textContent, durable.files[2].content);
    assert.equal(durable.artifactCalls().length, 2);
    await press(byLabel('Back to artifacts'));

    durable.hold('saved-html'); durable.corruptNext('saved-html');
    await press(byLabel('Open artifact saved-page.html'));
    await waitFor(() => text().includes('Opening saved artifact…') && durable.artifactCalls().length === 3, 'saved HTML remains in a loading state while its bytes are pending');
    assert.equal(doc.querySelector('iframe[data-testid="artifact-html"]'), null);
    assert.equal(byLabel('HTML interaction'), null);
    assert.equal(byLabel('Copy artifact').getAttribute('aria-disabled'), 'true');
    durable.release('saved-html');
    await waitFor(() => byLabel('Retry loading artifact') && text().includes('SHA-256 integrity check'), 'a same-length corrupted download becomes a retryable reader error');
    assert.equal(doc.querySelector('iframe[data-testid="artifact-html"]'), null);
    assert.equal(byLabel('HTML interaction'), null);
    assert.equal(byLabel('Export artifact').getAttribute('aria-disabled'), 'true');
    assert.equal(copied.length, copiedBeforeDurable + 1);
    await press(byLabel('Retry loading artifact'));
    await waitFor(() => doc.querySelector('iframe[data-testid="artifact-html"]'), 'retry fetches verified HTML and opens the existing isolated preview');
    assert.equal(durable.artifactCalls().length, 4);
    frame = doc.querySelector('iframe[data-testid="artifact-html"]');
    assert.equal(frame.getAttribute('sandbox'), '');
    assert.equal(frame.getAttribute('referrerpolicy'), 'no-referrer');
    assert.ok(frame.getAttribute('srcdoc').includes('Content-Security-Policy'));
    assert.ok(!frame.getAttribute('srcdoc').includes(durable.token), 'the preview document contains no workspace credential');
    await press(byLabel('HTML interaction'));
    assert.equal(doc.querySelector('iframe[data-testid="artifact-html"]').getAttribute('sandbox'), 'allow-scripts');
    await press(byLabel('Artifact source'));
    assert.equal(byLabel('Source code, html').textContent, durable.files[1].content);
    checks.push('saved HTML shares the original sandbox, script toggle, and complete-source reader');

    await press(byLabel('Back to chat')); await press(byLabel('Start a new chat'));
    await waitFor(() => durable.created === 2 && doc.querySelector('[data-testid="new-chat-welcome"]'), 'a second durable chat starts with an empty transcript');
    await showSidebar(); await press(byLabel('Artifacts'));
    await waitFor(() => text().includes('Give good work some room.'), 'switching durable sessions clears the previous artifact selection and list');
    assert.equal(byLabel('Open artifact saved-page.html'), null);
    assert.equal(doc.querySelector('iframe[data-testid="artifact-html"]'), null);
    await openHistory('Saved fixture workspace');
    await waitFor(() => text().includes('Your saved fixture files are ready.'), 'durable history rehydrates the first session from its authoritative snapshot');
    assert.equal(durable.artifactCalls().length, 4, 'history hydration restores references without fetching their content');
    await showSidebar(); await press(byLabel('Artifacts')); await press(byLabel('Open artifact saved-page.html'));
    await waitFor(() => doc.querySelector('iframe[data-testid="artifact-html"]'), 'a saved file can be reopened after changing sessions');
    assert.equal(doc.querySelector('iframe[data-testid="artifact-html"]').getAttribute('sandbox'), '', 'reopened saved HTML does not inherit prior script permission');
    assert.equal(durable.artifactCalls().length, 5);
    await showSidebar(); await press(byLabel('Connection')); await press(byText('Restart the demo'));
    await waitFor(() => doc.querySelector('[data-testid="new-chat-welcome"]') && !byLabel('Choose a model'), 'returning to demo also detaches the durable host and its saved artifacts');

    assert.deepEqual(errors, []); assert.deepEqual(logs.filter(entry => entry[0] === 'error'), []); assert.deepEqual(blocked, []);
    console.log(JSON.stringify({ result: 'PASS (DOM emulation only; synthetic OpenCode and Pi Durable protocols, no real host or model)', checks, fixtureRequests: openCode.calls.length + secondOpenCode.calls.length, durableFixtureRequests: durable.calls.length, durableArtifactRequests: durable.artifactCalls().length, errors, cssLimitations, logs, blocked }, null, 2));
  } catch (e) {
    console.log(JSON.stringify({ failure: String(e), checks, renderedText: text().slice(0, 5000), controls: [...doc.querySelectorAll('button,[role=button],[role=radio]')].map(x => ({ label: x.getAttribute('aria-label'), text: x.textContent.slice(0, 100) })), errors, cssLimitations, logs, blocked }, null, 2));
    process.exitCode = 1;
  } finally { dom.window.close(); }
})();
