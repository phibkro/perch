#!/usr/bin/env node
/** Host-owned Cloudflare provisioning. No provider or account keys go to the phone. */
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, lstat, open, rename, rm, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseManifest, validateCredentials } from '../src/workspace/protocol.ts';

export const WRANGLER_VERSION = '4.148.0';
const root = fileURLToPath(new URL('../', import.meta.url));
const backend = path.join(root, 'server/pi-durable');
const MAX_FILE = 1024 * 1024;
const defaultStateDir = path.join(homedir(), '.config/perch/cloudflare');
const fail = message => { throw new Error(message); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const ownFields = (value, allowed) => record(value) && Object.keys(value).every(key => allowed.includes(key));
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);

export function parseArguments(argv) {
  const result = { stateDir: defaultStateDir, plan: false, apply: false, reuseBucket: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (['--plan', '--apply', '--help', '--reuse-bucket'].includes(flag)) {
      result[{ '--plan': 'plan', '--apply': 'apply', '--help': 'help', '--reuse-bucket': 'reuseBucket' }[flag]] = true;
    } else if (['--config', '--state-dir', '--wrangler'].includes(flag)) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) fail(`Supply a path after ${flag}.`);
      result[{ '--config': 'config', '--state-dir': 'stateDir', '--wrangler': 'wrangler' }[flag]] = path.resolve(argv[++i]);
    } else fail('Unknown option. Run bun run setup:cloud --help.');
  }
  if (result.plan && result.apply) fail('Choose --plan or --apply, not both.');
  return result;
}

const HELP = `Perch Cloudflare setup (Node 22.19+ and Bun)

  bun run setup:cloud                         Guided setup; review before applying
  bun run setup:cloud --plan --config FILE     Validate and save; no Cloudflare calls
  bun run setup:cloud --apply --config FILE    Explicit noninteractive provisioning

  --state-dir DIR   Private resumable state (default ~/.config/perch/cloudflare)
  --config FILE     Private JSON config; use apiKeyEnv / apiKeyFile / apiKey per model
  --wrangler PATH   Explicit Wrangler ${WRANGLER_VERSION} executable instead of pinned bun x
  --reuse-bucket    Allow the named existing bucket after reviewing its use
  --plan           Do not log in, provision, deploy, or call model providers
  --apply          Authorize the reviewed configuration (TTY also confirms its Worker name)

Cloudflare: existing Wrangler OAuth login, device login, or CLOUDFLARE_API_TOKEN.
Provider choices: OpenCode Go, Anthropic API, OpenAI API, or a compatible endpoint.
No Claude/ChatGPT subscription tokens or harness OAuth files are imported.
See docs/CLOUD-SETUP.md for credentials, private config format, and recovery.
`;

/** Validate with the backend's actual contract, so wizard and runtime cannot drift. */
export async function normalizeConfiguration(input, env = process.env) {
  if (!ownFields(input, ['accountId', 'workerName', 'bucketName', 'workspaceId', 'workspaceName', 'models']) ||
      !/^[a-f0-9]{32}$/i.test(input.accountId ?? '') ||
      typeof input.workerName !== 'string' || !/^[a-z][a-z0-9-]{0,61}[a-z0-9]$/.test(input.workerName) ||
      typeof input.bucketName !== 'string' || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(input.bucketName) ||
      !identifier(input.workspaceId) || typeof input.workspaceName !== 'string' || !input.workspaceName.trim() ||
      input.workspaceName.length > 120 || /[\u0000-\u001f\u007f]/.test(input.workspaceName) ||
      !Array.isArray(input.models) || !input.models.length || input.models.length > 100) {
    fail('Invalid account, Worker, bucket, workspace, or model configuration. See docs/CLOUD-SETUP.md.');
  }
  const models = [];
  for (const source of input.models) {
    if (!record(source)) fail('Each configured model must be an object.');
    const { apiKeyEnv, apiKeyFile, ...item } = source;
    const keySources = [item.apiKey !== undefined, apiKeyEnv !== undefined, apiKeyFile !== undefined].filter(Boolean).length;
    if (keySources > 1 || (item.keyless === true && keySources)) fail('Choose one credential source for each model.');
    if (apiKeyEnv !== undefined) {
      if (typeof apiKeyEnv !== 'string' || !/^[A-Z][A-Z0-9_]{0,127}$/.test(apiKeyEnv) || !env[apiKeyEnv]) fail('A configured provider key environment variable is missing.');
      item.apiKey = env[apiKeyEnv];
    }
    if (apiKeyFile !== undefined) {
      if (typeof apiKeyFile !== 'string' || !path.isAbsolute(apiKeyFile)) fail('Provider key files require an absolute private path.');
      item.apiKey = (await readPrivate(apiKeyFile)).trim();
    }
    // These options are API credentials. Pi also has separate native OAuth
    // implementations; passing their tokens here would not install refresh.
    if (typeof item.apiKey === 'string' && (/[\u0000-\u0020\u007f]/.test(item.apiKey) || item.apiKey.startsWith('sk-ant-oat'))) fail('Supply an API key, not a browser session or Claude subscription token.');
    if (item.provider === 'openai' && (item.keyless || !item.apiKey?.startsWith('sk-'))) fail('The OpenAI API option requires a platform API key. Codex/ChatGPT sign-in belongs to its host harness.');
    if (item.provider === 'anthropic' && (item.keyless || !item.apiKey?.startsWith('sk-ant-api'))) fail('The Anthropic option requires a Console API key.');
    if (item.provider === 'opencode-go') {
      const expected = item.api === 'anthropic-messages' ? 'https://opencode.ai/zen/go' : 'https://opencode.ai/zen/go/v1';
      if (item.baseUrl !== expected || item.keyless) fail('OpenCode Go requires its API key and the correct Go API-family URL.');
    }
    models.push(item);
  }
  const { configuredModels } = await import('../server/pi-durable/src/provider.mjs');
  let validated;
  try { validated = configuredModels({ PERCH_MODELS: JSON.stringify(models) }); }
  catch { fail('Invalid model API, endpoint, credentials, or token limits. See docs/CLOUD-SETUP.md.'); }
  for (const item of validated) {
    // Cloud Workers cannot reach the operator's loopback or ordinary LAN.
    const url = new URL(item.baseUrl);
    if (url.protocol !== 'https:') fail('Cloud provider endpoints require HTTPS. Use self-hosted setup for local HTTP models.');
  }
  return { ...input, accountId: input.accountId.toLowerCase(), workspaceName: input.workspaceName.trim(), models: validated };
}

export function createState(configuration, previous) {
  if (previous) {
    if (previous.version !== 1 || !/^[a-f0-9-]{36}$/i.test(previous.installationId ?? '') ||
        !record(previous.configuration) || !record(previous.progress)) fail('Private setup state is invalid. Restore its protected backup.');
    validateCredentials({ url: 'https://validation.example', token: previous.token });
    for (const key of ['accountId', 'workerName', 'bucketName', 'workspaceId']) {
      if (previous.configuration[key] !== configuration[key]) fail('This state directory belongs to a different workspace. Choose a separate --state-dir.');
    }
    return { ...previous, configuration };
  }
  return { version: 1, installationId: randomUUID(), token: randomBytes(32).toString('base64url'), configuration, progress: {} };
}

export function publicPlan(state) {
  const config = state.configuration;
  return { accountId: config.accountId, worker: config.workerName, bucket: config.bucketName,
    workspace: { id: config.workspaceId, name: config.workspaceName },
    runtime: 'Pi Durable / Cloudflare Workers', durableObjects: ['PerchCatalog', 'PerchSession'],
    models: config.models.map(({ provider, id, name, api, baseUrl }) => ({ provider, id, name, api, baseUrl })),
    secrets: ['PERCH_TOKENS (generated workspace access)', 'PERCH_MODELS (chosen provider credentials)'],
    deploy: 'Worker code + secrets together; existing owned Worker updated; no resources deleted',
  };
}

export function deploymentFiles(state, main = path.join(backend, 'dist/worker.mjs')) {
  const config = state.configuration;
  return {
    wrangler: { name: config.workerName, account_id: config.accountId, main, workers_dev: true, preview_urls: false,
      compatibility_date: '2026-10-01', compatibility_flags: ['nodejs_compat'],
      durable_objects: { bindings: [{ name: 'PERCH_CATALOGS', class_name: 'PerchCatalog' }, { name: 'PERCH_SESSIONS', class_name: 'PerchSession' }] },
      migrations: [{ tag: 'v1', new_sqlite_classes: ['PerchCatalog', 'PerchSession'] }],
      r2_buckets: [{ binding: 'ARTIFACTS', bucket_name: config.bucketName }],
      vars: { PERCH_ALLOWED_ORIGINS: '[]', PERCH_WORKSPACE_NAME: config.workspaceName,
        PERCH_DEPLOYMENT: 'cloudflare', PERCH_INSTALLATION_ID: state.installationId },
    },
    secrets: { PERCH_TOKENS: JSON.stringify({ [config.workspaceId]: state.token }), PERCH_MODELS: JSON.stringify(config.models) },
  };
}

export async function privateDirectory(directory) {
  const absolute = path.resolve(directory);
  // A cloud setup has long-lived secrets; putting its state in the checkout
  // makes an accidental commit too easy. The operator owns this private path.
  let ancestor = absolute;
  while (true) {
    try {
      if ((await lstat(ancestor)).isSymbolicLink()) fail('Private setup paths must not contain symbolic links.');
      try { await lstat(path.join(ancestor, '.git')); fail('Store Cloudflare setup outside a Git checkout.'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = path.dirname(ancestor); if (parent === ancestor) break; ancestor = parent;
  }
  await mkdir(absolute, { recursive: true, mode: 0o700 });
  const stat = await lstat(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) fail('Setup directory must be private (chmod 700), owned by this user, and not a symbolic link.');
  if (process.getuid && stat.uid !== process.getuid()) fail('The setup directory must belong to this user.');
  return realpath(absolute);
}

export async function readPrivate(filename) {
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.size > MAX_FILE || (process.getuid && stat.uid !== process.getuid())) fail('Credential/config files must be private regular files (chmod 600), owned by this user, and at most 1 MiB.');
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return await handle.readFile('utf8'); } finally { await handle.close(); }
}

export async function writePrivate(filename, value) {
  try {
    const stat = await lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) fail('Refusing to replace an unsafe private setup file.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = `${filename}.${randomUUID()}.tmp`;
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
  try { await rename(temporary, filename); } finally { await rm(temporary, { force: true }); }
}

async function privateJson(filename) {
  let text;
  try { text = await readPrivate(filename); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try { return JSON.parse(text); } catch { fail('A private setup JSON file is invalid. Its contents were not printed.'); }
}

/** Do not echo subprocess output: an auth response or failed upload can hold keys. */
export function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd ?? root,
      env: { ...process.env, WRANGLER_WRITE_LOGS: 'false', WRANGLER_SEND_METRICS: 'false',
        WRANGLER_SEND_ERROR_REPORTS: 'false', NO_COLOR: '1', ...options.env },
      stdio: options.interactive ? 'inherit' : ['ignore', 'pipe', 'pipe'] });
    let stdout = '', size = 0, overflow = false;
    if (!options.interactive) {
      child.stdout.on('data', chunk => { size += chunk.length; if (size > 4 * MAX_FILE) { overflow = true; child.kill(); } else stdout += chunk; });
      child.stderr.on('data', () => {});
    }
    child.on('error', () => reject(new Error('A required local command could not start. Install Node and Bun, or supply --wrangler PATH.')));
    child.on('close', code => resolve({ code: overflow ? 1 : code, stdout: overflow ? '' : stdout }));
  });
}

export function cloudflareApi(token, fetchImpl = fetch) {
  if (typeof token !== 'string' || !token || /[^\x21-\x7e]/.test(token)) fail('Cloudflare authentication did not return an API token.');
  return async (method, route, body, allowMissing = false) => {
    let response;
    try { response = await fetchImpl('https://api.cloudflare.com/client/v4' + route, { method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(30_000) }); }
    catch { fail('Cloudflare could not be reached. Check connectivity and retry with the same state directory.'); }
    if (allowMissing && response.status === 404) return null;
    let payload;
    try { const bytes = await boundedText(response); payload = JSON.parse(bytes); } catch { fail(`Cloudflare returned an unreadable response (HTTP ${response.status}).`); }
    if (!response.ok || payload.success !== true) {
      const codes = Array.isArray(payload.errors) ? payload.errors.map(item => item?.code).filter(Number.isSafeInteger).join(', ') : '';
      fail(`Cloudflare ${method} failed (HTTP ${response.status}${codes ? `; codes ${codes}` : ''}). Check account access, Workers/R2 permissions, and billing activation; provider credentials were not printed.`);
    }
    return payload.result;
  };
}

async function boundedText(response) {
  if (!response.body) fail('Empty response.');
  const reader = response.body.getReader(); let size = 0; const chunks = [];
  try {
    while (true) { const next = await reader.read(); if (next.done) break; size += next.value.length;
      if (size > MAX_FILE) fail('Response too large.'); chunks.push(Buffer.from(next.value)); }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}

export async function verifyWorkspace(url, state, fetchImpl = fetch) {
  validateCredentials({ url, token: state.token });
  const get = async suffix => {
    let response;
    try { response = await fetchImpl(url + suffix, { headers: { Authorization: `Bearer ${state.token}` }, redirect: 'error', signal: AbortSignal.timeout(30_000) }); }
    catch { fail('The deployed workspace could not be reached. Rerun setup after checking its workers.dev access.'); }
    if (!response.ok) fail(`Workspace verification failed (HTTP ${response.status}). No pairing code was issued.`);
    try { return JSON.parse(await boundedText(response)); } catch { fail('The deployed workspace returned invalid JSON. No pairing code was issued.'); }
  };
  const health = await get('/perch/health');
  const expectedModels = state.configuration.models.map(({ provider, id, name }) => ({ provider, id, name }));
  if (health.service !== 'perch-durable' || health.protocol !== 1 || health.synthetic !== false ||
      health.harness?.name !== 'Pi Durable' || !Array.isArray(health.models) ||
      JSON.stringify(health.models) !== JSON.stringify(expectedModels)) fail('The deployed endpoint is not a production Perch Pi Durable backend with the selected models.');
  const manifest = parseManifest(await get('/perch/workspace'));
  if (manifest.workspace.id !== state.configuration.workspaceId || manifest.workspace.name !== state.configuration.workspaceName || manifest.workspace.deployment !== 'cloudflare' ||
      manifest.defaultConnectionId !== 'durable' || manifest.connections.length !== 1 ||
      manifest.connections[0].kind !== 'durable' || manifest.connections[0].path !== '') fail('Workspace discovery does not match this Cloudflare configuration.');
  const catalog = await get('/perch/sessions');
  if (!record(catalog) || !Array.isArray(catalog.sessions)) fail('The deployed workspace catalog could not be verified.');
  return `perch://pair#${Buffer.from(JSON.stringify({ version: 1, url, token: state.token })).toString('base64url')}`;
}

/** Dependency injection here exercises provisioning failures without account access. */
export async function provisionCloudflare({ apply = false, state, directory, api, wrangler, persist,
  verify = verifyWorkspace, reuseBucket = false, log = () => {} }) {
  if (apply !== true) fail('Cloud provisioning requires an explicit apply confirmation.');
  const config = state.configuration; const account = `/accounts/${config.accountId}`;
  const workerRoute = `${account}/workers/scripts/${config.workerName}/settings`;
  const assertOwned = settings => {
    if (settings && !settings.bindings?.some(binding => binding.type === 'plain_text' &&
        binding.name === 'PERCH_INSTALLATION_ID' && binding.text === state.installationId)) {
      fail('A Worker with this name already exists and is not owned by this setup. Choose a new Worker name and state directory.');
    }
  };
  assertOwned(await api('GET', workerRoute, undefined, true));
  const domain = await api('GET', `${account}/workers/subdomain`);
  if (!domain || typeof domain.subdomain !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(domain.subdomain)) fail('Enable an account workers.dev subdomain in Cloudflare, then rerun this setup.');
  const bucketRoute = `${account}/r2/buckets/${config.bucketName}`;
  const bucket = await api('GET', bucketRoute, undefined, true);
  if (bucket && !state.progress.bucketReady && !reuseBucket) fail('The R2 bucket already exists. Review its contents/access, then use --reuse-bucket to adopt it or choose a different setup directory and names.');
  if (!bucket) {
    log('Creating the R2 artifact bucket…');
    state.progress.bucketCreateRequested = true; await persist(state);
    await api('POST', `${account}/r2/buckets`, { name: config.bucketName });
  }
  state.progress.bucketReady = true; await persist(state);
  assertOwned(await api('GET', workerRoute, undefined, true));
  log('Deploying Pi Durable, its SQLite namespaces, and private model settings…');
  state.progress.verified = false; await persist(state);
  const result = await wrangler(['deploy', '--config', path.join(directory, 'wrangler.json'), '--no-bundle',
    '--secrets-file', path.join(directory, 'secrets.json'), '--keep-vars', '--strict', '--autoconfig=false']);
  if (result.code !== 0) fail('Wrangler deployment failed. No pairing code was issued. Check the required account roles and private configuration, then rerun with the same state directory.');
  state.progress.deployed = true; state.url = `https://${config.workerName}.${domain.subdomain}.workers.dev`; await persist(state);
  log('Checking authenticated discovery, health, and the SQLite session catalog…');
  const pairing = await verify(state.url, state);
  state.progress.verified = true; await persist(state);
  return pairing;
}

async function question(prompt, defaultValue = '') {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { const result = (await rl.question(`${prompt}${defaultValue ? ` [${defaultValue}]` : ''}: `)).trim(); return result || defaultValue; }
  finally { rl.close(); }
}

async function secret(prompt) {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) fail('Secret entry needs a terminal. Use a private --config with apiKeyEnv or apiKeyFile in automation.');
  process.stdout.write(`${prompt} (hidden): `);
  return new Promise((resolve, reject) => {
    let value = ''; const previousRaw = process.stdin.isRaw;
    const finish = (error) => { process.stdin.removeListener('data', onData); process.stdin.setRawMode(previousRaw); process.stdin.pause(); process.stdout.write('\n'); error ? reject(error) : resolve(value); };
    const onData = data => {
      for (const character of data.toString('utf8')) {
        if (character === '\u0003') return finish(new Error('Setup cancelled.'));
        if (character === '\r' || character === '\n') return finish();
        if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
        else if (/[\x21-\x7e]/.test(character)) { value += character; if (value.length > 8192) return finish(new Error('Provider key is too long.')); }
      }
    };
    process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.on('data', onData);
  });
}

async function ensureBackend() {
  try { await lstat(path.join(backend, 'node_modules/@earendil-works/pi-ai/package.json')); await lstat(path.join(backend, 'node_modules/esbuild/package.json')); }
  catch {
    process.stdout.write('Installing the pinned backend dependencies with Bun…\n');
    const installed = await runCommand('bun', ['install', '--frozen-lockfile'], { cwd: backend });
    if (installed.code !== 0) fail('Backend dependency installation failed. Run bun install --cwd server/pi-durable --frozen-lockfile, then retry.');
  }
}

function wranglerRunner(executable, accountId) {
  return (args, interactive = false) => runCommand(executable ?? 'bun', executable ? args : ['x', `wrangler@${WRANGLER_VERSION}`, ...args], {
    interactive, env: accountId ? { CLOUDFLARE_ACCOUNT_ID: accountId } : {},
  });
}

async function authenticateWrangler(wrangler, interactive) {
  const version = await wrangler(['--version']);
  if (version.code !== 0 || !new RegExp(`(?:^|\\s)${WRANGLER_VERSION.replaceAll('.', '\\.')}\\s*$`).test(version.stdout.trim())) fail(`Wrangler ${WRANGLER_VERSION} is required. Use the default pinned runner or update your explicit executable.`);
  // A scoped account token need not have user-profile or account-list access.
  // Actual resource preflight checks it; ask for the known account ID instead.
  if (process.env.CLOUDFLARE_API_TOKEN) return { loggedIn: true, accounts: [] };
  let who = await wrangler(['whoami', '--json']);
  let identity; try { identity = JSON.parse(who.stdout); } catch { identity = null; }
  if (who.code !== 0 || !identity?.loggedIn) {
    if (!interactive) fail('Cloudflare is not authenticated. Run bun x wrangler@' + WRANGLER_VERSION + ' login --device, or set CLOUDFLARE_API_TOKEN, then retry.');
    process.stdout.write('Approve Cloudflare access using the device code below. The code can be opened on your phone.\n');
    const login = await wrangler(['login', '--device', '--browser=false'], true);
    if (login.code !== 0) fail('Cloudflare sign-in did not complete. The setup has not provisioned resources.');
    who = await wrangler(['whoami', '--json']);
    try { identity = JSON.parse(who.stdout); } catch { identity = null; }
    if (who.code !== 0 || !identity?.loggedIn) fail('Cloudflare authentication could not be verified.');
  }
  return identity;
}

async function authToken(wrangler) {
  // Captured only in memory. WRANGLER_WRITE_LOGS=false also prevents Wrangler
  // itself from writing this command's stdout into a debug log on disk.
  const result = await wrangler(['auth', 'token', '--json']); let value;
  try { value = JSON.parse(result.stdout); } catch { fail('Wrangler did not return a usable account credential.'); }
  if (result.code !== 0 || !['api_token', 'oauth'].includes(value?.type) || typeof value.token !== 'string') fail('Use Wrangler OAuth or a scoped Cloudflare API token; global API keys are not used by this setup.');
  return value.token;
}

async function providerModels() {
  const providers = [ ['opencode-go', 'OpenCode Go'], ['anthropic', 'Anthropic API'],
    ['openai', 'OpenAI API'], ['custom', 'Other HTTPS OpenAI-compatible endpoint'] ];
  const results = []; const chosen = new Set();
  while (true) {
    process.stdout.write('\nSelect a model provider (API credentials stay on this host):\n');
    providers.forEach(([id, name], i) => { if (!chosen.has(id)) process.stdout.write(`  ${i + 1}. ${name}\n`); });
    const index = Number(await question('Provider number', String(providers.findIndex(([id]) => !chosen.has(id)) + 1))) - 1;
    const provider = providers[index]; if (!provider || chosen.has(provider[0])) fail('Choose an available provider number. Rerun setup to try again.');
    const [id, label] = provider; chosen.add(id);
    let models;
    if (id === 'custom') {
      const providerId = await question('Provider ID (letters, digits, dash, underscore)', 'custom');
      if (['openai', 'anthropic', 'opencode-go', 'openai-codex'].includes(providerId)) fail('Use a distinct custom provider ID.');
      const baseUrl = await question('HTTPS API base URL (including /v1 if required)');
      const modelId = await question('Model ID');
      process.stdout.write('API families: openai-completions, openai-responses, anthropic-messages\n');
      const api = await question('API family', 'openai-completions');
      const contextWindow = Number(await question('Context window in tokens', '32768'));
      const maxTokens = Number(await question('Maximum output tokens', '4096'));
      models = [{ provider: providerId, id: modelId, name: modelId, baseUrl, api, contextWindow, maxTokens }];
    } else {
      const { setupCatalog } = await import('../server/pi-durable/setup-catalog.mjs');
      const catalog = (await setupCatalog(id)).filter(model =>
        ['openai-completions', 'openai-responses', 'anthropic-messages'].includes(model.api) && model.contextWindow >= 4096 && model.maxTokens < model.contextWindow);
      process.stdout.write(`\n${label} model IDs from the installed Pi catalog (availability depends on your account):\n`);
      for (const model of catalog) process.stdout.write(`  ${model.id}\n`);
      const ids = (await question('Choose one or more model IDs, separated by commas')).split(',').map(value => value.trim());
      if (!ids.length || ids.some(id => !catalog.some(model => model.id === id)) || new Set(ids).size !== ids.length) fail('Choose model IDs from the displayed catalog.');
      models = ids.map(id => {
        const model = catalog.find(item => item.id === id);
        return { provider: model.provider, id: model.id, name: model.name, api: model.api, baseUrl: model.baseUrl,
          contextWindow: model.contextWindow, maxTokens: model.maxTokens, reasoning: model.reasoning ?? false };
      });
    }
    const keyless = id === 'custom' && (await question('Does this endpoint explicitly require no API key? (yes/no)', 'no')).toLowerCase() === 'yes';
    const apiKey = keyless ? undefined : await secret(`${label} API key`);
    results.push(...models.map(model => ({ ...model, ...(keyless ? { keyless: true } : { apiKey }) })));
    if (chosen.size === providers.length || (await question('Add another provider? (yes/no)', 'no')).toLowerCase() !== 'yes') break;
  }
  return results;
}

async function interactiveConfiguration(identity) {
  let accountId;
  const accounts = Array.isArray(identity?.accounts) ? identity.accounts.filter(item => /^[a-f0-9]{32}$/i.test(item.id)) : [];
  if (accounts.length) {
    process.stdout.write('\nCloudflare accounts:\n'); accounts.forEach((account, i) => process.stdout.write(`  ${i + 1}. ${String(account.name).replace(/[\u0000-\u001f\u007f]/g, '')} (${account.id})\n`));
    const index = Number(await question('Account number', '1')) - 1;
    if (!accounts[index]) fail('Choose one of the displayed accounts.'); accountId = accounts[index].id;
  } else accountId = await question('Cloudflare account ID (32 hexadecimal characters)');
  const workerName = await question('Worker name', `perch-${randomBytes(3).toString('hex')}`);
  const bucketName = await question('R2 artifact bucket name', `${workerName}-artifacts`);
  const workspaceId = await question('Workspace ID', 'personal');
  const workspaceName = await question('Workspace name shown in Perch', 'My cloud workspace');
  return { accountId, workerName, bucketName, workspaceId, workspaceName, models: await providerModels() };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help) { process.stdout.write(HELP); return; }
  const interactive = !!process.stdin.isTTY && !!process.stdout.isTTY;
  const directory = await privateDirectory(options.stateDir);
  const lockPath = path.join(directory, 'setup.lock'); let lock;
  try { lock = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
  catch { fail('This setup directory is locked. If no setup process is running, remove setup.lock and rerun.'); }
  try {
    await lock.writeFile(`${process.pid}\n`);
    const saved = await privateJson(path.join(directory, 'state.json'));
    let input = options.config ? await privateJson(options.config) : saved?.configuration;
    if (options.config && !input) fail('The private --config file does not exist.');
    if (!input && !interactive) fail('Use a terminal for guided setup, or provide a private --config file. No Cloudflare resources were created.');
    await ensureBackend();
    let wrangler = wranglerRunner(options.wrangler); let identity;
    if (!input) {
      if (!options.plan) identity = await authenticateWrangler(wrangler, true);
      input = await interactiveConfiguration(identity);
    }
    const configuration = await normalizeConfiguration(input);
    const state = createState(configuration, saved);
    const persist = value => writePrivate(path.join(directory, 'state.json'), value);
    await persist(state);
    const files = deploymentFiles(state);
    await writePrivate(path.join(directory, 'wrangler.json'), files.wrangler);
    await writePrivate(path.join(directory, 'secrets.json'), files.secrets);
    process.stdout.write(`\nReview this deployment:\n${JSON.stringify(publicPlan(state), null, 2)}\n\nPrivate resumable setup: ${directory}\n`);
    process.stdout.write('Cloudflare resource usage and model calls use your account billing. Setup itself makes no model call.\n');
    if (options.plan) { process.stdout.write('Plan saved. No Cloudflare authentication or provisioning was attempted. Rerun without --plan to review and apply.\n'); return; }
    if (!interactive && !options.apply) { process.stdout.write('Plan saved. Noninteractive deployment needs --apply.\n'); return; }
    if (interactive && await question(`Type ${configuration.workerName} to provision/update this Worker, or press Enter to stop`) !== configuration.workerName) {
      process.stdout.write('Plan saved; deployment was not applied.\n'); return;
    }
    wrangler = wranglerRunner(options.wrangler, configuration.accountId);
    if (!identity) await authenticateWrangler(wrangler, interactive);
    const token = await authToken(wrangler);
    process.stdout.write('Building the pinned production backend…\n');
    const built = await runCommand(process.execPath, ['build.mjs'], { cwd: backend });
    if (built.code !== 0) fail('Backend build failed. Run bun run --cwd server/pi-durable build for local diagnostics. No deployment was attempted.');
    const pairing = await provisionCloudflare({ apply: true, state, directory, api: cloudflareApi(token), wrangler, persist,
      reuseBucket: options.reuseBucket, log: message => process.stdout.write(message + '\n') });
    await writePrivate(path.join(directory, 'pairing.txt'), pairing + '\n');
    process.stdout.write(`\nWorkspace verified: ${state.url}\nIn Perch, open Connect a workspace → Cloud and paste this private pairing code:\n\n${pairing}\n\n`);
    process.stdout.write('The code grants workspace access. Keep it private. Only the workspace URL and its generated token are transferred to the phone.\n');
    process.stdout.write('Provider entitlement/inference and R2 recovery still need an actual chat/artifact check after pairing.\n');
  } finally { await lock.close(); await rm(lockPath, { force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    // OS/parser/provider errors can include the input. Only errors deliberately
    // created above are intended for output; runtime detail remains local.
    const safe = error instanceof Error && !error.code && error.constructor === Error;
    process.stderr.write(`Setup stopped: ${safe ? error.message : 'A local setup step failed. Check private file permissions and installed dependencies, then retry.'}\n`);
    process.exitCode = 1;
  });
}
