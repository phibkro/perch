import { request as httpRequest, Agent } from 'node:http';
import { OmpRemoteBridge } from '../bridge.mjs';

export const TOKEN = 'test_omp_remote_private_adapter_token_1234567890';
export const CONFIG = { version: 1, id: 'omp_test', name: 'Existing terminal', hostId: 'host_test', hostName: 'Fixture host', token: TOKEN, port: 0 };
export const MODEL = { id: 'fixture-small', provider: 'fixture', name: 'Fixture Small', apiKey: 'never-project-this', baseUrl: 'https://private-provider.example' };
export const MODEL_TWO = { id: 'fixture-large', provider: 'fixture', name: 'Fixture Large' };

/** A direct loopback client; ambient proxy variables cannot receive the token. */
export function request(url, path, init = {}) {
  return new Promise((resolve, reject) => {
    const agent = new Agent({ keepAlive: false });
    const req = httpRequest(url + path, { method: init.method ?? 'GET', agent, signal: init.signal,
      headers: { Authorization: `Bearer ${TOKEN}`, ...init.headers } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => { agent.destroy(); resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })); });
    });
    req.on('error', failure => { agent.destroy(); reject(failure); });
    req.end(init.body);
  });
}

export const post = command => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command) });
export async function until(check, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!check()) { if (Date.now() > deadline) throw new Error('Timed out waiting for the fixture.'); await new Promise(resolve => setTimeout(resolve, 5)); }
}

export async function fixture(options = {}) {
  const state = { entries: [], sessionId: 'conversation_one', cwd: '/fixture/project', title: 'Host conversation', model: MODEL, idle: true, pending: false,
    prompts: [], aborts: 0, models: [], ...options.state };
  const context = { agent: { kind: 'main', id: 'Main' }, mode: 'tui', hasUI: true,
    sessionManager: { getSessionId: () => state.sessionId, getBranch: () => state.entries, getSessionName: () => state.title, getCwd: () => state.cwd },
    models: { list: () => [MODEL, MODEL_TWO], current: () => state.model },
    get cwd() { return state.cwd; }, get model() { return state.model; },
    isIdle: () => state.idle, hasPendingMessages: () => state.pending,
    abort() { state.aborts++; state.idle = true; void bridge.observe({ type: 'agent_end' }, context); },
  };
  const api = {
    sendUserMessage(text) {
      state.prompts.push(text);
      if (options.admit !== false) { state.idle = false; void bridge.observe({ type: 'agent_start' }, context); }
    },
    async setModel(model) { state.models.push(model); await options.setModel?.(model); state.model = model; return true; },
  };
  const bridge = new OmpRemoteBridge(api, CONFIG, { allowEphemeralPort: true, maxReceipts: options.maxReceipts });
  await bridge.observe({ type: 'session_start' }, context);
  return { state, context, api, bridge, url: bridge.url, close: () => bridge.close(),
    request: (path, init) => request(bridge.url, path, init),
    command: (id, type = 'prompt', extra = { text: 'Hello' }) => {
      const summary = bridge.catalog().sessions[0];
      return { id, epoch: bridge.epoch, generation: summary.generation, conversationId: summary.conversationId, type, ...extra };
    },
  };
}
