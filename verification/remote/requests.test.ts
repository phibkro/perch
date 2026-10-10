import { expect, test } from 'bun:test';
import { SessionStore } from '../../src/session/store';
import { remoteFixture } from './fixture';
import { parseRemoteCommand, parseRemoteQuestion, parseRemoteSnapshot, type RemoteQuestion } from '../../src/harness/remote';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 6_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await wait(10);
  }
}
const ready = (store: SessionStore) => store.getSnapshot().connection.status === 'live' && !store.getSnapshot().sessionAction;
const approval = (): RemoteQuestion => ({
  id: 'owner-request-one', revision: 'request-content-one', kind: 'choice', category: 'approval', actionable: true,
  title: 'Approve tool execution?', prompt: 'Run the host tool with these exact arguments: {"command":"bun test"}',
  options: [{ id: '0', label: 'Approve' }, { id: '1', label: 'Deny' }],
});
const posts = (host: Awaited<ReturnType<typeof remoteFixture>>) => host.requests.filter(request => request.method === 'POST');

test('a native answer targets the displayed owner request and stays pending until the host dismisses it', async () => {
  const host = await remoteFixture(); const store = new SessionStore();
  try {
    const selected = host.snapshots.get('session_one')!;
    selected.pendingQuestion = approval();
    selected.capabilities.questions = true; selected.session.status = 'needs-input';
    await store.connectRemote(host); await until(() => ready(store), 'catalog');
    store.selectSession('session_one'); await until(() => !!store.getSnapshot().pendingQuestion, 'owner approval appears');
    const question = store.getSnapshot().pendingQuestion!;
    expect(question.prompt).toContain('bun test'); expect(question.options?.map(option => option.label)).toEqual(['Approve', 'Deny']);
    expect(store.getSnapshot().capabilities.questions).toBe(true);
    store.answerQuestion('0', 'stale-question'); store.answerQuestion('invented-choice', question.id);
    await wait(20); expect(posts(host)).toHaveLength(0);
    store.answerQuestion('1', question.id); store.answerQuestion('0', question.id);
    await until(() => posts(host).length === 1 && store.getSnapshot().pendingQuestion?.answering === true, 'one answer is sent');
    expect(posts(host)[0].body).toMatchObject({ type: 'answer', requestId: 'owner-request-one', requestRevision: 'request-content-one', answer: '1',
      generation: 'generation-one', conversationId: 'conversation-session_one' });
    store.reconnect(); await until(() => ready(store), 'reconnected request');
    expect(store.getSnapshot().pendingQuestion?.answering).toBe(true); expect(posts(host)).toHaveLength(1);
    selected.pendingQuestion = null; selected.session.status = 'idle'; host.update();
    store.reconnect(); await until(() => ready(store), 'host dismissal');
    expect(store.getSnapshot().pendingQuestion).toBeNull(); expect(posts(host)).toHaveLength(1);
  } finally { store.dispose(); await host.close(); }
});

test('a revised plan retires old choices and preserves the complete plan document', async () => {
  const host = await remoteFixture(); const store = new SessionStore();
  try {
    const selected = host.snapshots.get('session_one')!;
    selected.pendingQuestion = { ...approval(), category: 'plan', title: 'Review implementation plan', prompt: 'Execution model: local/mock',
      document: { title: 'Implementation plan', format: 'markdown', content: '# Plan\n\n1. Inspect the code.\n2. Run `bun test`.\n\nPreserve æøå and 日本語.' },
      options: [{ id: 'execute', label: 'Implement plan' }, { id: 'refine', label: 'Refine plan' }, { id: 'unavailable', label: 'Unavailable model', disabled: true }] };
    selected.capabilities.questions = true; selected.session.status = 'needs-input';
    await store.connectRemote(host); await until(() => ready(store), 'catalog');
    store.selectSession('session_one'); await until(() => !!store.getSnapshot().pendingQuestion, 'plan review');
    const old = store.getSnapshot().pendingQuestion!;
    expect(old.category).toBe('plan'); expect(old.document).toEqual(selected.pendingQuestion.document);
    store.answerQuestion('unavailable', old.id); await wait(20); expect(posts(host)).toHaveLength(0);
    selected.pendingQuestion = { ...selected.pendingQuestion, revision: 'request-content-two', document: { ...selected.pendingQuestion.document!, content: '# Revised plan\n\nInspect only; do not run tests.' } }; host.update();
    store.reconnect(); await until(() => ready(store), 'revised plan');
    const next = store.getSnapshot().pendingQuestion!;
    expect(next.id).not.toBe(old.id); expect(next.document?.content).toContain('Inspect only');
    store.answerQuestion('execute', old.id); await wait(20); expect(posts(host)).toHaveLength(0);
    store.answerQuestion('refine', next.id);
    await until(() => posts(host).length === 1 && store.getSnapshot().pendingQuestion?.answerState === 'forwarded', 'current plan choice');
    expect(posts(host)[0].body).toMatchObject({ requestId: 'owner-request-one', requestRevision: 'request-content-two', answer: 'refine' });
  } finally { store.dispose(); await host.close(); }
});

test('unconfirmed answers remain locked across reconnect and reattachment without automatic replay', async () => {
  const host = await remoteFixture(); const store = new SessionStore();
  try {
    const selected = host.snapshots.get('session_one')!;
    selected.pendingQuestion = approval(); selected.capabilities.questions = true; selected.session.status = 'needs-input';
    await store.connectRemote(host); await until(() => ready(store), 'catalog');
    store.selectSession('session_one'); await until(() => !!store.getSnapshot().pendingQuestion, 'approval');
    host.setCommandMode('unrecorded-drop');
    store.answerQuestion('1', store.getSnapshot().pendingQuestion!.id);
    await until(() => store.getSnapshot().pendingQuestion?.answerState === 'unknown', 'uncertain answer');
    expect(store.getSnapshot().connection.error).toContain('Answer delivery is unconfirmed');
    store.reconnect(); await until(() => ready(store), 'reconnect');
    store.answerQuestion('0', store.getSnapshot().pendingQuestion!.id); await wait(20);
    expect(posts(host)).toHaveLength(1); expect(store.getSnapshot().pendingQuestion?.answering).toBe(true);
    store.detachSession(); store.selectSession('session_one'); await until(() => !!store.getSnapshot().pendingQuestion && ready(store), 'reattachment');
    store.answerQuestion('1', store.getSnapshot().pendingQuestion!.id); await wait(20); expect(posts(host)).toHaveLength(1);
    const oldQuestionId = store.getSnapshot().pendingQuestion!.id;
    selected.pendingQuestion = { ...approval(), revision: 'request-content-two', prompt: 'The same mounted request now shows an updated detail.' }; host.update();
    store.reconnect(); await until(() => ready(store), 'same request with revised content');
    expect(store.getSnapshot().pendingQuestion?.id).not.toBe(oldQuestionId);
    expect(store.getSnapshot().pendingQuestion?.answerState).toBe('unknown');
    expect(store.getSnapshot().pendingQuestion?.answering).toBe(true);
    store.answerQuestion('0', store.getSnapshot().pendingQuestion!.id); await wait(20); expect(posts(host)).toHaveLength(1);
    const receiptReads = host.requests.filter(request => request.path.includes('/operations/'));
    expect(receiptReads.length).toBeGreaterThan(0);
    selected.pendingQuestion = { ...approval(), id: 'replacement-request' }; host.update();
    host.setCommandMode('normal'); store.reconnect(); await until(() => ready(store), 'replacement request');
    expect(store.getSnapshot().pendingQuestion?.answering).toBeUndefined();
    store.answerQuestion('1', store.getSnapshot().pendingQuestion!.id);
    await until(() => posts(host).length === 2 && store.getSnapshot().pendingQuestion?.answerState === 'forwarded', 'explicit new request');
  } finally { store.dispose(); await host.close(); }
});

test('host permissions and incomplete requests cannot be overridden by native answers', async () => {
  const host = await remoteFixture(); const store = new SessionStore();
  try {
    const selected = host.snapshots.get('session_one')!;
    selected.pendingQuestion = approval(); selected.capabilities.questions = true; selected.readOnly = true; selected.session.status = 'needs-input';
    await store.connectRemote(host); await until(() => ready(store), 'catalog');
    store.selectSession('session_one'); await until(() => !!store.getSnapshot().pendingQuestion, 'view-only approval');
    store.answerQuestion('0', store.getSnapshot().pendingQuestion!.id); await wait(20); expect(posts(host)).toHaveLength(0);
    selected.readOnly = false; selected.capabilities.questions = false; host.update();
    store.reconnect(); await until(() => ready(store), 'unsupported request');
    store.answerQuestion('0', store.getSnapshot().pendingQuestion!.id); await wait(20); expect(posts(host)).toHaveLength(0);
    selected.capabilities.questions = true; selected.pendingQuestion = { ...approval(), actionable: false, notice: 'The plan exceeds the complete-view limit. Review it on the host.' }; host.update();
    store.reconnect(); await until(() => ready(store), 'incomplete plan');
    expect(store.getSnapshot().pendingQuestion?.disabledReason).toContain('complete-view limit');
    store.answerQuestion('0', store.getSnapshot().pendingQuestion!.id); await wait(20); expect(posts(host)).toHaveLength(0);
  } finally { store.dispose(); await host.close(); }
});

test('an answer rejected after a host-side request change refreshes the request without carrying its selection forward', async () => {
  const host = await remoteFixture(); const store = new SessionStore();
  try {
    const selected = host.snapshots.get('session_one')!;
    selected.pendingQuestion = approval(); selected.capabilities.questions = true; selected.session.status = 'needs-input';
    await store.connectRemote(host); await until(() => ready(store), 'catalog');
    store.selectSession('session_one'); await until(() => !!store.getSnapshot().pendingQuestion, 'approval');
    const displayed = store.getSnapshot().pendingQuestion!;
    selected.pendingQuestion = { ...approval(), id: 'new-owner-request' }; host.update();
    store.answerQuestion('0', displayed.id);
    await until(() => ready(store) && store.getSnapshot().pendingQuestion?.id !== displayed.id, 'host rejects stale answer and supplies current request');
    expect(host.operations.size).toBe(0); expect(posts(host)).toHaveLength(1);
    expect(store.getSnapshot().pendingQuestion?.answering).toBeUndefined();
    expect(store.getSnapshot().connection.error).toContain('host session changed');
  } finally { store.dispose(); await host.close(); }
});

test('request parsing preserves disabled choices, excludes raw events and remains compatible with older adapters', async () => {
  const host = await remoteFixture();
  try {
    const snapshot = parseRemoteSnapshot(host.snapshots.get('session_one'));
    expect(snapshot.capabilities.questions).toBe(false); expect(snapshot.pendingQuestion).toBeNull();
    expect(parseRemoteQuestion({ ...approval(), rawEvent: { ev: 'activate', id: 'should-stay-private' } })).not.toHaveProperty('rawEvent');
    for (const changes of [
      { options: [{ id: 'same', label: 'Approve' }, { id: 'same', label: 'Deny' }] },
      { options: [{ id: 'all-disabled', label: 'Approve', disabled: true }] },
      { document: { title: 'Plan', content: 'x'.repeat(200_001), format: 'markdown' } },
    ]) expect(() => parseRemoteQuestion({ ...approval(), ...changes })).toThrow();
    const command = { id: 'phone-answer', epoch: 'epoch-one', generation: 'generation-one', type: 'answer', requestId: 'owner-request', requestRevision: 'revision-one', answer: '0' };
    expect(parseRemoteCommand(command)).toEqual(command);
    expect(() => parseRemoteCommand({ ...command, event: { ev: 'activate' } })).toThrow();
    expect(() => parseRemoteCommand({ ...command, requestRevision: '' })).toThrow();
  } finally { await host.close(); }
});
