import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Linking, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Check, ChevronRight, Cloud, Copy, Link2, Server, Trash2 } from 'lucide-react-native';
import { sessionStore, type SessionSnapshot } from '../session';
import { parsePairingCode, validateCredentials, workspaceManager, type Deployment } from '../workspace';
import { NativeAction } from './NativeAction';
import type { Theme } from './theme';

const useWorkspaces = () => useSyncExternalStore(workspaceManager.subscribe, workspaceManager.getSnapshot, workspaceManager.getSnapshot);

export function WorkspaceSetup({ theme: t, state, onConnected, onAdvanced }: {
  theme: Theme; state: SessionSnapshot; onConnected: () => void; onAdvanced: () => void;
}) {
  const s = useMemo(() => styles(t), [t]); const workspaces = useWorkspaces();
  const [deployment, setDeployment] = useState<Deployment>('self-hosted');
  const [pairing, setPairing] = useState(''); const [manual, setManual] = useState(false);
  const [url, setUrl] = useState(''); const [token, setToken] = useState('');
  const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [pending, setPending] = useState(false); const [epoch, setEpoch] = useState<number>();
  const request = useRef(0);
  useEffect(() => { void workspaceManager.initialize(); return () => { ++request.current; }; }, []);
  useEffect(() => {
    if (epoch !== undefined && state.connectionEpoch === epoch && state.connection.status === 'live') {
      setPairing(''); setToken(''); setEpoch(undefined); onConnected();
    }
  }, [epoch, state.connectionEpoch, state.connection.status, onConnected]);
  const busy = pending || workspaces.busy || epoch !== undefined && state.connectionEpoch === epoch && state.connection.status === 'connecting';
  async function connect(savedId?: string) {
    const current = ++request.current; setError(''); setNotice(''); setPending(true); setEpoch(undefined);
    try {
      if (savedId) await workspaceManager.open(savedId);
      else await workspaceManager.join(manual ? validateCredentials({ url, token }) : parsePairingCode(pairing));
      if (current === request.current) setEpoch(sessionStore.getSnapshot().connectionEpoch);
    } catch (cause) { if (current === request.current) setError(cause instanceof Error ? cause.message : 'The workspace could not be joined.'); }
    finally { if (current === request.current) setPending(false); }
  }
  async function forget(id: string) {
    setError('');
    try { await workspaceManager.forget(id); setNotice('Workspace removed from this device. Its host and chats are still available.'); }
    catch { setError('The saved access token could not be removed. Unlock this device and try again.'); }
  }
  const command = deployment === 'cloudflare' ? 'bun run setup:cloud' : 'bun run setup:host';
  async function copyCommand() {
    try { await Clipboard.setStringAsync(command); setNotice('Setup command copied. Run it from your Perch checkout on the host.'); }
    catch { setError('The command could not be copied. You can select the text instead.'); }
  }
  return <View testID="workspace-setup">
    {workspaces.profiles.length > 0 && <>
      <Text style={s.label}>SAVED WORKSPACES</Text>
      <View style={s.group}>{workspaces.profiles.map(profile => <View key={profile.id} style={s.savedRow}>
        <Pressable accessibilityRole="button" accessibilityLabel={`Connect ${profile.name}`} onPress={() => void connect(profile.id)} disabled={busy} style={s.savedButton}>
          {profile.deployment === 'cloudflare' ? <Cloud size={20} color={t.primary} /> : <Server size={20} color={t.primary} />}
          <View style={s.flex}><Text style={s.heading}>{profile.name}</Text><Text style={s.small} numberOfLines={1}>{new URL(profile.url).host}</Text></View>
          <ChevronRight size={18} color={t.subtle} />
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={`Forget ${profile.name}`} disabled={busy} onPress={() => void forget(profile.id)} style={s.remove}><Trash2 size={17} color={t.subtle} /></Pressable>
      </View>)}</View>
    </>}
    <Text style={[s.label, { marginTop: workspaces.profiles.length ? 24 : 0 }]}>ADD A WORKSPACE</Text>
    <Text style={[s.body, { marginBottom: 16 }]}>Connect once. Choose any assistant available on that host.</Text>
    <View style={s.choices}>
      {(['self-hosted', 'cloudflare'] as const).map(value => <Pressable key={value} accessibilityRole="tab" accessibilityLabel={value === 'self-hosted' ? 'Self-hosted setup' : 'Cloud setup'} aria-selected={deployment === value} accessibilityState={{ selected: deployment === value }} disabled={busy} onPress={() => { setDeployment(value); setError(''); setNotice(''); }} style={[s.choice, deployment === value && s.selected]}>
        {value === 'self-hosted' ? <Server size={22} color={deployment === value ? t.primary : t.muted} /> : <Cloud size={22} color={deployment === value ? t.primary : t.muted} />}
        <Text style={s.heading}>{value === 'self-hosted' ? 'Self-hosted' : 'Cloud'}</Text>
        <Text style={s.small}>{value === 'self-hosted' ? 'Your computer or server' : 'Cloudflare'}</Text>
      </Pressable>)}
    </View>
    <View style={s.step}>
      <View style={s.number}><Text style={s.numberText}>1</Text></View>
      <View style={s.flex}>
        <Text style={s.heading}>{deployment === 'cloudflare' ? 'Set up your Cloudflare workspace' : 'Set up your host once'}</Text>
        <Text style={[s.body, { marginTop: 5 }]}>{deployment === 'cloudflare' ? 'On a computer, authorize Cloudflare and add your chosen model providers. Setup prepares the worker, durable chats, and artifact storage.' : 'On your host, choose the available harnesses and sign in to model providers. The phone uses their shared workspace address.'}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Copy workspace setup command" onPress={() => void copyCommand()} style={s.command}>
          <Text selectable style={s.code}>{command}</Text><Copy size={16} color={t.primary} />
        </Pressable>
        <Pressable accessibilityRole="link" onPress={() => { void Linking.openURL('https://github.com/phibkro/perch/blob/main/docs/WORKSPACE-SETUP.md').catch(() => setError('The setup guide could not be opened.')); }} style={s.textButton}><Text style={s.link}>Open the setup guide</Text><ChevronRight size={15} color={t.primary} /></Pressable>
      </View>
    </View>
    <View style={s.step}>
      <View style={s.number}><Text style={s.numberText}>2</Text></View>
      <View style={s.flex}>
        <Text style={s.heading}>Pair this phone</Text>
        <Text style={[s.body, { marginTop: 5, marginBottom: 14 }]}>Paste the code printed by setup. Already have a workspace? Start here.</Text>
        {manual ? <>
          <Text style={s.inputLabel}>Workspace URL</Text><TextInput accessibilityLabel="Workspace URL" testID="workspace-url" value={url} onChangeText={setUrl} autoCapitalize="none" autoCorrect={false} autoComplete="off" placeholder="https://your-workspace.example" placeholderTextColor={t.subtle} style={s.input} editable={!busy} />
          <Text style={s.inputLabel}>Workspace access token</Text><TextInput accessibilityLabel="Workspace access token" value={token} onChangeText={setToken} autoCapitalize="none" autoCorrect={false} autoComplete="off" secureTextEntry placeholder="The device token from setup" placeholderTextColor={t.subtle} style={s.input} editable={!busy} />
        </> : <TextInput accessibilityLabel="Workspace pairing code" testID="workspace-pairing-code" value={pairing} onChangeText={setPairing} autoCapitalize="none" autoCorrect={false} autoComplete="off" secureTextEntry placeholder="perch://pair#…" placeholderTextColor={t.subtle} style={s.input} editable={!busy} />}
        <Pressable accessibilityRole="button" onPress={() => { setManual(!manual); setError(''); }} disabled={busy} style={s.textButton}><Text style={s.link}>{manual ? 'Use a pairing code' : 'Enter an address and token'}</Text></Pressable>
      </View>
    </View>
    {(error || epoch !== undefined && state.connectionEpoch === epoch && state.connection.error) && <Text accessibilityRole="alert" style={s.error}>{error || state.connection.error}</Text>}
    {workspaces.storageError && <Text accessibilityRole="alert" style={s.error}>{workspaces.storageError}</Text>}
    {notice && <Text accessibilityLiveRegion="polite" style={[s.small, { marginBottom: 12 }]}>{notice}</Text>}
    <Text style={[s.small, { marginBottom: 16 }]}>{Platform.OS === 'web' ? 'This browser preview remembers access for this visit. The installed app uses device secure storage.' : 'Workspace access is saved in device secure storage. Provider keys and Cloudflare credentials stay on your host.'}</Text>
    <View style={{ alignItems: 'flex-end' }}><NativeAction theme={t} label={busy ? 'Joining workspace…' : 'Join workspace'} onPress={() => void connect()} disabled={busy || (manual ? !url.trim() || !token.trim() : !pairing.trim())} testID="join-workspace" /></View>
    <Pressable accessibilityRole="button" onPress={onAdvanced} disabled={busy} style={[s.textButton, { marginTop: 22, justifyContent: 'center' }]}><Link2 size={15} color={t.muted} /><Text style={s.small}>Advanced connection · existing servers</Text><ChevronRight size={15} color={t.muted} /></Pressable>
  </View>;
}

export function WorkspaceConnections({ theme: t, onConnected }: { theme: Theme; onConnected: () => void }) {
  const s = useMemo(() => styles(t), [t]); const workspace = useWorkspaces(); const [error, setError] = useState('');
  if (!workspace.active) return null;
  return <View style={{ marginTop: 24 }}>
    <Text style={[s.heading, { marginBottom: 7 }]}>{workspace.active.name}</Text>
    <Text style={[s.small, { marginBottom: 12 }]}>{workspace.active.deployment === 'cloudflare' ? 'Cloudflare' : 'Self-hosted'} · Choose an assistant on this workspace</Text>
    <View style={s.group}>{workspace.connections.map(connection => <Pressable key={connection.id} accessibilityRole="button" accessibilityLabel={`Use ${connection.name}`} accessibilityState={{ selected: connection.id === workspace.selectedConnectionId }} disabled={workspace.busy || connection.id === workspace.selectedConnectionId} onPress={() => {
      setError(''); void workspaceManager.chooseConnection(connection.id).then(onConnected).catch(() => setError('This assistant could not be opened. Reconnect the workspace to refresh its list.'));
    }} style={[s.savedButton, { padding: 16 }]}>
      <View style={s.flex}><Text style={s.heading}>{connection.name}</Text><Text style={s.small}>{connection.kind === 'remote' ? 'Browse and attach to running host sessions' : connection.kind === 'omp' ? 'Join a shared terminal session' : connection.kind === 'durable' ? 'Persistent chats and artifacts' : connection.kind === 'pi' ? 'Host-managed Pi session' : 'OpenCode sessions'}</Text></View>
      {connection.id === workspace.selectedConnectionId ? <Check size={19} color={t.primary} /> : <ChevronRight size={18} color={t.subtle} />}
    </Pressable>)}</View>
    {error && <Text accessibilityRole="alert" style={s.error}>{error}</Text>}
    {workspace.storageError && <Text accessibilityRole="alert" style={s.error}>{workspace.storageError}</Text>}
  </View>;
}

function styles(t: Theme) { return StyleSheet.create({
  flex: { flex: 1, minWidth: 0 }, label: { fontSize: 11, fontWeight: '500', fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', letterSpacing: .6, color: t.subtle, marginBottom: 9 },
  heading: { fontSize: 15, lineHeight: 21, fontWeight: '600', color: t.ink }, body: { fontSize: 14, lineHeight: 21, color: t.muted }, small: { fontSize: 12, lineHeight: 18, color: t.muted },
  choices: { flexDirection: 'row', gap: 10, marginBottom: 22 }, choice: { flex: 1, gap: 7, padding: 15, borderWidth: 1, borderColor: t.line, borderRadius: 12, backgroundColor: t.surface }, selected: { borderColor: t.primary, backgroundColor: t.primarySoft },
  group: { borderWidth: 1, borderColor: t.line, borderRadius: 12, overflow: 'hidden', backgroundColor: t.surface },
  savedRow: { flexDirection: 'row', alignItems: 'center', paddingLeft: 14 }, savedButton: { flex: 1, flexDirection: 'row', gap: 12, alignItems: 'center', paddingVertical: 15 }, remove: { padding: 15 },
  step: { flexDirection: 'row', gap: 12, marginBottom: 23 }, number: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: t.primarySoft }, numberText: { fontSize: 12, fontWeight: '700', color: t.primary },
  command: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8, borderWidth: 1, borderColor: t.line, backgroundColor: t.surfaceAlt, borderRadius: 8, padding: 12, marginTop: 12, minHeight: 48 }, code: { flex: 1, fontSize: 12, color: t.ink, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  inputLabel: { color: t.muted, fontSize: 12, marginBottom: 7 }, input: { borderWidth: 1, borderColor: t.controlLine, borderRadius: 8, paddingHorizontal: 13, paddingVertical: 13, color: t.ink, backgroundColor: t.surface, fontSize: 15, marginBottom: 10, minHeight: 48 },
  textButton: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: 9 }, link: { color: t.primary, fontSize: 12, fontWeight: '600' }, error: { fontSize: 13, lineHeight: 19, color: t.error, marginBottom: 13 },
}); }
