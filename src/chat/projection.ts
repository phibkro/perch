import type { ThreadMessageLike } from '@assistant-ui/react-native';
import type { SessionSnapshot } from '../session';

/** The host store owns history. This projection adds presentation, never local tool execution. */
export function projectThread(state: SessionSnapshot): ThreadMessageLike[] {
  const messages: ThreadMessageLike[] = state.messages.map(message => ({
    id: message.id,
    role: message.role,
    content: [{ type: 'text', text: message.text }],
    createdAt: new Date(message.createdAt || 0),
    ...(message.role === 'assistant' ? { status: message.streaming
      ? { type: 'running' as const }
      : { type: 'complete' as const, reason: 'stop' as const } } : {}),
    metadata: { custom: { sourceId: message.id } },
  }));
  // Some harnesses publish tool activity independently of chat messages. Keep
  // their stable host IDs and render through assistant-ui's tool-call boundary.
  for (const tool of state.tools) messages.push({
    id: `activity:${tool.id}`,
    role: 'assistant',
    content: [{
      type: 'tool-call', toolCallId: tool.id, toolName: tool.name,
      args: { activityId: tool.id },
      ...(tool.status === 'done' || tool.status === 'error'
        ? { result: tool.output ?? tool.detail, isError: tool.status === 'error' }
        : {}),
    }],
    status: tool.status === 'running' ? { type: 'running' }
      : tool.status === 'interrupted' ? { type: 'incomplete', reason: 'cancelled' }
      : tool.status === 'unknown' ? { type: 'incomplete', reason: 'other' }
      : { type: 'complete', reason: 'stop' },
    metadata: { custom: { activity: true } },
  });
  return messages;
}

export const passThroughMessage = (message: ThreadMessageLike) => message;

export function canSubmit(state: SessionSnapshot): boolean {
  const active = state.sessions.find(session => session.id === state.activeSessionId);
  return !state.readOnly && !state.sessionAction && state.capabilities.prompt &&
    (state.connection.status === 'demo' || state.connection.status === 'live') &&
    !state.pendingQuestion && !state.isWorking && active?.status === 'idle';
}
