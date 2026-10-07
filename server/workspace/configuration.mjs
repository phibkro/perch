import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { MAX_WORKSPACE_BYTES, parseManifest, validateCredentials } from '../../src/workspace/protocol.ts';
import { parseCollabLink } from '../../src/vendor/omp/link.ts';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasFields = (value, required, optional = []) => isObject(value)
  && required.every(key => Object.hasOwn(value, key))
  && Object.keys(value).every(key => [...required, ...optional].includes(key));
const failure = message => { throw new Error(message); };
const secret = (value, minimum = 24, maximum = 512) => typeof value === 'string'
  && value.length >= minimum && value.length <= maximum && /^[\x21-\x7e]+$/.test(value);

/** Only operator-configured literal loopback destinations can receive credentials. */
function upstreamUrl(value, websocket) {
  if (typeof value !== 'string' || value.length > 2048
      || !/^(?:https?|wss?):\/\/(?:127\.0\.0\.1|\[::1\])(?::[0-9]+)?(?:\/[A-Za-z0-9_-]+)*\/?$/.test(value)) {
    failure('Upstream URLs must use literal 127.0.0.1 or [::1], a simple path, and no credentials, query, or fragment.');
  }
  let url;
  try { url = new URL(value); } catch { failure('An upstream URL is invalid.'); }
  if (!(websocket ? ['ws:', 'wss:'] : ['http:', 'https:']).includes(url.protocol)
      || url.port === '0') failure('Use a WebSocket URL for Pi and an HTTP(S) URL for the HTTP adapters.');
  return url.toString().replace(/\/+$/, '');
}

function connection(value) {
  if (!isObject(value)) failure('Each connection must be a configuration object.');
  const base = { id: value.id, name: value.name, kind: value.kind };
  if (value.kind === 'omp') {
    if (!hasFields(value, ['id', 'name', 'kind', 'collabLink']) || typeof value.collabLink !== 'string'
        || value.collabLink.length > 4096 || /[\u0000-\u0020\u007f]/.test(value.collabLink)) failure('Use a complete OMP Collab invitation.');
    let parsed;
    try { parsed = parseCollabLink(value.collabLink); } catch { failure('The OMP Collab invitation is invalid.'); }
    if ('error' in parsed) failure('The OMP Collab invitation is invalid.');
    return { ...base, collabLink: value.collabLink };
  }
  if (!['durable', 'pi', 'opencode'].includes(value.kind)
      || !hasFields(value, ['id', 'name', 'kind', 'upstream'])) failure('A connection kind or its fields are unsupported.');
  const upstream = value.upstream;
  if (value.kind === 'opencode') {
    if (!hasFields(upstream, ['url', 'username', 'password']) || typeof upstream.username !== 'string'
        || !upstream.username || upstream.username.length > 128 || /[:\x00-\x20\x7f-\uffff]/.test(upstream.username)
        || typeof upstream.password !== 'string' || upstream.password.length < 24 || upstream.password.length > 4096
        || /[\x00-\x1f\x7f]/.test(upstream.password)) failure('OpenCode needs the local Perch OpenCode gateway username and password.');
    return { ...base, upstream: { url: upstreamUrl(upstream.url, false), username: upstream.username, password: upstream.password } };
  }
  if (!hasFields(upstream, ['url', 'token']) || !secret(upstream.token, value.kind === 'durable' ? 32 : 24)) failure('Pi and Durable need their local adapter token.');
  return { ...base, upstream: { url: upstreamUrl(upstream.url, value.kind === 'pi'), token: upstream.token } };
}

export function manifestFor(config) {
  const manifest = parseManifest({ protocol: 'perch-workspace', version: 1,
    workspace: config.workspace, defaultConnectionId: config.defaultConnectionId,
    connections: config.connections.map(item => item.kind === 'omp'
      ? { id: item.id, name: item.name, kind: item.kind, collabLink: item.collabLink }
      : { id: item.id, name: item.name, kind: item.kind, path: `/harness/${item.id}` }),
  });
  if (Buffer.byteLength(JSON.stringify(manifest)) > MAX_WORKSPACE_BYTES) failure('The workspace manifest exceeds the phone limit.');
  return manifest;
}

export function parseConfiguration(value) {
  if (!hasFields(value, ['version', 'workspace', 'publicUrl', 'token', 'listen', 'allowedOrigins', 'defaultConnectionId', 'connections']) || value.version !== 1) failure('Unsupported workspace configuration.');
  if (!secret(value.token, 32)) failure('Use a random workspace token of 32–512 printable non-space ASCII characters.');
  let credentials;
  try { credentials = validateCredentials({ url: value.publicUrl, token: value.token }); }
  catch { failure('The public workspace URL must be HTTPS, or loopback HTTP for local development, with a simple path and no credentials.'); }
  if (!hasFields(value.listen, ['hostname', 'port']) || !['127.0.0.1', '::1', '0.0.0.0', '::'].includes(value.listen.hostname)
      || !Number.isInteger(value.listen.port) || value.listen.port < 0 || value.listen.port > 65535) failure('Choose a literal listener address and a valid port.');
  if (!Array.isArray(value.allowedOrigins) || value.allowedOrigins.length > 16) failure('Configure at most 16 exact browser origins.');
  const allowedOrigins = value.allowedOrigins.map(origin => {
    let url;
    try { url = new URL(origin); } catch { failure('A browser origin is invalid.'); }
    if (typeof origin !== 'string' || origin.length > 2048 || !['http:', 'https:'].includes(url.protocol)
        || url.origin !== origin || url.username || url.password) failure('Browser origins must be exact HTTP(S) origins, without paths or credentials.');
    return origin;
  });
  if (!Array.isArray(value.connections) || value.connections.length < 1 || value.connections.length > 16) failure('Configure between one and 16 connections.');
  const config = { version: 1, workspace: value.workspace, publicUrl: credentials.url, token: credentials.token,
    listen: { hostname: value.listen.hostname, port: value.listen.port }, allowedOrigins: [...new Set(allowedOrigins)],
    defaultConnectionId: value.defaultConnectionId, connections: value.connections.map(connection) };
  const manifest = manifestFor(config);
  config.workspace = manifest.workspace;
  for (const item of config.connections) {
    if (item.kind !== 'omp' && (item.upstream.token === config.token || item.upstream.password === config.token)) failure('The workspace token must be different from every upstream credential.');
  }
  return config;
}

export function prepareConfiguration(value) {
  if (!hasFields(value, ['name', 'publicUrl', 'connections'], ['workspaceId', 'defaultConnectionId', 'listen', 'allowedOrigins'])) failure('Setup input needs name, publicUrl, and connections.');
  return parseConfiguration({ version: 1,
    workspace: { id: value.workspaceId ?? randomUUID(), name: value.name, deployment: 'self-hosted' },
    publicUrl: value.publicUrl, token: randomBytes(32).toString('base64url'),
    listen: value.listen ?? { hostname: '127.0.0.1', port: 4780 }, allowedOrigins: value.allowedOrigins ?? [],
    defaultConnectionId: value.defaultConnectionId ?? value.connections?.[0]?.id, connections: value.connections });
}

export function pairingCode(config) {
  const { url, token } = validateCredentials({ url: config.publicUrl, token: config.token });
  return `perch://pair#${Buffer.from(JSON.stringify({ version: 1, url, token })).toString('base64url')}`;
}

export async function readConfiguration(path) {
  const info = await stat(path);
  if (!info.isFile() || info.size > 128 * 1024) failure('The workspace config must be a regular file smaller than 128 KiB.');
  if (process.platform !== 'win32' && (info.mode & 0o077)) failure('The workspace config contains credentials. Set its permissions to 600 before starting it.');
  let value;
  try { value = JSON.parse(await readFile(path, 'utf8')); } catch { failure('The workspace config is not valid JSON.'); }
  return parseConfiguration(value);
}
