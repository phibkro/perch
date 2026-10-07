import { OPENCODE_CAPABILITIES, OPENCODE_HARNESS } from '../harness/capabilities';
import type { HarnessDriver, HarnessUpdate, Message, ModelMetadata, OpenCodeConnection } from './types';
import { openCodeFetch } from './opencode/fetch';
import * as project from './opencode/projection';

const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;
const MAX_EVENT_CHARACTERS = 256 * 1024;
const EMPTY = { id: 'opencode-empty', title: 'New chat', directory: 'OpenCode workspace', updated: 0 };
class HttpError extends Error {
  constructor(readonly status: number) { super(status === 401 || status === 403 ? 'OpenCode rejected the server credentials.' : `OpenCode returned HTTP ${status}. Check the host before retrying.`); }
}
class GatewayRequiredError extends Error {
  constructor() { super('Connect to the Perch OpenCode gateway, not the raw OpenCode server. The gateway keeps provider credentials on the host. See docs/OPENCODE.md for setup.'); }
}
class InvalidJsonError extends Error { constructor() { super('OpenCode returned invalid JSON.'); } }
export function validateOpenCodeConnection(config: OpenCodeConnection): OpenCodeConnection {
  let url: URL;
  try { url = new URL(config.url.trim()); } catch { throw new Error('Enter a valid https:// OpenCode server URL.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('Use https:// for a remote OpenCode server. http:// is accepted only for loopback development.');
  if (url.username || url.password || url.search || url.hash) throw new Error('Keep server credentials in their separate fields, not in the URL.');
  const username = config.username.trim() || 'perch';
  if (/[:\u0000-\u001f\u007f]/.test(username) || username.length > 256) throw new Error('Enter a valid OpenCode server username without a colon or control characters.');
  if (!config.password || config.password.length > 4096 || /[\u0000-\u001f\u007f]/.test(config.password)) throw new Error('Enter the OpenCode server password.');
  const directory = config.directory?.trim() || undefined;
  if (directory && (directory.length > 4096 || /[\u0000-\u001f\u007f]/.test(directory))) throw new Error('Enter a valid host workspace directory.');
  return { url: url.toString().replace(/\/$/, ''), username, password: config.password, directory };
}
function basicAuth(username: string, password: string): string {
  // HTTP Basic uses UTF-8 bytes; btoa alone corrupts non-ASCII credentials.
  const bytes = encodeURIComponent(`${username}:${password}`).replace(/%([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  return `Basic ${btoa(bytes)}`;
}
async function readJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('OpenCode returned an empty response.');
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) { await response.body.cancel(); throw new Error('This OpenCode response exceeds the 12 MiB phone limit.'); }
  const reader = response.body.getReader(); const decoder = new TextDecoder();
  let text = ''; let size = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error('This OpenCode response exceeds the 12 MiB phone limit.');
      text += decoder.decode(next.value, { stream: true });
    }
    text += decoder.decode();
    try { return JSON.parse(text); } catch { throw new InvalidJsonError(); }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Construction validates configuration but starts no network request. */
export async function createOpenCodeDriver(config: OpenCodeConnection, onUpdate: (update: HarnessUpdate) => void): Promise<HarnessDriver> {
  const connection = validateOpenCodeConnection(config);
  const authorization = basicAuth(connection.username, connection.password);
  let workspaceDirectory = connection.directory;
  let closed = false; let generation = 0; let selection = 0; let snapshotSequence = 0;
  let controller: AbortController | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  let refreshing = false; let dirty = false;
  let active: project.HostSession | undefined;
  let hostSessions: project.HostSession[] = [];
  let statuses: project.ObjectValue = {};
  let requests: project.RequestQuestion[] = [];
  let catalog: ModelMetadata[] = [];
  let contents: ReturnType<typeof project.transcript> = { messages: [], tools: [] };
  let history: unknown = [];
  const liveText = new Map<string, project.LiveText>();
  const seenTextEvents = new Set<string>();
  const deleted = { parts: new Set<string>(), messages: new Set<string>() };
  let version: string | undefined;
  let sessionAction: HarnessUpdate['sessionAction'];
  let answeringId: string | undefined; let customQuestionId: string | undefined;
  let promptPending = false;
  let authenticated = false;
  const selectedModels = new Map<string, ModelMetadata>();
  const notices = new Map<string, Message[]>();
  const writes = new Map<number, { sessionID?: string; label: string }>();
  let writeSequence = 0;
  let status: HarnessUpdate['connection'] = { status: 'connecting', label: 'Connecting to OpenCode' };
  function current(g: number) { return !closed && g === generation && !controller?.signal.aborted; }
  function pending() { return requests.find(item => item.sessionID === active?.id); }
  function publish() {
    if (closed) return;
    const question = project.question(pending(), customQuestionId, answeringId);
    const model = active ? selectedModels.get(active.id) ?? active.model ?? contents.model : undefined;
    const namedModel = model ? catalog.find(item => item.provider === model.provider && item.id === model.id) ?? model : undefined;
    onUpdate({
      harness: { ...OPENCODE_HARNESS, version },
      capabilities: { ...OPENCODE_CAPABILITIES, prompt: !!active && !sessionAction && !promptPending, modelSelection: !!active && catalog.length > 0 },
      connection: status, session: project.summary(active ?? EMPTY, statuses, !!question),
      sessions: hostSessions.map(item => project.summary(item, statuses, requests.some(request => request.sessionID === item.id))),
      sessionAction, model: namedModel, availableModels: catalog,
      messages: [...contents.messages, ...(active ? notices.get(active.id) ?? [] : [])], tools: contents.tools,
      pendingQuestion: question, agents: [], isWorking: !!active && project.working(statuses, active.id), readOnly: !authenticated,
    });
  }
  function addNotice(sessionID: string, text: string) {
    notices.set(sessionID, [...(notices.get(sessionID) ?? []), { id: `opencode-notice:${Date.now()}:${++writeSequence}`, role: 'system', text, createdAt: Date.now() }]);
  }
  function stopRequests() {
    controller?.abort(); clearTimeout(refreshTimer); clearTimeout(readyTimer); clearInterval(pollTimer);
    refreshTimer = undefined; pollTimer = undefined; refreshing = false; dirty = false;
  }
  function dropped(error: unknown, g: number) {
    if (!current(g)) return;
    for (const write of writes.values()) if (write.sessionID) addNotice(write.sessionID, `${write.label} was not confirmed before the connection changed. It may have reached OpenCode. Check the host history before manually trying again; Perch did not resend it.`);
    writes.clear(); promptPending = false; answeringId = undefined; sessionAction = undefined;
    if (error instanceof GatewayRequiredError || error instanceof HttpError && [401, 403].includes(error.status)) authenticated = false;
    stopRequests();
    status = { status: active || hostSessions.length ? 'offline' : 'error', label: error instanceof GatewayRequiredError ? 'Perch gateway required' : error instanceof HttpError && [401, 403].includes(error.status) ? 'OpenCode authentication failed' : 'Disconnected from OpenCode', error: error instanceof HttpError || error instanceof GatewayRequiredError ? error.message : 'The connection stopped. The host may still be working. Reconnect to load its current state; no actions are replayed.' };
    publish();
  }
  async function request(path: string, g: number, method = 'GET', body?: unknown): Promise<unknown> {
    if (!current(g)) throw new Error('Connection changed.');
    const abort = new AbortController(); const signal = controller!.signal;
    const cancel = () => abort.abort(); signal.addEventListener('abort', cancel, { once: true });
    const timeout = setTimeout(cancel, 30_000);
    const url = new URL(connection.url + path);
    if (workspaceDirectory) url.searchParams.set('directory', workspaceDirectory);
    try {
      const response = await openCodeFetch(url.toString(), { method, headers: { Authorization: authorization, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', credentials: 'omit', signal: abort.signal });
      if (!response.ok) { await response.body?.cancel(); throw new HttpError(response.status); }
      return response.status === 204 ? undefined : await readJson(response);
    } finally { clearTimeout(timeout); signal.removeEventListener('abort', cancel); }
  }
  async function snapshot(g: number, target = active?.id, expectedSelection = selection): Promise<boolean> {
    const sequence = ++snapshotSequence;
    const relevant = () => current(g) && selection === expectedSelection && sequence === snapshotSequence;
    try {
      const [list, state, permissions, questionList, nextHistory] = await Promise.all([
        request('/session?roots=true&limit=200', g), request('/session/status', g), request('/permission', g), request('/question', g),
        target ? request(`/session/${encodeURIComponent(target)}/message`, g) : Promise.resolve([]),
      ]);
      if (!relevant()) return false;
      const nextSessions = project.sessions(list);
      const nextStatuses = project.statusMap(state);
      const nextRequests = project.questions(permissions, questionList);
      const nextActive = target ? nextSessions.find(item => item.id === target) ?? hostSessions.find(item => item.id === target) ?? (active?.id === target ? active : undefined) : undefined;
      if (target && !nextActive) throw new Error('This session is no longer available in the host history.');
      const nextContents = target ? project.transcript(nextHistory, target, liveText, deleted) : { messages: [], tools: [] };
      // Successful history read verifies that an older selected session still exists.
      // Keep it addressable when it has fallen outside the 200 most recent rows.
      if (nextActive && !nextSessions.some(item => item.id === nextActive.id)) nextSessions.unshift(nextActive);
      hostSessions = nextSessions; statuses = nextStatuses; requests = nextRequests; active = nextActive; contents = nextContents; history = nextHistory;
      const completed = new Set(nextContents.messages.filter(message => message.role !== 'assistant' || !message.streaming).map(message => message.id));
      for (const [key, part] of liveText) if (part.sessionID !== active?.id || completed.has(part.messageID)) liveText.delete(key);
      if (!pending() || `${pending()!.type}:${pending()!.id}` !== answeringId) answeringId = undefined;
      if (pending()?.id !== customQuestionId) customQuestionId = undefined;
      return true;
    } catch (error) {
      // Rejected reads retire with their successful equivalents. An old chat's
      // failed refresh must not disconnect a newer selection or snapshot.
      if (!relevant()) return false;
      throw error;
    }
  }
  function queueRefresh(g: number) {
    dirty = true;
    if (!current(g) || sessionAction || refreshing || refreshTimer || status.status !== 'live') return;
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      if (!current(g) || sessionAction) return;
      dirty = false; refreshing = true;
      void snapshot(g).then(changed => { if (changed) publish(); }).catch(error => dropped(error, g)).finally(() => {
        if (!current(g)) return;
        refreshing = false; if (dirty) queueRefresh(g);
      });
    }, 150);
  }
  async function events(g: number, response: Response) {
    if (!response.body) throw new Error('This runtime cannot stream OpenCode events.');
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
    try {
      while (current(g)) {
        const chunk = await reader.read(); if (chunk.done) throw new Error('OpenCode event stream ended.');
        buffer = (buffer + decoder.decode(chunk.value, { stream: true })).replace(/\r\n/g, '\n');
        if (buffer.length > MAX_EVENT_CHARACTERS) throw new Error('OpenCode event exceeds the phone limit.');
        let end: number;
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
          if (!data) continue;
          const event = project.object(JSON.parse(data)); if (!event || typeof event.type !== 'string') throw new Error('Invalid OpenCode event.');
          if (event.type === 'server.instance.disposed') throw new Error('OpenCode workspace restarted.');
          if (event.type === 'perch.removed' && event.sessionID === active?.id && typeof event.messageID === 'string') {
            if (typeof event.partID === 'string') { deleted.parts.add(event.partID); liveText.delete(event.partID); }
            else { deleted.messages.add(event.messageID); for (const [key, part] of liveText) if (part.messageID === event.messageID) liveText.delete(key); }
            if (deleted.parts.size + deleted.messages.size > 10_000) throw new Error('Reconnect to refresh this large history change.');
            if (active) { contents = project.transcript(history, active.id, liveText, deleted); publish(); }
            queueRefresh(g);
          }
          if (event.type === 'perch.text') {
            if (typeof event.sessionID !== 'string' || event.sessionID !== active?.id || typeof event.messageID !== 'string' || typeof event.partID !== 'string' || typeof event.text !== 'string') continue;
            if (typeof event.id === 'string') { if (seenTextEvents.has(event.id)) continue; seenTextEvents.add(event.id); if (seenTextEvents.size > 4000) seenTextEvents.delete(seenTextEvents.values().next().value!); }
            const previous = liveText.get(event.partID);
            if (event.operation === 'replace') { deleted.parts.delete(event.partID); liveText.set(event.partID, { sessionID: event.sessionID, messageID: event.messageID, partID: event.partID, text: event.text, complete: event.complete === true }); }
            else if (event.operation === 'append' && previous?.messageID === event.messageID && previous.sessionID === event.sessionID) liveText.set(event.partID, { ...previous, text: previous.text + event.text });
            // Orphan deltas after a mid-response reconnect do not form a complete
            // message. Wait for a full text part or the final host history instead.
            if (liveText.size > 1000 || [...liveText.values()].reduce((size, part) => size + part.text.length, 0) > MAX_RESPONSE_BYTES) throw new Error('Live OpenCode text exceeds the phone limit.');
            if (active) { contents = project.transcript(history, active.id, liveText, deleted); publish(); }
            queueRefresh(g);
          }
          if (event.type === 'perch.invalidate' || event.type.startsWith('message.') || event.type.startsWith('session.') || event.type.startsWith('permission.') || event.type.startsWith('question.')) queueRefresh(g);
          if (event.type === 'models-dev.refreshed') void request('/provider', g).then(value => { if (current(g)) { catalog = project.models(value); publish(); } }).catch(error => dropped(error, g));
        }
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  async function open(reconnecting = false) {
    if (closed) return;
    // Mark unacknowledged mutations before cancelling their transport. Never replay them.
    if (writes.size && controller) dropped(new Error('Reconnect requested.'), generation);
    stopRequests(); const g = ++generation; ++selection; controller = new AbortController(); liveText.clear(); seenTextEvents.clear(); deleted.parts.clear(); deleted.messages.clear();
    sessionAction = undefined; promptPending = false; answeringId = undefined;
    status = { status: reconnecting ? 'reconnecting' : 'connecting', label: reconnecting ? 'Reconnecting to OpenCode' : 'Authenticating with OpenCode' }; publish();
    readyTimer = setTimeout(() => dropped(new Error('OpenCode did not become ready.'), g), 30_000);
    try {
      let health: project.ObjectValue | undefined;
      try { health = project.object(await request('/perch/health', g)); }
      catch (error) { if (error instanceof InvalidJsonError || error instanceof HttpError && [404, 405].includes(error.status)) throw new GatewayRequiredError(); throw error; }
      if (!health || health.protocol !== 'perch-opencode' || health.version !== 1 || health.healthy !== true || typeof health.upstreamVersion !== 'string') throw new GatewayRequiredError();
      version = health.upstreamVersion;
      if (!workspaceDirectory && typeof health.directory === 'string') workspaceDirectory = health.directory;
      const eventUrl = new URL(connection.url + '/event'); if (workspaceDirectory) eventUrl.searchParams.set('directory', workspaceDirectory);
      const response = await openCodeFetch(eventUrl.toString(), { headers: { Authorization: authorization, Accept: 'text/event-stream' }, credentials: 'omit', redirect: 'error', signal: controller.signal });
      if (!response.ok) { await response.body?.cancel(); throw new HttpError(response.status); }
      if (!response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('OpenCode did not return an event stream.');
      void events(g, response).catch(error => dropped(error, g));
      const [list, providerList] = await Promise.all([request('/session?roots=true&limit=200', g), request('/provider', g)]);
      if (!current(g)) return;
      const initial = project.sessions(list); catalog = project.models(providerList);
      // The capped recent list is not an existence check. Reconnect the selected
      // chat directly; an unavailable history preserves its last transcript.
      const target = active?.id ?? initial[0]?.id;
      if (!await snapshot(g, target)) return;
      authenticated = true; status = { status: 'live', label: 'Connected to OpenCode' }; clearTimeout(readyTimer); publish();
      pollTimer = setInterval(() => queueRefresh(g), 15_000);
      if (dirty) queueRefresh(g);
    } catch (error) { dropped(error, g); }
  }
  function canWrite() { return !closed && status.status === 'live' && !sessionAction; }
  async function mutate(label: string, path: string, body?: unknown, sessionID = active?.id): Promise<boolean> {
    const g = generation; const id = ++writeSequence; writes.set(id, { label, sessionID });
    try {
      await request(path, g, 'POST', body);
      if (!current(g)) return false;
      writes.delete(id); return true;
    } catch (error) {
      if (!current(g)) return false;
      writes.delete(id);
      if (error instanceof HttpError && [401, 403].includes(error.status)) dropped(error, g);
      else if (!(error instanceof HttpError)) { if (sessionID) addNotice(sessionID, `${label} was not confirmed. It may have reached OpenCode. Check the host history before manually retrying; it was not resent.`); dropped(error, g); }
      else { status = { status: 'live', label: 'Connected to OpenCode · action failed', error: error.message }; publish(); }
      return false;
    }
  }
  async function loadSession(id: string, creating = false): Promise<string | undefined> {
    const g = generation; const s = ++selection;
    sessionAction = creating ? 'creating' : 'switching'; customQuestionId = undefined; publish();
    try {
      if (!await snapshot(g, id, s)) return undefined;
      sessionAction = undefined; status = { status: 'live', label: 'Connected to OpenCode' }; publish(); if (dirty) queueRefresh(g); return id;
    } catch (error) {
      if (!current(g) || selection !== s) return undefined;
      sessionAction = undefined;
      status = { status: 'live', label: 'Could not open this OpenCode chat', error: error instanceof HttpError ? error.message : 'The previous transcript is preserved. Reconnect and inspect the host history before trying again.' }; publish();
      if (dirty) queueRefresh(g); return undefined;
    }
  }
  return {
    connect() { void open(); }, reconnect() { void open(true); },
    close() { closed = true; ++generation; ++selection; stopRequests(); writes.clear(); },
    async createSession() {
      if (!canWrite() || promptPending) return undefined;
      const g = generation; sessionAction = 'creating'; ++selection; publish();
      const id = ++writeSequence; writes.set(id, { label: 'New chat' });
      try {
        const created = project.session(await request('/session', g, 'POST', {}));
        if (!current(g)) return undefined;
        writes.delete(id);
        // The create response proves identity. Transcript publication waits for its complete read.
        hostSessions = [created, ...hostSessions.filter(item => item.id !== created.id)];
        return await loadSession(created.id, true);
      } catch (error) {
        if (!current(g)) return undefined;
        writes.delete(id); sessionAction = undefined;
        if (error instanceof HttpError && [401, 403].includes(error.status)) { dropped(error, g); return undefined; }
        status = { status: 'live', label: 'OpenCode chat creation was not confirmed', error: error instanceof HttpError ? error.message : 'The host may have created this chat. Inspect its history before trying New chat again; Perch did not repeat the request.' }; publish(); queueRefresh(g); return undefined;
      }
    },
    selectSession(id) { if (canWrite() && !promptPending && id !== active?.id && hostSessions.some(item => item.id === id)) void loadSession(id); },
    sendPrompt(text) {
      if (!canWrite() || !active || promptPending || !text.trim() || pending() || project.working(statuses, active.id)) return;
      const g = generation; const id = active.id; const model = selectedModels.get(id); promptPending = true; publish();
      void mutate('The prompt', `/session/${encodeURIComponent(id)}/prompt_async`, { parts: [{ type: 'text', text }], ...(model?.provider ? { model: { providerID: model.provider, modelID: model.id } } : {}) }, id).then(async ok => {
        if (!current(g)) return;
        if (ok) { try { await snapshot(g); } catch (error) { dropped(error, g); } }
        if (current(g)) { promptPending = false; publish(); }
      });
    },
    interrupt() { const g = generation; if (canWrite() && active) void mutate('The interrupt', `/session/${encodeURIComponent(active.id)}/abort`).then(ok => { if (ok && current(g)) queueRefresh(g); }); },
    answerQuestion(displayed, answer) {
      if (!canWrite() || !active || answeringId) return;
      const request = pending(); const currentQuestion = project.question(request, customQuestionId);
      if (!request || !currentQuestion || displayed.id !== currentQuestion.id || (currentQuestion.kind === 'choice' && !currentQuestion.options?.some(option => option.id === answer))) return;
      if (request.type === 'question' && answer === 'custom' && currentQuestion.kind === 'choice') { customQuestionId = request.id; publish(); return; }
      if (currentQuestion.kind === 'editor' && !answer.trim()) return;
      const body = request.type === 'permission' ? { reply: answer } : { answers: [[currentQuestion.kind === 'editor' ? answer : currentQuestion.options!.find(option => option.id === answer)!.label]] };
      const g = generation; answeringId = currentQuestion.id; publish();
      void mutate('The answer', `/${request.type}/${encodeURIComponent(request.id)}/reply`, body).then(ok => {
        if (!current(g)) return;
        if (!ok) { answeringId = undefined; publish(); } else queueRefresh(g);
      });
    },
    setModel(provider, modelId) {
      if (!canWrite() || !active || promptPending || pending() || project.working(statuses, active.id)) return;
      const selected = catalog.find(model => model.provider === provider && model.id === modelId);
      if (!selected) return;
      selectedModels.set(active.id, selected); status = { status: 'live', label: 'Connected to OpenCode · model selected for the next prompt' }; publish();
    },
  };
}
