import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { REMOTE_PROTOCOL, REMOTE_VERSION, MAX_REMOTE_COMMAND_BYTES, parseRemoteCommand, isRemoteId } from '../../src/harness/remote.ts';
import { validateConfiguration } from './configuration.mjs';
import { LIMITATIONS, MAX_ROWS, liveMessage, liveTool, projectSnapshot, sessionSummary } from './projection.mjs';

export const MAX_RECEIPTS = 4096;
const headers = Object.freeze({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'" });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers });
const error = (message, status) => json({ error: message }, status);
const identity = command => ({ id: command.id, epoch: command.epoch, generation: command.generation,
  ...(command.conversationId === undefined ? {} : { conversationId: command.conversationId }) });
const fingerprint = command => createHash('sha256').update(JSON.stringify(command)).digest('hex');
const authorized = (request, token) => {
  const expected = Buffer.from(`Bearer ${token}`), actual = Buffer.from(request.headers.get('Authorization') ?? '');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};

async function readCommand(request) {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw Object.assign(new Error('Expected application/json.'), { status: 415 });
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_REMOTE_COMMAND_BYTES)) throw Object.assign(new Error('Command body is too large.'), { status: 413 });
  if (!request.body) throw Object.assign(new Error('Expected a command body.'), { status: 400 });
  const reader = request.body.getReader(), chunks = [];
  let length = 0;
  const deadline = setTimeout(() => { void reader.cancel('Command body timed out.'); }, 10_000);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_REMOTE_COMMAND_BYTES) { await reader.cancel(); throw Object.assign(new Error('Command body is too large.'), { status: 413 }); }
      chunks.push(value);
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    return parseRemoteCommand(JSON.parse(text));
  } finally { clearTimeout(deadline); reader.releaseLock(); }
}

/** One authenticated projection over an already-created, extension-owned OMP session. */
export class OmpRemoteBridge {
  #api;
  #config;
  #context;
  #server;
  #epoch = randomUUID();
  #generation = randomUUID();
  #revision = 0;
  #eventSequence = 0;
  #conversation;
  #live;
  #tools = new Map();
  #approvals = new Set();
  #receipts = new Map();
  #maxReceipts;
  #mutationPending = false;
  #admissionPending = false;
  #models = [];
  #modelsReadAt = 0;

  constructor(api, config, { allowEphemeralPort = false, maxReceipts = MAX_RECEIPTS } = {}) {
    this.#api = api;
    this.#config = validateConfiguration(config, { allowEphemeralPort });
    this.#maxReceipts = maxReceipts;
  }

  get url() { return this.#server ? `http://127.0.0.1:${this.#server.port}` : undefined; }
  get epoch() { return this.#epoch; }

  beforeTransition(context) {
    if (context.agent.kind === 'main' && (this.#mutationPending || this.#admissionPending)) return { cancel: true };
    return undefined;
  }

  /** Deliberate host-only recovery; never called on a phone reconnect. */
  resetAdmission(context) {
    if (context.agent.kind !== 'main' || this.#mutationPending || !context.isIdle() || context.hasPendingMessages()) return false;
    this.#updateContext(context, true);
    return true;
  }

  #updateContext(context, reset = false) {
    const conversation = context.sessionManager.getSessionId();
    if (reset || (this.#conversation !== undefined && conversation !== this.#conversation)) {
      this.#generation = randomUUID();
      this.#live = undefined;
      this.#tools.clear();
      this.#approvals.clear();
      this.#admissionPending = false;
      this.#modelsReadAt = 0;
    }
    this.#context = context;
    this.#conversation = conversation;
  }

  #refreshModels() {
    if (!this.#context) return;
    if (Date.now() - this.#modelsReadAt > 5000) {
      this.#models = this.#context.models.list();
      this.#modelsReadAt = Date.now();
    }
  }

  /** Registered only through public ExtensionAPI lifecycle and message events. */
  async observe(event, context) {
    if (context.agent.kind !== 'main') return;
    if (event.type === 'session_shutdown') { await this.close(); return; }
    const order = ++this.#eventSequence;
    this.#updateContext(context, event.type === 'session_switch' || event.type === 'session_branch' || event.type === 'session_tree' || event.type === 'session_compact');
    if (event.type === 'session_start') {
      this.#refreshModels();
      if (!this.#server) this.#server = Bun.serve({ hostname: '127.0.0.1', port: this.#config.port,
        maxRequestBodySize: MAX_REMOTE_COMMAND_BYTES, idleTimeout: 15, fetch: request => this.fetch(request),
        error: () => error('The OMP remote adapter could not complete this request.', 500) });
    }
    if (event.type === 'agent_start') this.#admissionPending = false;
    if (event.type === 'message_start' || event.type === 'message_update' || event.type === 'message_end') {
      if (event.message.role === 'assistant') this.#live = { ...liveMessage(event.message, context.sessionManager.getBranch(), this.#live,
        event.type !== 'message_end', event.type === 'message_start'), order };
    }
    if (event.type === 'tool_execution_start' || event.type === 'tool_execution_update' || event.type === 'tool_execution_end') {
      const item = liveTool(event);
      if (item) {
        const previous = this.#tools.get(item.tool.id);
        this.#tools.set(item.tool.id, { ...item, order, tool: { ...previous?.tool, ...item.tool,
          ...(previous?.tool.artifact && !item.tool.artifact ? { artifact: previous.tool.artifact } : {}) } });
        while (this.#tools.size > MAX_ROWS) this.#tools.delete(this.#tools.keys().next().value);
      }
    }
    if (event.type === 'tool_approval_requested') this.#approvals.add(event.toolCallId);
    if (event.type === 'tool_approval_resolved') this.#approvals.delete(event.toolCallId);
    if (event.type === 'agent_end') {
      this.#admissionPending = false;
      this.#approvals.clear();
      for (const [id, item] of this.#tools) if (item.tool.status === 'running') this.#tools.set(id, { ...item, tool: { ...item.tool, status: 'unknown' } });
      if (this.#live) this.#live.streaming = false;
    }
  }

  health() {
    return { protocol: REMOTE_PROTOCOL, version: REMOTE_VERSION, host: { id: this.#config.hostId, name: this.#config.hostName },
      adapter: 'omp', epoch: this.#epoch, synchronization: 'snapshot', limitations: [...LIMITATIONS] };
  }

  catalog() {
    if (this.#context) this.#updateContext(this.#context);
    return { protocol: REMOTE_PROTOCOL, version: REMOTE_VERSION, epoch: this.#epoch, revision: ++this.#revision,
      sessions: this.#context ? [sessionSummary(this.#config, this.#generation, this.#context, this.#approvals.size > 0)] : [] };
  }

  snapshot() {
    if (!this.#context) throw new Error('The instrumented OMP session is unavailable.');
    this.#updateContext(this.#context);
    this.#refreshModels();
    const entries = this.#context.sessionManager.getBranch();
    // Once persistence contains an observed completion, discard its event copy.
    // A later host rewrite must not resurrect it from a retained phone overlay.
    if (this.#live && !this.#live.streaming) {
      const matching = entries.filter(entry => entry.type === 'message' && entry.message?.role === 'assistant'
        && entry.message.timestamp === this.#live.timestamp);
      if (matching.length > this.#live.ordinal) this.#live = undefined;
    }
    for (const entry of entries) if (entry.type === 'message' && entry.message?.role === 'toolResult') this.#tools.delete(entry.message.toolCallId);
    const snapshot = projectSnapshot({ config: this.#config, epoch: this.#epoch, generation: this.#generation, revision: ++this.#revision,
      context: this.#context, entries, live: this.#live, activeTools: this.#tools, needsInput: this.#approvals.size > 0, models: this.#models });
    if (this.#admissionPending) {
      snapshot.capabilities.prompt = false;
      snapshot.notices.push('The prompt was forwarded, but OMP has not yet signalled a turn. Check the host terminal before submitting again.');
    }
    if (this.#mutationPending) { snapshot.capabilities.prompt = false; snapshot.capabilities.modelSelection = false; }
    return snapshot;
  }

  #receipt(command, status, message) {
    return { protocol: REMOTE_PROTOCOL, version: REMOTE_VERSION, ...identity(command), sessionId: this.#config.id, status,
      ...(message ? { message } : {}) };
  }

  operation(id) {
    const existing = this.#receipts.get(id);
    if (existing) return { ...existing.receipt };
    return undefined;
  }

  async dispatch(input) {
    const command = parseRemoteCommand(input), hash = fingerprint(command), existing = this.#receipts.get(command.id);
    if (existing) return existing.hash === hash ? { ...existing.receipt }
      : this.#receipt(command, 'rejected', 'This command ID was already used with different input or session identity.');
    if (!this.#context || command.epoch !== this.#epoch || command.generation !== this.#generation
        || !command.conversationId || command.conversationId !== this.#context.sessionManager.getSessionId()) {
      return this.#receipt(command, 'rejected', 'The OMP session identity changed. Refresh the host catalog and attach to the current session.');
    }
    if (this.#receipts.size >= this.#maxReceipts) return this.#receipt(command, 'rejected', 'This adapter epoch has reached its command-receipt limit. New commands are blocked so old IDs cannot be executed again.');
    const entry = { hash, receipt: this.#receipt(command, 'pending') };
    this.#receipts.set(command.id, entry); // Reserve before any effect, including async model lookup.
    const rejected = message => { entry.receipt = this.#receipt(command, 'rejected', message); return { ...entry.receipt }; };
    if (command.type === 'answer') return rejected('Native owner dialogs require the Tern remote connection. This OMP extension cannot answer them.');
    if (command.type !== 'interrupt' && (this.#mutationPending || this.#admissionPending || !this.#context.isIdle()
        || this.#context.hasPendingMessages() || this.#approvals.size > 0)) return rejected('Wait for OMP to finish its current work or pending decision before sending a prompt or changing models.');
    try {
      if (command.type === 'prompt') {
        this.#admissionPending = true;
        this.#api.sendUserMessage(command.text);
        entry.receipt = this.#receipt(command, 'forwarded', 'Forwarded to the existing OMP session. Check the authoritative transcript for admission and progress.');
      } else if (command.type === 'interrupt') {
        this.#context.abort();
        entry.receipt = this.#receipt(command, 'forwarded', 'Interrupt forwarded. The existing OMP process remains running.');
      } else if (command.type === 'set-model') {
        this.#mutationPending = true;
        this.#refreshModels();
        const model = this.#models.find(item => item.provider === command.provider && item.id === command.modelId);
        if (!model) return rejected('Select a model advertised by this OMP session.');
        const changed = await this.#api.setModel(model);
        if (!changed) return rejected('OMP could not select this model with the host credentials.');
        entry.receipt = this.#receipt(command, 'forwarded', 'OMP accepted the model selection. Refresh the session snapshot to see the current model.');
        this.#modelsReadAt = 0;
      }
    } catch {
      entry.receipt = this.#receipt(command, 'unknown', 'The extension action did not return normally. Its effect is uncertain; inspect OMP in the host terminal before doing anything else.');
    } finally { if (command.type === 'set-model') this.#mutationPending = false; }
    return { ...entry.receipt };
  }

  async fetch(request) {
    if (!authorized(request, this.#config.token)) return error('Unauthorized.', 401);
    if (request.headers.has('Origin')) return error('Connect through the paired workspace gateway.', 403);
    try {
      const url = new URL(request.url);
      if (url.search) return error('Query parameters are not supported.', 400);
      if (request.method === 'GET' && url.pathname === '/perch/health') return json(this.health());
      if (request.method === 'GET' && url.pathname === '/perch/sessions') return json(this.catalog());
      const match = /^\/perch\/sessions\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})(?:\/(commands|operations)(?:\/([A-Za-z0-9][A-Za-z0-9_-]{0,127}))?)?$/.exec(url.pathname);
      if (!match || match[1] !== this.#config.id) return error('Unknown remote session route.', 404);
      if (request.method === 'GET' && !match[2]) return json(this.snapshot());
      if (request.method === 'GET' && match[2] === 'operations' && isRemoteId(match[3])) {
        const receipt = this.operation(match[3]);
        return receipt ? json(receipt) : error('No receipt is available. This does not prove that an earlier command did not run; inspect the host without replaying it.', 404);
      }
      if (request.method === 'POST' && match[2] === 'commands' && !match[3]) {
        const receipt = await this.dispatch(await readCommand(request));
        return json(receipt, receipt.status === 'rejected' ? 409 : 200);
      }
      return error('Unsupported remote session method.', 405);
    } catch (failure) {
      const status = failure.status ?? (failure instanceof SyntaxError || failure instanceof TypeError ? 400 : 400);
      return error(status === 413 ? 'Command body is too large.' : status === 415 ? 'Expected application/json.' : 'The remote request is invalid or this session is unavailable.', status);
    }
  }

  async close() {
    const server = this.#server;
    this.#server = undefined;
    this.#context = undefined;
    this.#live = undefined;
    this.#tools.clear();
    this.#approvals.clear();
    await server?.stop(true);
  }
}
