import type { HarnessUpdate, Message, ModelMetadata, PendingQuestion, ToolActivity } from '../../src/session/types';
import { PI_CAPABILITIES, PI_HARNESS } from '../../src/harness/capabilities';
import { record } from '../../src/harness/protocol';
import { writeArtifact } from '../../src/harness/tool-artifact';

type Raw = Record<string, unknown>;
function textContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap(block => record(block) && block.type === 'text' && typeof block.text === 'string' ? [block.text] : record(block) && block.type === 'image' ? ['[Image attachment — image display is not enabled for this connector.]'] : []).join('\n');
}
function model(value: unknown): ModelMetadata | undefined {
  if (!record(value) || typeof value.id !== 'string') return undefined;
  return { id: value.id, name: typeof value.name === 'string' ? value.name : undefined, provider: typeof value.provider === 'string' ? value.provider : undefined };
}

/** Server-owned projection. A reconnect loads this state rather than replaying RPC. */
export class PiProjector {
  private sessionId = 'pi';
  private title = 'pi session';
  private messages: Message[] = [];
  private tools = new Map<string, ToolActivity>();
  private rawMessages: Raw[] = [];
  private activeIndex: number | undefined;
  private blocks = new Map<number, string>();
  private working = false;
  private metadata: ModelMetadata | undefined;
  private models: ModelMetadata[] = [];
  private question: PendingQuestion | null = null;
  private request: Raw | null = null;
  private noticeId = 0;
  private connection: HarnessUpdate['connection'] = { status: 'connecting', label: 'Starting pi RPC' };

  constructor(private project: string, private version?: string) {}

  snapshot(): HarnessUpdate {
    return {
      harness: { ...PI_HARNESS, version: this.version }, capabilities: PI_CAPABILITIES,
      model: this.metadata, availableModels: this.models,
      connection: this.connection,
      session: { id: this.sessionId, title: this.title, project: this.project, status: this.question ? 'needs-input' : this.working ? 'working' : 'idle' },
      messages: this.messages.filter(m => m.text.length > 0), tools: [...this.tools.values()], pendingQuestion: this.question,
      agents: [], isWorking: this.working, readOnly: this.connection.status !== 'live',
    };
  }

  setConnection(status: HarnessUpdate['connection']['status'], label: string, error?: string) { this.connection = { status, label, error }; }
  setState(value: unknown, updateLifecycle = true) {
    if (!record(value)) throw new Error('pi returned an invalid state.');
    if (typeof value.sessionId === 'string') this.sessionId = value.sessionId;
    if (typeof value.sessionName === 'string') this.title = value.sessionName;
    this.metadata = model(value.model);
    if (updateLifecycle) this.working = value.isStreaming === true || value.isCompacting === true || Number(value.pendingMessageCount) > 0;
  }
  setModels(value: unknown) {
    this.models = record(value) && Array.isArray(value.models) ? value.models.map(model).filter((m): m is ModelMetadata => !!m) : [];
  }
  hydrate(value: unknown) {
    if (!record(value) || !Array.isArray(value.messages)) throw new Error('pi returned an invalid history.');
    this.rawMessages = []; this.messages = []; this.tools.clear(); this.activeIndex = undefined;
    for (const raw of value.messages) if (record(raw)) this.upsert(raw, false);
  }
  notice(text: string) { this.messages.push({ id: `${this.sessionId}:notice:${++this.noticeId}`, role: 'system', text, createdAt: Date.now() }); }

  private upsert(raw: Raw, streaming: boolean, index?: number) {
    const position = index ?? this.rawMessages.length;
    this.rawMessages[position] = raw;
    const role = raw.role;
    const timestamp = typeof raw.timestamp === 'number' ? raw.timestamp : 0;
    const id = `${this.sessionId}:message:${position}`;
    if (role === 'user' || role === 'assistant' || role === 'custom' || role === 'customMessage') {
      const value: Message = { id, role: role === 'user' ? 'user' : role === 'assistant' ? 'assistant' : 'system', text: textContent(raw.content), createdAt: timestamp, streaming };
      if (role === 'assistant' && typeof raw.errorMessage === 'string') value.text += `\n\n${raw.stopReason === 'aborted' ? 'Interrupted' : 'Model error'}: ${raw.errorMessage}`;
      const existing = this.messages.findIndex(m => m.id === id);
      if (existing >= 0) this.messages[existing] = value; else this.messages.push(value);
    }
    if (role === 'assistant' && Array.isArray(raw.content)) for (const block of raw.content) {
      if (record(block) && block.type === 'toolCall' && typeof block.id === 'string' && typeof block.name === 'string') {
        const existing = this.tools.get(block.id);
        this.tools.set(block.id, { id: block.id, name: block.name, label: block.name, status: 'unknown', detail: 'No result recorded yet', ...existing, artifact: writeArtifact(block.name, block.arguments) });
      }
    }
    if (role === 'toolResult' && typeof raw.toolCallId === 'string') {
      const name = typeof raw.toolName === 'string' ? raw.toolName : 'Tool';
      this.tools.set(raw.toolCallId, { ...this.tools.get(raw.toolCallId), id: raw.toolCallId, name, label: name, status: raw.isError ? 'error' : 'done', detail: raw.isError ? 'Tool reported an error' : 'Tool completed', output: textContent(raw.content) });
    }
    return position;
  }

  event(event: Raw): void {
    const type = event.type;
    if (type === 'agent_start' || type === 'auto_retry_start' || type === 'compaction_start') this.working = true;
    if (type === 'agent_settled') {
      this.working = false; this.activeIndex = undefined;
      this.clearQuestion();
      this.messages = this.messages.map(m => m.streaming ? { ...m, streaming: false } : m);
      for (const [id, tool] of this.tools) if (tool.status === 'running') this.tools.set(id, { ...tool, status: 'unknown', detail: 'Run ended without a recorded tool result' });
    }
    if (type === 'message_start' && record(event.message)) {
      this.activeIndex = this.upsert(event.message, event.message.role === 'assistant'); this.blocks.clear();
      if (Array.isArray(event.message.content)) event.message.content.forEach((block, index) => { if (record(block) && block.type === 'text' && typeof block.text === 'string') this.blocks.set(index, block.text); });
    }
    if (type === 'message_update' && record(event.assistantMessageEvent) && this.activeIndex !== undefined) {
      const update = event.assistantMessageEvent;
      const index = Number(update.contentIndex);
      if (Number.isSafeInteger(index) && index >= 0) {
        if (update.type === 'text_delta' && typeof update.delta === 'string') this.blocks.set(index, (this.blocks.get(index) ?? '') + update.delta);
        if (update.type === 'text_end' && typeof update.content === 'string') this.blocks.set(index, update.content);
        const original = this.rawMessages[this.activeIndex];
        this.upsert({ ...original, content: [...this.blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, text]) => ({ type: 'text', text })) }, true, this.activeIndex);
      }
    }
    if (type === 'message_end' && record(event.message)) {
      const raw = event.message;
      const index = this.activeIndex !== undefined && this.rawMessages[this.activeIndex]?.role === raw.role ? this.activeIndex : undefined;
      this.upsert(raw, false, index); this.activeIndex = undefined;
    }
    if (typeof event.toolCallId === 'string' && typeof event.toolName === 'string') {
      const id = event.toolCallId;
      const previous = this.tools.get(id);
      if (type === 'tool_execution_start') this.tools.set(id, { id, name: event.toolName, label: event.toolName, status: 'running', detail: 'Running on your host', artifact: writeArtifact(event.toolName, event.args) });
      if (type === 'tool_execution_update') this.tools.set(id, { ...previous, id, name: event.toolName, label: event.toolName, status: 'running', detail: 'Running on your host', output: record(event.partialResult) ? textContent(event.partialResult.content) : undefined });
      if (type === 'tool_execution_end') this.tools.set(id, { ...previous, id, name: event.toolName, label: event.toolName, status: event.isError ? 'error' : 'done', detail: event.isError ? 'Tool reported an error' : 'Tool completed', output: record(event.result) ? textContent(event.result.content) : undefined });
    }
    if (type === 'session_info_changed' && typeof event.name === 'string') this.title = event.name;
    if (type === 'extension_error' && typeof event.error === 'string') this.notice(`Extension error: ${event.error}`);
    if (type === 'auto_retry_end' && event.success === false && typeof event.finalError === 'string') this.notice(`Model request failed: ${event.finalError}`);
    if (type === 'extension_ui_request') this.uiRequest(event);
  }

  private uiRequest(request: Raw) {
    if (request.method === 'notify' && typeof request.message === 'string') { this.notice(request.message); return; }
    if (!['select', 'confirm', 'input', 'editor'].includes(String(request.method)) || typeof request.id !== 'string') return;
    const id = `${this.sessionId}:question:${request.id}`;
    const title = typeof request.title === 'string' ? request.title : 'Host question';
    const prompt = typeof request.message === 'string' ? request.message : typeof request.placeholder === 'string' ? request.placeholder : 'Your server is waiting for a response.';
    this.request = request;
    if (request.method === 'select' && Array.isArray(request.options) && request.options.every(o => typeof o === 'string')) {
      this.question = { id, title, prompt, kind: 'choice', options: request.options.map((label, index) => ({ id: String(index), label })) };
    } else if (request.method === 'confirm') {
      this.question = { id, title, prompt, kind: 'choice', options: [{ id: 'yes', label: 'Confirm' }, { id: 'no', label: 'Cancel' }] };
    } else if (request.method === 'input' || request.method === 'editor') {
      this.question = { id, title, prompt, kind: 'editor', initialValue: typeof request.prefill === 'string' ? request.prefill : '' };
    } else { this.question = null; this.request = null; this.notice('The host sent an unsupported question.'); }
  }

  response(questionId: string, answer: string): Raw {
    if (!this.question || !this.request || this.question.id !== questionId || this.question.answering) throw new Error('That question is no longer pending.');
    const response: Raw = { type: 'extension_ui_response', id: this.request.id };
    if (this.request.method === 'confirm') {
      if (answer !== 'yes' && answer !== 'no') throw new Error('Invalid confirmation.');
      response.confirmed = answer === 'yes';
    } else if (this.question.kind === 'choice') {
      const option = this.question.options?.find(o => o.id === answer);
      if (!option) throw new Error('Invalid choice.');
      response.value = option.label;
    } else response.value = answer;
    this.question = { ...this.question, answering: true };
    return response;
  }
  cancelQuestion(): Raw | undefined { return this.request ? { type: 'extension_ui_response', id: this.request.id, cancelled: true } : undefined; }
  clearQuestion(questionId?: string) { if (!questionId || this.question?.id === questionId) { this.question = null; this.request = null; } }
  resetAnswering(questionId: string) { if (this.question?.id === questionId) this.question = { ...this.question, answering: false }; }
}
