import { afterEach, expect, test } from 'bun:test';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture as durableFixture } from '../../../verification/durable/fixture.cjs';
import { parsePairingCode } from '../../../src/workspace/protocol.ts';
import { manifestFor, pairingCode, parseConfiguration, readConfiguration } from '../configuration.mjs';
import { setupArguments, writeConfiguration } from '../setup.mjs';
import { config, PI_TOKEN, piFixture, until, WORKSPACE_TOKEN } from './helpers.mjs';

const handles = [];
afterEach(async () => { for (const handle of handles.splice(0).reverse()) await handle.close(); });
const keep = value => { handles.push(value); return value; };
const connection = { id: 'pi', name: 'Pi', kind: 'pi', upstream: { url: 'ws://127.0.0.1:8787/session', token: PI_TOKEN } };
const setupPath = fileURLToPath(new URL('../setup.mjs', import.meta.url));
const checkout = fileURLToPath(new URL('../../..', import.meta.url));
async function folder() {
  const path = await mkdtemp(join(tmpdir(), 'perch-workspace-test-'));
  keep({ close: () => rm(path, { recursive: true, force: true }) }); return path;
}
function command(args, env = {}) {
  const process = Bun.spawn([Bun.which('bun') || globalThis.process.execPath, setupPath, ...args], {
    cwd: checkout, env: { ...globalThis.process.env, ...env }, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
  });
  let stdout = ''; let stderr = '';
  const read = async (stream, append) => { const decoder = new TextDecoder(); for await (const chunk of stream) append(decoder.decode(chunk, { stream: true })); append(decoder.decode()); };
  const output = Promise.all([read(process.stdout, value => { stdout += value; }), read(process.stderr, value => { stderr += value; })]);
  const result = async () => { const code = await process.exited; await output; return { code, stdout, stderr }; };
  keep({ close: async () => { process.kill(); await process.exited; await output; } });
  return { process, result, get stdout() { return stdout; }, get stderr() { return stderr; } };
}

test('private host config rejects unconfigured destinations, credentials in URLs and accidental shared tokens', () => {
  const valid = config([connection]);
  for (const url of ['ws://localhost:8787/session', 'ws://169.254.169.254/session', 'ws://127.0.0.1.evil/session', 'ws://127.1/session',
    'ws://2130706433/session', 'ws://user:password@127.0.0.1/session', 'ws://127.0.0.1/a/../session', 'ws://127.0.0.1/%2Fsession',
    'ws://127.0.0.1/session?token=secret', 'ws://127.0.0.1/session#secret', 'http://127.0.0.1/session', 'ws://127.0.0.1:0/session']) {
    expect(() => parseConfiguration({ ...valid, connections: [{ ...connection, upstream: { ...connection.upstream, url } }] })).toThrow();
  }
  expect(() => parseConfiguration({ ...valid, extra: 'provider-key' })).toThrow();
  expect(() => parseConfiguration({ ...valid, token: PI_TOKEN })).toThrow('different');
  expect(() => parseConfiguration({ ...valid, connections: [{ ...connection, upstream: { ...connection.upstream, apiKey: 'secret' } }] })).toThrow();
  expect(() => parseConfiguration({ ...valid, allowedOrigins: ['https://phone.example.com/path'] })).toThrow();
  expect(() => parseConfiguration({ ...valid, publicUrl: 'http://192.168.1.20:4780' })).toThrow();
  expect(() => parseConfiguration({ ...valid, connections: [{ id: 'omp', name: 'OMP', kind: 'omp', collabLink: 'invalid-private-invite' }] })).toThrow('invitation is invalid');
  const ipv6 = parseConfiguration({ ...valid, connections: [{ ...connection, upstream: { ...connection.upstream, url: 'ws://[::1]:8787/session' } }] });
  expect(ipv6.connections[0].upstream.url).toBe('ws://[::1]:8787/session');
});

test('pairing is one fragment capability and config writes are private, complete and never overwrite existing credentials', async () => {
  const path = join(await folder(), 'workspace.json'); const value = config([connection]);
  const pair = pairingCode(value); expect(parsePairingCode(pair)).toEqual({ url: value.publicUrl, token: WORKSPACE_TOKEN });
  expect(pair.split('#')[0]).toBe('perch://pair'); expect(pair).not.toContain(WORKSPACE_TOKEN);
  await writeConfiguration(path, value);
  expect((await stat(path)).mode & 0o077).toBe(0);
  const loaded = await readConfiguration(path); expect(loaded.token).toBe(WORKSPACE_TOKEN); expect(manifestFor(loaded).connections[0].path).toBe('/harness/pi');
  const before = await readFile(path, 'utf8');
  await expect(writeConfiguration(path, { ...value, token: 'replacement-public-test-token-32-characters' })).rejects.toThrow();
  expect(await readFile(path, 'utf8')).toBe(before);
  await chmod(path, 0o644); await expect(readConfiguration(path)).rejects.toThrow('600');
  await expect(writeConfiguration(join(checkout, 'workspace-test-credentials.json'), value)).rejects.toThrow('outside the Perch checkout');
});

test('setup rejects secret command-line flags and does not issue pairing or save a partial configuration', async () => {
  expect(() => setupArguments(['--token', WORKSPACE_TOKEN])).toThrow('Unsupported');
  expect(() => setupArguments(['--check', '--pair'])).toThrow();
  const path = await folder(); const input = join(path, 'setup.json'); const destination = join(path, 'workspace.json');
  const pi = keep(piFixture());
  await writeFile(input, JSON.stringify({ name: 'Partial workspace', publicUrl: 'https://host.example.com', connections: [
    pi.connection, { ...connection, id: 'broken', name: 'Broken adapter', upstream: { ...pi.connection.upstream, token: 'wrong-public-upstream-token-long-enough' } },
  ] }), { mode: 0o600 });
  const { code, stdout, stderr } = await command(['--config', destination, '--from', input]).result();
  expect(code).toBe(1); expect(stdout).toContain('Pi: local adapter verified'); expect(stderr).toContain('No pairing code was issued');
  expect(stdout + stderr).not.toContain('perch://pair#'); expect(stdout + stderr).not.toContain(PI_TOKEN);
  await expect(stat(destination)).rejects.toThrow();
});

test('host setup checks adapters directly despite ambient proxies, persists once and reuses the same pairing identity', async () => {
  const path = await folder(); const input = join(path, 'setup.json'); const destination = join(path, 'workspace.json');
  const pi = keep(piFixture()); const durable = keep(await durableFixture());
  let proxyRequests = 0;
  const proxy = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { proxyRequests++; return new Response(null, { status: 502 }); } });
  keep({ close: () => proxy.stop(true) });
  const proxyUrl = `http://127.0.0.1:${proxy.port}`;
  const env = { HTTP_PROXY: proxyUrl, http_proxy: proxyUrl, HTTPS_PROXY: proxyUrl, https_proxy: proxyUrl, ALL_PROXY: proxyUrl, all_proxy: proxyUrl, NO_PROXY: '', no_proxy: '' };
  await writeFile(input, JSON.stringify({ name: 'Ready workspace', publicUrl: 'https://host.example.com', listen: { hostname: '127.0.0.1', port: 0 }, connections: [
    pi.connection, { id: 'durable', name: 'Durable', kind: 'durable', upstream: { url: durable.url, token: durable.token } },
  ] }), { mode: 0o600 });
  const started = command(['--config', destination, '--from', input], env);
  await until(() => started.stdout.includes('perch://pair#') || started.stderr.length, 'completed host setup', 3000);
  if (started.stderr) throw new Error(JSON.stringify({ error: started.stderr, proxyRequests, durableRequests: durable.requests.length, piHandshakes: pi.frames.length }));
  expect(started.stderr).toBe('');
  const printed = started.stdout.match(/perch:\/\/pair#[A-Za-z0-9_-]+/)[0];
  const saved = await readConfiguration(destination); expect(parsePairingCode(printed).token).toBe(saved.token);
  expect(started.stdout).toContain('Perch workspace listening');
  expect(started.stdout).not.toContain(PI_TOKEN); expect(started.stdout).not.toContain(durable.token);
  started.process.kill('SIGTERM'); expect((await started.result()).code).toBe(0);
  const check = await command(['--config', destination, '--check'], env).result();
  expect(check.code).toBe(0); expect(check.stdout).not.toContain('perch://pair#');
  const paired = await command(['--config', destination, '--pair'], env).result();
  expect(paired.code).toBe(0); expect(paired.stdout).toContain(printed);
  expect((await readConfiguration(destination)).token).toBe(saved.token);
  expect(proxyRequests).toBe(0); expect(durable.requests.every(item => item.authorized)).toBe(true);
  expect(pi.frames.every(frame => frame.type === 'hello' && frame.token === PI_TOKEN)).toBe(true);
});
