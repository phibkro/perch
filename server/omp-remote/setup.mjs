import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConfiguration, readConfiguration } from './configuration.mjs';

export function main(args = process.argv.slice(2)) {
  const values = { config: join(homedir(), '.config', 'perch', 'omp-remote.json'), name: 'OMP in this terminal', hostName: 'My host', port: 4781 };
  const flags = { '--config': 'config', '--name': 'name', '--host-name': 'hostName', '--port': 'port' };
  for (let index = 0; index < args.length; index++) {
    const field = flags[args[index]];
    if (!field || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error('Usage: bun setup.mjs [--config /private/omp-remote.json] [--name NAME] [--host-name NAME] [--port PORT]');
    values[field] = field === 'port' ? Number(args[++index]) : args[++index];
  }
  let config;
  try { config = readConfiguration(values.config); }
  catch (error) { if (error.code !== 'ENOENT') throw error; config = createConfiguration(values.config, values); }
  const extension = fileURLToPath(new URL('./extension.ts', import.meta.url));
  console.log(`Private adapter configuration ready: ${values.config}`);
  console.log(`Adapter: ${config.name}; loopback listener: 127.0.0.1:${config.port}`);
  console.log('Start OMP in the project terminal with PERCH_OMP_CONFIG set to that path and --extension pointing to:');
  console.log(extension);
  console.log('Add a workspace connection with kind "remote", that listener, and the adapter token from the private file.');
  console.log('The adapter token is not printed here. The workspace gateway gives the phone its separate pairing credential.');
  return config;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
