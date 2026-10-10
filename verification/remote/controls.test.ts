import { expect, test } from 'bun:test';
import { SessionStore } from '../../src/session/store';
import { parseSessionInsights } from '../../src/harness/insights';
import { parseRemoteCommand } from '../../src/harness/remote';
import { remoteFixture } from './fixture';

const wait = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Session controls did not settle.'); await wait(10); }
}

test('the phone uses advertised host settings and reconciles a lost receipt without resubmission', async () => {
  const host = await remoteFixture(), store = new SessionStore();
  const selected = host.snapshots.get('session_one')!;
  selected.capabilities = { ...selected.capabilities, thinkingSelection: true, sessionRename: true, focusSession: true };
  selected.insights = { thinking: { level: 'low', availableLevels: ['low', 'medium', 'high'] }, context: { tokens: 100, contextWindow: 1_000, percent: 10 } };
  const posts = () => host.requests.filter(row => row.method === 'POST');
  const ready = () => store.getSnapshot().connection.status === 'live' && !store.getSnapshot().sessionAction;
  const refresh = async () => { host.update(); store.reconnect(); await until(ready); };
  try {
    await store.connectRemote(host); await until(ready);
    store.selectSession('session_one'); await until(() => !!store.getSnapshot().remote?.attached && ready());
    expect(store.getSnapshot().insights?.context?.percent).toBe(10);
    store.setThinking('invented'); await wait(); expect(posts()).toHaveLength(0);
    host.setCommandMode('accepted-drop');
    store.setThinking('high'); store.setThinking('low');
    await until(() => store.getSnapshot().insights?.thinking?.level === 'high' && ready());
    expect(posts()).toHaveLength(1);
    expect(posts()[0].body).toMatchObject({ type: 'set-thinking', provider: 'local', modelId: 'model-one', level: 'high', epoch: 'epoch-one', generation: 'generation-one', conversationId: 'conversation-session_one' });
    await refresh(); expect(posts()).toHaveLength(1);
    host.setCommandMode('normal');
    store.renameSession('My host chat');
    await until(() => store.getSnapshot().sessions.find(s => s.id === 'session_one')?.title === 'My host chat' && ready());
    expect(posts()).toHaveLength(2);
    store.focusSession(); await until(() => posts().length === 3 && !!store.getSnapshot().capabilities.focusSession);
    expect(posts()[2].body).toMatchObject({ type: 'focus-session' });
    selected.readOnly = true; await refresh();
    store.renameSession('View only'); store.setThinking('low'); store.focusSession(); await wait(); expect(posts()).toHaveLength(3);
    selected.readOnly = false; selected.capabilities.thinkingSelection = false; selected.capabilities.sessionRename = false; selected.capabilities.focusSession = false; await refresh();
    store.renameSession('Unavailable'); store.setThinking('low'); store.focusSession(); await wait(); expect(posts()).toHaveLength(3);
    store.detachSession(); expect(store.getSnapshot().insights).toBeUndefined();
    store.renameSession('Detached'); store.setThinking('low'); store.focusSession(); await wait(); expect(posts()).toHaveLength(3);
  } finally { store.dispose(); await host.close(); }
});

test('display facts exclude private fields and malformed details never become selectable controls', () => {
  expect(parseSessionInsights({ thinking: { level: 'high', availableLevels: ['high'], secret: 'private' }, tools: [{ name: 'read', description: 'Read a file.', active: true, parameters: { secret: 'private' } }] })).toEqual({ thinking: { level: 'high', availableLevels: ['high'] }, tools: [{ name: 'read', description: 'Read a file.', active: true }] });
  for (const value of [null, { thinking: { availableLevels: ['high', 'high'] } }, { thinking: { level: 'raw\nkeys', availableLevels: [] } }, { context: { tokens: 1, contextWindow: 0, percent: 0 } }, { tools: [{ name: 'read', description: 'a', active: 'yes' }] }, { usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: -1, scope: 'current-branch' } }]) expect(() => parseSessionInsights(value)).toThrow();
  const identity = { id: 'command', epoch: 'current', generation: 'current' };
  for (const command of [{ type: 'focus-session', raw: 'keys' }, { type: 'set-thinking', level: 'high' }, { type: 'rename-session', title: 'bad\nname' }, { type: 'rename-session', title: 'a'.repeat(161) }]) expect(() => parseRemoteCommand({ ...identity, ...command })).toThrow();
});
