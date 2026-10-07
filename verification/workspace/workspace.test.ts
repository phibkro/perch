import { describe, expect, test } from 'bun:test';
import { WorkspaceManager } from '../../src/workspace/manager';
import { connectionUrl, parseManifest, parsePairingCode, validateCredentials, type SavedWorkspace, type WorkspaceManifest } from '../../src/workspace/protocol';
import { memoryWorkspacePersistence, secureWorkspacePersistence } from '../../src/workspace/persistence';
import { discoverWorkspace } from '../../src/workspace/discovery';

const token = 'synthetic-workspace-token-'.repeat(2);
const credentials = { url: 'https://perch.example/base', token };
const manifest = (): WorkspaceManifest => ({ protocol: 'perch-workspace', version: 1,
  workspace: { id: 'home', name: 'Home workstation', deployment: 'self-hosted' }, defaultConnectionId: 'durable',
  connections: [
    { id: 'durable', name: 'Pi Durable', kind: 'durable', path: '/harness/durable' },
    { id: 'pi', name: 'Pi', kind: 'pi', path: '/harness/pi' },
    { id: 'opencode', name: 'OpenCode', kind: 'opencode', path: '/harness/opencode' },
    { id: 'omp', name: 'OMP terminal', kind: 'omp', collabLink: 'wss://relay.example/r/synthetic.public-test-key' },
  ] });
const pairing = (value: unknown) => 'perch://pair#' + Buffer.from(JSON.stringify(value)).toString('base64url');
function sessionSpy() {
  const calls: { kind: string; config?: unknown }[] = [];
  return { calls, sessions: {
    connectDurable: async (config: unknown) => { calls.push({ kind: 'durable', config }); },
    connectPi: async (config: unknown) => { calls.push({ kind: 'pi', config }); },
    connectOpenCode: async (config: unknown) => { calls.push({ kind: 'opencode', config }); },
    connectCollab: async (config: unknown) => { calls.push({ kind: 'omp', config }); },
    useDemo: () => { calls.push({ kind: 'demo' }); },
  } };
}
const saved = (id = 'local-home'): SavedWorkspace => ({ ...credentials, id, workspaceId: 'home', name: 'Home workstation', deployment: 'self-hosted', lastConnectionId: 'durable' });

describe('workspace authority', () => {
  test('one pairing capability carries only the URL and device token', () => {
    expect(parsePairingCode(pairing({ version: 1, ...credentials }))).toEqual(credentials);
    for (const value of [
      { version: 2, ...credentials }, { version: 1, ...credentials, apiKey: 'do-not-import' },
      { version: 1, ...credentials, url: 'http://192.168.1.4' }, { version: 1, ...credentials, url: 'https://user:password@host.example' },
      { version: 1, ...credentials, url: 'https://host.example?token=secret' }, { version: 1, ...credentials, url: 'file:///etc/passwd' },
      { version: 1, ...credentials, url: 'https://host.example/perch/%2e%2e/admin' }, { version: 1, ...credentials, url: 'https://host.example/perch/../admin' },
    ]) expect(() => parsePairingCode(pairing(value))).toThrow();
    expect(() => parsePairingCode('https://perch.example/#token')).toThrow();
    expect(validateCredentials({ url: 'http://127.0.0.1:9876/', token }).url).toBe('http://127.0.0.1:9876');
  });

  test('host paths cannot send the workspace token outside its origin or mount', () => {
    const value = parseManifest(manifest());
    for (const path of ['https://elsewhere.example', '//elsewhere.example', '/../private', '/a/../../private', '/%2e%2e/private', '/a?token=x', '/a#b', '/a\\b', '/a//b']) {
      const bad = manifest(); bad.connections[0] = { id: 'durable', name: 'Pi', kind: 'durable', path };
      expect(() => parseManifest(bad)).toThrow();
    }
    const pi = value.connections.find(item => item.kind === 'pi')!;
    if (pi.kind === 'omp') throw new Error('fixture');
    expect(connectionUrl(credentials, pi)).toBe('wss://perch.example/base/harness/pi');
    const duplicate = manifest(); duplicate.connections.push(duplicate.connections[0]);
    expect(() => parseManifest(duplicate)).toThrow();
    expect(() => parseManifest({ ...manifest(), providerToken: 'secret' })).toThrow();
  });

  test('discovery authenticates once, bounds streaming bytes, and withholds error bodies', async () => {
    const original = globalThis.fetch; const calls: { url: string; init?: RequestInit }[] = [];
    let mode = 'ok';
    globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      if (mode === 'error') return new Response('secret-upstream-diagnostic', { status: 401 });
      if (mode === 'large') return new Response(new Uint8Array(32769));
      return Response.json(manifest());
    }, { preconnect: original.preconnect });
    try {
      expect((await discoverWorkspace(credentials, new AbortController().signal)).workspace.id).toBe('home');
      expect(calls[0].url).toBe(credentials.url + '/perch/workspace');
      expect(calls[0].init?.redirect).toBe('error');
      expect(calls[0].init?.headers).toEqual({ Authorization: `Bearer ${token}`, Accept: 'application/json' });
      mode = 'error'; await expect(discoverWorkspace(credentials, new AbortController().signal)).rejects.toThrow('rejected the workspace token');
      mode = 'large'; await expect(discoverWorkspace(credentials, new AbortController().signal)).rejects.toThrow('too large');
    } finally { globalThis.fetch = original; }
  });
});

describe('one saved workspace, several harnesses', () => {
  test('pair once, switch harnesses, reopen from persisted access without a prompt replay', async () => {
    const spy = sessionSpy(); const persistence = memoryWorkspacePersistence(); let discoveries = 0;
    const manager = new WorkspaceManager({ ...spy, persistence, newId: () => 'local-home', discover: async () => { discoveries++; return manifest(); } });
    await manager.join(credentials, 'self-hosted');
    await manager.chooseConnection('pi'); await manager.chooseConnection('opencode'); await manager.chooseConnection('omp');
    expect(spy.calls).toEqual([
      { kind: 'durable', config: { url: credentials.url + '/harness/durable', token } },
      { kind: 'pi', config: { url: 'wss://perch.example/base/harness/pi', token } },
      { kind: 'opencode', config: { url: credentials.url + '/harness/opencode', username: 'perch', password: token } },
      { kind: 'omp', config: manifest().connections[3].kind === 'omp' ? 'wss://relay.example/r/synthetic.public-test-key' : '' },
    ]);
    expect(discoveries).toBe(1);
    expect(JSON.stringify(manager.getSnapshot())).not.toContain(token);
    expect(JSON.stringify(manager.getSnapshot())).not.toContain('synthetic.public-test-key');
    const restored = new WorkspaceManager({ ...spy, persistence, discover: async () => { discoveries++; return manifest(); } });
    await restored.initialize(); expect(restored.getSnapshot().profiles.length).toBe(1); expect(discoveries).toBe(1);
    await restored.open('local-home'); expect(discoveries).toBe(2); expect(spy.calls.at(-1)?.kind).toBe('omp');
    await restored.forget('local-home'); expect(await persistence.load()).toEqual([]); expect(spy.calls.at(-1)?.kind).toBe('demo');
  });

  test('a late discovery cannot replace a newer workspace selection', async () => {
    const spy = sessionSpy(); let finishFirst!: (value: WorkspaceManifest) => void;
    const manager = new WorkspaceManager({ ...spy, persistence: memoryWorkspacePersistence(), discover: async config => config.url.includes('first') ? new Promise(resolve => { finishFirst = resolve; }) : { ...manifest(), workspace: { id: 'second', name: 'Second', deployment: 'cloudflare' } } });
    const first = manager.join({ url: 'https://first.example', token });
    await new Promise(resolve => setTimeout(resolve, 0));
    await manager.join({ url: 'https://second.example', token });
    finishFirst(manifest()); await first;
    expect(manager.getSnapshot().active?.workspaceId).toBe('second'); expect(spy.calls.length).toBe(1);
  });

  test('refresh refuses a different workspace identity and missing harness falls back to its declared default', async () => {
    const spy = sessionSpy(); const persistence = memoryWorkspacePersistence(); await persistence.put({ ...saved(), lastConnectionId: 'removed' });
    let value = manifest(); const manager = new WorkspaceManager({ ...spy, persistence, discover: async () => value });
    await manager.open('local-home'); expect(spy.calls[0].kind).toBe('durable');
    value = { ...manifest(), workspace: { ...manifest().workspace, id: 'replacement' } };
    await expect(manager.open('local-home')).rejects.toThrow('different workspace'); expect(spy.calls.length).toBe(1);
  });

  test('opening during Forget cannot recreate a removed device token', async () => {
    const data = new Map<string, string>(); let holdRemoval = false; let release!: () => void;
    const persistence = secureWorkspacePersistence({ get: async key => data.get(key) ?? null,
      set: async (key, value) => { data.set(key, value); },
      remove: async key => { if (holdRemoval) await new Promise<void>(resolve => { release = resolve; }); data.delete(key); } });
    const spy = sessionSpy(); const manager = new WorkspaceManager({ ...spy, persistence, newId: () => 'local-home', discover: async () => manifest() });
    await manager.join(credentials); holdRemoval = true;
    const removing = manager.forget('local-home'); await new Promise(resolve => setTimeout(resolve, 0));
    await expect(manager.open('local-home')).rejects.toThrow('removal');
    await expect(manager.join(credentials)).rejects.toThrow('removal');
    await manager.chooseConnection('pi'); expect(spy.calls.length).toBe(1);
    release(); await removing;
    expect(await persistence.load()).toEqual([]); expect(manager.getSnapshot().profiles).toEqual([]);
    expect(spy.calls.map(item => item.kind)).toEqual(['durable', 'demo']);
  });
});

describe('device credential storage', () => {
  test('encrypted storage adapter round trips separate entries and removes the token first', async () => {
    const data = new Map<string, string>(); const removed: string[] = [];
    const persistence = secureWorkspacePersistence({ get: async key => data.get(key) ?? null, set: async (key, value) => { data.set(key, value); }, remove: async key => { removed.push(key); data.delete(key); } });
    await Promise.all([persistence.put(saved('a')), persistence.put(saved('b'))]);
    expect((await persistence.load()).map(item => item.id)).toEqual(['a', 'b']);
    await persistence.remove('a'); expect((await persistence.load()).map(item => item.id)).toEqual(['b']);
    expect(removed[0]).toBe('perch.workspaces.v1.a');
    expect(data.get('perch.workspaces.v1.index')).not.toContain(token);
  });

  test('a failed index write cleans the new token up, and a failed token deletion is reported', async () => {
    const data = new Map<string, string>(); let failIndex = true; let failDelete = false;
    const persistence = secureWorkspacePersistence({ get: async key => data.get(key) ?? null,
      set: async (key, value) => { if (failIndex && key.endsWith('.index')) throw new Error('synthetic disk failure'); data.set(key, value); },
      remove: async key => { if (failDelete) throw new Error('synthetic deletion failure'); data.delete(key); },
    });
    await expect(persistence.put(saved())).rejects.toThrow('disk failure'); expect(data.size).toBe(0);
    failIndex = false; await persistence.put(saved()); failDelete = true;
    await expect(persistence.remove('local-home')).rejects.toThrow('deletion failure'); expect((await persistence.load()).length).toBe(1);
  });

  test('an interrupted index update after forgetting does not consume a saved-workspace slot', async () => {
    const data = new Map<string, string>(); let failIndex = false;
    const persistence = secureWorkspacePersistence({ get: async key => data.get(key) ?? null,
      set: async (key, value) => { if (failIndex && key.endsWith('.index')) throw new Error('synthetic interrupted index'); data.set(key, value); }, remove: async key => { data.delete(key); } });
    for (let index = 0; index < 8; index++) await persistence.put(saved(`w${index}`));
    failIndex = true; await expect(persistence.remove('w0')).rejects.toThrow('interrupted index');
    failIndex = false; expect((await persistence.load()).length).toBe(7);
    await persistence.put(saved('replacement')); expect((await persistence.load()).length).toBe(8);
    expect((await persistence.load()).some(item => item.id === 'w0')).toBe(false);
  });
});
