import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const MAX_BYTES = 12 * 1024 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
export function configuration(env = process.env) {
  const upstream = new URL(env.OPENCODE_URL || 'http://127.0.0.1:4096');
  if (!['http:', 'https:'].includes(upstream.protocol) || upstream.username || upstream.password || upstream.search || upstream.hash) throw new Error('OPENCODE_URL must be an HTTP(S) server URL without credentials, query, or fragment.');
  if (upstream.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(upstream.hostname)) throw new Error('Use HTTPS for a remote OpenCode upstream.');
  const username = env.PERCH_OPENCODE_USERNAME || 'perch';
  const password = env.PERCH_OPENCODE_PASSWORD || '';
  const upstreamUsername = env.OPENCODE_SERVER_USERNAME || 'opencode';
  const upstreamPassword = env.OPENCODE_SERVER_PASSWORD || '';
  if (password.length < 24 || password.length > 4096 || /[\x00-\x1f\x7f]/.test(password)) throw new Error('Set PERCH_OPENCODE_PASSWORD to a new secret of 24–4096 characters.');
  if (!upstreamPassword || upstreamPassword === password) throw new Error('Set OPENCODE_SERVER_PASSWORD to the upstream password; use a different PERCH_OPENCODE_PASSWORD for the phone.');
  if ([username, upstreamUsername].some(value => /[:\x00-\x1f\x7f]/.test(value))) throw new Error('Server usernames cannot contain colons or control characters.');
  const origins = new Set((env.PERCH_OPENCODE_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean).map(value => {
    const url = new URL(value);
    if (url.origin !== value || !['http:', 'https:'].includes(url.protocol)) throw new Error('PERCH_OPENCODE_ORIGINS must contain exact HTTP(S) origins.');
    return value;
  }));
  const port = Number(env.PERCH_OPENCODE_PORT || 4097);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid PERCH_OPENCODE_PORT.');
  return { upstream: upstream.toString().replace(/\/$/, ''), username, password, upstreamUsername, upstreamPassword, origins, host: env.PERCH_OPENCODE_HOST || '127.0.0.1', port };
}
function equal(a, b) {
  const left = Buffer.from(a); const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
function catalog(value) {
  if (!object(value) || !Array.isArray(value.all) || !Array.isArray(value.connected)) throw new Error('Invalid provider catalog.');
  const connected = new Set(value.connected.filter(id => typeof id === 'string'));
  const all = value.all.filter(provider => object(provider) && typeof provider.id === 'string' && connected.has(provider.id)).map(provider => ({
    id: provider.id, name: typeof provider.name === 'string' ? provider.name : provider.id,
    models: Object.fromEntries(Object.entries(object(provider.models) || {}).flatMap(([key, model]) => object(model) ? [[key, { id: typeof model.id === 'string' ? model.id : key, name: typeof model.name === 'string' ? model.name : key }]] : [])),
  }));
  const defaults = object(value.default) || {};
  return { all, connected: all.map(provider => provider.id), default: Object.fromEntries(all.flatMap(provider => typeof defaults[provider.id] === 'string' ? [[provider.id, defaults[provider.id]]] : [])) };
}
async function readBody(stream) {
  let size = 0; const chunks = [];
  for await (const chunk of stream) {
    size += chunk.byteLength;
    if (size > MAX_BYTES) throw new Error('Response or request exceeds the 12 MiB limit.');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}
function route(method, path) {
  if (method === 'GET' && ['/perch/health', '/provider', '/event', '/session', '/session/status', '/permission', '/question'].includes(path)) return true;
  if (method === 'GET' && /^\/session\/[A-Za-z0-9_-]+\/message$/.test(path)) return true;
  if (method === 'POST' && (path === '/session' || /^\/session\/[A-Za-z0-9_-]+\/(prompt_async|abort)$/.test(path) || /^\/(permission|question)\/[A-Za-z0-9_-]+\/reply$/.test(path))) return true;
  return false;
}
function command(path, body) {
  const input = object(body);
  if (path.endsWith('/abort')) return undefined;
  if (!input) throw new Error('A JSON command is required.');
  if (path === '/session') return typeof input.title === 'string' ? { title: input.title } : {};
  if (path.endsWith('/prompt_async')) {
    if (!Array.isArray(input.parts) || input.parts.length !== 1 || input.parts[0]?.type !== 'text' || typeof input.parts[0].text !== 'string' || !input.parts[0].text.trim()) throw new Error('Only a text prompt is supported.');
    const model = object(input.model);
    if (model && (typeof model.providerID !== 'string' || typeof model.modelID !== 'string')) throw new Error('Invalid model selection.');
    return { parts: [{ type: 'text', text: input.parts[0].text }], ...(model ? { model: { providerID: model.providerID, modelID: model.modelID } } : {}) };
  }
  if (path.startsWith('/permission/')) {
    if (!['once', 'reject'].includes(input.reply)) throw new Error('Only Allow once and Deny are supported.');
    return { reply: input.reply };
  }
  if (!Array.isArray(input.answers) || input.answers.length !== 1 || !Array.isArray(input.answers[0]) || input.answers[0].length !== 1 || typeof input.answers[0][0] !== 'string') throw new Error('Only a single question answer is supported.');
  return { answers: [[input.answers[0][0]]] };
}
/** The server object is inert until listen() is called. No deployment is implied. */
export function createGateway(config) {
  const expected = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`;
  const upstreamAuthorization = `Basic ${Buffer.from(`${config.upstreamUsername}:${config.upstreamPassword}`).toString('base64')}`;
  const connections = new Set();
  let workspace;
  async function upstream(path, { method = 'GET', body, signal } = {}) {
    return fetch(config.upstream + path, { method, headers: { Authorization: upstreamAuthorization, Accept: path.startsWith('/event') ? 'text/event-stream' : 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal, credentials: 'omit' });
  }
  async function defaultDirectory(signal) {
    if (workspace) return workspace;
    const response = await upstream('/path', { signal });
    if (!response.ok) throw new Error('OpenCode workspace lookup failed.');
    const value = JSON.parse(await readBody(response.body));
    if (typeof value.directory !== 'string') throw new Error('OpenCode returned an invalid workspace.');
    workspace = value.directory; return workspace;
  }
  const server = http.createServer(async (req, res) => {
    const abort = new AbortController(); connections.add(abort);
    let timeout = setTimeout(() => abort.abort(), 30_000);
    res.on('close', () => { abort.abort(); clearTimeout(timeout); connections.delete(abort); });
    const json = (status, body) => { if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(body)); };
    try {
      const origin = req.headers.origin;
      if (origin && !config.origins.has(origin)) { json(403, { error: 'This browser origin is not allowed.' }); return; }
      if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
      if (req.method === 'OPTIONS') {
        const allowedHeaders = new Set(['authorization', 'content-type']);
        if (!origin || !['GET', 'POST'].includes(req.headers['access-control-request-method']) || String(req.headers['access-control-request-headers'] || '').split(',').some(header => header.trim() && !allowedHeaders.has(header.trim().toLowerCase()))) { json(403, { error: 'This preflight is not allowed.' }); return; }
        res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '600' }); res.end(); return;
      }
      if (!equal(String(req.headers.authorization || ''), expected)) { json(401, { error: 'Gateway authentication failed.' }); return; }
      const url = new URL(req.url || '/', 'http://gateway.invalid');
      if (!route(req.method, url.pathname)) { json(404, { error: 'This operation is not exposed by the Perch gateway.' }); return; }
      const allowedQuery = new Set(['directory', ...(url.pathname === '/session' ? ['roots', 'limit'] : [])]);
      if ([...url.searchParams.keys()].some(key => !allowedQuery.has(key))) { json(400, { error: 'Unsupported query parameter.' }); return; }
      if (url.pathname === '/perch/health') {
        const response = await upstream('/global/health', { signal: abort.signal });
        if (!response.ok) { json(502, { error: 'Could not authenticate with the OpenCode upstream.' }); return; }
        const value = JSON.parse(await readBody(response.body));
        if (value.healthy !== true || typeof value.version !== 'string') throw new Error('Invalid OpenCode health response.');
        const directory = await defaultDirectory(abort.signal);
        json(200, { protocol: 'perch-opencode', version: 1, healthy: true, upstreamVersion: value.version, directory }); return;
      }
      if (!url.searchParams.has('directory')) url.searchParams.set('directory', await defaultDirectory(abort.signal));
      let body;
      if (req.method === 'POST') {
        try { const text = await readBody(req); body = command(url.pathname, text ? JSON.parse(text) : {}); }
        catch { json(400, { error: 'Invalid or oversized Perch command.' }); return; }
      }
      const response = await upstream(url.pathname + url.search, { method: req.method, body, signal: abort.signal });
      if (!response.ok) { await response.body?.cancel(); json(response.status, { error: `OpenCode returned HTTP ${response.status}. Inspect the host before retrying.` }); return; }
      if (url.pathname === '/event') {
        if (!response.headers.get('content-type')?.includes('text/event-stream') || !response.body) throw new Error('Invalid OpenCode event stream.');
        clearTimeout(timeout);
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' });
        const decoder = new TextDecoder(); let buffer = ''; const textParts = new Set();
        for await (const chunk of response.body) {
          if (res.destroyed) break;
          buffer = (buffer + decoder.decode(chunk, { stream: true })).replace(/\r\n/g, '\n');
          if (buffer.length > MAX_BYTES) throw new Error('OpenCode event exceeds the gateway limit.');
          let end;
          while ((end = buffer.indexOf('\n\n')) !== -1) {
            const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
            if (!data) continue;
            const original = object(JSON.parse(data));
            if (typeof original?.type !== 'string') throw new Error('Invalid OpenCode event.');
            const properties = object(original.properties); const part = object(properties?.part);
            let textEvent;
            if (original.type === 'message.part.updated' && typeof part?.id === 'string') {
              textParts.delete(part.id);
              if (part.type === 'text' && !part.ignored && typeof part.sessionID === 'string' && typeof part.messageID === 'string' && typeof part.text === 'string') {
                const complete = typeof object(part.time)?.end === 'number';
                textEvent = { type: 'perch.text', operation: 'replace', sessionID: part.sessionID, messageID: part.messageID, partID: part.id, text: part.text, complete };
                if (!complete) textParts.add(part.id);
              }
            }
            if (original.type === 'message.part.delta' && properties?.field === 'text' && typeof properties.sessionID === 'string' && typeof properties.messageID === 'string' && typeof properties.partID === 'string' && textParts.has(properties.partID) && typeof properties.delta === 'string') textEvent = { type: 'perch.text', operation: 'append', sessionID: properties.sessionID, messageID: properties.messageID, partID: properties.partID, text: properties.delta };
            let removal;
            if (['message.part.removed', 'message.removed'].includes(original.type) && typeof properties?.sessionID === 'string' && typeof properties.messageID === 'string') {
              removal = { type: 'perch.removed', sessionID: properties.sessionID, messageID: properties.messageID, ...(typeof properties.partID === 'string' ? { partID: properties.partID } : {}) };
              if (typeof properties.partID === 'string') textParts.delete(properties.partID);
            }
            if (textParts.size > 1000) throw new Error('Too many active text parts.');
            if (textEvent && typeof original.id === 'string') textEvent.id = original.id;
            // Perch reads authoritative snapshots. No raw tool inputs, provider options,
            // error payloads, or future secret-bearing event fields cross this stream.
            const type = /^(message|session|permission|question)\./.test(original.type) ? 'perch.invalidate' : ['server.connected', 'server.heartbeat', 'server.instance.disposed', 'models-dev.refreshed'].includes(original.type) ? original.type : undefined;
            if (!type) continue;
            // Large full parts arrive through the bounded snapshot route instead.
            const safeEvent = removal || (textEvent && textEvent.text.length <= 200_000 ? textEvent : { type });
            if (!res.write(`data: ${JSON.stringify(safeEvent)}\n\n`)) await new Promise(resolve => {
              const done = () => { res.removeListener('drain', done); res.removeListener('close', done); resolve(); };
              res.once('drain', done); res.once('close', done);
            });
          }
        }
        res.end(); return;
      }
      if (response.status === 204) { res.writeHead(204); res.end(); return; }
      const value = JSON.parse(await readBody(response.body));
      json(200, url.pathname === '/provider' ? catalog(value) : value);
    } catch {
      if (res.destroyed) return;
      if (res.headersSent) res.destroy(); else json(502, { error: 'The OpenCode connection failed. A submitted action may still have reached the host; no request was replayed.' });
    } finally { clearTimeout(timeout); }
  });
  server.on('close', () => { for (const abort of connections) abort.abort(); connections.clear(); });
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = configuration(); const server = createGateway(config);
    server.listen(config.port, config.host, () => process.stdout.write(`Perch OpenCode gateway listening on ${config.host}:${server.address().port}\n`));
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.closeAllConnections(); server.close(() => process.exit(0)); });
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
