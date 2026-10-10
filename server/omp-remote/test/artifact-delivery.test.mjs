import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { parseRemoteSnapshot } from '../../../src/harness/remote.ts';
import { fixture } from './helpers.mjs';

const cleanup = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function setup(source = 'builtin') {
  const cwd = await mkdtemp(join(tmpdir(), 'perch-file-delivery-'));
  cleanup.push(() => rm(cwd, { recursive: true, force: true }));
  const handle = await fixture({ state: { cwd } }); cleanup.push(handle.close);
  handle.api.getAllTools = () => [{ name: 'write', description: 'Write a file', sourceInfo: { source } }];
  handle.api.getActiveTools = () => ['write'];
  return { ...handle, cwd,
    start: id => handle.bridge.observe({ type: 'tool_execution_start', toolName: 'write', toolCallId: id, args: { path: 'report.md', content: 'Original tool argument' } }, handle.context),
    end: (id, isError = false) => handle.bridge.observe({ type: 'tool_execution_end', toolName: 'write', toolCallId: id, result: { content: [{ type: 'text', text: 'Written.' }] }, isError }, handle.context),
  };
}

test('successful built-in writes deliver actual captured bytes once, protected by auth and session scope', async () => {
  const f = await setup(), bytes = Buffer.from('\ufeff# Actual host file\r\n\r\nUnicode 🦜\r\n');
  await writeFile(join(f.cwd, 'report.md'), bytes);
  await f.start('written_file'); await f.end('written_file');
  const snapshot = parseRemoteSnapshot(f.bridge.snapshot()), [manifest] = snapshot.storedArtifacts;
  expect(manifest.bytes).toBe(bytes.length);
  expect(manifest.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  expect(snapshot.tools.find(tool => tool.id === 'written_file').artifact).toBeUndefined();
  const path = `/perch/sessions/omp_test/artifacts/${manifest.id}`;
  expect((await f.request(path, { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401);
  expect((await f.request(path, { headers: { Origin: 'https://untrusted.example' } })).status).toBe(403);
  const response = await f.request(path);
  expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  expect(response.headers.get('content-type')).toBe('application/octet-stream');
  expect(response.headers.get('content-disposition')).toBe('attachment; filename="report.md"');
  expect(response.headers.get('etag')).toBe(`"${manifest.sha256}"`);
  expect(response.headers.get('cache-control')).toBe('no-store');
  await writeFile(join(f.cwd, 'report.md'), 'Changed later');
  await f.end('written_file');
  expect(Buffer.from(await (await f.request(path)).arrayBuffer())).toEqual(bytes);
  expect(f.bridge.snapshot().storedArtifacts).toHaveLength(1);
  await f.bridge.observe({ type: 'session_branch' }, f.context);
  expect(f.bridge.snapshot().storedArtifacts).toEqual([]);
  expect((await f.request(path)).status).toBe(404);
});

test('failed writes, missing start events, extension-name collisions and replaced sessions do not capture files', async () => {
  const f = await setup(); await writeFile(join(f.cwd, 'report.md'), 'Existing private file');
  await f.start('failed'); await f.end('failed', true);
  await f.end('no_start');
  await f.start('old_scope');
  f.state.sessionId = 'replacement_conversation';
  await f.bridge.observe({ type: 'session_switch' }, f.context); await f.end('old_scope');
  expect(f.bridge.snapshot().storedArtifacts).toEqual([]);
  const other = await setup('extension'); await writeFile(join(other.cwd, 'report.md'), 'Not a stock write');
  await other.start('collision'); await other.end('collision');
  expect(other.bridge.snapshot().storedArtifacts).toEqual([]);
  expect((await f.request('/perch/sessions/omp_test/files/report.md')).status).toBe(404);
  expect((await f.request('/perch/sessions/omp_test/artifacts/unknown?path=report.md')).status).toBe(400);
});
