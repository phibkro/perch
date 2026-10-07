import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { developmentEnvironment, projectRoot, toolingRoot } from './environment.mjs';

const env = { ...developmentEnvironment(), CI: '1', EAS_NO_VCS: '1', EXPO_NO_TELEMETRY: '1' };
const checks = [];
function check(name, command, args, optional = false) {
  const result = spawnSync(command, args, { cwd: projectRoot, env, encoding: 'utf8', timeout: 25000 });
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
  checks.push({ name, status: result.status === 0 ? 'available' : optional ? 'not configured' : 'missing', output: result.error?.message || output });
}
check('Node', process.execPath, ['--version']);
check('Bun', process.platform === 'win32' ? 'bun.exe' : 'bun', ['--version']);
check('Java compiler', 'javac', ['-version']);
check('Android device inventory', 'adb', ['devices', '-l'], true);
const inventory = checks.at(-1);
if (inventory.status === 'available' && !/^[^\s]+\s+device(?:\s|$)/m.test(inventory.output)) inventory.status = 'no authorized device attached';
check('agent-device', process.execPath, [path.join(toolingRoot, 'run.mjs'), 'agent-device', '--version']);
check('Maestro', process.execPath, [path.join(toolingRoot, 'run.mjs'), 'maestro', '--version']);
check('EAS CLI', process.execPath, [path.join(toolingRoot, 'run.mjs'), 'eas', '--version']);
check('Expo account', process.execPath, [path.join(toolingRoot, 'run.mjs'), 'eas', 'whoami'], true);
const config = JSON.parse(fs.readFileSync(path.join(projectRoot, 'app.json'), 'utf8')).expo;
checks.push({ name: 'Expo project link', status: config.extra?.eas?.projectId ? 'configured' : 'not configured', output: config.extra?.eas?.projectId ? 'Project ID exists in app.json.' : 'No Expo project ID. Local builds work; hosted operations need an explicit account/project setup.' });
checks.push({ name: 'Over-the-air updates', status: config.updates?.enabled === false ? 'disabled' : 'inspect configuration', output: 'No update was published by this command.' });
for (const item of checks) console.log(`\n${item.name}: ${item.status}\n${item.output}`);
if (checks.some(item => item.status === 'missing')) process.exitCode = 1;
