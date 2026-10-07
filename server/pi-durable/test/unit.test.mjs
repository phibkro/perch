import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { authenticate, createInput, errorResponse, jsonBody, originFor, parseAccess,
  preflight, secureResponse, submitInput } from '../src/http.mjs';
import { configuredModels, productionRuntime } from '../src/provider.mjs';
import { artifactInput, attachmentHeaders, sha256, storeImmutable } from '../src/artifacts.mjs';
import { projectSnapshot } from '../src/projector.mjs';

const alpha = 'a'.repeat(48), beta = 'b'.repeat(48);
const env = { PERCH_TOKENS: JSON.stringify({ alpha, beta }), PERCH_ALLOWED_ORIGINS: '["https://app.example"]' };
const request = (headers = {}) => new Request('https://api.example/perch/health', { headers });
const rejectsStatus = status => error => error.status === status;

test('access fails closed; distinct bearer tokens determine the workspace', () => {
  assert.throws(() => parseAccess({}), rejectsStatus(503));
  assert.throws(() => parseAccess({ PERCH_TOKENS: JSON.stringify({ alpha: 'short' }) }), rejectsStatus(503));
  assert.throws(() => parseAccess({ PERCH_TOKENS: JSON.stringify({ alpha, beta: alpha }) }), rejectsStatus(503));
  const access = parseAccess(env);
  assert.equal(authenticate(request({ Authorization: `Bearer ${alpha}`, 'X-Workspace': 'beta' }), access), 'alpha');
  assert.equal(authenticate(request({ Authorization: `Bearer ${beta}` }), access), 'beta');
  assert.throws(() => authenticate(request(), access), rejectsStatus(401));
  assert.throws(() => authenticate(request({ Authorization: `Bearer ${alpha.slice(0, -1)}x` }), access), rejectsStatus(401));
});

test('browser requests require an exact origin; native requests have no Origin', () => {
  const access = parseAccess(env);
  assert.equal(originFor(request(), access), null);
  assert.equal(originFor(request({ Origin: 'https://app.example' }), access), 'https://app.example');
  assert.throws(() => originFor(request({ Origin: 'https://app.example.evil' }), access), rejectsStatus(403));
  assert.throws(() => originFor(request({ Origin: 'null' }), access), rejectsStatus(403));
  assert.throws(() => parseAccess({ ...env, PERCH_ALLOWED_ORIGINS: '["*"]' }), rejectsStatus(503));
  const pre = new Request('https://api.example/perch/health', { method: 'OPTIONS', headers: {
    Origin: 'https://app.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, content-type',
  } });
  assert.equal(preflight(pre).status, 204);
  assert.throws(() => preflight(new Request(pre, { headers: { Origin: 'https://app.example',
    'Access-Control-Request-Method': 'DELETE' } })), rejectsStatus(405));
  const response = secureResponse(errorResponse(new Error('provider secret: do-not-leak')), 'https://app.example');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://app.example');
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
});

test('request decoding rejects oversized chunked bodies and preserves exact prompt identity', async () => {
  const body = text => new Request('https://api.example/perch/sessions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: text,
  });
  const input = { operationId: 'operation_1', text: '  Exact whitespace\n' };
  assert.deepEqual(submitInput(await jsonBody(body(JSON.stringify(input)))), input);
  assert.deepEqual(createInput({ operationId: 'create-1' }), { operationId: 'create-1', title: '' });
  assert.throws(() => createInput({ operationId: 'poison-title', title: 'chat\u007f' }), rejectsStatus(400));
  assert.throws(() => submitInput({ ...input, workspaceId: 'other' }), rejectsStatus(400));
  assert.throws(() => submitInput({ ...input, operationId: '../unsafe' }), rejectsStatus(400));
  assert.throws(() => submitInput({ ...input, text: 'x'.repeat(100001) }), rejectsStatus(400));
  await assert.rejects(jsonBody(body('{not-json')), rejectsStatus(400));
  await assert.rejects(jsonBody(body(' '.repeat(500001))), rejectsStatus(413));
  await assert.rejects(jsonBody(new Request('https://api.example/perch/sessions', {
    method: 'POST', body: '{}', headers: { 'Content-Type': 'text/plain' },
  })), rejectsStatus(415));
  assert.deepEqual(await errorResponse(new Error('private-key')).json(), { error: 'Backend request failed.' });
});

const modelDefinition = { provider: 'local', id: 'code/model', name: 'Local model',
  baseUrl: 'http://127.0.0.1:8080/v1', apiKey: 'private-test-key', contextWindow: 32768, maxTokens: 4096 };
test('provider configuration requires an explicit key policy and exposes only safe descriptors', () => {
  assert.throws(() => configuredModels({}), rejectsStatus(503));
  const { apiKey, ...missing } = modelDefinition;
  assert.throws(() => configuredModels({ PERCH_MODELS: JSON.stringify([missing]) }), rejectsStatus(503));
  assert.throws(() => configuredModels({ PERCH_MODELS: JSON.stringify([{ ...modelDefinition, baseUrl: 'https://user:secret@host.example' }]) }), rejectsStatus(503));
  assert.throws(() => configuredModels({ PERCH_MODELS: JSON.stringify([modelDefinition, modelDefinition]) }), rejectsStatus(503));
  for (const field of ['provider', 'id', 'name']) {
    assert.throws(() => configuredModels({ PERCH_MODELS: JSON.stringify([{ ...modelDefinition, [field]: 'invalid\u007f' }]) }), rejectsStatus(503));
  }
  const runtime = productionRuntime({ PERCH_MODELS: JSON.stringify([modelDefinition]) });
  assert.deepEqual(runtime.safeModels, [{ provider: 'local', id: 'code/model', name: 'Local model' }]);
  assert.equal(JSON.stringify(runtime.safeModels).includes('private-test-key'), false);
  const keyless = configuredModels({ PERCH_MODELS: JSON.stringify([{ ...missing, keyless: true }]) });
  assert.equal(keyless[0].keyless, true);
});

test('artifact limits use UTF-8 bytes and downloaded HTML cannot become an API-origin document', () => {
  const input = { kind: 'html', filename: 'preview.html', title: 'Preview', content: '<script>window.parent.secret</script>' };
  const parsed = artifactInput(input);
  assert.equal(parsed.mimeType, 'text/html'); assert.equal(parsed.language, 'html');
  assert.throws(() => artifactInput({ ...input, title: 'Invalid\u007f' }));
  assert.throws(() => artifactInput({ ...input, filename: '../preview.html' }));
  assert.throws(() => artifactInput({ ...input, filename: '"inject.html' }));
  assert.throws(() => artifactInput({ ...input, content: '😀'.repeat(500001) }));
  const headers = attachmentHeaders({ filename: 'preview.html', bytes: parsed.bytes.length, sha256: 'f'.repeat(64) });
  assert.equal(headers['Content-Type'], 'application/octet-stream');
  assert.equal(headers['Content-Disposition'], 'attachment; filename="preview.html"');
  assert.equal(headers['X-Content-Type-Options'], 'nosniff');
  assert.match(headers['Content-Security-Policy'], /sandbox/);
});

test('immutable artifact retries converge and refuse damaged existing content', async () => {
  const stored = new Map(); let writes = 0;
  const bucket = {
    async put(key, bytes, options) {
      assert.deepEqual(options.onlyIf, { etagDoesNotMatch: '*' });
      if (stored.has(key)) return null;
      writes++; stored.set(key, bytes.slice()); return { key };
    },
    async get(key) {
      const bytes = stored.get(key);
      return bytes ? { size: bytes.length, arrayBuffer: async () => bytes.slice().buffer } : null;
    },
  };
  const bytes = new TextEncoder().encode('# A stable artifact\n');
  const digest = await sha256(bytes);
  await storeImmutable(bucket, digest, bytes, digest);
  await storeImmutable(bucket, digest, bytes, digest);
  assert.equal(writes, 1);
  stored.set(digest, new Uint8Array(bytes.length));
  await assert.rejects(storeImmutable(bucket, digest, bytes, digest), /integrity/);
});

test('snapshot contains stable tool-task identity, committed partials, and safe provider metadata', () => {
  const metadata = { id: 'session-1', title: 'Artifact chat', createdAt: 1 };
  const manifest = { id: 'artifact-1', sessionId: metadata.id, sourceId: 'tool:session-1:tool-task:7' };
  const view = { entries: [
    { id: 1, model: [{ role: 'user', content: 'Write a document', timestamp: 1 }] },
    { id: 2, model: [{ role: 'assistant', content: [{ type: 'toolCall', id: 'call-1', name: 'write_artifact', arguments: {} }], timestamp: 2 }] },
    { id: 3, byTaskId: 7, model: [{ role: 'toolResult', toolCallId: 'call-1', toolName: 'write_artifact', content: [{ type: 'text', text: 'Saved' }], isError: false }] },
    { id: 4, model: [{ role: 'assistant', content: [], stopReason: 'error', errorMessage: 'Authorization: Bearer PRIVATE' }] },
  ], docs: { 'pi.live': { generation: { attempt: 2, message: { role: 'assistant', content: [{ type: 'text', text: 'Committed partial' }], timestamp: 4 } },
    tools: [], run: { taskId: 9, inputs: [1] } }, 'pi.inbox': { items: [] }, 'pi.agent': { model: { provider: 'local', modelId: 'model' } } } };
  const input = { metadata, view, operations: [{ operationId: 'request-1', status: 'running' }], manifests: [manifest],
    models: [{ provider: 'local', id: 'model', name: 'Model' }] };
  const projected = projectSnapshot(input);
  assert.equal(projected.state.tools.length, 1);
  assert.equal(projected.state.tools[0].id, 'session-1:tool-task:7');
  assert.equal(`tool:${projected.state.tools[0].id}`, manifest.sourceId);
  assert.equal(projected.state.tools[0].status, 'done');
  assert.equal(projected.state.messages.at(-1).text, 'Committed partial');
  assert.equal(projected.state.messages.at(-1).streaming, true);
  assert.equal(projected.state.isWorking, true);
  assert.equal(projected.state.pendingQuestion, null);
  assert.equal(JSON.stringify(projected).includes('PRIVATE'), false);
  assert.deepEqual(projectSnapshot(input), projected);
  assert.equal(projected.state.storedArtifacts[0].id, manifest.id);
});

// Exercise the actual phone boundary and artifact identity derivation, not a
// second validator that could drift with this projector. The build stays in RAM.
let phonePromise;
function phone() {
  return phonePromise ??= (async () => {
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const bundled = await build({ bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent',
      stdin: { resolveDir: root, contents: `export { snapshot as validate } from './src/session/durable/projection.ts'; export { deriveArtifacts } from './src/artifacts/model.ts';` } });
    return import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'));
  })();
}
const frame = (entries = [], live = {}) => ({ entries, docs: { 'pi.live': live } });
const assistant = (text, extra = {}) => ({ role: 'assistant', content: [{ type: 'text', text }], timestamp: 42, ...extra });
const project = (view, extra = {}) => projectSnapshot({ metadata: { id: 'session-1', title: 'Chat', createdAt: 1 },
  view, operations: [], manifests: [], models: [], ...extra });

test('the open document keeps its identity through completion, retries, and a subsequent generation', async () => {
  const api = await phone();
  const text = '# A document\n\nThis response is being read as it streams.';
  const user = { id: 2, model: [{ role: 'user', content: 'Write a document', timestamp: 1 }] };
  const first = project(frame([user], { run: { taskId: 5, inputs: [1] }, generation: { attempt: 1, message: assistant(text) } }));
  const completed = project(frame([user, { id: 9, byTaskId: 5, model: [assistant(text)] }]));
  const firstMessage = api.validate(first, 'session-1').state.messages.at(-1);
  const completedMessage = api.validate(completed, 'session-1').state.messages.at(-1);
  assert.equal(firstMessage.id, completedMessage.id);
  assert.equal(firstMessage.streaming, true); assert.equal(completedMessage.streaming, false);
  assert.equal(api.deriveArtifacts(first.state.messages)[0].id, api.deriveArtifacts(completed.state.messages)[0].id);

  const failed = { id: 9, byTaskId: 5, model: [assistant('A failed partial', { stopReason: 'error', errorMessage: 'private detail' })] };
  const retry = project(frame([user, failed], { run: { taskId: 5, inputs: [1] }, generation: { attempt: 2, message: assistant(text) } }));
  const retried = project(frame([user, failed, { id: 12, byTaskId: 5, model: [assistant(text)] }]));
  api.validate(retry, 'session-1'); api.validate(retried, 'session-1');
  assert.equal(retry.state.messages.at(-1).id, retried.state.messages.at(-1).id);
  assert.notEqual(retry.state.messages.at(-2).id, retry.state.messages.at(-1).id);
  assert.equal(api.deriveArtifacts(retry.state.messages).at(-1).id, api.deriveArtifacts(retried.state.messages).at(-1).id);
  assert.equal(JSON.stringify(retried).includes('private detail'), false);
  const next = project(frame([user, ...retried.state.messages.slice(1).map((message, i) => ({ id: 9 + i, byTaskId: 5, model: [assistant(message.text)] }))],
    { run: { taskId: 15, inputs: [1] }, generation: { attempt: 1, message: assistant(text) } }));
  api.validate(next, 'session-1'); assert.notEqual(next.state.messages.at(-1).id, retried.state.messages.at(-1).id);
});

test('unavailable calls have distinct cards and malformed provider labels/IDs cannot poison snapshots', async () => {
  const api = await phone();
  const calls = [
    { type: 'toolCall', id: 'bad\ncall\u007f' + 'x'.repeat(800), name: 'missing\nfunction\u007f', arguments: {} },
    { type: 'toolCall', id: 'second', name: 'another_' + 'x'.repeat(800), arguments: {} },
    { type: 'toolCall', id: 'third', name: '', arguments: {} },
  ];
  const entries = [{ id: 2, byTaskId: 5, model: [assistant('', { content: calls, stopReason: 'toolUse' })] },
    ...calls.map((call, i) => ({ id: 10 + i, byTaskId: 5, data: { diagnostics: [{ code: 'tool_unavailable' }] },
      model: [{ role: 'toolResult', toolCallId: call.id, toolName: call.name, content: [], isError: true }] }))];
  const result = project(frame(entries, { tools: calls.map((call, i) => ({ callId: call.id, name: call.name, status: 'done', entry: 10 + i })) }));
  const parsed = api.validate(result, 'session-1');
  assert.equal(parsed.state.tools.length, 3);
  assert.equal(new Set(parsed.state.tools.map(tool => tool.id)).size, 3);
  assert(parsed.state.tools.every(tool => tool.status === 'error'));
  assert.equal(parsed.state.tools[0].name, 'missing function');
  assert(parsed.state.tools[1].name.endsWith('…')); assert(parsed.state.tools[1].name.length <= 128);
  assert.equal(parsed.state.tools[2].name, 'Tool');
  assert(parsed.state.tools.every(tool => !tool.id.includes('bad') && !tool.id.includes('tool-task:5')));
  assert.equal(entries[0].model[0].content[0].name, calls[0].name, 'Projection does not rewrite host transcript');
});

test('actual tool task sources survive live/completed projection and result-less tools remain visible', async () => {
  const api = await phone();
  const call = { type: 'toolCall', id: 'write\ncall', name: 'write_artifact', arguments: {} };
  const request = { id: 2, byTaskId: 5, model: [assistant('', { content: [call] })] };
  const manifest = { id: 'file-1', sessionId: 'session-1', title: 'Saved', filename: 'saved.md', mimeType: 'text/markdown',
    language: 'markdown', sha256: 'a'.repeat(64), bytes: 1, createdAt: 42, sourceId: 'tool:session-1:tool-task:7' };
  const running = project(frame([request], { run: { taskId: 5, inputs: [1] }, tools: [{ callId: call.id, name: call.name, taskId: 7, status: 'running' }] }), { manifests: [manifest] });
  const completed = project(frame([request, { id: 9, byTaskId: 7, model: [{ role: 'toolResult', toolCallId: call.id, toolName: call.name, content: 'Saved', isError: false }] }],
    { tools: [{ callId: call.id, name: call.name, taskId: 7, status: 'done', entry: 9 }] }), { manifests: [manifest] });
  api.validate(running, 'session-1'); api.validate(completed, 'session-1');
  assert.equal(running.state.tools[0].id, completed.state.tools[0].id);
  assert.equal('tool:' + completed.state.tools[0].id, manifest.sourceId);
  assert.deepEqual(completed.state.storedArtifacts, [manifest]);
  const missing = project(frame([], { tools: [{ callId: 'orphan\ncall', name: '\u007f', taskId: 11, status: 'done' }] }));
  api.validate(missing, 'session-1'); assert.equal(missing.state.tools.length, 1); assert.equal(missing.state.tools[0].status, 'unknown');
});

test('oversized display fields are explicitly shortened and remain valid for the actual phone', async () => {
  const api = await phone();
  const huge = 'x'.repeat(2_000_001);
  const result = project(frame([
    { id: 2, byTaskId: 5, model: [assistant(huge, { stopReason: 'aborted', timestamp: -1 })] },
    { id: 3, byTaskId: 7, model: [{ role: 'toolResult', toolCallId: 'call', toolName: 'Tool', content: huge, isError: true }] },
  ], { run: { taskId: 9, inputs: [1] }, generation: { attempt: 1, message: assistant(huge, { timestamp: 1.5 }) } }));
  api.validate(result, 'session-1');
  for (const text of [...result.state.messages.map(message => message.text), result.state.tools[0].output]) {
    assert(text.length <= 2_000_000); assert.match(text, /Display truncated/);
  }
  assert.match(result.state.messages[0].text, /^\[Response interrupted\]/);
  assert(result.state.messages.every(message => message.createdAt === 1));
});

test('encoded snapshot budget preserves recent text and manifests even when JSON escaping multiplies bytes', async () => {
  const api = await phone();
  const controlText = '\u0000'.repeat(250_000);
  const entries = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, byTaskId: i + 20, model: [assistant(controlText)] }));
  const manifests = Object.freeze([Object.freeze({ id: 'retained-file', sessionId: 'session-1', title: 'Retained document', filename: 'retained.md',
    mimeType: 'text/markdown', language: 'markdown', sha256: 'a'.repeat(64), bytes: 1, createdAt: 42, sourceId: 'tool:session-1:tool-task:7' })]);
  const result = project(frame(entries), { manifests });
  api.validate(result, 'session-1');
  assert(Buffer.byteLength(JSON.stringify(result)) < 12 * 1024 * 1024);
  assert(result.state.messages.some(message => /Display truncated/.test(message.text)));
  assert.equal(result.state.messages.at(-1).text, controlText, 'Newest response gets the remaining display budget first');
  assert.deepEqual(result.state.storedArtifacts, manifests, 'Artifact references survive display-budget reduction');
  assert.equal(entries[0].model[0].content[0].text, controlText, 'Host contents are unchanged');
});

test('a history beyond the phone row cap remains readable with an explicit omission notice', async () => {
  const api = await phone();
  const entries = Array.from({ length: 10_005 }, (_, i) => ({ id: i + 1, model: [{ role: 'user', content: `Message ${i}`, timestamp: 1 }] }));
  const result = project(frame(entries));
  api.validate(result, 'session-1');
  assert(result.state.messages.length <= 10_000);
  assert.equal(result.state.messages[0].role, 'system'); assert.match(result.state.messages[0].text, /6 older messages/);
  assert.equal(result.state.messages.at(-1).text, 'Message 10004');
  assert.equal(entries.length, 10_005);
});
