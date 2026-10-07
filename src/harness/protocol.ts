import type { HarnessUpdate } from '../session/types';

/** Perch's own small UI protocol, not pi RPC, TSP, AG-UI, or OMP Collab. */
export const BRIDGE_PROTOCOL = 1;
export const MAX_FRAME_BYTES = 6 * 1024 * 1024;
export const MAX_PROMPT_LENGTH = 100_000;
export type BridgeCommand =
  | { type: 'prompt'; id: string; text: string }
  | { type: 'interrupt'; id: string }
  | { type: 'answer'; id: string; questionId: string; answer: string }
  | { type: 'set-model'; id: string; provider: string; modelId: string };
export type BridgeClientFrame = { type: 'hello'; protocol: 1; token: string } | BridgeCommand;
export type BridgeServerFrame =
  | { type: 'snapshot'; protocol: 1; epoch: string; revision: number; state: HarnessUpdate }
  | { type: 'ack'; id: string }
  | { type: 'error'; id?: string; error: string };

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown, max = MAX_PROMPT_LENGTH): value is string { return typeof value === 'string' && value.length <= max; }
function model(value: unknown): boolean { return record(value) && text(value.id) && (value.name === undefined || text(value.name)) && (value.provider === undefined || text(value.provider)); }
export function parseClientFrame(value: unknown): BridgeClientFrame {
  if (!record(value)) throw new Error('Expected a bridge record.');
  if (value.type === 'hello' && value.protocol === 1 && text(value.token, 4096)) return value as BridgeClientFrame;
  if (!text(value.id, 160) || !value.id) throw new Error('A request ID is required.');
  if (value.type === 'prompt' && text(value.text) && value.text.trim()) return value as BridgeCommand;
  if (value.type === 'interrupt') return value as BridgeCommand;
  if (value.type === 'answer' && text(value.questionId, 256) && text(value.answer)) return value as BridgeCommand;
  if (value.type === 'set-model' && text(value.provider, 256) && text(value.modelId, 512)) return value as BridgeCommand;
  throw new Error('Unsupported or invalid bridge command.');
}

/** Validate the remote boundary before any data reaches native components. */
export function parseServerFrame(value: unknown): BridgeServerFrame {
  if (!record(value)) throw new Error('Expected a bridge record.');
  if (value.type === 'ack' && text(value.id, 160)) return value as BridgeServerFrame;
  if (value.type === 'error' && text(value.error) && (value.id === undefined || text(value.id, 160))) return value as BridgeServerFrame;
  if (value.type !== 'snapshot' || value.protocol !== BRIDGE_PROTOCOL || !text(value.epoch, 160) || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0) throw new Error('Unsupported bridge protocol.');
  const s = value.state;
  if (!record(s) || !record(s.harness) || s.harness.id !== 'pi' || s.harness.transport !== 'pi-rpc' || !text(s.harness.name, 160) || !record(s.capabilities)) throw new Error('Invalid harness metadata.');
  for (const key of ['prompt', 'interrupt', 'questions', 'steer', 'attachments', 'modelSelection', 'sessionSelection']) if (typeof s.capabilities[key] !== 'boolean') throw new Error('Invalid capabilities.');
  if (s.model !== undefined && !model(s.model)) throw new Error('Invalid model metadata.');
  if (s.availableModels !== undefined && (!Array.isArray(s.availableModels) || s.availableModels.length > 10_000 || !s.availableModels.every(model))) throw new Error('Invalid models.');
  if (!record(s.connection) || !['connecting', 'live', 'offline', 'ended', 'error', 'reconnecting'].includes(String(s.connection.status)) || !text(s.connection.label) || (s.connection.error !== undefined && !text(s.connection.error))) throw new Error('Invalid connection state.');
  if (!record(s.session) || !text(s.session.id, 256) || !text(s.session.title) || !text(s.session.project) || !['idle', 'working', 'needs-input'].includes(String(s.session.status))) throw new Error('Invalid session.');
  if (!Array.isArray(s.messages) || s.messages.length > 50_000 || !s.messages.every(m => record(m) && text(m.id, 256) && ['user', 'assistant', 'system'].includes(String(m.role)) && text(m.text, MAX_FRAME_BYTES) && typeof m.createdAt === 'number' && Number.isFinite(m.createdAt) && (m.streaming === undefined || typeof m.streaming === 'boolean'))) throw new Error('Invalid transcript.');
  if (!Array.isArray(s.tools) || s.tools.length > 50_000 || !s.tools.every(t => record(t) && text(t.id, 256) && text(t.name) && text(t.label) && text(t.detail) && ['running', 'done', 'error', 'interrupted', 'unknown'].includes(String(t.status)) && (t.output === undefined || text(t.output, MAX_FRAME_BYTES)) && (t.artifact === undefined || (record(t.artifact) && text(t.artifact.filename) && text(t.artifact.content, MAX_FRAME_BYTES) && (t.artifact.language === undefined || text(t.artifact.language)))))) throw new Error('Invalid tool activity.');
  if (!Array.isArray(s.agents) || !s.agents.every(a => record(a) && text(a.id) && text(a.name) && text(a.task) && ['working', 'idle', 'done', 'interrupted'].includes(String(a.status)))) throw new Error('Invalid agent activity.');
  const q = s.pendingQuestion;
  if (q !== null && (!record(q) || !text(q.id, 256) || !['choice', 'editor'].includes(String(q.kind)) || !text(q.title) || !text(q.prompt) || (q.initialValue !== undefined && !text(q.initialValue)) || (q.answering !== undefined && typeof q.answering !== 'boolean') || (q.kind === 'choice' && (!Array.isArray(q.options) || q.options.length > 1_000 || !q.options.every(o => record(o) && text(o.id) && text(o.label) && (o.description === undefined || text(o.description))))))) throw new Error('Invalid host question.');
  if (typeof s.isWorking !== 'boolean' || typeof s.readOnly !== 'boolean') throw new Error('Invalid session flags.');
  return value as BridgeServerFrame;
}
