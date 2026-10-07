import React, { useMemo } from 'react';
import { Platform, ScrollView, Text, View } from 'react-native';
import { common, createLowlight } from 'lowlight';
import type { Element, RootContent } from 'hast';
import type { Theme } from '../ui/theme';
import { MAX_HIGHLIGHT_CHARACTERS, MAX_RENDER_CHARACTERS } from './model';

const highlighter = createLowlight(common);
const aliases: Record<string, string> = { tsx: 'typescript', jsx: 'javascript', svg: 'xml', html: 'xml', mdx: 'markdown' };
const fontFamily = Platform.OS === 'ios' ? 'Menlo' : 'monospace';
const tokenColors: Record<string, string> = {
  keyword: '#DDB4ED', built_in: '#DDB4ED', literal: '#E8B383', number: '#E8B383',
  string: '#BFD990', regexp: '#BFD990', title: '#A7D7E9', function: '#A7D7E9',
  attr: '#D5DE9A', attribute: '#D5DE9A', name: '#A9D3A9', tag: '#A9D3A9',
  comment: '#94A494', quote: '#94A494', meta: '#C3C59B', variable: '#E5C58F',
  deletion: '#FFB4A8', addition: '#BFD990', section: '#A7D7E9',
};

function tokenStyle(node: Element) {
  const classes = Array.isArray(node.properties.className) ? node.properties.className : [];
  const token = classes.map(value => String(value).replace(/^hljs-/, '')).find(value => tokenColors[value]);
  return token ? { color: tokenColors[token] } : undefined;
}

function renderTokens(nodes: RootContent[], key = ''): React.ReactNode[] {
  return nodes.map((node, i) => node.type === 'text' ? node.value
    : node.type === 'element' ? <Text key={key + i} style={tokenStyle(node)}>{renderTokens(node.children, key + i + '.')}</Text>
    : null);
}

/** Syntax tokens become native Text spans; code is never executed. */
export function CodePreview({ content, language, theme: t, wrap = false, compact = false }: {
  content: string; language: string; theme: Theme; wrap?: boolean; compact?: boolean;
}) {
  const visible = content.slice(0, MAX_RENDER_CHARACTERS);
  const highlighted = useMemo(() => {
    const lang = aliases[language] || language;
    if (visible.length > MAX_HIGHLIGHT_CHARACTERS || !highlighter.registered(lang)) return visible;
    try { return renderTokens(highlighter.highlight(lang, visible).children); }
    catch { return visible; }
  }, [visible, language]);
  const code = <Text selectable accessibilityLabel={'Source code, ' + language}
    style={{ color: t.codeInk, fontFamily, fontSize: compact ? 12 : 13, lineHeight: compact ? 20 : 22, flexShrink: wrap ? 1 : 0 }}>
    {highlighted}
  </Text>;
  return <View style={{ flex: compact ? undefined : 1, minHeight: 0, backgroundColor: t.code, borderRadius: compact ? 12 : 0, overflow: 'hidden' }}>
    {content.length > MAX_RENDER_CHARACTERS && <Text style={{ color: t.codeInk, padding: 12, fontSize: 12 }}>
      Showing the first {MAX_RENDER_CHARACTERS.toLocaleString()} characters. Copy and export include the complete file.
    </Text>}
    {visible.length > MAX_HIGHLIGHT_CHARACTERS && <Text style={{ color: t.codeInk, opacity: 0.7, paddingHorizontal: 16, paddingTop: 12, fontSize: 11 }}>
      Highlighting is paused for this large file.
    </Text>}
    {compact
      ? <ScrollView horizontal={!wrap} nestedScrollEnabled contentContainerStyle={{ padding: 16, minWidth: '100%' }}>{code}</ScrollView>
      : <ScrollView nestedScrollEnabled style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1 }}>
        {wrap ? <View style={{ padding: 20 }}>{code}</View>
          : <ScrollView horizontal nestedScrollEnabled contentContainerStyle={{ padding: 20, minWidth: '100%' }}>{code}</ScrollView>}
      </ScrollView>}
  </View>;
}
