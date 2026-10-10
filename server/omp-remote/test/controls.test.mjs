import { afterEach, expect, test } from 'bun:test';
import { parseRemoteSnapshot } from '../../../src/harness/remote.ts';
import { MAX_SNAPSHOT_BYTES } from '../projection.mjs';
import { fixture, MODEL, post, until } from './helpers.mjs';

const handles = [];
const keep = async () => { const handle = await fixture(); handles.push(handle); return handle; };
afterEach(async () => { for (const handle of handles.splice(0)) await handle.close(); });
const path = '/perch/sessions/omp_test';
const reasoningModel = { ...MODEL, reasoning: true, thinking: { efforts: ['low', 'medium', 'high'], requiresEffort: false } };

function controls(handle) {
  const applied = { level: 'low', changes: [], names: [] };
  handle.state.model = reasoningModel;
  handle.api.getThinkingLevel = () => applied.level;
  handle.api.setThinkingLevel = level => { applied.changes.push(level); applied.level = level === 'high' ? 'medium' : level; };
  handle.api.setSessionName = async name => { applied.names.push(name); handle.state.title = name; };
  return applied;
}

test('thinking choices come from the current model, respect host clamping, and never replay', async () => {
  const handle = await keep(), applied = controls(handle);
  const snapshot = parseRemoteSnapshot(handle.bridge.snapshot());
  expect(snapshot.insights.thinking).toEqual({ level: 'low', availableLevels: ['off', 'low', 'medium', 'high'] });
  expect(snapshot.capabilities.thinkingSelection).toBe(true);
  const command = handle.command('think_once', 'set-thinking', { level: 'high', provider: MODEL.provider, modelId: MODEL.id });
  expect((await handle.bridge.dispatch(command)).status).toBe('forwarded');
  expect(parseRemoteSnapshot(handle.bridge.snapshot()).insights.thinking.level).toBe('medium');
  expect((await handle.bridge.dispatch(command)).status).toBe('forwarded');
  expect(applied.changes).toEqual(['high']);
  expect((await handle.bridge.dispatch({ ...command, level: 'low' })).status).toBe('rejected');
  expect((await handle.bridge.dispatch({ ...command, id: 'unadvertised', level: 'maximum' })).status).toBe('rejected');
  handle.state.model = { ...reasoningModel, id: 'another-model' };
  expect((await handle.bridge.dispatch({ ...command, id: 'old_model' })).status).toBe('rejected');
  expect(applied.changes).toEqual(['high']);
  handle.state.model = { ...reasoningModel, thinking: { efforts: ['high'], requiresEffort: true } };
  expect(handle.bridge.snapshot().insights.thinking.availableLevels).toEqual(['high']);
});

test('async rename remains pending until host persistence returns and fences other mutations', async () => {
  const handle = await keep(), applied = controls(handle);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  handle.api.setSessionName = async title => { applied.names.push(title); await gate; handle.state.title = title; };
  const command = handle.command('title_once', 'rename-session', { title: 'Plan for the mobile client' });
  const request = handle.request(`${path}/commands`, post(command));
  await until(() => applied.names.length === 1);
  expect(handle.bridge.operation(command.id).status).toBe('pending');
  const pending = handle.bridge.snapshot();
  expect(pending.session.title).toBe('Host conversation');
  expect(pending.capabilities.sessionRename).toBe(false);
  expect(pending.capabilities.thinkingSelection).toBe(false);
  expect(handle.bridge.beforeTransition(handle.context)).toEqual({ cancel: true });
  expect((await handle.bridge.dispatch(handle.command('blocked_prompt'))).status).toBe('rejected');
  release();
  expect((await (await request).json()).status).toBe('forwarded');
  expect(handle.bridge.snapshot().session.title).toBe(command.title);
  expect((await handle.bridge.dispatch(command)).status).toBe('forwarded');
  expect(applied.names).toHaveLength(1);
  expect(handle.bridge.beforeTransition(handle.context)).toBeUndefined();
});

test('session settings are withheld during work, queued prompts, decisions, and unsupported APIs', async () => {
  const handle = await keep(), applied = controls(handle);
  const rename = id => handle.command(id, 'rename-session', { title: 'Must not change yet' });
  handle.state.idle = false;
  expect(handle.bridge.snapshot().capabilities.sessionRename).toBe(false);
  expect((await handle.bridge.dispatch(rename('working'))).status).toBe('rejected');
  handle.state.idle = true; handle.state.pending = true;
  expect((await handle.bridge.dispatch(rename('queued'))).status).toBe('rejected');
  handle.state.pending = false;
  await handle.bridge.observe({ type: 'tool_approval_requested', toolCallId: 'approval' }, handle.context);
  expect((await handle.bridge.dispatch(rename('decision'))).status).toBe('rejected');
  await handle.bridge.observe({ type: 'tool_approval_resolved', toolCallId: 'approval' }, handle.context);
  expect(applied.names).toEqual([]);
  delete handle.api.setSessionName; delete handle.api.setThinkingLevel;
  const snapshot = handle.bridge.snapshot();
  expect(snapshot.capabilities.sessionRename).toBe(false);
  expect(snapshot.capabilities.thinkingSelection).toBe(false);
  expect((await handle.bridge.dispatch(rename('unsupported'))).status).toBe('rejected');
  expect((await handle.bridge.dispatch(handle.command('focus_not_omp', 'focus-session', {}))).status).toBe('rejected');
});

test('only safe context, branch usage, and public tool descriptions leave the host', async () => {
  const handle = await keep(); controls(handle);
  handle.context.getContextUsage = () => ({ tokens: 500, contextWindow: 10_000, percent: 5, providerSecret: 'do-not-leak' });
  handle.api.getAllTools = () => [{ name: 'write', description: 'Write a file.', parameters: { secret: 'do-not-leak' }, source: { path: '/private/extension' } }, { name: 'bash', description: 'Run a command.' }];
  handle.api.getActiveTools = () => ['write'];
  handle.state.entries = [
    { type: 'message', message: { role: 'assistant', timestamp: 1, content: [], usage: { input: 100, output: 10, cacheRead: 40, cacheWrite: 20, cost: { total: .02 } } } },
    { type: 'message', message: { role: 'assistant', timestamp: 2, content: [], usage: { input: 200, output: 15, cacheRead: 0, cacheWrite: 5, cost: { total: .03 } } } },
    { type: 'message', message: { role: 'toolResult', toolCallId: 'none', content: [], usage: { input: 999, output: 999 } } },
  ];
  const snapshot = parseRemoteSnapshot(handle.bridge.snapshot());
  expect(snapshot.insights.context).toEqual({ tokens: 500, contextWindow: 10_000, percent: 5 });
  expect(snapshot.insights.usage).toEqual({ input: 300, output: 25, cacheRead: 40, cacheWrite: 25, cost: .05, scope: 'current-branch' });
  expect(snapshot.insights.tools).toEqual([{ name: 'write', description: 'Write a file.', active: true }, { name: 'bash', description: 'Run a command.', active: false }]);
  expect(JSON.stringify(snapshot)).not.toContain('do-not-leak'); expect(JSON.stringify(snapshot)).not.toContain('/private/extension');
  // Removing a branch entry removes its reported usage; no second accounting database.
  handle.state.entries.shift(); delete handle.state.entries[0].message.usage.cost;
  const changed = handle.bridge.snapshot();
  expect(changed.insights.usage.input).toBe(200); expect(changed.insights.usage.cost).toBeUndefined();
  handle.context.getContextUsage = () => undefined; handle.state.entries = [];
  expect(handle.bridge.snapshot().insights.context).toBeUndefined();
  expect(handle.bridge.snapshot().insights.usage).toBeUndefined();
});

test('tool details share the bounded snapshot budget with conversation output', async () => {
  const handle = await keep(); controls(handle);
  handle.api.getAllTools = () => Array.from({ length: 256 }, (_, i) => ({ name: `tool-${i}`, description: 'A'.repeat(512) }));
  handle.api.getActiveTools = () => [];
  handle.state.entries = Array.from({ length: 300 }, (_, i) => ({ type: 'message', message: { role: 'assistant', timestamp: i, content: [{ type: 'text', text: 'Long text '.repeat(10_000) }] } }));
  const snapshot = handle.bridge.snapshot();
  expect(snapshot.truncated).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThanOrEqual(MAX_SNAPSHOT_BYTES);
  expect(parseRemoteSnapshot(snapshot).insights.tools).toHaveLength(256);
});
