import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createTernRemoteServer } from '../bridge.mjs';
import { setupTernRemote, readPrivateConfig } from '../setup.mjs';
import { parseRemoteCatalog, parseRemoteHealth, parseRemoteReceipt, parseRemoteSnapshot } from '../../../src/harness/remote.ts';
import { agent, detail, DEVICE_TOKEN, PLUGIN_TOKEN, exchange, listen, register, requestJSON } from './helpers.mjs';

const cleanup = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture(options = {}) {
  let clock = 1_000;
  const server = createTernRemoteServer({ token: DEVICE_TOKEN, pluginToken: PLUGIN_TOKEN,
    now: () => clock, snapshotWaitMs: 80, exchangeDelayMs: 0, ...options });
  const origin = await listen(server);
  cleanup.push(() => new Promise(resolve => server.close(resolve)));
  const bridgeId = await register(origin);
  await exchange(origin, bridgeId, 1);
  const health = parseRemoteHealth((await requestJSON(origin, '/perch/health')).value);
  const catalog = parseRemoteCatalog((await requestJSON(origin, '/perch/sessions')).value);
  const session = catalog.sessions[0];
  const commands = `/perch/sessions/${session.id}/commands`;
  const command = (id, extra = {}) => requestJSON(origin, commands, { method: 'POST',
    value: { id, epoch: health.epoch, generation: session.generation, type: 'prompt', text: 'One remote question', ...extra } });
  const receipt = id => requestJSON(origin, `/perch/sessions/${session.id}/operations/${id}`);
  return { origin, bridgeId, health, session, command, receipt, advance: ms => { clock += ms; } };
}

describe('Tern remote HTTP boundary', () => {
  test('publishes actual-shaped snapshots accepted by the native protocol', async () => {
    const f = await fixture();
    const snapshot = parseRemoteSnapshot((await requestJSON(f.origin, `/perch/sessions/${f.session.id}`)).value);
    expect(snapshot.session.generation).toBe(f.session.generation);
    expect(snapshot.session.conversationId).toBeUndefined();
    expect(snapshot.messages[0].createdAt).toBe(0);
    expect(snapshot.messages[1].text).toContain('Existing artifact');
    expect(snapshot.tools[0].status).toBe('done');
    expect(snapshot.availableModels).toEqual([]);
    expect(snapshot.capabilities).toEqual({ prompt: true, interrupt: true, modelSelection: false });
    const response = await exchange(f.origin, f.bridgeId, 2);
    expect(response.value.inspectPane).toBe(2);
    expect(response.value.commands).toEqual([]);
  });

  test('requires distinct credentials and rejects raw terminal commands', async () => {
    const f = await fixture();
    expect((await requestJSON(f.origin, '/perch/sessions', { token: PLUGIN_TOKEN })).status).toBe(401);
    expect((await requestJSON(f.origin, '/tern/register', { method: 'POST', value: {} })).status).toBe(401);
    expect((await requestJSON(f.origin, '/perch/sessions?token=bad')).status).toBe(400);
    expect((await f.command('raw-command', { type: 'raw-keys', text: 'rm -rf /' })).status).toBe(400);
    expect((await f.command('extra-field', { rawKeys: '\u0003' })).status).toBe(400);
    expect((await requestJSON(f.origin, '/perch/ctl')).status).toBe(404);
    expect((await requestJSON(f.origin, '/perch/sessions', { method: 'DELETE' })).status).toBe(404);
  });

  test('rejects browser origins even when either local credential is valid', async () => {
    const f = await fixture();
    for (const origin of ['https://untrusted.example', 'http://localhost:5173', 'null']) {
      expect((await requestJSON(f.origin, '/perch/health', { headers: { Origin: origin } })).status).toBe(403);
      expect((await requestJSON(f.origin, '/tern/register', { method: 'POST', token: PLUGIN_TOKEN,
        value: { protocol: 'perch-tern-plugin', version: 1 }, headers: { Origin: origin } })).status).toBe(403);
    }
    expect((await requestJSON(f.origin, '/perch/health')).status).toBe(200);
    expect(parseRemoteCatalog((await requestJSON(f.origin, '/perch/sessions')).value).sessions).toHaveLength(1);
  });

  test('forwards once, settles the receipt, and never sends again on reconnect', async () => {
    const f = await fixture();
    const admitted = await f.command('prompt-once');
    expect(admitted.status).toBe(202);
    expect(parseRemoteReceipt(admitted.value).status).toBe('pending');
    const dispatched = await exchange(f.origin, f.bridgeId, 2);
    expect(dispatched.value.commands.map(c => c.id)).toEqual(['prompt-once']);
    expect((await exchange(f.origin, f.bridgeId, 3)).value.commands).toEqual([]);
    expect((await f.command('prompt-once')).value.status).toBe('pending');
    await exchange(f.origin, f.bridgeId, 4, { receipts: [{ id: 'prompt-once', status: 'forwarded' }] });
    expect(parseRemoteReceipt((await f.receipt('prompt-once')).value).status).toBe('forwarded');
    await requestJSON(f.origin, '/perch/health');
    await requestJSON(f.origin, `/perch/sessions/${f.session.id}`);
    expect((await exchange(f.origin, f.bridgeId, 5)).value.commands).toEqual([]);
    expect((await f.command('prompt-once', { text: 'different input' })).status).toBe(409);
  });

  test('lost plugin reply becomes unknown and is not redelivered', async () => {
    const f = await fixture();
    await f.command('ambiguous');
    await exchange(f.origin, f.bridgeId, 2);
    f.advance(5_001);
    expect((await f.receipt('ambiguous')).value.status).toBe('unknown');
    expect((await f.command('ambiguous')).value.status).toBe('unknown');
    expect((await exchange(f.origin, f.bridgeId, 3)).value.commands).toEqual([]);
    const newBridge = await register(f.origin);
    expect((await exchange(f.origin, newBridge, 1)).value.commands).toEqual([]);
    expect((await exchange(f.origin, f.bridgeId, 3)).status).toBe(409);
  });

  test('an API invocation failure stays unknown and never replays or fabricates a receipt', async () => {
    const f = await fixture();
    await f.command('api-failure');
    await exchange(f.origin, f.bridgeId, 2);
    const result = await exchange(f.origin, f.bridgeId, 3, { receipts: [{ id: 'api-failure', status: 'unknown' }] });
    expect(result.status).toBe(200);
    expect(result.value.commands).toEqual([]);
    const receipt = parseRemoteReceipt((await f.receipt('api-failure')).value);
    expect(receipt.status).toBe('unknown');
    expect(receipt.generation).toBe(f.session.generation);
    expect(receipt.message).toContain('Inspect the host');
    expect((await f.command('api-failure')).value.status).toBe('unknown');
    expect((await exchange(f.origin, f.bridgeId, 4)).value.commands).toEqual([]);
    expect((await f.receipt('missing-operation')).status).toBe(404);
    f.advance(10_001);
    expect((await f.receipt('missing-operation')).status).toBe(404);
    expect((await f.receipt('api-failure')).value.generation).toBe(f.session.generation);
  });

  test('undelivered requests expire safely and stale identities are rejected', async () => {
    const f = await fixture();
    expect((await f.command('stale-epoch', { epoch: 'old-host' })).value.status).toBe('rejected');
    expect((await f.command('stale-pane', { generation: 'old-pane' })).value.status).toBe('rejected');
    expect((await f.command('wrong-conversation', { conversationId: 'unsupported' })).status).toBe(400);
    await f.command('never-delivered');
    f.advance(5_001);
    expect((await f.receipt('never-delivered')).value.status).toBe('rejected');
    expect((await exchange(f.origin, f.bridgeId, 2)).value.commands).toEqual([]);
    f.advance(10_001);
    expect(parseRemoteCatalog((await requestJSON(f.origin, '/perch/sessions')).value).sessions).toEqual([]);
    expect((await exchange(f.origin, f.bridgeId, 3)).status).toBe(409);
  });

  test('rejects commands after pane replacement and never relabels its cached transcript', async () => {
    const f = await fixture();
    await f.command('replacement');
    const result = await exchange(f.origin, f.bridgeId, 2, {
      agents: [{ ...agent, generation: '2' }], detail: undefined,
    });
    expect(result.value.commands).toEqual([]);
    expect((await f.receipt('replacement')).value.status).toBe('rejected');
    expect((await requestJSON(f.origin, `/perch/sessions/${f.session.id}`)).status).toBe(503);
    await exchange(f.origin, f.bridgeId, 3, { agents: [{ ...agent, generation: '2' }], detail: { ...detail, generation: '2' } });
    const current = parseRemoteSnapshot((await requestJSON(f.origin, `/perch/sessions/${f.session.id}`)).value);
    expect(current.session.generation).not.toBe(f.session.generation);
  });

  test('interleaved windows retain separate identities and cannot take each other’s commands or receipts', async () => {
    const f = await fixture();
    const second = await register(f.origin);
    await exchange(f.origin, second, 1);
    const catalog = parseRemoteCatalog((await requestJSON(f.origin, '/perch/sessions')).value);
    expect(catalog.sessions).toHaveLength(2);
    expect(catalog.sessions[0].id).not.toBe(catalog.sessions[1].id);
    expect(catalog.sessions[0].runtimeId).not.toBe(catalog.sessions[1].runtimeId);
    await f.command('original-window');
    expect((await exchange(f.origin, second, 2)).value.commands).toEqual([]);
    expect((await exchange(f.origin, f.bridgeId, 2)).value.commands[0].id).toBe('original-window');
    await exchange(f.origin, second, 3, { receipts: [{ id: 'original-window', status: 'forwarded' }] });
    expect((await f.receipt('original-window')).value.status).toBe('pending');
    await exchange(f.origin, f.bridgeId, 3, { receipts: [{ id: 'original-window', status: 'forwarded' }] });
    expect((await f.receipt('original-window')).value.status).toBe('forwarded');
    expect(parseRemoteCatalog((await requestJSON(f.origin, '/perch/sessions')).value).sessions[0].id).toBe(f.session.id);
  });

  test('read-only and readiness capabilities guard every command', async () => {
    const f = await fixture({ readOnly: true });
    const snapshot = parseRemoteSnapshot((await requestJSON(f.origin, `/perch/sessions/${f.session.id}`)).value);
    expect(snapshot.readOnly).toBe(true);
    expect(snapshot.capabilities.prompt).toBe(false);
    expect((await f.command('denied')).value.status).toBe('rejected');
    const g = await fixture();
    await exchange(g.origin, g.bridgeId, 2, { detail: { ...detail, canPrompt: false } });
    expect((await g.command('not-ready')).value.status).toBe('rejected');
    expect((await g.command('no-model', { type: 'set-model', text: undefined, provider: 'x', modelId: 'y' })).value.status).toBe('rejected');
    expect((await g.command('interrupt', { type: 'interrupt', text: undefined })).value.status).toBe('pending');
    expect((await exchange(g.origin, g.bridgeId, 3)).value.commands[0].type).toBe('interrupt');
  });

  test('bounds inputs and keeps capped artifact IDs from drifting to different text', async () => {
    const f = await fixture();
    const path = `/perch/sessions/${f.session.id}`;
    expect((await exchange(f.origin, f.bridgeId, 2, { agents: Array(33).fill(agent) })).status).toBe(400);
    expect((await f.command('oversized', { text: 'x'.repeat(100_001) })).status).toBe(400);
    expect((await requestJSON(f.origin, `${path}/commands`, { method: 'POST', raw: 'x'.repeat(130 * 1024) })).status).toBe(413);
    await exchange(f.origin, f.bridgeId, 2, { detail: { ...detail, truncated: true } });
    const first = parseRemoteSnapshot((await requestJSON(f.origin, path)).value);
    await exchange(f.origin, f.bridgeId, 3, { detail: { ...detail, truncated: true,
      messages: [{ role: 'assistant', text: 'Different bounded tail', tools: [{ status: '__proto__' }] }] } });
    const second = parseRemoteSnapshot((await requestJSON(f.origin, path)).value);
    expect(second.messages[0].id).not.toBe(first.messages[0].id);
    expect(second.tools[0].status).toBe('unknown');
  });

  test('capped windows retain unchanged artifacts and an anchored streaming assistant ID', async () => {
    const f = await fixture();
    const path = `/perch/sessions/${f.session.id}`;
    await exchange(f.origin, f.bridgeId, 2, { detail: { ...detail, truncated: true } });
    const first = parseRemoteSnapshot((await requestJSON(f.origin, path)).value);
    const grown = [...detail.messages.slice(0, 1), { ...detail.messages[1], text: `${detail.messages[1].text}\nMore streamed content.` }];
    await exchange(f.origin, f.bridgeId, 3, { detail: { ...detail, messages: grown, truncated: true } });
    const second = parseRemoteSnapshot((await requestJSON(f.origin, path)).value);
    expect(second.messages.map(row => row.id)).toEqual(first.messages.map(row => row.id));
    expect(second.tools[0].id).toBe(first.tools[0].id);
    await exchange(f.origin, f.bridgeId, 4, { detail: { ...detail, truncated: true,
      messages: [grown[1], { role: 'user', text: 'A later question', tools: [] }] } });
    const shifted = parseRemoteSnapshot((await requestJSON(f.origin, path)).value);
    expect(shifted.messages[0].id).toBe(second.messages[1].id);
    expect(shifted.messages[1].id).not.toBe(first.messages[0].id);
    expect(shifted.tools[0].id).toBe(first.tools[0].id);
  });

  test('a full receipt ledger rejects new IDs and retains the old outcome without expiry eviction', async () => {
    const f = await fixture();
    for (let batch = 0; batch < 32; batch++) {
      const results = await Promise.all(Array.from({ length: 32 }, (_, i) =>
        f.command(`retained-${batch * 32 + i}`, { epoch: 'stale-host' })));
      expect(results.every(result => result.value.status === 'rejected')).toBe(true);
    }
    expect((await f.command('over-capacity')).status).toBe(503);
    f.advance(3_600_001);
    expect((await f.receipt('retained-0')).value.status).toBe('rejected');
  });
});

test('host setup creates private files and retains credentials when repeated', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'perch-tern-setup-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, 'tern.json');
  const pluginDirectory = join(directory, 'plugin');
  await setupTernRemote({ configPath, pluginDirectory });
  const initial = await readPrivateConfig(configPath);
  expect(initial.port).toBe(4782);
  expect(initial.token).not.toBe(initial.pluginToken);
  expect((await stat(configPath)).mode & 0o077).toBe(0);
  expect((await stat(join(pluginDirectory, 'connection.json'))).mode & 0o077).toBe(0);
  expect(JSON.parse(await readFile(join(pluginDirectory, 'connection.json'), 'utf8')).token).toBe(initial.pluginToken);
  await setupTernRemote({ configPath, pluginDirectory });
  expect((await readPrivateConfig(configPath)).token).toBe(initial.token);
  const external = join(directory, 'external.json');
  await writeFile(external, '{}', { mode: 0o600 });
  await symlink(external, join(directory, 'linked.json'));
  await expect(readPrivateConfig(join(directory, 'linked.json'))).rejects.toThrow();
});

test('secret paths reject checkout placement, including linked ancestors and existing config values', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'perch-tern-placement-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, 'tern.json'), pluginDirectory = join(directory, 'plugin');
  const repository = resolve(import.meta.dir, '../../..');
  const checkoutConfig = join(repository, 'do-not-create-tern-credentials.json');
  const checkoutPlugin = join(repository, 'do-not-create-tern-plugin');
  await expect(setupTernRemote({ configPath: checkoutConfig, pluginDirectory })).rejects.toThrow('outside');
  await expect(readPrivateConfig(checkoutConfig)).rejects.toThrow('outside');
  await expect(setupTernRemote({ configPath, pluginDirectory: checkoutPlugin })).rejects.toThrow('outside');
  const link = join(directory, 'checkout-link');
  await symlink(repository, link);
  await expect(setupTernRemote({ configPath: join(link, 'missing-parent', 'tern.json'), pluginDirectory })).rejects.toThrow('outside');
  await expect(setupTernRemote({ configPath, pluginDirectory: join(link, 'missing-plugin') })).rejects.toThrow('outside');
  await setupTernRemote({ configPath, pluginDirectory });
  const initial = await readPrivateConfig(configPath);
  await writeFile(configPath, JSON.stringify({ ...initial, pluginDirectory: checkoutPlugin }));
  await expect(readPrivateConfig(configPath)).rejects.toThrow('outside');
});

test('private config rejects public mode and a different effective user before reading secrets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'perch-tern-owner-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, 'tern.json'), pluginDirectory = join(directory, 'plugin');
  await setupTernRemote({ configPath, pluginDirectory });
  if (process.platform !== 'win32') {
    await chmod(configPath, 0o644);
    await expect(readPrivateConfig(configPath)).rejects.toThrow('0600');
    await chmod(configPath, 0o600);
    // User namespaces may forbid chown even for uid 0. Present a different
    // current user while reading the real owned file; restore before cleanup.
    const uid = spyOn(process, 'getuid').mockReturnValue((await stat(configPath)).uid + 1);
    try {
      await expect(readPrivateConfig(configPath)).rejects.toThrow('owned by this user');
      await expect(setupTernRemote({ configPath, pluginDirectory })).rejects.toThrow('owned by this user');
    } finally { uid.mockRestore(); }
  }
});
