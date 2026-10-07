import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import extract from 'extract-zip';
import { toolingRoot } from './environment.mjs';

const version = 'cli-2.11.0';
const releaseUrl = `https://github.com/mobile-dev-inc/Maestro/releases/download/${version}`;
const cache = path.join(toolingRoot, '.cache');
await fs.mkdir(cache, { recursive: true });
async function download(name) {
  const response = await fetch(`${releaseUrl}/${name}`);
  if (!response.ok) throw new Error(`Maestro download failed: ${response.status} ${response.statusText}`);
  return Buffer.from(await response.arrayBuffer());
}
const checksums = (await download('checksums_sha256.txt')).toString('utf8');
const checksumLine = checksums.split(/\r?\n/).find(line => /\bmaestro\.zip$/.test(line.trim()));
const expected = checksumLine?.match(/\b[a-fA-F0-9]{64}\b/)?.[0].toLowerCase();
if (!expected) throw new Error('Official Maestro release did not include a SHA-256 checksum for maestro.zip.');
const archive = await download('maestro.zip');
const actual = crypto.createHash('sha256').update(archive).digest('hex');
if (actual !== expected) throw new Error('Maestro archive checksum mismatch.');
const zipPath = path.join(cache, 'maestro.zip');
await fs.writeFile(zipPath, archive);
const dest = path.join(cache, 'maestro');
await fs.rm(dest, { recursive: true, force: true });
await extract(zipPath, { dir: dest });
await fs.chmod(path.join(dest, 'maestro/bin/maestro'), 0o755);
await fs.writeFile(path.join(dest, 'PROVENANCE.json'), JSON.stringify({ version, releaseUrl, sha256: actual }, null, 2) + '\n');
await fs.rm(zipPath);
console.log(`Installed Maestro ${version} in tooling/.cache/maestro; official SHA-256 verified.`);
