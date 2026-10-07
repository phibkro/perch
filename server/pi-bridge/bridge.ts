import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { BRIDGE_PROTOCOL, MAX_FRAME_BYTES, parseClientFrame, type BridgeCommand, type BridgeServerFrame } from '../../src/harness/protocol';
import { PiProjector } from './projector';
import { PiRpc } from './rpc';

export interface BridgeOptions {
  token: string;
  binary: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  host?: string;
  port?: number;
  allowedOrigins?: string[];
  version?: string;
}

function permitsOrigin(origin: string | undefined, authority: string | undefined, allowed: string[] = []): boolean {
  if (!origin || allowed.includes(origin)) return true;
  if (!authority) return false;
  try {
    const source = new URL(origin);
    if (!['http:', 'https:'].includes(source.protocol) || source.username || source.password ||
      source.pathname !== '/' || source.search || source.hash) return false;
    // React Native derives an HTTP(S) Origin from its WebSocket endpoint.
    // URL parsing normalizes casing, IPv6, and explicit default ports. Browsers
    // cannot forge Host; this check is additional to mandatory token auth.
    const endpoint = new URL(source.protocol + '//' + authority);
    if (endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) return false;
    return source.host === endpoint.host;
  } catch { return false; }
}

export async function startBridge(options: BridgeOptions) {
  if (options.token.length < 24) throw new Error('PERCH_BRIDGE_TOKEN must have at least 24 characters.');
  const secret = createHash('sha256').update(options.token).digest();
  const projector = new PiProjector(options.cwd, options.version);
  const agentEnv = { ...(options.env ?? process.env) };
  // The agent needs provider credentials, not the bridge's administrative secret.
  delete agentEnv.PERCH_BRIDGE_TOKEN;
  const rpc = new PiRpc(options.binary, options.args, { cwd: options.cwd, env: agentEnv });
  const epoch = randomUUID();
  let revision = 0;
  let ready = false;
  let closing = false;
  let publication: NodeJS.Timeout | undefined;
  let questionTimer: NodeJS.Timeout | undefined;
  const authenticated = new Set<WebSocket>();
  const actions = new Map<string, Promise<BridgeServerFrame>>();
  const server = createServer((request, response) => {
    if (request.url === '/health') { response.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' }); response.end(JSON.stringify({ status: ready ? 'ready' : 'starting', protocol: BRIDGE_PROTOCOL })); }
    else { response.writeHead(404); response.end('Not found'); }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
  function send(socket: WebSocket, frame: BridgeServerFrame) {
    if (socket.readyState !== WebSocket.OPEN) return;
    const payload = JSON.stringify(frame);
    if (Buffer.byteLength(payload) > MAX_FRAME_BYTES || socket.bufferedAmount > MAX_FRAME_BYTES) { socket.close(1009, 'Snapshot exceeds the prototype limit'); return; }
    socket.send(payload);
  }
  function snapshot(socket: WebSocket) { send(socket, { type: 'snapshot', protocol: BRIDGE_PROTOCOL, epoch, revision, state: projector.snapshot() }); }
  function publish(immediate = false) {
    if (publication) { if (!immediate) return; clearTimeout(publication); }
    const flush = () => { publication = undefined; ++revision; for (const socket of authenticated) snapshot(socket); };
    if (immediate) flush(); else publication = setTimeout(flush, 24);
  }
  rpc.on('record', (event: Record<string, unknown>) => {
    projector.event(event);
    if (event.type === 'extension_ui_request' && ['select', 'confirm', 'input', 'editor'].includes(String(event.method)) && projector.snapshot().pendingQuestion) {
      clearTimeout(questionTimer);
      const questionId = projector.snapshot().pendingQuestion!.id;
      if (typeof event.timeout === 'number' && event.timeout > 0) questionTimer = setTimeout(() => { projector.clearQuestion(questionId); publish(true); }, Math.min(event.timeout, 2_147_483_647));
    }
    if (event.type === 'agent_settled' && ready) void rpc.command('get_state').then(value => { projector.setState(value, false); publish(); }).catch(() => {});
    publish();
  });
  rpc.on('failure', (error: Error) => { ready = false; projector.setConnection('ended', 'pi process ended', error.message); publish(true); });

  async function action(command: BridgeCommand): Promise<BridgeServerFrame> {
    if (!ready) return { type: 'error', id: command.id, error: 'The pi process is not ready.' };
    try {
      const state = projector.snapshot();
      if (command.type === 'prompt') {
        if (state.pendingQuestion) throw new Error('Answer the current host question first.');
        await rpc.command('prompt', { message: command.text, ...(state.isWorking ? { streamingBehavior: 'steer' } : {}) });
      } else if (command.type === 'interrupt') {
        const cancel = projector.cancelQuestion();
        if (cancel) { await rpc.write(cancel); projector.clearQuestion(); }
        // pi abort alone may continue queued work. Clear first to honor a stop action.
        const cleared = await rpc.command('clear_queue');
        if (cleared && typeof cleared === 'object') {
          const queues = cleared as { steering?: unknown[]; followUp?: unknown[] };
          const texts = [...(queues.steering ?? []), ...(queues.followUp ?? [])].filter(t => typeof t === 'string');
          if (texts.length) projector.notice(`Stopped queued messages (not resent):\n${texts.join('\n')}`);
        }
        await rpc.command('abort'); publish(true);
      } else if (command.type === 'answer') {
        const response = projector.response(command.questionId, command.answer); publish(true);
        try {
          await rpc.write(response);
          // pi has no response acknowledgment for this record. Clear only after successful pipe write.
          projector.clearQuestion(command.questionId); clearTimeout(questionTimer); publish(true);
        } catch (error) { projector.resetAnswering(command.questionId); publish(true); throw error; }
      } else if (command.type === 'set-model') {
        if (state.isWorking || state.pendingQuestion) throw new Error('Wait until the current operation finishes before changing model.');
        if (!state.availableModels?.some(m => m.id === command.modelId && m.provider === command.provider)) throw new Error('That model is not configured on this pi host.');
        await rpc.command('set_model', { provider: command.provider, modelId: command.modelId });
        projector.setState(await rpc.command('get_state'), false); publish(true);
      }
      return { type: 'ack', id: command.id };
    } catch (error) { return { type: 'error', id: command.id, error: error instanceof Error ? error.message : 'Command failed.' }; }
  }

  server.on('upgrade', (request, socket, head) => {
    const origin = request.headers.origin;
    if (request.url !== '/session' || !permitsOrigin(origin, request.headers.host, options.allowedOrigins) || wss.clients.size >= 16) { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws));
  });
  wss.on('connection', socket => {
    let isAuthenticated = false;
    let commands = 0;
    let windowStart = Date.now();
    const deadline = setTimeout(() => socket.close(4401, 'Authentication required'), 5000);
    socket.on('error', () => {});
    socket.on('close', () => { clearTimeout(deadline); authenticated.delete(socket); });
    socket.on('message', data => {
      let frame;
      try { frame = parseClientFrame(JSON.parse(data.toString())); }
      catch { socket.close(4400, 'Invalid protocol record'); return; }
      if (!isAuthenticated) {
        if (frame.type !== 'hello' || !timingSafeEqual(createHash('sha256').update(frame.token).digest(), secret)) { socket.close(4401, 'Authentication failed'); return; }
        isAuthenticated = true; clearTimeout(deadline); authenticated.add(socket); snapshot(socket); return;
      }
      if (frame.type === 'hello') { socket.close(4400, 'Already authenticated'); return; }
      if (Date.now() - windowStart > 1000) { commands = 0; windowStart = Date.now(); }
      if (++commands > 16) { send(socket, { type: 'error', id: frame.id, error: 'Too many commands. Wait before trying again.' }); return; }
      let outcome = actions.get(frame.id);
      if (!outcome) {
        outcome = action(frame); actions.set(frame.id, outcome);
        if (actions.size > 512) actions.delete(actions.keys().next().value!);
      }
      void outcome.then(result => send(socket, result));
    });
  });

  try {
    // Establish the baseline before accepting network connections. Events are already subscribed.
    projector.setState(await rpc.command('get_state', {}, 30_000));
    projector.hydrate(await rpc.command('get_messages', {}, 30_000));
    projector.setModels(await rpc.command('get_available_models', {}, 30_000));
    ready = true; projector.setConnection('live', 'Connected to pi');
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 8787, options.host ?? '127.0.0.1', resolve); });
  } catch (error) { await rpc.close(); throw error; }
  return {
    address: server.address(),
    snapshot: () => projector.snapshot(),
    async close() {
      if (closing) return; closing = true;
      clearTimeout(publication); clearTimeout(questionTimer);
      for (const socket of wss.clients) socket.terminate();
      await new Promise<void>(resolve => wss.close(() => resolve()));
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rpc.close();
    },
  };
}
