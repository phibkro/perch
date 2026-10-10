import React, { useMemo, useState } from 'react';
import { Image, Linking, Pressable, Text, View, type ImageStyle, type TextStyle } from 'react-native';
import Markdown, { Renderer } from 'react-native-marked';
import type { Theme } from '../ui/theme';
import { CodePreview } from './CodePreview';
import { DiagramPreview } from './DiagramPreview';
import { isMermaidLanguage } from './diagram';
import { MAX_RENDER_CHARACTERS } from './model';

function externalUrl(value: string) {
  try { const url = new URL(value); return ['https:', 'http:', 'mailto:'].includes(url.protocol) ? value : null; }
  catch { return null; }
}

function DocumentImage({ uri, alt, theme: t }: { uri: string; alt?: string; theme: Theme }) {
  const embedded = /^data:image\/(?:png|jpe?g|gif|webp);base64,/i.test(uri);
  const [loaded, setLoaded] = useState(embedded);
  const [error, setError] = useState(false);
  if (loaded && !error) return <Image source={{ uri }} accessibilityLabel={alt || 'Document image'}
    style={{ width: '100%', height: 220, resizeMode: 'contain', marginVertical: 12 }} onError={() => setError(true)} />;
  const canLoad = /^https?:\/\//i.test(uri);
  return <Pressable accessibilityRole="button" accessibilityLabel="Load document image" disabled={!canLoad || error}
    onPress={() => setLoaded(true)} style={{ borderWidth: 1, borderColor: t.line, borderRadius: 12, padding: 16, marginVertical: 10, gap: 5 }}>
    <Text style={{ color: t.ink, fontWeight: '600' }}>{alt || 'Document image'}</Text>
    <Text style={{ color: t.muted, fontSize: 12 }}>{error ? 'The image could not be loaded.' : canLoad ? 'Tap to load this external image.' : 'Image source is unavailable in this document.'}</Text>
  </Pressable>;
}

class DocumentRenderer extends Renderer {
  constructor(private readonly theme: Theme) { super({ selectable: true }); }
  code(text: string, language?: string) {
    const format = (language || 'text').split(/\s+/)[0];
    return <View key={this.getKey()} style={{ marginVertical: 10 }}>{isMermaidLanguage(format)
      ? <DiagramPreview content={text} theme={this.theme} compact />
      : <CodePreview content={text} language={format} theme={this.theme} compact />}</View>;
  }
  image(uri: string, alt?: string, _style?: ImageStyle, title?: string) {
    return <DocumentImage key={this.getKey()} uri={uri} alt={alt || title} theme={this.theme} />;
  }
  link(children: string | React.ReactNode[], href: string, styles?: TextStyle, title?: string) {
    const url = externalUrl(href);
    return <Text key={this.getKey()} selectable accessibilityRole={url ? 'link' : undefined}
      accessibilityLabel={title} style={styles} onPress={url ? () => { void Linking.openURL(url).catch(() => {}); } : undefined}>{children}</Text>;
  }
  linkImage(_href: string, uri: string, alt?: string, style?: ImageStyle, title?: string) {
    return this.image(uri, alt, style, title);
  }
}

/** A native document reader with virtualized Markdown blocks and selectable text. */
export function MarkdownPreview({ content, theme: t }: { content: string; theme: Theme }) {
  const renderer = useMemo(() => new DocumentRenderer(t), [t]);
  return <View style={{ flex: 1, minHeight: 0, backgroundColor: t.surface }}>
    {content.length > MAX_RENDER_CHARACTERS && <Text style={{ color: t.muted, padding: 14, fontSize: 12 }}>
      This is a preview of a large document. Copy and export include its complete content.
    </Text>}
    <Markdown value={content.slice(0, MAX_RENDER_CHARACTERS)} renderer={renderer}
      theme={{ colors: { text: t.ink, link: t.primary, code: t.surfaceAlt, border: t.line } }}
      styles={{
        text: { fontSize: 16, lineHeight: 27 }, strong: { fontSize: 16, lineHeight: 27 },
        paragraph: { paddingVertical: 8 }, h1: { fontSize: 30, lineHeight: 38, fontWeight: '700', borderBottomWidth: 0, marginBottom: 14 },
        h2: { fontSize: 23, lineHeight: 31, fontWeight: '600', borderBottomWidth: 0, marginTop: 24 },
        h3: { fontSize: 19, lineHeight: 27, fontWeight: '600', marginTop: 20 },
        blockquote: { backgroundColor: t.primarySoft, borderLeftWidth: 3, borderRadius: 4, paddingVertical: 6, opacity: 1 },
        codespan: { color: t.primary, backgroundColor: t.surfaceAlt, fontStyle: 'normal', fontWeight: '500' },
        table: { borderColor: t.line }, tableCell: { padding: 12 }, hr: { marginVertical: 20 },
      }}
      flatListProps={{
        testID: 'artifact-markdown', style: { flex: 1, backgroundColor: t.surface },
        contentContainerStyle: { padding: 24, paddingBottom: 60, width: '100%', maxWidth: 820, alignSelf: 'center' },
        keyboardShouldPersistTaps: 'handled',
      }} />
  </View>;
}
