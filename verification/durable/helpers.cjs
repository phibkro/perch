const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const project = path.resolve(__dirname, '../..');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label, timeout = 10_000) {
  const start = Date.now();
  while (!predicate()) { if (Date.now() - start > timeout) throw new Error(`Timed out: ${label}`); await wait(15); }
}
function compile() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'perch-durable-build-'));
  try {
    execFileSync(process.execPath, [path.join(project, 'node_modules/typescript/bin/tsc'), 'src/session/durable.ts', 'src/session/store.ts', '--outDir', directory, '--module', 'commonjs', '--target', 'es2022', '--lib', 'es2023,dom', '--esModuleInterop', '--skipLibCheck', '--strict'], { cwd: project, stdio: 'pipe' });
    return { ...require(path.join(directory, 'session/durable.js')), projection: require(path.join(directory, 'session/durable/projection.js')), SessionStore: require(path.join(directory, 'session/store.js')).SessionStore, close() { fs.rmSync(directory, { recursive: true, force: true }); } };
  } catch (error) { fs.rmSync(directory, { recursive: true, force: true }); throw error; }
}
async function listen(server) { server.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); return `http://127.0.0.1:${server.address().port}`; }
async function close(server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
module.exports = { assert, wait, until, compile, listen, close };
