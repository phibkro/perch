import { createServer } from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { MAX_REMOTE_COMMAND_BYTES, parseRemoteCommand, parseRemoteQuestion } from '../../src/harness/remote.ts';

const PROTOCOL = { protocol: 'perch-remote', version: 1 };
const PRIVATE_PROTOCOL = 'perch-tern-plugin';
const MAX_BODY = 2 * 1024 * 1024;
const MAX_OPERATIONS = 1024;
const LIMITATIONS = [
  'Requires a connected Tern desktop window running the Perch plugin. Closing the window removes this bridge, not the agent process.',
  'Bounded Tern transcript snapshots, not a lossless TSP stream. Message timestamps and canonical OMP conversation IDs are unavailable.',
  'Attach selects a phone view without changing desktop focus. Detach does not interrupt or terminate the host program.',
  'A forwarded receipt means the plugin called the Tern API. It does not prove model completion or exactly-once external effects.',
];

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = (value, max = 512) => typeof value === 'string' && value.length <= max;
const id = value => string(value, 160) && /^[a-zA-Z0-9_.:-]+$/.test(value);
const bounded = (value, max = 512) => typeof value === 'string' ? value.slice(0, max) : '';
const hash = value => createHash('sha256').update(value).digest();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Presentation identity only: bounded Tern text is always the authoritative input. */
function reconcileRows(previous, source, makeId, key, grows) {
  const beforeKeys = previous.map(row => key(row.value));
  const nextKeys = source.map(key);
  if (JSON.stringify(beforeKeys) === JSON.stringify(nextKeys)) {
    return source.map((value, index) => ({ id: previous[index].id, value }));
  }
  const old = new Map(), counts = new Map();
  for (let i = 0; i < beforeKeys.length; i++) {
    const item = old.get(beforeKeys[i]);
    old.set(beforeKeys[i], item === undefined ? i : -1);
  }
  for (const value of nextKeys) counts.set(value, (counts.get(value) ?? 0) + 1);
  let last = -1;
  const rows = source.map((value, index) => {
    const candidate = old.get(nextKeys[index]);
    if (candidate !== undefined && candidate >= 0 && candidate > last && counts.get(nextKeys[index]) === 1) {
      last = candidate; return { id: previous[candidate].id, value };
    }
    return { id: makeId(), value };
  });
  // Only the final streaming row may change in place, and only with an exact
  // preceding-row anchor. An ambiguous branch/reset gets fresh presentation IDs.
  if (grows && rows.length > 1 && previous.length > 1) {
    const current = rows.at(-1), prior = previous.at(-1);
    if (rows.at(-2).id === previous.at(-2).id && grows(prior.value, current.value)) current.id = prior.id;
  }
  return rows;
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function authorize(request, expected) {
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ') ||
      !timingSafeEqual(hash(header.slice(7)), expected)) throw new HttpError(401, 'Unauthorized.');
}

async function body(request, maximum = MAX_BODY) {
  if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? '')) throw new HttpError(415, 'Use application/json.');
  let length = 0;
  const chunks = [];
  for await (const chunk of request) {
    length += chunk.length;
    if (length > maximum) throw new HttpError(413, 'Request is too large.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'Expected JSON.'); }
}

function reply(response, status, value) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(value));
}

function answerRejection(question, command) {
  if (!question || question.id !== command.requestId || question.revision !== command.requestRevision) {
    return 'This host request changed or was already dismissed. Refresh before answering.';
  }
  if (!question.actionable) return question.notice || 'This request must be answered in Tern.';
  if (!question.options.some(option => option.id === command.answer && !option.disabled)) return 'That choice is not available for the current host request.';
}

function validateFrame(value) {
  if (!record(value) || value.protocol !== PRIVATE_PROTOCOL || value.version !== 1 ||
      !id(value.bridgeId) || !Number.isSafeInteger(value.sequence) || value.sequence < 1 ||
      !Array.isArray(value.agents) || value.agents.length > 32) throw new HttpError(400, 'Invalid plugin frame.');
  const panes = new Set();
  for (const agent of value.agents) {
    if (!record(agent) || !Number.isSafeInteger(agent.pane) || agent.pane < 1 || panes.has(agent.pane) ||
        !id(agent.generation) || !string(agent.title, 512) || !string(agent.cwd, 2048) ||
        !['idle', 'working', 'waiting_input', 'exited'].includes(agent.state) ||
        !['omp', 'tern'].includes(agent.harness) ||
        (agent.model !== undefined && !string(agent.model, 512)) ||
        (agent.deliveryError !== undefined && !string(agent.deliveryError, 2048)) ||
        (agent.location !== undefined && (!record(agent.location) ||
          !['host', 'workspace', 'tab', 'pane'].every(key => agent.location[key] === undefined || string(agent.location[key], 512))))) {
      throw new HttpError(400, 'Invalid plugin agent.');
    }
    panes.add(agent.pane);
  }
  const detail = value.detail;
  if (detail !== undefined) {
    if (!record(detail) || !panes.has(detail.pane) || !id(detail.generation) ||
        !Array.isArray(detail.messages) || detail.messages.length > 64 ||
        !detail.messages.every(row => record(row) && ['user', 'assistant'].includes(row.role) && string(row.text, 64_000) &&
          Array.isArray(row.tools) && row.tools.length <= 64 && row.tools.every(tool => record(tool))) ||
        typeof detail.canPrompt !== 'boolean' || typeof detail.canInterrupt !== 'boolean' ||
        detail.canFocus !== undefined && typeof detail.canFocus !== 'boolean' ||
        typeof detail.truncated !== 'boolean' ||
        !Array.isArray(detail.notices) || detail.notices.length > 8 || !detail.notices.every(n => string(n, 2048))) {
      throw new HttpError(400, 'Invalid plugin transcript.');
    }
    const agent = value.agents.find(row => row.pane === detail.pane);
    if (agent.generation !== detail.generation) throw new HttpError(400, 'Plugin transcript generation does not match its pane.');
    if (detail.pendingQuestion !== undefined && detail.pendingQuestion !== null) {
      try { detail.pendingQuestion = parseRemoteQuestion(detail.pendingQuestion); }
      catch { throw new HttpError(400, 'Invalid plugin request.'); }
      if (detail.pendingQuestion.kind !== 'choice') throw new HttpError(400, 'Unsupported Tern request kind.');
    }
  }
  if (value.receipts !== undefined && (!Array.isArray(value.receipts) || value.receipts.length > 8 ||
      !value.receipts.every(row => record(row) && id(row.id) && ['forwarded', 'rejected', 'unknown'].includes(row.status) &&
        (row.message === undefined || string(row.message, 2048))))) throw new HttpError(400, 'Invalid plugin receipts.');
  return value;
}

/**
 * The gateway owns this loopback listener; Tern owns every program and transcript.
 * A private plugin credential is deliberately separate from the device credential.
 * `now` and short timeouts support lifecycle tests at the same HTTP boundary.
 */
export function createTernRemoteServer({ token, pluginToken, host = { id: 'tern-local', name: 'Tern workspace' },
  readOnly = false, now = Date.now, leaseMs = 10_000, commandMs = 5_000, snapshotWaitMs = 2_500, exchangeDelayMs = 750 } = {}) {
  if (!string(token, 4096) || token.length < 24 || !string(pluginToken, 4096) || pluginToken.length < 24 || token === pluginToken) {
    throw new Error('Separate device and plugin credentials of at least 24 characters are required.');
  }
  if (!record(host) || !id(host.id) || !string(host.name, 160) || !host.name.trim()) throw new Error('Invalid host metadata.');
  const tokenHash = hash(token), pluginHash = hash(pluginToken);
  const epoch = randomUUID();
  const bridges = new Map();
  const operations = new Map();
  let revision = 0;

  function expire() {
    const time = now();
    for (const [key, bridge] of bridges) {
      if (time - bridge.seenAt > leaseMs) { bridges.delete(key); revision++; }
    }
    for (const operation of operations.values()) {
      if (operation.receipt.status === 'pending' &&
          (!bridges.has(operation.bridgeId) || time >= operation.deadline)) {
        operation.receipt.status = operation.dispatched ? 'unknown' : 'rejected';
        operation.receipt.message = operation.dispatched
          ? 'Tern did not confirm this command. Inspect the host before deliberately submitting again.'
          : 'The Tern connection expired before this command was delivered.';
        operation.command = undefined;
      }
    }
  }

  function summary(bridge, agent) {
    return {
      id: `${bridge.id}-${agent.pane}`,
      generation: `${bridge.id}:${agent.generation}`,
      runtimeId: `${bridge.id}:${agent.pane}`,
      title: agent.title || `Tern pane ${agent.pane}`,
      project: agent.cwd,
      status: agent.state === 'waiting_input' ? 'needs-input' : agent.state,
      harness: agent.harness,
      ...(agent.model ? { model: { id: agent.model, name: agent.model } } : {}),
      ...(agent.location ? { location: agent.location } : {}),
    };
  }

  function findSession(sessionId) {
    expire();
    for (const bridge of bridges.values()) {
      for (const agent of bridge.agents) if (`${bridge.id}-${agent.pane}` === sessionId) return { bridge, agent };
    }
    throw new HttpError(404, 'This Tern pane is no longer available. Refresh the host session list.');
  }

  function project(bridge, agent, detail) {
    const session = summary(bridge, agent);
    // Tern supplies no permanent entry IDs. Reuse only defensible bounded view
    // identities; never turn this cache into another authoritative transcript.
    const previous = bridge.projection?.generation === session.generation && bridge.projection?.pane === agent.pane
      ? bridge.projection.rows : [];
    const rows = reconcileRows(previous, detail.messages, randomUUID,
      row => JSON.stringify([row.role, row.text]),
      (a, b) => a.role === 'assistant' && b.role === 'assistant' && b.text.startsWith(a.text));
    const oldTools = new Map(previous.map(row => [row.id, row.tools ?? []]));
    for (const row of rows) row.tools = reconcileRows(oldTools.get(row.id) ?? [], row.value.tools, randomUUID,
      tool => JSON.stringify([tool.name, tool.target]));
    bridge.projection = { pane: agent.pane, generation: session.generation, rows };
    const messages = rows.map((row, i) => ({ id: row.id, role: row.value.role, text: row.value.text, createdAt: 0,
      ...(agent.state === 'working' && row.value.role === 'assistant' && i === rows.length - 1 ? { streaming: true } : {}) }));
    const tools = [];
    for (let i = 0; i < detail.messages.length; i++) {
      for (let j = 0; j < detail.messages[i].tools.length; j++) {
        const tool = detail.messages[i].tools[j];
        if (tools.length >= 4000) break;
        const status = new Map([['running', 'running'], ['pending', 'running'], ['done', 'done'], ['ok', 'done'],
          ['success', 'done'], ['error', 'error'], ['failed', 'error'], ['interrupted', 'interrupted']]).get(tool.status) ?? 'unknown';
        tools.push({ id: rows[i].tools[j].id, name: bounded(tool.name) || 'Tool',
          label: bounded(tool.name) || 'Host tool', detail: bounded(tool.target, 2048), status,
          ...(typeof tool.text === 'string' ? { output: tool.text.slice(0, 64_000) } : {}) });
      }
    }
    return { ...PROTOCOL, epoch, revision, session,
      capabilities: { prompt: !readOnly && detail.canPrompt && !detail.pendingQuestion,
        interrupt: !readOnly && detail.canInterrupt, modelSelection: false, questions: !readOnly,
        focusSession: !readOnly && detail.canFocus === true },
      readOnly, messages, tools, availableModels: [], truncated: detail.truncated || tools.length >= 4000,
      pendingQuestion: detail.pendingQuestion ?? null,
      notices: [...detail.notices.map(n => n.slice(0, 2000)), ...(agent.deliveryError ? [agent.deliveryError.slice(0, 2000)] : []),
        'Tern supplies rendered conversation text. Entry timestamps and the canonical OMP session identity are unavailable.'],
    };
  }

  function settleReceipts(bridge, receipts) {
    for (const incoming of receipts ?? []) {
      const operation = operations.get(incoming.id);
      if (!operation || operation.bridgeId !== bridge.id || !operation.dispatched ||
          operation.receipt.status === 'forwarded' || operation.receipt.status === 'rejected') continue;
      operation.receipt.status = incoming.status;
      operation.command = undefined;
      operation.receipt.message = incoming.message?.slice(0, 2000) || (incoming.status === 'forwarded'
        ? 'The Tern window plugin called the requested API.' : incoming.status === 'rejected'
          ? 'Tern rejected this command.' : 'The Tern API failed during invocation. Inspect the host before deliberately submitting again.');
    }
  }

  async function route(request, response) {
    // This adapter accepts the local gateway and plugin, never browser origins.
    // The gateway authenticates allowed clients and strips their Origin header.
    if (request.headers.origin !== undefined) throw new HttpError(403, 'Browser origins must use the workspace gateway.');
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.search) throw new HttpError(400, 'Query parameters are unsupported.');
    const path = url.pathname;
    expire();
    if (path.startsWith('/tern/')) {
      authorize(request, pluginHash);
      if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
      const value = await body(request);
      if (path === '/tern/register') {
        if (!record(value) || value.protocol !== PRIVATE_PROTOCOL || value.version !== 1) throw new HttpError(400, 'Unsupported plugin.');
        if (bridges.size >= 8) throw new HttpError(503, 'Too many attached Tern windows.');
        const bridgeId = randomUUID();
        bridges.set(bridgeId, { id: bridgeId, seenAt: now(), sequence: 0, agents: [], details: new Map(), inspectPane: undefined });
        reply(response, 200, { protocol: PRIVATE_PROTOCOL, version: 1, bridgeId }); return;
      }
      if (path === '/tern/exchange') {
        const frame = validateFrame(value);
        const bridge = bridges.get(frame.bridgeId);
        if (!bridge || frame.sequence !== bridge.sequence + 1) throw new HttpError(409, 'Register a fresh plugin connection. Commands are never replayed.');
        bridge.sequence = frame.sequence;
        bridge.seenAt = now();
        bridge.agents = frame.agents;
        for (const [pane, detail] of bridge.details) {
          if (!frame.agents.some(a => a.pane === pane && a.generation === detail.value.generation)) bridge.details.delete(pane);
        }
        if (frame.detail) {
          // One phone view per window is inspected at a time. Keep one bounded
          // transcript rather than accumulating every pane ever opened remotely.
          bridge.details.clear();
          bridge.details.set(frame.detail.pane, { at: now(), value: frame.detail });
        }
        settleReceipts(bridge, frame.receipts);
        revision++;
        // The loopback server supplies the normal cadence; the window simply
        // chains async fetch callbacks and does no work while the reply waits.
        if (exchangeDelayMs > 0) await delay(exchangeDelayMs);
        expire();
        if (!bridges.has(bridge.id) || bridge.sequence !== frame.sequence) throw new HttpError(409, 'The plugin connection changed during exchange.');
        const commands = [];
        for (const operation of operations.values()) {
          if (operation.bridgeId !== bridge.id || operation.dispatched || operation.receipt.status !== 'pending') continue;
          const current = frame.agents.find(a => a.pane === operation.pane);
          if (!current || summary(bridge, current).generation !== operation.receipt.generation) {
            operation.receipt.status = 'rejected'; operation.command = undefined;
            operation.receipt.message = 'The pane generation changed before delivery.'; continue;
          }
          if (operation.command.type === 'answer') {
            const rejected = answerRejection(bridge.details.get(operation.pane)?.value.pendingQuestion, operation.command);
            if (rejected) {
              operation.receipt.status = 'rejected'; operation.command = undefined;
              operation.receipt.message = rejected; continue;
            }
          }
          operation.dispatched = true;
          commands.push({ ...operation.command, pane: operation.pane, generation: current.generation });
          operation.command = undefined;
          break;
        }
        reply(response, 200, { protocol: PRIVATE_PROTOCOL, version: 1, bridgeId: bridge.id,
          sequence: bridge.sequence, commands,
          ...(bridge.inspectPane !== undefined && now() - bridge.watchAt < 30_000 ? { inspectPane: bridge.inspectPane } : {}) });
        return;
      }
      throw new HttpError(404, 'Unknown plugin route.');
    }
    authorize(request, tokenHash);
    if (request.method === 'GET' && path === '/perch/health') {
      reply(response, 200, { ...PROTOCOL, host, adapter: 'tern', epoch, synchronization: 'snapshot', limitations: LIMITATIONS }); return;
    }
    if (request.method === 'GET' && path === '/perch/sessions') {
      const sessions = [...bridges.values()].flatMap(bridge => bridge.agents.map(agent => summary(bridge, agent)));
      reply(response, 200, { ...PROTOCOL, epoch, revision, sessions }); return;
    }
    const match = /^\/perch\/sessions\/([a-zA-Z0-9_.:-]+)(?:\/(commands|operations\/([a-zA-Z0-9_.:-]+)))?$/.exec(path);
    if (!match) throw new HttpError(404, 'Unknown remote session route.');
    const sessionId = match[1];
    if (request.method === 'GET' && match[3]) {
      const operation = operations.get(match[3]);
      if (!operation || operation.receipt.sessionId !== sessionId) throw new HttpError(404, 'Unknown command receipt.');
      reply(response, 200, operation.receipt); return;
    }
    const { bridge, agent } = findSession(sessionId);
    if (request.method === 'GET' && !match[2]) {
      bridge.inspectPane = agent.pane; bridge.watchAt = now();
      const started = Date.now();
      let detail;
      do {
        detail = bridge.details.get(agent.pane);
        if (detail && now() - detail.at < 2_000 && detail.value.generation === agent.generation) break;
        if (Date.now() - started >= snapshotWaitMs || response.destroyed) throw new HttpError(503, 'Waiting for the Tern window to publish this pane. Reconnect shortly.');
        await delay(40);
      } while (true);
      const current = findSession(sessionId);
      if (current.agent.generation !== agent.generation) throw new HttpError(409, 'The pane changed while attaching. Refresh the session list.');
      reply(response, 200, project(bridge, current.agent, detail.value)); return;
    }
    if (request.method === 'POST' && match[2] === 'commands') {
      let command;
      try { command = parseRemoteCommand(await body(request, MAX_REMOTE_COMMAND_BYTES)); }
      catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, 'Invalid command.'); }
      if (command.conversationId !== undefined) throw new HttpError(400, 'Tern does not expose a canonical conversation ID.');
      const fingerprint = createHash('sha256').update(JSON.stringify({ sessionId, epoch: command.epoch, generation: command.generation,
        type: command.type, text: command.text, provider: command.provider, modelId: command.modelId,
        level: command.level, title: command.title,
        requestId: command.requestId, requestRevision: command.requestRevision, answer: command.answer })).digest('hex');
      const existing = operations.get(command.id);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new HttpError(409, 'That command ID was already used for different input.');
        reply(response, 200, existing.receipt); return;
      }
      if (operations.size >= MAX_OPERATIONS) throw new HttpError(503, 'The command receipt limit was reached. Try later.');
      const session = summary(bridge, agent);
      const receipt = { ...PROTOCOL, id: command.id, epoch, sessionId, generation: command.generation, status: 'pending' };
      const detail = bridge.details.get(agent.pane);
      let rejection;
      if (command.epoch !== epoch || command.generation !== session.generation) rejection = 'Stale host or pane generation. Refresh before sending.';
      else if (readOnly) rejection = 'This adapter is read-only.';
      else if (command.type === 'set-model') rejection = 'Model selection requires the OMP in-process adapter.';
      else if (command.type === 'set-thinking' || command.type === 'rename-session') rejection = 'Session settings require the OMP in-process adapter.';
      else if (!detail || now() - detail.at >= 2_000 || detail.value.generation !== agent.generation) rejection = 'Read a fresh pane snapshot before sending.';
      else if (command.type === 'prompt' && (!detail.value.canPrompt || detail.value.pendingQuestion)) rejection = 'The native OMP composer is not ready to accept a prompt.';
      else if (command.type === 'interrupt' && !detail.value.canInterrupt) rejection = 'This pane does not support interruption.';
      else if (command.type === 'focus-session' && detail.value.canFocus !== true) rejection = 'This Tern plugin does not advertise pane focus. Update the host adapter.';
      else if (command.type === 'answer') {
        const question = detail.value.pendingQuestion;
        rejection = answerRejection(question, command);
        if (!rejection && [...operations.values()].some(op => op.bridgeId === bridge.id && op.pane === agent.pane &&
          op.requestId === command.requestId && ['pending', 'forwarded', 'unknown'].includes(op.receipt.status))) {
          rejection = 'A response to this host request was already submitted. Wait for the host to dismiss it.';
        }
      }
      if (!rejection && [...operations.values()].some(op => op.bridgeId === bridge.id && op.pane === agent.pane && op.receipt.status === 'pending')) rejection = 'Wait for the previous command receipt before sending another.';
      if (rejection) { receipt.status = 'rejected'; receipt.message = rejection; }
      operations.set(command.id, { receipt, fingerprint, command: rejection ? undefined : command, pane: agent.pane, bridgeId: bridge.id,
        requestId: command.type === 'answer' ? command.requestId : undefined,
        dispatched: false, deadline: now() + commandMs, createdAt: now() });
      reply(response, rejection ? 200 : 202, receipt); return;
    }
    throw new HttpError(405, 'Method not allowed.');
  }

  return createServer((request, response) => {
    route(request, response).catch(error => {
      if (!response.headersSent && !response.destroyed) reply(response, error instanceof HttpError ? error.status : 500,
        { error: error instanceof HttpError ? error.message : 'The Tern bridge could not process this request.' });
    });
  });
}
