/** The phone trusts one workspace origin; model credentials never belong here. */
export const WORKSPACE_PROTOCOL = 'perch-workspace';
export const MAX_WORKSPACE_BYTES = 32 * 1024;
export const MAX_SAVED_WORKSPACES = 8;
export type Deployment = 'self-hosted' | 'cloudflare';
export type WorkspaceCredentials = { url: string; token: string };
export type WorkspaceConnection =
  | { id: string; name: string; kind: 'durable' | 'pi' | 'opencode' | 'remote'; path: string }
  | { id: string; name: string; kind: 'omp'; collabLink: string };
export type WorkspaceManifest = {
  protocol: typeof WORKSPACE_PROTOCOL; version: 1;
  workspace: { id: string; name: string; deployment: Deployment };
  defaultConnectionId: string; connections: WorkspaceConnection[];
};
export type SavedWorkspace = WorkspaceCredentials & {
  id: string; workspaceId: string; name: string; deployment: Deployment;
  lastConnectionId: string;
};

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const fields = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key)) && keys.every(key => Object.hasOwn(value, key));
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
const label = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= 120 && !/[\u0000-\u001f\u007f]/.test(value);
function invalidManifest(): never { throw new Error('This host returned an unsupported workspace configuration. Update its Perch setup and try again.'); }

export function validateCredentials(value: unknown): WorkspaceCredentials {
  if (!object(value) || typeof value.url !== 'string' || typeof value.token !== 'string') throw new Error('Enter the workspace URL and access token, or paste its pairing code.');
  const source = value.url.trim();
  let url: URL;
  try { url = new URL(source); } catch { throw new Error('Enter a valid https:// workspace URL.'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error('Use HTTPS for your workspace. HTTP is allowed only for local development on this device.');
  if (source.length > 2048 || url.username || url.password || /[?#\\\u0000-\u0020\u007f]/.test(source) || /^[a-z]+:\/\/[^/]*@/i.test(source)) throw new Error('Keep credentials out of the workspace URL. It cannot contain a query, fragment, or spaces.');
  // A canonical, literal path prevents a manifest suffix escaping a proxy mount.
  const pathStart = source.indexOf('/', source.indexOf('://') + 3);
  const literalPath = pathStart < 0 ? '/' : source.slice(pathStart);
  if (!/^\/(?:[A-Za-z0-9_-]+\/?)*$/.test(literalPath)) throw new Error('The workspace URL must use a simple path without encoded characters or dot segments.');
  const token = value.token.trim();
  if (token.length < 32 || token.length > 512 || /[^\x21-\x7e]/.test(token)) throw new Error('Enter the workspace token: 32–512 printable characters without spaces.');
  return { url: url.toString().replace(/\/+$/, ''), token };
}

/** A pairing code is a capability. It contains a device token, never provider keys. */
export function parsePairingCode(source: string): WorkspaceCredentials {
  const input = source.trim();
  const match = /^perch:\/\/pair#([A-Za-z0-9_-]+)$/.exec(input);
  if (!match || input.length > 6000) throw new Error('Paste the complete perch://pair#… code from your host setup.');
  let value: unknown;
  try {
    const binary = atob(match[1].replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(match[1].length / 4) * 4, '='));
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch { throw new Error('This pairing code is incomplete or invalid. Copy it again from your host.'); }
  if (!object(value) || !fields(value, ['version', 'url', 'token']) || value.version !== 1) throw new Error('This pairing-code version is not supported. Update the app or the host setup.');
  return validateCredentials(value);
}

export function parseManifest(value: unknown): WorkspaceManifest {
  if (!object(value) || !fields(value, ['protocol', 'version', 'workspace', 'defaultConnectionId', 'connections']) || value.protocol !== WORKSPACE_PROTOCOL || value.version !== 1) invalidManifest();
  const workspace = value.workspace;
  if (!object(workspace) || !fields(workspace, ['id', 'name', 'deployment']) || !identifier(workspace.id) || !label(workspace.name) || !['self-hosted', 'cloudflare'].includes(String(workspace.deployment))) invalidManifest();
  if (!Array.isArray(value.connections) || value.connections.length < 1 || value.connections.length > 16 || !identifier(value.defaultConnectionId)) invalidManifest();
  const seen = new Set<string>();
  const connections: WorkspaceConnection[] = value.connections.map(item => {
    if (!object(item) || !identifier(item.id) || !label(item.name) || seen.has(item.id)) invalidManifest();
    seen.add(item.id);
    if (item.kind === 'omp') {
      if (!fields(item, ['id', 'name', 'kind', 'collabLink']) || typeof item.collabLink !== 'string' || !item.collabLink || item.collabLink.length > 4096 || /[\u0000-\u0020\u007f]/.test(item.collabLink)) invalidManifest();
      return { id: item.id, name: item.name, kind: 'omp', collabLink: item.collabLink };
    }
    if (!fields(item, ['id', 'name', 'kind', 'path']) || !['durable', 'pi', 'opencode', 'remote'].includes(String(item.kind)) || typeof item.path !== 'string' || item.path.length > 256 || !/^(?:\/[A-Za-z0-9_-]+)*$/.test(item.path)) invalidManifest();
    return { id: item.id, name: item.name, kind: item.kind as 'durable' | 'pi' | 'opencode' | 'remote', path: item.path };
  });
  if (!seen.has(value.defaultConnectionId)) invalidManifest();
  return { protocol: WORKSPACE_PROTOCOL, version: 1,
    workspace: { id: workspace.id, name: workspace.name, deployment: workspace.deployment as Deployment },
    defaultConnectionId: value.defaultConnectionId, connections };
}

export function connectionUrl(credentials: WorkspaceCredentials, connection: Exclude<WorkspaceConnection, { kind: 'omp' }>): string {
  const validated = validateCredentials(credentials);
  // parseManifest has ruled out absolute URLs, queries, encoded traversal, and //.
  if (!/^(?:\/[A-Za-z0-9_-]+)*$/.test(connection.path)) invalidManifest();
  const url = validated.url + connection.path;
  return connection.kind === 'pi' ? url.replace(/^http/, 'ws') : url;
}

export function parseSavedWorkspace(value: unknown): SavedWorkspace {
  if (!object(value) || !fields(value, ['id', 'workspaceId', 'name', 'deployment', 'lastConnectionId', 'url', 'token']) || !identifier(value.id) || !identifier(value.workspaceId) || !label(value.name) || !identifier(value.lastConnectionId) || !['self-hosted', 'cloudflare'].includes(String(value.deployment))) throw new Error('A saved workspace is invalid. Remove it and pair again.');
  return { ...validateCredentials(value), id: value.id, workspaceId: value.workspaceId, name: value.name,
    deployment: value.deployment as Deployment, lastConnectionId: value.lastConnectionId };
}
