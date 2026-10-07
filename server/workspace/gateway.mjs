import { createHash, timingSafeEqual } from 'node:crypto';
import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { BRIDGE_PROTOCOL, MAX_FRAME_BYTES, parseClientFrame, parseServerFrame } from '../../src/harness/protocol.ts';
import { MAX_STORED_ARTIFACT_BYTES } from '../../src/harness/durable.ts';
import { health as projectDurableHealth } from '../../src/session/durable/projection.ts';
import { parseConfiguration, manifestFor } from './configuration.mjs';

export const MAX_REQUEST_BYTES = 512 * 1024;
export const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;
const MAX_CLIENT_FRAME = 128 * 1024;
const ID = '[A-Za-z0-9][A-Za-z0-9_-]{0,127}';
const digest = value => createHash('sha256').update(value).digest();
const equal = (left, right) => typeof left === 'string' && left.length <= 8192 && timingSafeEqual(digest(left), digest(right));
const basic = (username, password) => `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
class GatewayError extends Error { constructor(status, message) { super(message); this.status = status; } }
const reject = (status, message) => { throw new GatewayError(status, message); };
const jsonType = value => /^application\/json(?:\s*;|$)/i.test(value ?? '');
// Explicit agents never adopt a process-wide proxy. Bun 1.4.2's fetch ignores
// proxy:false in the presence of HTTP_PROXY, despite the current Bun docs.
const httpAgent = new HttpAgent({ keepAlive: false, maxSockets: 64, proxyEnv: {} });
const httpsAgent = new HttpsAgent({ keepAlive: false, maxSockets: 64, proxyEnv: {} });

function responseHeaders(origin, extra = {}) {
  const headers = new Headers({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer', 'Vary': 'Origin', ...extra });
  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length, ETag');
  }
  return headers;
}
function jsonResponse(status, value, origin, extra) {
  return new Response(JSON.stringify(value), { status, headers: responseHeaders(origin, { 'Content-Type': 'application/json', ...extra }) });
}

async function boundedBytes(body, maximum, signal, declared) {
  if (declared !== null && declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
    await body?.cancel(); reject(413, 'The request or response exceeds this adapter limit.');
  }
  if (!body) return new Uint8Array();
  const reader = body.getReader(); const chunks = []; let count = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      if (signal?.aborted) throw new Error('Cancelled');
      const { done, value } = await reader.read();
      if (signal?.aborted) throw new Error('Cancelled');
      if (done) break;
      count += value.byteLength;
      if (count > maximum) { await reader.cancel(); reject(413, 'The request or response exceeds this adapter limit.'); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(count); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } finally { signal?.removeEventListener('abort', cancel); reader.releaseLock(); }
}

function upstreamRequest(connection, path, { method = 'GET', body, signal, stream = false } = {}) {
  const url = new URL(connection.upstream.url + path);
  return new Promise((resolve, rejectRequest) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method, signal, agent: url.protocol === 'https:' ? httpsAgent : httpAgent,
      headers: { Authorization: connection.kind === 'opencode'
        ? basic(connection.upstream.username, connection.upstream.password) : `Bearer ${connection.upstream.token}`,
      Accept: stream ? 'text/event-stream' : path.includes('/artifacts/') ? 'application/octet-stream' : 'application/json',
      'Accept-Encoding': 'identity', ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': String(body.byteLength) }) },
    }, response => {
      const status = response.statusCode ?? 502;
      if (status >= 300 && status <= 399) {
        response.destroy(); rejectRequest(new GatewayError(502, 'The local adapter redirected the request. Redirects are not followed.')); return;
      }
      const headers = new Headers();
      for (const key of ['content-type', 'content-length', 'content-disposition', 'etag']) {
        const value = response.headers[key]; if (typeof value === 'string') headers.set(key, value);
      }
      resolve({ ok: status >= 200 && status <= 299, status, headers, body: Readable.toWeb(response) });
    });
    request.on('error', rejectRequest);
    request.end(body);
  });
}

async function httpHealth(connection, signal) {
  const response = await upstreamRequest(connection, '/perch/health', { signal });
  if (!response.ok || !jsonType(response.headers.get('content-type'))) {
    await response.body?.cancel(); reject(502, 'The local adapter handshake failed. Check its address and credentials on the host.');
  }
  const bytes = await boundedBytes(response.body, connection.kind === 'durable' ? MAX_RESPONSE_BYTES : 32 * 1024, signal, response.headers.get('content-length'));
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { reject(502, 'The local adapter returned an invalid handshake.'); }
  if (connection.kind === 'opencode') {
    if (!isObject(value) || value.protocol !== 'perch-opencode' || value.version !== 1 || value.healthy !== true
        || typeof value.upstreamVersion !== 'string' || value.upstreamVersion.length > 120
        || typeof value.directory !== 'string' || !value.directory || value.directory.length > 4096
        || /[\u0000-\u001f\u007f]/.test(value.directory)) reject(502, 'Connect this route to the Perch OpenCode gateway, not the raw OpenCode server.');
    return { protocol: 'perch-opencode', version: 1, healthy: true, upstreamVersion: value.upstreamVersion, directory: value.directory };
  }
  try { return projectDurableHealth(value); }
  catch { reject(502, 'Connect this route to the Perch Pi Durable backend.'); }
}

function allowedRoute(kind, method, path) {
  if (kind === 'durable') {
    if (method === 'GET' && path === '/perch/health') return true;
    if (['GET', 'POST'].includes(method) && path === '/perch/sessions') return true;
    if (method === 'GET' && new RegExp(`^/perch/sessions/${ID}(?:/(?:operations|artifacts)/${ID})?$`).test(path)) return true;
    return method === 'POST' && new RegExp(`^/perch/sessions/${ID}/(?:submit|abort|model)$`).test(path);
  }
  if (kind === 'opencode') {
    if (method === 'GET' && ['/perch/health', '/provider', '/event', '/session', '/session/status', '/permission', '/question'].includes(path)) return true;
    if (method === 'GET' && new RegExp(`^/session/${ID}/message$`).test(path)) return true;
    return method === 'POST' && (path === '/session' || new RegExp(`^/session/${ID}/(?:prompt_async|abort)$`).test(path)
      || new RegExp(`^/(?:permission|question)/${ID}/reply$`).test(path));
  }
  return false;
}

function validateQuery(connection, path, params, directory) {
  if (connection.kind === 'durable') { if ([...params].length) reject(400, 'This route does not accept query parameters.'); return ''; }
  const allowed = path === '/session' ? ['directory', 'roots', 'limit'] : ['directory'];
  const seen = new Set();
  for (const [key, value] of params) {
    if (!allowed.includes(key) || seen.has(key)) reject(400, 'Unsupported or repeated query parameter.');
    seen.add(key);
    if (key === 'directory' && value !== directory) reject(403, 'This connection belongs to a different host directory.');
    if (key === 'roots' && value !== 'true') reject(400, 'This client lists root sessions only.');
    if (key === 'limit' && (!/^[1-9][0-9]{0,2}$/.test(value) || Number(value) > 200)) reject(400, 'Use a session limit between one and 200.');
  }
  const query = new URLSearchParams(params);
  query.set('directory', directory);
  return `?${query.toString()}`;
}

function safeCommand(frame) {
  if (frame.type === 'prompt') return { type: frame.type, id: frame.id, text: frame.text };
  if (frame.type === 'interrupt') return { type: frame.type, id: frame.id };
  if (frame.type === 'answer') return { type: frame.type, id: frame.id, questionId: frame.questionId, answer: frame.answer };
  if (frame.type === 'set-model') return { type: frame.type, id: frame.id, provider: frame.provider, modelId: frame.modelId };
  throw new Error('Unsupported command');
}

function openPi(connection) {
  // Bun's WebSocket client uses a direct connection unless a proxy is explicitly
  // supplied. Do not inherit client headers, cookies, URL credentials or Origin.
  return new WebSocket(connection.upstream.url, { perMessageDeflate: false });
}

/** Checks existing adapters without starting an agent, sending a prompt, or using a model. */
export async function probeConnection(connection, timeoutMs = 8000) {
  if (connection.kind === 'omp') return { id: connection.id, status: 'invitation-configured' };
  if (connection.kind !== 'pi') {
    await httpHealth(connection, AbortSignal.timeout(timeoutMs));
    return { id: connection.id, status: 'verified' };
  }
  return new Promise((resolve, rejectPromise) => {
    const socket = openPi(connection); let complete = false;
    const finish = error => {
      if (complete) return; complete = true; clearTimeout(timer);
      socket.terminate();
      if (error) rejectPromise(new Error('The local Pi bridge handshake failed. Check its address and credentials on the host.'));
      else resolve({ id: connection.id, status: 'verified' });
    };
    const timer = setTimeout(() => finish(true), timeoutMs);
    socket.onopen = () => socket.send(JSON.stringify({ type: 'hello', protocol: BRIDGE_PROTOCOL, token: connection.upstream.token }));
    socket.onmessage = event => {
      try {
        if (typeof event.data !== 'string' || Buffer.byteLength(event.data) > MAX_FRAME_BYTES
            || parseServerFrame(JSON.parse(event.data)).type !== 'snapshot') throw new Error('Invalid snapshot');
        finish(false);
      } catch { finish(true); }
    };
    socket.onerror = () => finish(true); socket.onclose = () => finish(true);
  });
}

/** Importing is inert. Calling this function starts only the workspace gateway. */
export function createWorkspaceGateway(input) {
  const config = parseConfiguration(input); const manifest = manifestFor(config);
  const mount = new URL(config.publicUrl).pathname.replace(/\/+$/, '');
  const allowedOrigins = new Set([new URL(config.publicUrl).origin, ...config.allowedOrigins]);
  const routes = new Map(config.connections.filter(item => item.kind !== 'omp').map(item => [`${mount}/harness/${item.id}`, item]));
  const connections = new Set(); const requests = new Set(); const health = new Map();
  let closed = false;
  function closePeer(socket, code = 1011, reason = 'The local adapter connection ended. Reconnect to inspect its state.') {
    const data = socket.data;
    if (data.closed) return;
    data.closed = true; clearTimeout(data.timer);
    data.upstream?.terminate(); connections.delete(socket);
    socket.close(code, reason);
  }
  function send(socket, frame) {
    if (socket.data.closed || socket.readyState !== WebSocket.OPEN) return;
    const text = typeof frame === 'string' ? frame : JSON.stringify(frame);
    if (Buffer.byteLength(text) > MAX_FRAME_BYTES || socket.getBufferedAmount() > MAX_FRAME_BYTES) {
      closePeer(socket, 1009, 'The adapter snapshot exceeds the connection limit.'); return;
    }
    const result = socket.send(text);
    if (result === -1) socket.data.upstream?.pause();
    else if (result === 0) closePeer(socket);
  }
  function connectPi(socket) {
    const data = socket.data;
    data.stage = 'opening'; clearTimeout(data.timer);
    data.timer = setTimeout(() => closePeer(socket, 1013, 'The local Pi bridge did not become ready.'), 8000);
    const upstream = openPi(data.connection); data.upstream = upstream;
    upstream.onopen = () => {
      if (data.closed) { upstream.terminate(); return; }
      upstream.send(JSON.stringify({ type: 'hello', protocol: BRIDGE_PROTOCOL, token: data.connection.upstream.token }));
    };
    upstream.onmessage = event => {
      if (data.closed) return;
      try {
        if (typeof event.data !== 'string' || Buffer.byteLength(event.data) > MAX_FRAME_BYTES) throw new Error('Invalid bridge frame');
        const frame = parseServerFrame(JSON.parse(event.data));
        if (data.stage === 'opening') {
          if (frame.type !== 'snapshot') throw new Error('Expected authenticated snapshot');
          data.stage = 'ready'; clearTimeout(data.timer);
        }
        send(socket, event.data);
      } catch { closePeer(socket, 1011, 'The local Pi bridge returned an unsupported response.'); }
    };
    upstream.onerror = () => closePeer(socket);
    upstream.onclose = () => closePeer(socket);
  }

  const server = Bun.serve({ hostname: config.listen.hostname, port: config.listen.port,
    development: false, maxRequestBodySize: MAX_REQUEST_BYTES, idleTimeout: 60,
    error: () => jsonResponse(500, { error: 'The workspace request failed.' }),
    async fetch(request, instance) {
      let origin; let abort; let cleanup; let streamed = false;
      try {
        if (closed) reject(503, 'The workspace is stopping.');
        const suppliedOrigin = request.headers.get('origin');
        if (suppliedOrigin !== null && !allowedOrigins.has(suppliedOrigin)) reject(403, 'This browser origin is not allowed.');
        origin = suppliedOrigin;
        const url = new URL(request.url);
        if (request.url.length > 8192 || /[%\\]/.test(url.pathname) || url.pathname.includes('//')) reject(400, 'Use a literal workspace route.');
        const discovery = url.pathname === `${mount}/perch/workspace`;
        let route; let path;
        for (const [prefix, item] of routes) {
          if (url.pathname === prefix || url.pathname.startsWith(prefix + '/')) { route = item; path = url.pathname.slice(prefix.length); break; }
        }
        if (!discovery && !route) reject(404, 'This workspace route does not exist.');
        if (request.method === 'OPTIONS') {
          const requestedMethod = request.headers.get('access-control-request-method');
          const requestedHeaders = (request.headers.get('access-control-request-headers') ?? '').toLowerCase().split(',').map(value => value.trim()).filter(Boolean);
          if (!origin || !['GET', 'POST'].includes(requestedMethod) || requestedHeaders.length > 3
              || requestedHeaders.some(value => !['authorization', 'content-type', 'accept'].includes(value))
              || (discovery ? requestedMethod !== 'GET' || url.search : !allowedRoute(route.kind, requestedMethod, path))) reject(403, 'This preflight is not allowed.');
          return new Response(null, { status: 204, headers: responseHeaders(origin, {
            'Access-Control-Allow-Methods': discovery ? 'GET' : 'GET, POST',
            'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept', 'Access-Control-Max-Age': '600' }) });
        }
        if (route?.kind === 'pi' && request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
          if (request.method !== 'GET' || path || url.search || request.headers.has('sec-websocket-protocol')) reject(400, 'Use the configured Pi WebSocket path without parameters.');
          if (instance.pendingWebSockets >= 16) reject(429, 'Too many workspace sockets are open.');
          if (instance.upgrade(request, { headers: responseHeaders(origin), data: { connection: route, stage: 'unauthenticated', closed: false, commands: 0, windowStart: Date.now() } })) return undefined;
          reject(400, 'The WebSocket upgrade failed.');
        }
        const expected = route?.kind === 'opencode' ? basic('perch', config.token) : `Bearer ${config.token}`;
        if (!equal(request.headers.get('authorization'), expected)) reject(401, 'Workspace authentication failed.');
        if (discovery) {
          if (request.method !== 'GET' || url.search) reject(404, 'The workspace manifest is a GET route without parameters.');
          return jsonResponse(200, manifest, origin);
        }
        if (!allowedRoute(route.kind, request.method, path)) reject(404, 'This adapter operation is not exposed.');
        if (requests.size >= 64) reject(429, 'Too many workspace requests are active.');
        abort = new AbortController(); requests.add(abort);
        const cancel = () => abort.abort(); request.signal.addEventListener('abort', cancel, { once: true });
        let timeout = setTimeout(cancel, 30_000);
        cleanup = () => { clearTimeout(timeout); request.signal.removeEventListener('abort', cancel); requests.delete(abort); };
        if (request.signal.aborted) cancel();
        let verified = health.get(route.id);
        if (!verified || path === '/perch/health') {
          verified = await httpHealth(route, abort.signal); health.set(route.id, verified);
        }
        const directory = route.kind === 'opencode' ? verified.directory : undefined;
        if (path === '/perch/health') {
          validateQuery(route, path, url.searchParams, directory);
          return jsonResponse(200, verified, origin);
        }
        const query = validateQuery(route, path, url.searchParams, directory);
        let body;
        if (request.method === 'POST') {
          // The OpenCode driver's Stop action is a bodyless POST. Other
          // commands still require JSON, including an abort with a body.
          const contentType = request.headers.get('content-type');
          const bodylessAbort = route.kind === 'opencode' && path.endsWith('/abort') && contentType === null;
          if (!bodylessAbort && !jsonType(contentType)) reject(415, 'Send application/json for adapter commands.');
          body = await boundedBytes(request.body, MAX_REQUEST_BYTES, abort.signal, request.headers.get('content-length'));
          if (bodylessAbort) {
            if (body.byteLength) reject(415, 'Send application/json for adapter commands.');
            body = undefined;
          } else {
            try { JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); }
            catch { reject(400, 'The adapter command is not valid JSON.'); }
          }
        }
        const stream = route.kind === 'opencode' && path === '/event';
        const upstream = await upstreamRequest(route, path + query, { method: request.method, body, signal: abort.signal, stream });
        if (!upstream.ok) {
          await upstream.body?.cancel();
          if ([401, 403].includes(upstream.status)) health.delete(route.id);
          const status = upstream.status >= 400 && upstream.status <= 599 ? upstream.status : 502;
          return jsonResponse(status, { error: `The local adapter returned HTTP ${upstream.status}. A submitted action may have reached it; no request was replayed.` }, origin);
        }
        if (stream) {
          if (!upstream.body || !/^text\/event-stream(?:\s*;|$)/i.test(upstream.headers.get('content-type') ?? '')) { await upstream.body?.cancel(); reject(502, 'The local adapter did not return an event stream.'); }
          clearTimeout(timeout); instance.timeout(request, 0);
          const reader = upstream.body.getReader();
          let finished = false;
          const finish = () => {
            if (finished) return; finished = true;
            abort.abort(); cleanup(); try { reader.releaseLock(); } catch {}
          };
          const response = new Response(new ReadableStream({
            async pull(controller) {
              try {
                const { done, value } = await reader.read();
                if (finished) return;
                if (done) { controller.close(); finish(); }
                else if (value.byteLength > MAX_RESPONSE_BYTES) {
                  controller.error(new Error('The event chunk exceeds the adapter limit.'));
                  const cancelled = reader.cancel(); finish(); await cancelled.catch(() => {});
                }
                else controller.enqueue(value);
              } catch { if (!finished) { controller.error(new Error('The adapter event stream ended.')); finish(); } }
            },
            async cancel() { if (!finished) { const cancelled = reader.cancel(); finish(); await cancelled.catch(() => {}); } },
          }), { headers: responseHeaders(origin, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no' }) });
          streamed = true; return response;
        }
        if (upstream.status === 204) { await upstream.body?.cancel(); return new Response(null, { status: 204, headers: responseHeaders(origin) }); }
        const artifact = route.kind === 'durable' && /\/artifacts\//.test(path);
        if (!artifact && !jsonType(upstream.headers.get('content-type'))) { await upstream.body?.cancel(); reject(502, 'The local adapter returned an unexpected content type.'); }
        const bytes = await boundedBytes(upstream.body, artifact ? MAX_STORED_ARTIFACT_BYTES : MAX_RESPONSE_BYTES, abort.signal, upstream.headers.get('content-length'));
        const headers = responseHeaders(origin, { 'Content-Type': artifact ? 'application/octet-stream' : 'application/json', 'Content-Length': String(bytes.byteLength) });
        if (artifact) {
          headers.set('Content-Security-Policy', "sandbox; default-src 'none'");
          headers.set('Content-Disposition', 'attachment');
          const disposition = upstream.headers.get('Content-Disposition');
          if (disposition && /^attachment(?:;|$)/i.test(disposition)) headers.set('Content-Disposition', disposition);
          const etag = upstream.headers.get('ETag'); if (etag) headers.set('ETag', etag);
        }
        return new Response(bytes, { status: upstream.status, headers });
      } catch (error) {
        return jsonResponse(error instanceof GatewayError ? error.status : 502, { error: error instanceof GatewayError ? error.message
          : 'The local adapter connection failed. A submitted action may have reached it; no request was replayed.' }, origin);
      } finally { if (!streamed) { abort?.abort(); cleanup?.(); } }
    },
    websocket: {
      maxPayloadLength: MAX_CLIENT_FRAME, backpressureLimit: MAX_FRAME_BYTES * 2, closeOnBackpressureLimit: true,
      perMessageDeflate: false, idleTimeout: 120, sendPings: true,
      open(socket) {
        connections.add(socket);
        socket.data.timer = setTimeout(() => closePeer(socket, 4401, 'Workspace authentication is required.'), 5000);
      },
      message(socket, message) {
        const data = socket.data; if (data.closed) return;
        let frame;
        try {
          if (typeof message !== 'string' || Buffer.byteLength(message) > MAX_CLIENT_FRAME) throw new Error('Expected text');
          frame = parseClientFrame(JSON.parse(message));
        } catch { closePeer(socket, 4400, 'Invalid Pi bridge record.'); return; }
        if (data.stage === 'unauthenticated') {
          if (frame.type !== 'hello' || !equal(frame.token, config.token)) { closePeer(socket, 4401, 'Workspace authentication failed.'); return; }
          connectPi(socket); return;
        }
        if (frame.type === 'hello') { closePeer(socket, 4400, 'This socket is already authenticated.'); return; }
        if (data.stage !== 'ready' || data.upstream?.readyState !== WebSocket.OPEN) { send(socket, { type: 'error', id: frame.id, error: 'Wait for the local Pi bridge snapshot before sending a command.' }); return; }
        if (Date.now() - data.windowStart >= 1000) { data.commands = 0; data.windowStart = Date.now(); }
        if (++data.commands > 16) { send(socket, { type: 'error', id: frame.id, error: 'Too many commands. Wait before sending another.' }); return; }
        if (data.upstream.bufferedAmount > MAX_CLIENT_FRAME * 4) { closePeer(socket, 1013, 'The local Pi bridge is not accepting commands.'); return; }
        try { data.upstream.send(JSON.stringify(safeCommand(frame))); }
        catch { closePeer(socket); }
      },
      drain(socket) { if (!socket.data.closed) socket.data.upstream?.resume(); },
      close(socket) { closePeer(socket, 1000, 'Phone disconnected.'); },
      error(socket) { closePeer(socket); },
    },
  });
  return { server, manifest,
    async close() {
      if (closed) return; closed = true;
      for (const request of requests) request.abort();
      for (const socket of connections) closePeer(socket, 1001, 'Workspace gateway stopping.');
      await server.stop(true);
    },
  };
}
