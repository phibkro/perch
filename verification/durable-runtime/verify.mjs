import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertRuntimeRunning, probeRuntimeReadiness, RuntimeExitedError } from './runtime-health.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const area = join(project, 'verification/durable-runtime');
const backend = join(project, 'server/pi-durable');
const celld = process.env.CELLD_BIN || 'celld';
const productionOnly = process.argv.includes('--production-provider');
const esbuild = await import(pathToFileURL(join(backend, 'node_modules/esbuild/lib/main.js')));
const tokens = { primary: 'public-fixture-primary-token-0000000001', second: 'public-fixture-second-token-00000000002' };
const report = { startedAt: new Date().toISOString(), syntheticModel: true,
  productionEntry: productionOnly, runtime: 'celld dev with local backing object store', realR2: false, checks: [], events: [], requests: [], processKills: [] };
const resultPath = resolve(process.env.DURABLE_RESULTS || join(area, productionOnly ? 'results/production-provider.json' : 'results/latest.json'));
const providerContent = '# Configured provider artifact\n\nThe real OpenAI-compatible adapter produced this saved file.\n';
let directory, runtime, base, proxy, child, phase = 'before-crash', dropNextSubmit = false;
const stores = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const record = event => { const item = { at: new Date().toISOString(), phase, ...event }; report.events.push(item); return item; };
const passed = (name, evidence = {}) => { report.checks.push({ name, status: 'passed', ...evidence }); console.log(`PASS ${name}`); };
async function eventually(read, predicate, name, timeout = 25000) {
  const deadline = Date.now() + timeout; let last;
  while (Date.now() < deadline) {
    try { last = await read(); if (predicate(last)) return last; } catch (error) {
      if (error instanceof RuntimeExitedError) throw error;
      last = String(error);
    }
    await sleep(100);
  }
  throw new Error(`${name} timed out: ${JSON.stringify(last).slice(0, 1500)}`);
}
async function body(req) {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? Buffer.concat(chunks) : undefined;
}
async function serveObserver() {
  const server = createServer(async (req, res) => {
    try {
      const bytes = await body(req);
      const value = bytes ? JSON.parse(bytes) : undefined;
      if (req.url === '/v1/chat/completions') {
        assert.equal(req.headers.authorization, 'Bearer public-fixture-inference-key');
        assert.equal(value.model, 'local-fixture');
        assert.ok(value.tools.some(tool => tool.function?.name === 'write_artifact'));
        record({ type: 'production-provider-request', model: value.model });
        const afterTool = value.messages.some(message => message.role === 'tool');
        const chunk = delta => `data: ${JSON.stringify({ id: 'completion-fixture', object: 'chat.completion.chunk',
          created: 1, model: value.model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(chunk({ role: 'assistant' }));
        res.write(chunk(afterTool ? { content: 'The configured provider saved your artifact.' }
          : { tool_calls: [{ index: 0, id: 'provider-write', type: 'function', function: { name: 'write_artifact', arguments: JSON.stringify({
            kind: 'markdown', filename: 'provider.md', title: 'Configured provider artifact', content: providerContent,
          }) } }] }));
        res.write(`data: ${JSON.stringify({ id: 'completion-fixture', object: 'chat.completion.chunk', created: 1, model: value.model,
          choices: [{ index: 0, delta: {}, finish_reason: afterTool ? 'stop' : 'tool_calls' }],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })}\n\n`);
        res.end('data: [DONE]\n\n'); return;
      }
      if (req.url.startsWith('/perch/')) {
        report.requests.push({ method: req.method, path: req.url, body: value });
        const upstream = await fetch(base + req.url, { method: req.method,
          headers: { ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {}),
            ...(bytes ? { 'Content-Type': 'application/json' } : {}) },
          ...(bytes ? { body: bytes } : {}), signal: AbortSignal.timeout(25000), redirect: 'error' });
        const output = Buffer.from(await upstream.arrayBuffer());
        if (dropNextSubmit && req.method === 'POST' && req.url.endsWith('/submit') && upstream.ok) {
          dropNextSubmit = false; record({ type: 'lost-receipt', receipt: JSON.parse(output) }); res.destroy(); return;
        }
        res.writeHead(upstream.status, Object.fromEntries(upstream.headers)); res.end(output); return;
      }
      record({ path: req.url, ...value });
      const hold = (req.url === '/model' && value.input === 'Stop this response')
        || (phase === 'before-crash' && ((req.url === '/stored' && value.title === 'recover-upload')
        || (req.url === '/model' && value.input === 'Recover partial')));
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ hold }));
    } catch (error) {
      if (!res.destroyed) res.writeHead(502).end(JSON.stringify({ error: 'Local integration proxy failed.' }));
      record({ type: 'observer-error', error: String(error) });
    }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}
async function raw(path, value, token = tokens.primary, extra = {}) {
  return fetch(base + '/perch' + path, { method: value === undefined ? 'GET' : 'POST',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(value === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }), signal: AbortSignal.timeout(25000), redirect: 'error' });
}
async function api(path, value, token) {
  const response = await raw(path, value, token); const text = await response.text();
  if (!response.ok) throw new Error(`${path}: ${response.status} ${text}`);
  return JSON.parse(text);
}
async function start(label) {
  const proc = spawn(celld, ['dev', runtime, '--port', String(report.port), '--logs', '--no-watch'], {
    cwd: project, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, CELLD_DURABILITY: 'bucket',
      CELLD_ESBUILD: join(backend, 'node_modules/.bin/esbuild') },
  });
  child = proc; proc.label = label; let log = '';
  proc.stdout.on('data', value => { log += value; }); proc.stderr.on('data', value => { log += value; });
  proc.on('error', error => { log += String(error); }); proc.logs = () => log;
  let readiness;
  await eventually(async () => {
    assertRuntimeRunning(proc);
    readiness = await probeRuntimeReadiness(base);
    return api('/health');
  }, value => value.service === 'perch-durable', `${label} startup`, 45000)
    .catch(error => { throw new Error(`${error.message}\n${log.slice(-5000)}`); });
  const [current, limit] = await Promise.all(['memory.current', 'memory.max'].map(name =>
    readFile(`/sys/fs/cgroup/${name}`, 'utf8').then(value => value.trim()).catch(() => null)));
  (report.runtimeReadiness ??= []).push({ phase: label, at: new Date().toISOString(), health: readiness,
    cgroupCurrentBytes: current === null ? null : Number(current),
    cgroupLimitBytes: limit === null || limit === 'max' ? null : Number(limit) });
  console.log(`${label}: celld ready`);
}
function listenerClosed() {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port: report.port });
    socket.on('connect', () => { socket.destroy(); resolve(false); });
    socket.on('error', error => error.code === 'ECONNREFUSED' ? resolve(true) : reject(error));
    socket.setTimeout(1000, () => { socket.destroy(); reject(new Error('Listener check timed out')); });
  });
}
async function killRuntime(reason) {
  if (!child) return;
  const proc = child;
  if (proc.exitCode === null && proc.signalCode === null) {
    const exited = once(proc, 'exit'); proc.kill('SIGKILL'); const [code, signal] = await exited;
    assert.equal(signal, 'SIGKILL');
    await eventually(listenerClosed, Boolean, 'Runtime listener disappears after SIGKILL', 10000);
    report.processKills.push({ reason, code, signal, listenerClosed: true,
      mechanism: 'celld dev supervisor SIGKILL; Linux child PR_SET_PDEATHSIG=SIGKILL' });
  }
  await writeFile(join(directory, `${proc.label}.log`), proc.logs()); child = undefined;
}
const sessionPath = (id, suffix = '') => `/sessions/${id}${suffix ? `/${suffix}` : ''}`;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

try {
  if (process.platform !== 'linux') throw new Error('This runner requires Linux celld dev parent-death behavior.');
  report.celldVersion = execFileSync(celld, ['--version'], { encoding: 'utf8' }).trim();
  await mkdir(join(area, '.runs'), { recursive: true }); directory = await mkdtemp(join(area, '.runs/run-'));
  runtime = join(directory, 'project'); await mkdir(runtime); report.evidenceDirectory = directory;
  const reserved = createServer(); reserved.listen(0, '127.0.0.1'); await once(reserved, 'listening');
  report.port = reserved.address().port; await new Promise(resolve => reserved.close(resolve));
  base = `http://127.0.0.1:${report.port}`; proxy = await serveObserver();
  await esbuild.build({ entryPoints: [productionOnly ? join(backend, 'src/worker.mjs') : join(area, 'fixture-worker.mjs')], outfile: join(runtime, 'worker.mjs'),
    bundle: true, format: 'esm', platform: 'browser', target: 'es2022', conditions: ['workerd', 'worker', 'browser'],
    tsconfigRaw: { compilerOptions: {} }, external: ['cloudflare:*', 'node:*'], nodePaths: [join(backend, 'node_modules')] });
  await esbuild.build({ entryPoints: [join(project, 'src/session/store.ts')], outfile: join(directory, 'client.mjs'),
    bundle: true, format: 'esm', platform: 'node', target: 'node24',
    external: ['./collab', './pi', './opencode'], tsconfigRaw: { compilerOptions: {} } });
  await writeFile(join(runtime, 'wrangler.json'), JSON.stringify({ name: 'perch-durable-integration', main: 'worker.mjs',
    compatibility_date: '2026-10-07', compatibility_flags: ['nodejs_compat'],
    vars: { PROBE_CONTROL_URL: proxy.url, PERCH_TOKENS: JSON.stringify(tokens), PERCH_ALLOWED_ORIGINS: '["https://phone.example"]',
      ...(productionOnly ? { PERCH_MODELS: JSON.stringify([{ provider: 'local', id: 'local-fixture', name: 'Configured local fixture',
        baseUrl: proxy.url + '/v1', apiKey: 'public-fixture-inference-key', contextWindow: 32768, maxTokens: 2048 }]) } : {}) },
    durable_objects: { bindings: [{ name: 'PERCH_CATALOGS', class_name: 'PerchCatalog' }, { name: 'PERCH_SESSIONS', class_name: 'PerchSession' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['PerchCatalog', 'PerchSession'] }],
    r2_buckets: [{ binding: 'ARTIFACTS', bucket_name: 'perch-integration-artifacts' }],
  }, null, 2));
  await start('before-crash');
  if (productionOnly) {
    const health = await api('/health'); assert.equal(health.synthetic, false);
    assert.deepEqual(health.models, [{ provider: 'local', id: 'local-fixture', name: 'Configured local fixture' }]);
    const { SessionStore } = await import(pathToFileURL(join(directory, 'client.mjs')));
    const store = new SessionStore(); stores.push(store);
    await store.connectDurable({ url: proxy.url, token: tokens.primary });
    await eventually(() => store.getSnapshot(), value => value.connection.status === 'live', 'Production entry connects');
    assert.ok(await store.createSession()); store.sendPrompt('Write a Markdown artifact with the configured provider.');
    const state = await eventually(() => store.getSnapshot(), value => !value.isWorking && value.storedArtifacts?.length === 1,
      'Production model adapter runs its tool and returns a final response', 45000);
    assert.equal(await store.loadArtifact(state.storedArtifacts[0]), providerContent);
    assert.ok(state.messages.some(message => message.text === 'The configured provider saved your artifact.'));
    assert.equal(report.events.filter(event => event.type === 'production-provider-request').length, 2);
    passed('Production entry uses the real OpenAI-completions adapter, host credentials, Pi tool execution, and protected artifact download');
    report.productionSnapshot = state;
  } else {
  const health = await api('/health'); assert.equal(health.synthetic, true); assert.equal(health.models.length, 2);
  assert.equal((await raw('/health', undefined, '')).status, 401);
  assert.equal((await raw('/health', undefined, 'wrong-token-with-at-least-32-characters')).status, 401);
  assert.equal((await raw('/health', undefined, tokens.primary, { Origin: 'https://untrusted.example' })).status, 403);
  const allowed = await raw('/health', undefined, tokens.primary, { Origin: 'https://phone.example' });
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://phone.example');
  assert.deepEqual(await api('/sessions', undefined, tokens.second), { sessions: [] });
  passed('Authenticated health, origin checks, and independent workspace catalogs');

  const { SessionStore } = await import(pathToFileURL(join(directory, 'client.mjs')));
  const connect = async (token = tokens.primary) => {
    const store = new SessionStore(); stores.push(store);
    await store.connectDurable({ url: proxy.url, token });
    await eventually(() => store.getSnapshot(), value => value.connection.status === 'live', 'Native SessionStore connects');
    return store;
  };
  const first = await connect(); assert.equal(first.getSnapshot().sessions.length, 0);
  assert.equal(first.getSnapshot().capabilities.prompt, false);
  const baseline = await first.createSession(); assert.ok(baseline);
  assert.equal(first.getSnapshot().activeSessionId, baseline);
  dropNextSubmit = true; first.sendPrompt('Create three artifacts');
  await eventually(() => first.getSnapshot(), value => !value.isWorking && value.storedArtifacts?.length === 3,
    'Phone receives committed manifests after dropped submission receipt', 40000);
  const lost = report.events.find(event => event.type === 'lost-receipt'); assert.ok(lost);
  assert.equal(report.requests.filter(item => item.path.endsWith('/submit') && item.body.text === 'Create three artifacts').length, 1);
  assert.equal(first.getSnapshot().messages.filter(item => item.role === 'user').length, 1);
  assert.equal((await api(sessionPath(baseline, 'submit'), { operationId: lost.receipt.operationId, text: 'Create three artifacts' })).accepted, false);
  assert.equal((await raw(sessionPath(baseline, 'submit'), { operationId: lost.receipt.operationId, text: 'Different prompt' })).status, 409);
  passed('Actual SessionStore creates a chat and reconciles a lost receipt without duplicate submission');

  const saved = first.getSnapshot().storedArtifacts;
  report.baseline = { sessionId: baseline, manifests: saved };
  for (const artifact of saved) {
    const content = await first.loadArtifact(artifact); const bytes = Buffer.from(content, 'utf8');
    assert.equal(bytes.length, artifact.bytes); assert.equal(digest(bytes), artifact.sha256);
    assert.ok(first.getSnapshot().tools.some(tool => `tool:${tool.id}` === artifact.sourceId));
    const response = await raw(sessionPath(baseline, `artifacts/${artifact.id}`));
    assert.match(response.headers.get('content-disposition'), /^attachment;/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('content-type'), 'application/octet-stream');
    assert.equal((await raw(sessionPath(baseline, `artifacts/${artifact.id}`), undefined, tokens.second)).status, 404);
  }
  assert.equal((await raw(sessionPath(baseline), undefined, tokens.second)).status, 404);
  passed('Markdown, HTML, and code bytes pass the real phone loader; another workspace cannot read them');

  first.setModel('perch-fixture', 'fixture-two');
  await eventually(() => first.getSnapshot().model, model => model?.id === 'fixture-two', 'Model selection acknowledged');
  first.dispose();
  const reconnected = await connect();
  assert.equal(reconnected.getSnapshot().activeSessionId, baseline);
  assert.equal(reconnected.getSnapshot().model.id, 'fixture-two');
  assert.deepEqual(reconnected.getSnapshot().storedArtifacts, saved);
  assert.equal(digest(Buffer.from(await reconnected.loadArtifact(saved[0]))), saved[0].sha256);
  passed('A fresh phone store reopens host history, model selection, and immutable artifacts');
  const stoppedSession = await reconnected.createSession(); assert.ok(stoppedSession);
  reconnected.sendPrompt('Stop this response');
  await eventually(() => reconnected.getSnapshot(), value => value.isWorking && value.messages.some(item => item.streaming), 'Interrupt fixture starts streaming');
  reconnected.interrupt();
  await eventually(() => reconnected.getSnapshot(), value => !value.isWorking && value.messages.some(item => /Response interrupted/.test(item.text)), 'Phone Stop aborts the actual active Pi run');
  assert.deepEqual(report.requests.findLast(item => item.path.endsWith('/abort')).body, {});
  passed('Phone Stop aborts the actual Pi run and records an interrupted response');
  reconnected.dispose();

  const createInput = { operationId: 'create-upload', title: 'recover-upload' };
  const upload = await api('/sessions', createInput); const partial = await api('/sessions', { operationId: 'create-partial', title: 'recover-partial' });
  assert.equal((await api('/sessions', createInput)).accepted, false);
  assert.equal((await raw('/sessions', { ...createInput, title: 'Different title' })).status, 409);
  assert.equal((await raw('/sessions', { operationId: 'client-scope', workspaceId: 'second' })).status, 400);
  for (const [created, text, op] of [[upload, 'Recover upload', 'upload'], [partial, 'Recover partial', 'partial']]) {
    const id = created.session.id;
    assert.equal((await api(sessionPath(id, 'submit'), { operationId: `${op}-one`, text })).accepted, true);
    assert.equal((await api(sessionPath(id, 'submit'), { operationId: `${op}-two`, text: 'Queued follow-up' })).accepted, true);
  }
  const storedBefore = await eventually(() => report.events.find(event => event.path === '/stored' && event.title === 'recover-upload'), Boolean,
    'Artifact bytes stored before manifest commit');
  const uploadBefore = await api(sessionPath(upload.session.id));
  assert.equal(uploadBefore.state.storedArtifacts.length, 0);
  assert.ok(uploadBefore.operations.some(item => item.operationId === 'upload-two' && item.status === 'queued'));
  const partialBefore = await eventually(() => api(sessionPath(partial.session.id)), value => value.state.messages.some(item => item.streaming && /committed partial/.test(item.text)),
    'Committed partial text appears in authoritative snapshot');
  assert.ok(partialBefore.operations.some(item => item.operationId === 'partial-two' && item.status === 'queued'));
  passed('Artifact upload and model stream reach real interruption boundaries with queued input');

  await killRuntime('Crash before artifact manifest commit and during model streaming');
  const cache = join(runtime, '.celld/dev/runtime');
  const objectStore = join(runtime, '.celld/dev/objects.sqlite3'); assert.ok((await stat(objectStore)).size > 0);
  await rm(cache, { recursive: true, force: true });
  report.cacheRemoval = { removed: cache, retained: objectStore, retainedSidecars: true };
  phase = 'after-crash'; await start('after-crash');
  // No session/API client reconnect occurs until both cells report completion
  // through their alarm-activated hook and Pi's own operation wait result.
  await eventually(() => {
    assertRuntimeRunning(child);
    return report.events.filter(event => event.phase === 'after-crash');
  }, events =>
    [upload.session.id, partial.session.id].every(id =>
      events.some(event => event.sessionId === id && event.type === 'boot' && event.activatedBy === 'alarm'))
    && ['upload-one', 'upload-two', 'partial-one', 'partial-two'].every(id =>
      events.some(event => event.type === 'settled' && event.operationId === id && event.result?.status === 'done')),
    'Alarm-only recovery and completion of all four accepted operations', 100000);
  passed('Fresh runtime restores both unfinished chats and completes queued work through alarms alone');

  const recoveredUpload = await api(sessionPath(upload.session.id));
  const recoveredPartial = await api(sessionPath(partial.session.id));
  assert.equal(recoveredUpload.state.storedArtifacts.length, 1);
  assert.deepEqual(recoveredUpload.state.storedArtifacts[0], storedBefore.manifest);
  const attempts = report.events.filter(event => event.path === '/stored' && event.title === 'recover-upload');
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[0].manifest, attempts[1].manifest);
  assert.equal(recoveredUpload.state.messages.filter(item => item.role === 'user').length, 2);
  assert.equal(recoveredPartial.state.messages.filter(item => item.role === 'user').length, 2);
  assert.ok(recoveredPartial.state.messages.some(item => /interrupted response resumed/.test(item.text)));
  for (const [created, text, op] of [[upload, 'Recover upload', 'upload'], [partial, 'Recover partial', 'partial']]) {
    assert.equal((await api(sessionPath(created.session.id, 'submit'), { operationId: `${op}-one`, text })).accepted, false);
  }
  report.recovered = { upload: recoveredUpload, partial: recoveredPartial };
  passed('Interrupted upload converges on the original artifact identity; recovered prompts stay deduplicated');

  const fresh = await connect();
  fresh.selectSession(baseline);
  await eventually(() => fresh.getSnapshot(), value => value.activeSessionId === baseline && !value.sessionAction, 'Reopen completed chat after cache deletion');
  assert.deepEqual(fresh.getSnapshot().storedArtifacts, saved);
  for (const artifact of saved) assert.equal(digest(Buffer.from(await fresh.loadArtifact(artifact))), artifact.sha256);
  fresh.selectSession(upload.session.id);
  await eventually(() => fresh.getSnapshot(), value => value.activeSessionId === upload.session.id && !value.sessionAction, 'Reopen recovered chat');
  const recoveredArtifact = fresh.getSnapshot().storedArtifacts[0];
  assert.equal(digest(Buffer.from(await fresh.loadArtifact(recoveredArtifact))), storedBefore.manifest.sha256);
  const oldEpoch = fresh.getSnapshot().connectionEpoch;
  await fresh.connectDurable({ url: proxy.url, token: tokens.second });
  await eventually(() => fresh.getSnapshot(), value => value.connection.status === 'live', 'Switch credential scope');
  assert.ok(fresh.getSnapshot().connectionEpoch > oldEpoch); assert.equal(fresh.getSnapshot().sessions.length, 0);
  await assert.rejects(() => fresh.loadArtifact(recoveredArtifact), /no longer available/);
  passed('Fresh phone reopens completed and recovered artifacts after cache deletion; credential switch revokes old references');
  }
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = String(error?.stack || error); console.error(report.error); process.exitCode = 1;
} finally {
  for (const store of stores) store.dispose();
  try { await killRuntime('Integration cleanup'); } catch (error) { report.cleanupError = String(error); }
  if (proxy) { proxy.server.closeAllConnections(); await new Promise(resolve => proxy.server.close(resolve)); }
  report.finishedAt = new Date().toISOString(); await mkdir(dirname(resultPath), { recursive: true });
  await writeFile(resultPath, JSON.stringify(report, null, 2) + '\n');
  console.log(`Report: ${resultPath}`);
}
