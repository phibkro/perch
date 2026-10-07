import test from 'node:test';
import assert from 'node:assert/strict';
import { configuredModels, productionRuntime } from '../src/provider.mjs';
import { workspaceManifest } from '../src/workspace.mjs';
import { authenticate, parseAccess } from '../src/http.mjs';
import { parseManifest } from '../../../src/workspace/protocol.ts';

const definition = { provider: 'wire', id: 'test-model', name: 'Test model',
  baseUrl: 'https://provider.example/v1', apiKey: 'sk-private-fixture', contextWindow: 32768, maxTokens: 1024 };
const envFor = (extra = {}) => ({ PERCH_MODELS: JSON.stringify([{ ...definition, ...extra }]) });
const transcript = { messages: [{ role: 'user', content: 'Say hello', timestamp: 1 }] };
const text = 'Hello from the wire';
const event = data => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`;
function streamBody(api) {
  if (api === 'openai-completions') return `data: ${JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } })}\n\ndata: [DONE]\n\n`;
  if (api === 'openai-responses') return [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg-1', role: 'assistant', content: [] } },
    { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: text },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg-1', content: [{ type: 'output_text', text, annotations: [] }] } },
    { type: 'response.completed', response: { id: 'resp-1', status: 'completed', output: [], usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 } } },
  ].map(event).join('');
  return [
    { type: 'message_start', message: { id: 'msg-1', type: 'message', role: 'assistant', model: 'test-model', content: [], stop_reason: null, usage: { input_tokens: 3, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } },
    { type: 'message_stop' },
  ].map(event).join('');
}

for (const [api, suffix, authHeader] of [
  ['openai-completions', '/chat/completions', 'authorization'],
  ['openai-responses', '/responses', 'authorization'],
  ['anthropic-messages', '/messages', 'x-api-key'],
]) {
  test(`real Pi ${api} adapter sends configured credentials and parses streaming text`, async () => {
    const runtime = productionRuntime(envFor({ api, baseUrl: api === 'anthropic-messages' ? 'https://provider.example' : definition.baseUrl }));
    const model = runtime.models.getModel('wire', 'test-model');
    const requests = [];
    const result = await runtime.models.completeSimple(model, transcript, { maxRetries: 0, fetch: async (url, init) => {
      const request = new Request(url, init); requests.push(request);
      assert.equal(new URL(request.url).pathname, '/v1' + suffix);
      assert.equal(request.headers.get(authHeader), authHeader === 'authorization' ? 'Bearer sk-private-fixture' : 'sk-private-fixture');
      const body = await request.json(); assert.equal(body.model, 'test-model'); assert.equal(body.stream, true);
      assert.equal(JSON.stringify(body).includes('Say hello'), true);
      return new Response(streamBody(api), { headers: { 'Content-Type': 'text/event-stream' } });
    } });
    assert.equal(requests.length, 1);
    assert.equal(result.stopReason, 'stop', result.errorMessage);
    assert.equal(result.content.filter(part => part.type === 'text').map(part => part.text).join(''), text);
    assert.deepEqual(runtime.safeModels, [{ provider: 'wire', id: 'test-model', name: 'Test model' }]);
  });
}

test('Go forwards Pi persisted session identity across requests and respects a fork identity', async () => {
  const runtime = productionRuntime(envFor({ provider: 'opencode-go', api: 'openai-completions' }), { metadata: { id: 'perch-fallback' } });
  const model = runtime.models.getModel('opencode-go', 'test-model'); const seen = [];
  for (const sessionId of ['pi-persisted-1', 'pi-persisted-1', 'pi-fork-2', undefined]) {
    const result = await runtime.models.completeSimple(model, transcript, { sessionId, maxRetries: 0, fetch: async (url, init) => {
      const headers = new Headers(init.headers); seen.push(headers.get('x-opencode-session'));
      assert.equal(headers.get('user-agent'), 'perch-pi-durable/1');
      return new Response(streamBody('openai-completions'), { headers: { 'Content-Type': 'text/event-stream' } });
    } });
    assert.equal(result.stopReason, 'stop', result.errorMessage);
  }
  assert.deepEqual(seen, ['pi-persisted-1', 'pi-persisted-1', 'pi-fork-2', 'perch-fallback']);
  const missing = productionRuntime(envFor({ provider: 'opencode-go' }));
  const rejected = await missing.models.completeSimple(missing.models.getModel('opencode-go', 'test-model'), transcript, {
    fetch: () => { assert.fail('No upstream request without session identity'); },
  });
  assert.equal(rejected.stopReason, 'error');
  assert.match(rejected.errorMessage, /stable session/);
});

test('API configuration is explicit with backward compatible completions default', () => {
  assert.equal(configuredModels(envFor())[0].api, 'openai-completions');
  assert.throws(() => configuredModels(envFor({ api: 'invented-oauth-api' })), error => error.status === 503);
  const mixed = configuredModels({ PERCH_MODELS: JSON.stringify([
    { ...definition, api: 'openai-completions' }, { ...definition, id: 'other', api: 'anthropic-messages', baseUrl: 'https://provider.example' },
  ]) });
  assert.equal(mixed.length, 2);
  assert.throws(() => configuredModels(envFor({ api: 'anthropic-messages', apiKey: 'sk-ant-oat01-consumer-token' })), error => error.status === 503);
  assert.throws(() => configuredModels(envFor({ provider: 'openai', api: 'openai-responses', baseUrl: 'https://api.openai.com/v1', apiKey: 'subscription-token' })), error => error.status === 503);
});

test('one Go provider routes Messages and Responses to their distinct catalog API roots', async () => {
  const definitions = [
    { ...definition, provider: 'opencode-go', id: 'messages-model', api: 'anthropic-messages', baseUrl: 'https://opencode.ai/zen/go' },
    { ...definition, provider: 'opencode-go', id: 'responses-model', api: 'openai-responses', baseUrl: 'https://opencode.ai/zen/go/v1' },
  ];
  const runtime = productionRuntime({ PERCH_MODELS: JSON.stringify(definitions) }); const paths = [];
  for (const item of definitions) {
    const result = await runtime.models.completeSimple(runtime.models.getModel('opencode-go', item.id), transcript, {
      sessionId: 'persisted-go-session', maxRetries: 0, fetch: async (url, init) => {
        paths.push(new URL(url).pathname); assert.equal(new Headers(init.headers).get('x-opencode-session'), 'persisted-go-session');
        return new Response(streamBody(item.api), { headers: { 'Content-Type': 'text/event-stream' } });
      },
    });
    assert.equal(result.stopReason, 'stop', result.errorMessage);
  }
  assert.deepEqual(paths, ['/zen/go/v1/messages', '/zen/go/v1/responses']);
});

test('workspace discovery uses the authenticated identity and explicitly labels runtime deployment', () => {
  const token = 'a'.repeat(48);
  const env = { PERCH_TOKENS: JSON.stringify({ mine: token }), PERCH_WORKSPACE_NAME: 'My workspace' };
  const request = new Request('https://workspace.example/perch/workspace?workspace=other', { headers: {
    Authorization: `Bearer ${token}`, 'X-Workspace': 'other',
  } });
  const id = authenticate(request, parseAccess(env));
  const self = parseManifest(workspaceManifest(env, id));
  assert.deepEqual(self.workspace, { id: 'mine', name: 'My workspace', deployment: 'self-hosted' });
  const cloud = workspaceManifest({ ...env, PERCH_DEPLOYMENT: 'cloudflare' }, id);
  assert.equal(cloud.workspace.deployment, 'cloudflare');
  assert.deepEqual(cloud.connections, [{ id: 'durable', name: 'Pi Durable', kind: 'durable', path: '' }]);
  assert.equal(JSON.stringify(cloud).includes(token), false);
  assert.throws(() => workspaceManifest({ ...env, PERCH_DEPLOYMENT: 'unknown' }, id), error => error.status === 503);
  assert.throws(() => workspaceManifest({ ...env, PERCH_WORKSPACE_NAME: 'x'.repeat(121) }, id), error => error.status === 503);
});
