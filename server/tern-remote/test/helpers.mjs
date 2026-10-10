import { request } from 'node:http';

export const DEVICE_TOKEN = 'device-fixture-token-01234567890123456789';
export const PLUGIN_TOKEN = 'plugin-fixture-token-01234567890123456789';

export function requestJSON(origin, path, { method = 'GET', token = DEVICE_TOKEN, value, raw, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const bytes = raw ?? (value === undefined ? undefined : JSON.stringify(value));
    const req = request(`${origin}${path}`, { method, agent: false,
      headers: { Authorization: `Bearer ${token}`, ...(bytes === undefined ? {} : {
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bytes) }), ...headers } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        try { resolve({ status: response.statusCode, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
        catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.end(bytes);
  });
}

export async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return `http://127.0.0.1:${server.address().port}`;
}

export const agent = { pane: 2, generation: '1', title: 'Existing OMP', cwd: '/project', state: 'idle', harness: 'omp',
  model: 'Host model', location: { workspace: 'Default', tab: 'Work', pane: '2' } };

export const detail = { pane: 2, generation: '1', canPrompt: true, canInterrupt: true, truncated: false, notices: [],
  messages: [{ role: 'user', text: 'Existing question', tools: [] },
    { role: 'assistant', text: '# Existing artifact\n\nProduced on the host.', tools: [{ name: 'bash', target: 'pwd', status: 'done', text: '/project' }] }] };

export async function register(origin) {
  const result = await requestJSON(origin, '/tern/register', { method: 'POST', token: PLUGIN_TOKEN,
    value: { protocol: 'perch-tern-plugin', version: 1 } });
  if (result.status !== 200) throw new Error(`Plugin register failed: ${JSON.stringify(result)}`);
  return result.value.bridgeId;
}

export function exchange(origin, bridgeId, sequence, extra = {}) {
  return requestJSON(origin, '/tern/exchange', { method: 'POST', token: PLUGIN_TOKEN,
    value: { protocol: 'perch-tern-plugin', version: 1, bridgeId, sequence, agents: [agent], detail, receipts: [], ...extra } });
}
