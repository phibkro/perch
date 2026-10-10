import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createConfiguration, readConfiguration, validateConfiguration } from '../configuration.mjs';
import { main } from '../setup.mjs';
import { CONFIG } from './helpers.mjs';

const directories = [];
const temp = () => { const directory = mkdtempSync(join(tmpdir(), 'perch-omp-config-')); directories.push(directory); return directory; };
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

test('setup creates and reuses one private adapter credential without printing it', () => {
  const path = join(temp(), 'private', 'omp.json'), logged = [], log = console.log;
  console.log = value => logged.push(value);
  let first, second;
  try { first = main(['--config', path, '--name', 'A real project']); second = main(['--config', path]); }
  finally { console.log = log; }
  expect(second).toEqual(first); expect(first.name).toBe('A real project'); expect(first.port).toBe(4781);
  expect(readConfiguration(path)).toEqual(first);
  expect(logged.join('\n')).not.toContain(first.token);
  expect(logged.join('\n')).toContain('kind "remote"');
  if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(() => createConfiguration(path)).toThrow();
  expect(JSON.parse(readFileSync(path, 'utf8')).token).toBe(first.token);
});

test('private configuration rejects public files, links, checkout paths, and invalid protocol values', () => {
  const directory = temp(), path = join(directory, 'omp.json');
  createConfiguration(path);
  if (process.platform !== 'win32') {
    chmodSync(path, 0o644); expect(() => readConfiguration(path)).toThrow('0600'); chmodSync(path, 0o600);
    const link = join(directory, 'linked.json'); symlinkSync(path, link); expect(() => readConfiguration(link)).toThrow();
    const repoLink = join(directory, 'checkout'); symlinkSync(resolve(import.meta.dir, '../../..'), repoLink);
    expect(() => createConfiguration(join(repoLink, 'do-not-create-omp-credentials.json'))).toThrow('outside');
  }
  expect(() => createConfiguration(resolve(import.meta.dir, '../credentials.json'))).toThrow('outside');
  expect(() => validateConfiguration({ ...CONFIG, port: 4781, id: 123 })).toThrow('id');
  expect(() => validateConfiguration({ ...CONFIG, port: 4781, id: '_invalid' })).toThrow('id');
  expect(() => validateConfiguration({ ...CONFIG, port: 0 })).toThrow('port');
  expect(() => validateConfiguration({ ...CONFIG, port: 4781, token: 'too-short' })).toThrow('token');
  writeFileSync(path, JSON.stringify({ ...CONFIG, port: 4781, unexpected: 'no' }), { mode: 0o600 });
  expect(() => readConfiguration(path)).toThrow('Unexpected');
});
