import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Use Mermaid's published browser build. Metro embeds this JSON as inert text;
// the renderer is evaluated only inside the isolated diagram document.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = path.join(root, 'node_modules', 'mermaid');
const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
if (manifest.name !== 'mermaid' || manifest.version !== '12.1.0') {
  throw new Error('The diagram renderer requires the reviewed mermaid@12.1.0 package. Run bun install --frozen-lockfile.');
}
const script = readFileSync(path.join(packageRoot, 'dist', 'mermaid.min.js'), 'utf8');
if (/<\/script/i.test(script)) throw new Error('The Mermaid browser build contains an HTML script boundary; review its embedding before updating.');
const sha256 = createHash('sha256').update(script).digest('hex');
const output = path.join(root, 'src', 'artifacts', 'generated', 'mermaid-runtime.json');
mkdirSync(path.dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify({ version: manifest.version, sha256, script }) + '\n');
console.log(`Prepared offline Mermaid ${manifest.version}: ${Buffer.byteLength(script).toLocaleString('en-US')} bytes, SHA-256 ${sha256}.`);
