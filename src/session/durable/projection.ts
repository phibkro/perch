import { DURABLE_PROTOCOL, DURABLE_SERVICE, MAX_STORED_ARTIFACT_BYTES } from '../../harness/durable';
import type { DurableCreateResult, DurableHealth, DurableOperation, DurableReceipt, DurableSnapshot, StoredArtifact } from '../../harness/durable';
import type { AgentSummary, HarnessCapabilities, HarnessUpdate, Message, ModelMetadata, SessionSummary, ToolActivity } from '../types';

/** Only this module turns untrusted wire values into phone display state. */
export class ProtocolError extends Error {
  constructor(part = 'response') { super(`The durable server returned an invalid ${part}. Reconnect after checking the host version.`); }
}
type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProtocolError();
  return value as ObjectValue;
}
function text(value: unknown, maximum = 512, empty = false): string {
  if (typeof value !== 'string' || value.length > maximum || (!empty && !value.length)) throw new ProtocolError();
  return value;
}
function label(value: unknown, maximum = 512): string {
  const result = text(value, maximum);
  if (/[\u0000-\u001f\u007f]/.test(result)) throw new ProtocolError();
  return result;
}
export function routeId(value: unknown): string {
  const result = text(value, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(result)) throw new ProtocolError('identifier');
  return result;
}
function flag(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new ProtocolError();
  return value;
}
function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) throw new ProtocolError();
  return value;
}
function values<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new ProtocolError();
  return value as T;
}
function rows<T>(value: unknown, project: (row: unknown) => T, maximum = 10_000): T[] {
  if (!Array.isArray(value) || value.length > maximum) throw new ProtocolError();
  return value.map(project);
}
function unique<T>(list: T[], identity: (item: T) => string): T[] {
  const ids = list.map(identity);
  if (new Set(ids).size !== list.length) throw new ProtocolError('duplicate identifier');
  return list;
}
function model(value: unknown): ModelMetadata {
  const item = object(value);
  return { id: label(item.id, 512), ...(item.name === undefined ? {} : { name: label(item.name) }), ...(item.provider === undefined ? {} : { provider: label(item.provider) }) };
}
function models(value: unknown): ModelMetadata[] {
  return unique(rows(value, model, 2_000), item => JSON.stringify([item.provider, item.id]));
}
export function session(value: unknown): SessionSummary {
  const item = object(value);
  return { id: routeId(item.id), title: label(item.title), project: label(item.project), status: values(item.status, ['idle', 'working', 'needs-input']) };
}
export function sessions(value: unknown): SessionSummary[] {
  return unique(rows(object(value).sessions, session, 2_000), item => item.id);
}
export function health(value: unknown): DurableHealth {
  const item = object(value); const harness = object(item.harness);
  if (item.service !== DURABLE_SERVICE || item.protocol !== DURABLE_PROTOCOL || harness.name !== 'Pi Durable') throw new ProtocolError('service handshake');
  return { service: DURABLE_SERVICE, protocol: DURABLE_PROTOCOL, harness: { name: 'Pi Durable', version: label(harness.version, 128) }, synthetic: flag(item.synthetic), models: models(item.models) };
}
export function created(value: unknown): DurableCreateResult {
  const item = object(value);
  return { session: session(item.session), accepted: flag(item.accepted) };
}
export function receipt(value: unknown, sessionId: string, operationId: string): DurableReceipt {
  const item = object(value);
  if (item.session !== sessionId || item.operationId !== operationId) throw new ProtocolError('submission receipt');
  return { operationId, session: sessionId, accepted: flag(item.accepted) };
}
export function operation(value: unknown, expectedId?: string): DurableOperation {
  const item = object(value); const operationId = routeId(item.operationId);
  if (expectedId !== undefined && operationId !== expectedId) throw new ProtocolError('operation receipt');
  return { operationId, status: values(item.status, ['queued', 'running', 'done', 'unanswered']) };
}
export function ok(value: unknown): void {
  if (object(value).ok !== true) throw new ProtocolError('action receipt');
}
function capabilities(value: unknown): HarnessCapabilities {
  const item = object(value);
  const result = { prompt: flag(item.prompt), interrupt: flag(item.interrupt), questions: flag(item.questions), steer: flag(item.steer), attachments: flag(item.attachments), modelSelection: flag(item.modelSelection), sessionSelection: flag(item.sessionSelection), sessionCreation: flag(item.sessionCreation) };
  if (result.questions || result.steer || result.attachments) throw new ProtocolError('unsupported capability');
  return result;
}
function message(value: unknown): Message {
  const item = object(value);
  return { id: label(item.id), role: values(item.role, ['user', 'assistant', 'system']), text: text(item.text, 2_000_000, true), createdAt: integer(item.createdAt), ...(item.streaming === undefined ? {} : { streaming: flag(item.streaming) }) };
}
function tool(value: unknown): ToolActivity {
  const item = object(value);
  return { id: label(item.id), name: label(item.name), label: label(item.label), status: values(item.status, ['running', 'done', 'error', 'interrupted', 'unknown']), detail: text(item.detail, 100_000, true), ...(item.output === undefined ? {} : { output: text(item.output, 2_000_000, true) }) };
}
function agent(value: unknown): AgentSummary {
  const item = object(value);
  return { id: label(item.id), name: label(item.name), task: text(item.task, 100_000, true), status: values(item.status, ['working', 'idle', 'done', 'interrupted']) };
}
export function artifact(value: unknown, sessionId: string): StoredArtifact {
  const item = object(value); const filename = label(item.filename, 255); const mimeType = label(item.mimeType, 128); const sha256 = text(item.sha256, 64);
  if (item.sessionId !== sessionId || filename === '.' || filename === '..' || /[\\/]/.test(filename) || !/^[a-f0-9]{64}$/.test(sha256)) throw new ProtocolError('artifact manifest');
  if (!/^text\/[A-Za-z0-9.+-]+$/.test(mimeType) && !/^application\/(?:json|javascript|typescript|xml|yaml|x-yaml)$/.test(mimeType)) throw new ProtocolError('artifact media type');
  return { id: routeId(item.id), sessionId, title: label(item.title), filename, mimeType, language: label(item.language, 64), sha256, bytes: integer(item.bytes, MAX_STORED_ARTIFACT_BYTES), createdAt: integer(item.createdAt), sourceId: label(item.sourceId) };
}
export function snapshot(value: unknown, sessionId: string): DurableSnapshot {
  const item = object(value); const state = object(item.state); const harness = object(state.harness); const connection = object(state.connection);
  if (item.protocol !== DURABLE_PROTOCOL || harness.id !== 'pi-durable' || harness.transport !== 'durable-http' || state.pendingQuestion !== null) throw new ProtocolError('snapshot');
  const selected = session(state.session);
  if (selected.id !== sessionId) throw new ProtocolError('session snapshot');
  const isWorking = flag(state.isWorking);
  if (isWorking !== (selected.status === 'working')) throw new ProtocolError('session activity');
  // Validate the host's connection envelope, but transport state remains local.
  if (connection.status !== 'live') throw new ProtocolError('connection envelope');
  label(connection.label);
  const result: HarnessUpdate = {
    harness: { id: 'pi-durable', name: label(harness.name), transport: 'durable-http', ...(harness.version === undefined ? {} : { version: label(harness.version, 128) }) },
    capabilities: capabilities(state.capabilities), connection: { status: 'live', label: 'Connected to Pi Durable' }, session: selected,
    ...(state.model === undefined ? {} : { model: model(state.model) }), ...(state.availableModels === undefined ? {} : { availableModels: models(state.availableModels) }),
    messages: unique(rows(state.messages, message), row => row.id), tools: unique(rows(state.tools, tool), row => row.id), pendingQuestion: null,
    agents: unique(rows(state.agents, agent, 1_000), row => row.id), isWorking, readOnly: flag(state.readOnly),
    storedArtifacts: unique(rows(state.storedArtifacts ?? [], row => artifact(row, sessionId), 2_000), row => row.id),
  };
  return { protocol: DURABLE_PROTOCOL, state: result, operations: unique(rows(item.operations, row => operation(row)), row => row.operationId) };
}
