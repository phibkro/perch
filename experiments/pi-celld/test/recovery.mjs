import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// A real celld/PiHarness crash experiment. Every model response and external
// effect is an explicitly synthetic fixture, served only over loopback.
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const celld = process.env.CELLD_BIN || 'celld';
const esbuild = process.env.CELLD_ESBUILD || join(project, 'node_modules/.bin/esbuild');
const freshOnCrash = process.argv.includes('--fresh-cache-on-crash');
const output = resolve(process.env.PROBE_RESULTS || join(project,
  freshOnCrash ? 'results/fresh-cache-pending.json' : 'results/local-dev.json'));
const startedAt = new Date().toISOString();
const runId = randomUUID();
const events = [];
const cases = new Map();
let phase = 'before-crash';
let runtime;
let child;
let observer;
let base;
let directory;
const report = { runId, startedAt, mode: 'celld-dev-local-object-store',
  syntheticModel: true, realR2: false, freshCacheWhilePending:freshOnCrash,
  checks: [], events, processKills: [] };

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const progress = (message) => console.log(JSON.stringify({ at: new Date().toISOString(), message }));
const record = (event) => { const full = { at: new Date().toISOString(), phase, ...event }; events.push(full); return full; };
const ok = (name, detail) => { report.checks.push({ name, status: 'passed', ...detail }); progress(name); };

async function eventually(read, predicate, description, milliseconds = 20000) {
  const deadline = Date.now() + milliseconds;
  let last;
  while (Date.now() < deadline) {
    try { last = await read(); if (predicate(last)) return last; }
    catch (error) { last = String(error); }
    await delay(100);
  }
  throw new Error(`${description} timed out; last value: ${JSON.stringify(last).slice(0,2000)}`);
}

async function jsonBody(req) {
  let body = '';
  for await (const chunk of req) { body += chunk; if (body.length > 2_000_000) throw new Error('Fixture body too large'); }
  return JSON.parse(body || '{}');
}

async function serveObserver() {
  const server = createServer(async (req, res) => {
    try {
      const payload = await jsonBody(req);
      if (req.url === '/drop-submit') {
        // The client never receives the already-committed upstream receipt.
        const response = await fetch(`${base}/sessions/${payload.sessionName}/submit`, {
          method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(payload.input),
          signal:AbortSignal.timeout(20000),
        });
        const receipt = await response.json();
        if (!response.ok) throw new Error(JSON.stringify(receipt));
        record({type:'dropped-receipt', sessionName:payload.sessionName, receipt});
        res.destroy();
        return;
      }
      const state = cases.get(payload.sessionName);
      if (!state) throw new Error(`Unknown fixture session: ${payload.sessionName}`);
      const event = record({path:req.url, ...payload});
      if (req.url === '/events') {
        state.events.push(event);
        res.writeHead(200, {'content-type':'application/json'}).end(JSON.stringify({ok:true}));
        return;
      }
      if (req.url === '/model-attempt') {
        state.models.push(event);
        const hold = phase === 'before-crash' && state.scenario === 'model' && state.hold;
        res.writeHead(200, {'content-type':'application/json'}).end(JSON.stringify({attempt:state.models.length, hold}));
        return;
      }
      if (req.url === '/tool-attempt') {
        state.tools.push(event);
        assert.equal(typeof payload.artifactId, 'string');
        assert.match(payload.artifactId, /^[a-zA-Z0-9_-]+$/);
        assert.equal(typeof payload.content, 'string');
        if (state.scenario === 'unsafe') state.effects.push(event);
        else await writeFile(join(directory, 'artifacts', `${payload.artifactId}.md`), payload.content);
        const hold = phase === 'before-crash' && state.hold;
        res.writeHead(200, {'content-type':'application/json'}).end(JSON.stringify({attempt:state.tools.length, hold}));
        return;
      }
      res.writeHead(404).end('Unknown observer route');
    } catch (error) {
      record({type:'observer-error', error:String(error)});
      if (!res.destroyed) res.writeHead(500, {'content-type':'application/json'}).end(JSON.stringify({error:String(error)}));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {server, url:`http://127.0.0.1:${server.address().port}`};
}

async function request(path, body, timeout = 25000) {
  const response = await fetch(base + path, {method:body === undefined ? 'GET' : 'POST',
    headers:{'content-type':'application/json'}, ...(body === undefined ? {} : {body:JSON.stringify(body)}),
    signal:AbortSignal.timeout(timeout)});
  const text = await response.text();
  let value; try { value = JSON.parse(text); } catch { value = text; }
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}: ${JSON.stringify(value)}`);
  return value;
}

async function start(label) {
  const logFile = join(directory, `${label}.log`);
  child = spawn(celld, ['dev', runtime, '--port', String(report.port), '--logs', '--no-watch'], {
    cwd:project, detached:true, stdio:['ignore','pipe','pipe'],
    env:{PATH:process.env.PATH, HOME:process.env.HOME, CELLD_ESBUILD:esbuild, CELLD_DURABILITY:'bucket'},
  });
  let log = '';
  child.stdout.on('data', (v) => { log += v; });
  child.stderr.on('data', (v) => { log += v; });
  child.on('error', (error) => { log += String(error); });
  child.on('close', () => { void writeFile(logFile, log); });
  child.probeLog = () => log;
  child.probeLabel = label;
  await eventually(async () => {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(log.slice(-5000));
    return request('/health', undefined, 2000);
  }, Boolean, `${label} runtime startup`, 45000).catch((error) => {
    throw new Error(`${error.message}\n${log.slice(-6000)}`);
  });
  progress(`${label}: celld listening`);
}

async function listenerClosed() {
  return new Promise((resolve, reject) => {
    const socket = createConnection({host:'127.0.0.1',port:report.port});
    socket.on('connect', () => { socket.destroy(); resolve(false); });
    socket.on('error', (error) => {
      if (error.code === 'ECONNREFUSED') resolve(true);
      else reject(error);
    });
    socket.setTimeout(1000, () => { socket.destroy(); reject(new Error('Listener closure check timed out')); });
  });
}

async function killRuntime(reason) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const current = child;
  // celld dev gives its node a separate process group, and on Linux sets
  // PR_SET_PDEATHSIG=SIGKILL. Kill the actual spawned supervisor, then require
  // the node listener to disappear before any replacement is started.
  const exited = once(current, 'exit');
  current.kill('SIGKILL');
  const [code, signal] = await exited;
  assert.equal(signal, 'SIGKILL');
  await eventually(listenerClosed, Boolean, 'celld child listener closes after supervisor SIGKILL', 10000);
  await writeFile(join(directory, `${current.probeLabel}.log`), current.probeLog());
  report.processKills.push({reason, supervisor:current.pid, code, signal,
    nodeDeathMechanism:'Linux PR_SET_PDEATHSIG=SIGKILL',nodeListenerClosed:true});
  child = undefined;
}

function messages(value) {
  const snap = value.snapshot || value;
  return (snap.entries || []).flatMap((entry) => entry.model || []);
}

const sessionPath = (name, suffix) => `/sessions/${name}/${suffix}`;
const submit = (name, text, operationId, scenario) => request(sessionPath(name,'submit'), {text,operationId,scenario});
const snapshot = (name) => request(sessionPath(name,'snapshot'));
const result = (name, operationId) => request(sessionPath(name,`result?operationId=${encodeURIComponent(operationId)}`), undefined, 45000);

try {
  if (process.platform !== 'linux') throw new Error('This runner requires celld dev Linux parent-death SIGKILL behavior.');
  report.celldVersion = execFileSync(celld, ['--version'], {encoding:'utf8'}).trim();
  await mkdir(join(project,'.runs'), {recursive:true});
  directory = await mkdtemp(join(project,'.runs/run-'));
  runtime = join(directory,'project');
  await mkdir(runtime);
  await mkdir(join(directory,'artifacts'));
  report.evidenceDirectory = directory;
  const reserve = createServer(); reserve.listen(0,'127.0.0.1'); await once(reserve,'listening');
  report.port = reserve.address().port; await new Promise((r) => reserve.close(r));
  base = `http://127.0.0.1:${report.port}`;
  observer = await serveObserver();
  await copyFile(join(project,'dist/worker.mjs'), join(runtime,'worker.mjs'));
  await writeFile(join(runtime,'wrangler.json'), JSON.stringify({
    name:'perch-pi-celld-probe', main:'worker.mjs', compatibility_date:'2026-10-07', compatibility_flags:['nodejs_compat'],
    vars:{PROBE_CONTROL_URL:observer.url},
    durable_objects:{bindings:[{name:'PROBE_SESSIONS',class_name:'ProbeSession'}]},
    migrations:[{tag:'v1',new_sqlite_classes:['ProbeSession']}],
  },null,2));
  for (const [name, scenario, hold] of [['completed','safe',false],['safe','safe',true],['unsafe','unsafe',true],['model','model',true],['lost-ack','safe',true]]) {
    cases.set(name,{scenario,hold,events:[],models:[],tools:[],effects:[]});
  }
  await start('before-crash');
  const completedReceipt = await submit('completed','Produce an artifact','completed-1','safe');
  assert.equal((await result('completed','completed-1')).status,'done');
  report.completedBefore = await snapshot('completed');
  assert.equal(cases.get('completed').tools.length,1);
  ok('Official PiHarness loads and completes a tool-backed session', {receipt:completedReceipt});

  for (const name of ['safe','unsafe','model','lost-ack']) {
    const state = cases.get(name);
    const input = {text:'Produce an artifact',operationId:`${name}-1`,scenario:state.scenario};
    if (name === 'lost-ack') {
      let lost = false;
      try { await fetch(observer.url + '/drop-submit', {method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({sessionName:name,input}),signal:AbortSignal.timeout(25000)}); }
      catch { lost = true; }
      assert.equal(lost,true,'The client must actually lose the HTTP receipt');
      state.receipt = events.findLast((event) => event.type === 'dropped-receipt' && event.sessionName === name)?.receipt;
      assert.ok(state.receipt,'Upstream accepted receipt must be observed at the dropping proxy');
    } else state.receipt = await submit(name,input.text,input.operationId,input.scenario);
    assert.equal(state.receipt.accepted,true,'The original operation must be durably accepted');
    state.queued = await submit(name,'Queued follow-up',`${name}-2`,state.scenario);
    assert.equal(state.queued.accepted,true);
    await eventually(async () => {
      const value = await snapshot(name); state.before = value; return value;
    }, (value) => name === 'model'
      ? /partial answer/.test(JSON.stringify(value.snapshot?.generation || {}))
      : state.tools.length === 1,
    `${name} reaches recorded crash boundary`);
    assert.ok(state.before.pending.some((entry) => entry.operationId === `${name}-2` && entry.status === 'queued'),
      `${name} follow-up must be persisted and queued before kill`);
    state.bootBefore = state.before.bootId;
  }
  ok('All interrupted sessions reached recorded crash boundaries with queued input');
  await killRuntime('Crash while four sessions have unfinished accepted work');
  assert.equal(report.processKills[0].nodeListenerClosed,true);
  if (freshOnCrash) {
    const cache = join(runtime,'.celld/dev/runtime');
    await rm(cache,{recursive:true,force:true});
    report.pendingCacheRemoval = {removed:cache,
      retainedObjectStore:join(runtime,'.celld/dev/objects.sqlite3'),retainedStoreSidecars:true};
    progress('Removed all local runtime data while accepted work is still unfinished');
  }
  phase = 'after-crash';
  await start('after-crash');

  // Deliberately no session request here. Only the observer and /health are used.
  // If celld's waker does not revive the sessions, this check fails visibly.
  await eventually(async () => Object.fromEntries([...cases].filter(([name]) => name !== 'completed').map(([name,state]) => [name,
    {boots:state.events.filter((event) => event.type === 'boot' && event.phase === 'after-crash'),
      settled:state.events.filter((event) => event.type === 'settled' && event.phase === 'after-crash')} ])),
    (value) => Object.entries(value).every(([name,state]) => state.boots.length > 0
      && state.boots.every((event) => event.activatedBy === 'alarm')
      && [`${name}-1`,`${name}-2`].every((id) => state.settled.some((event) => event.operationId === id
        && event.result?.status === 'done'))),
    'Alarm-only activation and completion without reconnecting to any session', 100000);
  ok('Alarms resume and complete accepted work without a client session request');

  for (const name of ['safe','unsafe','model','lost-ack']) {
    const state = cases.get(name);
    state.after = await snapshot(name);
    assert.notEqual(state.after.bootId,state.bootBefore);
    const one = await submit(name,'Produce an artifact',`${name}-1`,state.scenario);
    const two = await submit(name,'Queued follow-up',`${name}-2`,state.scenario);
    assert.equal(one.accepted,false); assert.equal(two.accepted,false);
    assert.equal(one.operationId,state.receipt.operationId); assert.equal(two.operationId,state.queued.operationId);
    assert.equal((await result(name,`${name}-1`)).status,'done');
    assert.equal((await result(name,`${name}-2`)).status,'done');
    const transcript = messages(state.after);
    assert.equal(transcript.filter((message) => message.role === 'user').length,2);
    assert.equal(state.after.pending.length,0);
    const providerIds = state.models.map((entry) => entry.providerSessionId).filter(Boolean);
    assert.equal(providerIds.length,state.models.length,'Every request has a provider session identity');
    assert.equal(new Set(providerIds).size,1,'Provider session identity must survive recovery');
    if (name === 'model') {
      assert.ok(transcript.some((message) => message.role === 'assistant' && message.stopReason === 'aborted'
        && JSON.stringify(message.content).includes('partial answer')));
      assert.ok(state.models.some((event) => event.phase === 'after-crash'));
    } else if (state.scenario === 'unsafe') {
      assert.equal(state.tools.length,1); assert.equal(state.effects.length,1);
      const toolResult = transcript.find((message) => message.role === 'toolResult');
      assert.equal(toolResult?.isError,true);
      assert.match(JSON.stringify(toolResult),/interrupted.*may have partially run/);
    } else {
      assert.equal(state.tools.length,2);
      assert.equal(state.tools[0].artifactId,state.tools[1].artifactId);
      const bytes = await readFile(join(directory,'artifacts',`${state.tools[0].artifactId}.md`),'utf8');
      assert.equal(bytes,state.tools[0].content);
      assert.equal(state.tools[0].content,state.tools[1].content);
      state.artifactSha256 = createHash('sha256').update(bytes).digest('hex');
      assert.equal(transcript.filter((message) => message.role === 'toolResult').length,1);
    }
    ok(`${name}: recovery, submission deduplication, queue and session identity`);
  }
  const completedAfter = await snapshot('completed');
  assert.equal(cases.get('completed').tools.length,1,'A completed tool is not re-executed on reopen');
  assert.deepEqual(messages(completedAfter),messages(report.completedBefore));
  ok('Completed transcript and tool result survive reopening without another effect');

  await killRuntime('Drop all local cell caches after completed work');
  const localCache = join(runtime,'.celld/dev/runtime');
  await rm(localCache,{recursive:true,force:true});
  report.freshCache = {removed:localCache,retainedObjectStore:join(runtime,'.celld/dev/objects.sqlite3')};
  phase = 'fresh-cache';
  await start('fresh-cache');
  for (const [name,state] of cases) {
    const value = await snapshot(name);
    const expected = name === 'completed' ? report.completedBefore : state.after;
    assert.deepEqual(messages(value),messages(expected), `${name} transcript must restore from backing object store`);
    assert.equal(value.pending.length,0);
  }
  assert.equal(cases.get('completed').tools.length,1);
  assert.equal(cases.get('safe').tools.length,2);
  assert.equal(cases.get('unsafe').effects.length,1);
  ok('Every transcript restores after removing celld local caches and retaining only its dev object store');
  assert.equal(events.filter((event) => event.type === 'observer-error').length,0);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = {message:error.message,stack:error.stack};
  if (child) report.lastRuntimeLog = child.probeLog?.().slice(-16000);
  progress(`FAILED: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (child) await killRuntime('Experiment cleanup').catch((error) => { report.cleanupError = String(error); });
  if (observer) { observer.server.closeAllConnections(); await new Promise((r) => observer.server.close(r)); }
  report.finishedAt = new Date().toISOString();
  report.sessions = Object.fromEntries(cases);
  await mkdir(dirname(output),{recursive:true});
  await writeFile(output,JSON.stringify(report,null,2)+'\n');
  progress(`Evidence written to ${output}`);
}
