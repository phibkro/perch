import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';

// A separate entry point is required for synthetic providers. Production never
// reads a fixture flag and cannot silently fall back to a fake model.
const entry = process.argv[2] ?? 'src/worker.mjs';
const outfile = process.argv[3] ?? 'dist/worker.mjs';
const result = await build({
  entryPoints: [entry], outfile, bundle: true, format: 'esm', platform: 'browser',
  target: 'es2022', conditions: ['workerd', 'worker', 'browser'],
  tsconfigRaw: { compilerOptions: {} }, external: ['cloudflare:*', 'node:*'],
  metafile: true, sourcemap: 'external', legalComments: 'eof', logLevel: 'info',
});
await mkdir('dist', { recursive: true });
await writeFile('dist/metafile.json', JSON.stringify(result.metafile, null, 2) + '\n');
