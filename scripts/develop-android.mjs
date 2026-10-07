import { spawn } from 'node:child_process';
import { projectRoot, developmentEnvironment } from '../tooling/environment.mjs';
const child = spawn(process.execPath, ['node_modules/expo/bin/cli', 'run:android', '--variant', 'debug', '--app-id', 'dev.perch.assistant.dev', '--device', ...process.argv.slice(2)], {
  cwd: projectRoot, stdio: 'inherit', env: { ...developmentEnvironment(), NODE_ENV: 'development' },
});
child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1); });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { child.kill(signal); });
