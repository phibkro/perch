import { constants } from 'node:fs';
import { access, link, mkdir, open, readFile, realpath, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { pairingCode, prepareConfiguration, readConfiguration } from './configuration.mjs';
import { probeConnection } from './gateway.mjs';
import { runWorkspace } from './index.mjs';

const checkout = resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const defaultConfigPath = () => resolve(homedir(), '.config/perch/workspace.json');

/** The new file appears complete, stays private, and can never replace an existing config. */
export async function writeConfiguration(path, config) {
  const destination = resolve(path); const parent = dirname(destination);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const canonicalParent = await realpath(parent);
  const withinCheckout = relative(checkout, canonicalParent);
  if (!withinCheckout || (!withinCheckout.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) && !isAbsolute(withinCheckout))) {
    throw new Error('Save the private workspace config outside the Perch checkout.');
  }
  const temporary = resolve(parent, `.perch-workspace-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(config, null, 2) + '\n'); await handle.sync();
    await handle.close(); handle = undefined;
    await link(temporary, destination); // Atomic create, with EEXIST instead of overwrite.
  } finally { await handle?.close(); await unlink(temporary).catch(() => {}); }
}

async function readSetupInput(path) {
  const info = await stat(path);
  if (!info.isFile() || info.size > 128 * 1024) throw new Error('The setup input must be a regular JSON file smaller than 128 KiB.');
  if (process.platform !== 'win32' && (info.mode & 0o077)) throw new Error('The setup input contains credentials. Set its permissions to 600.');
  let value;
  try { value = JSON.parse(await readFile(path, 'utf8')); }
  catch { throw new Error('The setup input is not valid JSON.'); }
  return prepareConfiguration(value);
}

async function interactiveSetup() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Use an interactive terminal, or --from /absolute/private/setup.json. Credentials are never command-line arguments.');
  let muted = false;
  const output = new Writable({ write(chunk, _encoding, callback) { if (!muted) process.stdout.write(chunk); callback(); } });
  const input = createInterface({ input: process.stdin, output, terminal: true });
  const abort = new AbortController();
  input.on('SIGINT', () => abort.abort());
  const ask = async (prompt, fallback = '') => {
    const value = (await input.question(`${prompt}${fallback ? ` [${fallback}]` : ''}: `, { signal: abort.signal })).trim();
    return value || fallback;
  };
  const credential = async prompt => {
    process.stdout.write(`${prompt} (hidden): `); muted = true;
    try { return (await input.question('', { signal: abort.signal })).trim(); }
    finally { muted = false; input.history.length = 0; process.stdout.write('\n'); }
  };
  try {
    process.stdout.write('Perch host setup\nUse adapters already running on this machine. Provider login and project folders stay on this host.\n\n');
    const name = await ask('Workspace name', 'Home workspace');
    const publicUrl = await ask('Public HTTPS address that forwards to this gateway');
    process.stdout.write('\nLocal adapters: 1 Pi Durable, 2 Pi bridge, 3 OpenCode gateway, 4 Existing OMP invitation\n');
    const selections = (await ask('Choose numbers separated by commas', '2')).split(',').map(value => value.trim());
    if (!selections.length || new Set(selections).size !== selections.length || selections.some(value => !['1', '2', '3', '4'].includes(value))) throw new Error('Choose each adapter number once, from 1 through 4.');
    const connections = [];
    for (const selection of selections) {
      if (selection === '4') {
        process.stdout.write('\nOMP attaches to an existing session. Its invitation has its own sharing lifetime.\n');
        connections.push({ id: 'omp', name: 'OMP terminal', kind: 'omp', collabLink: await credential('OMP Collab invitation') });
        continue;
      }
      const kind = { 1: 'durable', 2: 'pi', 3: 'opencode' }[selection];
      const label = { durable: 'Pi Durable', pi: 'Pi bridge', opencode: 'OpenCode gateway' }[kind];
      const fallback = { durable: 'http://127.0.0.1:8788', pi: 'ws://127.0.0.1:8787/session', opencode: 'http://127.0.0.1:4097' }[kind];
      process.stdout.write(`\n${label}\n`);
      const url = await ask('Local adapter address', fallback);
      const upstream = kind === 'opencode'
        ? { url, username: await ask('Gateway username', 'perch'), password: await credential('Gateway password') }
        : { url, token: await credential('Adapter token') };
      connections.push({ id: kind, name: label, kind, upstream });
    }
    const defaultConnectionId = connections.length === 1 ? connections[0].id
      : await ask(`Default connection (${connections.map(item => item.id).join(', ')})`, connections[0].id);
    return prepareConfiguration({ name, publicUrl, connections, defaultConnectionId });
  } finally { muted = false; input.close(); }
}

export function setupArguments(args) {
  const result = { config: defaultConfigPath(), from: undefined, check: false, pair: false, help: false };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--help') result.help = true;
    else if (argument === '--check') result.check = true;
    else if (argument === '--pair') result.pair = true;
    else if (['--config', '--from'].includes(argument) && args[index + 1] && !args[index + 1].startsWith('--')) {
      const key = argument.slice(2); if (key === 'from' && result.from) throw new Error('Use --from only once.');
      result[key] = resolve(args[++index]);
    } else throw new Error('Unsupported setup argument. Run setup:host --help for the supported flags.');
  }
  if (result.check && result.pair || result.from && (result.check || result.pair)) throw new Error('Use --check or --pair with an existing config; --from creates a new one.');
  return result;
}

export async function setup(args = process.argv.slice(2)) {
  const options = setupArguments(args);
  if (options.help) {
    process.stdout.write('Run bun run setup:host to configure, check, and start a workspace.\n'
      + '  --config PATH  Private config path; default ~/.config/perch/workspace.json\n'
      + '  --from PATH    Create a new config from a private setup JSON file\n'
      + '  --check        Verify an existing config and local adapters, then exit\n'
      + '  --pair         Verify local adapters and print an existing workspace pairing code, then exit\n'
      + 'Provider and adapter credentials must be entered in the terminal or supplied in a private file.\n');
    return;
  }
  let exists = true;
  try { await access(options.config, constants.F_OK); } catch (error) { if (error.code === 'ENOENT') exists = false; else throw error; }
  if (exists && options.from) throw new Error('The config already exists. It was not overwritten; edit its private connection list to add adapters.');
  if (!exists && (options.check || options.pair)) throw new Error('Run the setup once to create this workspace config.');
  const config = exists ? await readConfiguration(options.config) : options.from ? await readSetupInput(options.from) : await interactiveSetup();
  process.stdout.write(`\nChecking ${config.connections.length} configured connection${config.connections.length === 1 ? '' : 's'} without a model request…\n`);
  const results = await Promise.allSettled(config.connections.map(item => probeConnection(item)));
  let failures = 0;
  results.forEach((result, index) => {
    const item = config.connections[index];
    if (result.status === 'fulfilled') process.stdout.write(`${item.name}: ${result.value.status === 'verified' ? 'local adapter verified' : 'invitation format checked; live sharing is verified when the phone joins'}\n`);
    else { failures++; process.stderr.write(`${item.name}: local check failed. Confirm the adapter is running and its private credentials match.\n`); }
  });
  if (failures) throw new Error('Workspace setup is incomplete. No pairing code was issued. Fix the failed local adapters and run the same setup again.');
  if (!exists) { await writeConfiguration(options.config, config); process.stdout.write(`Private workspace configuration saved to ${options.config}.\n`); }
  if (options.check) { process.stdout.write('Local workspace checks passed. No configuration or pairing credential was changed.\n'); return; }
  if (!options.pair) runWorkspace(config);
  process.stdout.write('\nOn the phone, choose Self-hosted and paste this pairing code:\n');
  process.stdout.write(pairingCode(config) + '\n');
  process.stdout.write('\nKeep this code private. The public HTTPS address must forward to the workspace listener; local checks do not verify your reverse proxy.\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await setup(); }
  catch (error) { process.stderr.write(`${error?.name === 'AbortError' ? 'Setup cancelled.' : error.message}\n`); process.exitCode = 1; }
}
