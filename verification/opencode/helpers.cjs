const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const project = path.resolve(__dirname, '../..');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label, timeout = 10_000) {
  const start = Date.now();
  while (!predicate()) { if (Date.now() - start > timeout) throw new Error(`Timed out: ${label}`); await wait(20); }
}
function compile() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'perch-opencode-build-'));
  execFileSync(process.execPath, [path.join(project, 'node_modules/typescript/bin/tsc'), 'src/session/opencode.ts', 'src/session/store.ts', '--outDir', directory, '--module', 'commonjs', '--target', 'es2022', '--lib', 'es2023,dom', '--esModuleInterop', '--skipLibCheck', '--strict'], { cwd: project, stdio: 'pipe' });
  return { ...require(path.join(directory, 'session/opencode.js')), SessionStore: require(path.join(directory, 'session/store.js')).SessionStore, projection: require(path.join(directory, 'session/opencode/projection.js')), close() { fs.rmSync(directory, { recursive: true, force: true }); } };
}
async function listen(server) { server.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); return `http://127.0.0.1:${server.address().port}`; }
async function close(server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
module.exports = { assert, fs, path, os, project, wait, until, compile, listen, close };
