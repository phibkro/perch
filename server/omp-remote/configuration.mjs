import { constants, openSync, readFileSync, closeSync, fstatSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const repository = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/;
const isRecord = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value, name, limit) => {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`Invalid ${name}.`);
  return value;
};

export function validateConfiguration(value, { allowEphemeralPort = false } = {}) {
  if (!isRecord(value) || value.version !== 1) throw new Error('Expected an OMP remote configuration with version 1.');
  const allowed = new Set(['version', 'id', 'name', 'hostId', 'hostName', 'token', 'port']);
  if (Object.keys(value).some(key => !allowed.has(key))) throw new Error('Unexpected OMP remote configuration field.');
  for (const field of ['id', 'hostId']) if (typeof value[field] !== 'string' || !ID.test(value[field])) throw new Error(`Invalid ${field}.`);
  const name = text(value.name, 'name', 160), hostName = text(value.hostName, 'hostName', 160);
  if (typeof value.token !== 'string' || !/^[a-zA-Z0-9_-]{32,256}$/.test(value.token)) throw new Error('The adapter token must contain 32–256 URL-safe characters.');
  if (!Number.isSafeInteger(value.port) || value.port < (allowEphemeralPort ? 0 : 1024) || value.port > 65535) throw new Error('The adapter port must be between 1024 and 65535.');
  return Object.freeze({ version: 1, id: value.id, name, hostId: value.hostId, hostName, token: value.token, port: value.port });
}

function privatePath(path) {
  if (!isAbsolute(path)) throw new Error('Use an absolute private configuration path.');
  const result = resolve(path), rel = relative(repository, result);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) throw new Error('Store credentials outside the Perch checkout.');
  try {
    const canonical = resolve(realpathSync(dirname(result)), basename(result));
    const actual = relative(realpathSync(repository), canonical);
    if (actual === '' || (!actual.startsWith('..') && !isAbsolute(actual))) throw new Error('Store credentials outside the Perch checkout, including through directory links.');
  } catch (failure) { if (failure.code !== 'ENOENT') throw failure; }
  return result;
}

export function readConfiguration(path) {
  const target = privatePath(path);
  const fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 16_384) throw new Error('Expected a small, regular configuration file.');
    if (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid())) throw new Error('The configuration must be owned by this user with mode 0600.');
    return validateConfiguration(JSON.parse(readFileSync(fd, 'utf8')));
  } finally { closeSync(fd); }
}

export function createConfiguration(path, { name = 'OMP in this terminal', hostName = 'My host', port = 4781 } = {}) {
  const target = privatePath(path);
  const config = validateConfiguration({ version: 1, id: `omp_${randomUUID().replaceAll('-', '')}`, name,
    hostId: `host_${randomUUID().replaceAll('-', '')}`, hostName, token: randomBytes(32).toString('base64url'), port });
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  privatePath(target);
  writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return config;
}
