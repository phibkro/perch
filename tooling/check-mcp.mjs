// Read-only MCP handshake and tool discovery; never invokes a device tool.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { projectRoot, developmentEnvironment } from './environment.mjs';

async function check(server) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['tooling/run.mjs', server, 'mcp'], { cwd: projectRoot, env: developmentEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    let finished = false;
    const timer = setTimeout(() => finish(new Error(`${server}: handshake timed out. ${stderr.slice(-1000)}`)), 25000);
    const lines = createInterface({ input: child.stdout });
    function finish(error, result) { if (finished) return; finished = true; clearTimeout(timer); lines.close(); child.stdin.end(); child.kill(); error ? reject(error) : resolve(result); }
    function send(message) { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n'); }
    child.stderr.on('data', (data) => { stderr += data.toString(); });
    child.on('error', (error) => finish(error));
    child.on('exit', (code) => { if (!finished) finish(new Error(`${server}: exited ${code}. ${stderr.slice(-1000)}`)); });
    lines.on('line', (line) => {
      if (!line.trim()) return;
      let response; try { response = JSON.parse(line); } catch { return finish(new Error(`${server}: non-JSON output on MCP stdout: ${line.slice(0, 160)}`)); }
      if (response.error) return finish(new Error(`${server}: ${JSON.stringify(response.error)}`));
      if (response.id === 1) { send({ method: 'notifications/initialized' }); send({ id: 2, method: 'tools/list', params: {} }); }
      if (response.id === 2) finish(null, { server, toolCount: response.result.tools.length, tools: response.result.tools.map((tool) => tool.name) });
    });
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'perch-tooling-check', version: '0.2.0' } } });
  });
}
for (const server of ['agent-device', 'maestro']) {
  try { console.log(JSON.stringify(await check(server))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
