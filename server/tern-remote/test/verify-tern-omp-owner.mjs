/** Optional actual Tern + actual OMP same-process owner request qualification. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createTernRemoteServer } from '../bridge.mjs';
import { parseRemoteCatalog, parseRemoteHealth, parseRemoteReceipt, parseRemoteSnapshot } from '../../../src/harness/remote.ts';
import { DEVICE_TOKEN, PLUGIN_TOKEN, listen, requestJSON } from './helpers.mjs';

const tern = process.env.TERN_BIN;
assert.ok(tern, 'Set TERN_BIN to the separately installed Tern executable.');
const here = dirname(fileURLToPath(import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'perch-tern-omp-owner-'));
const crate = join(directory, 'crates', 'tern');
const plugin = join(directory, 'crates', 'plugins', 'fixtures', 'perch-remote');
const work = join(directory, 'work');
const log = join(directory, 'owner-events.jsonl');
const server = createTernRemoteServer({ token: DEVICE_TOKEN, pluginToken: PLUGIN_TOKEN, snapshotWaitMs: 5_000 });
let child, pump, pumping = false, logs = '';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const run = (argv, timeoutMs = 15_000) => new Promise((resolve, reject) => {
  const proc = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  proc.stdout.on('data', data => { out += data; }); proc.stderr.on('data', data => { err += data; });
  const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error(`Timed out: ${argv[1]}`)); }, timeoutMs);
  proc.on('error', error => { clearTimeout(timer); reject(error); });
  proc.on('exit', code => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(err || out)); });
});
const events = async () => (await readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse);

try {
  const version = (await run([tern, '--version'])).trim();
  const origin = await listen(server);
  await mkdir(join(crate, 'goldens'), { recursive: true }); await mkdir(plugin, { recursive: true }); await mkdir(work);
  for (const name of ['plugin.toml', 'window.luau', 'requests.luau']) await copyFile(join(here, '..', 'plugin', name), join(plugin, name));
  if (process.env.PERCH_TERN_PROFILE === '1') {
    let window = await readFile(join(plugin, 'window.luau'), 'utf8');
    for (const [target, label] of [['local entries = array(cx.agents:list())', 'agents'],
      ['local source = array(cx.agents:transcript(entry.pane, { last = 64 }))', 'transcript'],
      ['local question, modal = requests:read(cx, entry.pane, currentGeneration)', 'requests']]) {
      window = window.replace(target, `tern.log.warn("profile ${label} start", tern.now())\n${target}\ntern.log.warn("profile ${label} end", tern.now())`);
    }
    await writeFile(join(plugin, 'window.luau'), window);
    let requests = await readFile(join(plugin, 'requests.luau'), 'utf8');
    requests = requests.replace('local current = cx.session:surface', 'tern.log.warn("profile surface start", name, tern.now())\nlocal current = cx.session:surface')
      .replace('if type(current) ~= "table"', 'tern.log.warn("profile surface end", name, tern.now())\nif type(current) ~= "table"')
      .replace('local decision = extract(merged)', 'tern.log.warn("profile extract start", tern.now())\nlocal decision = extract(merged)\ntern.log.warn("profile extract end", tern.now())');
    await writeFile(join(plugin, 'requests.luau'), requests);
  }
  await writeFile(join(plugin, 'connection.json'), JSON.stringify({ url: origin, token: PLUGIN_TOKEN }), { mode: 0o600 });
  const launcher = join(directory, 'omp');
  await writeFile(launcher, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(here, 'omp-owner-child.mjs'))} ${quote(log)} ${quote(work)}\n`, { mode: 0o700 });
  child = spawn(tern, ['serve', '--control', '0', '--out', join(directory, 'shots')], {
    cwd: directory, env: { ...process.env, STENCIL_FIXTURE_ROOT: crate, TERN_CONFIG_DIR: join(directory, 'config'),
      STENCIL_LOG_DIR: join(directory, 'logs'), STENCIL_LOG: 'warn,tern::plugin=debug',
      // Software fixtures must not create one raster worker per host CPU when
      // the container has a much smaller quota. This does not change Tern's budget.
      LP_NUM_THREADS: process.env.LP_NUM_THREADS || '1',
      NO_PROXY: '127.0.0.1,localhost,::1', no_proxy: '127.0.0.1,localhost,::1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', data => { logs += data; });
  let port;
  child.stdout.on('data', data => { logs += data; for (const line of String(data).split('\n')) {
    try { const value = JSON.parse(line); if (value.control?.port) port = value.control.port; } catch {}
  } });
  const startupDeadline = Date.now() + 15_000;
  while (!port && Date.now() < startupDeadline && child.exitCode === null) await sleep(25);
  assert.ok(port, `Tern failed to start. ${logs.slice(-3000)}`);
  const ctl = async (...args) => {
    const result = JSON.parse(await run([tern, 'ctl', '--control', String(port), ...args]));
    assert.equal(result.ok, true, JSON.stringify(result)); return result;
  };
  await ctl('plugins', 'fixtures'); await ctl('run', JSON.stringify(quote(launcher)));
  pumping = true;
  pump = (async () => { for (let i = 0; pumping && i < 1000; i++) { await ctl('wait', '250'); await sleep(50); } })()
    .catch(error => { if (pumping) logs += `control pump: ${error.message}\n`; });
  const until = async (read, accept, label) => {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const value = await read(); if (accept(value)) return value;
      const failed = (await events()).find(event => event.type === 'error'); if (failed) throw new Error(failed.message);
      await sleep(150);
    }
    throw new Error(`${label} did not arrive. Child: ${JSON.stringify(await events())}. ${logs.slice(-4000)}`);
  };
  const health = parseRemoteHealth((await requestJSON(origin, '/perch/health')).value);
  const catalog = await until(async () => parseRemoteCatalog((await requestJSON(origin, '/perch/sessions')).value),
    value => value.sessions.length > 0, 'OMP session discovery');
  const session = catalog.sessions[0], sessionPath = `/perch/sessions/${session.id}`;
  const snapshot = async () => {
    const response = await requestJSON(origin, sessionPath);
    assert.equal(response.status, 200, `Snapshot failed: ${JSON.stringify(response.value)}`);
    return parseRemoteSnapshot(response.value);
  };
  const answer = async (id, view, label) => {
    const q = view.pendingQuestion; assert.ok(q);
    const option = q.options.find(item => typeof label === 'string' ? item.label === label : label.test(item.label));
    assert.ok(option && !option.disabled, JSON.stringify(q));
    const command = { id, epoch: health.epoch, generation: session.generation, type: 'answer',
      requestId: q.id, requestRevision: q.revision, answer: option.id };
    const accepted = (await requestJSON(origin, `${sessionPath}/commands`, { method: 'POST', value: command })).value;
    assert.equal(accepted.status, 'pending', JSON.stringify(accepted));
    const receipt = await until(async () => parseRemoteReceipt((await requestJSON(origin, `${sessionPath}/operations/${id}`)).value),
      value => value.status !== 'pending', 'answer forwarding receipt');
    assert.equal(receipt.status, 'forwarded', JSON.stringify(receipt));
    return command;
  };
  const first = await until(snapshot, view => view.pendingQuestion?.category === 'approval', 'first real tool approval');
  assert.equal(first.capabilities.questions, true, JSON.stringify(first.pendingQuestion));
  assert.match(first.pendingQuestion.prompt, /This exact inert tool requires a decision/);
  const denied = await answer('deny-tool', first, 'Deny');
  const second = await until(snapshot, view => view.pendingQuestion?.category === 'approval' && view.pendingQuestion.id !== first.pendingQuestion.id,
    'second identical real tool approval');
  assert.equal((await events()).filter(event => event.type === 'tool-executed').length, 0);
  const stale = (await requestJSON(origin, `${sessionPath}/commands`, { method: 'POST', value: { ...denied, id: 'stale-answer' } })).value;
  assert.equal(stale.status, 'rejected');
  const approved = await answer('approve-tool', second, 'Approve');
  const plan = await until(snapshot, view => view.pendingQuestion?.category === 'plan', 'real plan review');
  const originalPlan = await readFile(join(work, 'owner-plan.md'), 'utf8');
  const [planHeading, ...planLines] = originalPlan.split('\n');
  const normalized = text => text.replace(/\n{3,}/g, '\n\n').trim();
  // OMP places the one top-level heading in the sheet title, then exposes each
  // remaining section as Markdown. Verify every line, not just a quoted clause.
  assert.equal(plan.pendingQuestion.document.title, planHeading.replace(/^#\s+/, ''));
  assert.equal(normalized(plan.pendingQuestion.document.content), normalized(planLines.join('\n')));
  assert.equal(plan.pendingQuestion.actionable, true);
  assert.equal((await events()).filter(event => event.type === 'tool-executed').length, 1);
  const duplicate = (await requestJSON(origin, `${sessionPath}/commands`, { method: 'POST', value: approved })).value;
  assert.equal(duplicate.status, 'forwarded');
  await answer('refine-plan', plan, 'Refine plan');
  const ready = await until(snapshot, view => !view.pendingQuestion && view.capabilities.prompt, 'normal composer after Refine');
  assert.equal(ready.session.generation, first.session.generation);
  const prompt = { id: 'explicit-feedback', epoch: health.epoch, generation: session.generation, type: 'prompt',
    text: 'Phone feedback 🦜\nKeep the plan focused.' };
  assert.equal((await requestJSON(origin, `${sessionPath}/commands`, { method: 'POST', value: prompt })).value.status, 'pending');
  const reviewed = await until(snapshot, view => view.pendingQuestion?.category === 'plan' && view.pendingQuestion.id !== plan.pendingQuestion.id,
    'reopened plan after explicit feedback');
  assert.equal(reviewed.pendingQuestion.document.title, plan.pendingQuestion.document.title);
  assert.equal(reviewed.pendingQuestion.document.content, plan.pendingQuestion.document.content);
  await answer('approve-plan', reviewed, /^Approve and keep context/);
  const finalEvents = await until(events, values => values.some(event => event.type === 'done'), 'completed real owner flow');
  assert.equal(finalEvents.filter(event => event.type === 'tool-executed').length, 1);
  assert.equal(finalEvents.filter(event => event.type === 'phone-feedback').length, 1);
  assert.equal(finalEvents.find(event => event.type === 'phone-feedback').text, prompt.text);
  assert.ok(finalEvents.every(event => event.pid === finalEvents[0].pid));
  assert.equal(finalEvents[0].native, true);
  assert.ok(typeof finalEvents[0].sessionId === 'string' && finalEvents[0].sessionId.trim().length > 0);
  assert.ok(finalEvents.every(event => event.sessionId === finalEvents[0].sessionId), 'Every owner event must belong to the original canonical OMP session.');
  assert.equal(finalEvents.at(-1).modelCalls, 6);
  assert.equal(finalEvents.at(-1).paidProviderCalls, 0);
  await requestJSON(origin, '/perch/health'); await requestJSON(origin, '/perch/sessions'); await snapshot();
  assert.equal((await events()).filter(event => event.type === 'tool-executed').length, 1);
  const result = { verified: true, ternVersion: version, ompVersion: '18.8.7', agentSessionsCreated: 1,
    samePid: true, sameConversation: finalEvents[0].sessionId === finalEvents.at(-1).sessionId,
    modelCalls: 6, paidProviderCalls: 0, inertToolExecutions: 1,
    checks: ['Production plugin and bridge discover an actual OMP process in an actual Tern PTY.',
      'HTTP Deny resolves the native tool approval with no tool execution.',
      'A stale identical request answer is rejected; current Approve executes the inert tool once.',
      'The exact plan heading and all body text are exposed; Refine returns to the real composer.',
      'A separate explicit Unicode feedback prompt enters the original planning conversation.',
      'Approve and keep context continues the original session through the upstream mock provider.',
      'Duplicate receipt lookup and reconnect reads do not repeat effects.'],
    limitations: ['Headless fixture Tern window, not a restored user desktop or physical Android device.',
      'TSP events have no upstream expected-document-revision guard. Forwarded means event dispatch, not persisted external effects.'] };
  if (process.env.PERCH_OMP_OWNER_RESULT) await writeFile(process.env.PERCH_OMP_OWNER_RESULT, JSON.stringify({ result, events: finalEvents }, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.stack ?? error); console.error(JSON.stringify(await events(), null, 2)); console.error(logs.slice(-5000));
  process.exitCode = 1;
} finally {
  pumping = false; if (pump) await pump;
  for (const event of await events()) if (event.type === 'started') { try { process.kill(event.pid, 'SIGTERM'); } catch {} }
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await Promise.race([new Promise(resolve => child.once('exit', resolve)), sleep(1000)]);
    if (child.exitCode === null) child.kill('SIGKILL'); }
  await new Promise(resolve => server.close(resolve));
  if (process.env.PERCH_TERN_KEEP_FAILURE === '1' && process.exitCode) {
    await writeFile(join(directory, 'tern.log'), logs);
    console.error(`Kept diagnostic directory: ${directory}`);
  } else await rm(directory, { recursive: true, force: true });
}
