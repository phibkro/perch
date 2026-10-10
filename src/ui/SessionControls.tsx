import React, { useEffect, useMemo, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Check, ChevronDown, ChevronUp, ExternalLink, Wrench } from 'lucide-react-native';
import { sessionStore, type SessionSnapshot } from '../session';
import { NativeAction } from './NativeAction';
import type { Theme } from './theme';

const count = (value: number) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
const readableLevel = (level: string) => level ? level[0].toLocaleUpperCase() + level.slice(1) : level;

/** Host metadata stays authoritative: changes appear after a fresh snapshot. */
export function SessionControls({ state, theme: t }: { state: SessionSnapshot; theme: Theme }) {
  const scope = JSON.stringify([state.connectionEpoch, state.remote?.epoch, state.activeSessionId, state.remote?.attached?.generation]);
  return <ScopedSessionControls key={scope} state={state} theme={t} />;
}

/** Remount local drafts when the host/session incarnation changes. */
function ScopedSessionControls({ state, theme: t }: { state: SessionSnapshot; theme: Theme }) {
  const s = useMemo(() => styles(t), [t]);
  const currentTitle = state.sessions.find(session => session.id === state.activeSessionId)?.title
    ?? state.remote?.attached?.title ?? state.displayName;
  const [title, setTitle] = useState(currentTitle);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [toolsOpen, setToolsOpen] = useState(false);
  const insights = state.insights;
  const thinking = insights?.thinking;
  const context = insights?.context;
  const usage = insights?.usage;
  const tools = insights?.tools;
  const reason = state.readOnly ? 'This session is view only.'
    : state.connection.status !== 'live' ? 'Reconnect to change this session.'
    : state.sessionAction ? 'Wait for the session to finish opening.'
    : state.pendingQuestion ? 'Answer the current request before changing chat settings.'
    : state.isWorking ? 'Chat settings are available when the assistant is idle.' : undefined;
  const disabled = !!reason;
  const focusDisabled = state.readOnly || state.connection.status !== 'live' || !!state.sessionAction;
  const hasActions = !!(state.capabilities.thinkingSelection || state.capabilities.sessionRename || state.capabilities.focusSession);

  useEffect(() => { setTitle(currentTitle); }, [currentTitle]);

  function request(action: () => void, message: string, blocked = disabled) {
    if (blocked) return;
    setNotice(''); setError('');
    try { action(); setNotice(message); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'The host could not accept this change.'); }
  }

  const percent = context && Number.isFinite(context.percent) ? Math.max(0, Math.min(100, context.percent)) : undefined;
  const contextColor = percent !== undefined && percent >= 90 ? t.amber : t.primary;
  const changedTitle = title.trim().length > 0 && title.trim() !== currentTitle;

  return <ScrollView testID="session-controls" style={s.flex} contentContainerStyle={s.page} keyboardShouldPersistTaps="handled">
    <View style={s.identity}>
      <Text style={s.eyebrow}>{state.harness.name}</Text>
      <Text selectable style={s.sessionTitle}>{currentTitle}</Text>
      {!!state.model && <Text selectable style={s.metadata}>{[state.model.provider, state.model.name || state.model.id].filter(Boolean).join(' · ')}</Text>}
    </View>

    {!!reason && hasActions && <Text accessibilityLiveRegion="polite" style={s.notice}>{reason}</Text>}

    {state.capabilities.sessionRename && <View style={s.section}>
      <Text accessibilityRole="header" style={s.heading}>Chat title</Text>
      <TextInput testID="session-title-input" accessibilityLabel="Chat title" accessibilityState={{ disabled }}
        editable={!disabled} value={title} onChangeText={setTitle} maxLength={160}
        placeholder="Name this chat" placeholderTextColor={t.subtle} selectionColor={t.primary}
        style={[s.input, disabled && s.disabled]} />
      <View style={s.actionEnd}><NativeAction testID="save-session-title" label="Save title" theme={t} secondary
        disabled={disabled || !changedTitle}
        onPress={() => request(() => sessionStore.renameSession(title.trim()), 'Title change requested. The host title above updates when confirmed.')} /></View>
    </View>}

    {thinking && <View style={s.section}>
      <View style={s.between}><Text accessibilityRole="header" style={s.heading}>Thinking</Text>
        {!!thinking.level && <Text style={s.metadata}>{readableLevel(thinking.level)}</Text>}
      </View>
      {state.capabilities.thinkingSelection && thinking.availableLevels.length > 0
        ? <View accessibilityRole="radiogroup" style={s.chips}>{thinking.availableLevels.map(level => {
          const selected = thinking.level === level;
          return <Pressable key={level} accessibilityRole="radio" accessibilityLabel={`Thinking level ${readableLevel(level)}`}
            accessibilityState={{ checked: selected, disabled: disabled || selected }} aria-checked={selected} disabled={disabled || selected}
            onPress={() => request(() => sessionStore.setThinking(level), 'Thinking change requested. The selected level updates when confirmed.')}
            style={[s.chip, selected && s.selected, disabled && s.disabled]}>
            {selected && <Check size={14} color={t.primary} />}<Text style={[s.chipText, selected && { color: t.primary }]}>{readableLevel(level)}</Text>
          </Pressable>;
        })}</View>
        : <Text style={s.body}>The host controls this setting.</Text>}
    </View>}

    {context && <View style={s.section}>
      <View style={s.between}><Text accessibilityRole="header" style={s.heading}>Context</Text>
        {percent !== undefined && <Text style={[s.value, { color: contextColor }]}>{Math.round(percent)}%</Text>}
      </View>
      {percent !== undefined && <View accessibilityRole="progressbar" accessibilityLabel="Context window used"
        accessibilityValue={{ min: 0, max: 100, now: percent, text: `${Math.round(percent)} percent used` }}
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={`${Math.round(percent)} percent used`} style={s.track}>
        <View style={[s.fill, { width: `${percent}%`, backgroundColor: contextColor }]} />
      </View>}
      <Text style={s.body}>{count(context.tokens)} / {count(context.contextWindow)} tokens</Text>
      <Text style={s.small}>Reported by the host.</Text>
    </View>}

    {usage && <View style={s.section}>
      <View style={s.between}><Text accessibilityRole="header" style={s.heading}>Usage</Text><Text style={s.metadata}>Current branch</Text></View>
      <View style={s.metrics}>
        {[['Input', usage.input], ['Output', usage.output], ['Cache read', usage.cacheRead], ['Cache write', usage.cacheWrite]].map(([label, value]) => <View key={label} style={s.metric}>
          <Text style={s.small}>{label}</Text><Text selectable style={s.value}>{count(Number(value))}</Text>
        </View>)}
      </View>
      {usage.cost !== undefined && <Text style={s.small}>Reported cost (USD): {new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(usage.cost)}</Text>}
      <Text style={s.small}>Token totals for this conversation branch, separate from provider subscription limits.</Text>
    </View>}

    {tools && <View style={s.section}>
      <Pressable testID="session-tool-catalog" accessibilityRole="button" accessibilityLabel="Host tool catalog"
        accessibilityState={{ expanded: toolsOpen }} aria-expanded={toolsOpen} onPress={() => setToolsOpen(!toolsOpen)} style={[s.between, s.disclosure]}>
        <View style={s.row}><Wrench size={17} color={t.muted} /><Text style={s.heading}>Host tools</Text><Text style={s.metadata}>{tools.filter(tool => tool.active).length} / {tools.length} active</Text></View>
        {toolsOpen ? <ChevronUp size={18} color={t.muted} /> : <ChevronDown size={18} color={t.muted} />}
      </Pressable>
      {toolsOpen && <View style={s.toolList}>
        {tools.length === 0 && <Text style={s.body}>The host reports no tools.</Text>}
        {tools.map(tool => <View key={tool.name} style={s.tool}>
          <View style={s.between}><Text selectable style={[s.metadata, s.toolName]}>{tool.name}</Text><Text style={[s.small, { color: tool.active ? t.success : t.muted }]}>{tool.active ? 'Active' : 'Inactive'}</Text></View>
          {!!tool.description && <Text selectable style={s.small}>{tool.description}</Text>}
        </View>)}
        <Text style={s.small}>Tool selection is managed on the host.</Text>
      </View>}
    </View>}

    {state.capabilities.focusSession && <Pressable testID="focus-host-session" accessibilityRole="button" accessibilityLabel="Show session in Tern"
      accessibilityState={{ disabled: focusDisabled }} disabled={focusDisabled} style={[s.focusButton, focusDisabled && s.disabled]}
      onPress={() => request(() => sessionStore.focusSession(), 'Pane focus requested in Tern.', focusDisabled)}>
      <ExternalLink size={18} color={t.primary} /><Text style={s.actionText}>Show in Tern</Text>
    </Pressable>}

    {!!notice && <Text accessibilityLiveRegion="polite" style={s.small}>{notice}</Text>}
    {!!error && <Text accessibilityRole="alert" style={s.error}>{error}</Text>}
    {!!state.connection.error && state.connection.error !== error && <Text accessibilityRole="alert" style={s.error}>{state.connection.error}</Text>}
  </ScrollView>;
}

function styles(t: Theme) { return StyleSheet.create({
  flex: { flex: 1, minHeight: 0 }, page: { gap: 20, paddingBottom: 20 },
  identity: { gap: 6 }, eyebrow: { color: t.subtle, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 11, lineHeight: 18 },
  sessionTitle: { color: t.ink, fontSize: 20, lineHeight: 28, fontWeight: '600' },
  heading: { color: t.ink, fontSize: 14, lineHeight: 21, fontWeight: '600' },
  body: { color: t.muted, fontSize: 13, lineHeight: 21 }, small: { color: t.muted, fontSize: 12, lineHeight: 19 },
  metadata: { color: t.muted, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 11, lineHeight: 18 },
  value: { color: t.ink, fontVariant: ['tabular-nums'], fontSize: 17, lineHeight: 25, fontWeight: '600' },
  section: { gap: 10, borderTopWidth: 1, borderTopColor: t.line, paddingTop: 18 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1, flexWrap: 'wrap' },
  between: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  input: { minHeight: 48, borderWidth: 1, borderColor: t.controlLine, borderRadius: 8, backgroundColor: t.background, paddingHorizontal: 13, paddingVertical: 12, color: t.ink, fontSize: 15, lineHeight: 22 },
  actionEnd: { alignItems: 'flex-end' }, disabled: { opacity: .5 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderColor: t.line, borderRadius: 8, paddingHorizontal: 13, paddingVertical: 10, backgroundColor: t.background },
  selected: { backgroundColor: t.primarySoft, borderColor: t.primary }, chipText: { color: t.ink, fontSize: 13, fontWeight: '500' },
  track: { height: 8, backgroundColor: t.surfaceAlt, borderRadius: 4, overflow: 'hidden' }, fill: { height: '100%', borderRadius: 4 },
  metrics: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 }, metric: { width: '47%', flexGrow: 1, backgroundColor: t.surfaceAlt, padding: 12, borderRadius: 8, gap: 3 },
  disclosure: { minHeight: 44 }, toolList: { gap: 10 }, tool: { gap: 5, padding: 12, borderWidth: 1, borderColor: t.line, borderRadius: 8 }, toolName: { flex: 1, minWidth: 0, color: t.ink },
  focusButton: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9, borderWidth: 1, borderColor: t.line, borderRadius: 8, backgroundColor: t.background },
  actionText: { color: t.primary, fontSize: 14, fontWeight: '600' },
  notice: { color: t.amber, fontSize: 13, lineHeight: 21 }, error: { color: t.error, fontSize: 13, lineHeight: 21 },
}); }
