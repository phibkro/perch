import { MAX_DURABLE_PROMPT } from '../../../src/harness/durable.ts';

export const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
export const MAX_BODY_BYTES = 500_000;
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const fail = (status, message) => { throw new HttpError(status, message); };
export const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export function id(value) {
  if (typeof value !== 'string' || !ID.test(value)) fail(400, 'Invalid identifier.');
  return value;
}
export function fields(value, allowed, required = []) {
  if (!isRecord(value) || Object.keys(value).some(key => !allowed.includes(key))
      || required.some(key => !Object.hasOwn(value, key))) fail(400, 'Invalid request body.');
  return value;
}
export async function jsonBody(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) {
    fail(415, 'Send application/json.');
  }
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) fail(413, 'Request is too large.');
  if (!request.body) fail(400, 'A JSON body is required.');
  const reader = request.body.getReader();
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) { await reader.cancel(); fail(413, 'Request is too large.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail(400, 'Invalid JSON.'); }
}
export function createInput(value) {
  fields(value, ['operationId', 'title'], ['operationId']); id(value.operationId);
  if (value.title !== undefined && (typeof value.title !== 'string' || value.title.length > 120 || /[\u0000-\u001f\u007f]/.test(value.title))) fail(400, 'Invalid title.');
  return { operationId: value.operationId, title: value.title ?? '' };
}
export function submitInput(value) {
  fields(value, ['operationId', 'text'], ['operationId', 'text']); id(value.operationId);
  if (typeof value.text !== 'string' || !value.text.trim() || value.text.length > MAX_DURABLE_PROMPT) fail(400, 'Invalid prompt.');
  return { operationId: value.operationId, text: value.text };
}
export function parseAccess(env) {
  let tokens, origins;
  try {
    tokens = JSON.parse(env.PERCH_TOKENS);
    origins = JSON.parse(env.PERCH_ALLOWED_ORIGINS ?? '[]');
  } catch { fail(503, 'Backend access is not configured.'); }
  if (!isRecord(tokens) || !Object.keys(tokens).length || Object.keys(tokens).length > 100
      || !Array.isArray(origins) || origins.length > 50) fail(503, 'Backend access is not configured.');
  const pairs = Object.entries(tokens);
  const seen = new Set();
  for (const [workspace, token] of pairs) {
    if (!ID.test(workspace) || typeof token !== 'string' || token.length < 32 || token.length > 512
        || /[^\x21-\x7e]/.test(token) || seen.has(token)) fail(503, 'Backend access is not configured.');
    seen.add(token);
  }
  for (const origin of origins) {
    let url; try { url = new URL(origin); } catch { fail(503, 'Backend access is not configured.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin || url.username || url.password) fail(503, 'Backend access is not configured.');
  }
  return { pairs, origins: new Set(origins) };
}
export function originFor(request, access) {
  const origin = request.headers.get('origin');
  if (origin !== null && !access.origins.has(origin)) fail(403, 'Origin is not allowed.');
  return origin;
}
export function authenticate(request, access) {
  const match = /^Bearer ([\x21-\x7e]{32,512})$/.exec(request.headers.get('authorization') ?? '');
  if (!match) fail(401, 'Authentication required.');
  const supplied = match[1]; let workspace;
  // Compare every configured candidate, without an early exit on the first byte.
  for (const [candidate, expected] of access.pairs) {
    let difference = expected.length ^ supplied.length;
    for (let i = 0; i < 512; i++) difference |= (expected.charCodeAt(i) || 0) ^ (supplied.charCodeAt(i) || 0);
    if (difference === 0) workspace = candidate;
  }
  if (!workspace) fail(401, 'Authentication required.');
  return workspace;
}
export function preflight(request) {
  if (!request.headers.has('origin')) fail(400, 'Origin is required for preflight.');
  if (!['GET', 'POST'].includes(request.headers.get('access-control-request-method'))) fail(405, 'Method is not allowed.');
  const headers = (request.headers.get('access-control-request-headers') ?? '').toLowerCase().split(',').map(v => v.trim()).filter(Boolean);
  if (headers.length > 4 || headers.some(h => !['authorization', 'content-type'].includes(h))) fail(403, 'Headers are not allowed.');
  return new Response(null, { status: 204, headers: {
    'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '600',
  } });
}
export function secureResponse(response, origin) {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store'); headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer'); headers.set('Vary', 'Origin');
  if (response.status === 401) headers.set('WWW-Authenticate', 'Bearer');
  if (origin) { headers.set('Access-Control-Allow-Origin', origin); headers.set('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length, ETag'); }
  return new Response(response.body, { status: response.status, headers });
}
export function errorResponse(error) {
  return Response.json({ error: error instanceof HttpError ? error.message : 'Backend request failed.' },
    { status: error instanceof HttpError ? error.status : 500 });
}
