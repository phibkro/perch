import { REMOTE_PROTOCOL, REMOTE_VERSION, MAX_REMOTE_MODELS } from '../../src/harness/remote.ts';

export const MAX_SNAPSHOT_BYTES = 2_000_000;
export const MAX_ROWS = 500;
export const MAX_TEXT = 256_000;
export const LIMITATIONS = Object.freeze([
  'This attaches to one instrumented OMP process. Closing the phone does not stop its work.',
  'Snapshots contain recent text and tool activity. They are not a lossless TSP or terminal stream.',
  'Prompt and interrupt receipts acknowledge forwarding through the OMP extension API, not a completed or persisted turn.',
  'Answer dialogs, approvals, branching, and session creation in the host terminal. This adapter does not intercept every TUI dialog.',
  'History survives according to OMP storage. Active model calls, tools, and command receipts are not restored after this process exits.',
]);

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const bounded = (value, maximum, mark) => {
  if (typeof value !== 'string') return '';
  if (value.length <= maximum) return value;
  mark?.();
  return `${value.slice(0, maximum - 26)}\n[Truncated by Perch host]`;
};
const timestamp = value => Number.isFinite(value) && value >= 0 ? value : 0;
const plainId = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value);

export function displayModel(value) {
  if (!record(value) || typeof value.id !== 'string' || !value.id || value.id.length > 1024
      || /[\u0000-\u001f\u007f]/u.test(value.id) || typeof value.provider !== 'string' || !value.provider
      || value.provider.length > 256 || /[\u0000-\u001f\u007f]/u.test(value.provider)) return undefined;
  return { id: value.id, provider: value.provider, name: bounded(value.name || value.id, 1024) };
}

export function messageText(message, mark) {
  if (typeof message?.content === 'string') return bounded(message.content, MAX_TEXT, mark);
  if (!Array.isArray(message?.content)) return '';
  let result = '';
  for (const block of message.content) {
    if (!record(block) || block.type !== 'text' || typeof block.text !== 'string') continue;
    if (result) result += '\n';
    const space = MAX_TEXT - result.length;
    if (block.text.length > space) { result += bounded(block.text, Math.max(30, space), mark); mark?.(); break; }
    result += block.text;
  }
  return bounded(result, MAX_TEXT, mark);
}

/** Only a small display projection is retained between events, never raw provider payloads. */
export function liveMessage(message, entries, previous, streaming, startsNew = false) {
  if (message?.role !== 'assistant') return undefined;
  const at = timestamp(message.timestamp);
  const same = !startsNew && previous?.timestamp === at;
  const ordinal = same ? previous.ordinal : entries.filter(entry => entry.type === 'message'
    && entry.message?.role === 'assistant' && timestamp(entry.message.timestamp) === at).length;
  let truncated = false;
  const mark = () => { truncated = true; };
  const text = messageText(message, mark);
  const calls = [];
  for (const block of Array.isArray(message.content) ? message.content : []) {
    if (block?.type === 'toolCall' && plainId(block.id)) calls.push(toolCall(block, mark, !streaming));
    if (calls.length === MAX_ROWS) { mark(); break; }
  }
  return { timestamp: at, ordinal, text, calls, streaming, truncated };
}

function toolCall(call, mark, includeArtifact = true) {
  const name = bounded(call.name || 'tool', 512, mark);
  const args = record(call.arguments) ? call.arguments : {};
  const detail = bounded(typeof args.path === 'string' ? args.path : typeof args.command === 'string' ? args.command : name, MAX_TEXT, mark);
  const result = { id: call.id, name, label: bounded(name, 1024), status: 'unknown', detail };
  if (includeArtifact && name === 'write' && plainId(args.path) && typeof args.content === 'string') {
    if (args.content.length <= MAX_TEXT) result.artifact = { filename: args.path, content: args.content };
    else mark?.(); // A partial input must never be represented as an exact file.
  }
  return result;
}

export function liveTool(event) {
  if (!plainId(event.toolCallId)) return undefined;
  let truncated = false;
  const mark = () => { truncated = true; };
  const tool = toolCall({ id: event.toolCallId, name: event.toolName, arguments: event.args }, mark);
  if (event.type === 'tool_execution_start' || event.type === 'tool_execution_update') tool.status = 'running';
  if (event.type === 'tool_execution_update') tool.output = messageText(event.partialResult, mark);
  if (event.type === 'tool_execution_end') {
    tool.status = event.isError ? 'error' : 'done';
    tool.output = messageText(event.result, mark);
  }
  return { tool, truncated };
}

export function sessionSummary(config, generation, context, needsInput) {
  const model = displayModel(context.models?.current?.() ?? context.model);
  return {
    id: config.id, runtimeId: config.id, generation,
    conversationId: context.sessionManager.getSessionId(),
    title: bounded(context.sessionManager.getSessionName?.() || config.name, 512),
    project: bounded(context.cwd || context.sessionManager.getCwd?.() || '', 4096),
    status: needsInput ? 'needs-input' : context.isIdle() && !context.hasPendingMessages() ? 'idle' : 'working',
    harness: 'omp', pid: process.pid, ...(model ? { model } : {}),
  };
}

/** Read host branch entries afresh and add only the not-yet-persisted streaming tail. */
export function projectSnapshot({ config, epoch, generation, revision, context, entries, live, activeTools, needsInput, models }) {
  let truncated = false;
  const mark = () => { truncated = true; };
  const messages = [], tools = new Map(), ordinals = new Map();
  const messageOrder = new Map(), toolOrder = new Map();
  let livePersisted = false;
  let sourceOrder = 0;
  for (const entry of entries) {
    sourceOrder++;
    if (entry.type !== 'message' || !record(entry.message)) continue;
    const message = entry.message, at = timestamp(message.timestamp);
    const key = `${message.role}:${at}`;
    const ordinal = ordinals.get(key) ?? 0;
    ordinals.set(key, ordinal + 1);
    if (message.role === 'user' || message.role === 'assistant' || message.role === 'developer') {
      if (live && message.role === 'assistant' && live.timestamp === at && live.ordinal === ordinal) livePersisted = true;
      const id = `message:${key}:${ordinal}`;
      messages.push({ id, role: message.role === 'developer' ? 'system' : message.role,
        text: messageText(message, mark), createdAt: at });
      messageOrder.set(id, sourceOrder);
      if (messages.length > MAX_ROWS) { const omitted = messages.shift(); messageOrder.delete(omitted.id); mark(); }
    }
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      for (const call of message.content) {
        if (call?.type !== 'toolCall' || !plainId(call.id)) continue;
        tools.set(call.id, toolCall(call, mark));
        toolOrder.set(call.id, sourceOrder);
      }
    } else if (message.role === 'toolResult' && plainId(message.toolCallId)) {
      const tool = tools.get(message.toolCallId) ?? { id: message.toolCallId, name: bounded(message.toolName || 'tool', 512),
        label: bounded(message.toolName || 'tool', 1024), status: 'unknown', detail: '' };
      tools.set(message.toolCallId, { ...tool, status: message.isError ? 'error' : 'done', output: messageText(message, mark) });
      toolOrder.set(message.toolCallId, sourceOrder);
    }
    while (tools.size > MAX_ROWS) { const omitted = tools.keys().next().value; tools.delete(omitted); toolOrder.delete(omitted); mark(); }
  }
  if (live && !livePersisted) {
    const id = `message:assistant:${live.timestamp}:${live.ordinal}`;
    messages.push({ id, role: 'assistant', text: live.text,
      createdAt: live.timestamp, streaming: live.streaming });
    messageOrder.set(id, entries.length + (live.order ?? 1));
    for (const call of live.calls) { tools.set(call.id, call); toolOrder.set(call.id, entries.length + (live.order ?? 1)); }
    if (live.truncated) mark();
  }
  for (const [id, item] of activeTools) {
    const existing = tools.get(id);
    // Persisted results supersede event overlays, including plugin transformations.
    if (existing && (existing.status === 'done' || existing.status === 'error')) continue;
    tools.set(id, { ...existing, ...item.tool, ...(existing?.artifact && !item.tool.artifact ? { artifact: existing.artifact } : {}) });
    toolOrder.set(id, entries.length + (item.order ?? 1));
    if (item.truncated) mark();
  }
  if (messages.length > MAX_ROWS) { messages.splice(0, messages.length - MAX_ROWS); mark(); }
  let toolRows = [...tools.values()].sort((a, b) => toolOrder.get(a.id) - toolOrder.get(b.id));
  if (toolRows.length > MAX_ROWS) { toolRows = toolRows.slice(-MAX_ROWS); mark(); }
  const advertised = models.map(displayModel).filter(Boolean);
  if (advertised.length > MAX_REMOTE_MODELS) mark();
  const snapshot = { protocol: REMOTE_PROTOCOL, version: REMOTE_VERSION, epoch, revision,
    session: sessionSummary(config, generation, context, needsInput),
    capabilities: { prompt: true, interrupt: true, modelSelection: true }, readOnly: false,
    messages, tools: toolRows, availableModels: advertised.slice(0, MAX_REMOTE_MODELS), truncated, notices: [] };
  if (needsInput) snapshot.notices.push('OMP is awaiting a tool decision. Answer it in the host terminal; this adapter cannot approve it.');
  const truncatedNotice = 'This is a bounded recent view. Some earlier rows or oversized text were omitted or shortened; the full history remains in OMP.';
  const bytes = value => Buffer.byteLength(JSON.stringify(value));
  let size = bytes(snapshot);
  // Keep one chronological priority across both chat and tool output. A newly
  // finished tool must not disappear just because older assistant prose is large.
  while (size > MAX_SNAPSHOT_BYTES - 1024 && snapshot.messages.length + snapshot.tools.length > 1) {
    snapshot.truncated = true;
    const oldestMessage = snapshot.messages[0], oldestTool = snapshot.tools[0];
    const removeMessage = oldestMessage && (!oldestTool || messageOrder.get(oldestMessage.id) <= toolOrder.get(oldestTool.id));
    const removed = removeMessage ? snapshot.messages.shift() : snapshot.tools.shift();
    size -= bytes(removed) + 1;
  }
  while (size > MAX_SNAPSHOT_BYTES - 1024 && snapshot.availableModels.length) {
    snapshot.truncated = true;
    size -= bytes(snapshot.availableModels.pop()) + 1;
  }
  // The last row can itself contain a large exact file plus escaped tool output.
  // Retain the latest activity, shorten display text, and keep file bytes exact.
  while (bytes(snapshot) > MAX_SNAPSHOT_BYTES - 1024) {
    snapshot.truncated = true;
    const message = snapshot.messages.at(-1), tool = snapshot.tools.at(-1);
    if (message) message.text = bounded(message.text, Math.max(30, Math.floor(message.text.length / 2)), mark);
    else if (tool) {
      tool.detail = bounded(tool.detail, Math.max(30, Math.floor(tool.detail.length / 2)), mark);
      if (tool.output) tool.output = bounded(tool.output, Math.max(30, Math.floor(tool.output.length / 2)), mark);
      if (tool.detail.length <= 30 && (!tool.output || tool.output.length <= 30) && tool.artifact) delete tool.artifact;
    } else {
      throw new Error('Remote metadata exceeds the snapshot budget.');
    }
  }
  if (snapshot.truncated) snapshot.notices.push(truncatedNotice);
  return snapshot;
}
