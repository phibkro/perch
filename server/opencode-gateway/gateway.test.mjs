import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { configuration, createGateway } from './index.mjs';

const listen = async server => { server.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); return `http://127.0.0.1:${server.address().port}`; };
const close = async server => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); };
test('gateway keeps upstream secrets off the phone and restricts methods, commands and origins', async () => {
  const calls = [];
  const upstreamSecret = 'public-upstream-secret-for-tests'; const providerSecret = 'public-provider-secret-for-tests'; const phoneSecret = 'public-phone-secret-for-tests';
  const upstreamAuth = `Basic ${Buffer.from(`opencode:${upstreamSecret}`).toString('base64')}`;
  const fake = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    calls.push({ path: req.url, method: req.method, authorization: req.headers.authorization, body: chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined });
    if (req.headers.authorization !== upstreamAuth) { res.writeHead(401); res.end('{}'); return; }
    const url = new URL(req.url, 'http://upstream');
    if (url.pathname === '/event') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const events = [
        { type: 'message.part.updated', properties: { apiKey: providerSecret, part: { text: upstreamSecret } } },
        { type: 'message.part.updated', properties: { part: { id: 'part_reasoning', sessionID: 'ses_one', messageID: 'msg_one', type: 'reasoning', text: providerSecret } } },
        { type: 'message.part.delta', properties: { partID: 'part_reasoning', sessionID: 'ses_one', messageID: 'msg_one', field: 'text', delta: providerSecret } },
        { type: 'message.part.updated', properties: { part: { id: 'part_text', sessionID: 'ses_one', messageID: 'msg_one', type: 'text', text: '', time: { start: 1 }, metadata: { apiKey: providerSecret } } } },
        { type: 'message.part.delta', properties: { partID: 'part_text', sessionID: 'ses_one', messageID: 'msg_one', field: 'text', delta: 'Visible' } },
        { type: 'message.part.updated', properties: { part: { id: 'part_text', sessionID: 'ses_one', messageID: 'msg_one', type: 'text', text: 'Final', time: { start: 1, end: 2 } } } },
        { type: 'message.part.removed', properties: { sessionID: 'ses_one', messageID: 'msg_one', partID: 'part_text' } },
      ];
      events.forEach((event, index) => res.write(`data: ${JSON.stringify({ id: `event_${index}`, ...event })}\n\n`)); return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(url.pathname === '/global/health' ? { healthy: true, version: '1.18.35' } : url.pathname === '/path' ? { directory: '/fixture/workspace' } : url.pathname === '/provider' ? { all: [{ id: 'fixture', name: 'Fixture', key: providerSecret, options: { apiKey: providerSecret }, models: { one: { id: 'one', name: 'One', headers: { Authorization: providerSecret }, options: { token: providerSecret } } } }, { id: 'off', key: providerSecret, models: {} }], connected: ['fixture'], default: { fixture: 'one', off: 'hidden' } } : []));
  });
  const upstream = await listen(fake);
  const config = configuration({ OPENCODE_URL: upstream, OPENCODE_SERVER_PASSWORD: upstreamSecret, PERCH_OPENCODE_PASSWORD: phoneSecret, PERCH_OPENCODE_ORIGINS: 'https://perch.example', PERCH_OPENCODE_PORT: '0' });
  const gateway = createGateway(config); const base = await listen(gateway);
  const authorization = `Basic ${Buffer.from(`perch:${phoneSecret}`).toString('base64')}`;
  const get = path => fetch(base + path, { headers: { Authorization: authorization } });
  try {
    assert.equal((await fetch(base + '/provider')).status, 401); assert.equal(calls.length, 0);
    const health = await (await get('/perch/health')).json(); assert.equal(health.protocol, 'perch-opencode'); assert.equal(health.directory, '/fixture/workspace');
    const catalog = await (await get('/provider')).text(); assert(!catalog.includes(providerSecret)); assert(!catalog.includes(upstreamSecret));
    assert.deepEqual(JSON.parse(catalog), { all: [{ id: 'fixture', name: 'Fixture', models: { one: { id: 'one', name: 'One' } } }], connected: ['fixture'], default: { fixture: 'one' } });
    assert(calls.find(call => call.path.startsWith('/provider')).path.includes('directory=%2Ffixture%2Fworkspace'));
    const oldCalls = calls.length;
    for (const path of ['/auth/fixture', '/config', '/file/content?path=/etc/passwd', '/doc', '/session/ses_one?permission=allow']) assert.equal((await get(path)).status, 404);
    assert.equal(calls.length, oldCalls);
    assert.equal((await fetch(base + '/provider', { headers: { Authorization: authorization, Origin: 'https://evil.example' } })).status, 403);
    const goodOrigin = await fetch(base + '/provider', { headers: { Authorization: authorization, Origin: 'https://perch.example' } }); assert.equal(goodOrigin.headers.get('access-control-allow-origin'), 'https://perch.example');
    const preflight = await fetch(base + '/session', { method: 'OPTIONS', headers: { Origin: 'https://perch.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'Authorization,Content-Type' } }); assert.equal(preflight.status, 204);
    const post = (path, body) => fetch(base + path, { method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post('/permission/per_one/reply', { reply: 'always' })).status, 400);
    await post('/session/ses_one/prompt_async', { parts: [{ type: 'text', text: 'Synthetic prompt' }], system: 'MUST NOT FORWARD', tools: { bash: true }, model: { providerID: 'fixture', modelID: 'one', hidden: 'DROP' } });
    const prompt = calls.find(call => call.path.startsWith('/session/ses_one/prompt_async')); assert.deepEqual(prompt.body, { parts: [{ type: 'text', text: 'Synthetic prompt' }], model: { providerID: 'fixture', modelID: 'one' } });
    const stream = await get('/event'); const reader = stream.body.getReader(); let eventText = '';
    while (eventText.split('\n\n').length - 1 < 7) eventText += new TextDecoder().decode((await reader.read()).value);
    await reader.cancel(); const events = eventText.trim().split('\n\n').map(event => JSON.parse(event.slice(6)));
    assert(events.slice(0, 3).every(event => event.type === 'perch.invalidate'));
    assert.equal(events[4].type, 'perch.text'); assert.equal(events[4].text, 'Visible'); assert.equal(events[5].text, 'Final'); assert.equal(events[5].complete, true); assert.equal(events[6].type, 'perch.removed');
    assert(!eventText.includes(providerSecret)); assert(!eventText.includes(upstreamSecret)); assert(!eventText.includes('metadata'));
    assert(calls.every(call => call.authorization === upstreamAuth)); assert(calls.every(call => !JSON.stringify(call).includes(phoneSecret)));
    assert.throws(() => configuration({ OPENCODE_SERVER_PASSWORD: phoneSecret, PERCH_OPENCODE_PASSWORD: phoneSecret }), /different/);
  } finally { await close(gateway); await close(fake); }
});
