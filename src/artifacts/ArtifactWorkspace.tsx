import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, useWindowDimensions, View } from 'react-native';
import { ArrowLeft, Check, Code2, Copy, Download, Eye, Files, RotateCcw, WrapText } from 'lucide-react-native';
import * as Clipboard from 'expo-clipboard';
import type { Theme } from '../ui/theme';
import type { Artifact, ArtifactLoader } from './types';
import { artifactStats, MAX_RENDER_CHARACTERS } from './model';
import { ArtifactCard } from './ArtifactCard';
import { CodePreview } from './CodePreview';
import { MarkdownPreview } from './MarkdownPreview';
import { HtmlPreview } from './HtmlPreview';
import { exportArtifact } from './export';
import { permitsInlineInteraction } from './html';
import { artifactReadState, artifactReferenceKey, beginArtifactLoad, type ArtifactLoad } from './read';

type Props = {
  artifacts: readonly Artifact[]; selectedArtifactId?: string | null;
  onSelectArtifact?: (id: string) => void; onClose?: () => void; theme: Theme;
  /** Keep stable for one connection; changing it discards previously loaded bytes. */
  loadArtifact?: ArtifactLoader;
};

export function ArtifactWorkspace({ artifacts, selectedArtifactId, onSelectArtifact, onClose, loadArtifact, theme: t }: Props) {
  const [internalId, setInternalId] = useState<string | null>(null);
  const [view, setView] = useState<'preview' | 'source'>('preview');
  const [wrap, setWrap] = useState(false);
  const [interaction, setInteraction] = useState<{ id: string; referenceKey?: string; loader?: ArtifactLoader } | null>(null);
  const [revision, setRevision] = useState(0);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [load, setLoad] = useState<ArtifactLoad | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const actionEpoch = useRef(0);
  const { width } = useWindowDimensions();
  const selectedId = selectedArtifactId === undefined ? internalId : selectedArtifactId;
  const artifact = artifacts.find(item => item.id === selectedId);
  const referenceKey = artifact?.stored ? artifactReferenceKey(artifact.stored) : undefined;
  const read = artifact ? artifactReadState(artifact, load, loadArtifact) : undefined;
  const readable = read?.status === 'ready' ? read.artifact : undefined;
  const interactive = !!readable && interaction?.referenceKey === referenceKey && interaction?.loader === loadArtifact
    && permitsInlineInteraction(readable.id, readable.streaming, interaction?.id || null);
  const wide = width >= 1000;
  useEffect(() => {
    actionEpoch.current += 1;
    setView('preview'); setInteraction(null); setNotice(''); setRevision(0); setBusy(false);
  }, [selectedId, referenceKey, loadArtifact]);
  useEffect(() => () => { actionEpoch.current += 1; }, []);
  useEffect(() => {
    if (!artifact?.stored || !loadArtifact) { setLoad(null); return; }
    return beginArtifactLoad(artifact.stored, loadArtifact, setLoad);
    // Snapshot polling may return a new object for the same immutable reference.
    // Its scalar key, rather than object identity, controls the load lifetime.
  }, [referenceKey, loadArtifact, loadAttempt]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 5000);
    return () => clearTimeout(timer);
  }, [notice]);
  const select = (id: string) => { setInternalId(id); onSelectArtifact?.(id); };
  const back = () => { setInternalId(null); onClose?.(); };
  const run = async (action: () => Promise<string>) => {
    if (busy) return;
    const epoch = actionEpoch.current;
    setBusy(true);
    try { const message = await action(); if (epoch === actionEpoch.current) setNotice(message); }
    catch (error) { if (epoch === actionEpoch.current) setNotice(error instanceof Error ? error.message : 'This action could not finish.'); }
    finally { if (epoch === actionEpoch.current) setBusy(false); }
  };

  const list = <View style={{ flex: 1, minHeight: 0 }}>
    <View style={{ padding: 24, paddingBottom: 16, gap: 8 }}>
      <Text style={{ color: t.subtle, fontSize: 10, fontWeight: '700', letterSpacing: 1.8 }}>YOUR WORK, UNFOLDED</Text>
      <Text accessibilityRole="header" style={{ color: t.ink, fontSize: 29, fontWeight: '600' }}>Artifacts</Text>
      <Text style={{ color: t.muted, fontSize: 14, lineHeight: 22 }}>Documents, pages, and code from this conversation.</Text>
    </View>
    {artifacts.length ? <ScrollView contentContainerStyle={{ padding: 20, paddingTop: 4, gap: 12, paddingBottom: 40 }}>
      {artifacts.map(item => <View key={item.id} style={item.id === artifact?.id ? { borderWidth: 2, borderColor: t.primary, borderRadius: 18 } : undefined}>
        <ArtifactCard artifact={item} theme={t} onPress={() => select(item.id)} />
      </View>)}
    </ScrollView> : <View style={{ flex: 1, padding: 32, alignItems: 'center', justifyContent: 'center', gap: 15 }}>
      <View style={{ borderRadius: 22, padding: 24, backgroundColor: t.primarySoft }}><Files size={36} color={t.primary} /></View>
      <Text style={{ color: t.ink, fontSize: 21, fontWeight: '600', textAlign: 'center' }}>Give good work some room.</Text>
      <Text style={{ color: t.muted, lineHeight: 23, textAlign: 'center', maxWidth: 340 }}>Ask your assistant for a report, an HTML page, or a piece of code. Its artifacts will appear here.</Text>
    </View>}
  </View>;

  if (!artifact) return <View testID="artifact-workspace" style={{ flex: 1, minHeight: 0, backgroundColor: t.background }}>{list}</View>;
  const source = view === 'source' || artifact.kind === 'code';
  const stats = readable ? artifactStats(readable.content) : undefined;
  const actionsDisabled = busy || !readable;
  const buttonStyle = { minHeight: 44, minWidth: 44, paddingHorizontal: 12, flexDirection: 'row' as const, alignItems: 'center' as const, justifyContent: 'center' as const, gap: 7, borderRadius: 10 };
  return <View testID="artifact-workspace" style={{ flex: 1, minHeight: 0, flexDirection: 'row', backgroundColor: t.background }}>
    {wide && <View style={{ width: 310, borderRightWidth: 1, borderRightColor: t.line }}>{list}</View>}
    <View style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
      <View style={{ paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 1, borderColor: t.line, backgroundColor: t.surface }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Pressable accessibilityRole="button" accessibilityLabel="Back to artifacts" onPress={back} style={buttonStyle}><ArrowLeft size={20} color={t.ink} /></Pressable>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text numberOfLines={1} style={{ color: t.ink, fontSize: 16, fontWeight: '600' }}>{artifact.filename}</Text>
            <Text style={{ color: t.muted, fontSize: 11, marginTop: 4 }}>{artifact.streaming ? 'Updating · ' : ''}{stats
              ? stats.lines.toLocaleString() + ' lines · ' + stats.characters.toLocaleString() + ' characters'
              : (artifact.stored?.bytes.toLocaleString() || '0') + ' bytes · Saved on host'}</Text>
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel="Copy artifact" accessibilityState={{ disabled: actionsDisabled }} disabled={actionsDisabled} style={[buttonStyle, { opacity: actionsDisabled ? 0.4 : 1 }]}
            onPress={() => { if (readable) void run(async () => { await Clipboard.setStringAsync(readable.content); return 'Complete file copied.'; }); }}><Copy size={18} color={t.primary} /></Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="Export artifact" accessibilityState={{ disabled: actionsDisabled }} disabled={actionsDisabled} style={[buttonStyle, { opacity: actionsDisabled ? 0.4 : 1 }]}
            onPress={() => { if (readable) void run(() => exportArtifact(readable)); }}><Download size={18} color={t.primary} /></Pressable>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7, paddingTop: 8 }}>
          {artifact.kind !== 'code' && (['preview', 'source'] as const).map(option => <Pressable key={option} accessibilityRole="tab"
            accessibilityState={{ selected: view === option, disabled: !readable }} accessibilityLabel={option === 'preview' ? 'Artifact preview' : 'Artifact source'}
            disabled={!readable} onPress={() => setView(option)} style={[buttonStyle, { backgroundColor: view === option ? t.primarySoft : 'transparent', opacity: readable ? 1 : 0.5 }]}>
            {option === 'preview' ? <Eye size={15} color={view === option ? t.primary : t.muted} /> : <Code2 size={15} color={view === option ? t.primary : t.muted} />}
            <Text style={{ color: view === option ? t.primary : t.muted, fontSize: 12, fontWeight: '600' }}>{option === 'preview' ? 'Preview' : 'Source'}</Text>
          </Pressable>)}
          {artifact.kind === 'code' && <Text style={{ color: t.muted, paddingHorizontal: 12, fontSize: 12 }}>{artifact.language}</Text>}
          <View style={{ flex: 1 }} />
          {source && !!readable && <Pressable accessibilityRole="button" accessibilityLabel="Toggle line wrapping" accessibilityState={{ selected: wrap }}
            style={[buttonStyle, { backgroundColor: wrap ? t.primarySoft : 'transparent' }]} onPress={() => setWrap(!wrap)}><WrapText size={17} color={wrap ? t.primary : t.muted} /></Pressable>}
          {!source && !!readable && artifact.kind === 'html' && <Pressable accessibilityRole="button" accessibilityLabel="Reload HTML preview" style={buttonStyle}
            onPress={() => setRevision(value => value + 1)}><RotateCcw size={16} color={t.muted} /></Pressable>}
        </View>
      </View>
      {!!notice && <View accessibilityLiveRegion="polite" style={{ flexDirection: 'row', gap: 8, alignItems: 'center', padding: 12, backgroundColor: t.primarySoft }}>
        <Check size={14} color={t.primary} /><Text style={{ color: t.primary, fontSize: 12, flex: 1 }}>{notice}</Text>
      </View>}
      {!source && !!readable && artifact.kind === 'html' && <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 18, paddingVertical: 8, borderBottomWidth: 1, borderColor: t.line }}>
        <Text style={{ flex: 1, color: t.muted, fontSize: 11, lineHeight: 17 }}>{artifact.streaming ? 'The page is updating. Interaction is available when it finishes.' : interactive ? 'Inline interactions enabled. External dependencies stay blocked.' : 'Visual preview. Enable interaction for buttons and inline scripts.'}</Text>
        <Pressable accessibilityRole="switch" accessibilityLabel="HTML interaction" accessibilityState={{ checked: interactive && !artifact.streaming, disabled: artifact.streaming }}
          disabled={artifact.streaming} onPress={() => setInteraction(interactive ? null : { id: artifact.id, referenceKey, loader: loadArtifact })} style={[buttonStyle, { backgroundColor: interactive && !artifact.streaming ? t.primarySoft : t.surfaceAlt, opacity: artifact.streaming ? 0.5 : 1 }]}>
          <Text style={{ color: interactive && !artifact.streaming ? t.primary : t.muted, fontSize: 12, fontWeight: '600' }}>{interactive && !artifact.streaming ? 'Enabled' : 'Enable'}</Text>
        </Pressable>
      </View>}
      <View style={{ flex: 1, minHeight: 0 }}>
        {!readable ? <View testID="artifact-load-state" accessibilityLiveRegion="polite" style={{ flex: 1, padding: 30, alignItems: 'center', justifyContent: 'center', gap: 16 }}>
          {read?.status === 'loading' && <ActivityIndicator color={t.primary} size="large" />}
          <Text style={{ color: t.ink, fontSize: 20, fontWeight: '600', textAlign: 'center' }}>{read?.status === 'loading' ? 'Opening saved artifact…' : read?.status === 'error' ? 'Could not open this artifact' : 'Connect to open this artifact'}</Text>
          <Text style={{ color: t.muted, lineHeight: 22, textAlign: 'center', maxWidth: 400 }}>{read?.status === 'error' ? read.message : read?.status === 'loading' ? 'Fetching the complete file from your host.' : 'This file is saved on your host. Reconnect to read, copy, or export it.'}</Text>
          {read?.status === 'error' && <Pressable testID="artifact-load-retry" accessibilityRole="button" accessibilityLabel="Retry loading artifact"
            onPress={() => { setInteraction(null); setLoadAttempt(value => value + 1); }} style={[buttonStyle, { backgroundColor: t.primarySoft }]}>
            <RotateCcw size={16} color={t.primary} /><Text style={{ color: t.primary, fontWeight: '600' }}>Try again</Text>
          </Pressable>}
        </View>
          : source ? <CodePreview key={artifact.id} content={readable.content} language={artifact.language} theme={t} wrap={wrap} />
          : artifact.kind === 'markdown' ? <MarkdownPreview key={artifact.id} content={readable.content} theme={t} />
          : readable.content.length > MAX_RENDER_CHARACTERS
            ? <View style={{ padding: 30, gap: 12 }}><Text style={{ color: t.ink, fontSize: 20, fontWeight: '600' }}>This page is larger than the preview limit.</Text><Text style={{ color: t.muted, lineHeight: 22 }}>Open Source to inspect it, or export the complete HTML file.</Text></View>
            : <HtmlPreview key={artifact.id + ':' + revision} content={readable.content} interactive={interactive && !artifact.streaming} dark={t.background === '#17221D'} />}
      </View>
    </View>
  </View>;
}
