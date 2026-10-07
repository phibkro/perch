import { GuestClient, type GuestSnapshot } from '../vendor/omp/client';
import { parseCollabLink } from '../vendor/omp/link';
import { importRoomKey, open, seal, verifyCodec } from '../vendor/omp/codec';
import type { SessionEntry, CollabUiRequest } from '../vendor/omp/wire';
import type { CollabDriver, CollabUpdate, Message, PendingQuestion, ToolActivity } from './types';
import { OMP_CAPABILITIES, OMP_HARNESS } from '../harness/capabilities';
import { writeArtifact } from '../harness/tool-artifact';

function textContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(block => {
    if (block?.type === 'text') return String(block.text ?? '');
    if (block?.type === 'image') return '[Image attachment — native image preview is not implemented in this prototype.]';
    return '';
  }).filter(Boolean).join('\n');
}

function questionFor(request: CollabUiRequest | null, sessionId: string): PendingQuestion | null {
  if (!request) return null;
  const id = `${sessionId}:question:${request.reqId}`;
  if (request.kind === 'editor') return { id, kind: 'editor', title: request.title, prompt: 'The host is asking for your input.', initialValue: request.prefill ?? '' };
  // Checkbox/markable pickers have terminal-specific semantics; do not submit a false single choice.
  if (request.selectionMarker === 'checkbox') return null;
  return {
    id, kind: 'choice', title: request.title, prompt: request.helpText ?? 'Choose a response for the host.',
    options: request.options.map((option, index) => ({ id: String(index), label: typeof option === 'string' ? option : option.label, description: typeof option === 'string' ? undefined : option.description })),
  };
}

function assistantIdForTimestamp(sessionId: string, timestamp: unknown): string | undefined {
  return typeof timestamp === 'number' && Number.isFinite(timestamp)
    ? `omp:${sessionId}:assistant:${timestamp}` : undefined;
}

export function projectCollab(snapshot: GuestSnapshot, answeringId?: string): CollabUpdate {
  const sessionId = snapshot.header?.id ?? 'collab';
  const messages: Message[] = [];
  const tools = new Map<string, ToolActivity>();
  const seen = new Set<string>();
  const assistantIds = new Set<string>();
  for (const entry of snapshot.entries) {
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    const timestamp = Date.parse(entry.timestamp) || 0;
    if (entry.type === 'message') {
      const m = entry.message;
      if (m.role === 'user' || m.role === 'assistant') {
        const text = textContent(m.content);
        let messageId = entry.id;
        if (m.role === 'assistant') {
          // OMP matches its streaming ghost to the persisted entry by timestamp.
          // Keep that identity after completion so open artifacts stay selected.
          const timestampId = assistantIdForTimestamp(sessionId, m.timestamp);
          messageId = timestampId ?? `omp:${sessionId}:assistant:entry:${entry.id}`;
          // Distinct historical entries may share a timestamp; retain each one
          // without renaming the first entry when a later collision arrives.
          if (timestampId && assistantIds.has(timestampId)) messageId = `${timestampId}:entry:${entry.id}`;
          if (timestampId) assistantIds.add(timestampId);
        }
        if (text) messages.push({ id: messageId, role: m.role, text, createdAt: m.timestamp || timestamp });
        if (m.role === 'assistant') for (const content of m.content) {
          if (content.type === 'toolCall') tools.set(content.id, { id: content.id, name: content.name, label: content.name, status: 'unknown', detail: 'No result recorded yet', artifact: writeArtifact(content.name, content.arguments) });
        }
      } else if (m.role === 'toolResult') {
        tools.set(m.toolCallId, { ...tools.get(m.toolCallId), id: m.toolCallId, name: m.toolName, label: m.toolName, status: m.isError ? 'error' : 'done', detail: m.isError ? 'Tool reported an error' : 'Tool completed', output: textContent(m.content) });
      }
    } else if (entry.type === 'custom_message' && entry.display) {
      const text = textContent(entry.content);
      if (text) messages.push({ id: entry.id, role: entry.customType === 'collab-prompt' ? 'user' : 'system', text, createdAt: timestamp });
    }
  }
  if (snapshot.stream) {
    const text = textContent(snapshot.stream.content);
    const duplicate = snapshot.entries.some((entry: SessionEntry) => entry.type === 'message' && entry.message.role === 'assistant' && entry.message.timestamp === snapshot.stream?.timestamp);
    if (text && !duplicate) messages.push({ id: assistantIdForTimestamp(sessionId, snapshot.stream.timestamp) ?? `omp:${sessionId}:assistant:stream`, role: 'assistant', text, createdAt: snapshot.stream.timestamp, streaming: !snapshot.streamDone });
  }
  for (const [toolId, active] of snapshot.activeTools) {
    tools.set(toolId, { ...tools.get(toolId), id: toolId, name: active.toolName, label: active.toolName, status: 'running', detail: active.intent ?? 'Running on your host', output: active.partialResult ? textContent((active.partialResult as { content?: unknown }).content) : undefined });
  }
  for (const notice of snapshot.notices) messages.push({ id: `notice-${notice.id}`, role: 'system', text: notice.message, createdAt: notice.at });
  if (snapshot.uiRequest?.kind === 'select' && snapshot.uiRequest.selectionMarker === 'checkbox') {
    messages.push({ id: `unsupported-question-${snapshot.uiRequest.reqId}`, role: 'system', text: 'The host requested a multi-selection picker. Answer it in the host terminal; this prototype only supports single-choice and text questions.', createdAt: 0 });
  }
  const question = questionFor(snapshot.uiRequest, sessionId);
  if (question && question.id === answeringId) question.answering = true;
  const isWorking = snapshot.working || snapshot.state?.isStreaming === true;
  const status = snapshot.uiRequest ? 'needs-input' as const : isWorking ? 'working' as const : 'idle' as const;
  const connection = snapshot.phase === 'live'
    ? { status: 'live' as const, label: snapshot.readOnly ? 'Connected · view only' : 'Connected to OMP' }
    : snapshot.phase === 'ended'
      ? { status: 'ended' as const, label: 'Connection ended', error: snapshot.endedReason ?? undefined }
      : snapshot.phase === 'reconnecting'
        ? { status: 'reconnecting' as const, label: 'Reconnecting to OMP' }
        : { status: 'connecting' as const, label: snapshot.loading ? `Loading history · ${snapshot.loading.received}/${snapshot.loading.total}` : 'Waiting for the OMP host' };
  return {
    connection,
    harness: OMP_HARNESS, capabilities: OMP_CAPABILITIES,
    model: snapshot.state?.model ? { id: snapshot.state.model.id, name: snapshot.state.model.name, provider: snapshot.state.model.provider } : undefined,
    session: { id: sessionId, title: snapshot.state?.sessionName || snapshot.header?.title || 'OMP session', project: snapshot.state?.cwd || snapshot.header?.cwd || 'Remote host', status },
    messages, tools: [...tools.values()], pendingQuestion: question,
    agents: snapshot.agents.filter(agent => agent.kind === 'sub').map(agent => ({ id: agent.id, name: agent.displayName, task: snapshot.progress.get(agent.id)?.task ?? 'Host subagent', status: agent.status === 'running' ? 'working' : agent.status === 'aborted' ? 'interrupted' : 'idle' })),
    isWorking, readOnly: snapshot.readOnly,
  };
}

/** Real network activity begins only when the caller invokes connect(). */
export async function createCollabDriver(link: string, name: string, onUpdate: (update: CollabUpdate) => void): Promise<CollabDriver> {
  const parsed = parseCollabLink(link);
  if ('error' in parsed) throw new Error(parsed.error);
  if (typeof WebSocket === 'undefined') throw new Error('This runtime does not provide WebSocket. Use the native development build.');
  // Exercise the selected platform codec before touching the network.
  await verifyCodec();
  const key = await importRoomKey(parsed.key);
  const test = await open(key, await seal(key, { t: 'abort' }));
  if (test.t !== 'abort') throw new Error('Native encryption self-check failed.');

  let client = new GuestClient(link, name);
  let unsubscribe: (() => void) | undefined;
  let answeringId: string | undefined;
  let closed = false;
  let lastNotice = 0;
  const publish = () => {
    if (closed) return;
    const snapshot = client.getSnapshot();
    const currentId = questionFor(snapshot.uiRequest, snapshot.header?.id ?? 'collab')?.id;
    const newError = snapshot.notices.some(n => n.id > lastNotice && n.level === 'error');
    lastNotice = snapshot.notices.at(-1)?.id ?? lastNotice;
    if (currentId !== answeringId || snapshot.phase !== 'live' || newError) answeringId = undefined;
    onUpdate(projectCollab(snapshot, answeringId));
  };
  const subscribe = () => { unsubscribe = client.subscribe(publish); };
  subscribe();
  const canWrite = () => !closed && client.getSnapshot().phase === 'live' && !client.getSnapshot().readOnly;
  return {
    connect() { if (closed) return; publish(); client.connect(); },
    close() { closed = true; unsubscribe?.(); client.close(); },
    sendPrompt(text) { if (canWrite() && !client.getSnapshot().uiRequest) client.sendPrompt(text); },
    interrupt() { if (canWrite()) client.sendAbort(); },
    answerQuestion(question, answer) {
      if (!canWrite() || answeringId) return;
      const snapshot = client.getSnapshot();
      const current = questionFor(snapshot.uiRequest, snapshot.header?.id ?? 'collab');
      if (!current || current.id !== question.id || !snapshot.uiRequest) return;
      let value = answer;
      if (current.kind === 'choice') {
        const option = current.options?.find(o => o.id === answer);
        if (!option) return;
        value = option.label;
      }
      answeringId = current.id;
      publish();
      client.sendUiResponse(snapshot.uiRequest.reqId, value);
    },
    reconnect() {
      if (closed) return;
      unsubscribe?.(); client.close();
      answeringId = undefined; lastNotice = 0;
      client = new GuestClient(link, name);
      subscribe(); publish(); client.connect();
    },
  };
}
