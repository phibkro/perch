import { BRIDGE_PROTOCOL, MAX_FRAME_BYTES, parseServerFrame, type BridgeCommand } from '../harness/protocol';
import { PI_CAPABILITIES, PI_HARNESS } from '../harness/capabilities';
import type { HarnessDriver, HarnessUpdate, PiConnection } from './types';

export function validatePiConnection(config: PiConnection): PiConnection {
  let url: URL;
  try { url = new URL(config.url.trim()); } catch { throw new Error('Enter a valid wss:// pi bridge URL.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && local)) throw new Error('Use wss:// for a remote bridge. ws:// is accepted only for loopback development.');
  if (url.username || url.password || url.search || url.hash) throw new Error('Keep the token in the separate token field, not in the URL.');
  const token = config.token.trim();
  if (token.length < 24 || token.length > 4096) throw new Error('The bridge token must have at least 24 characters.');
  return { url: url.toString(), token };
}

/** Network-neutral construction. Credentials live only in this driver's closure. */
export function createPiDriver(config: PiConnection, onUpdate: (state: HarnessUpdate) => void): HarnessDriver {
  const { url, token } = validatePiConnection(config);
  if (typeof WebSocket === 'undefined') throw new Error('This runtime does not provide WebSocket.');
  let socket: WebSocket | undefined;
  let generation = 0;
  let closed = false;
  let sequence = 0;
  let epoch = '';
  let revision = -1;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let answeringId: string | undefined;
  const prefix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`; // Correlation only; authentication uses the supplied token.
  const pending = new Map<string, BridgeCommand>();
  let state: HarnessUpdate = {
    harness: PI_HARNESS, capabilities: PI_CAPABILITIES,
    connection: { status: 'connecting', label: 'Connecting to pi' },
    session: { id: 'pi', title: 'pi session', project: 'Remote host', status: 'idle' },
    messages: [], tools: [], agents: [], pendingQuestion: null, isWorking: false, readOnly: true,
  };
  function publish() {
    if (closed) return;
    onUpdate({ ...state, pendingQuestion: state.pendingQuestion ? { ...state.pendingQuestion, answering: state.pendingQuestion.id === answeringId || state.pendingQuestion.answering } : null });
  }
  function connection(status: HarnessUpdate['connection']['status'], label: string, error?: string) {
    state = { ...state, connection: { status, label, error } }; publish();
  }
  function failPending() {
    if (!pending.size) return;
    const notices = [...pending.values()].map(command => ({ id: `unconfirmed:${command.id}`, role: 'system' as const, createdAt: Date.now(), text: command.type === 'prompt' ? `The connection changed before this prompt was acknowledged. It may have reached the host. Check the transcript before manually resending:\n\n${command.text}` : 'The connection changed before an action was acknowledged. It was not automatically resent.' }));
    state = { ...state, messages: [...state.messages, ...notices] }; pending.clear(); answeringId = undefined;
  }
  function openSocket(reconnecting = false) {
    if (closed) return;
    const current = ++generation;
    clearTimeout(timer); socket?.close(); failPending();
    epoch = ''; revision = -1;
    connection(reconnecting ? 'reconnecting' : 'connecting', reconnecting ? 'Reconnecting to pi' : 'Authenticating with pi bridge');
    const next = new WebSocket(url); socket = next;
    timer = setTimeout(() => { if (current !== generation || closed) return; connection('error', 'Connection timed out', 'The pi bridge did not send a ready snapshot.'); next.close(); }, 15_000);
    next.onopen = () => { if (current === generation && !closed) next.send(JSON.stringify({ type: 'hello', protocol: BRIDGE_PROTOCOL, token })); };
    next.onmessage = event => {
      if (current !== generation || closed) return;
      try {
        if (typeof event.data !== 'string' || event.data.length > MAX_FRAME_BYTES) throw new Error('Invalid or oversized bridge frame.');
        const frame = parseServerFrame(JSON.parse(event.data));
        if (frame.type === 'snapshot') {
          if (frame.epoch === epoch && frame.revision <= revision) return;
          epoch = frame.epoch; revision = frame.revision; state = frame.state;
          if (state.pendingQuestion?.id !== answeringId) answeringId = undefined;
          clearTimeout(timer); publish();
        } else if (frame.type === 'ack') {
          pending.delete(frame.id);
        } else {
          const command = frame.id ? pending.get(frame.id) : undefined;
          if (frame.id) pending.delete(frame.id);
          if (command?.type === 'answer') answeringId = undefined;
          const error = command?.type === 'prompt' ? `${frame.error}\n\nPrompt associated with this error (check the host before retrying):\n${command.text}` : frame.error;
          connection(state.connection.status === 'live' ? 'live' : 'error', state.connection.status === 'live' ? 'Connected to pi · action failed' : 'Could not connect', error);
        }
      } catch (error) {
        connection('error', 'Invalid bridge response', error instanceof Error ? error.message : 'Invalid response.'); next.close();
      }
    };
    next.onerror = () => { if (current === generation && !closed) connection('error', 'Connection failed', 'Could not reach the pi bridge. Check its URL, certificate, and network access.'); };
    next.onclose = event => {
      if (current !== generation || closed) return;
      clearTimeout(timer); failPending();
      if (event.code === 4401) connection('error', 'Authentication failed', 'The bridge rejected this token.');
      else if (event.code === 1009) connection('error', 'Session exceeds the preview limit', 'This bridge uses full snapshots capped at 6 MiB. Use the host to start a smaller session.');
      else if (state.connection.status === 'error' || state.connection.status === 'ended') publish();
      else connection('offline', 'Disconnected from pi', 'The server may still be working. Reconnect to load its current snapshot; no actions are replayed.');
    };
  }
  function send(command: Omit<Extract<BridgeCommand, { type: 'prompt' }>, 'id'> | Omit<Extract<BridgeCommand, { type: 'answer' }>, 'id'> | Omit<Extract<BridgeCommand, { type: 'interrupt' }>, 'id'> | Omit<Extract<BridgeCommand, { type: 'set-model' }>, 'id'>): boolean {
    if (closed || state.readOnly || state.connection.status !== 'live' || socket?.readyState !== 1) return false;
    const frame = { ...command, id: `${prefix}:${++sequence}` } as BridgeCommand;
    try { pending.set(frame.id, frame); socket.send(JSON.stringify(frame)); return true; }
    catch { pending.delete(frame.id); connection('error', 'Action could not be sent', 'Reconnect and check the transcript before trying again.'); return false; }
  }
  return {
    connect: () => openSocket(),
    reconnect: () => openSocket(true),
    close() { closed = true; ++generation; clearTimeout(timer); pending.clear(); socket?.close(); },
    sendPrompt(text) { if (!state.pendingQuestion && state.session.status !== 'needs-input') send({ type: 'prompt', text }); },
    interrupt() { send({ type: 'interrupt' }); },
    answerQuestion(question, answer) {
      const current = state.pendingQuestion;
      if (!current || current.id !== question.id || current.answering || answeringId || (current.kind === 'choice' && !current.options?.some(o => o.id === answer))) return;
      if (send({ type: 'answer', questionId: current.id, answer })) { answeringId = current.id; publish(); }
    },
    setModel(provider, modelId) { if (!state.isWorking && !state.pendingQuestion && state.availableModels?.some(m => m.provider === provider && m.id === modelId)) send({ type: 'set-model', provider, modelId }); },
  };
}
