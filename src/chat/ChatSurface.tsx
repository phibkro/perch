import React, { createContext, useContext, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, Text, View } from 'react-native';
import {
  AssistantRuntimeProvider, ComposerPrimitive, MessagePrimitive,
  useAuiState, useExternalStoreRuntime, type TextMessagePartComponent,
  type ToolCallMessagePartComponent,
} from '@assistant-ui/react-native';
import { ArrowUpRight, CheckCheck, ChevronDown, ChevronUp, Copy, Feather, FileText, Link2, Sparkles, Terminal } from 'lucide-react-native';
import * as Clipboard from 'expo-clipboard';
import { sessionStore, type SessionSnapshot } from '../session';
import { ArtifactCard, type Artifact } from '../artifacts';
import type { Theme } from '../ui/theme';
import { Thread } from './registry/components/assistant-ui/elements/thread.aui';
import { MarkdownText } from './registry/components/assistant-ui/elements/markdown-text';
import { canSubmit, passThroughMessage, projectThread } from './projection';

type Props = {
  state: SessionSnapshot; theme: Theme; draft: string; onDraftChange: (text: string) => void;
  submittedCopy: string; onKeepSubmitted: (text: string) => void; onRestoreSubmitted: () => void;
  artifacts: readonly Artifact[]; onOpenArtifact: (artifact: Artifact) => void;
  onOpenMessage: (messageId: string) => void; notify: (message: string) => void;
  onOpenArtifactExample: () => void; onTryDemo: () => void; onConnect: () => void; onNewChat: () => void;
};
const ChatContext = createContext<Props | null>(null);
function useChat() { const value = useContext(ChatContext); if (!value) throw new Error('Chat context is missing'); return value; }
const metadataFont = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

/** Native registry thread, with our authoritative external-store adapter. */
export function ChatSurface(props: Props) {
  const { state, draft, onDraftChange } = props;
  const latest = useRef(props); latest.current = props;
  const messages = useMemo(() => projectThread(state), [state.messages, state.tools]);
  const writable = !state.readOnly && !state.sessionAction && (state.connection.status === 'demo' || state.connection.status === 'live');
  const runtime = useExternalStoreRuntime({
    messages, convertMessage: passThroughMessage,
    isRunning: state.isWorking,
    isLoading: state.connection.status === 'connecting' && messages.length === 0,
    isDisabled: state.readOnly || !!state.sessionAction,
    isSendDisabled: !canSubmit(state),
    // No client-side tool dispatcher: all tools remain on the chosen host.
    unstable_enableToolInvocations: false,
    onNew: async message => {
      const text = message.content.filter(part => part.type === 'text').map(part => part.text).join('\n').trim();
      if (!text) return;
      const current = sessionStore.getSnapshot();
      if (!canSubmit(current)) {
        latest.current.onDraftChange(text);
        latest.current.notify('Your message is still a draft. Wait for the session to be ready.');
        return;
      }
      if (current.mode !== 'demo') latest.current.onKeepSubmitted(text);
      try { sessionStore.sendPrompt(text); }
      catch (error) {
        latest.current.onDraftChange(text);
        latest.current.notify(error instanceof Error ? error.message : 'Could not send. Your draft is kept.');
      }
    },
    ...(writable && state.capabilities.interrupt ? { onCancel: async () => { sessionStore.interrupt(); } } : {}),
  });

  // Subscribe before the first keystroke: a passive initial effect can overwrite
  // a fast first input with the initially empty app draft.
  // ComposerPrimitive owns the live input; the app owns per-session draft memory.
  useLayoutEffect(() => {
    runtime.thread.composer.setText(latest.current.draft);
    return runtime.thread.composer.subscribe(() => {
      const text = runtime.thread.composer.getState().text;
      if (text !== latest.current.draft) latest.current.onDraftChange(text);
    });
  }, [runtime]);
  useLayoutEffect(() => {
    if (runtime.thread.composer.getState().text !== draft) runtime.thread.composer.setText(draft);
  }, [draft, runtime]);

  return <ChatContext.Provider value={props}>
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread components={THREAD_COMPONENTS} />
    </AssistantRuntimeProvider>
  </ChatContext.Provider>;
}

const NativeComposerInput = () => {
  const { state, theme: t, draft, submittedCopy, onRestoreSubmitted } = useChat();
  const offline = state.connection.status !== 'demo' && state.connection.status !== 'live';
  return <View>
    {submittedCopy && !draft.trim() && <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, gap: 8 }}>
      <Text style={{ color: t.muted, fontSize: 11, flex: 1 }}>Last submitted text is kept on this device.</Text>
      <Pressable accessibilityRole="button" onPress={onRestoreSubmitted} style={{ minHeight: 44, justifyContent: 'center' }}><Text style={{ color: t.primary, fontWeight: '600', fontSize: 12 }}>Restore text</Text></Pressable>
    </View>}
    <ComposerPrimitive.Input testID="composer" accessibilityLabel="Message to assistant" multiline submitMode="none"
      editable={!state.readOnly && !state.sessionAction} maxLength={12000}
      placeholder={state.sessionAction ? 'Opening your chat…' : state.readOnly ? 'View-only session' : !state.capabilities.prompt ? state.mode === 'remote' ? 'Waiting for host prompt control…' : 'Start a new chat to send…' : state.pendingQuestion ? 'Answer the question to continue…' : offline ? 'Write a draft while offline…' : 'Message Perch…'}
      placeholderTextColor={t.subtle}
      selectionColor={t.primary}
      style={{ color: t.ink, minHeight: 48, maxHeight: 160, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 8, fontSize: 16, lineHeight: 24 }} />
    <Text style={{ color: t.subtle, fontFamily: metadataFont, fontSize: 11, lineHeight: 17, paddingHorizontal: 12, paddingTop: 2 }}>{state.mode === 'demo' ? 'Demo · no model calls' : state.readOnly ? 'View only' : `${state.harness.name} · tools run on your host`}</Text>
  </View>;
};

const PerchText: TextMessagePartComponent = props => <MarkdownText {...props} />;

const PerchAssistantMessage = () => {
  const { state, theme: t, artifacts, onOpenArtifact, onOpenMessage, notify } = useChat();
  const message = useAuiState(s => s.message);
  const source = state.messages.find(item => item.id === message.id);
  const activity = message.metadata.custom?.activity === true;
  const isSystem = message.role === 'system';
  const attached = artifacts.filter(artifact => artifact.sourceId === `message:${message.id}`);
  return <MessagePrimitive.Root style={{ gap: 8 }}>
    {!activity && <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
      {!isSystem && <Feather size={15} color={t.primary} />}
      <Text style={{ color: t.muted, fontFamily: metadataFont, fontWeight: '500', fontSize: 11, letterSpacing: .4 }}>{isSystem ? 'SESSION UPDATE' : 'ASSISTANT'}</Text>
      {message.role === 'assistant' && message.status?.type === 'running' && <Text style={{ color: t.activity, fontSize: 11 }}>writing</Text>}
    </View>}
    <MessagePrimitive.Parts components={{ Text: PerchText, tools: { Fallback: PerchTool } }} />
    {attached.length > 0 && <View style={{ gap: 8 }}>{attached.map(artifact => <ArtifactCard key={artifact.id} artifact={artifact} onPress={() => onOpenArtifact(artifact)} theme={t} />)}</View>}
    {source && source.role === 'assistant' && !!source.text && <View style={{ flexDirection: 'row', gap: 18 }}>
      <Pressable accessibilityRole="button" onPress={() => onOpenMessage(source.id)} style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 5 }}>
        <FileText size={14} color={t.primary} /><Text style={{ color: t.primary, fontSize: 12, fontWeight: '600' }}>Open as document</Text><ArrowUpRight size={13} color={t.primary} />
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="Copy assistant message" onPress={() => { void Clipboard.setStringAsync(source.text).then(() => notify('Message copied.')).catch(() => notify('Could not copy this message.')); }} style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}><Copy size={14} color={t.muted} /></Pressable>
    </View>}
  </MessagePrimitive.Root>;
};

const TOOL_STATUS: Record<string, string> = { running: 'Working', done: 'Complete', error: 'Needs attention', interrupted: 'Interrupted', unknown: 'No result recorded' };
const PerchTool: ToolCallMessagePartComponent = ({ toolCallId, toolName }) => {
  const { state, theme: t, artifacts, onOpenArtifact } = useChat();
  const tool = state.tools.find(item => item.id === toolCallId);
  const [expanded, setExpanded] = useState(false);
  const status = tool?.status ?? 'unknown';
  const statusInk = status === 'done' ? t.success : status === 'running' ? t.activity : status === 'error' ? t.error : status === 'interrupted' ? t.amber : t.muted;
  const statusFill = status === 'done' ? t.successSoft : status === 'running' ? t.activitySoft : status === 'error' ? t.errorSoft : status === 'interrupted' ? t.amberSoft : t.surfaceAlt;
  return <View style={{ borderWidth: 1, borderColor: t.line, borderLeftWidth: 3, borderLeftColor: statusInk, borderRadius: 12, backgroundColor: t.surface, overflow: 'hidden' }}>
    <Pressable accessibilityRole="button" accessibilityLabel={`${expanded ? 'Collapse' : 'Expand'} ${tool?.label ?? toolName}`} accessibilityState={{ expanded }} onPress={() => setExpanded(!expanded)} style={{ minHeight: 60, flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12 }}>
      {status === 'done' ? <CheckCheck size={18} color={statusInk} /> : <Terminal size={18} color={statusInk} />}
      <View style={{ flex: 1, minWidth: 0, gap: 5 }}><Text style={{ color: t.ink, fontFamily: metadataFont, fontWeight: '500', fontSize: 12, lineHeight: 19 }}>{tool?.label ?? toolName}</Text><View style={{ alignSelf: 'flex-start', backgroundColor: statusFill, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2 }}><Text style={{ color: statusInk, fontSize: 11, lineHeight: 16 }}>{TOOL_STATUS[status]}</Text></View></View>
      {expanded ? <ChevronUp size={17} color={t.muted} /> : <ChevronDown size={17} color={t.muted} />}
    </Pressable>
    {expanded && <View style={{ borderTopWidth: 1, borderTopColor: t.line, padding: 12, gap: 12 }}>
      <Text selectable style={{ color: t.muted, fontSize: 13, lineHeight: 21 }}>{tool?.detail ?? 'Activity reported by the host.'}</Text>
      {!!tool?.output && <ScrollView horizontal><Text selectable style={{ color: t.codeInk, backgroundColor: t.code, borderRadius: 8, padding: 14, fontSize: 12, lineHeight: 20, fontFamily: metadataFont }}>{tool.output}</Text></ScrollView>}
      {artifacts.filter(artifact => artifact.sourceId === `tool:${toolCallId}`).map(artifact => <ArtifactCard key={artifact.id} artifact={artifact} theme={t} onPress={() => onOpenArtifact(artifact)} />)}
    </View>}
  </View>;
};

const Welcome = () => {
  const { theme: t, state, onOpenArtifactExample, onTryDemo, onConnect, onNewChat } = useChat();
  const needsSession = state.mode !== 'demo' && state.capabilities.sessionCreation && state.sessions.length === 0 && state.connection.status === 'live';
  const actions = [
    { label: 'Preview artifacts', icon: FileText, onPress: onOpenArtifactExample },
    { label: 'Try an agent', icon: Sparkles, onPress: onTryDemo },
    { label: 'Connect a workspace', icon: Link2, onPress: onConnect },
  ];
  return <View testID="new-chat-welcome" style={{ alignItems: 'center', paddingHorizontal: 24, paddingVertical: 36, gap: 15 }}>
    <View style={{ width: 52, height: 52, borderRadius: 12, borderWidth: 1, borderColor: t.line, backgroundColor: t.surface, alignItems: 'center', justifyContent: 'center', marginBottom: 5 }}><Feather size={27} color={t.primary} /></View>
    <Text accessibilityRole="header" style={{ color: t.ink, fontSize: 28, lineHeight: 36, fontWeight: '600', letterSpacing: -.7, textAlign: 'center' }}>{state.readOnly ? 'Your shared conversation' : 'What would you like to do?'}</Text>
    <Text style={{ color: t.muted, textAlign: 'center', lineHeight: 21, fontSize: 14, maxWidth: 340 }}>{state.mode === 'demo' ? 'A fresh space for your next idea.' : needsSession ? 'Your workspace is connected. Start your first chat.' : state.readOnly ? 'Messages appear here as your host works.' : 'Your assistant is ready when you are.'}</Text>
    {needsSession && <Pressable accessibilityRole="button" onPress={onNewChat} disabled={!!state.sessionAction} style={{ minHeight: 48, justifyContent: 'center', borderRadius: 8, paddingHorizontal: 20, backgroundColor: t.primarySoft }}><Text style={{ color: t.primary, fontSize: 14, fontWeight: '600' }}>{state.sessionAction ? 'Creating chat…' : 'New chat'}</Text></Pressable>}
    {state.mode === 'demo' && <View style={{ flexDirection: 'row', justifyContent: 'center', flexWrap: 'wrap', gap: 9, maxWidth: 520, marginTop: 9 }}>
      {actions.map(({ label, icon: Icon, onPress }) => <Pressable key={label} accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={({ pressed }) => ({ minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 11, borderRadius: 8, borderWidth: 1, borderColor: t.line, backgroundColor: pressed ? t.primarySoft : t.surface })}><Icon size={16} color={t.primary} /><Text style={{ fontSize: 13, fontWeight: '500', color: t.ink }}>{label}</Text></Pressable>)}
    </View>}
  </View>;
};
const THREAD_COMPONENTS = { AssistantMessage: PerchAssistantMessage, ComposerInput: NativeComposerInput, ToolFallback: PerchTool, Welcome };
