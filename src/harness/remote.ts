import type { Message, ModelMetadata, ToolActivity, SessionInsights } from '../session/types.js';
import { isThinkingLevel, parseSessionInsights } from './insights';
import type { StoredArtifact } from './durable.js';
import { artifact as parseStoredArtifact } from '../session/durable/projection';

/** Perch's projected session protocol. This is neither TSP nor OMP RPC. */
export const REMOTE_PROTOCOL = 'perch-remote';
export const REMOTE_VERSION = 1;
export const MAX_REMOTE_BYTES = 6 * 1024 * 1024;
export const MAX_REMOTE_COMMAND_BYTES = 128 * 1024;
export const MAX_REMOTE_PROMPT_LENGTH = 100_000;
export const MAX_REMOTE_SESSIONS = 256;
export const MAX_REMOTE_MODELS = 10_000;
export const MAX_REMOTE_ANSWER_LENGTH = 100_000;

/** A projection of a live host dialog, never an instruction to run a tool locally. */
export interface RemoteQuestion {
  id: string;
  revision: string;
  kind: 'choice' | 'editor';
  category: 'question' | 'approval' | 'plan';
  actionable: boolean;
  title: string;
  prompt: string;
  options?: { id: string; label: string; description?: string; disabled?: boolean }[];
  initialValue?: string;
  document?: { title: string; content: string; format: 'markdown' | 'text' };
  notice?: string;
}

export interface RemoteHealth {
  protocol: typeof REMOTE_PROTOCOL;
  version: 1;
  host: { id: string; name: string };
  adapter: 'omp' | 'tern';
  epoch: string;
  synchronization: 'snapshot';
  limitations: string[];
}

export interface RemoteSessionSummary {
  id: string;
  generation: string;
  runtimeId: string;
  /** Absent when the adapter cannot identify the underlying conversation. */
  conversationId?: string;
  title: string;
  project: string;
  status: 'idle' | 'working' | 'needs-input' | 'exited';
  harness: 'omp' | 'tern';
  pid?: number;
  model?: ModelMetadata;
  location?: { host?: string; workspace?: string; tab?: string; pane?: string };
}

export interface RemoteCatalog {
  protocol: typeof REMOTE_PROTOCOL;
  version: 1;
  epoch: string;
  revision: number;
  sessions: RemoteSessionSummary[];
}

export interface RemoteCapabilities {
  prompt: boolean;
  interrupt: boolean;
  modelSelection: boolean;
  /** Optional for adapters predating native owner dialogs. */
  questions?: boolean;
  thinkingSelection?: boolean;
  sessionRename?: boolean;
  focusSession?: boolean;
}

export interface RemoteSnapshot {
  protocol: typeof REMOTE_PROTOCOL;
  version: 1;
  epoch: string;
  revision: number;
  session: RemoteSessionSummary;
  capabilities: RemoteCapabilities;
  readOnly: boolean;
  messages: Message[];
  tools: ToolActivity[];
  availableModels: ModelMetadata[];
  truncated: boolean;
  notices: string[];
  pendingQuestion?: RemoteQuestion | null;
  insights?: SessionInsights;
  storedArtifacts?: StoredArtifact[];
}

interface RemoteCommandIdentity {
  id: string;
  epoch: string;
  generation: string;
  conversationId?: string;
}
export type RemoteCommand = RemoteCommandIdentity & (
  | { type: 'prompt'; text: string }
  | { type: 'interrupt' }
  | { type: 'set-model'; provider: string; modelId: string }
  | { type: 'set-thinking'; level: string; provider: string; modelId: string }
  | { type: 'rename-session'; title: string }
  | { type: 'focus-session' }
  | { type: 'answer'; requestId: string; requestRevision: string; answer: string }
);

export interface RemoteReceipt extends RemoteCommandIdentity {
  protocol: typeof REMOTE_PROTOCOL;
  version: 1;
  sessionId: string;
  /** Forwarded acknowledges dispatch, never a completed or persisted agent turn. */
  status: 'pending' | 'forwarded' | 'rejected' | 'unknown';
  message?: string;
}

type RecordValue = Record<string, unknown>;
const object = (value: unknown): value is RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = (value: unknown, maximum: number): value is string => typeof value === 'string' && value.length <= maximum;
const opaque = (value: unknown, maximum = 256): value is string => string(value, maximum) && !!value && !/[\u0000-\u001f\u007f]/.test(value);
export const isRemoteId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
const safeRevision = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
function invalid(part: string): never { throw new Error(`The remote host returned an invalid ${part}. Update its Perch adapter and reconnect.`); }

function envelope(value: unknown): RecordValue {
  if (!object(value) || value.protocol !== REMOTE_PROTOCOL || value.version !== REMOTE_VERSION || !opaque(value.epoch)) invalid('protocol envelope');
  return value;
}

function descriptions(value: unknown, part: string): string[] {
  if (!Array.isArray(value) || value.length > 40 || !value.every(item => string(item, 2000))) invalid(part);
  return [...value];
}

function model(value: unknown): ModelMetadata {
  if (!object(value) || !opaque(value.id, 1024) || (value.name !== undefined && !string(value.name, 1024))
      || (value.provider !== undefined && !opaque(value.provider, 256))) invalid('model metadata');
  return { id: value.id, ...(value.name === undefined ? {} : { name: value.name as string }),
    ...(value.provider === undefined ? {} : { provider: value.provider as string }) };
}

function summary(value: unknown): RemoteSessionSummary {
  if (!object(value) || !isRemoteId(value.id) || !opaque(value.generation) || !opaque(value.runtimeId)
      || (value.conversationId !== undefined && !opaque(value.conversationId, 512))
      || !string(value.title, 512) || !string(value.project, 4096)
      || !['idle', 'working', 'needs-input', 'exited'].includes(String(value.status))
      || !['omp', 'tern'].includes(String(value.harness))
      || (value.pid !== undefined && (!Number.isSafeInteger(value.pid) || Number(value.pid) < 1))) invalid('session identity');
  const result: RemoteSessionSummary = { id: value.id, generation: value.generation, runtimeId: value.runtimeId,
    title: value.title, project: value.project, status: value.status as RemoteSessionSummary['status'], harness: value.harness as 'omp' | 'tern' };
  if (value.conversationId !== undefined) result.conversationId = value.conversationId as string;
  if (value.pid !== undefined) result.pid = value.pid as number;
  if (value.model !== undefined) result.model = model(value.model);
  if (value.location !== undefined) {
    if (!object(value.location)) invalid('session location');
    const location: NonNullable<RemoteSessionSummary['location']> = {};
    for (const key of ['host', 'workspace', 'tab', 'pane'] as const) {
      const field = value.location[key];
      if (field !== undefined) {
        if (!string(field, 512)) invalid('session location');
        location[key] = field;
      }
    }
    result.location = location;
  }
  return result;
}

function unique<T extends { id: string }>(values: T[], part: string): T[] {
  const ids = new Set<string>();
  for (const value of values) { if (ids.has(value.id)) invalid(`duplicate ${part} identity`); ids.add(value.id); }
  return values;
}

export function parseRemoteHealth(input: unknown): RemoteHealth {
  const value = envelope(input);
  if (!object(value.host) || !opaque(value.host.id) || !opaque(value.host.name, 512)
      || !['omp', 'tern'].includes(String(value.adapter)) || value.synchronization !== 'snapshot') invalid('host handshake');
  return { protocol: REMOTE_PROTOCOL, version: REMOTE_VERSION, host: { id: value.host.id, name: value.host.name },
    adapter: value.adapter as 'omp' | 'tern', epoch: value.epoch as string, synchronization: 'snapshot',
    limitations: descriptions(value.limitations, 'host limitations') };
}

export function parseRemoteCatalog(input: unknown): RemoteCatalog {
  const value = envelope(input);
  if (!safeRevision(value.revision) || !Array.isArray(value.sessions) || value.sessions.length > MAX_REMOTE_SESSIONS) invalid('session catalog');
  return { protocol: REMOTE_PROTOCOL, version: REMOTE_VERSION, epoch: value.epoch as string, revision: value.revision,
    sessions: unique(value.sessions.map(summary), 'session') };
}

function message(value: unknown): Message {
  if (!object(value) || !opaque(value.id, 512) || !['user', 'assistant', 'system'].includes(String(value.role))
      || !string(value.text, 2_000_000) || typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt)
      || value.createdAt < 0 || (value.streaming !== undefined && typeof value.streaming !== 'boolean')) invalid('transcript message');
  return { id: value.id, role: value.role as Message['role'], text: value.text, createdAt: value.createdAt,
    ...(value.streaming === undefined ? {} : { streaming: value.streaming as boolean }) };
}

function tool(value: unknown): ToolActivity {
  if (!object(value) || !opaque(value.id, 512) || !string(value.name, 512) || !string(value.label, 1024)
      || !string(value.detail, 2_000_000) || !['running', 'done', 'error', 'interrupted', 'unknown'].includes(String(value.status))
      || (value.output !== undefined && !string(value.output, 2_000_000))) invalid('tool activity');
  const result: ToolActivity = { id: value.id, name: value.name, label: value.label, detail: value.detail,
    status: value.status as ToolActivity['status'] };
  if (value.output !== undefined) result.output = value.output as string;
  if (value.progress !== undefined) {
    if (typeof value.progress !== 'number' || !Number.isFinite(value.progress) || value.progress < 0 || value.progress > 1) invalid('tool progress');
    result.progress = value.progress;
  }
  if (value.artifact !== undefined) {
    const artifact = value.artifact;
    if (!object(artifact) || !opaque(artifact.filename, 4096) || !string(artifact.content, 2_000_000)
        || (artifact.language !== undefined && !string(artifact.language, 128))) invalid('tool artifact');
    result.artifact = { filename: artifact.filename, content: artifact.content,
      ...(artifact.language === undefined ? {} : { language: artifact.language as string }) };
  }
  return result;
}

/** Reject incomplete/malformed request metadata instead of guessing host choices. */
export function parseRemoteQuestion(input: unknown): RemoteQuestion {
  if (!object(input) || !opaque(input.id) || !opaque(input.revision)
      || !['choice', 'editor'].includes(String(input.kind)) || !['question', 'approval', 'plan'].includes(String(input.category))
      || typeof input.actionable !== 'boolean' || !opaque(input.title, 1024) || !string(input.prompt, 100_000)
      || (input.initialValue !== undefined && !string(input.initialValue, MAX_REMOTE_ANSWER_LENGTH))
      || (input.notice !== undefined && !string(input.notice, 2000))) invalid('host request');
  const result: RemoteQuestion = { id: input.id, revision: input.revision, kind: input.kind as RemoteQuestion['kind'],
    category: input.category as RemoteQuestion['category'], actionable: input.actionable, title: input.title, prompt: input.prompt };
  if (input.kind === 'choice' || input.options !== undefined) {
    if (!Array.isArray(input.options) || input.options.length > 64 || !input.options.every(option => object(option)
        && opaque(option.id) && opaque(option.label, 1024) && (option.description === undefined || string(option.description, 4096))
        && (option.disabled === undefined || typeof option.disabled === 'boolean'))) invalid('host request choices');
    result.options = unique(input.options.map(option => ({ id: option.id as string, label: option.label as string,
      ...(option.description === undefined ? {} : { description: option.description as string }),
      ...(option.disabled === undefined ? {} : { disabled: option.disabled as boolean }) })), 'request choice');
    if (input.actionable && input.kind === 'choice' && !result.options.some(option => !option.disabled)) invalid('actionable host request');
  }
  if (input.initialValue !== undefined) result.initialValue = input.initialValue as string;
  if (input.notice !== undefined) result.notice = input.notice as string;
  if (input.document !== undefined) {
    const document = input.document;
    if (!object(document) || !opaque(document.title, 512) || !string(document.content, 200_000)
        || !['markdown', 'text'].includes(String(document.format))) invalid('host request document');
    result.document = { title: document.title, content: document.content, format: document.format as 'markdown' | 'text' };
  }
  return result;
}

export function parseRemoteSnapshot(input: unknown): RemoteSnapshot {
  const value = envelope(input);
  if (!safeRevision(value.revision) || !object(value.capabilities) || typeof value.readOnly !== 'boolean'
      || typeof value.truncated !== 'boolean') invalid('session snapshot');
  const capabilities = value.capabilities;
  for (const key of ['prompt', 'interrupt', 'modelSelection']) if (typeof capabilities[key] !== 'boolean') invalid('session capabilities');
  if (capabilities.questions !== undefined && typeof capabilities.questions !== 'boolean') invalid('session request capability');
  for (const key of ['thinkingSelection', 'sessionRename', 'focusSession']) {
    if (capabilities[key] !== undefined && typeof capabilities[key] !== 'boolean') invalid('session control capability');
  }
  if (!Array.isArray(value.messages) || value.messages.length > 4000 || !Array.isArray(value.tools) || value.tools.length > 4000
      || !Array.isArray(value.availableModels) || value.availableModels.length > MAX_REMOTE_MODELS) invalid('snapshot collections');
  if (value.storedArtifacts !== undefined && (!Array.isArray(value.storedArtifacts) || value.storedArtifacts.length > 128)) invalid('artifact manifests');
  const session = summary(value.session);
  return { protocol: REMOTE_PROTOCOL, version: REMOTE_VERSION, epoch: value.epoch as string, revision: value.revision,
    session, capabilities: { prompt: capabilities.prompt as boolean, interrupt: capabilities.interrupt as boolean,
      modelSelection: capabilities.modelSelection as boolean, questions: capabilities.questions === true,
      thinkingSelection: capabilities.thinkingSelection === true, sessionRename: capabilities.sessionRename === true,
      focusSession: capabilities.focusSession === true }, readOnly: value.readOnly,
    messages: unique(value.messages.map(message), 'message'), tools: unique(value.tools.map(tool), 'tool'),
    availableModels: value.availableModels.map(model), truncated: value.truncated, notices: descriptions(value.notices, 'snapshot notices'),
    pendingQuestion: value.pendingQuestion === undefined || value.pendingQuestion === null ? null : parseRemoteQuestion(value.pendingQuestion),
    ...(value.insights === undefined ? {} : { insights: parseSessionInsights(value.insights) }),
    ...(value.storedArtifacts === undefined ? {} : { storedArtifacts: unique((value.storedArtifacts as unknown[]).map(item => parseStoredArtifact(item, session.id)), 'artifact') }) };
}

/** Public commands accept only their declared fields; no raw terminal or plugin payload. */
export function parseRemoteCommand(input: unknown): RemoteCommand {
  if (!object(input) || !isRemoteId(input.id) || !opaque(input.epoch) || !opaque(input.generation)
      || (input.conversationId !== undefined && !opaque(input.conversationId, 512))) throw new Error('A remote command needs its ID and current session identity.');
  const base = { id: input.id, epoch: input.epoch, generation: input.generation,
    ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId as string }) };
  const keys = ['id', 'epoch', 'generation', 'conversationId', 'type'];
  const only = (extra: string[]) => Object.keys(input).every(key => [...keys, ...extra].includes(key));
  if (input.type === 'prompt' && only(['text']) && string(input.text, MAX_REMOTE_PROMPT_LENGTH) && input.text.trim()) return { ...base, type: 'prompt', text: input.text };
  if (input.type === 'interrupt' && only([])) return { ...base, type: 'interrupt' };
  if (input.type === 'set-model' && only(['provider', 'modelId']) && opaque(input.provider, 256) && opaque(input.modelId, 1024)) return { ...base, type: 'set-model', provider: input.provider, modelId: input.modelId };
  if (input.type === 'set-thinking' && only(['level', 'provider', 'modelId']) && isThinkingLevel(input.level)
      && opaque(input.provider, 256) && opaque(input.modelId, 1024)) return { ...base, type: 'set-thinking', level: input.level, provider: input.provider, modelId: input.modelId };
  if (input.type === 'rename-session' && only(['title']) && opaque(input.title, 160) && input.title.trim()) return { ...base, type: 'rename-session', title: input.title.trim() };
  if (input.type === 'focus-session' && only([])) return { ...base, type: 'focus-session' };
  if (input.type === 'answer' && only(['requestId', 'requestRevision', 'answer']) && opaque(input.requestId) && opaque(input.requestRevision)
      && string(input.answer, MAX_REMOTE_ANSWER_LENGTH) && input.answer.trim()) return { ...base, type: 'answer', requestId: input.requestId, requestRevision: input.requestRevision, answer: input.answer };
  throw new Error('This remote command is unsupported or invalid.');
}

export function parseRemoteReceipt(input: unknown): RemoteReceipt {
  const value = envelope(input);
  if (!isRemoteId(value.id) || !isRemoteId(value.sessionId) || !opaque(value.generation)
      || (value.conversationId !== undefined && !opaque(value.conversationId, 512))
      || !['pending', 'forwarded', 'rejected', 'unknown'].includes(String(value.status))
      || (value.message !== undefined && !string(value.message, 2000))) invalid('command receipt');
  return { protocol: REMOTE_PROTOCOL, version: REMOTE_VERSION, id: value.id, epoch: value.epoch as string,
    sessionId: value.sessionId, generation: value.generation, status: value.status as RemoteReceipt['status'],
    ...(value.conversationId === undefined ? {} : { conversationId: value.conversationId as string }),
    ...(value.message === undefined ? {} : { message: value.message as string }) };
}
