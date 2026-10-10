import { expect, test } from 'bun:test';
import { SessionStore } from '../../src/session/store';
import { createRemoteDriver, validateRemoteConnection } from '../../src/session/remote';
import type { HarnessUpdate } from '../../src/session/types';
import { MAX_REMOTE_BYTES } from '../../src/harness/remote';
import { remoteFixture } from './fixture';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean, label: string, timeout = 6_000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > deadline) throw new Error(`Timed out: ${label}`); await wait(10); }
}
const ready = (store: SessionStore) => store.getSnapshot().connection.status === 'live' && !store.getSnapshot().sessionAction;
const posts = (fixture: Awaited<ReturnType<typeof remoteFixture>>) => fixture.requests.filter(request => request.method === 'POST');

test('the public store browses first, attaches atomically, sends to the existing identity and detaches without stopping', async () => {
  const host = await remoteFixture(); const store = new SessionStore(); const observed: string[] = [];
  const unsubscribe = store.subscribe(() => { const s = store.getSnapshot(); if (s.mode === 'remote') observed.push(`${s.activeSessionId}:${s.messages[0]?.id ?? ''}`); });
  try {
    await store.connectRemote(host); await until(() => ready(store), 'host catalog');
    expect(store.getSnapshot().activeSessionId).toBe(''); expect(store.getSnapshot().remote?.attached).toBeUndefined();
    expect(store.getSnapshot().sessions).toHaveLength(2); expect(store.getSnapshot().messages).toEqual([]);
    expect(host.requests.map(request => request.path)).toEqual(['/perch/health', '/perch/sessions']);
    store.sendPrompt('Must not choose the first session'); await wait(20); expect(posts(host)).toHaveLength(0);
    store.selectSession('session_two'); await until(() => store.getSnapshot().activeSessionId === 'session_two' && ready(store), 'explicit second-session attachment');
    expect(store.getSnapshot().remote?.attached?.pid).toBe(654);
    expect(store.getSnapshot().messages[0].text).toContain('session_two');
    expect(observed.every(value => value === 'connecting:' || value === ':' || value === 'session_two:session_two-history')).toBe(true);
    store.sendPrompt('One authorized remote turn'); store.sendPrompt('Double tap');
    await until(() => store.getSnapshot().isWorking, 'host work begins');
    expect(posts(host)).toHaveLength(1);
    expect(posts(host)[0].body).toMatchObject({ type: 'prompt', epoch: 'epoch-one', generation: 'generation-one', conversationId: 'conversation-session_two', text: 'One authorized remote turn' });
    expect(host.snapshots.get('session_one')!.messages).toHaveLength(1);
    store.detachSession(); expect(store.getSnapshot().activeSessionId).toBe(''); expect(store.getSnapshot().messages).toEqual([]);
    expect(host.snapshots.get('session_two')!.session.status).toBe('working'); expect(posts(host)).toHaveLength(1);
    store.reconnect(); await until(() => ready(store), 'detached reconnect'); expect(store.getSnapshot().activeSessionId).toBe('');
    store.selectSession('session_two'); await until(() => store.getSnapshot().isWorking && ready(store), 'same process reattachment');
    store.interrupt(); await until(() => !store.getSnapshot().isWorking && ready(store), 'explicit interruption');
    expect(posts(host)).toHaveLength(2); expect(posts(host)[1].body).toMatchObject({ type: 'interrupt', generation: 'generation-one' });
    expect(store.getSnapshot().remote?.attached?.pid).toBe(654);
    expect(host.requests.every(request => request.authorized)).toBe(true);
    expect(JSON.stringify(store.getSnapshot())).not.toContain(host.token); expect(JSON.stringify(store.getSnapshot())).not.toContain('do-not-project');
  } finally { unsubscribe(); store.dispose(); await host.close(); }
});

test('a lost prompt receipt is queried without resubmission, including across reconnect and phone recreation', async () => {
  const host = await remoteFixture(); const store = new SessionStore(); const restored = new SessionStore();
  try {
    await store.connectRemote(host); await until(() => ready(store), 'catalog'); store.selectSession('session_one'); await until(() => !!store.getSnapshot().remote?.attached && ready(store), 'attachment');
    host.setCommandMode('accepted-drop'); store.sendPrompt('Accept once, lose the response');
    await until(() => store.getSnapshot().isWorking && ready(store), 'receipt reconciliation');
    expect(posts(host)).toHaveLength(1); expect(host.operations.size).toBe(1);
    expect(host.requests.some(request => request.path.includes('/operations/'))).toBe(true);
    store.reconnect(); await until(() => ready(store), 'same-session reconnect');
    expect(store.getSnapshot().messages.filter(message => message.text === 'Accept once, lose the response')).toHaveLength(1);
    expect(posts(host)).toHaveLength(1); expect(store.getSnapshot().remote?.attached?.runtimeId).toBe('runtime-session_one');
    store.dispose();
    await restored.connectRemote(host); await until(() => ready(restored), 'fresh phone process catalog');
    expect(restored.getSnapshot().activeSessionId).toBe(''); expect(restored.getSnapshot().messages).toEqual([]);
    restored.selectSession('session_one'); await until(() => restored.getSnapshot().isWorking, 'fresh phone explicitly attaches');
    expect(restored.getSnapshot().messages.filter(message => message.text === 'Accept once, lose the response')).toHaveLength(1);
    expect(posts(host)).toHaveLength(1);
  } finally { store.dispose(); restored.dispose(); await host.close(); }
});

test('an unknown receipt remains explicit and an in-flight detach cannot restore old chat state', async () => {
  const host = await remoteFixture(); const store = new SessionStore();
  try {
    await store.connectRemote(host); await until(() => ready(store), 'catalog'); store.selectSession('session_one'); await until(() => !!store.getSnapshot().remote?.attached && ready(store), 'attachment');
    host.setCommandMode('unrecorded-drop'); store.sendPrompt('An uncertain prompt');
    await until(() => !!store.getSnapshot().connection.error && ready(store), 'explicit uncertain delivery');
    expect(store.getSnapshot().connection.error).toContain('unconfirmed'); expect(posts(host)).toHaveLength(1);
    store.reconnect(); await until(() => ready(store), 'unknown receipt reconnect'); expect(posts(host)).toHaveLength(1);
    store.sendPrompt('An uncertain prompt'); await wait(20); expect(posts(host)).toHaveLength(1);
    expect(store.getSnapshot().messages).toHaveLength(1);
    const gate = host.hold('/perch/sessions/session_two'); store.selectSession('session_two'); await until(() => gate.started, 'delayed attachment');
    expect(store.getSnapshot().activeSessionId).toBe('session_one'); expect(store.getSnapshot().sessionAction).toBe('switching');
    store.detachSession(); expect(store.getSnapshot().remote?.attached).toBeUndefined(); gate.release(); await wait(80);
    expect(store.getSnapshot().activeSessionId).toBe(''); expect(store.getSnapshot().messages).toEqual([]); expect(posts(host)).toHaveLength(1);
  } finally { store.dispose(); await host.close(); }
});

test('reconnect refreshes host epoch and never attaches to a replaced generation or desktop conversation', async () => {
  const host = await remoteFixture(); const store = new SessionStore();
  async function attach() { store.selectSession('session_one'); await until(() => !!store.getSnapshot().remote?.attached && ready(store), 'current explicit attachment'); }
  async function reconnect() { store.reconnect(); await until(() => ready(store), 'refreshed host identity'); }
  try {
    await store.connectRemote(host); await until(() => ready(store), 'catalog'); await attach();
    host.health.epoch = 'epoch-two'; host.update(); await reconnect();
    expect(store.getSnapshot().remote?.epoch).toBe('epoch-two'); expect(store.getSnapshot().activeSessionId).toBe('');
    expect(store.getSnapshot().connection.error).toContain('restarted'); await attach();
    host.snapshots.get('session_one')!.session.generation = 'generation-two'; host.update(); await reconnect();
    expect(store.getSnapshot().activeSessionId).toBe(''); await attach();
    host.snapshots.get('session_one')!.session.conversationId = 'desktop-opened-another-chat'; host.update(); await reconnect();
    expect(store.getSnapshot().activeSessionId).toBe(''); await attach();
    host.snapshots.get('session_one')!.session.status = 'exited'; host.update(); await reconnect();
    expect(store.getSnapshot().activeSessionId).toBe(''); store.selectSession('session_one'); await wait(20); expect(store.getSnapshot().activeSessionId).toBe('');
    expect(posts(host)).toHaveLength(0);
    expect(host.requests.filter(request => request.path === '/perch/health')).toHaveLength(5);
  } finally { store.dispose(); await host.close(); }
});

test('read-only and unsupported controls are blocked; model choice uses the host catalog', async () => {
  const host = await remoteFixture(); const store = new SessionStore();
  async function refresh() { store.reconnect(); await until(() => ready(store), 'capability refresh'); }
  try {
    const selected = host.snapshots.get('session_one')!; selected.readOnly = true; selected.session.status = 'working';
    await store.connectRemote(host); await until(() => ready(store), 'catalog'); store.selectSession('session_one'); await until(() => !!store.getSnapshot().remote?.attached && ready(store), 'read-only attachment');
    store.sendPrompt('No write access'); store.interrupt(); store.setModel('other', 'model-two'); await wait(20); expect(posts(host)).toHaveLength(0);
    selected.readOnly = false; selected.session.status = 'idle'; selected.capabilities.prompt = false; selected.capabilities.interrupt = false; selected.capabilities.modelSelection = false; host.update(); await refresh();
    store.sendPrompt('Unsupported'); store.interrupt(); store.setModel('other', 'model-two'); await wait(20); expect(posts(host)).toHaveLength(0);
    selected.capabilities.modelSelection = true; host.update(); await refresh(); store.setModel('made-up', 'unadvertised'); await wait(20); expect(posts(host)).toHaveLength(0);
    store.setModel('other', 'model-two'); await until(() => store.getSnapshot().model?.provider === 'other', 'host model change');
    expect(posts(host)).toHaveLength(1); expect(posts(host)[0].body).toMatchObject({ type: 'set-model', provider: 'other', modelId: 'model-two' });
  } finally { store.dispose(); await host.close(); }
});

test('detaching during reconnect finishes in the catalog and pending receipts settle through reads alone', async () => {
  const host = await remoteFixture(); const store = new SessionStore();
  try {
    await store.connectRemote(host); await until(() => ready(store), 'catalog'); store.selectSession('session_one'); await until(() => !!store.getSnapshot().remote?.attached && ready(store), 'attachment');
    const gate = host.hold('/perch/sessions/session_one'); store.reconnect(); await until(() => gate.started, 'reconnect reading selected transcript');
    store.detachSession(); gate.release(); await until(() => ready(store), 'catalog-only reconnect after detach');
    expect(store.getSnapshot().activeSessionId).toBe(''); expect(store.getSnapshot().connection.label).toContain('choose a session');
    store.selectSession('session_one'); await until(() => !!store.getSnapshot().remote?.attached && ready(store), 'reattachment');
    host.setCommandMode('pending'); store.sendPrompt('Forwarding is still pending');
    await until(() => store.getSnapshot().isWorking && ready(store), 'pending command snapshot');
    expect(store.getSnapshot().capabilities.prompt).toBe(false); expect(posts(host)).toHaveLength(1);
    const operation = [...host.operations.values()][0]; operation.status = 'forwarded';
    await until(() => store.getSnapshot().capabilities.prompt, 'pending receipt resolves by poll');
    expect(host.requests.some(request => request.path.endsWith(`/operations/${operation.id}`))).toBe(true); expect(posts(host)).toHaveLength(1);
  } finally { store.dispose(); await host.close(); }
});

test('authenticated reads reject redirects, oversized bodies, duplicate identities and changed hosts', async () => {
  const host = await remoteFixture(); const other = await remoteFixture(); const store = new SessionStore();
  try {
    expect(() => validateRemoteConnection({ url: 'http://192.168.1.8', token: host.token })).toThrow('HTTPS');
    for (const url of ['https://user:password@host.example', 'https://host.example?token=x', 'https://host.example/a/../private', 'https://host.example/%2e%2e/private']) expect(() => validateRemoteConnection({ url, token: host.token })).toThrow();
    let state: HarnessUpdate | undefined; const passive = createRemoteDriver(host, update => { state = update; });
    expect(host.requests).toHaveLength(0); expect(state).toBeUndefined(); passive.close();
    await store.connectRemote({ ...host, token: 'incorrect-fixture-token-with-enough-characters' }); await until(() => store.getSnapshot().connection.status === 'error', 'wrong token');
    expect(JSON.stringify(store.getSnapshot())).not.toContain(host.token);
    host.overrides.set('/perch/health', { status: 302, headers: { Location: other.url + '/perch/health' } });
    await store.connectRemote(host); await until(() => store.getSnapshot().connection.status === 'error', 'redirect rejection'); expect(other.requests).toHaveLength(0);
    host.overrides.set('/perch/health', { body: ' '.repeat(MAX_REMOTE_BYTES + 1) });
    await store.connectRemote(host); await until(() => store.getSnapshot().connection.status === 'error', 'oversize rejection'); expect(store.getSnapshot().connection.error).toContain('size limit');
    host.overrides.clear(); await store.connectRemote(host); await until(() => ready(store), 'valid catalog'); store.selectSession('session_one'); await until(() => !!store.getSnapshot().remote?.attached && ready(store), 'valid snapshot');
    const snapshot = host.snapshots.get('session_one')!; snapshot.messages.push({ ...snapshot.messages[0], text: 'Duplicate identity' }); host.update();
    store.reconnect(); await until(() => store.getSnapshot().connection.status === 'offline', 'invalid snapshot rejected'); expect(store.getSnapshot().messages).toHaveLength(1);
    snapshot.messages.pop(); host.health.host.id = 'different-physical-host';
    store.reconnect(); await until(() => store.getSnapshot().connection.status === 'offline', 'host identity mismatch');
    expect(store.getSnapshot().connection.error).toContain('different host'); expect(store.getSnapshot().remote?.host?.id).toBe('fixture-host');
    expect(posts(host)).toHaveLength(0);
  } finally { store.dispose(); await host.close(); await other.close(); }
});
