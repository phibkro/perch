import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, chmod, lstat, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cloudflareApi, createState, deploymentFiles, normalizeConfiguration, parseArguments,
  privateDirectory, provisionCloudflare, publicPlan, readPrivate, verifyWorkspace, writePrivate } from '../../../scripts/setup-cloudflare.mjs';
import { parsePairingCode } from '../../../src/workspace/protocol.ts';

const model = { provider: 'custom', id: 'model-1', name: 'Test model', baseUrl: 'https://models.example/v1',
  apiKey: 'sk-secret-fixture', contextWindow: 32768, maxTokens: 4096 };
const input = { accountId: 'a'.repeat(32), workerName: 'perch-test', bucketName: 'perch-test-artifacts',
  workspaceId: 'personal', workspaceName: 'My cloud', models: [model] };
const state = async () => createState(await normalizeConfiguration(input));

test('cloud plan uses real model validation, only chosen credentials, and no secrets in review', async () => {
  const configured = await normalizeConfiguration({ ...input, models: [{ ...model, apiKey: undefined, apiKeyEnv: 'CHOSEN_KEY' }] }, { CHOSEN_KEY: 'sk-chosen-key' });
  assert.equal(configured.models[0].apiKey, 'sk-chosen-key'); assert.equal(configured.models[0].api, 'openai-completions');
  const setup = createState(configured); const plan = JSON.stringify(publicPlan(setup));
  assert.equal(plan.includes('sk-chosen-key'), false); assert.equal(plan.includes(setup.token), false);
  await assert.rejects(normalizeConfiguration({ ...input, models: [{ ...model, baseUrl: 'https://secret@example.com/v1' }] }), /Invalid model/);
  await assert.rejects(normalizeConfiguration({ ...input, models: [{ ...model, api: 'oauth-magic' }] }), /Invalid model/);
  await assert.rejects(normalizeConfiguration({ ...input, models: [{ ...model, baseUrl: 'http://127.0.0.1/v1' }] }), /HTTPS/);
  await assert.rejects(normalizeConfiguration({ ...input, models: [{ ...model, apiKey: 'sk-ant-oat01-consumer-token' }] }), /API key/);
  await assert.rejects(normalizeConfiguration({ ...input, models: [{ ...model, provider: 'openai', apiKey: 'subscription-token' }] }), /platform API key/);
  await assert.rejects(normalizeConfiguration({ ...input, models: [{ ...model, apiKeyEnv: 'CHOSEN_KEY' }] }, { CHOSEN_KEY: 'x' }), /one credential source/);
  await assert.rejects(normalizeConfiguration({ ...input, workspaceName: 'x'.repeat(121) }), /Invalid account/);
});

test('provider families retain their exact Go roots and setup state preserves access on rerun', async () => {
  const setup = createState(await normalizeConfiguration({ ...input, models: [
    { ...model, provider: 'opencode-go', api: 'anthropic-messages', baseUrl: 'https://opencode.ai/zen/go' },
    { ...model, provider: 'opencode-go', id: 'second', api: 'openai-responses', baseUrl: 'https://opencode.ai/zen/go/v1' },
  ] }));
  const repeated = createState({ ...setup.configuration, workspaceName: 'Renamed' }, setup);
  assert.equal(repeated.token, setup.token); assert.equal(repeated.installationId, setup.installationId);
  assert.throws(() => createState({ ...setup.configuration, workerName: 'somebody-else' }, setup), /different workspace/);
  const files = deploymentFiles(setup, '/private/worker.mjs');
  assert.equal(files.wrangler.vars.PERCH_DEPLOYMENT, 'cloudflare');
  assert.equal(files.wrangler.durable_objects.bindings.length, 2);
  assert.equal(files.wrangler.r2_buckets[0].binding, 'ARTIFACTS');
  assert.equal(JSON.stringify(files.wrangler).includes(model.apiKey), false);
  assert.deepEqual(JSON.parse(files.secrets.PERCH_TOKENS), { personal: setup.token });
  assert.equal(JSON.parse(files.secrets.PERCH_MODELS).length, 2);
});

test('private files are atomic, mode 600, and refuse symlinks, public files, and a Git checkout', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'perch-cloud-private-')); t.after(() => rm(directory, { recursive: true, force: true }));
  await chmod(directory, 0o700); await privateDirectory(directory);
  const filename = path.join(directory, 'private.json'); await writePrivate(filename, { secret: 'private' });
  assert.equal((await lstat(filename)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readPrivate(filename)), { secret: 'private' });
  await writePrivate(filename, { replaced: true }); assert.deepEqual(JSON.parse(await readPrivate(filename)), { replaced: true });
  const link = path.join(directory, 'link'); await symlink(filename, link);
  await assert.rejects(readPrivate(link), /private regular/); await assert.rejects(writePrivate(link, 'anything'), /unsafe/);
  await chmod(filename, 0o644); await assert.rejects(readPrivate(filename), /chmod 600/);
  const checkout = path.join(directory, 'checkout'); await mkdir(path.join(checkout, '.git'), { recursive: true });
  await assert.rejects(privateDirectory(path.join(checkout, 'setup')), /outside a Git/);
});

function fakeProvision(setup, overrides = {}) {
  const calls = [], snapshots = [];
  const api = async (method, route, body) => {
    calls.push({ method, route, body });
    if (route.endsWith('/settings')) return overrides.settings ?? null;
    if (route.endsWith('/workers/subdomain')) return { subdomain: 'account-test' };
    if (method === 'GET' && route.includes('/r2/buckets/')) return overrides.bucket ?? null;
    if (method === 'POST' && route.endsWith('/r2/buckets')) return { name: setup.configuration.bucketName };
    assert.fail('Unexpected API operation');
  };
  return { calls, snapshots, options: { apply: true, state: setup, directory: '/private/setup', api,
    wrangler: async args => { calls.push({ command: 'wrangler', args }); return { code: overrides.deployCode ?? 0 }; },
    persist: async value => snapshots.push(structuredClone(value)),
    verify: async url => { calls.push({ verify: url }); if (overrides.verifyError) throw new Error('Not verified'); return 'pairing-fixture'; },
  } };
}

test('provisioning requires apply and refuses unrelated Workers before any mutation', async () => {
  const fake = fakeProvision(await state());
  await assert.rejects(provisionCloudflare({ ...fake.options, apply: false }), /explicit apply/); assert.equal(fake.calls.length, 0);
  const other = fakeProvision(await state(), { settings: { bindings: [{ type: 'plain_text', name: 'PERCH_INSTALLATION_ID', text: 'not-ours' }] } });
  await assert.rejects(provisionCloudflare(other.options), /not owned/);
  assert(other.calls.every(call => call.method === 'GET')); assert.equal(other.snapshots.length, 0);
});

test('apply creates only the named bucket, uploads code plus secrets, and returns pairing after verification', async () => {
  const setup = await state(); const fake = fakeProvision(setup);
  const result = await provisionCloudflare(fake.options); assert.equal(result, 'pairing-fixture');
  const changes = fake.calls.filter(call => call.method === 'POST' || call.command || call.verify);
  assert.equal(changes[0].body.name, input.bucketName);
  assert.equal(changes[1].command, 'wrangler'); assert(changes[1].args.includes('--secrets-file'));
  assert(changes[1].args.includes('--strict')); assert(changes[1].args.includes('--keep-vars'));
  assert.equal(JSON.stringify(changes[1]).includes(model.apiKey), false);
  assert.equal(changes[2].verify, 'https://perch-test.account-test.workers.dev');
  assert.equal(setup.progress.verified, true); assert.equal(setup.progress.bucketReady, true);
  assert.equal(fake.snapshots[0].progress.bucketCreateRequested, true);
  const retry = fakeProvision(setup, { bucket: { name: input.bucketName }, settings: {
    bindings: [{ type: 'plain_text', name: 'PERCH_INSTALLATION_ID', text: setup.installationId }],
  } });
  await provisionCloudflare(retry.options); assert.equal(retry.calls.some(call => call.method === 'POST'), false);
});

test('existing buckets need explicit adoption and deployment/verification failures issue no pairing', async () => {
  const existing = fakeProvision(await state(), { bucket: { name: input.bucketName } });
  await assert.rejects(provisionCloudflare(existing.options), /--reuse-bucket/);
  assert.equal(existing.calls.some(call => call.command || call.method === 'POST'), false);
  await provisionCloudflare({ ...existing.options, reuseBucket: true });
  const failure = fakeProvision(await state(), { deployCode: 1 });
  await assert.rejects(provisionCloudflare(failure.options), /deployment failed/);
  assert.equal(failure.calls.some(call => call.verify), false); assert.equal(failure.options.state.progress.verified, false);
  const unverified = fakeProvision(await state(), { verifyError: true });
  await assert.rejects(provisionCloudflare(unverified.options), /Not verified/);
  assert.equal(unverified.options.state.progress.deployed, true); assert.equal(unverified.options.state.progress.verified, false);
});

test('Cloudflare API redacts service error bodies, binds the expected origin, and disables redirects', async () => {
  const requests = [];
  const api = cloudflareApi('cf-private-token', async (url, init) => {
    requests.push({ url, init }); return Response.json({ success: false, errors: [{ code: 10000, message: 'cf-private-token leaked-by-service' }] }, { status: 403 });
  });
  await assert.rejects(api('POST', `/accounts/${input.accountId}/r2/buckets`, { name: input.bucketName }), error => {
    assert.equal(error.message.includes('cf-private-token'), false); assert.match(error.message, /10000/); return true;
  });
  assert.equal(new URL(requests[0].url).origin, 'https://api.cloudflare.com');
  assert.equal(requests[0].init.redirect, 'error');
  assert.equal(requests[0].init.headers.Authorization, 'Bearer cf-private-token');
});

test('live verification checks real workspace contract and catalog before generating phone capability', async () => {
  const setup = await state(); const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(url); assert.equal(init.headers.Authorization, `Bearer ${setup.token}`); assert.equal(init.redirect, 'error');
    if (url.endsWith('/health')) return Response.json({ service: 'perch-durable', protocol: 1, synthetic: false, harness: { name: 'Pi Durable' }, models: [{ provider: model.provider, id: model.id, name: model.name }] });
    if (url.endsWith('/workspace')) return Response.json({ protocol: 'perch-workspace', version: 1,
      workspace: { id: 'personal', name: 'My cloud', deployment: 'cloudflare' }, defaultConnectionId: 'durable',
      connections: [{ id: 'durable', name: 'Pi Durable', kind: 'durable', path: '' }] });
    return Response.json({ sessions: [] });
  };
  const pairing = await verifyWorkspace('https://perch.example', setup, fetchImpl);
  assert.deepEqual(parsePairingCode(pairing), { url: 'https://perch.example', token: setup.token });
  assert.equal(seen.length, 3); assert.equal(pairing.includes(model.apiKey), false);
  await assert.rejects(verifyWorkspace('https://perch.example', setup, async () => Response.json({ service: 'perch-durable', protocol: 1, synthetic: true })), /production Perch/);
  await assert.rejects(verifyWorkspace('https://perch.example', setup, async () => new Response('private-error', { status: 401 })), /HTTP 401/);
});

test('CLI help and offline plan run without Cloudflare authentication or a provider key', async t => {
  const script = fileURLToPath(new URL('../../../scripts/setup-cloudflare.mjs', import.meta.url));
  assert.throws(() => parseArguments(['--plan', '--apply']), /Choose/);
  assert.throws(() => parseArguments(['--api-token', 'do-not-accept']), /Unknown option/);
  const help = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr); assert.match(help.stdout, /Guided setup/);
  const directory = await mkdtemp(path.join(tmpdir(), 'perch-cloud-plan-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const config = path.join(directory, 'input.json'); const { apiKey, ...keyless } = model;
  await writeFile(config, JSON.stringify({ ...input, models: [{ ...keyless, keyless: true }] }), { mode: 0o600 });
  const planned = spawnSync(process.execPath, [script, '--plan', '--config', config, '--state-dir', path.join(directory, 'private')], {
    encoding: 'utf8', env: { PATH: '' },
  });
  assert.equal(planned.status, 0, planned.stderr); assert.match(planned.stdout, /No Cloudflare authentication or provisioning/);
  const saved = JSON.parse(await readFile(path.join(directory, 'private/state.json'), 'utf8'));
  assert.equal(saved.configuration.models[0].keyless, true);
  assert.equal((await lstat(path.join(directory, 'private/secrets.json'))).mode & 0o777, 0o600);
  assert.equal(planned.stdout.includes(saved.token), false);
  assert.deepEqual(saved.progress, {});
});
