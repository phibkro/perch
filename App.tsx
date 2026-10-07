import React, { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AppState, BackHandler, Keyboard, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StatusBar, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft, ArrowRight, BookOpen, ChevronDown, ChevronRight, CircleHelp, Feather, FileText, Link2, Menu, MessageSquare, Plus, RefreshCw, Server, Settings2, Sparkles, SquarePen, WifiOff, X } from 'lucide-react-native';
import type { LucideIcon } from 'lucide-react-native';
import { Uniwind } from 'uniwind';
import { sessionStore, type SessionSnapshot, type PendingQuestion } from './src/session';
import { ChatSurface } from './src/chat/ChatSurface';
import { ArtifactWorkspace, artifactForMessage, deriveArtifacts, storedArtifactsToArtifacts, type Artifact } from './src/artifacts';
import { NativeAction, NativeAppearanceSwitch } from './src/ui/NativeAction';
import { ModelPicker } from './src/ui/ModelPicker';
import { darkTheme, lightTheme, type Theme } from './src/ui/theme';

type Screen = 'chat' | 'artifacts' | 'connection';
type SheetName = 'connect' | 'question' | 'models' | 'host-new-chat' | null;
const ThemeContext = createContext<Theme>(lightTheme);
const useUI = () => { const t = useContext(ThemeContext); return { t, s: useMemo(() => styles(t), [t]) }; };
const online = (state: SessionSnapshot) => state.connection.status === 'demo' || state.connection.status === 'live';
const friendly = (status: string) => ({ idle: 'Ready', working: 'Working', 'needs-input': 'Needs input', done: 'Complete', interrupted: 'Interrupted' }[status] ?? status);

function IconButton({ icon: Icon, label, onPress, disabled }: { icon: LucideIcon; label: string; onPress: () => void; disabled?: boolean }) {
  const { t, s } = useUI();
  return <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress} style={({ pressed }) => [s.iconButton, { opacity: disabled ? .4 : pressed ? .65 : 1 }]}><Icon size={21} color={t.ink} strokeWidth={1.8} /></Pressable>;
}
function Brand() { const { t, s } = useUI(); return <View style={s.row}><View style={s.brandMark}><Feather size={23} color={t.primaryInk} /></View><Text style={s.brandName}>perch<Text style={{ color: t.primary }}>.</Text></Text></View>; }
function Pill({ text, attention = false }: { text: string; attention?: boolean }) { const { t, s } = useUI(); return <View style={[s.pill, attention && { backgroundColor: t.amberSoft }]}><View style={[s.dot, { backgroundColor: attention ? t.amber : t.primary }]} /><Text style={{ color: attention ? t.amber : t.primary, fontSize: 11, fontWeight: '600' }}>{text}</Text></View>; }
function TextAction({ label, onPress, icon: Icon = ArrowRight }: { label: string; onPress: () => void; icon?: LucideIcon }) { const { t, s } = useUI(); return <Pressable accessibilityRole="button" onPress={onPress} style={s.textAction}><Text style={s.actionText}>{label}</Text><Icon size={15} color={t.primary} /></Pressable>; }

function Sidebar({ state, screen, artifactCount, onNewChat, onOpenChat, onNavigate, onConnect, onClose }: {
  state: SessionSnapshot; screen: Screen; artifactCount: number; onNewChat: () => void;
  onOpenChat: (id: string) => void; onNavigate: (screen: Screen) => void; onConnect: () => void; onClose?: () => void;
}) {
  const { t, s } = useUI();
  return <View testID="chat-sidebar" style={[s.sidebar, !!onClose && { width: '100%', borderRightWidth: 0 }]}>
    <View style={s.sidebarHeader}><Brand />{onClose && <IconButton icon={X} label="Close sidebar" onPress={onClose} />}</View>
    <View style={s.sidebarActions}>
      <Pressable accessibilityRole="button" accessibilityLabel="New chat" testID="new-chat-navigation" onPress={onNewChat} disabled={!!state.sessionAction} style={s.newChatButton}><SquarePen size={19} color={t.primary} /><Text style={[s.sidebarLabel, { color: t.primary }]}>{state.sessionAction === 'creating' ? 'Creating chat…' : 'New chat'}</Text><Plus size={17} color={t.primary} style={{ marginLeft: 'auto' }} /></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="Artifacts" aria-selected={screen === 'artifacts'} accessibilityState={{ selected: screen === 'artifacts' }} onPress={() => onNavigate('artifacts')} style={[s.sidebarItem, screen === 'artifacts' && s.sidebarSelected]}><BookOpen size={18} color={t.muted} /><Text style={s.sidebarLabel}>Artifacts</Text><Text style={[s.smallMuted, { marginLeft: 'auto' }]}>{artifactCount}</Text></Pressable>
    </View>
    <Text style={s.historyHeading}>CHATS</Text>
    <ScrollView style={s.flex} showsVerticalScrollIndicator={false} contentContainerStyle={s.historyList} keyboardShouldPersistTaps="handled">
      {state.sessions.map(session => <Pressable key={session.id} testID={`chat-history-${session.id}`} accessibilityRole="button" accessibilityLabel={`Open ${session.title}`} aria-selected={screen === 'chat' && state.activeSessionId === session.id} accessibilityState={{ selected: screen === 'chat' && state.activeSessionId === session.id, disabled: !!state.sessionAction }} disabled={!!state.sessionAction} onPress={() => onOpenChat(session.id)} style={[s.historyItem, screen === 'chat' && state.activeSessionId === session.id && s.sidebarSelected]}>
        {session.id === 'artifacts' ? <FileText size={17} color={t.muted} /> : <MessageSquare size={17} color={t.muted} />}
        <Text style={[s.sidebarLabel, { flex: 1, fontWeight: state.activeSessionId === session.id ? '600' : '400' }]} numberOfLines={2}>{session.title}</Text>
        {session.status !== 'idle' && <View accessibilityLabel={friendly(session.status)} style={[s.dot, { backgroundColor: session.status === 'needs-input' ? t.amber : t.primary }]} />}
      </Pressable>)}
    </ScrollView>
    <View style={s.sidebarFooter}>
      <Pressable accessibilityRole="button" onPress={onConnect} style={s.sidebarItem}><Link2 size={18} color={t.muted} /><Text style={s.sidebarLabel}>{state.mode === 'demo' ? 'Connect a workspace' : 'Switch workspace'}</Text></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="Connection" aria-selected={screen === 'connection'} accessibilityState={{ selected: screen === 'connection' }} onPress={() => onNavigate('connection')} style={[s.sidebarItem, screen === 'connection' && s.sidebarSelected]}><Settings2 size={18} color={t.muted} /><Text style={s.sidebarLabel}>Connection & settings</Text></Pressable>
      <View style={s.sidebarStatus}><View style={[s.dot, { backgroundColor: online(state) ? t.primary : t.amber }]} /><Text style={s.smallMuted} numberOfLines={1}>{state.mode === 'demo' ? 'Demo · no model calls' : `${state.harness.name} · ${state.connection.label}`}</Text></View>
    </View>
  </View>;
}

function ConnectionScreen({ state, openConnect, dark, toggleDark, openChat, openModels, restartDemo }: { state: SessionSnapshot; openConnect: () => void; dark: boolean; toggleDark: () => void; openChat: () => void; openModels: () => void; restartDemo: () => void }) {
  const { t, s } = useUI();
  return <ScrollView contentContainerStyle={s.page} showsVerticalScrollIndicator={false}>
    <Text style={s.eyebrow}>YOUR PHONE. YOUR WORKSPACE.</Text><Text style={[s.title, { marginBottom: 26 }]}>Connection</Text>
    <View style={[s.card, { padding: 22 }]}><View style={s.between}><View style={s.sessionIcon}><Server size={25} color={t.primary} /></View><Pill text={state.mode === 'demo' ? 'Demo mode' : state.readOnly && online(state) ? 'View only' : state.connection.label} attention={!online(state)} /></View>
      <Text style={[s.sectionTitle, { marginTop: 20 }]}>{state.mode === 'demo' ? 'Bring your own assistant' : state.harness.name}</Text>
      <Text style={[s.body, { marginTop: 8, marginBottom: 20 }]}>{state.mode === 'demo' ? 'Connect Pi Durable, OMP, pi, or OpenCode. Your workspace can run on your hardware or in the cloud. Models and tools stay on that host.' : 'Perch follows the sessions on your host. Change models here, or switch workspace to use another harness or server.'}</Text>
      <NativeAction label={state.mode === 'demo' ? 'Connect a workspace' : 'Join another workspace'} theme={t} onPress={openConnect} testID="open-connect" />
      {state.connection.error && <Text accessibilityRole="alert" style={[s.body, { color: t.error, marginTop: 12 }]}>{state.connection.error}</Text>}
    </View>
    <Text style={[s.sectionTitle, { marginTop: 26, marginBottom: 12 }]}>Session details</Text>
    <View style={s.card}><Detail label="Harness" value={state.harness.name} /><Detail label="Transport" value={state.harness.transport} /><Detail label="Model" value={state.mode === 'demo' ? 'Simulated · no model call' : state.model ? `${state.model.name || state.model.id}${state.model.provider ? ` · ${state.model.provider}` : ''}` : 'Not reported by this host'} />
      {state.capabilities.modelSelection && !!state.availableModels?.length && <View style={{ paddingHorizontal: 16 }}><TextAction label="Choose a model" onPress={openModels} /></View>}
    </View>
    <Text style={[s.sectionTitle, { marginTop: 26, marginBottom: 12 }]}>Make yourself at home</Text><View style={[s.card, { padding: 16 }]}><NativeAppearanceSwitch value={dark} onValueChange={toggleDark} theme={t} /></View>
    <Text style={[s.sectionTitle, { marginTop: 26, marginBottom: 6 }]}>Try the experience</Text><Text style={[s.body, { marginBottom: 12 }]}>Explore the flow without a server or model.</Text>
    <View style={s.card}><Pressable accessibilityRole="button" onPress={restartDemo} style={s.settingRow}><Sparkles size={20} color={t.primary} /><Text style={[s.noteTitle, s.flex]}>Restart the demo</Text><ChevronRight size={18} color={t.subtle} /></Pressable>
      {state.mode === 'demo' && <Pressable accessibilityRole="button" onPress={() => { sessionStore.simulateDisconnect(); openChat(); }} style={[s.settingRow, s.topLine]}><WifiOff size={20} color={t.primary} /><Text style={[s.noteTitle, s.flex]}>Simulate a connection drop</Text><ChevronRight size={18} color={t.subtle} /></Pressable>}
      {state.mode !== 'demo' && !online(state) && <Pressable accessibilityRole="button" onPress={sessionStore.reconnect} style={[s.settingRow, s.topLine]}><RefreshCw size={20} color={t.primary} /><Text style={s.noteTitle}>Reconnect</Text></Pressable>}
    </View>
    <Text style={[s.smallMuted, { textAlign: 'center', marginTop: 28 }]}>Perch 0.5.1 · an independent native assistant companion.{ '\n' }Pi Durable, OMP, pi, and OpenCode. Your models, your workspace.</Text>
  </ScrollView>;
}
function Detail({ label, value }: { label: string; value: string }) { const { s } = useUI(); return <View style={s.detail}><Text style={s.smallMuted}>{label}</Text><Text selectable style={[s.body, { flex: 1, textAlign: 'right' }]}>{value}</Text></View>; }

function Sheet({ visible, title, onClose, children, scroll = true }: { visible: boolean; title: string; onClose: () => void; children: React.ReactNode; scroll?: boolean }) {
  const { t, s } = useUI(); const insets = useSafeAreaInsets(); const { height } = useWindowDimensions();
  return <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
    <KeyboardAvoidingView style={s.modalRoot} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <Pressable accessibilityLabel="Close sheet" onPress={onClose} style={[StyleSheet.absoluteFill, { backgroundColor: t.backdrop }]} />
      <View accessibilityViewIsModal style={[s.sheet, { paddingBottom: Math.max(22, insets.bottom + 12) }]}><View style={s.sheetHandle} /><View style={s.between}><Text accessibilityRole="header" style={[s.sectionTitle, s.flex]}>{title}</Text><IconButton icon={X} label="Close sheet" onPress={onClose} /></View>{scroll ? <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingTop: 14 }}>{children}</ScrollView> : <View style={{ height: Math.min(560, height * .65), minHeight: 0, flexShrink: 1, paddingTop: 14 }}>{children}</View>}</View>
    </KeyboardAvoidingView>
  </Modal>;
}

function QuestionSheet({ question, visible, onClose, state }: { question: PendingQuestion | null; visible: boolean; onClose: () => void; state: SessionSnapshot }) {
  const { t, s } = useUI(); const [answer, setAnswer] = useState('');
  useEffect(() => setAnswer(question?.initialValue || ''), [question?.id, question?.kind]);
  if (!question) return null;
  const disabled = state.readOnly || !!state.sessionAction || !online(state) || !state.capabilities.questions;
  const submit = () => {
    if (disabled || question.answering || !answer.trim() || sessionStore.getSnapshot().pendingQuestion?.id !== question.id) return;
    sessionStore.answerQuestion(answer, question.id);
    if (sessionStore.getSnapshot().mode === 'demo') onClose();
  };
  return <Sheet visible={visible} title={question.title} onClose={onClose}>
    <Text style={[s.eyebrow, { color: t.amber, marginBottom: 14 }]}>YOUR ASSISTANT NEEDS A DECISION</Text><Text style={[s.body, { marginBottom: 22 }]}>{question.prompt}</Text>
    {question.kind === 'editor' ? <TextInput accessibilityLabel="Answer to agent" value={answer} onChangeText={setAnswer} multiline style={[s.input, { minHeight: 150, textAlignVertical: 'top' }]} placeholder="Write your answer…" placeholderTextColor={t.subtle} /> : <View style={{ gap: 10 }}>{question.options?.map(option => <Pressable key={option.id} accessibilityRole="radio" aria-checked={answer === option.id} accessibilityState={{ checked: answer === option.id }} accessibilityLabel={option.label} onPress={() => setAnswer(option.id)} style={[s.option, answer === option.id && { borderColor: t.primary, backgroundColor: t.primarySoft }]}><View style={[s.radio, answer === option.id && { borderColor: t.primary }]}>{answer === option.id && <View style={[s.dot, { backgroundColor: t.primary, width: 10, height: 10 }]} />}</View><View style={s.flex}><Text style={s.noteTitle}>{option.label}</Text>{option.description && <Text style={s.body}>{option.description}</Text>}</View></Pressable>)}</View>}
    {disabled && <Text style={[s.body, { color: t.amber, marginTop: 14 }]}>{state.readOnly ? 'This session is view only. Answer on the host or join with a write-enabled link.' : 'Reconnect before sending an answer.'}</Text>}
    <View style={{ marginTop: 22, alignItems: 'flex-end' }}><NativeAction theme={t} label={question.answering ? 'Waiting for host…' : 'Send answer'} onPress={submit} disabled={disabled || question.answering || !answer.trim()} testID="send-answer" /></View><Text style={[s.smallMuted, { marginTop: 12, textAlign: 'right' }]}>You can close this and answer later.</Text>
  </Sheet>;
}

function ConnectSheet({ state, visible, onClose, onConnected }: { state: SessionSnapshot; visible: boolean; onClose: () => void; onConnected: () => void }) {
  const { t, s } = useUI();
  const [kind, setKind] = useState<'durable' | 'omp' | 'pi' | 'opencode'>('durable');
  const [link, setLink] = useState(''); const [token, setToken] = useState(''); const [name, setName] = useState('Phone');
  const [username, setUsername] = useState('perch'); const [directory, setDirectory] = useState(''); const [error, setError] = useState(''); const [submitted, setSubmitted] = useState(false);
  const connecting = state.connection.status === 'connecting';
  const labels = { durable: 'Pi Durable', omp: 'OMP Collab', pi: 'pi bridge', opencode: 'OpenCode' };
  const urlLabels = { durable: 'Durable server URL', omp: 'Collab link', pi: 'Bridge WebSocket URL', opencode: 'OpenCode server URL' };
  const descriptions = {
    durable: 'Keep chats and generated files on your server. Reopen them when your phone reconnects, and choose from the models configured on that host.',
    omp: 'Start /collab inside your OMP session and paste its complete link. OMP can run inside a Tern pane.',
    pi: 'Run the included pi bridge on your hardware or a cloud server. Paste its WebSocket URL and access token. The bridge owns one pi session.',
    opencode: 'Run OpenCode with the included Perch gateway to open past chats and create new ones. Use the gateway’s HTTPS address and password. It keeps provider configuration on your host.',
  };
  const placeholders = { durable: 'https://your-perch.example', omp: 'Paste your /collab link', pi: 'wss://your-host.example/pi', opencode: 'https://your-opencode.example' };
  useEffect(() => { if (submitted && state.mode !== 'demo' && state.connection.status === 'live') { setLink(''); setToken(''); setDirectory(''); setSubmitted(false); onConnected(); onClose(); } }, [submitted, state.mode, state.connection.status]);
  const join = () => {
    setError('');
    if (!link.trim() || (kind !== 'omp' && !token.length)) {
      setError(kind === 'omp' ? 'Paste a Collab link from your OMP host.' : kind === 'opencode' ? 'Enter your OpenCode server URL and password.' : `Enter the ${kind === 'durable' ? 'durable server' : 'bridge WebSocket'} URL and access token.`);
      return;
    }
    setSubmitted(true);
    const pending = kind === 'durable' ? sessionStore.connectDurable({ url: link.trim(), token: token.trim() })
      : kind === 'omp' ? sessionStore.connectCollab(link.trim(), name.trim() || 'Phone')
      : kind === 'pi' ? sessionStore.connectPi({ url: link.trim(), token: token.trim() }, name.trim() || 'Phone')
      : sessionStore.connectOpenCode({ url: link.trim(), username: username.trim() || 'perch', password: token, ...(directory.trim() ? { directory: directory.trim() } : {}) });
    void pending.catch(e => { setSubmitted(false); setError(e instanceof Error ? e.message : 'Could not join the workspace.'); });
  };
  return <Sheet visible={visible} title="Connect your workspace" onClose={onClose}>
    <View style={s.harnessTabs}>{(['durable', 'omp', 'pi', 'opencode'] as const).map(value => <Pressable key={value} accessibilityRole="tab" aria-selected={kind === value} accessibilityState={{ selected: kind === value }} onPress={() => { setKind(value); setLink(''); setToken(''); setDirectory(''); setError(''); setSubmitted(false); }} disabled={connecting} style={[s.harnessTab, kind === value && { backgroundColor: t.primarySoft, borderColor: t.primary }]}><Text style={{ color: kind === value ? t.primary : t.muted, fontWeight: '600' }}>{labels[value]}</Text></Pressable>)}</View>
    <Text style={[s.body, { marginBottom: 19 }]}>{descriptions[kind]}</Text>
    <Text style={s.inputLabel}>{urlLabels[kind]}</Text><TextInput accessibilityLabel={urlLabels[kind]} testID="collab-link" secureTextEntry={kind === 'omp'} autoCapitalize="none" autoCorrect={false} autoComplete="off" value={link} onChangeText={setLink} placeholder={placeholders[kind]} placeholderTextColor={t.subtle} style={s.input} />
    {(kind === 'pi' || kind === 'durable') && <><Text style={s.inputLabel}>Access token</Text><TextInput accessibilityLabel={`${labels[kind]} access token`} secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete="off" value={token} onChangeText={setToken} placeholder={kind === 'durable' ? 'Your workspace token' : 'Your bridge token'} placeholderTextColor={t.subtle} style={s.input} /></>}
    {kind === 'opencode' && <>
      <Text style={s.inputLabel}>Gateway username</Text><TextInput accessibilityLabel="OpenCode username" value={username} onChangeText={setUsername} autoCapitalize="none" autoCorrect={false} style={s.input} />
      <Text style={s.inputLabel}>Gateway password</Text><TextInput accessibilityLabel="OpenCode server password" value={token} onChangeText={setToken} secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete="off" style={s.input} />
      <Text style={s.inputLabel}>Workspace directory · optional</Text><TextInput accessibilityLabel="OpenCode workspace directory" value={directory} onChangeText={setDirectory} autoCapitalize="none" autoCorrect={false} placeholder="Use the server's current directory" placeholderTextColor={t.subtle} style={s.input} />
    </>}
    {(kind === 'omp' || kind === 'pi') && <><Text style={s.inputLabel}>Your name on the host</Text><TextInput accessibilityLabel="Participant name" value={name} onChangeText={setName} maxLength={60} style={s.input} /></>}
    {(error || (submitted && state.connection.error)) && <Text accessibilityRole="alert" style={[s.body, { color: t.error, marginTop: 14 }]}>{error || state.connection.error}</Text>}
    <Text style={[s.smallMuted, { marginVertical: 18 }]}>These credentials grant access to your workspace. They stay in memory and are cleared when the app restarts.</Text><View style={{ alignItems: 'flex-end' }}><NativeAction theme={t} label={connecting ? 'Connecting…' : 'Join workspace'} onPress={join} disabled={connecting || !link.trim() || (kind !== 'omp' && !token.length)} testID="join-session" /></View>
  </Sheet>;
}

function Perch() {
  const state = useSyncExternalStore(sessionStore.subscribe, sessionStore.getSnapshot, sessionStore.getSnapshot);
  const [dark, setDark] = useState(false); const theme = dark ? darkTheme : lightTheme;
  useEffect(() => Uniwind.setTheme(dark ? 'dark' : 'light'), [dark]);
  return <ThemeContext.Provider value={theme}><Workspace state={state} dark={dark} toggleDark={() => setDark(!dark)} /></ThemeContext.Provider>;
}

function Workspace({ state, dark, toggleDark }: { state: SessionSnapshot; dark: boolean; toggleDark: () => void }) {
  const { t, s } = useUI(); const { width } = useWindowDimensions(); const desktop = width >= 900;
  const [screen, setScreen] = useState<Screen>('chat'); const [sheet, setSheet] = useState<SheetName>(null); const [drawerOpen, setDrawerOpen] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({}); const [submittedCopies, setSubmittedCopies] = useState<Record<string, string>>({});
  const [toast, setToast] = useState(''); const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null); const [documentIds, setDocumentIds] = useState<string[]>([]);
  const creationRequest = useRef(0);
  const namespace = `${state.mode}:${state.connectionEpoch ?? 0}:${state.activeSessionId}`; const active = state.sessions.find(item => item.id === state.activeSessionId);
  const artifacts = useMemo(() => {
    const all = [...storedArtifactsToArtifacts(state.storedArtifacts ?? []), ...deriveArtifacts(state.messages, state.tools)];
    for (const id of documentIds) { const message = state.messages.find(item => item.id === id); if (message) { const artifact = artifactForMessage(message); if (artifact && !all.some(item => item.id === artifact.id)) all.push(artifact); } }
    return all;
  }, [state.messages, state.tools, state.storedArtifacts, documentIds]);
  const navigate = (next: Screen) => { Keyboard.dismiss(); setDrawerOpen(false); setScreen(next); };
  const openConnect = () => { ++creationRequest.current; Keyboard.dismiss(); setDrawerOpen(false); setSheet('connect'); };
  const openArtifact = (artifact: Artifact) => { setSelectedArtifactId(artifact.id); navigate('artifacts'); };
  const openMessage = (id: string) => { const message = state.messages.find(item => item.id === id); if (!message) return; const artifact = artifactForMessage(message); if (!artifact) return; setDocumentIds(prev => prev.includes(id) ? prev : [...prev, id]); openArtifact(artifact); };
  const openChat = (id = state.activeSessionId) => { sessionStore.selectSession(id); setSheet(null); navigate('chat'); };
  const startDemo = () => { ++creationRequest.current; setDrafts({}); setSubmittedCopies({}); sessionStore.useDemo(); setSheet(null); navigate('chat'); };
  const newChat = () => {
    Keyboard.dismiss(); setDrawerOpen(false);
    const current = sessionStore.getSnapshot();
    if (!current.capabilities.sessionCreation) { setSheet('host-new-chat'); return; }
    if (current.sessionAction) return;
    const request = ++creationRequest.current;
    setSheet(null); setScreen('chat');
    void sessionStore.createSession().then(id => {
      if (request === creationRequest.current && id === undefined) setToast(sessionStore.getSnapshot().connection.error || 'The chat was not opened. Reconnect and check your history before trying again.');
    }).catch(() => { if (request === creationRequest.current) setToast('Could not confirm the new chat. Check your host history before trying again.'); });
  };
  useEffect(() => { setSelectedArtifactId(null); setDocumentIds([]); }, [namespace]);
  useEffect(() => { if (desktop) setDrawerOpen(false); }, [desktop]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 5000); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => { if (!state.pendingQuestion && sheet === 'question') setSheet(null); }, [state.pendingQuestion?.id, sheet]);
  useEffect(() => { const sub = BackHandler.addEventListener('hardwareBackPress', () => { if (sheet) { setSheet(null); return true; } if (drawerOpen) { setDrawerOpen(false); return true; } if (selectedArtifactId && screen === 'artifacts') { setSelectedArtifactId(null); return true; } if (screen !== 'chat') { setScreen('chat'); return true; } return false; }); return () => sub.remove(); }, [sheet, drawerOpen, screen, selectedArtifactId]);
  useEffect(() => { const sub = AppState.addEventListener('change', next => { const current = sessionStore.getSnapshot(); if (next === 'active' && current.mode !== 'demo' && /offline|reconnecting/.test(current.connection.status)) sessionStore.reconnect(); }); return () => sub.remove(); }, []);
  const modelLabel = state.mode === 'demo' ? 'Demo · no model calls' : state.model?.name || state.model?.id || 'Host-configured model';
  const sidebarProps = { state, screen, artifactCount: artifacts.length, onNewChat: newChat, onOpenChat: openChat, onNavigate: navigate, onConnect: openConnect };
  return <SafeAreaView edges={['top', 'left', 'right']} style={s.root}>
    <StatusBar barStyle={dark ? 'light-content' : 'dark-content'} backgroundColor={t.background} />
    {desktop && <Sidebar {...sidebarProps} />}
    <View testID="chat-shell" accessibilityElementsHidden={drawerOpen} importantForAccessibility={drawerOpen ? 'no-hide-descendants' : 'auto'} style={s.main}>
      <View testID="chat-header" style={s.chatHeader}>
        {!desktop && <IconButton icon={Menu} label="Open sidebar" onPress={() => { Keyboard.dismiss(); setDrawerOpen(true); }} />}
        <View style={s.headerTitle}><Text accessibilityRole="header" numberOfLines={1} style={s.cardTitle}>{screen === 'chat' ? active?.title || 'New chat' : screen === 'artifacts' ? 'Artifacts' : 'Connection & settings'}</Text>
          {screen === 'chat' && (state.capabilities.modelSelection && !!state.availableModels?.length ? <Pressable accessibilityRole="button" accessibilityLabel="Choose a model" onPress={() => setSheet('models')} style={s.modelPicker}><Text numberOfLines={1} style={s.smallMuted}>{modelLabel}</Text><ChevronDown size={13} color={t.muted} /></Pressable> : <Text style={s.smallMuted} numberOfLines={1}>{modelLabel}</Text>)}
        </View>
        {screen === 'chat' ? <><IconButton icon={BookOpen} label="Open artifacts" onPress={() => navigate('artifacts')} /><IconButton icon={SquarePen} label="Start a new chat" onPress={newChat} disabled={!!state.sessionAction} /></> : <IconButton icon={ArrowLeft} label="Back to chat" onPress={() => navigate('chat')} />}
      </View>
      {screen === 'chat' && <View style={s.flex}>
        {state.sessionAction && <View accessibilityLiveRegion="polite" style={s.banner}><RefreshCw size={18} color={t.primary} /><Text style={[s.body, s.flex]}>{state.sessionAction === 'creating' ? 'Creating your chat…' : 'Opening your chat…'} Your current conversation stays here until it is ready.</Text></View>}
        {online(state) && state.connection.error && !state.sessionAction && <View style={s.banner}><Text accessibilityRole="alert" style={[s.body, { color: t.amber }]}>{state.connection.error}</Text></View>}
        {!online(state) && <View style={s.banner}><WifiOff size={18} color={t.amber} /><Text style={[s.body, s.flex, { color: t.amber }]}>{state.connection.label}. Your draft stays here.</Text><TextAction label="Retry" onPress={sessionStore.reconnect} /></View>}
        {state.pendingQuestion && <Pressable accessibilityRole="button" accessibilityLabel="Answer agent question" onPress={() => setSheet('question')} style={s.banner}><CircleHelp size={21} color={t.amber} /><View style={s.flex}><Text style={[s.eyebrow, { color: t.amber }]}>YOUR INPUT</Text><Text style={[s.body, { color: t.amber }]}>{state.pendingQuestion.answering ? 'Answer sent · waiting for host' : state.pendingQuestion.title}</Text></View><ChevronRight size={20} color={t.amber} /></Pressable>}
        {state.mode === 'demo' && state.messages.length > 0 && !state.isWorking && !state.pendingQuestion && online(state) && <View style={s.demoActions}><TextAction label="Try a demo turn" icon={Sparkles} onPress={() => sessionStore.sendPrompt('Explore this workspace and ask me how to proceed.')} /></View>}
        <ChatSurface key={namespace} state={state} theme={t} artifacts={artifacts} onOpenArtifact={openArtifact} onOpenMessage={openMessage} onOpenArtifactExample={() => openChat('artifacts')} onTryDemo={() => openChat('mobile')} onConnect={openConnect} onNewChat={newChat} notify={setToast} draft={drafts[namespace] || ''} onDraftChange={text => setDrafts(prev => prev[namespace] === text ? prev : { ...prev, [namespace]: text })} submittedCopy={submittedCopies[namespace] || ''} onKeepSubmitted={text => setSubmittedCopies(prev => ({ ...prev, [namespace]: text }))} onRestoreSubmitted={() => { setDrafts(prev => ({ ...prev, [namespace]: submittedCopies[namespace] || '' })); setSubmittedCopies(prev => ({ ...prev, [namespace]: '' })); setToast('Text restored. Check the transcript before sending again.'); }} />
      </View>}
      {screen === 'artifacts' && <SafeAreaView edges={['bottom']} style={s.flex}><ArtifactWorkspace key={namespace} loadArtifact={sessionStore.loadArtifact} artifacts={artifacts} selectedArtifactId={selectedArtifactId} onSelectArtifact={setSelectedArtifactId} onClose={() => setSelectedArtifactId(null)} theme={t} /></SafeAreaView>}
      {screen === 'connection' && <SafeAreaView edges={['bottom']} style={s.flex}><ConnectionScreen state={state} openConnect={openConnect} dark={dark} toggleDark={toggleDark} openChat={() => openChat()} openModels={() => setSheet('models')} restartDemo={startDemo} /></SafeAreaView>}
      {!!toast && <View accessibilityLiveRegion="polite" style={s.toast}><Text style={{ color: t.primaryInk, fontSize: 13 }}>{toast}</Text></View>}
    </View>
    <Modal visible={!desktop && drawerOpen} transparent animationType="fade" onRequestClose={() => setDrawerOpen(false)} statusBarTranslucent>
      <View style={s.drawerRoot}>
        <Pressable accessibilityRole="button" accessibilityLabel="Dismiss sidebar" onPress={() => setDrawerOpen(false)} style={[StyleSheet.absoluteFill, { backgroundColor: t.backdrop }]} />
        <SafeAreaView edges={['top', 'bottom', 'left']} accessibilityViewIsModal testID="mobile-sidebar" style={[s.drawerPanel, { width: Math.min(320, width - 48) }]}><Sidebar {...sidebarProps} onClose={() => setDrawerOpen(false)} /></SafeAreaView>
      </View>
    </Modal>
    <QuestionSheet question={state.pendingQuestion} state={state} visible={sheet === 'question'} onClose={() => setSheet(null)} />
    <ConnectSheet state={state} visible={sheet === 'connect'} onClose={() => setSheet(null)} onConnected={() => { setDrafts(prev => Object.fromEntries(Object.entries(prev).filter(([key]) => key.startsWith('demo:')))); setSubmittedCopies(prev => Object.fromEntries(Object.entries(prev).filter(([key]) => key.startsWith('demo:')))); setScreen('chat'); }} />
    <Sheet visible={sheet === 'host-new-chat'} title="New chats start on your host" onClose={() => setSheet(null)}>
      <Text style={[s.body, { marginBottom: 20 }]}>{state.harness.name} shares one active session with this app. Start a new session on the host, then connect to it here.</Text>
      <NativeAction label="Return to current chat" theme={t} onPress={() => { setSheet(null); navigate('chat'); }} />
      <Pressable accessibilityRole="button" onPress={() => setSheet('connect')} style={[s.settingRow, { marginTop: 10 }]}><Link2 size={20} color={t.primary} /><Text style={[s.noteTitle, s.flex]}>Connect another host</Text><ChevronRight size={18} color={t.subtle} /></Pressable>
      <Pressable accessibilityRole="button" onPress={startDemo} style={s.settingRow}><Sparkles size={20} color={t.primary} /><View style={s.flex}><Text style={s.noteTitle}>Start a demo</Text><Text style={s.smallMuted}>Leave this connection and explore the app.</Text></View><ChevronRight size={18} color={t.subtle} /></Pressable>
    </Sheet>
    <Sheet visible={sheet === 'models'} title="Choose a model" onClose={() => setSheet(null)} scroll={false}>
      {sheet === 'models' && <ModelPicker models={state.availableModels || []} selected={state.model} disabled={state.readOnly || !online(state) || state.isWorking || !!state.pendingQuestion || !!state.sessionAction} theme={t} onSelect={model => { if (model.provider) sessionStore.setModel(model.provider, model.id); setSheet(null); }} />}
    </Sheet>
  </SafeAreaView>;
}

export default function App() { return <SafeAreaProvider><Perch /></SafeAreaProvider>; }

const styles = (t: Theme) => StyleSheet.create({
  flex: { flex: 1, minHeight: 0 }, row: { flexDirection: 'row', alignItems: 'center', gap: 9 }, between: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  root: { flex: 1, flexDirection: 'row', backgroundColor: t.background }, main: { flex: 1, minWidth: 0, minHeight: 0, backgroundColor: t.background },
  page: { padding: 24, paddingTop: 24, paddingBottom: 36, width: '100%', maxWidth: 760, alignSelf: 'center' },
  sidebar: { width: 280, height: '100%', flexShrink: 0, minHeight: 0, borderRightWidth: 1, borderRightColor: t.line, backgroundColor: t.surface },
  sidebarHeader: { height: 72, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingLeft: 20, paddingRight: 10 }, sidebarActions: { paddingHorizontal: 12, gap: 5 },
  brandMark: { width: 30, height: 30, borderRadius: 10, backgroundColor: t.primary, alignItems: 'center', justifyContent: 'center' }, brandName: { fontSize: 25, fontWeight: '700', letterSpacing: -1.2, color: t.ink },
  newChatButton: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, borderColor: t.line, backgroundColor: t.primarySoft, borderRadius: 12, minHeight: 48, paddingHorizontal: 13 },
  sidebarItem: { minHeight: 47, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 13, borderRadius: 11 }, sidebarSelected: { backgroundColor: t.surfaceAlt }, sidebarLabel: { fontSize: 13, lineHeight: 19, color: t.ink, fontWeight: '500' },
  historyHeading: { fontSize: 10, fontWeight: '700', letterSpacing: 1.1, color: t.subtle, paddingHorizontal: 25, paddingTop: 26, paddingBottom: 10 }, historyList: { paddingHorizontal: 12, gap: 3, paddingBottom: 16 }, historyItem: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 13, borderRadius: 11 },
  sidebarFooter: { padding: 12, gap: 3, borderTopWidth: 1, borderTopColor: t.line }, sidebarStatus: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 13, paddingTop: 10, paddingBottom: 4 },
  drawerRoot: { flex: 1, flexDirection: 'row' }, drawerPanel: { height: '100%', backgroundColor: t.surface },
  iconButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 13 },
  eyebrow: { fontSize: 10, letterSpacing: 1.5, color: t.muted, fontWeight: '700' }, title: { fontSize: 30, lineHeight: 37, letterSpacing: -1, color: t.ink, fontWeight: '600', marginTop: 12 },
  sectionTitle: { color: t.ink, fontSize: 18, fontWeight: '600', letterSpacing: -.3 }, cardTitle: { color: t.ink, fontSize: 15, fontWeight: '600', lineHeight: 21 }, body: { color: t.muted, fontSize: 13, lineHeight: 21 }, smallMuted: { color: t.muted, fontSize: 11, lineHeight: 17 }, noteTitle: { color: t.ink, fontSize: 13, fontWeight: '600', lineHeight: 20 },
  card: { backgroundColor: t.surface, borderWidth: 1, borderColor: t.line, borderRadius: 18, overflow: 'hidden' }, sessionIcon: { width: 43, height: 43, borderRadius: 13, backgroundColor: t.primarySoft, alignItems: 'center', justifyContent: 'center' }, topLine: { borderTopWidth: 1, borderTopColor: t.line },
  textAction: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 4 }, actionText: { color: t.primary, fontSize: 12, fontWeight: '600' }, dot: { width: 5, height: 5, borderRadius: 5 }, pill: { flexDirection: 'row', gap: 6, alignItems: 'center', paddingHorizontal: 10, paddingVertical: 7, borderRadius: 20, backgroundColor: t.primarySoft, maxWidth: '78%' },
  chatHeader: { minHeight: 64, flexDirection: 'row', gap: 4, alignItems: 'center', paddingHorizontal: 10, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: t.line }, headerTitle: { flex: 1, minWidth: 0, gap: 1, paddingHorizontal: 7 }, modelPicker: { minHeight: 44, flexDirection: 'row', gap: 5, alignItems: 'center', alignSelf: 'flex-start' },
  banner: { backgroundColor: t.amberSoft, flexDirection: 'row', alignItems: 'center', gap: 11, paddingHorizontal: 18, paddingVertical: 11 }, demoActions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', paddingHorizontal: 20, minHeight: 40 },
  detail: { flexDirection: 'row', alignItems: 'center', gap: 16, padding: 16, borderBottomWidth: 1, borderBottomColor: t.line }, settingRow: { flexDirection: 'row', alignItems: 'center', gap: 13, padding: 17, minHeight: 63 },
  modalRoot: { flex: 1, justifyContent: 'flex-end', alignItems: 'center' }, sheet: { backgroundColor: t.surface, width: '100%', maxWidth: 580, maxHeight: '90%', paddingHorizontal: 24, paddingTop: 12, borderTopLeftRadius: 28, borderTopRightRadius: 28 }, sheetHandle: { width: 35, height: 4, borderRadius: 4, backgroundColor: t.line, alignSelf: 'center', marginBottom: 10 },
  inputLabel: { color: t.ink, fontWeight: '600', fontSize: 12, marginTop: 15, marginBottom: 8 }, input: { borderWidth: 1, borderColor: t.line, borderRadius: 12, backgroundColor: t.background, minHeight: 50, padding: 14, color: t.ink, fontSize: 15, lineHeight: 22 }, option: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, borderColor: t.line, padding: 16, borderRadius: 14, minHeight: 62, marginBottom: 8 }, radio: { width: 20, height: 20, borderRadius: 12, borderWidth: 1.5, borderColor: t.subtle, alignItems: 'center', justifyContent: 'center' }, harnessTabs: { flexDirection: 'row', flexWrap: 'wrap', gap: 9, marginBottom: 19 }, harnessTab: { flexBasis: '47%', flexGrow: 1, minHeight: 48, borderWidth: 1, borderColor: t.line, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  toast: { position: 'absolute', bottom: 160, left: 20, right: 20, maxWidth: 600, alignSelf: 'center', backgroundColor: t.primary, padding: 16, borderRadius: 16 },
});
