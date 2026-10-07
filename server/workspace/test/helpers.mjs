import { prepareConfiguration } from '../configuration.mjs';
import { createWorkspaceGateway } from '../gateway.mjs';

export const WORKSPACE_TOKEN = 'public-workspace-test-token-at-least-32-characters';
export const PI_TOKEN = 'public-pi-test-upstream-token-at-least-24-characters';
export const OPENCODE_PASSWORD = 'public-opencode-gateway-test-password';
export const OMP_INVITE = `test-room-12345.${Buffer.alloc(48, 7).toString('base64url')}`;
export const basic = (user, password) => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
export const json = (value, options = {}) => new Response(JSON.stringify(value), { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
export function config(connections, extra = {}) {
  return { ...prepareConfiguration({ name: 'Test workspace', publicUrl: 'http://127.0.0.1', connections,
    listen: { hostname: '127.0.0.1', port: 0 }, allowedOrigins: ['https://phone.example.com'] }), token: WORKSPACE_TOKEN, ...extra };
}
export function gateway(connections, extra) {
  const input = config(connections, extra); const handle = createWorkspaceGateway(input);
  const mount = new URL(input.publicUrl).pathname.replace(/\/+$/, '');
  const base = `http://127.0.0.1:${handle.server.port}${mount}`;
  return { ...handle, config: input, base,
    request(path, options = {}) {
      return fetch(base + path, { proxy: false, redirect: 'error', ...options,
        headers: { Authorization: `Bearer ${WORKSPACE_TOKEN}`, ...options.headers } });
    },
  };
}
export const piSnapshot = () => ({ type: 'snapshot', protocol: 1, epoch: 'test-epoch', revision: 1,
  state: {
    harness: { id: 'pi', name: 'Pi', transport: 'pi-rpc' },
    capabilities: { prompt: true, interrupt: true, questions: true, steer: false, attachments: false, modelSelection: true, sessionSelection: false },
    connection: { status: 'live', label: 'Connected' }, session: { id: 'pi_one', title: 'Test Pi', project: 'Workspace', status: 'idle' },
    model: { id: 'test', provider: 'local' }, availableModels: [{ id: 'test', provider: 'local' }],
    messages: [], tools: [], agents: [], pendingQuestion: null, isWorking: false, readOnly: false,
  },
});
export function piFixture() {
  const frames = []; let opened = 0; let closed = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0,
    fetch(request, instance) { if (new URL(request.url).pathname === '/session' && instance.upgrade(request)) return; return new Response(null, { status: 404 }); },
    websocket: {
      open() { opened++; }, close() { closed++; },
      message(socket, message) {
        const frame = JSON.parse(message); frames.push(frame);
        if (frame.type === 'hello') {
          if (frame.token !== PI_TOKEN) { socket.close(4401, 'Wrong fixture credential'); return; }
          socket.send(JSON.stringify(piSnapshot()));
        } else socket.send(JSON.stringify({ type: 'ack', id: frame.id }));
      },
    },
  });
  return { frames, get opened() { return opened; }, get closed() { return closed; },
    connection: { id: 'pi', name: 'Pi', kind: 'pi', upstream: { url: `ws://127.0.0.1:${server.port}/session`, token: PI_TOKEN } },
    close: () => server.stop(true),
  };
}
export async function until(predicate, description = 'condition', timeout = 2000) {
  const end = Date.now() + timeout;
  while (!predicate()) { if (Date.now() >= end) throw new Error(`Timed out waiting for ${description}`); await Bun.sleep(5); }
}
export async function client(url, options) {
  const frames = []; let closeEvent;
  const socket = new WebSocket(url, options);
  socket.onmessage = event => frames.push(JSON.parse(event.data));
  socket.onclose = event => { closeEvent = event; };
  socket.onerror = () => {};
  await until(() => socket.readyState !== WebSocket.CONNECTING, 'WebSocket open');
  return { socket, frames, get closeEvent() { return closeEvent; }, send(frame) { socket.send(JSON.stringify(frame)); }, close: () => socket.terminate() };
}
