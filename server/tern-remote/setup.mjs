import { constants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, open, realpath, writeFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, '../..');
const owned = stat => process.platform === 'win32' || stat.uid === process.getuid();
const inside = (parent, path) => {
  const result = relative(parent, path);
  return result === '' || (result !== '..' && !result.startsWith(`..${sep}`) && !isAbsolute(result));
};

async function privatePath(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('Use an absolute private Tern configuration path.');
  const target = resolve(path);
  if (inside(repository, target)) throw new Error('Store Tern credentials outside the Perch checkout.');
  // Resolve the nearest existing ancestor as well, so a directory link cannot
  // place a new nested secret inside the checkout before mkdir has run.
  let ancestor = target;
  const missing = [];
  let canonical;
  while (true) {
    try { canonical = resolve(await realpath(ancestor), ...missing); break; }
    catch (error) {
      if (error.code !== 'ENOENT' || dirname(ancestor) === ancestor) throw error;
      missing.unshift(basename(ancestor)); ancestor = dirname(ancestor);
    }
  }
  if (inside(await realpath(repository), canonical)) throw new Error('Store Tern credentials outside the Perch checkout, including through directory links.');
  return target;
}

export async function readPrivateConfig(path) {
  const target = await privatePath(path);
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 16_384 || !owned(stat) ||
        (process.platform !== 'win32' && (stat.mode & 0o077))) throw new Error('Tern bridge config must be a regular file owned by this user with mode 0600.');
    const config = JSON.parse(await handle.readFile('utf8'));
    if (!config || typeof config !== 'object' || !Number.isSafeInteger(config.port) || config.port < 1024 || config.port > 65535 ||
        typeof config.pluginDirectory !== 'string' || (config.readOnly !== undefined && typeof config.readOnly !== 'boolean')) {
      throw new Error('Invalid Tern bridge config. Run setup again.');
    }
    await privatePath(config.pluginDirectory);
    return config;
  } finally { await handle.close(); }
}

/** Idempotent host setup; existing credentials are retained, never logged. */
export async function setupTernRemote({ configPath = join(homedir(), '.config/perch/tern-remote.json'),
  pluginDirectory = join(homedir(), '.config/perch/tern-plugin'), port = 4782 } = {}) {
  configPath = await privatePath(configPath); pluginDirectory = await privatePath(pluginDirectory);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('The Tern bridge port must be between 1024 and 65535.');
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  await privatePath(configPath);
  let config;
  try { config = await readPrivateConfig(configPath); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    config = { port, host: { id: `tern-${randomUUID()}`, name: `${hostname()} · Tern` },
      token: randomBytes(32).toString('base64url'), pluginToken: randomBytes(32).toString('base64url'), pluginDirectory };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  }
  pluginDirectory = await privatePath(config.pluginDirectory);
  await mkdir(pluginDirectory, { recursive: true, mode: 0o700 });
  await privatePath(pluginDirectory);
  const directoryStat = await lstat(pluginDirectory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || !owned(directoryStat)) throw new Error('The plugin directory must be a real directory owned by this user.');
  await chmod(pluginDirectory, 0o700);
  for (const name of ['plugin.toml', 'window.luau']) {
    const target = join(pluginDirectory, name);
    try {
      const stat = await lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink() || !owned(stat)) throw new Error('Plugin setup only replaces regular files owned by this user.');
    }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await copyFile(join(here, 'plugin', name), target);
    await chmod(target, 0o600);
  }
  const target = join(pluginDirectory, 'connection.json');
  const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !owned(stat)) throw new Error('The plugin connection must be a regular file owned by this user.');
    await handle.chmod(0o600);
    await handle.truncate(0);
    await handle.writeFile(`${JSON.stringify({ url: `http://127.0.0.1:${config.port}`, token: config.pluginToken }, null, 2)}\n`);
  } finally { await handle.close(); }
  return { configPath, pluginDirectory, port: config.port };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--config', '--plugin-dir'].includes(args[i]) || !args[i + 1]) {
      console.error('Usage: bun server/tern-remote/setup.mjs [--config /path] [--plugin-dir /path]'); process.exit(1);
    }
    options[args[i] === '--config' ? 'configPath' : 'pluginDirectory'] = args[i + 1];
  }
  setupTernRemote(options).then(result => {
    console.log(`Private bridge config: ${result.configPath}`);
    console.log(`Plugin directory: ${result.pluginDirectory}`);
    console.log('Link that directory with `tern plugin link`, then run server/tern-remote/index.mjs.');
    console.log(`Workspace upstream: http://127.0.0.1:${result.port}; use the adapter token in the private bridge config.`);
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
