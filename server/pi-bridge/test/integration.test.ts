import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { startBridge } from '../bridge';
import { createPiDriver } from '../../../src/session/pi';
import { SessionStore } from '../../../src/session/store';
import { DEMO_ARTIFACT_REPLY } from '../../../src/harness/demo-artifacts';
import { parseClientFrame, parseServerFrame } from '../../../src/harness/protocol';
import type { HarnessDriver, HarnessUpdate } from '../../../src/session/types';

const cli = resolve(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))), 'cli.js');
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate: () => unknown, label: string, timeout = 20_000) {
  const end = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > end) throw new Error(`Timed out: ${label}`); await delay(20); }
}

test('real pinned pi + authenticated bridge + native session driver, with only a loopback model', { timeout: 90_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'perch-real-pi-'));
  const agentDir = join(directory, 'agent'); await mkdir(agentDir);
  const workspace = join(directory, 'workspace'); await mkdir(workspace);
  const token = 'synthetic-test-token-never-use-in-production';
  let requests = 0;
  let streamed = false;
  const model = createServer(async (request, response) => {
    if (request.url !== '/v1/chat/completions') { response.writeHead(404); response.end(); return; }
    requests++;
    let body = ''; for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    assert.equal(input.model === 'fixture-model' || input.model === 'fixture-model-2', true);
    const messages = input.messages as Array<{ role: string; content: unknown }>;
    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    const slow = JSON.stringify(lastUser?.content).includes('slow');
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    let cancelled = false; response.on('close', () => { cancelled = true; });
    const send = (delta: unknown, finish_reason: string | null = null) => {
      if (cancelled) return;
      response.write(`data: ${JSON.stringify({ id: 'synthetic-completion', object: 'chat.completion.chunk', created: 1700000000, model: input.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    };
    if (!messages.some(m => m.role === 'tool') && !slow) {
      send({ role: 'assistant', content: 'Writing a synthetic helper.\u2028The separator is part of the text.' });
      send({ tool_calls: [{ index: 0, id: 'fixture-write', type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: 'example.ts', content: 'export const answer = 42;\n' }) } }] });
      send({}, 'tool_calls');
    } else {
      const reply = slow ? 'Synthetic slow response. '.repeat(60) : DEMO_ARTIFACT_REPLY;
      const chunks = reply.match(/[\s\S]{1,120}/g) ?? [];
      send({ role: 'assistant', content: '' });
      for (const content of chunks) { if (cancelled) break; send({ content }); await delay(slow ? 150 : 10); }
      send({}, 'stop');
    }
    if (!cancelled) { response.write('data: [DONE]\n\n'); response.end(); }
  });
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
  const port = (model.address() as { port: number }).port;
  await writeFile(join(agentDir, 'models.json'), JSON.stringify({ providers: { 'perch-fixture': { baseUrl: `http://127.0.0.1:${port}/v1`, api: 'openai-completions', apiKey: 'public-fixture', models: [{ id: 'fixture-model', contextWindow: 32000, maxTokens: 4096 }, { id: 'fixture-model-2', contextWindow: 32000, maxTokens: 4096 }] } } }));
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ autoCompact: false, retry: { enabled: false } }));
  let bridge: Awaited<ReturnType<typeof startBridge>> | undefined;
  let driver: HarnessDriver | undefined;
  let next: HarnessDriver | undefined;
  const store = new SessionStore();
  try {
    bridge = await startBridge({ token, binary: process.execPath, args: [cli, '--offline', '--no-approve', '--no-session', '--no-mcp', '--no-extensions', '--no-skills', '--no-context-files', '--no-prompt-templates', '--extension', resolve('fixtures/questions.ts'), '--provider', 'perch-fixture', '--model', 'fixture-model', '--tools', 'write', '--mode', 'rpc'], cwd: workspace, version: '1.0.4', env: { ...process.env, PERCH_BRIDGE_TOKEN: token, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1' }, port: 0 });
    const url = `ws://127.0.0.1:${(bridge.address as { port: number }).port}/session`;
    assert.equal(requests, 0, 'Starting pi and bridge does not invoke a model');
    const nativeOrigin = url.replace(/^ws:/, 'http:').replace(/\/session$/, '');
    async function authenticatedSnapshot(origin: string, host?: string) {
      const socket = new WebSocket(url, { origin, ...(host ? { headers: { Host: host } } : {}) });
      try {
        return await new Promise<unknown>((resolve, reject) => {
          socket.once('open', () => socket.send(JSON.stringify({ type: 'hello', protocol: 1, token })));
          socket.once('message', data => resolve(JSON.parse(data.toString())));
          socket.once('error', reject);
          socket.once('unexpected-response', (_request, response) => { response.resume(); reject(new Error('Unexpected HTTP ' + response.statusCode)); });
        });
      } finally { socket.terminate(); }
    }
    assert.equal((await authenticatedSnapshot(nativeOrigin) as { type: string }).type, 'snapshot', 'Android default endpoint Origin can authenticate');
    assert.equal((await authenticatedSnapshot('https://perch.example:443', 'Perch.Example') as { type: string }).type, 'snapshot', 'TLS proxy Host/default-port origin is normalized');
    const foreignOrigin = new WebSocket(url, { origin: 'https://another-site.invalid' });
    foreignOrigin.on('error', () => {});
    const foreignStatus = await new Promise<number | undefined>(resolve => {
      foreignOrigin.once('unexpected-response', (_request, response) => { response.resume(); foreignOrigin.terminate(); resolve(response.statusCode); });
    });
    assert.equal(foreignStatus, 403, 'An unrelated browser Origin is rejected');
    let unauthenticatedFrames = 0;
    const denied = new WebSocket(url, { origin: nativeOrigin });
    denied.on('message', () => { unauthenticatedFrames++; });
    const deniedCode = new Promise<number>(resolve => denied.on('close', code => resolve(code)));
    denied.on('open', () => denied.send(JSON.stringify({ type: 'hello', protocol: 1, token: 'wrong' })));
    assert.equal(await deniedCode, 4401, 'Wrong token is rejected before a snapshot');
    assert.equal(unauthenticatedFrames, 0, 'Allowed native Origin does not grant session access without the token');
    let state: HarnessUpdate | undefined;
    driver = createPiDriver({ url, token }, update => { state = update; if (update.messages.some(m => m.streaming)) streamed = true; });
    assert.equal(state, undefined, 'Constructing the driver does not connect');
    driver.connect(); await until(() => state?.connection.status === 'live', 'authenticated pi snapshot');
    assert.equal(state!.harness.id, 'pi'); assert.equal(state!.model?.provider, 'perch-fixture');
    assert.equal(state!.availableModels?.filter(m => m.provider === 'perch-fixture').length, 2);
    driver.sendPrompt('/perch-secret-check');
    await until(() => state?.messages.some(m => m.text === 'Bridge token is absent from agent environment.'), 'bridge token excluded from agent subprocess');
    driver.sendPrompt('Generate the synthetic artifact examples.');
    await until(() => state?.messages.some(m => m.text.includes('workspace-card.html')) && !state.isWorking, 'actual pi model/tool completion');
    assert.equal(streamed, true, 'Pi deltas update a streaming native message');
    assert.equal(await readFile(join(workspace, 'example.ts'), 'utf8'), 'export const answer = 42;\n');
    assert.equal(state!.tools.find(t => t.id === 'fixture-write')?.artifact?.content, 'export const answer = 42;\n');
    assert.equal(state!.tools.find(t => t.id === 'fixture-write')?.status, 'done');
    assert(state!.messages.some(m => m.text.includes('\u2028')), 'LF reader preserves Unicode separators');
    assert.equal(requests, 2, 'One real tool round-trip used only the loopback model');
    driver.setModel?.('perch-fixture', 'fixture-model-2');
    await until(() => state?.model?.id === 'fixture-model-2', 'server-side configured model change');
    driver.sendPrompt('/perch-question');
    await until(() => state?.pendingQuestion?.kind === 'choice', 'real pi extension select');
    const question = state!.pendingQuestion!;
    driver.reconnect(); await until(() => state?.connection.status === 'live' && state.pendingQuestion?.id === question.id, 'question survives reconnect');
    driver.answerQuestion({ ...question, id: 'stale' }, '0'); await delay(50);
    assert.equal(state!.pendingQuestion?.id, question.id, 'Stale question cannot be answered');
    driver.answerQuestion(question, '0');
    await until(() => !state?.pendingQuestion && state?.messages.some(m => m.text === 'Fixture received: Preview'), 'answer reaches actual pi extension');
    driver.sendPrompt('/perch-editor'); await until(() => state?.pendingQuestion?.kind === 'editor', 'real pi extension editor');
    driver.answerQuestion(state!.pendingQuestion!, 'A small phone note.');
    await until(() => state?.messages.some(m => m.text === 'Fixture note: A small phone note.'), 'editor roundtrip');
    driver.sendPrompt('slow fixture for disconnect'); await until(() => state?.isWorking && state.messages.some(m => m.streaming), 'slow run');
    driver.close(); driver = undefined;
    next = createPiDriver({ url, token }, update => { state = update; }); next.connect();
    await until(() => state?.connection.status === 'live' && state.isWorking, 'reconnect attaches to same running process');
    next.interrupt(); await until(() => !state?.isWorking, 'actual pi abort settles');
    assert.equal(state!.messages.filter(m => m.role === 'user' && m.text === 'slow fixture for disconnect').length, 1, 'Reconnect does not replay prompts');
    assert.equal(requests, 3);
    await store.connectPi({ url, token }); await until(() => store.getSnapshot().connection.status === 'live', 'public store integration');
    assert.equal(store.getSnapshot().mode, 'pi');
    store.useDemo(); await delay(50); assert.equal(store.getSnapshot().harness.id, 'demo', 'Stale pi callbacks cannot overwrite demo');
  } finally {
    driver?.close(); next?.close(); store.dispose(); await bridge?.close();
    model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('wire boundary rejects wrong versions, arbitrary commands and insecure remote URL', () => {
  assert.throws(() => parseClientFrame({ type: 'bash', id: '1', command: 'anything' }));
  assert.throws(() => parseServerFrame({ type: 'snapshot', protocol: 99 }));
  assert.throws(() => createPiDriver({ url: 'ws://example.com/session', token: 'a'.repeat(32) }, () => {}));
  assert.throws(() => createPiDriver({ url: 'wss://example.com/session?token=secret', token: 'a'.repeat(32) }, () => {}));
});
