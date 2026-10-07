import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readConfiguration } from './configuration.mjs';
import { createWorkspaceGateway } from './gateway.mjs';

export function runWorkspace(config) {
  const gateway = createWorkspaceGateway(config);
  process.stdout.write(`Perch workspace listening on ${config.listen.hostname}:${gateway.server.port}. Pairing credentials are not logged.\n`);
  const stop = () => { void gateway.close().then(() => process.exit(0)); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  return gateway;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== '--config') throw new Error('Run: bun server/workspace/index.mjs --config /absolute/private/workspace.json');
    runWorkspace(await readConfiguration(resolve(args[1])));
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
