import { createModels, createProvider } from '@earendil-works/pi-ai/models';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { HttpError, isRecord } from './http.mjs';

export const MODEL_APIS = ['openai-completions', 'openai-responses', 'anthropic-messages'];
const configurationError = () => { throw new HttpError(503, 'Configure the host model provider before connecting.'); };
export function configuredModels(env) {
  let raw;
  try { raw = JSON.parse(env.PERCH_MODELS); } catch { configurationError(); }
  if (!Array.isArray(raw) || !raw.length || raw.length > 100) configurationError();
  const seen = new Set(); const providers = new Map();
  const definitions = raw.map(item => {
    if (!isRecord(item) || Object.keys(item).some(key => !['provider', 'id', 'name', 'baseUrl', 'api', 'apiKey', 'keyless', 'contextWindow', 'maxTokens', 'reasoning'].includes(key))
        || typeof item.provider !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(item.provider)
        || typeof item.id !== 'string' || !item.id || item.id.length > 256 || /[\u0000-\u001f\u007f]/.test(item.id)
        || typeof item.name !== 'string' || !item.name || item.name.length > 160 || /[\u0000-\u001f\u007f]/.test(item.name)
        || !Number.isSafeInteger(item.contextWindow) || item.contextWindow < 4096 || item.contextWindow > 10_000_000
        || !Number.isSafeInteger(item.maxTokens) || item.maxTokens < 1 || item.maxTokens >= item.contextWindow
        || (item.reasoning !== undefined && typeof item.reasoning !== 'boolean')
        || (item.api !== undefined && !MODEL_APIS.includes(item.api))
        || (item.keyless !== true && (typeof item.apiKey !== 'string' || !item.apiKey || item.apiKey.length > 8192))
        || (item.keyless === true && item.apiKey !== undefined)) configurationError();
    let url; try { url = new URL(item.baseUrl); } catch { configurationError(); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) configurationError();
    // This runtime installs API keys, not OAuth login or credential refresh.
    if (item.apiKey?.startsWith('sk-ant-oat') || (item.provider === 'openai' && url.href.replace(/\/$/, '') === 'https://api.openai.com/v1' &&
        (item.keyless || !item.apiKey?.startsWith('sk-')))) configurationError();
    const pair = `${item.provider}\0${item.id}`;
    if (seen.has(pair)) configurationError(); seen.add(pair);
    // A provider can expose different API-family roots (Go's Messages root
    // omits /v1). Credentials remain shared; each model owns its exact URL.
    const credential = JSON.stringify([item.apiKey ?? null, item.keyless === true]);
    if (providers.has(item.provider) && providers.get(item.provider) !== credential) configurationError();
    providers.set(item.provider, credential);
    return { ...item, api: item.api ?? 'openai-completions', baseUrl: url.href.replace(/\/$/, '') };
  });
  return definitions;
}

/** Only explicitly configured providers are installed. No catalog discovery or OAuth. */
export function productionRuntime(env, session) {
  const definitions = configuredModels(env);
  const models = createModels();
  for (const providerId of new Set(definitions.map(item => item.provider))) {
    const group = definitions.filter(item => item.provider === providerId);
    const first = group[0];
    const api = {
      'openai-completions': openAICompletionsApi(),
      'openai-responses': openAIResponsesApi(),
      'anthropic-messages': anthropicMessagesApi(),
    };
    if (providerId === 'opencode-go') {
      // Pi persists its provider session ID across eviction and changes it on a
      // fork. Metadata is a fallback for hosts that do not supply that option.
      const optionsForGo = options => {
        const sessionId = options?.sessionId ?? session?.metadata?.id;
        if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 512 || /[^\x21-\x7e]/.test(sessionId)) {
          throw new Error('OpenCode Go requires a stable session identity.');
        }
        return { ...options, headers: { ...options?.headers,
          'User-Agent': 'perch-pi-durable/1', 'x-opencode-session': sessionId } };
      };
      for (const [name, streams] of Object.entries(api)) {
        api[name] = { ...streams,
          stream: (model, context, options) => streams.stream(model, context, optionsForGo(options)),
          streamSimple: (model, context, options) => streams.streamSimple(model, context, optionsForGo(options)),
        };
      }
    }
    models.setProvider(createProvider({
      id: providerId, name: providerId, baseUrl: first.baseUrl,
      auth: { apiKey: { name: 'Host configured provider',
        resolve: async () => ({ auth: first.keyless ? {} : { apiKey: first.apiKey } }) } },
      models: group.map(item => ({ provider: item.provider, id: item.id, name: item.name,
        api: item.api, baseUrl: item.baseUrl, reasoning: item.reasoning ?? false, input: ['text'],
        contextWindow: item.contextWindow, maxTokens: item.maxTokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
      api,
    }));
  }
  return { models, defaultModel: { provider: definitions[0].provider, id: definitions[0].id },
    safeModels: definitions.map(({ provider, id, name }) => ({ provider, id, name })) };
}
