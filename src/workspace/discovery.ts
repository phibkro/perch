import { durableFetch } from '../session/durable/fetch';
import { MAX_WORKSPACE_BYTES, parseManifest, validateCredentials, type WorkspaceCredentials, type WorkspaceManifest } from './protocol';

export async function discoverWorkspace(credentials: WorkspaceCredentials, signal: AbortSignal): Promise<WorkspaceManifest> {
  const { url, token } = validateCredentials(credentials);
  const response = await durableFetch(url + '/perch/workspace', {
    method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    redirect: 'error', credentials: 'omit', signal,
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(response.status === 401 || response.status === 403 ? 'This host rejected the workspace token. Pair again using its current code.' : response.status === 404 ? 'This host needs the Perch workspace setup. You can still use Advanced connection for an older server.' : `The workspace could not be loaded (HTTP ${response.status}). Check the host and try again.`);
  }
  if (response.redirected || response.url && new URL(response.url).origin !== new URL(url).origin) { await response.body?.cancel(); throw new Error('The workspace redirected to another address. Enter its final HTTPS address directly.'); }
  const length = response.headers.get('content-length');
  if (!response.body || length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_WORKSPACE_BYTES)) { await response.body?.cancel(); throw new Error('The host returned an invalid workspace response.'); }
  const reader = response.body.getReader(); const decoder = new TextDecoder('utf-8', { fatal: true });
  let text = ''; let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_WORKSPACE_BYTES) throw new Error('The workspace configuration is too large.');
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('The host returned invalid workspace JSON.'); }
  return parseManifest(value);
}
