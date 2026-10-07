import type { Message, ModelMetadata, PendingQuestion, SessionSummary, ToolActivity } from '../types';

export type ObjectValue = Record<string, unknown>;
export const object = (value: unknown): ObjectValue | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : undefined;
const string = (value: unknown, fallback = '') => typeof value === 'string' ? value : fallback;
export function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('OpenCode returned an invalid list.');
  return value;
}
export interface HostSession { id: string; title: string; directory: string; updated: number; parentID?: string; model?: ModelMetadata }
export function session(value: unknown): HostSession {
  const item = object(value);
  if (!item || typeof item.id !== 'string' || !item.id || typeof item.directory !== 'string') throw new Error('OpenCode returned an invalid session.');
  const model = object(item.model);
  return {
    id: item.id, title: string(item.title, 'OpenCode chat'), directory: item.directory,
    updated: Number(object(item.time)?.updated) || 0, parentID: typeof item.parentID === 'string' ? item.parentID : undefined,
    model: model && typeof model.id === 'string' && typeof model.providerID === 'string' ? { id: model.id, provider: model.providerID } : undefined,
  };
}
export function sessions(value: unknown): HostSession[] {
  return array(value).map(session).filter(item => !item.parentID).sort((a, b) => b.updated - a.updated);
}
export function models(value: unknown): ModelMetadata[] {
  const catalog = object(value);
  if (!catalog || !Array.isArray(catalog.connected)) throw new Error('OpenCode returned an invalid provider catalog.');
  const connected = new Set(catalog.connected.filter((id): id is string => typeof id === 'string'));
  const result = new Map<string, ModelMetadata>();
  for (const candidate of array(catalog.all)) {
    const provider = object(candidate);
    if (!provider || typeof provider.id !== 'string' || !connected.has(provider.id)) continue;
    for (const [key, value] of Object.entries(object(provider.models) ?? {})) {
      const model = object(value);
      if (!model) continue;
      const id = string(model.id, key);
      result.set(`${provider.id}\u0000${id}`, { id, name: string(model.name, id), provider: provider.id });
      if (result.size > 10_000) throw new Error('This host advertises more than 10,000 models. Narrow the host catalog first.');
    }
  }
  // Deliberately discard provider key/options/env/API URLs and all non-display fields.
  return [...result.values()].sort((a, b) => `${a.provider}/${a.name}`.localeCompare(`${b.provider}/${b.name}`));
}
export function statusMap(value: unknown): ObjectValue {
  const map = object(value);
  if (!map) throw new Error('OpenCode returned invalid session statuses.');
  return map;
}
export function working(statuses: ObjectValue, id: string): boolean {
  const type = object(statuses[id])?.type;
  return type === 'busy' || type === 'retry';
}
export function summary(item: HostSession, statuses: ObjectValue, needsInput = false): SessionSummary {
  return { id: item.id, title: item.title, project: item.directory, status: needsInput ? 'needs-input' : working(statuses, item.id) ? 'working' : 'idle' };
}

export interface RequestQuestion {
  id: string;
  sessionID: string;
  type: 'permission' | 'question';
  raw: ObjectValue;
}
export function questions(permissions: unknown, questions: unknown): RequestQuestion[] {
  return [...array(permissions).map(raw => ({ raw, type: 'permission' as const })), ...array(questions).map(raw => ({ raw, type: 'question' as const }))].flatMap(({ raw: value, type }) => {
    const raw = object(value);
    if (!raw || typeof raw.id !== 'string' || typeof raw.sessionID !== 'string') throw new Error('OpenCode returned an invalid pending request.');
    if (type === 'permission' && (typeof raw.permission !== 'string' || !Array.isArray(raw.patterns) || raw.patterns.some(pattern => typeof pattern !== 'string'))) throw new Error('OpenCode returned an invalid permission request.');
    return [{ id: raw.id, sessionID: raw.sessionID, type, raw }];
  });
}
export function question(request: RequestQuestion | undefined, customId?: string, answeringId?: string): PendingQuestion | null {
  if (!request) return null;
  const id = `${request.type}:${request.id}`;
  if (request.type === 'permission') {
    const patterns = Array.isArray(request.raw.patterns) ? request.raw.patterns.filter((pattern): pattern is string => typeof pattern === 'string') : [];
    return { id, kind: 'choice', title: 'OpenCode permission', prompt: `Allow ${string(request.raw.permission, 'this action')}?\n\n${patterns.join('\n')}`, options: [{ id: 'once', label: 'Allow once', description: 'Allow this pending request.' }, { id: 'reject', label: 'Deny', description: 'Reject this pending request.' }], answering: answeringId === id };
  }
  const items = Array.isArray(request.raw.questions) ? request.raw.questions : [];
  const first = object(items[0]);
  if (items.length !== 1 || !first || first.multiple === true) {
    return { id, kind: 'choice', title: 'Answer on the OpenCode host', prompt: 'This request needs multiple questions or multiple selections. Answer it in OpenCode, then Perch will update.\n\n' + items.map(item => string(object(item)?.question)).join('\n\n'), options: [] };
  }
  const options = Array.isArray(first.options) ? first.options.flatMap((value, index) => {
    const option = object(value);
    return option && typeof option.label === 'string' ? [{ id: `option:${index}`, label: option.label, description: string(option.description) }] : [];
  }) : [];
  const custom = first.custom !== false;
  if (custom && (!options.length || customId === request.id)) return { id, kind: 'editor', title: string(first.header, 'OpenCode question'), prompt: string(first.question), answering: answeringId === id };
  return { id, kind: 'choice', title: string(first.header, 'OpenCode question'), prompt: string(first.question), options: [...options, ...(custom ? [{ id: 'custom', label: 'Write an answer', description: 'Enter a custom response.' }] : [])], answering: answeringId === id };
}
export interface LiveText { sessionID: string; messageID: string; partID: string; text: string; complete?: boolean }
export function transcript(value: unknown, sessionID: string, liveText: ReadonlyMap<string, LiveText> = new Map(), deleted?: { parts: ReadonlySet<string>; messages: ReadonlySet<string> }): { messages: Message[]; tools: ToolActivity[]; model?: ModelMetadata } {
  const messages: Message[] = [];
  const tools: ToolActivity[] = [];
  let model: ModelMetadata | undefined;
  for (const item of array(value)) {
    const entry = object(item); const info = object(entry?.info);
    if (!entry || !info || typeof info.id !== 'string' || info.sessionID !== sessionID || !['user', 'assistant'].includes(String(info.role))) throw new Error('OpenCode returned a transcript for an unexpected session.');
    if (deleted?.messages.has(info.id)) continue;
    const time = object(info.time);
    const parts = array(entry.parts).map(object).filter((part): part is ObjectValue => !!part && !(typeof part.id === 'string' && deleted?.parts.has(part.id)));
    if (parts.some(part => part.sessionID !== sessionID || part.messageID !== info.id)) throw new Error('OpenCode returned a part for an unexpected message.');
    const userModel = object(info.model);
    const provider = string(userModel?.providerID, string(info.providerID));
    const modelId = string(userModel?.modelID, string(info.modelID));
    if (provider && modelId) model = { id: modelId, provider };
    if (!(info.role === 'assistant' && info.summary === true)) {
      const textParts = parts.filter(part => part.type === 'text' && !part.ignored).map(part => ({ id: string(part.id), text: string(part.text), completed: !!object(part.time)?.end }));
      if (info.role === 'assistant' && !time?.completed) {
        for (const live of liveText.values()) {
          if (live.sessionID !== sessionID || live.messageID !== info.id || deleted?.parts.has(live.partID) || parts.some(part => part.id === live.partID && part.ignored)) continue;
          const existing = textParts.find(part => part.id === live.partID);
          // A completed host part wins. A compatible uncommitted prefix can be
          // extended by its ordered text events; a divergent snapshot is not guessed.
          if (existing && !existing.completed && (live.complete || live.text.startsWith(existing.text))) existing.text = live.text;
          else if (!existing) textParts.push({ id: live.partID, text: live.text, completed: false });
        }
      }
      const text = textParts.map(part => part.text).join('\n\n');
      const message: Message = { id: info.id, role: info.role as 'user' | 'assistant', text, createdAt: typeof time?.created === 'number' ? time.created : 0, streaming: info.role === 'assistant' && !time?.completed };
      if (text || message.streaming) messages.push(message);
      const error = object(info.error);
      if (error && typeof error.name === 'string') messages.push({ id: `${info.id}:error`, role: 'system', text: error.name === 'MessageAbortedError' ? 'OpenCode stopped this response.' : 'OpenCode reported a model error. Inspect the host for details before retrying.', createdAt: message.createdAt });
    }
    for (const part of parts) {
      if (part.type !== 'tool' || typeof part.id !== 'string' || typeof part.tool !== 'string') continue;
      const state = object(part.state); if (!state) continue;
      const input = object(state.input);
      const status = state.status === 'completed' ? 'done' : state.status === 'error' ? 'error' : state.status === 'pending' || state.status === 'running' ? 'running' : 'unknown';
      tools.push({
        id: part.id, name: part.tool, label: string(state.title, part.tool), status,
        detail: state.status === 'pending' ? 'Waiting for the host' : string(state.title, status === 'running' ? 'Running on OpenCode' : 'Host tool result'),
        output: typeof state.output === 'string' ? state.output : typeof state.error === 'string' ? state.error : undefined,
        artifact: part.tool === 'write' && ['running', 'completed', 'error'].includes(String(state.status)) && input && typeof input.filePath === 'string' && typeof input.content === 'string' ? { filename: input.filePath, content: input.content } : undefined,
      });
    }
  }
  return { messages, tools, model };
}
