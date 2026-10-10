import React, { useMemo, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ChevronDown, ChevronRight, Link2, RefreshCw, Server, Unplug } from 'lucide-react-native';
import type { SessionSnapshot } from '../session';
import type { Theme } from './theme';
import { questionProgress } from './QuestionContent';

const activity = (status: string) => ({ idle: 'Ready', working: 'Working', 'needs-input': 'Needs input', exited: 'Ended' }[status] ?? status);

/** Browse metadata first; attaching never starts another harness process. */
export function RemoteSessionBrowser({ state, theme: t, onAttach, onRefresh }: {
  state: SessionSnapshot; theme: Theme; onAttach: (id: string) => void; onRefresh: () => void;
}) {
  const s = useMemo(() => styles(t), [t]);
  const available = state.remote?.sessions ?? [];
  const ready = state.connection.status === 'live' && !state.sessionAction;
  return <ScrollView testID="remote-session-browser" style={s.flex} contentContainerStyle={s.page} keyboardShouldPersistTaps="handled">
    <View style={s.hostIcon}><Server size={26} color={t.primary} /></View>
    <Text style={s.eyebrow}>{state.remote?.host?.name ?? 'YOUR HOST'}</Text>
    <Text accessibilityRole="header" style={s.title}>Continue a host session</Text>
    <Text style={s.body}>Choose a running session to see its conversation and follow its work. It keeps running when you leave.</Text>
    <View style={[s.between, { marginTop: 22, marginBottom: 10 }]}>
      <Text style={s.sectionTitle}>Host sessions{available.length ? ` · ${available.length}` : ''}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="Refresh host sessions" onPress={onRefresh} disabled={!!state.sessionAction || state.connection.status === 'connecting' || state.connection.status === 'reconnecting'} style={s.action}><RefreshCw size={15} color={t.primary} /><Text style={s.actionText}>Refresh</Text></Pressable>
    </View>
    {available.length === 0 && <View style={s.empty}>
      <Text style={s.sectionTitle}>{ready ? 'No sessions available yet' : 'Reading your host…'}</Text>
      <Text style={s.body}>{ready ? 'Start OMP with the Perch extension, or open a supported Tern pane on this host. Refresh here when it is ready.' : 'The catalog appears after your workspace is authenticated.'}</Text>
    </View>}
    <View style={{ gap: 12 }}>{available.map(session => {
      const disabled = !ready || session.status === 'exited';
      return <Pressable key={session.id} testID={`attach-session-${session.id}`} accessibilityRole="button" accessibilityLabel={`Attach to ${session.title}`} accessibilityState={{ disabled }} disabled={disabled} onPress={() => onAttach(session.id)} style={({ pressed }) => [s.card, { backgroundColor: pressed ? t.primarySoft : t.surface, opacity: session.status === 'exited' ? .6 : 1 }]}>
        <View style={s.between}><Text style={s.sectionTitle} numberOfLines={2}>{session.title}</Text><Text style={[s.status, { color: session.status === 'needs-input' ? t.amber : session.status === 'working' ? t.activity : session.status === 'exited' ? t.muted : t.success }]}>{activity(session.status)}</Text></View>
        <Text style={s.small} numberOfLines={2}>{session.location?.host ? `${session.location.host} · ` : ''}{session.project || 'Host workspace'}</Text>
        <View style={s.between}>
          <Text style={[s.small, s.flex]} numberOfLines={1}>{session.harness === 'tern' ? 'Tern pane' : 'OMP'}{session.pid ? ` · PID ${session.pid}` : ''}{session.model ? ` · ${session.model.name || session.model.id}` : ''}</Text>
          <View style={s.action}><Link2 size={15} color={t.primary} /><Text style={s.actionText}>{session.status === 'exited' ? 'Ended' : 'Attach'}</Text><ChevronRight size={15} color={t.primary} /></View>
        </View>
      </Pressable>;
    })}</View>
    <Text style={[s.small, { marginTop: 20 }]}>For Tern, add remote hosts in Tern and keep that window connected. Its Perch bridge shares supported panes, including panes on those hosts. Perch does not add SSH hosts itself.</Text>
    <Text style={[s.small, { marginTop: 20 }]}>Session control and artifact reading are native. Pane and terminal views are still being developed.</Text>
  </ScrollView>;
}

/** Keep identity, read-only access and bounded history visible beside the chat. */
export function RemoteSessionAttachment({ state, theme: t, onDetach }: {
  state: SessionSnapshot; theme: Theme; onDetach: () => void;
}) {
  const s = useMemo(() => styles(t), [t]); const [expanded, setExpanded] = useState(false);
  const attached = state.remote?.attached;
  if (!attached) return null;
  const notices = state.remote?.notices ?? [];
  const question = state.pendingQuestion;
  const inputNotice = !question || !state.capabilities.questions
    ? 'This dialog is not available for phone answers. Continue on the host.'
    : question.answerState === 'unknown' ? 'Answer outcome is unconfirmed. Check the host before making another decision.'
    : questionProgress(question) || (state.readOnly ? 'This session is view only. Answer the request on the host.'
      : question.disabledReason || (state.connection.status !== 'live' ? 'Reconnect to answer this request.' : 'This request can be answered here. Open the request above.'));
  return <View testID="remote-attachment" style={s.attachment}>
    <View style={s.between}>
      <Pressable accessibilityRole="button" accessibilityLabel="Session connection details" accessibilityState={{ expanded }} onPress={() => setExpanded(!expanded)} style={[s.action, s.flex]}>
        <View style={[s.dot, { backgroundColor: state.connection.status === 'live' ? t.success : t.amber }]} />
        <View style={s.flex}><Text style={s.small} numberOfLines={1}>{attached.location?.host ?? state.remote?.host?.name ?? 'Host'}{attached.pid ? ` · PID ${attached.pid}` : ''}</Text><Text style={s.small}>{state.readOnly ? 'View only' : activity(attached.status)} · periodic snapshots</Text></View><ChevronDown size={14} color={t.muted} />
      </Pressable>
      <Pressable testID="detach-session" accessibilityRole="button" accessibilityLabel="Detach from host session" onPress={onDetach} style={s.action}><Unplug size={15} color={t.primary} /><Text style={s.actionText}>Detach</Text></Pressable>
    </View>
    {state.remote?.truncated && <Text accessibilityRole="alert" style={s.small}>This view contains part of the host history. Open the host for the full transcript.</Text>}
    {attached.status === 'needs-input' && <Text accessibilityRole="alert" style={[s.small, { color: t.amber }]}>{inputNotice}</Text>}
    {expanded && <View style={{ gap: 8, paddingBottom: 9 }}>
      <Text selectable style={s.small}>{attached.project}</Text>
      <Text selectable style={s.small}>Runtime: {attached.runtimeId}{'\n'}Generation: {attached.generation}</Text>
      {!!attached.location && <Text style={s.small}>{[attached.location.host, attached.location.workspace, attached.location.tab, attached.location.pane].filter(Boolean).join(' · ')}</Text>}
      {attached.location?.host && <Text style={s.small}>Bridge: {state.remote?.host?.name ?? 'Host'}</Text>}
      {notices.map((notice, index) => <Text key={`${index}:${notice}`} style={s.small}>{notice}</Text>)}
      <Text style={s.small}>Detach leaves the host running. Stop in the composer interrupts its current response.</Text>
    </View>}
  </View>;
}

function styles(t: Theme) { return StyleSheet.create({
  flex: { flex: 1, minWidth: 0 }, page: { padding: 24, paddingBottom: 40, width: '100%', maxWidth: 760, alignSelf: 'center' },
  hostIcon: { width: 52, height: 52, borderRadius: 12, borderWidth: 1, borderColor: t.line, backgroundColor: t.surface, alignItems: 'center', justifyContent: 'center', marginBottom: 20 },
  eyebrow: { fontSize: 11, fontWeight: '500', fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', letterSpacing: .6, color: t.muted, marginBottom: 10 },
  title: { fontSize: 28, lineHeight: 35, fontWeight: '600', color: t.ink, letterSpacing: -.7, marginBottom: 12 },
  body: { fontSize: 14, lineHeight: 22, color: t.muted }, small: { fontSize: 11, lineHeight: 17, color: t.muted },
  sectionTitle: { fontSize: 14, fontWeight: '600', lineHeight: 21, color: t.ink, flexShrink: 1 },
  between: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  action: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44 }, actionText: { fontSize: 12, fontWeight: '600', color: t.primary },
  status: { fontSize: 11, fontWeight: '500', flexShrink: 0 }, card: { borderWidth: 1, borderColor: t.line, borderRadius: 12, padding: 16, gap: 7 },
  empty: { padding: 20, gap: 10, borderRadius: 12, backgroundColor: t.surfaceAlt },
  attachment: { backgroundColor: t.chrome, paddingHorizontal: 18, paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: t.line, gap: 4 },
  dot: { width: 6, height: 6, borderRadius: 3 },
}); }
