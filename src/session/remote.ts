import { REMOTE_CAPABILITIES, REMOTE_HARNESS } from '../harness/capabilities';
import {
  isRemoteId, MAX_REMOTE_BYTES, MAX_REMOTE_COMMAND_BYTES, MAX_REMOTE_PROMPT_LENGTH, MAX_REMOTE_ANSWER_LENGTH,
  parseRemoteCatalog, parseRemoteHealth, parseRemoteReceipt, parseRemoteSnapshot,
  type RemoteCatalog, type RemoteCommand, type RemoteHealth, type RemoteReceipt,
  type RemoteSessionSummary, type RemoteSnapshot,
} from '../harness/remote';
import { validateCredentials } from '../workspace/protocol';
import type { HarnessDriver, HarnessUpdate, PendingQuestion, RemoteConnection, SessionSummary } from './types';
import { operationId, sha256 } from './durable/crypto';
import { MAX_STORED_ARTIFACT_BYTES, type StoredArtifact } from '../harness/durable';
import { artifact as parseStoredArtifact } from './durable/projection';
import { remoteFetch } from './remote/fetch';

const EMPTY: SessionSummary = { id: '', title: 'Host sessions', project: '', status: 'idle' };
class ProtocolError extends Error {}
class EpochChanged extends Error {}
class HttpError extends Error {
  constructor(readonly status: number) {
    super(status === 401 || status === 403 ? 'The host rejected the remote-session credentials.'
      : status === 404 || status === 410 ? 'This host session is no longer available. Refresh the host session list.'
      : status === 409 ? 'The host session changed. Refresh it before sending another action.'
      : `The remote adapter returned HTTP ${status}. Check the host before retrying.`);
  }
}
type Pending = { command: RemoteCommand; sessionId: string; state: 'sending' | 'pending' | 'unknown'; message?: string };
const sameSession = (a: RemoteSessionSummary, b: RemoteSessionSummary) => a.id === b.id && a.runtimeId === b.runtimeId && a.generation === b.generation && a.conversationId === b.conversationId;
const summary = (value: RemoteSessionSummary): SessionSummary => ({ id: value.id, title: value.title, project: value.project, status: value.status === 'exited' ? 'idle' : value.status });
const sessionScope = (epoch: string, session: { id: string; generation: string; conversationId?: string }) => JSON.stringify([epoch, session.id, session.generation, session.conversationId ?? null]);
const questionKey = (snapshot: RemoteSnapshot) => snapshot.pendingQuestion
  ? JSON.stringify([sessionScope(snapshot.epoch, snapshot.session), snapshot.pendingQuestion.id, snapshot.pendingQuestion.revision]) : undefined;
const requestKey = (snapshot: RemoteSnapshot) => snapshot.pendingQuestion
  ? JSON.stringify([sessionScope(snapshot.epoch, snapshot.session), snapshot.pendingQuestion.id]) : undefined;
const answerKey = (command: Extract<RemoteCommand, { type: 'answer' }>, sessionId: string) =>
  JSON.stringify([sessionScope(command.epoch, { ...command, id: sessionId }), command.requestId]);
export const validateRemoteConnection = (value: RemoteConnection): RemoteConnection => validateCredentials(value);

function parse<T>(parser: (value: unknown) => T, value: unknown): T {
  try { return parser(value); }
  catch { throw new ProtocolError('The remote host returned invalid session data. Update its Perch adapter and reconnect.'); }
}
async function readBytes(response: Response, maximum: number): Promise<Uint8Array> {
  if (!response.body) throw new ProtocolError('The remote host returned an empty response.');
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) {
    await response.body.cancel(); throw new ProtocolError('The host snapshot exceeds the phone size limit.');
  }
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength;
      if (size > maximum) throw new ProtocolError('The host response exceeds the phone size limit.');
      chunks.push(next.value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
function utf8(bytes: Uint8Array): string {
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    const encoded = new TextEncoder().encode(text);
    if (encoded.length !== bytes.length || encoded.some((byte, index) => byte !== bytes[index])) throw new Error();
    return text;
  } catch { throw new ProtocolError('The remote host returned invalid UTF-8 text.'); }
}

/** Owns an observation of an existing host runtime, never the runtime itself. */
export function createRemoteDriver(config: RemoteConnection, onUpdate: (update: HarnessUpdate) => void): HarnessDriver {
  const connection = validateRemoteConnection(config); const authorization = `Bearer ${connection.token}`;
  let closed = false; let generation = 0; let selection = 0; let readSequence = 0;
  let controller: AbortController | undefined; let timer: ReturnType<typeof setTimeout> | undefined;
  let health: RemoteHealth | undefined; let pinnedHostId: string | undefined;
  let catalog: RemoteCatalog | undefined; let selected: RemoteSnapshot | undefined;
  let status: HarnessUpdate['connection'] = { status: 'connecting', label: 'Connecting to host sessions' };
  let sessionAction: HarnessUpdate['sessionAction']; let notice: string | undefined;
  const pending = new Map<string, Pending>(); const sending = new Set<string>();
  const answers = new Map<string, { scope: string; state: NonNullable<PendingQuestion['answerState']> }>();
  const current = (g: number) => !closed && g === generation && !!controller && !controller.signal.aborted;
  const relevantPending = () => [...pending.values()].filter(item => selected && item.command.epoch === selected.epoch && item.sessionId === selected.session.id && item.command.generation === selected.session.generation && item.command.conversationId === selected.session.conversationId);
  const label = () => selected ? `Attached to ${health?.host.name ?? 'host session'}` : `Connected to ${health?.host.name ?? 'host'} · choose a session`;

  function currentQuestion(): PendingQuestion | null {
    const question = selected?.pendingQuestion; const key = selected && questionKey(selected);
    if (!question || !key) return null;
    const attempt = answers.get(requestKey(selected!)!);
    return { id: key, kind: question.kind, title: question.title, prompt: question.prompt, category: question.category,
      options: question.options, initialValue: question.initialValue, document: question.document,
      ...(!question.actionable ? { disabledReason: question.notice || 'This host request cannot be answered from this view. Open it on the host.' } : {}),
      ...(attempt ? { answering: true, answerState: attempt.state } : {}) };
  }

  function observeQuestion(snapshot: RemoteSnapshot) {
    const scope = sessionScope(snapshot.epoch, snapshot.session); const currentKey = requestKey(snapshot);
    // Only disappearance or replacement ends a mounted request. Its displayed
    // content can change while an answer still has an uncertain outcome.
    for (const [key, attempt] of answers) if (attempt.scope === scope && key !== currentKey) answers.delete(key);
    for (const [id, item] of pending) if (item.command.type === 'answer'
        && sessionScope(item.command.epoch, { ...item.command, id: item.sessionId }) === scope
        && answerKey(item.command, item.sessionId) !== currentKey) pending.delete(id);
  }

  function publish() {
    if (closed) return;
    const live = status.status === 'live'; const valid = !!selected && selected.session.status !== 'exited';
    const unconfirmed = relevantPending();
    const deliveryNotice = unconfirmed.find(item => item.state === 'unknown')?.message;
    const actionPending = sending.size > 0 || unconfirmed.some(item => item.state === 'pending');
    const sessions = catalog?.sessions.map(summary) ?? [];
    onUpdate({
      harness: selected ? { id: selected.session.harness, name: selected.session.harness === 'tern' ? 'Tern session' : 'OMP', transport: 'remote-http' } : REMOTE_HARNESS,
      capabilities: { ...REMOTE_CAPABILITIES, prompt: valid && !!selected?.capabilities.prompt && !selected?.pendingQuestion && !actionPending && !sessionAction,
        interrupt: valid && !!selected?.capabilities.interrupt && !sending.size,
        modelSelection: valid && !!selected?.capabilities.modelSelection && !selected?.pendingQuestion && !!selected?.availableModels.length && !actionPending,
        questions: valid && !!selected?.capabilities.questions && !sessionAction,
        thinkingSelection: valid && !!selected?.capabilities.thinkingSelection && !selected?.pendingQuestion && !unconfirmed.length && !sessionAction,
        sessionRename: valid && !!selected?.capabilities.sessionRename && !selected?.pendingQuestion && !unconfirmed.length && !sessionAction,
        focusSession: valid && !!selected?.capabilities.focusSession && !unconfirmed.length && !sessionAction },
      connection: { ...status, label: live ? label() : status.label, ...(live && (deliveryNotice || notice) ? { error: deliveryNotice || notice } : {}) },
      session: selected ? summary(selected.session) : EMPTY, sessions, sessionAction,
      messages: selected?.messages ?? [], tools: selected?.tools ?? [], agents: [], pendingQuestion: currentQuestion(),
      model: selected?.session.model, availableModels: selected?.availableModels ?? [],
      insights: selected?.insights,
      storedArtifacts: selected?.storedArtifacts ?? [],
      isWorking: selected?.session.status === 'working', readOnly: !selected || selected.readOnly || !valid,
      remote: { host: health?.host, epoch: health?.epoch, sessions: catalog?.sessions ?? [], attached: selected?.session,
        synchronization: 'snapshot', truncated: selected?.truncated ?? false,
        notices: [...(health?.limitations ?? []), ...(selected?.notices ?? []), ...unconfirmed.flatMap(item => item.message ? [item.message] : [])] },
    });
  }
  function stopRequests() { controller?.abort(); clearTimeout(timer); timer = undefined; }
  function unknown(item: Pending) {
    item.state = 'unknown';
    if (item.command.type === 'answer') {
      const attempt = answers.get(answerKey(item.command, item.sessionId)); if (attempt) attempt.state = 'unknown';
    }
    const action = { prompt: 'Prompt', interrupt: 'Interrupt', answer: 'Answer', 'set-model': 'Model change', 'set-thinking': 'Thinking change', 'rename-session': 'Title change', 'focus-session': 'Pane focus' }[item.command.type];
    item.message = `${action} delivery is unconfirmed. Check the host conversation before sending again. Reconnect checks its receipt and never resends it.`;
  }
  function drop(error: unknown, g: number) {
    if (!current(g)) return;
    for (const item of pending.values()) if (item.state === 'sending') unknown(item);
    stopRequests(); sending.clear(); sessionAction = undefined;
    status = { status: health ? 'offline' : 'error', label: 'Disconnected from host sessions',
      error: error instanceof HttpError || error instanceof ProtocolError ? error.message : 'The connection stopped. The host may still be working. Reconnect to read its current state.' };
    publish();
  }
  async function request(path: string, g: number, method = 'GET', body?: unknown, artifactBytes = false): Promise<unknown> {
    if (!current(g)) throw new Error('The connection changed.');
    const signal = controller!.signal; const abort = new AbortController(); const cancel = () => abort.abort();
    signal.addEventListener('abort', cancel, { once: true }); const timeout = setTimeout(cancel, 20_000);
    const url = `${connection.url}/perch${path}`;
    try {
      const encoded = body === undefined ? undefined : JSON.stringify(body);
      if (encoded !== undefined && new TextEncoder().encode(encoded).byteLength > MAX_REMOTE_COMMAND_BYTES) throw new ProtocolError('This action exceeds the remote command size limit.');
      const response = await remoteFetch(url, { method, headers: { Authorization: authorization, Accept: artifactBytes ? 'application/octet-stream' : 'application/json', ...(encoded === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(encoded === undefined ? {} : { body: encoded }), redirect: 'error', credentials: 'omit', signal: abort.signal });
      if (response.redirected || response.url && response.url !== url) { await response.body?.cancel(); throw new ProtocolError('The remote adapter redirected an authenticated request. Use its direct workspace address.'); }
      if (!response.ok) { await response.body?.cancel(); throw new HttpError(response.status); }
      if (!artifactBytes && !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) { await response.body?.cancel(); throw new ProtocolError('The remote host did not return JSON.'); }
      const bytes = await readBytes(response, artifactBytes ? MAX_STORED_ARTIFACT_BYTES : MAX_REMOTE_BYTES);
      if (artifactBytes) return bytes;
      try { return JSON.parse(utf8(bytes)); } catch { throw new ProtocolError('The remote host returned invalid UTF-8 JSON.'); }
    } finally { clearTimeout(timeout); signal.removeEventListener('abort', cancel); }
  }
  function receipt(value: unknown, item: Pending): RemoteReceipt {
    const next = parse(parseRemoteReceipt, value); const command = item.command;
    if (next.id !== command.id || next.sessionId !== item.sessionId || next.epoch !== command.epoch || next.generation !== command.generation || next.conversationId !== command.conversationId) throw new ProtocolError('The host returned a receipt for a different session or command.');
    return next;
  }
  function applyReceipt(value: RemoteReceipt, item: Pending) {
    if (value.status === 'pending') { item.state = 'pending'; item.message = 'The host is processing this action. Its receipt is checked without sending it again.'; }
    else if (value.status === 'unknown') unknown(item);
    else {
      pending.delete(item.command.id);
      if (item.command.type === 'answer') {
        const key = answerKey(item.command, item.sessionId); const attempt = answers.get(key);
        if (value.status === 'rejected') answers.delete(key);
        else if (attempt) attempt.state = 'forwarded';
      }
      if (value.status === 'rejected') notice = value.message || 'The host rejected this action. Inspect the current session before trying again.';
    }
  }
  async function reconcile(item: Pending, g: number) {
    if (item.command.epoch !== health?.epoch) return;
    try {
      const value = receipt(await request(`/sessions/${item.sessionId}/operations/${item.command.id}`, g), item);
      if (current(g)) applyReceipt(value, item);
    } catch (error) {
      if (!current(g)) return;
      if (error instanceof HttpError && [404, 409, 410].includes(error.status)) unknown(item);
      else throw error;
    }
  }
  function clearAttachment(message?: string) { selected = undefined; sessionAction = undefined; notice = message; }
  async function refresh(g: number, target = selected?.session, expectedSelection = selection): Promise<boolean> {
    const sequence = ++readSequence;
    const relevant = () => current(g) && selection === expectedSelection && sequence === readSequence;
    const nextCatalog = parse(parseRemoteCatalog, await request('/sessions', g));
    if (!relevant()) return false;
    if (nextCatalog.epoch !== health?.epoch) throw new EpochChanged();
    if (catalog && nextCatalog.revision < catalog.revision) throw new ProtocolError('The host returned an older session catalog. Reconnect to refresh its authority.');
    const listed = target && nextCatalog.sessions.find(item => item.id === target.id);
    if (target && (!listed || !sameSession(target, listed) || listed.status === 'exited')) {
      catalog = nextCatalog; clearAttachment('The selected host session ended or changed. Choose a session to attach again.'); return true;
    }
    let next: RemoteSnapshot | undefined;
    if (target) {
      try { next = parse(parseRemoteSnapshot, await request(`/sessions/${target.id}`, g)); }
      catch (error) {
        if (!relevant()) return false;
        if (error instanceof HttpError && [404, 409, 410].includes(error.status)) { catalog = nextCatalog; clearAttachment('The selected host session is no longer available. Refresh and choose a session.'); return true; }
        throw error;
      }
      if (!relevant()) return false;
      if (next.epoch !== health?.epoch) throw new EpochChanged();
      if (!sameSession(target, next.session) || next.session.status === 'exited') {
        catalog = nextCatalog; clearAttachment('The host switched its conversation or runtime. Choose a session to attach again.'); return true;
      }
      if (selected && sameSession(selected.session, next.session) && next.revision < selected.revision) throw new ProtocolError('The host returned an older transcript. Reconnect to read its current state.');
      const index = nextCatalog.sessions.findIndex(item => item.id === next!.session.id);
      if (index !== -1) nextCatalog.sessions[index] = next.session;
    }
    catalog = nextCatalog; selected = next;
    if (next) observeQuestion(next);
    return true;
  }
  function armPoll(g: number) {
    clearTimeout(timer);
    if (!current(g) || status.status !== 'live' || sessionAction) return;
    const s = selection;
    timer = setTimeout(() => {
      timer = undefined;
      if (!current(g) || selection !== s || sessionAction) return;
      void (async () => {
        for (const item of relevantPending()) if (item.state === 'pending') await reconcile(item, g);
        if (current(g) && selection === s && await refresh(g, selected?.session, s)) publish();
      })().catch(error => { if (current(g) && selection === s) { if (error instanceof EpochChanged) void open(true); else drop(error, g); } })
        .finally(() => { if (current(g) && selection === s) armPoll(g); });
    }, selected?.session.status === 'working' || selected?.session.status === 'needs-input' || relevantPending().some(item => item.state === 'pending') ? 750 : 3_000);
  }
  async function open(reconnecting = false) {
    if (closed) return;
    for (const item of pending.values()) if (item.state === 'sending') unknown(item);
    stopRequests(); const g = ++generation; ++selection; controller = new AbortController(); sending.clear(); sessionAction = undefined;
    status = { status: reconnecting ? 'reconnecting' : 'connecting', label: reconnecting ? 'Reconnecting to host sessions' : 'Authenticating with host sessions' }; publish();
    try {
      const nextHealth = parse(parseRemoteHealth, await request('/health', g));
      if (!current(g)) return;
      if (pinnedHostId && nextHealth.host.id !== pinnedHostId) throw new ProtocolError('This address identifies a different host. Pair explicitly with its current workspace before attaching.');
      pinnedHostId = nextHealth.host.id;
      if (health && (health.epoch !== nextHealth.epoch || health.adapter !== nextHealth.adapter)) {
        clearAttachment('The host adapter restarted. Choose a session to attach again; previous in-flight actions were not resent.'); catalog = undefined;
      }
      health = nextHealth;
      for (const item of pending.values()) { await reconcile(item, g); if (!current(g)) return; }
      if (!await refresh(g)) return;
      status = { status: 'live', label: label() }; publish(); armPoll(g);
    } catch (error) { drop(error, g); }
  }
  async function attach(target: RemoteSessionSummary) {
    const g = generation; const s = ++selection; clearTimeout(timer); sessionAction = 'switching'; notice = undefined; publish();
    try {
      if (!await refresh(g, target, s)) return;
      sessionAction = undefined; status = { status: 'live', label: label() }; publish(); armPoll(g);
    } catch (error) {
      if (!current(g) || selection !== s) return;
      sessionAction = undefined;
      if (error instanceof EpochChanged) void open(true);
      else drop(error, g);
    }
  }
  const canWrite = () => !closed && status.status === 'live' && !!selected && !selected.readOnly && selected.session.status !== 'exited' && !sessionAction && !sending.size;
  async function dispatch(command: RemoteCommand) {
    if (!selected) return;
    if (pending.size >= 64) { notice = 'Too many unconfirmed actions. Inspect the host and reconnect before sending more.'; publish(); return; }
    const g = generation; const s = selection; const target = selected.session;
    if (command.type === 'answer') {
      if (answers.size >= 64) { notice = 'Too many unanswered host receipts. Reconnect and inspect the host before sending another decision.'; publish(); return; }
      answers.set(answerKey(command, target.id), { scope: sessionScope(command.epoch, target), state: 'sending' });
    }
    const item: Pending = { command, sessionId: target.id, state: 'sending' }; pending.set(command.id, item); sending.add(command.id); clearTimeout(timer); notice = undefined; publish();
    try {
      const value = receipt(await request(`/sessions/${target.id}/commands`, g, 'POST', command), item);
      if (current(g)) applyReceipt(value, item);
    } catch (error) {
      if (!current(g)) return;
      if (error instanceof HttpError && error.status >= 400 && error.status < 500 && error.status !== 408) {
        pending.delete(command.id);
        if (command.type === 'answer') answers.delete(answerKey(command, target.id));
        if ([401, 403].includes(error.status)) { drop(error, g); return; }
        notice = error.message;
      } else {
        unknown(item);
        try { await reconcile(item, g); }
        catch (cause) { if (current(g) && selection === s) drop(cause, g); return; }
      }
    } finally { if (current(g)) sending.delete(command.id); }
    if (!current(g) || selection !== s) return;
    try { if (await refresh(g, target, s)) { status = { status: 'live', label: label() }; publish(); } }
    catch (error) { if (error instanceof EpochChanged) void open(true); else drop(error, g); }
    finally { if (current(g) && selection === s) armPoll(g); }
  }
  function commandIdentity() {
    return { id: operationId(), epoch: selected!.epoch, generation: selected!.session.generation,
      ...(selected!.session.conversationId === undefined ? {} : { conversationId: selected!.session.conversationId }) };
  }
  return {
    connect() { void open(); }, reconnect() { void open(true); },
    close() { closed = true; ++generation; ++selection; stopRequests(); pending.clear(); sending.clear(); answers.clear(); },
    selectSession(id) {
      if (closed || status.status !== 'live' || sessionAction || !isRemoteId(id)) return;
      const target = catalog?.sessions.find(item => item.id === id && item.status !== 'exited');
      if (target && (!selected || !sameSession(target, selected.session))) void attach(target);
    },
    detachSession() {
      if (closed) return;
      const opening = status.status === 'connecting' || status.status === 'reconnecting';
      ++selection; clearTimeout(timer); clearAttachment();
      // An in-flight reconnect was reading the old selection. Start a catalog-
      // only handshake so its discarded response cannot leave us reconnecting.
      if (opening) { void open(true); return; }
      publish(); armPoll(generation);
    },
    sendPrompt(text) {
      if (!canWrite() || !selected!.capabilities.prompt || selected!.pendingQuestion || selected!.session.status !== 'idle' || !text.trim()) return;
      if (text.length > MAX_REMOTE_PROMPT_LENGTH || new TextEncoder().encode(text).byteLength > MAX_REMOTE_COMMAND_BYTES - 4096) { notice = 'This prompt exceeds the remote command size limit. Shorten it before sending.'; publish(); return; }
      if (relevantPending().some(item => item.command.type === 'prompt' && item.command.text === text)) { notice = 'This exact prompt has an unconfirmed receipt. Check the host before submitting it again.'; publish(); return; }
      void dispatch({ ...commandIdentity(), type: 'prompt', text });
    },
    interrupt() { if (canWrite() && selected!.capabilities.interrupt && ['working', 'needs-input'].includes(selected!.session.status)) void dispatch({ ...commandIdentity(), type: 'interrupt' }); },
    setModel(provider, modelId) {
      if (!canWrite() || selected!.pendingQuestion || selected!.session.status !== 'idle' || !selected!.capabilities.modelSelection || !selected!.availableModels.some(item => item.provider === provider && item.id === modelId)) return;
      void dispatch({ ...commandIdentity(), type: 'set-model', provider, modelId });
    },
    setThinking(level) {
      const model = selected?.session.model;
      if (!canWrite() || selected!.pendingQuestion || selected!.session.status !== 'idle' || relevantPending().length
          || !selected!.capabilities.thinkingSelection || !model?.provider || !selected!.insights?.thinking?.availableLevels.includes(level)) return;
      void dispatch({ ...commandIdentity(), type: 'set-thinking', level, provider: model.provider, modelId: model.id });
    },
    renameSession(title) {
      const clean = title.trim();
      if (!canWrite() || selected!.pendingQuestion || selected!.session.status !== 'idle' || relevantPending().length
          || !selected!.capabilities.sessionRename || !clean || clean.length > 160 || /[\u0000-\u001f\u007f]/.test(clean)) return;
      void dispatch({ ...commandIdentity(), type: 'rename-session', title: clean });
    },
    focusSession() {
      if (!canWrite() || !selected!.capabilities.focusSession || relevantPending().length) return;
      void dispatch({ ...commandIdentity(), type: 'focus-session' });
    },
    async loadArtifact(value: StoredArtifact): Promise<string> {
      if (!current(generation) || status.status !== 'live' || !selected || sessionAction) throw new Error('Reconnect to the artifact’s session before opening it.');
      const g = generation, s = selection, scope = sessionScope(selected.epoch, selected.session);
      const manifest = parse(input => parseStoredArtifact(input, selected!.session.id), value);
      const known = selected.storedArtifacts?.find(item => item.id === manifest.id);
      if (!known || JSON.stringify(known) !== JSON.stringify(manifest)) throw new Error('This artifact is no longer in the selected session. Refresh its manifest.');
      const stillSelected = () => current(g) && selection === s && !!selected && sessionScope(selected.epoch, selected.session) === scope
        && selected.storedArtifacts?.some(item => item.id === manifest.id && item.sha256 === manifest.sha256);
      try {
        const bytes = await request(`/sessions/${manifest.sessionId}/artifacts/${manifest.id}`, g, 'GET', undefined, true) as Uint8Array;
        if (!stillSelected()) throw new Error('The selected session changed while the artifact loaded.');
        if (bytes.byteLength !== manifest.bytes || await sha256(bytes) !== manifest.sha256) throw new Error('The artifact failed its byte-length or SHA-256 integrity check. Refresh its manifest before trying again.');
        if (!stillSelected()) throw new Error('The selected session changed while the artifact loaded.');
        return utf8(bytes);
      } catch (error) {
        if (error instanceof HttpError && [401, 403].includes(error.status)) drop(error, g);
        if (error instanceof HttpError || error instanceof ProtocolError || error instanceof Error && /^(The artifact failed|The selected session changed)/.test(error.message)) throw error;
        throw new Error('The artifact could not be downloaded from the connected host. Check the connection and retry.');
      }
    },
    answerQuestion(question, answer) {
      const current = currentQuestion(); const request = selected?.pendingQuestion;
      if (!canWrite() || !selected!.capabilities.questions || !request?.actionable || !current || current.answering
          || question.id !== current.id || !answer.trim()) return;
      if (request.kind === 'choice' && !request.options?.some(option => option.id === answer && !option.disabled)) return;
      if (answer.length > MAX_REMOTE_ANSWER_LENGTH || new TextEncoder().encode(answer).byteLength > MAX_REMOTE_COMMAND_BYTES - 4096) {
        notice = 'This answer exceeds the remote command size limit. Shorten it before sending.'; publish(); return;
      }
      void dispatch({ ...commandIdentity(), type: 'answer', requestId: request.id, requestRevision: request.revision, answer });
    },
  };
}
