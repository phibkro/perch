import { createModels, createProvider } from '@earendil-works/pi-ai/models';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { createBackend } from '../../server/pi-durable/src/backend.mjs';
import { SessionData } from '../../server/pi-durable/src/artifacts.mjs';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';

// A separate, explicitly synthetic composition root. Production has no switch
// that enables this provider or its loopback fault-injection hooks.
const MODEL = { id: 'fixture', name: 'Synthetic integration model', provider: 'perch-fixture',
  api: 'perch-fixture', baseUrl: 'https://invalid.example', reasoning: false,
  input: ['text'], contextWindow: 32000, maxTokens: 2048,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const SECOND = { ...MODEL, id: 'fixture-two', name: 'Second synthetic model' };
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const files = [
  { kind: 'markdown', filename: 'durable-plan.md', title: 'Durable plan',
    content: '# A plan that stays\n\nSaved on the server. Reopened on the phone.\n\nCafé · 日本語\n' },
  { kind: 'html', filename: 'durable-card.html', title: 'Durable card',
    content: '<!doctype html><html><body><h1>A saved card</h1><p>Open in the isolated reader.</p></body></html>' },
  { kind: 'code', filename: 'durable-helper.ts', title: 'Durable helper', language: 'typescript',
    content: 'export const reconnect = (sessionId: string) => ({ sessionId, replayPrompt: false });\n' },
];
const textOf = content => typeof content === 'string' ? content : (content ?? [])
  .filter(part => part.type === 'text').map(part => part.text).join('');

async function control(session, path, value = {}) {
  const base = new URL(session.env.PROBE_CONTROL_URL);
  if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1') throw new Error('Fixture observer must be loopback.');
  const response = await fetch(new URL(path, base), { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...value, sessionId: session.metadata.id, title: session.metadata.title,
      bootId: session.bootId, activatedBy: session.activatedBy }) });
  if (!response.ok) throw new Error('Fixture observer failed.');
  return response.json();
}

function createRuntime(_env, session) {
  function stream(model, transcript, options) {
    const events = new AssistantMessageEventStream();
    const message = (content, stopReason = 'stop') => ({ role: 'assistant', content, stopReason,
      api: model.api, provider: model.provider, model: model.id, usage, timestamp: Date.now() });
    void (async () => {
      const userIndex = transcript.messages.findLastIndex(item => item.role === 'user');
      const input = textOf(transcript.messages[userIndex]?.content);
      const results = transcript.messages.slice(userIndex + 1).filter(item => item.role === 'toolResult');
      const gate = await control(session, '/model', { input, providerSessionId: options?.sessionId, modelId: model.id });
      if (gate.hold) {
        const partial = message([{ type: 'text', text: 'A committed partial response before the restart.' }]);
        events.push({ type: 'start', partial });
        events.push({ type: 'text_delta', contentIndex: 0, delta: partial.content[0].text, partial });
        options?.signal?.addEventListener('abort', () => {
          const stopped = { ...partial, stopReason: 'aborted', errorMessage: 'Fixture request aborted.' };
          events.push({ type: 'error', reason: 'aborted', error: stopped }); events.end(stopped);
        }, { once: true });
        return;
      }
      const requested = input === 'Create three artifacts' ? files
        : input === 'Recover upload' ? files.slice(0, 1) : [];
      if (results.length < requested.length) {
        const result = message([{ type: 'toolCall', id: `file-${results.length}`,
          name: 'write_artifact', arguments: requested[results.length] }], 'toolUse');
        events.push({ type: 'done', reason: 'toolUse', message: result }); events.end(result); return;
      }
      const text = results.some(item => item.isError) ? 'The artifact tool reported an error.'
        : requested.length ? 'Your saved artifacts are ready.'
        : input === 'Recover partial' ? 'The interrupted response resumed.' : `Answered: ${input}`;
      const result = message([{ type: 'text', text }]);
      events.push({ type: 'done', reason: 'stop', message: result }); events.end(result);
      await control(session, '/event', { type: 'model-finished', input });
    })().catch(error => {
      const failed = { ...message([], 'error'), errorMessage: String(error) };
      events.push({ type: 'error', reason: 'error', error: failed }); events.end(failed);
    });
    return events;
  }
  const models = createModels();
  models.setProvider(createProvider({ id: MODEL.provider, models: [MODEL, SECOND],
    auth: { apiKey: { name: 'Synthetic fixture; no key', resolve: async () => ({ auth: {} }) } },
    api: { stream, streamSimple: stream } }));
  return { models, defaultModel: { provider: MODEL.provider, id: MODEL.id },
    safeModels: [MODEL, SECOND].map(({ provider, id, name }) => ({ provider, id, name })),
    settings: { retry: { enabled: false } } };
}

const backend = createBackend({ createRuntime, synthetic: true,
  async onSessionStart(session) {
    await control(session, '/event', { type: 'boot' });
    // Recovery may finish a fast model before onStart returns. Watch every
    // persisted admission, including those already settled, not only pending().
    const data = await (await session.harness.pi()).snapshot(SessionData, BACKGROUND_CONTEXT);
    for (const admission of data?.admissions ?? []) {
      session.ctx.waitUntil(session.harness.wait(admission.operationId)
        .then(result => control(session, '/event', { type: 'settled', operationId: admission.operationId, result })));
    }
  },
  async onArtifactStored(session, manifest) {
    const gate = await control(session, '/stored', { manifest });
    if (gate.hold) await new Promise(() => {});
  },
  async onArtifactCommitted(session, manifest) { await control(session, '/committed', { manifest }); },
});
export const { PerchCatalog, PerchSession } = backend;
export default { fetch: backend.fetch };
