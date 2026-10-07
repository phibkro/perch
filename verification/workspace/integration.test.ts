import { expect, test } from 'bun:test';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { WebSocketServer } from 'ws';
import { fixture as durableFixture } from '../durable/fixture.cjs';
import { createWorkspaceGateway } from '../../server/workspace/gateway.mjs';
import { pairingCode } from '../../server/workspace/configuration.mjs';
import { SessionStore } from '../../src/session/store';
import type { HarnessUpdate } from '../../src/session/types';
import type { BridgeClientFrame } from '../../src/harness/protocol';
import { WorkspaceManager } from '../../src/workspace/manager';
import { discoverWorkspace } from '../../src/workspace/discovery';
import { parsePairingCode } from '../../src/workspace/protocol';
import { memoryWorkspacePersistence } from '../../src/workspace/persistence';

// Approved seam: real pairing/discovery -> workspace gateway -> real session
// drivers. Only the external harness transports are fixtures; no model runs.
const workspaceToken = 'workspace-integration-public-test-token-32-characters';
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean, label: string, timeout = 6_000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await wait(15);
  }
}
async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture listener.');
  return `http://127.0.0.1:${address.port}`;
}
async function closeHttp(server: Server) {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => {
    // Bun's ws compatibility layer can stop its parent listener first.
    if (error && !('code' in error && error.code === 'ERR_SERVER_NOT_RUNNING')) reject(error);
    else resolve();
  }));
}
function live(store: SessionStore, mode: 'durable' | 'pi' | 'opencode') {
  const snapshot = store.getSnapshot();
  return snapshot.mode === mode && snapshot.connection.status === 'live';
}
function displayedText(store: SessionStore, text: string) {
  return store.getSnapshot().messages.some(message => message.text === text);
}
function configFor(connections: unknown[], defaultConnectionId: string) {
  return {
    version: 1, workspace: { id: 'integration', name: 'Fixture workspace', deployment: 'self-hosted' },
    publicUrl: 'http://127.0.0.1/base', token: workspaceToken,
    listen: { hostname: '127.0.0.1', port: 0 }, allowedOrigins: [],
    defaultConnectionId, connections,
  };
}
function credentialsFor(gateway: ReturnType<typeof createWorkspaceGateway>) {
  // The bound ephemeral port is learned after startup; the mount remains /base.
  return parsePairingCode(pairingCode({
    publicUrl: `http://127.0.0.1:${gateway.server.port}/base`, token: workspaceToken,
  }));
}

async function piFixture() {
  const token = 'pi-private-fixture-token-at-least-24-characters';
  const frames: BridgeClientFrame[] = [];
  const state: HarnessUpdate = {
    harness: { id: 'pi', name: 'pi', transport: 'pi-rpc' },
    capabilities: { prompt: true, interrupt: true, questions: true, steer: false, attachments: false, modelSelection: true, sessionSelection: false, sessionCreation: false },
    connection: { status: 'live', label: 'Connected' },
    session: { id: 'pi_one', title: 'Pi host history', project: 'Fixture workspace', status: 'idle' },
    messages: [{ id: 'pi_history', role: 'assistant', text: 'Saved Pi history', createdAt: 1 }],
    model: { provider: 'local', id: 'pi-model' }, availableModels: [{ provider: 'local', id: 'pi-model' }],
    tools: [], agents: [], pendingQuestion: null, isWorking: false, readOnly: false,
  };
  let revision = 1;
  const server = createServer((_request, response) => { response.writeHead(404); response.end(); });
  const websocket = new WebSocketServer({ server, path: '/rpc' });
  const snapshot = () => JSON.stringify({ type: 'snapshot', protocol: 1, epoch: 'pi-fixture-epoch', revision, state });
  websocket.on('connection', socket => {
    let authenticated = false;
    socket.on('message', bytes => {
      const frame: BridgeClientFrame = JSON.parse(bytes.toString()); frames.push(frame);
      if (!authenticated) {
        if (frame.type !== 'hello' || frame.protocol !== 1 || frame.token !== token) { socket.close(4401); return; }
        authenticated = true; socket.send(snapshot()); return;
      }
      if (frame.type === 'prompt') {
        state.messages.push({ id: `pi_user_${frame.id}`, role: 'user', text: frame.text, createdAt: Date.now() });
        state.messages.push({ id: `pi_answer_${frame.id}`, role: 'assistant', text: 'Pi transport reply', createdAt: Date.now() });
        revision++; socket.send(JSON.stringify({ type: 'ack', id: frame.id })); socket.send(snapshot());
      }
    });
  });
  const url = (await listen(server)).replace('http:', 'ws:') + '/rpc';
  return { url, token, frames, clients: websocket.clients,
    async close() {
      for (const socket of websocket.clients) socket.terminate();
      await new Promise<void>(resolve => websocket.close(() => resolve()));
      await closeHttp(server);
    },
  };
}

test('one mounted workspace pairs Durable and Pi, restores host history, and never replays a prompt when switching', async () => {
  const durable = await durableFixture(); const pi = await piFixture();
  const gateway = createWorkspaceGateway(configFor([
    { id: 'durable', name: 'Durable', kind: 'durable', upstream: { url: durable.url, token: durable.token } },
    { id: 'pi', name: 'Pi', kind: 'pi', upstream: { url: pi.url, token: pi.token } },
  ], 'durable'));
  const store = new SessionStore(); const restoredStore = new SessionStore();
  const persistence = memoryWorkspacePersistence();
  let discoveries = 0;
  const discover: typeof discoverWorkspace = (...args) => { discoveries++; return discoverWorkspace(...args); };
  const manager = new WorkspaceManager({ sessions: store, persistence, discover, newId: () => 'paired' });
  try {
    await manager.join(credentialsFor(gateway), 'self-hosted');
    await until(() => live(store, 'durable'), 'Durable ready through paired gateway');
    expect(discoveries).toBe(1);
    expect(manager.getSnapshot().connections.map(connection => connection.id)).toEqual(['durable', 'pi']);
    expect(store.getSnapshot().activeSessionId).toBe('session_one');
    expect(displayedText(store, 'Saved history for session_one')).toBe(true);
    expect(await store.loadArtifact(store.getSnapshot().storedArtifacts[0])).toBe('\ufeff# Æ🙂 report\n\nPersisted Markdown bytes.\n');

    store.setModel('other', 'test-model');
    await until(() => store.getSnapshot().model?.provider === 'other', 'Durable model selection');
    durable.setSubmitMode('accepted-drop');
    store.sendPrompt('Durable prompt with a lost receipt');
    await until(() => displayedText(store, 'Controlled reply') && live(store, 'durable'), 'lost receipt reconciled through gateway');
    const submissions = () => durable.requests.filter((request: { path: string }) => request.path.endsWith('/submit'));
    expect(submissions()).toHaveLength(1);
    expect(durable.requests.some((request: { path: string }) => request.path.includes('/operations/'))).toBe(true);

    await manager.chooseConnection('pi');
    await until(() => live(store, 'pi'), 'Pi ready through paired gateway');
    expect(displayedText(store, 'Saved Pi history')).toBe(true);
    expect(pi.frames.filter(frame => frame.type === 'hello')).toEqual([{ type: 'hello', protocol: 1, token: pi.token }]);
    store.sendPrompt('One Pi prompt');
    await until(() => displayedText(store, 'Pi transport reply'), 'Pi prompt and snapshot');

    await manager.chooseConnection('durable');
    await until(() => live(store, 'durable') && pi.clients.size === 0, 'Pi socket closes while Durable restores');
    expect(displayedText(store, 'Durable prompt with a lost receipt')).toBe(true);
    expect(store.getSnapshot().model?.provider).toBe('other');
    await manager.chooseConnection('pi');
    await until(() => live(store, 'pi') && displayedText(store, 'One Pi prompt'), 'Pi host history restored');
    expect(discoveries).toBe(1);
    expect(submissions()).toHaveLength(1);
    expect(pi.frames.filter(frame => frame.type === 'prompt')).toHaveLength(1);

    store.dispose();
    const restored = new WorkspaceManager({ sessions: restoredStore, persistence, discover });
    await restored.initialize();
    expect(discoveries).toBe(1); // Loading saved identities is offline.
    await restored.open('paired');
    await until(() => live(restoredStore, 'pi') && displayedText(restoredStore, 'One Pi prompt'), 'saved workspace reopens last harness');
    expect(discoveries).toBe(2);
    expect(restored.getSnapshot().selectedConnectionId).toBe('pi');
    expect(pi.frames.filter(frame => frame.type === 'prompt')).toHaveLength(1);
    expect(submissions()).toHaveLength(1);
    expect(durable.requests.every((request: { authorized: boolean }) => request.authorized)).toBe(true);
    expect(pi.frames.filter(frame => frame.type === 'hello').every(frame => frame.token === pi.token)).toBe(true);
    const display = JSON.stringify([manager.getSnapshot(), restored.getSnapshot(), restoredStore.getSnapshot()]);
    for (const secret of [workspaceToken, durable.token, pi.token, 'do-not-project']) expect(display).not.toContain(secret);
  } finally {
    store.dispose(); restoredStore.dispose();
    await gateway.close(); await pi.close(); await durable.close();
  }
}, 20_000);

async function openCodeFixture() {
  const username = 'private-opencode'; const password = 'opencode-private-fixture-Æ🙂-password';
  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  const directory = '/synthetic/workspace';
  const streams = new Set<ServerResponse>();
  const requests: Array<{ method?: string; path: string; directory: string | null; authorized: boolean; body: unknown }> = [];
  let prompt: string | undefined; let busy = false; let finalText: string | undefined;
  const event = (value: unknown) => { for (const response of streams) response.write(`data: ${JSON.stringify(value)}\n\n`); };
  const history = () => [
    { info: { id: 'oc_history', sessionID: 'ses_one', role: 'assistant', time: { created: 1, completed: 2 } },
      parts: [{ id: 'oc_history_part', messageID: 'oc_history', sessionID: 'ses_one', type: 'text', text: 'Saved OpenCode history' }] },
    ...(prompt === undefined ? [] : [
      { info: { id: 'oc_prompt', sessionID: 'ses_one', role: 'user', time: { created: 3 } },
        parts: [{ id: 'oc_prompt_part', messageID: 'oc_prompt', sessionID: 'ses_one', type: 'text', text: prompt }] },
      { info: { id: 'oc_stream', sessionID: 'ses_one', role: 'assistant', time: { created: 4, ...(finalText === undefined ? {} : { completed: 5 }) } },
        parts: [{ id: 'oc_stream_part', messageID: 'oc_stream', sessionID: 'ses_one', type: 'text', text: finalText ?? '', time: { start: 4, ...(finalText === undefined ? {} : { end: 5 }) } }] },
    ]),
  ];
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url!, 'http://fixture'); const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
      const authorized = request.headers.authorization === authorization;
      requests.push({ method: request.method, path: url.pathname, directory: url.searchParams.get('directory'), authorized, body });
      const json = (value: unknown, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
      if (!authorized) return json({ error: 'Private adapter authentication failed.' }, 401);
      if (url.pathname === '/perch/health') return json({ protocol: 'perch-opencode', version: 1, healthy: true, upstreamVersion: '1.18.35', directory, privateData: password });
      if (url.searchParams.get('directory') !== directory) return json({ error: 'Wrong host directory.' }, 403);
      if (url.pathname === '/event') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.write('data: {"type":"server.connected","properties":{}}\n\n');
        streams.add(response); response.on('close', () => streams.delete(response)); return;
      }
      if (url.pathname === '/provider') return json({ all: [
        { id: 'provider_a', models: { same: { id: 'same', name: 'Shared model' } } },
        { id: 'provider_b', models: { same: { id: 'same', name: 'Shared model' } } },
      ], connected: ['provider_a', 'provider_b'], default: {} });
      if (url.pathname === '/session' && request.method === 'GET') return json([{ id: 'ses_one', title: 'OpenCode chat', directory, time: { updated: 2 } }]);
      if (url.pathname === '/session/status') return json({ ses_one: { type: busy ? 'busy' : 'idle' } });
      if (['/permission', '/question'].includes(url.pathname)) return json([]);
      if (url.pathname === '/session/ses_one/message') return json(history());
      if (url.pathname === '/session/ses_one/prompt_async' && request.method === 'POST') {
        prompt = body?.parts?.[0]?.text; busy = true;
        event({ type: 'perch.invalidate' }); response.writeHead(204); response.end(); return;
      }
      if (url.pathname === '/session/ses_one/abort' && request.method === 'POST') {
        busy = false; event({ type: 'perch.invalidate' }); return json(true);
      }
      return json({}, 404);
    })().catch(() => { if (!response.destroyed) { response.writeHead(500); response.end('{}'); } });
  });
  return { url: await listen(server), username, password, requests, streams, event,
    async splitUnicodeEvent(value: unknown) {
      const bytes = Buffer.from(`data: ${JSON.stringify(value)}\n\n`);
      const split = bytes.indexOf(Buffer.from('🙂')) + 2;
      if (split < 2) throw new Error('This fixture event needs an emoji to split.');
      for (const response of streams) response.write(bytes.subarray(0, split));
      await wait(20);
      for (const response of streams) response.write(bytes.subarray(split));
    },
    finish(text: string) { finalText = text; busy = false; event({ type: 'perch.invalidate' }); },
    close: () => closeHttp(server),
  };
}

test('one workspace carries OpenCode Basic auth, live SSE and host model identity; switching closes the old stream without replay', async () => {
  const durable = await durableFixture(); const openCode = await openCodeFixture();
  const gateway = createWorkspaceGateway(configFor([
    { id: 'opencode', name: 'OpenCode', kind: 'opencode', upstream: { url: openCode.url, username: openCode.username, password: openCode.password } },
    { id: 'durable', name: 'Durable', kind: 'durable', upstream: { url: durable.url, token: durable.token } },
  ], 'opencode'));
  const store = new SessionStore(); let discoveries = 0;
  const discover: typeof discoverWorkspace = (...args) => { discoveries++; return discoverWorkspace(...args); };
  const manager = new WorkspaceManager({ sessions: store, persistence: memoryWorkspacePersistence(), discover });
  try {
    await manager.join(credentialsFor(gateway), 'self-hosted');
    await until(() => live(store, 'opencode'), 'OpenCode health and SSE ready through paired gateway');
    expect(displayedText(store, 'Saved OpenCode history')).toBe(true);
    expect(store.getSnapshot().availableModels?.map(model => `${model.provider}/${model.id}`)).toEqual(['provider_a/same', 'provider_b/same']);
    store.setModel('provider_b', 'same');
    store.sendPrompt('One OpenCode prompt');
    await until(() => store.getSnapshot().isWorking && store.getSnapshot().messages.some(message => message.id === 'oc_stream'), 'OpenCode accepted prompt');
    const submissions = () => openCode.requests.filter(request => request.path.endsWith('/prompt_async'));
    expect(submissions()).toHaveLength(1);
    expect(submissions()[0].body).toEqual({ parts: [{ type: 'text', text: 'One OpenCode prompt' }], model: { providerID: 'provider_b', modelID: 'same' } });

    const textEvent = (id: string, operation: string, text: string, complete = false) => ({ type: 'perch.text', id, sessionID: 'ses_one', messageID: 'oc_stream', partID: 'oc_stream_part', operation, text, complete });
    openCode.event(textEvent('start', 'replace', ''));
    await openCode.splitUnicodeEvent(textEvent('unicode', 'append', 'Live Æ🙂 output'));
    await until(() => displayedText(store, 'Live Æ🙂 output'), 'SSE crosses gateway before host commits final text');
    expect(store.getSnapshot().messages.find(message => message.id === 'oc_stream')?.streaming).toBe(true);
    openCode.event(textEvent('complete', 'replace', '# Final artifact\n\nA completed document.', true));
    openCode.finish('# Final artifact\n\nA completed document.');
    await until(() => !store.getSnapshot().isWorking && store.getSnapshot().messages.find(message => message.id === 'oc_stream')?.streaming === false, 'completed host text replaces stream');
    expect(displayedText(store, '# Final artifact\n\nA completed document.')).toBe(true);

    await manager.chooseConnection('durable');
    await until(() => live(store, 'durable') && openCode.streams.size === 0, 'switch cancels upstream OpenCode stream');
    expect(displayedText(store, 'Saved history for session_one')).toBe(true);
    await manager.chooseConnection('opencode');
    await until(() => live(store, 'opencode') && openCode.streams.size === 1, 'OpenCode reconnect creates one stream');
    expect(displayedText(store, 'One OpenCode prompt')).toBe(true);
    expect(displayedText(store, '# Final artifact\n\nA completed document.')).toBe(true);
    expect(submissions()).toHaveLength(1);
    expect(discoveries).toBe(1);
    expect(openCode.requests.every(request => request.authorized)).toBe(true);
    expect(openCode.requests.filter(request => request.path !== '/perch/health').every(request => request.directory === '/synthetic/workspace')).toBe(true);
    const display = JSON.stringify([manager.getSnapshot(), store.getSnapshot()]);
    for (const secret of [workspaceToken, durable.token, openCode.password]) expect(display).not.toContain(secret);

    await gateway.close();
    await until(() => store.getSnapshot().connection.status === 'offline' && openCode.streams.size === 0, 'gateway shutdown ends the phone and upstream streams');
    expect(submissions()).toHaveLength(1);
  } finally {
    store.dispose(); await gateway.close(); await openCode.close(); await durable.close();
  }
}, 20_000);

test('a paired OpenCode client can interrupt with its normal bodyless POST', async () => {
  const openCode = await openCodeFixture();
  const gateway = createWorkspaceGateway(configFor([
    { id: 'opencode', name: 'OpenCode', kind: 'opencode', upstream: { url: openCode.url, username: openCode.username, password: openCode.password } },
  ], 'opencode'));
  const store = new SessionStore();
  const manager = new WorkspaceManager({ sessions: store, persistence: memoryWorkspacePersistence(), discover: discoverWorkspace });
  try {
    await manager.join(credentialsFor(gateway));
    await until(() => live(store, 'opencode'), 'paired OpenCode client ready');
    store.sendPrompt('Start work for an explicit interruption');
    await until(() => store.getSnapshot().isWorking, 'host started work');
    store.interrupt();
    await until(() => !store.getSnapshot().isWorking || !!store.getSnapshot().connection.error, 'interrupt acknowledged or rejected');
    expect(store.getSnapshot().connection.error).toBeUndefined();
    expect(store.getSnapshot().isWorking).toBe(false);
    const aborts = openCode.requests.filter(request => request.path.endsWith('/abort'));
    expect(aborts).toHaveLength(1);
    expect(aborts[0].body).toBeUndefined();
    expect(aborts[0].authorized).toBe(true);
  } finally { store.dispose(); await gateway.close(); await openCode.close(); }
}, 15_000);

test('a rejected pairing code contacts no private adapter and stores no workspace; a current code can then connect', async () => {
  const durable = await durableFixture();
  const gateway = createWorkspaceGateway(configFor([
    { id: 'durable', name: 'Durable', kind: 'durable', upstream: { url: durable.url, token: durable.token } },
  ], 'durable'));
  const store = new SessionStore(); const persistence = memoryWorkspacePersistence();
  const manager = new WorkspaceManager({ sessions: store, persistence, discover: discoverWorkspace });
  try {
    const credentials = credentialsFor(gateway);
    await expect(manager.join({ ...credentials, token: 'revoked-public-test-workspace-token-32-characters' })).rejects.toThrow('This host rejected the workspace token.');
    expect(durable.requests).toHaveLength(0);
    expect(await persistence.load()).toHaveLength(0);
    expect(store.getSnapshot().mode).toBe('demo');
    await manager.join(credentials);
    await until(() => live(store, 'durable'), 'current pairing code connects after rejection');
    expect(displayedText(store, 'Saved history for session_one')).toBe(true);
    expect(await persistence.load()).toHaveLength(1);
    expect(durable.requests.every((request: { authorized: boolean }) => request.authorized)).toBe(true);
  } finally { store.dispose(); await gateway.close(); await durable.close(); }
}, 15_000);
