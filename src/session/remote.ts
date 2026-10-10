import { REMOTE_CAPABILITIES, REMOTE_HARNESS } from '../harness/capabilities';
import {
  isRemoteId, MAX_REMOTE_BYTES, MAX_REMOTE_COMMAND_BYTES, MAX_REMOTE_PROMPT_LENGTH,
  parseRemoteCatalog, parseRemoteHealth, parseRemoteReceipt, parseRemoteSnapshot,
  type RemoteCatalog, type RemoteCommand, type RemoteHealth, type RemoteReceipt,
  type RemoteSessionSummary, type RemoteSnapshot,
} from '../harness/remote';
import { validateCredentials } from '../workspace/protocol';
import type { HarnessDriver, HarnessUpdate, RemoteConnection, SessionSummary } from './types';
import { operationId } from './durable/crypto';
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
export const validateRemoteConnection = (value: RemoteConnection): RemoteConnection => validateCredentials(value);

function parse<T>(parser: (value: unknown) => T, value: unknown): T {
  try { return parser(value); }
  catch { throw new ProtocolError('The remote host returned invalid session data. Update its Perch adapter and reconnect.'); }
}
async function readJson(response: Response): Promise<unknown> {
  if (!response.body) throw new ProtocolError('The remote host returned an empty response.');
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_REMOTE_BYTES)) {
    await response.body.cancel(); throw new ProtocolError('The host snapshot exceeds the phone size limit.');
  }
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_REMOTE_BYTES) throw new ProtocolError('The host snapshot exceeds the phone size limit.');
      chunks.push(next.value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    const encoded = new TextEncoder().encode(text);
    if (encoded.length !== bytes.length || encoded.some((byte, index) => byte !== bytes[index])) throw new Error();
    return JSON.parse(text);
  } catch { throw new ProtocolError('The remote host returned invalid UTF-8 JSON.'); }
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
  const current = (g: number) => !closed && g === generation && !!controller && !controller.signal.aborted;
  const relevantPending = () => [...pending.values()].filter(item => selected && item.command.epoch === selected.epoch && item.sessionId === selected.session.id && item.command.generation === selected.session.generation && item.command.conversationId === selected.session.conversationId);
  const label = () => selected ? `Attached to ${health?.host.name ?? 'host session'}` : `Connected to ${health?.host.name ?? 'host'} · choose a session`;

  function publish() {
    if (closed) return;
    const live = status.status === 'live'; const valid = !!selected && selected.session.status !== 'exited';
    const unconfirmed = relevantPending();
    const deliveryNotice = unconfirmed.find(item => item.state === 'unknown')?.message;
    const actionPending = sending.size > 0 || unconfirmed.some(item => item.state === 'pending');
    const sessions = catalog?.sessions.map(summary) ?? [];
    onUpdate({
      harness: selected ? { id: selected.session.harness, name: selected.session.harness === 'tern' ? 'Tern session' : 'OMP', transport: 'remote-http' } : REMOTE_HARNESS,
      capabilities: { ...REMOTE_CAPABILITIES, prompt: valid && !!selected?.capabilities.prompt && !actionPending && !sessionAction,
        interrupt: valid && !!selected?.capabilities.interrupt && !sending.size,
        modelSelection: valid && !!selected?.capabilities.modelSelection && !!selected?.availableModels.length && !actionPending },
      connection: { ...status, label: live ? label() : status.label, ...(live && (deliveryNotice || notice) ? { error: deliveryNotice || notice } : {}) },
      session: selected ? summary(selected.session) : EMPTY, sessions, sessionAction,
      messages: selected?.messages ?? [], tools: selected?.tools ?? [], agents: [], pendingQuestion: null,
      model: selected?.session.model, availableModels: selected?.availableModels ?? [],
      isWorking: selected?.session.status === 'working', readOnly: !selected || selected.readOnly || !valid,
      remote: { host: health?.host, epoch: health?.epoch, sessions: catalog?.sessions ?? [], attached: selected?.session,
        synchronization: 'snapshot', truncated: selected?.truncated ?? false,
        notices: [...(health?.limitations ?? []), ...(selected?.notices ?? []), ...unconfirmed.flatMap(item => item.message ? [item.message] : [])] },
    });
  }
  function stopRequests() { controller?.abort(); clearTimeout(timer); timer = undefined; }
  function unknown(item: Pending) {
    item.state = 'unknown';
    item.message = `${item.command.type === 'prompt' ? 'Prompt' : item.command.type === 'interrupt' ? 'Interrupt' : 'Model change'} delivery is unconfirmed. Check the host conversation before sending again. Reconnect checks its receipt and never resends it.`;
  }
  function drop(error: unknown, g: number) {
    if (!current(g)) return;
    for (const item of pending.values()) if (item.state === 'sending') unknown(item);
    stopRequests(); sending.clear(); sessionAction = undefined;
    status = { status: health ? 'offline' : 'error', label: 'Disconnected from host sessions',
      error: error instanceof HttpError || error instanceof ProtocolError ? error.message : 'The connection stopped. The host may still be working. Reconnect to read its current state.' };
    publish();
  }
  async function request(path: string, g: number, method = 'GET', body?: unknown): Promise<unknown> {
    if (!current(g)) throw new Error('The connection changed.');
    const signal = controller!.signal; const abort = new AbortController(); const cancel = () => abort.abort();
    signal.addEventListener('abort', cancel, { once: true }); const timeout = setTimeout(cancel, 20_000);
    const url = `${connection.url}/perch${path}`;
    try {
      const encoded = body === undefined ? undefined : JSON.stringify(body);
      if (encoded !== undefined && new TextEncoder().encode(encoded).byteLength > MAX_REMOTE_COMMAND_BYTES) throw new ProtocolError('This action exceeds the remote command size limit.');
      const response = await remoteFetch(url, { method, headers: { Authorization: authorization, Accept: 'application/json', ...(encoded === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(encoded === undefined ? {} : { body: encoded }), redirect: 'error', credentials: 'omit', signal: abort.signal });
      if (response.redirected || response.url && response.url !== url) { await response.body?.cancel(); throw new ProtocolError('The remote adapter redirected an authenticated request. Use its direct workspace address.'); }
      if (!response.ok) { await response.body?.cancel(); throw new HttpError(response.status); }
      if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) { await response.body?.cancel(); throw new ProtocolError('The remote host did not return JSON.'); }
      return await readJson(response);
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
    else { pending.delete(item.command.id); if (value.status === 'rejected') notice = value.message || 'The host rejected this action. Inspect the current session before trying again.'; }
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
    }, selected?.session.status === 'working' || relevantPending().some(item => item.state === 'pending') ? 750 : 3_000);
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
    const item: Pending = { command, sessionId: target.id, state: 'sending' }; pending.set(command.id, item); sending.add(command.id); clearTimeout(timer); notice = undefined; publish();
    try {
      const value = receipt(await request(`/sessions/${target.id}/commands`, g, 'POST', command), item);
      if (current(g)) applyReceipt(value, item);
    } catch (error) {
      if (!current(g)) return;
      if (error instanceof HttpError && error.status >= 400 && error.status < 500 && error.status !== 408) {
        pending.delete(command.id);
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
    close() { closed = true; ++generation; ++selection; stopRequests(); pending.clear(); sending.clear(); },
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
      if (!canWrite() || !selected!.capabilities.prompt || selected!.session.status !== 'idle' || !text.trim()) return;
      if (text.length > MAX_REMOTE_PROMPT_LENGTH || new TextEncoder().encode(text).byteLength > MAX_REMOTE_COMMAND_BYTES - 4096) { notice = 'This prompt exceeds the remote command size limit. Shorten it before sending.'; publish(); return; }
      if (relevantPending().some(item => item.command.type === 'prompt' && item.command.text === text)) { notice = 'This exact prompt has an unconfirmed receipt. Check the host before submitting it again.'; publish(); return; }
      void dispatch({ ...commandIdentity(), type: 'prompt', text });
    },
    interrupt() { if (canWrite() && selected!.capabilities.interrupt && ['working', 'needs-input'].includes(selected!.session.status)) void dispatch({ ...commandIdentity(), type: 'interrupt' }); },
    setModel(provider, modelId) {
      if (!canWrite() || selected!.session.status !== 'idle' || !selected!.capabilities.modelSelection || !selected!.availableModels.some(item => item.provider === provider && item.id === modelId)) return;
      void dispatch({ ...commandIdentity(), type: 'set-model', provider, modelId });
    },
    answerQuestion() { /* Shared dialog answers require a separate host UI broker. */ },
  };
}
