import { DURABLE_PROTOCOL } from '../../../src/harness/durable.ts';

const MAX_TEXT = 2_000_000;
const MAX_ROWS = 10_000;
// Bound encoded JSON below the phone's 12 MiB response limit, including escapes.
const MAX_SNAPSHOT_BYTES = 10 * 1024 * 1024;
const SHORTENED = '\n\n[Display truncated for the phone. Full text remains on the host.]';
const encoder = new TextEncoder();
const jsonBytes = value => encoder.encode(JSON.stringify(value)).byteLength;
const taskId = value => Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const timestamp = (value, fallback) => Number.isSafeInteger(value) && value >= 0 ? value : fallback;

function prefix(text, length) {
  const result = text.slice(0, length);
  const last = result.charCodeAt(result.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? result.slice(0, -1) : result;
}
function shortened(text, limit = MAX_TEXT) {
  return text.length <= limit ? text : prefix(text, limit - SHORTENED.length) + SHORTENED;
}
function displayLabel(value) {
  const text = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim() : '';
  return !text ? 'Tool' : text.length <= 128 ? text : prefix(text, 127) + '…';
}

/** Keep complete identifiers/manifests; shorten display text before omitting rows. */
function withinPhoneBudget(result) {
  const state = result.state;
  let omittedMessages = Math.max(0, state.messages.length - (MAX_ROWS - 1));
  let omittedTools = Math.max(0, state.tools.length - MAX_ROWS);
  const messages = state.messages.slice(omittedMessages);
  const tools = state.tools.slice(omittedTools);
  const originals = new Map();
  for (const message of messages) { originals.set(message, message.text); message.text = shortened(message.text, 192); }
  for (const tool of tools) if (typeof tool.output === 'string') { originals.set(tool, tool.output); tool.output = shortened(tool.output, 192); }
  const updateRows = () => {
    state.messages = omittedMessages || omittedTools ? [{
      id: `${state.session.id}:projection-window`, role: 'system', createdAt: 0,
      text: `Phone history omits ${omittedMessages} older messages and ${omittedTools} older tool cards. Earlier entries remain on the host.`,
    }, ...messages] : messages;
    state.tools = tools;
  };
  updateRows();
  let used = jsonBytes(result);
  // Identifiers/labels alone can exceed the budget in an exceptional history.
  // Retain recent rows and make the omission visible instead of breaking reads.
  while (used > MAX_SNAPSHOT_BYTES && (messages.length > 1 || tools.length > 1)) {
    if (messages.length >= tools.length && messages.length > 1) {
      const count = Math.max(1, Math.floor(messages.length / 4)); messages.splice(0, count); omittedMessages += count;
    } else {
      const count = Math.max(1, Math.floor(tools.length / 4)); tools.splice(0, count); omittedTools += count;
    }
    updateRows(); used = jsonBytes(result);
  }
  let remaining = MAX_SNAPSHOT_BYTES - used;
  // Restore newest conversation text first, then tool output. Ordinary
  // snapshots are restored byte-for-byte with no truncation notice.
  for (const [row, key] of [...messages.slice().reverse().map(row => [row, 'text']), ...tools.slice().reverse().map(row => [row, 'output'])]) {
    const original = originals.get(row);
    if (original === undefined || row[key] === original) continue;
    const baseline = jsonBytes(row[key]);
    const complete = jsonBytes(original) - baseline;
    if (complete <= remaining) { row[key] = original; remaining -= complete; continue; }
    let low = 192; let high = original.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (jsonBytes(shortened(original, middle)) - baseline <= remaining) low = middle;
      else high = middle - 1;
    }
    const value = shortened(original, low);
    remaining -= jsonBytes(value) - baseline; row[key] = value;
  }
  return result;
}

const textOf = content => typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n') : '';
export const CAPABILITIES = Object.freeze({ prompt: true, interrupt: true, questions: false, steer: false,
  attachments: false, modelSelection: true, sessionSelection: true, sessionCreation: true });

/**
 * Read one published ConversationView frame. Its entries and pi.live document
 * are captured together by Conversation.watch(); SnapshotEvent omits run.taskId.
 * Neither raw provider errors/config nor model-supplied identifiers reach the UI.
 */
export function projectSnapshot({ metadata, view, operations, manifests, models, synthetic = false }) {
  const liveState = view.docs['pi.live'] ?? {};
  const entries = view.entries;
  const liveTools = liveState.tools ?? [];
  const sessionId = metadata.id;
  const messages = []; const tools = new Map(); const calls = new Map(); const resultIds = new Map();
  const assistantOrdinals = new Map();
  const generationTasks = new Set(entries.filter(entry => entry.model?.some(raw => raw.role === 'assistant'))
    .map(entry => taskId(entry.byTaskId)).filter(id => id !== undefined));
  const currentGeneration = taskId(liveState.run?.taskId);
  if (currentGeneration !== undefined) generationTasks.add(currentGeneration);
  for (const entry of entries) {
    for (const [index, raw] of (entry.model ?? []).entries()) {
      const recordedId = `${sessionId}:entry:${entry.id}:${index}`;
      const owner = taskId(entry.byTaskId);
      let messageId = recordedId;
      if (raw.role === 'assistant' && owner !== undefined) {
        const ordinal = assistantOrdinals.get(owner) ?? 0;
        assistantOrdinals.set(owner, ordinal + 1);
        messageId = `${sessionId}:assistant-task:${owner}:${ordinal}`;
      }
      if (['user', 'assistant', 'system'].includes(raw.role)) {
        let text = textOf(raw.content);
        if (raw.role === 'assistant' && raw.stopReason === 'aborted') text = `[Response interrupted]${text ? '\n\n' + text : ''}`;
        if (raw.role === 'assistant' && raw.stopReason === 'error') text = `[Model request failed. Check the host configuration.]${text ? '\n\n' + text : ''}`;
        if (text) messages.push({ id: messageId, role: raw.role, text: shortened(text),
          createdAt: timestamp(raw.timestamp, metadata.createdAt), streaming: false });
      }
      if (raw.role === 'assistant' && Array.isArray(raw.content)) for (const [callIndex, call] of raw.content.entries()) {
        if (call?.type !== 'toolCall') continue;
        // The entry/content slot is a host identity. A malformed provider call
        // ID remains only a correlation key and cannot invalidate a UI label.
        const toolId = `${recordedId}:tool-slot:${callIndex}`;
        calls.set(call.id, { id: toolId, generationTask: owner });
        const name = displayLabel(call.name);
        tools.set(toolId, { id: toolId, name, label: name, status: 'unknown', detail: 'Awaiting a recorded result' });
      }
      if (raw.role === 'toolResult') {
        const source = calls.get(raw.toolCallId);
        // Pi writes unavailable/unstarted results inside the generation task.
        // They share byTaskId, but have no executed tool task of their own.
        const executedTask = owner !== undefined && owner !== source?.generationTask && !generationTasks.has(owner);
        const toolId = executedTask ? `${sessionId}:tool-task:${owner}` : source?.id ?? `${recordedId}:tool-result`;
        const previous = tools.get(source?.id ?? toolId);
        if (source && source.id !== toolId) tools.delete(source.id);
        resultIds.set(entry.id, toolId);
        const interrupted = (entry.data?.diagnostics ?? []).some(item => /^(?:interrupted|aborted)$/.test(item.code ?? ''));
        const name = displayLabel(raw.toolName ?? previous?.name);
        tools.set(toolId, { id: toolId, name, label: name, status: interrupted ? 'interrupted' : raw.isError ? 'error' : 'done',
          detail: interrupted ? 'Execution was interrupted' : raw.isError ? 'Tool reported an error' : 'Tool completed', output: shortened(textOf(raw.content)) });
      }
    }
  }
  for (const [index, live] of liveTools.entries()) {
    const source = calls.get(live.callId);
    const executedTask = taskId(live.taskId);
    const toolId = executedTask !== undefined ? `${sessionId}:tool-task:${executedTask}`
      : resultIds.get(live.entry) ?? source?.id ?? `${sessionId}:live-tool-slot:${index}`;
    if (source && source.id !== toolId) tools.delete(source.id);
    const previous = tools.get(toolId);
    if (live.status === 'done' && previous && previous.status !== 'unknown') continue;
    const name = displayLabel(live.name);
    tools.set(toolId, { id: toolId, name, label: name,
      status: live.status === 'running' || live.status === 'pending' ? 'running' : 'unknown',
      detail: live.status === 'done' ? 'No result was recorded' : 'Running on the host',
      ...(typeof live.output === 'string' ? { output: shortened(live.output) } : {}) });
  }
  const partial = liveState.generation?.message;
  if (partial && textOf(partial.content)) {
    // Retries may append multiple assistant entries under one generation task.
    // Its next assistant ordinal is identical before and after the append commit.
    const messageId = currentGeneration !== undefined
      ? `${sessionId}:assistant-task:${currentGeneration}:${assistantOrdinals.get(currentGeneration) ?? 0}`
      : `${sessionId}:partial:${entries.at(-1)?.id ?? 'start'}:${liveState.generation.attempt}`;
    messages.push({ id: messageId, role: 'assistant', text: shortened(textOf(partial.content)),
      createdAt: timestamp(partial.timestamp, metadata.createdAt), streaming: true });
  }
  const inbox = view.docs['pi.inbox']?.items ?? [];
  const isWorking = Boolean(liveState.run || liveState.generation || inbox.length
    || operations.some(operation => operation.status === 'queued' || operation.status === 'running'));
  const selected = view.docs['pi.agent']?.model;
  const model = models.find(value => value.provider === selected?.provider && value.id === selected?.modelId);
  return withinPhoneBudget({ protocol: DURABLE_PROTOCOL, operations, state: {
    harness: { id: 'pi-durable', name: 'Pi Durable', transport: 'durable-http', version: '1.0.4' },
    ...(model ? { model } : {}), availableModels: models, capabilities: CAPABILITIES,
    connection: { status: 'live', label: synthetic ? 'Synthetic durable test backend' : 'Connected to durable host' },
    session: { id: sessionId, title: metadata.title, project: 'Durable workspace', status: isWorking ? 'working' : 'idle' },
    messages, tools: [...tools.values()], pendingQuestion: null, agents: [], isWorking, readOnly: false,
    storedArtifacts: manifests,
  } });
}
