/** Setup-only package scope: catalogs do not join the Worker or phone bundle. */
export async function setupCatalog(provider) {
  if (provider === 'opencode-go') {
    const { opencodeGoProvider } = await import('@earendil-works/pi-ai/providers/opencode-go');
    return opencodeGoProvider().getModels();
  }
  if (provider === 'anthropic') {
    const { anthropicProvider } = await import('@earendil-works/pi-ai/providers/anthropic');
    return anthropicProvider().getModels();
  }
  if (provider === 'openai') {
    const { openaiProvider } = await import('@earendil-works/pi-ai/providers/openai');
    return openaiProvider().getModels();
  }
  throw new Error('Unsupported setup catalog.');
}
