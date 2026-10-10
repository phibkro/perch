import React, { useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Code2, Workflow } from 'lucide-react-native';
import { randomUUID } from 'expo-crypto';
import type { Theme } from '../ui/theme';
import { CodePreview } from './CodePreview';
import { DiagramFrame } from './DiagramFrame';
import { buildDiagramDocument, diagramSourceProblem } from './diagram';
import runtime from './generated/mermaid-runtime.json';

type Props = { content: string; theme: Theme; compact?: boolean; streaming?: boolean; };

/** Embedded diagrams open on demand; changing source discards the opened frame. */
export function DiagramPreview({ content, theme: t, compact = false, streaming = false }: Props) {
  const [openedSource, setOpenedSource] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);
  const active = compact ? openedSource === content && !showSource : !streaming;
  const problem = diagramSourceProblem(content);
  const preview = useMemo(() => {
    if (!active || problem) return { html: '', error: undefined };
    try { return { html: buildDiagramDocument(content, t, randomUUID().replace(/-/g, ''), runtime.script), error: undefined }; }
    catch { return { html: '', error: 'The diagram reader could not start. Open Source to read or export the complete diagram.' }; }
  }, [active, problem, content, t]);
  const buttonStyle = { minHeight: 44, paddingHorizontal: 14, flexDirection: 'row' as const, alignItems: 'center' as const, gap: 8, borderRadius: 8 };
  return <View style={compact ? { borderWidth: 1, borderColor: t.line, borderRadius: 12, overflow: 'hidden', backgroundColor: t.surface } : { flex: 1, minHeight: 0, backgroundColor: t.surface }}>
    {compact && <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, padding: 8, borderBottomWidth: 1, borderColor: t.line }}>
      <Workflow size={17} color={t.primary} /><Text style={{ color: t.ink, flex: 1, fontWeight: '600', fontSize: 13 }}>Diagram</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={active ? 'Show diagram source' : 'Render diagram'}
        disabled={!!problem && !active} onPress={() => { if (active) setShowSource(true); else { setOpenedSource(content); setShowSource(false); } }}
        style={[buttonStyle, { backgroundColor: t.primarySoft, opacity: problem ? 0.5 : 1 }]}>
        {active ? <Code2 size={15} color={t.primary} /> : <Workflow size={15} color={t.primary} />}
        <Text style={{ color: t.primary, fontSize: 12, fontWeight: '600' }}>{active ? 'Source' : 'Render'}</Text>
      </Pressable>
    </View>}
    {!!(problem || preview.error) && <Text accessibilityRole="alert" style={{ color: t.muted, padding: 18, lineHeight: 21 }}>{problem || preview.error}</Text>}
    {active && !problem && !preview.error ? <View style={compact ? { height: 400 } : { flex: 1, minHeight: 280 }}><DiagramFrame html={preview.html} /></View>
      : compact ? <CodePreview content={content} language="mermaid" theme={t} compact />
      : !problem && !preview.error && <View style={{ padding: 24, gap: 12 }}><Workflow size={26} color={t.primary} />
        <Text style={{ color: t.ink, fontSize: 17, fontWeight: '600' }}>The diagram is updating.</Text>
        <Text style={{ color: t.muted, lineHeight: 22 }}>Preview opens when it finishes. Source contains the current diagram.</Text>
      </View>}
  </View>;
}
