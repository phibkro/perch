import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { ArrowUpRight, Code2, FileText, PanelTop } from 'lucide-react-native';
import type { Theme } from '../ui/theme';
import type { Artifact } from './types';

export function ArtifactCard({ artifact, onPress, theme: t }: { artifact: Artifact; onPress: () => void; theme: Theme }) {
  const Icon = artifact.kind === 'html' ? PanelTop : artifact.kind === 'markdown' ? FileText : Code2;
  return <Pressable accessibilityRole="button" accessibilityLabel={'Open artifact ' + artifact.filename}
    testID={'artifact-card-' + artifact.id} onPress={onPress}
    style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, minHeight: 76,
      borderWidth: 1, borderColor: t.line, borderRadius: 16, backgroundColor: pressed ? t.primarySoft : t.surface })}>
    <View style={{ width: 42, height: 46, borderWidth: 1, borderColor: t.line, borderRadius: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: t.background }}><Icon color={t.primary} size={22} /></View>
    <View style={{ flex: 1, minWidth: 0, gap: 5 }}>
      <Text numberOfLines={1} style={{ color: t.ink, fontSize: 14, fontWeight: '600' }}>{artifact.title}</Text>
      <Text style={{ color: t.muted, fontSize: 11 }}>{artifact.streaming ? 'Updating · ' : artifact.stored ? 'Saved · ' : ''}{artifact.kind === 'html' ? 'HTML · Visual preview' : artifact.kind === 'markdown' ? 'Markdown · Document' : artifact.language + ' · Source code'}</Text>
    </View>
    <ArrowUpRight size={17} color={t.primary} />
  </Pressable>;
}
