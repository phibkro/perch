import { DURABLE_CAPABILITIES, DURABLE_HARNESS } from '../harness/capabilities';
import { MAX_DURABLE_PROMPT, MAX_STORED_ARTIFACT_BYTES } from '../harness/durable';
import type { StoredArtifact } from '../harness/durable';
import type { DurableConnection, HarnessDriver, HarnessUpdate, Message, ModelMetadata, SessionSummary } from './types';
import { operationId, sha256 } from './durable/crypto';
import { durableFetch } from './durable/fetch';
import * as project from './durable/projection';

const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;
const EMPTY: SessionSummary = { id: 'durable-empty', title: 'New chat', project: 'Pi Durable workspace', status: 'idle' };
class HttpError extends Error {
  constructor(readonly status: number) {
    super(status === 401 || status === 403 ? 'Pi Durable rejected the server credentials.' : status === 409 ? 'This operation conflicts with existing host state. Refresh the session before trying again.' : `Pi Durable returned HTTP ${status}. Check the host before retrying.`);
  }
}
class DeliveryError extends Error {
  constructor(action: string) { super(`${action} was not confirmed. Reconnect to check its original operation; the host may still be working.`); }
}

export function validateDurableConnection(config: DurableConnection): DurableConnection {
  let url: URL;
  try { url = new URL(config.url.trim()); } catch { throw new Error('Enter a valid https:// Pi Durable server URL.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('Use https:// for a remote Pi Durable server. http:// is accepted only for loopback development.');
  if (url.username || url.password || /[?#]/.test(config.url) || /^[a-z]+:\/\/[^/]*@/i.test(config.url.trim()) || /[\u0000-\u001f\u007f]/.test(config.url)) throw new Error('Keep the token in its separate field. The URL cannot contain credentials, a query, or a fragment.');
  if (config.url.length > 4_096 || typeof config.token !== 'string' || config.token.length < 32 || config.token.length > 512 || /[^\x21-\x7e]/.test(config.token)) throw new Error('Enter the Pi Durable server token, 32–512 printable ASCII characters without whitespace.');
  return { url: url.toString().replace(/\/+$/, ''), token: config.token };
}

async function readBytes(response: Response, maximum: number): Promise<Uint8Array> {
  if (!response.body) throw new project.ProtocolError('empty response');
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) {
    await response.body.cancel(); throw new Error('The server response exceeds the phone size limit.');
  }
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength;
      if (size > maximum) throw new Error('The server response exceeds the phone size limit.');
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
    // Some native decoder implementations ignore fatal. Round-trip validation
    // also rejects replacement characters introduced by malformed UTF-8 bytes.
    if (encoded.length !== bytes.length || encoded.some((byte, index) => byte !== bytes[index])) throw new Error();
    return text;
  } catch { throw new project.ProtocolError('UTF-8 document'); }
}
type Submission = { operationId: string; sessionId: string; text: string; state: 'sending' | 'uncertain' };

/** Construction is network-neutral; credentials and delivery identities stay in memory. */
export async function createDurableDriver(config: DurableConnection, onUpdate: (update: HarnessUpdate) => void): Promise<HarnessDriver> {
  const connection = validateDurableConnection(config); const authorization = `Bearer ${connection.token}`;
  let closed = false; let generation = 0; let selection = 0; let snapshotSequence = 0;
  let controller: AbortController | undefined; let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let authenticated = false; let synthetic = false; let version: string | undefined;
  let selected: HarnessUpdate | undefined; let hostSessions: SessionSummary[] = []; let catalog: readonly ModelMetadata[] = [];
  let status: HarnessUpdate['connection'] = { status: 'connecting', label: 'Connecting to Pi Durable' };
  let sessionAction: HarnessUpdate['sessionAction']; let pendingCreate: { operationId: string } | undefined;
  const submissions = new Map<string, Submission>(); const actions = new Set<string>();
  const notices = new Map<string, Map<string, Message>>();

  function current(g: number) { return !closed && generation === g && !!controller && !controller.signal.aborted; }
  function label() { return `Connected to Pi Durable${synthetic ? ' · controlled test provider' : ''}${selected ? '' : ' · start a new chat'}`; }
  function publish() {
    if (closed) return;
    const capabilities = selected?.capabilities ?? DURABLE_CAPABILITIES;
    onUpdate({
      harness: { ...DURABLE_HARNESS, name: synthetic ? 'Pi Durable · controlled test provider' : DURABLE_HARNESS.name, version },
      capabilities: { ...DURABLE_CAPABILITIES, prompt: !!selected && capabilities.prompt && !sessionAction && actions.size === 0, interrupt: !!selected && capabilities.interrupt, modelSelection: !!selected && capabilities.modelSelection && catalog.length > 0, sessionSelection: capabilities.sessionSelection, sessionCreation: capabilities.sessionCreation },
      connection: status, session: selected?.session ?? EMPTY, sessions: hostSessions, sessionAction,
      model: selected?.model, availableModels: catalog,
      messages: [...(selected?.messages ?? []), ...(selected ? [...(notices.get(selected.session.id)?.values() ?? [])] : [])],
      tools: selected?.tools ?? [], agents: selected?.agents ?? [], pendingQuestion: null,
      isWorking: selected?.isWorking ?? false, readOnly: !authenticated || !!selected?.readOnly,
      storedArtifacts: selected?.storedArtifacts ?? [],
    });
  }
  function notice(sessionId: string, id: string, text: string) {
    const list = notices.get(sessionId) ?? new Map<string, Message>();
    list.set(id, { id: `durable-notice:${id}`, role: 'system', text, createdAt: list.get(id)?.createdAt ?? Date.now() });
    if (list.size > 32) list.delete(list.keys().next().value!);
    notices.set(sessionId, list);
  }
  function confirmed(id: string) {
    const pending = submissions.get(id);
    if (pending) notices.get(pending.sessionId)?.delete(id);
    submissions.delete(id);
  }
  function markUncertain(pending: Submission) {
    pending.state = 'uncertain';
    notice(pending.sessionId, pending.operationId, 'Prompt delivery is unconfirmed. Reconnect checks the original operation. If it remains unknown, explicitly sending exactly the same text reuses that operation ID.');
  }
  function stopRequests() { controller?.abort(); clearTimeout(pollTimer); pollTimer = undefined; }
  function drop(error: unknown, g: number) {
    if (!current(g)) return;
    for (const pending of submissions.values()) if (pending.state === 'sending') markUncertain(pending);
    if (error instanceof HttpError && [401, 403].includes(error.status)) authenticated = false;
    stopRequests(); actions.clear(); sessionAction = undefined;
    status = { status: selected || hostSessions.length ? 'offline' : 'error', label: !authenticated && error instanceof HttpError ? 'Pi Durable authentication failed' : 'Disconnected from Pi Durable', error: error instanceof HttpError || error instanceof project.ProtocolError || error instanceof DeliveryError ? error.message : 'The connection stopped. The host may still be working. Reconnect to read its current state.' };
    publish();
  }
  async function request(path: string, g: number, method = 'GET', body?: unknown, bytes = false): Promise<unknown> {
    if (!current(g)) throw new Error('The connection changed.');
    const signal = controller!.signal; const abort = new AbortController(); const cancel = () => abort.abort();
    signal.addEventListener('abort', cancel, { once: true });
    const timeout = setTimeout(cancel, 20_000); const url = `${connection.url}/perch${path}`;
    try {
      const response = await durableFetch(url, { method, headers: { Authorization: authorization, Accept: bytes ? 'application/octet-stream' : 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', credentials: 'omit', signal: abort.signal });
      if (response.redirected || response.url && response.url !== url) { await response.body?.cancel(); throw new project.ProtocolError('redirect'); }
      if (!response.ok) { await response.body?.cancel(); throw new HttpError(response.status); }
      if (!bytes && !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) { await response.body?.cancel(); throw new project.ProtocolError('JSON content type'); }
      const result = await readBytes(response, bytes ? MAX_STORED_ARTIFACT_BYTES : MAX_RESPONSE_BYTES);
      if (bytes) return result;
      try { return JSON.parse(utf8(result)); } catch { throw new project.ProtocolError('JSON response'); }
    } finally { clearTimeout(timeout); signal.removeEventListener('abort', cancel); }
  }
  async function refresh(g: number, target = selected?.session.id, expectedSelection = selection): Promise<boolean> {
    const sequence = ++snapshotSequence;
    const relevant = () => current(g) && selection === expectedSelection && sequence === snapshotSequence;
    try {
      const [list, value] = await Promise.all([request('/sessions', g), target ? request(`/sessions/${project.routeId(target)}`, g) : Promise.resolve(undefined)]);
      if (!relevant()) return false;
      const nextSessions = project.sessions(list); const nextTarget = target ?? nextSessions[0]?.id;
      const next = nextTarget ? project.snapshot(value ?? await request(`/sessions/${project.routeId(nextTarget)}`, g), nextTarget) : undefined;
      if (!relevant()) return false;
      if (next) {
        const index = nextSessions.findIndex(item => item.id === next.state.session.id);
        if (index === -1) nextSessions.unshift(next.state.session); else nextSessions[index] = next.state.session;
        for (const operation of next.operations) if (submissions.get(operation.operationId)?.sessionId === next.state.session.id) confirmed(operation.operationId);
      }
      selected = next?.state; hostSessions = nextSessions;
      if (selected?.availableModels) catalog = selected.availableModels;
      return true;
    } catch (error) { if (!relevant()) return false; throw error; }
  }
  function armPoll(g: number) {
    clearTimeout(pollTimer);
    if (!current(g) || status.status !== 'live' || sessionAction) return;
    const expectedSelection = selection;
    pollTimer = setTimeout(() => {
      pollTimer = undefined;
      if (!current(g) || selection !== expectedSelection || sessionAction) return;
      void refresh(g).then(changed => { if (changed) publish(); }).catch(error => drop(error, g)).finally(() => { if (current(g) && selection === expectedSelection) armPoll(g); });
    }, selected?.isWorking ? 750 : 6_000);
  }
  async function reconcile(pending: Submission, g: number): Promise<boolean> {
    try {
      project.operation(await request(`/sessions/${project.routeId(pending.sessionId)}/operations/${project.routeId(pending.operationId)}`, g), pending.operationId);
      if (!current(g)) return false;
      confirmed(pending.operationId); return true;
    } catch (error) {
      if (!current(g)) return false;
      if (error instanceof HttpError && error.status === 404) { markUncertain(pending); return false; }
      throw error;
    }
  }
  async function open(reconnecting = false) {
    if (closed) return;
    for (const pending of submissions.values()) if (pending.state === 'sending') markUncertain(pending);
    stopRequests(); const g = ++generation; ++selection; controller = new AbortController(); actions.clear(); sessionAction = undefined;
    status = { status: reconnecting ? 'reconnecting' : 'connecting', label: reconnecting ? 'Reconnecting to Pi Durable' : 'Authenticating with Pi Durable' }; publish();
    try {
      const health = project.health(await request('/health', g)); if (!current(g)) return;
      version = health.harness.version; synthetic = health.synthetic; catalog = health.models;
      let target = selected?.session.id;
      if (pendingCreate) {
        // The catalog has no lookup route. Recover only the exact, already
        // authorized creation identity; never manufacture a replacement ID.
        const created = project.created(await request('/sessions', g, 'POST', pendingCreate));
        if (!current(g)) return;
        pendingCreate = undefined; target = created.session.id;
      }
      for (const pending of [...submissions.values()]) { await reconcile(pending, g); if (!current(g)) return; }
      if (!await refresh(g, target)) return;
      authenticated = true; status = { status: 'live', label: label() }; publish(); armPoll(g);
    } catch (error) { drop(error, g); }
  }
  function canWrite() { return !closed && status.status === 'live' && authenticated && !selected?.readOnly && !sessionAction && actions.size === 0; }
  function actionFailed(error: unknown, g: number) {
    if (!current(g)) return;
    if (!(error instanceof HttpError) || [401, 403].includes(error.status)) { drop(error, g); return; }
    status = { status: 'live', label: `${label()} · action failed`, error: error.message }; publish(); armPoll(g);
  }
  async function loadSession(id: string, creating = false): Promise<string | undefined> {
    const g = generation; const s = ++selection;
    sessionAction = creating ? 'creating' : 'switching'; clearTimeout(pollTimer); publish();
    try {
      if (!await refresh(g, id, s)) return undefined;
      sessionAction = undefined; status = { status: 'live', label: label() }; publish(); armPoll(g); return id;
    } catch (error) {
      if (!current(g) || selection !== s) return undefined;
      sessionAction = undefined;
      if (error instanceof HttpError && [401, 403].includes(error.status)) drop(error, g);
      else { status = { status: 'live', label: 'Could not open this Pi Durable chat', error: error instanceof HttpError || error instanceof project.ProtocolError ? error.message : 'The previous transcript is preserved. Reconnect to refresh the host history.' }; publish(); armPoll(g); }
      return undefined;
    }
  }
  async function mutate(path: string, body: unknown) {
    const g = generation; const s = selection; const id = operationId(); actions.add(id); publish();
    try {
      project.ok(await request(path, g, 'POST', body));
      if (current(g) && selection === s && await refresh(g)) { status = { status: 'live', label: label() }; publish(); }
    } catch (error) { if (current(g) && selection === s) actionFailed(error, g); }
    finally { if (current(g)) { actions.delete(id); publish(); armPoll(g); } }
  }

  return {
    connect() { void open(); }, reconnect() { void open(true); },
    close() { closed = true; ++generation; ++selection; stopRequests(); submissions.clear(); actions.clear(); pendingCreate = undefined; notices.clear(); },
    async createSession() {
      if (!canWrite()) return undefined;
      const g = generation; const s = ++selection; sessionAction = 'creating'; clearTimeout(pollTimer);
      pendingCreate ??= { operationId: operationId() }; publish();
      try {
        const result = project.created(await request('/sessions', g, 'POST', pendingCreate));
        if (!current(g) || selection !== s) return undefined;
        pendingCreate = undefined;
        return await loadSession(result.session.id, true);
      } catch (error) {
        if (!current(g) || selection !== s) return undefined;
        sessionAction = undefined;
        if (error instanceof HttpError && error.status >= 400 && error.status < 500 && error.status !== 408) { pendingCreate = undefined; actionFailed(error, g); }
        else drop(new DeliveryError('Chat creation'), g);
        return undefined;
      }
    },
    selectSession(id) { if (canWrite() && id !== selected?.session.id && hostSessions.some(session => session.id === id)) void loadSession(id); },
    sendPrompt(text) {
      if (!canWrite() || !selected || !selected.capabilities.prompt || selected.isWorking || !text.trim()) return;
      if (text.length > MAX_DURABLE_PROMPT) { status = { status: 'live', label: label(), error: 'This prompt exceeds the 100,000-character phone limit.' }; publish(); return; }
      const g = generation; const sessionId = selected.session.id;
      // An explicit same-text retry after an unknown receipt retains identity.
      const existing = [...submissions.values()].find(item => item.sessionId === sessionId && item.text === text);
      if (submissions.size >= 64 && !existing) { status = { status: 'live', label: label(), error: 'Too many unconfirmed operations. Reconnect to reconcile them before sending more.' }; publish(); return; }
      const pending: Submission = existing ?? { operationId: operationId(), sessionId, text, state: 'sending' };
      pending.state = 'sending'; submissions.set(pending.operationId, pending); actions.add(pending.operationId); publish();
      void (async () => {
        try {
          project.receipt(await request(`/sessions/${sessionId}/submit`, g, 'POST', { operationId: pending.operationId, text }), sessionId, pending.operationId);
          if (!current(g)) return;
          confirmed(pending.operationId);
        } catch (error) {
          if (!current(g)) return;
          if (error instanceof HttpError && error.status >= 400 && error.status < 500 && error.status !== 408) { confirmed(pending.operationId); actionFailed(error, g); return; }
          markUncertain(pending);
          try { await reconcile(pending, g); }
          catch (reconcileError) { drop(reconcileError instanceof HttpError || reconcileError instanceof project.ProtocolError ? reconcileError : new DeliveryError('Prompt delivery'), g); return; }
        }
        if (!current(g)) return;
        try { if (await refresh(g)) { status = { status: 'live', label: label() }; publish(); } } catch (error) { drop(error, g); }
      })().finally(() => { if (current(g)) { actions.delete(pending.operationId); publish(); armPoll(g); } });
    },
    interrupt() { if (canWrite() && selected && selected.capabilities.interrupt && selected.isWorking) void mutate(`/sessions/${selected.session.id}/abort`, {}); },
    answerQuestion() { /* This protocol version does not advertise questions. */ },
    setModel(provider, modelId) {
      if (!canWrite() || !selected || selected.isWorking || !selected.capabilities.modelSelection || !catalog.some(model => model.provider === provider && model.id === modelId)) return;
      void mutate(`/sessions/${selected.session.id}/model`, { provider, modelId });
    },
    async loadArtifact(value: StoredArtifact): Promise<string> {
      if (!current(generation) || status.status !== 'live' || !selected || sessionAction) throw new Error('Reconnect to the artifact’s session before opening it.');
      const g = generation; const s = selection; const manifest = project.artifact(value, selected.session.id);
      const known = selected.storedArtifacts?.find(item => item.id === manifest.id);
      if (!known || known.sha256 !== manifest.sha256 || known.bytes !== manifest.bytes || known.filename !== manifest.filename || known.mimeType !== manifest.mimeType || known.language !== manifest.language || known.sourceId !== manifest.sourceId) throw new Error('This artifact is no longer in the selected session. Refresh its manifest.');
      try {
        const bytes = await request(`/sessions/${manifest.sessionId}/artifacts/${manifest.id}`, g, 'GET', undefined, true) as Uint8Array;
        if (!current(g) || selection !== s) throw new Error('The selected session changed while the artifact loaded.');
        if (bytes.byteLength !== manifest.bytes || await sha256(bytes) !== manifest.sha256) throw new Error('The artifact failed its byte-length or SHA-256 integrity check. Refresh its manifest before trying again.');
        if (!current(g) || selection !== s) throw new Error('The selected session changed while the artifact loaded.');
        return utf8(bytes);
      } catch (error) {
        if (error instanceof HttpError && [401, 403].includes(error.status)) drop(error, g);
        if (error instanceof HttpError || error instanceof project.ProtocolError || error instanceof Error && /^(The artifact failed|The selected session changed)/.test(error.message)) throw error;
        throw new Error('The artifact could not be downloaded from the connected server. Check the connection and retry.');
      }
    },
  };
}
