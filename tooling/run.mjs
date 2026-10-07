import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { developmentEnvironment, projectRoot, toolingRoot } from './environment.mjs';

const [tool, ...args] = process.argv.slice(2);
const entries = {
  'agent-device': path.join(toolingRoot, 'node_modules/agent-device/bin/agent-device.mjs'),
  eas: path.join(toolingRoot, 'node_modules/eas-cli/bin/run'),
  maestro: path.join(toolingRoot, '.cache/maestro/maestro/bin', process.platform === 'win32' ? 'maestro.bat' : 'maestro'),
};
const entry = entries[tool];
if (!entry) throw new Error('Expected agent-device, maestro, or eas.');
if (!fs.existsSync(entry)) throw new Error(`${tool} is not installed. Run bun install --cwd tooling --frozen-lockfile${tool === 'maestro' ? ' and node tooling/install-maestro.mjs' : ''}.`);
const child = spawn(tool === 'maestro' ? entry : process.execPath, tool === 'maestro' ? args : [entry, ...args], {
  cwd: projectRoot,
  env: developmentEnvironment(),
  stdio: 'inherit',
  shell: process.platform === 'win32' && tool === 'maestro',
});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1); });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { child.kill(signal); });
