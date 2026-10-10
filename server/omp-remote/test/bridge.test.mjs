import { afterEach, expect, test } from 'bun:test';
import { parseRemoteCatalog, parseRemoteHealth, parseRemoteReceipt, parseRemoteSnapshot, MAX_REMOTE_COMMAND_BYTES } from '../../../src/harness/remote.ts';
import { MAX_ROWS, MAX_SNAPSHOT_BYTES, MAX_TEXT } from '../projection.mjs';
import { fixture, MODEL, MODEL_TWO, post, until } from './helpers.mjs';

const handles = [];
const keep = async options => { const handle = await fixture(options); handles.push(handle); return handle; };
afterEach(async () => { for (const handle of handles.splice(0)) await handle.close(); });
const sessionPath = '/perch/sessions/omp_test';
const entry = (id, message) => ({ type: 'message', id, timestamp: new Date().toISOString(), parentId: null, message });

test('authenticated loopback snapshots attach to existing host identity without exposing provider configuration', async () => {
  const handle = await keep();
  handle.state.entries.push(entry('source_one', { role: 'user', content: 'Already on the host', timestamp: 11 }),
    entry('source_two', { role: 'assistant', content: [{ type: 'text', text: 'Existing answer' }], timestamp: 12,
      providerPayload: { secret: 'opaque-provider-secret' }, credentialId: 987 }));
  expect((await handle.request('/perch/health', { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401);
  const health = parseRemoteHealth(await (await handle.request('/perch/health')).json());
  const catalog = parseRemoteCatalog(await (await handle.request('/perch/sessions')).json());
  const response = await handle.request(sessionPath), raw = await response.text(), snapshot = parseRemoteSnapshot(JSON.parse(raw));
  expect(health.adapter).toBe('omp'); expect(health.synchronization).toBe('snapshot');
  expect(catalog.sessions[0].conversationId).toBe('conversation_one'); expect(catalog.sessions[0].pid).toBe(process.pid);
  expect(snapshot.messages.map(row => row.text)).toEqual(['Already on the host', 'Existing answer']);
  expect(snapshot.availableModels).toEqual([{ id: MODEL.id, provider: MODEL.provider, name: MODEL.name }, MODEL_TWO]);
  for (const secret of ['opaque-provider-secret', 'never-project-this', 'private-provider.example', 'credentialId', 'apiKey']) expect(raw).not.toContain(secret);
  expect(response.headers.get('cache-control')).toBe('no-store'); expect(handle.state.prompts).toHaveLength(0);
});

test('prompt receipts bind the live conversation and deduplicate before effects; reconnect reads never resend', async () => {
  const handle = await keep(), command = handle.command('prompt_one');
  const first = parseRemoteReceipt(await (await handle.request(`${sessionPath}/commands`, post(command))).json());
  expect(first.status).toBe('forwarded'); expect(handle.state.prompts).toEqual(['Hello']);
  const repeated = await (await handle.request(`${sessionPath}/commands`, post(command))).json();
  expect(repeated).toEqual(first);
  expect((await handle.request(`${sessionPath}/commands`, post({ ...command, text: 'Different input' }))).status).toBe(409);
  await handle.request('/perch/health'); await handle.request('/perch/sessions'); await handle.request(sessionPath);
  expect(parseRemoteReceipt(await (await handle.request(`${sessionPath}/operations/prompt_one`)).json())).toEqual(first);
  expect(handle.state.prompts).toHaveLength(1);
  const interrupt = handle.command('stop_one', 'interrupt', {});
  expect((await handle.bridge.dispatch(interrupt)).status).toBe('forwarded');
  expect((await handle.bridge.dispatch(interrupt)).status).toBe('forwarded'); expect(handle.state.aborts).toBe(1);
  expect((await handle.request(sessionPath)).status).toBe(200);
});

test('pending async model effects survive a dropped phone response and remain queryable without replay', async () => {
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  const handle = await keep({ setModel: () => gate });
  const command = handle.command('model_one', 'set-model', { provider: MODEL_TWO.provider, modelId: MODEL_TWO.id });
  const controller = new AbortController();
  const sent = handle.request(`${sessionPath}/commands`, { ...post(command), signal: controller.signal });
  const dropped = sent.catch(failure => failure.name);
  await until(() => handle.state.models.length === 1);
  expect(handle.bridge.operation(command.id).status).toBe('pending');
  expect(handle.bridge.beforeTransition(handle.context)).toEqual({ cancel: true });
  controller.abort(); expect(await dropped).toBe('AbortError');
  finish();
  await until(() => handle.bridge.operation(command.id).status === 'forwarded');
  expect(parseRemoteSnapshot(await (await handle.request(sessionPath)).json()).session.model.id).toBe(MODEL_TWO.id);
  expect((await handle.bridge.dispatch(command)).status).toBe('forwarded'); expect(handle.state.models).toHaveLength(1);
  expect(handle.bridge.beforeTransition(handle.context)).toBeUndefined();
});

test('desktop conversation switches and branches keep the listener but fence old commands and streamed tails', async () => {
  const handle = await keep();
  const old = handle.command('old_prompt');
  await handle.bridge.observe({ type: 'message_start', message: { role: 'assistant', timestamp: 50, content: [{ type: 'text', text: 'Old stream' }] } }, handle.context);
  handle.state.sessionId = 'conversation_two'; handle.state.entries = [];
  await handle.bridge.observe({ type: 'session_switch' }, handle.context);
  expect((await handle.bridge.dispatch(old)).status).toBe('rejected');
  const current = parseRemoteSnapshot(await (await handle.request(sessionPath)).json());
  expect(current.messages).toHaveLength(0); expect(current.session.conversationId).toBe('conversation_two');
  expect(current.session.generation).not.toBe(old.generation); expect(current.epoch).toBe(old.epoch);
  const beforeBranch = handle.command('before_branch');
  await handle.bridge.observe({ type: 'session_branch' }, handle.context);
  expect((await handle.bridge.dispatch(beforeBranch)).status).toBe('rejected');
  expect(handle.bridge.catalog().sessions[0].conversationId).toBe('conversation_two');
  expect((await handle.request('/perch/health')).status).toBe(200);
  expect(handle.state.prompts).toHaveLength(0);
});

test('a single streaming identity becomes the persisted host answer; exact write inputs remain artifacts', async () => {
  const handle = await keep();
  const partial = { role: 'assistant', timestamp: 51, content: [{ type: 'text', text: 'Building…' }] };
  await handle.bridge.observe({ type: 'message_start', message: partial }, handle.context);
  const before = handle.bridge.snapshot();
  const finished = { ...partial, content: [{ type: 'text', text: '# Done' },
    { type: 'toolCall', id: 'write_call', name: 'write', arguments: { path: 'hello.html', content: '<h1>Exact bytes</h1>' } }] };
  await handle.bridge.observe({ type: 'message_end', message: finished }, handle.context);
  handle.state.entries.push(entry('persisted_answer', finished), entry('persisted_tool', { role: 'toolResult', toolCallId: 'write_call', toolName: 'write', isError: false,
    content: [{ type: 'text', text: 'Successfully wrote a file (this is not its content)' }], timestamp: 52 }));
  const after = parseRemoteSnapshot(handle.bridge.snapshot());
  expect(after.messages).toHaveLength(1); expect(after.messages[0].id).toBe(before.messages[0].id); expect(after.messages[0].text).toBe('# Done');
  expect(after.messages[0].streaming).toBeUndefined();
  expect(after.tools[0].artifact).toEqual({ filename: 'hello.html', content: '<h1>Exact bytes</h1>' });
  expect(after.tools[0].status).toBe('done');
});

test('subagents cannot replace the main projection; approval notifications never create an approval command', async () => {
  const handle = await keep();
  await handle.bridge.observe({ type: 'session_start' }, { ...handle.context, agent: { kind: 'sub', id: 'sub_one' }, sessionManager: { getSessionId: () => 'sub_conversation' } });
  expect(handle.bridge.catalog().sessions[0].conversationId).toBe('conversation_one');
  await handle.bridge.observe({ type: 'tool_approval_requested', toolCallId: 'decision' }, handle.context);
  const snapshot = handle.bridge.snapshot();
  expect(snapshot.session.status).toBe('needs-input'); expect(snapshot.notices[0]).toContain('host terminal');
  expect((await handle.bridge.dispatch(handle.command('blocked_prompt'))).status).toBe('rejected');
  expect((await handle.request(`${sessionPath}/commands`, post({ ...handle.command('approval'), type: 'approve' }))).status).toBe(400);
  await handle.bridge.observe({ type: 'tool_approval_resolved', toolCallId: 'decision' }, handle.context);
  expect(handle.bridge.snapshot().session.status).toBe('idle');
});

test('the direct OMP extension rejects owner answers without changing its model or blocking later prompts', async () => {
  const handle = await keep();
  const command = handle.command('unsupported_answer', 'answer', { requestId: 'owner-choice', requestRevision: 'one', answer: '0' });
  const response = await handle.request(`${sessionPath}/commands`, post(command));
  expect(response.status).toBe(409);
  expect(parseRemoteReceipt(await response.json()).message).toContain('Tern remote connection');
  expect(handle.state.models).toHaveLength(0);
  expect(parseRemoteSnapshot(handle.bridge.snapshot()).capabilities.questions).toBe(false);
  expect((await handle.bridge.dispatch(handle.command('valid_after_rejection'))).status).toBe('forwarded');
  expect(handle.state.prompts).toEqual(['Hello']);
});

test('separate assistant messages with the same timestamp do not reuse a streaming identity', async () => {
  const handle = await keep();
  const first = { role: 'assistant', timestamp: 99, content: [{ type: 'text', text: 'First answer' }] };
  await handle.bridge.observe({ type: 'message_start', message: first }, handle.context);
  await handle.bridge.observe({ type: 'message_end', message: first }, handle.context);
  handle.state.entries.push(entry('first_source', first));
  const second = { ...first, content: [{ type: 'text', text: 'Second answer streaming' }] };
  await handle.bridge.observe({ type: 'message_start', message: second }, handle.context);
  const live = parseRemoteSnapshot(handle.bridge.snapshot());
  expect(live.messages.map(message => message.text)).toEqual(['First answer', 'Second answer streaming']);
  expect(new Set(live.messages.map(message => message.id)).size).toBe(2);
  expect(live.messages[1].streaming).toBe(true);
  await handle.bridge.observe({ type: 'message_end', message: second }, handle.context);
  handle.state.entries.push(entry('second_source', second));
  expect(handle.bridge.snapshot().messages[1].id).toBe(live.messages[1].id);
});

test('unconfirmed prompt admission is explicit and only a deliberate idle host reset releases it', async () => {
  const handle = await keep({ admit: false });
  const command = handle.command('uncertain_prompt');
  expect((await handle.bridge.dispatch(command)).status).toBe('forwarded');
  expect(handle.bridge.snapshot().capabilities.prompt).toBe(false);
  await handle.request('/perch/health'); await handle.request(sessionPath);
  expect((await handle.bridge.dispatch(handle.command('second_prompt'))).status).toBe('rejected');
  expect(handle.state.prompts).toHaveLength(1);
  expect(handle.bridge.resetAdmission(handle.context)).toBe(true);
  expect(handle.bridge.snapshot().capabilities.prompt).toBe(true);
  expect(handle.bridge.catalog().sessions[0].generation).not.toBe(command.generation);
  expect((await handle.bridge.dispatch(command)).status).toBe('forwarded'); expect(handle.state.prompts).toHaveLength(1);
});

test('receipt saturation fails closed instead of forgetting old command IDs', async () => {
  const handle = await keep({ maxReceipts: 2 });
  const a = handle.command('interrupt_a', 'interrupt', {}), b = handle.command('interrupt_b', 'interrupt', {});
  await handle.bridge.dispatch(a); await handle.bridge.dispatch(b);
  expect((await handle.bridge.dispatch(handle.command('interrupt_c', 'interrupt', {}))).status).toBe('rejected');
  expect((await handle.bridge.dispatch(a)).status).toBe('forwarded'); expect(handle.state.aborts).toBe(2);
  expect(handle.bridge.operation('unrecognized')).toBeUndefined();
});

test('an unknown pre-admission command stays missing after desktop /new instead of acquiring the new identity', async () => {
  const handle = await keep();
  const untransmitted = handle.command('lost_before_admission');
  handle.state.sessionId = 'conversation_after_new';
  await handle.bridge.observe({ type: 'session_switch' }, handle.context);
  const missing = await handle.request(`${sessionPath}/operations/${untransmitted.id}`);
  expect(missing.status).toBe(404);
  const body = await missing.text();
  expect(body).not.toContain('conversation_after_new'); expect(body).not.toContain('generation');
  expect(parseRemoteCatalog(await (await handle.request('/perch/sessions')).json()).sessions[0].conversationId).toBe('conversation_after_new');
  expect(handle.state.prompts).toHaveLength(0);
});

test('compaction and tree navigation retire stale event tails and fence their old command identities', async () => {
  const handle = await keep();
  const message = { role: 'assistant', timestamp: 24, content: [{ type: 'text', text: 'This answer will be removed' }] };
  await handle.bridge.observe({ type: 'message_start', message }, handle.context);
  await handle.bridge.observe({ type: 'message_end', message }, handle.context);
  await handle.bridge.observe({ type: 'tool_execution_end', toolCallId: 'removed_tool', toolName: 'bash', isError: false,
    result: { content: [{ type: 'text', text: 'Removed tool output' }] } }, handle.context);
  const prior = handle.command('before_compaction');
  handle.state.entries = [];
  await handle.bridge.observe({ type: 'session_compact' }, handle.context);
  const compacted = handle.bridge.snapshot();
  expect(compacted.messages).toHaveLength(0); expect(compacted.tools).toHaveLength(0);
  expect(compacted.session.generation).not.toBe(prior.generation);
  expect((await handle.bridge.dispatch(prior)).status).toBe('rejected');
  const beforeTree = handle.command('before_tree');
  await handle.bridge.observe({ type: 'session_tree' }, handle.context);
  expect(handle.bridge.catalog().sessions[0].generation).not.toBe(beforeTree.generation);
});

test('snapshot limits explicitly truncate recent text and never turn a partial write into an exact artifact', async () => {
  const handle = await keep();
  handle.state.entries = Array.from({ length: MAX_ROWS + 5 }, (_, index) => entry(`row_${index}`, { role: 'assistant', timestamp: index + 1,
    content: [{ type: 'text', text: `row ${index} ` + '😀'.repeat(5000) }] }));
  handle.state.entries.push(entry('large_write', { role: 'assistant', timestamp: 1000, content: [{ type: 'toolCall', id: 'large_file', name: 'write',
    arguments: { path: 'huge.html', content: 'a'.repeat(MAX_TEXT + 1) } }] }));
  const snapshot = parseRemoteSnapshot(handle.bridge.snapshot());
  expect(snapshot.truncated).toBe(true); expect(snapshot.messages.length).toBeLessThanOrEqual(MAX_ROWS);
  expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThanOrEqual(MAX_SNAPSHOT_BYTES);
  expect(snapshot.tools.every(tool => tool.artifact === undefined)).toBe(true);
  expect(snapshot.notices.join(' ')).toContain('full history remains in OMP');
  expect(handle.state.entries).toHaveLength(MAX_ROWS + 6);
});

test('recent tool output survives the byte budget while older conversation rows are omitted', async () => {
  const handle = await keep();
  handle.state.entries.push(entry('old_tool_call', { role: 'assistant', timestamp: 1, content: [{ type: 'toolCall', id: 'latest_result', name: 'bash', arguments: { command: 'fixture-only' } }] }));
  for (let index = 0; index < 8; index++) handle.state.entries.push(entry(`old_${index}`, { role: 'assistant', timestamp: index + 2,
    content: [{ type: 'text', text: String(index).repeat(240_000) }] }));
  const newestOutput = 'Latest verified tool output\n' + 'z'.repeat(100_000);
  handle.state.entries.push(entry('latest_tool_result', { role: 'toolResult', toolCallId: 'latest_result', toolName: 'bash', isError: false,
    content: [{ type: 'text', text: newestOutput }], timestamp: 50 }));
  const snapshot = parseRemoteSnapshot(handle.bridge.snapshot());
  expect(snapshot.truncated).toBe(true); expect(snapshot.messages.length).toBeLessThan(9);
  expect(snapshot.tools).toHaveLength(1); expect(snapshot.tools[0].output).toBe(newestOutput); expect(snapshot.tools[0].status).toBe('done');
  expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThanOrEqual(MAX_SNAPSHOT_BYTES);
});

test('auth, browser, paths, bodies, and unsupported fields are rejected before effects', async () => {
  const handle = await keep();
  expect((await handle.request(sessionPath, { headers: { Origin: 'https://evil.example' } })).status).toBe(403);
  expect((await handle.request(`${sessionPath}?token=secret`)).status).toBe(400);
  expect((await handle.request('/perch/sessions/%2e%2e/commands', post(handle.command('path')))).status).toBe(404);
  expect((await handle.request(`${sessionPath}/commands`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'text/plain' } })).status).toBe(415);
  expect((await handle.request(`${sessionPath}/commands`, { method: 'POST', body: '{', headers: { 'Content-Type': 'application/json' } })).status).toBe(400);
  expect((await handle.request(`${sessionPath}/commands`, post({ ...handle.command('extra'), shell: 'forbidden' }))).status).toBe(400);
  expect((await handle.request(`${sessionPath}/commands`, post({ ...handle.command('large'), text: 'a'.repeat(MAX_REMOTE_COMMAND_BYTES) }))).status).toBe(413);
  expect((await handle.bridge.dispatch({ ...handle.command('no_identity'), conversationId: undefined })).status).toBe('rejected');
  expect((await handle.bridge.dispatch(handle.command('unknown_model', 'set-model', { provider: 'arbitrary', modelId: 'arbitrary' }))).status).toBe('rejected');
  expect(handle.state.prompts).toHaveLength(0); expect(handle.state.models).toHaveLength(0); expect(handle.state.aborts).toBe(0);
});
