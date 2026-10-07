import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { assertRuntimeRunning, probeRuntimeReadiness, RuntimeExitedError } from './runtime-health.mjs';

test('app health cannot mask a celld runtime that refuses admission', async t => {
  let ready = false;
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    if (req.url === '/.well-known/celld/health') {
      res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: ready }));
    } else if (req.url === '/perch/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ service: 'perch-durable' }));
    } else res.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await assert.rejects(() => probeRuntimeReadiness(origin), /celld readiness.*503/);
  ready = true;
  assert.deepEqual(await probeRuntimeReadiness(origin), { ok: true });
  assert.deepEqual(requests, ['/.well-known/celld/health', '/.well-known/celld/health']);
});

test('a stopped runtime produces a fatal error containing its readiness diagnosis', () => {
  assert.throws(() => assertRuntimeRunning({ label: 'after-crash', exitCode: 1, signalCode: null,
    logs: () => 'Error: the readiness endpoint returned 503 Service Unavailable' }),
  error => error instanceof RuntimeExitedError && /after-crash.*code 1/.test(error.message) && /503/.test(error.message));
  assert.doesNotThrow(() => assertRuntimeRunning({ exitCode: null, signalCode: null }));
});
