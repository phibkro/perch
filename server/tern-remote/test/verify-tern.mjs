/** Optional integration check using the user's separately installed Tern beta. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTernRemoteServer } from '../bridge.mjs';
import { parseRemoteCatalog, parseRemoteHealth, parseRemoteReceipt, parseRemoteSnapshot } from '../../../src/harness/remote.ts';
import { DEVICE_TOKEN, PLUGIN_TOKEN, listen, requestJSON } from './helpers.mjs';

const tern = process.env.TERN_BIN;
if (!tern) { console.error('Set TERN_BIN to your installed Tern executable. The beta is not bundled.'); process.exit(1); }
const loopback = process.argv.includes('--loopback');
const oversized = process.argv.includes('--oversized');
const focus = process.argv.includes('--focus');
const here = dirname(fileURLToPath(import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'perch-tern-runtime-'));
const crate = join(directory, 'crates', 'tern');
const plugin = join(directory, 'crates', 'plugins', 'fixtures', 'perch-remote');
const log = join(directory, 'omp-events.jsonl');
const server = createTernRemoteServer({ token: DEVICE_TOKEN, pluginToken: PLUGIN_TOKEN, snapshotWaitMs: 5_000 });
let child;
let logs = '';
let pumping = false;
let pump;
server.on('request', request => { logs += `bridge ${request.method} ${request.url}\n`; });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function run(argv, timeoutMs = 15_000) {
  return new Promise((resolveResult, reject) => {
    const p = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', b => { out += b; }); p.stderr.on('data', b => { err += b; });
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`Timed out: ${argv[1]}`)); }, timeoutMs);
    p.on('error', error => { clearTimeout(timer); reject(error); });
    p.on('exit', code => { clearTimeout(timer); code === 0 ? resolveResult(out) : reject(new Error(`${argv.slice(1, 4).join(' ')}: ${err || out}`)); });
  });
}

try {
  const version = (await run([tern, '--version'])).trim();
  const origin = await listen(server);
  await mkdir(join(crate, 'goldens'), { recursive: true });
  await mkdir(plugin, { recursive: true, mode: 0o700 });
  for (const name of ['plugin.toml', 'window.luau', 'requests.luau']) await copyFile(join(here, '..', 'plugin', name), join(plugin, name));
  await writeFile(join(plugin, 'connection.json'), JSON.stringify({ url: origin, token: PLUGIN_TOKEN }), { mode: 0o600 });
  const fakeOmp = join(directory, 'omp');
  const program = String.raw`#!/usr/bin/env python3
import json,os,re,signal,sys,termios,time,tty
LOG = sys.argv[1]
OVERSIZED = ${oversized ? 'True' : 'False'}
SF = "fixture-omp-session"
sequence = 1
def record(value):
    with open(LOG, "a") as f: f.write(json.dumps({**value,"pid":os.getpid()})+"\n")
def write(verb, body):
    sys.stdout.write("\x1b_tsp;"+verb+";"+json.dumps(body)+"\x1b\\")
    sys.stdout.flush()
def interrupted(*args): record({"type":"interrupt"})
signal.signal(signal.SIGINT, interrupted)
tty.setraw(sys.stdin.fileno())
record({"type":"started"})
write("q", {"q":"hello","v":[1],"app":"omp","ver":"perch-fixture","features":["send"]})
write("o", {"id":SF,"mode":"inline","title":"OMP local protocol fixture","role":"omp.session"})
write("f", {"sf":SF,"s":sequence,"ops":[
 ["add","main",SF,None,{"id":"main","k":"col","c":[
  {"id":"m1","k":"card","p":{"role":"omp.user"},"c":[{"id":"m1text","k":"md","p":{"text":"Existing fixture question"}}]},
  {"id":"m2","k":"col","p":{"role":"omp.assistant"},"c":[{"id":"m2text","k":"md","p":{"text":"# Existing artifact\n\nSynthetic TSP content, no model call."}}]}
 ]}],
 ["add","dock",SF,None,{"id":"dock","k":"col","c":[{"id":"composer-wrap","k":"col","p":{"role":"omp.editor"},"c":[{"id":"composer","k":"editor","p":{"text":"","sendable":True}}]}]}],
 ["add","layer",SF,None,{"id":"layer","k":"col"}],
 ["focus","composer"]
]})
buffer = b""
while True:
    data = os.read(sys.stdin.fileno(), 65536)
    if not data: break
    if b"\x03" in data: interrupted()
    buffer += data.replace(b"\x03",b"")
    while b"\x1b\\" in buffer:
        raw,buffer = buffer.split(b"\x1b\\",1)
        at = raw.find(b"\x1b_tsp;e;")
        if at < 0: continue
        try: event=json.loads(raw[at+len(b"\x1b_tsp;e;"):])
        except Exception: continue
        if event.get("ev") == "send":
            record({"type":"send","text":event.get("text"),"sf":event.get("sf"),"id":event.get("id")})
            sequence += 1
            write("f", {"sf":SF,"s":sequence,"ops":[
              ["add","m3","main",None,{"id":"m3","k":"card","p":{"role":"omp.user"},"c":[{"id":"m3text","k":"md","p":{"text":event["text"]}}]}],
              ["add","m4","main",None,{"id":"m4","k":"col","p":{"role":"omp.assistant"},"c":[{"id":"m4text","k":"md","p":{"text":"Synthetic fixture accepted this atomic send."}}]}],
              ["set","composer",{"sendable":False}]
            ]})
            if OVERSIZED:
                sequence += 1
                write("f", {"sf":SF,"s":sequence,"ops":[["add","plan","layer",None,
                  {"id":"plan","k":"overlay","p":{"role":"omp.overlay.planReview","head":"Oversized plan","modal":True},"c":[
                    {"id":"plan.body","k":"col","p":{"role":"omp.plan.body"},"c":[
                      {"id":"plan.md","k":"md","p":{"text":"Full plan context: " + "x"*65000 + " End of plan."}}]},
                    {"id":"plan.options","k":"list","p":{"role":"omp.plan.options"},"c":[
                      {"id":"plan.options/o0","k":"item","p":{"label":"Approve and execute"}},
                      {"id":"plan.options/o1","k":"item","p":{"label":"Refine plan"}}]}
                  ]}]]})
        elif event.get("ev") == "activate":
            record({"type":"activate","id":event.get("id"),"item":event.get("item")})
`;
  await writeFile(fakeOmp, program, { mode: 0o700 });
  child = spawn(tern, ['serve', '--control', '0', '--out', join(directory, 'shots')], {
    cwd: directory, env: { ...process.env, STENCIL_FIXTURE_ROOT: crate,
      TERN_CONFIG_DIR: join(directory, 'config'), STENCIL_LOG_DIR: join(directory, 'logs'),
      LP_NUM_THREADS: process.env.LP_NUM_THREADS || '1',
      STENCIL_LOG: 'warn,tern::plugin=debug', NO_PROXY: '127.0.0.1,localhost,::1', no_proxy: '127.0.0.1,localhost,::1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', b => { logs += b; });
  let port;
  child.stdout.on('data', b => {
    logs += b;
    for (const line of String(b).split('\n')) {
      try { const value = JSON.parse(line); if (value.control?.port) port = value.control.port; } catch {}
    }
  });
  const timeout = Date.now() + 15_000;
  while (!port && Date.now() < timeout && child.exitCode === null) await sleep(25);
  assert.ok(port, `Tern did not start its supported headless control endpoint. ${logs.slice(-4000)}`);
  const ctl = async (...args) => {
    const result = JSON.parse(await run([tern, 'ctl', '--control', String(port), ...args]));
    assert.equal(result.ok, true, JSON.stringify(result));
    return result;
  };
  await ctl('plugins', 'fixtures');
  if (loopback) await ctl('remote', 'loopback', 'fixture@perch-fixture-remote');
  await ctl('run', JSON.stringify(`${fakeOmp} ${log}`));
  // Headless Tern dispatches owner-thread fetch/timer callbacks when a scenario
  // advances it. Keep advancing while an HTTP snapshot waits for that callback.
  // The production plugin uses no control endpoint.
  pumping = true;
  pump = (async () => {
    for (let i = 0; pumping && i < 500; i++) {
      await ctl('wait', '250');
      await sleep(75);
    }
  })().catch(error => { if (pumping) logs += `control pump: ${error.message}\n`; });
  async function until(read, accept, label) {
    for (let i = 0; i < 30; i++) {
      await sleep(150);
      const value = await read();
      if (accept(value)) return value;
    }
    const state = await ctl('state');
    const events = await readFile(log, 'utf8').catch(() => 'No child events.');
    throw new Error(`${label} did not arrive. Child: ${events.slice(-6000)}. State: ${JSON.stringify(state)}. ${logs.slice(-2500)}`);
  }
  const health = parseRemoteHealth((await requestJSON(origin, '/perch/health')).value);
  const catalog = await until(async () => parseRemoteCatalog((await requestJSON(origin, '/perch/sessions')).value),
    value => value.sessions.length > 0, 'Plugin agent catalog');
  const session = catalog.sessions[0];
  if (loopback) assert.equal(session.location?.host, 'perch-fixture-remote');
  const sessionPath = `/perch/sessions/${session.id}`;
  // Reading a pane requests an on-demand transcript from the next plugin poll.
  const pendingSnapshot = requestJSON(origin, sessionPath);
  const firstResponse = await pendingSnapshot;
  assert.equal(firstResponse.status, 200, JSON.stringify(firstResponse));
  const snapshot = parseRemoteSnapshot(firstResponse.value);
  assert.equal(snapshot.session.id, session.id);
  assert.equal(snapshot.capabilities.prompt, true, JSON.stringify(snapshot));
  assert.equal(snapshot.messages.length, 2, JSON.stringify(snapshot));
  assert.match(snapshot.messages[1].text, /Existing artifact/);
  if (focus) {
    assert.equal(snapshot.capabilities.focusSession, true);
    const target = Number(session.location.pane);
    assert.ok(Number.isSafeInteger(target));
    await ctl('new-blocks', 'shell');
    await ctl('tab', 'new');
    const other = (await ctl('state')).focused.id;
    assert.notEqual(other, target);
    const focusCommand = { id: 'explicit-pane-focus', epoch: health.epoch, generation: session.generation, type: 'focus-session' };
    assert.equal((await requestJSON(origin, `${sessionPath}/commands`, { method: 'POST', value: focusCommand })).value.status, 'pending');
    const focusReceipt = await until(async () => parseRemoteReceipt((await requestJSON(origin,
      `${sessionPath}/operations/${focusCommand.id}`)).value), value => value.status !== 'pending', 'Tern focus receipt');
    assert.equal(focusReceipt.status, 'forwarded', JSON.stringify(focusReceipt));
    assert.equal((await ctl('state')).focused.id, target);
    await ctl('tab', 'next');
    assert.equal((await ctl('state')).focused.id, other);
    assert.equal((await requestJSON(origin, `${sessionPath}/commands`, { method: 'POST', value: focusCommand })).value.status, 'forwarded');
    await requestJSON(origin, '/perch/health');
    await requestJSON(origin, '/perch/sessions');
    await requestJSON(origin, `${sessionPath}/operations/${focusCommand.id}`);
    await ctl('wait', '500');
    assert.equal((await ctl('state')).focused.id, other, 'A repeated command receipt and reconnect reads must not refocus the desktop.');
    await ctl('tab', 'prev');
  }
  const command = { id: 'actual-atomic-send', epoch: health.epoch, generation: session.generation,
    type: 'prompt', text: 'One phone prompt 🦜\nWith another line.' };
  assert.equal((await requestJSON(origin, `${sessionPath}/commands`, { method: 'POST', value: command })).value.status, 'pending');
  const receipt = await until(async () => parseRemoteReceipt((await requestJSON(origin,
    `${sessionPath}/operations/${command.id}`)).value), value => value.status !== 'pending', 'Tern send receipt');
  assert.equal(receipt.status, 'forwarded', JSON.stringify(receipt));
  await until(async () => parseRemoteSnapshot((await requestJSON(origin, sessionPath)).value),
    value => value.messages.length === 4, 'Updated Tern transcript');
  const events = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const sent = events.filter(event => event.type === 'send');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, command.text);
  assert.equal(sent[0].id, 'composer');
  assert.equal(sent[0].pid, events[0].pid);
  // Phone reconnect consists only of fresh reads. Reusing the command ID reads
  // its receipt and never asks the existing process to do the work again.
  await requestJSON(origin, '/perch/health'); await requestJSON(origin, '/perch/sessions');
  const after = parseRemoteSnapshot((await requestJSON(origin, sessionPath)).value);
  assert.equal(after.session.generation, snapshot.session.generation);
  assert.equal(after.capabilities.prompt, false);
  if (oversized) {
    assert.equal(after.pendingQuestion?.category, 'plan', JSON.stringify(after));
    assert.equal(after.pendingQuestion.actionable, false, 'A plan clipped by the actual Tern surface read must not be answerable.');
    assert.ok(after.pendingQuestion.document.content.length <= 60_000);
    const attempted = { id: 'cannot-answer-clipped-plan', epoch: health.epoch, generation: session.generation, type: 'answer',
      requestId: after.pendingQuestion.id, requestRevision: after.pendingQuestion.revision, answer: '1' };
    assert.equal((await requestJSON(origin, `${sessionPath}/commands`, { method: 'POST', value: attempted })).value.status, 'rejected');
  }
  assert.equal((await requestJSON(origin, `${sessionPath}/commands`, { method: 'POST', value: command })).value.status, 'forwarded');
  assert.equal((await requestJSON(origin, `${sessionPath}/commands`, { method: 'POST',
    value: { ...command, id: 'not-queued' } })).value.status, 'rejected');
  const interrupt = { id: 'actual-interrupt', epoch: health.epoch, generation: session.generation, type: 'interrupt' };
  assert.equal((await requestJSON(origin, `${sessionPath}/commands`, { method: 'POST', value: interrupt })).value.status, 'pending');
  const interruptReceipt = await until(async () => parseRemoteReceipt((await requestJSON(origin,
    `${sessionPath}/operations/${interrupt.id}`)).value), value => value.status !== 'pending', 'Tern interrupt receipt');
  assert.equal(interruptReceipt.status, 'forwarded');
  await ctl('wait', '1000');
  const finalEvents = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(finalEvents.filter(event => event.type === 'send').length, 1);
  assert.equal(finalEvents.filter(event => event.type === 'interrupt').length, 1);
  assert.equal(finalEvents.filter(event => event.type === 'activate').length, 0);
  assert.ok(finalEvents.every(event => event.pid === events[0].pid));
  console.log(JSON.stringify({ version, proof: `actual Tern + our Luau plugin + ${loopback ? 'a real loopback remote daemon + ' : ''}local synthetic TSP program`,
    checks: ['session catalog', 'native protocol parsing', 'two existing messages', 'atomic Unicode send',
      'four updated messages', 'same child PID', 'reconnect without replay', 'non-ready send rejected', 'interrupt without process exit',
      ...(oversized ? ['actual Tern-capped plan stays read-only', 'no approval event for incomplete plan'] : []),
      ...(focus ? ['explicit Perch focus changes the actual Tern pane', 'duplicate focus and reconnect reads do not steal focus'] : []),
      ...(loopback ? ['already-attached remote host membership', 'prompt and interrupt through remote daemon'] : [])],
    limitations: ['No real OMP/model call', 'Headless fixture window; no restored user desktop', 'No physical Android device'] }, null, 2));
} catch (error) {
  console.error(error.stack ?? error);
  console.error(logs.slice(-6000));
  process.exitCode = 1;
} finally {
  pumping = false;
  if (pump) await pump;
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), sleep(1000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  await new Promise(resolve => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
