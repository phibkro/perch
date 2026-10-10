import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { SessionStore } from '../../src/session/store';
import { remoteFixture } from './fixture';

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Artifact fixture did not settle.'); await new Promise(resolve => setTimeout(resolve, 10)); }
}

test('remote artifacts reuse the native reader with exact UTF-8 bytes, hashes, and generation fencing', async () => {
  const host = await remoteFixture(), store = new SessionStore();
  const content = '\ufeff# Host Markdown\r\n\r\nUnicode 🦜\r\n';
  const bytes = new TextEncoder().encode(content);
  const manifest = { id: 'saved_file', sessionId: 'session_one', title: 'Report', filename: 'report.md', mimeType: 'text/markdown', language: 'markdown', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), sourceId: 'tool:write_one', createdAt: 1 };
  host.snapshots.get('session_one')!.storedArtifacts = [manifest]; host.artifacts.set(manifest.id, bytes);
  const path = `/perch/sessions/session_one/artifacts/${manifest.id}`;
  const ready = () => store.getSnapshot().connection.status === 'live' && !store.getSnapshot().sessionAction;
  try {
    await store.connectRemote(host); await until(ready); store.selectSession('session_one');
    await until(() => !!store.getSnapshot().remote?.attached && ready());
    expect(await store.loadArtifact(store.getSnapshot().storedArtifacts[0])).toBe(content);
    expect(host.requests.filter(row => row.method === 'POST')).toHaveLength(0);
    await expect(store.loadArtifact({ ...manifest, sha256: '0'.repeat(64) })).rejects.toThrow('no longer');
    host.artifacts.set(manifest.id, new TextEncoder().encode('Wrong revision'));
    await expect(store.loadArtifact(manifest)).rejects.toThrow('integrity');
    host.artifacts.set(manifest.id, bytes);
    host.overrides.set(path, { status: 302, headers: { Location: `${host.url}/redirect-target` } });
    await expect(store.loadArtifact(manifest)).rejects.toThrow();
    expect(host.requests.some(row => row.path === '/redirect-target')).toBe(false);
    host.overrides.delete(path);
    const gate = host.hold(path), loading = store.loadArtifact(manifest);
    const outcome = loading.then(() => 'Unexpected success', (error: Error) => error.message);
    await until(() => gate.started);
    store.detachSession(); gate.release(); expect(await outcome).toContain('selected session changed');
    expect(store.getSnapshot().storedArtifacts).toEqual([]);
    expect(host.requests.every(row => row.authorized)).toBe(true);
  } finally { store.dispose(); await host.close(); }
});
