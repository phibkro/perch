import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { readPrivateConfig } from './setup.mjs';
import { createTernRemoteServer } from './bridge.mjs';

const args = process.argv.slice(2);
if (args.length && !(args.length === 2 && args[0] === '--config')) {
  console.error('Usage: bun server/tern-remote/index.mjs [--config /path/to/tern-remote.json]');
  process.exit(1);
}
try {
  const configPath = resolve(args[1] ?? `${homedir()}/.config/perch/tern-remote.json`);
  const config = await readPrivateConfig(configPath);
  const server = createTernRemoteServer(config);
  server.on('error', error => { console.error(`Tern bridge failed: ${error.code ?? 'listen error'}`); process.exitCode = 1; });
  server.listen(config.port, '127.0.0.1', () => {
    console.log(`Perch Tern remote bridge: http://127.0.0.1:${config.port}`);
    console.log('Keep the configured Tern window open. Model credentials remain in the host OMP process.');
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => process.exit(0)));
} catch (error) { console.error(error.message); process.exitCode = 1; }
