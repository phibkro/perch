import { createModels, createProvider } from '@earendil-works/pi-ai/models';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { HttpError, isRecord } from './http.mjs';

const configurationError = () => { throw new HttpError(503, 'Configure the host model provider before connecting.'); };
export function configuredModels(env) {
  let raw;
  try { raw = JSON.parse(env.PERCH_MODELS); } catch { configurationError(); }
  if (!Array.isArray(raw) || !raw.length || raw.length > 100) configurationError();
  const seen = new Set(); const providers = new Map();
  const definitions = raw.map(item => {
    if (!isRecord(item) || Object.keys(item).some(key => !['provider', 'id', 'name', 'baseUrl', 'apiKey', 'keyless', 'contextWindow', 'maxTokens', 'reasoning'].includes(key))
        || typeof item.provider !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(item.provider)
        || typeof item.id !== 'string' || !item.id || item.id.length > 256 || /[\u0000-\u001f\u007f]/.test(item.id)
        || typeof item.name !== 'string' || !item.name || item.name.length > 160 || /[\u0000-\u001f\u007f]/.test(item.name)
        || !Number.isSafeInteger(item.contextWindow) || item.contextWindow < 4096 || item.contextWindow > 10_000_000
        || !Number.isSafeInteger(item.maxTokens) || item.maxTokens < 1 || item.maxTokens >= item.contextWindow
        || (item.reasoning !== undefined && typeof item.reasoning !== 'boolean')
        || (item.keyless !== true && (typeof item.apiKey !== 'string' || !item.apiKey || item.apiKey.length > 8192))
        || (item.keyless === true && item.apiKey !== undefined)) configurationError();
    let url; try { url = new URL(item.baseUrl); } catch { configurationError(); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) configurationError();
    const pair = `${item.provider}\0${item.id}`;
    if (seen.has(pair)) configurationError(); seen.add(pair);
    const credential = JSON.stringify([url.href, item.apiKey ?? null]);
    if (providers.has(item.provider) && providers.get(item.provider) !== credential) configurationError();
    providers.set(item.provider, credential);
    return { ...item, baseUrl: url.href.replace(/\/$/, '') };
  });
  return definitions;
}

/** Only explicitly configured providers are installed. No catalog discovery or OAuth. */
export function productionRuntime(env) {
  const definitions = configuredModels(env);
  const models = createModels();
  for (const providerId of new Set(definitions.map(item => item.provider))) {
    const group = definitions.filter(item => item.provider === providerId);
    const first = group[0];
    models.setProvider(createProvider({
      id: providerId, name: providerId, baseUrl: first.baseUrl,
      auth: { apiKey: { name: 'Host configured provider',
        resolve: async () => ({ auth: first.keyless ? {} : { apiKey: first.apiKey } }) } },
      models: group.map(item => ({ provider: item.provider, id: item.id, name: item.name,
        api: 'openai-completions', baseUrl: item.baseUrl, reasoning: item.reasoning ?? false, input: ['text'],
        contextWindow: item.contextWindow, maxTokens: item.maxTokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
      api: openAICompletionsApi(),
    }));
  }
  return { models, defaultModel: { provider: definitions[0].provider, id: definitions[0].id },
    safeModels: definitions.map(({ provider, id, name }) => ({ provider, id, name })) };
}
