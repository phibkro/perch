import React, { useMemo } from 'react';
import { buildIsolatedHtmlPreview } from './html';
import type { HtmlPreviewProps } from './HtmlPreview';

export function HtmlPreview({ content, interactive, dark }: HtmlPreviewProps) {
  const html = useMemo(() => buildIsolatedHtmlPreview(content, interactive, dark), [content, interactive, dark]);
  return <iframe key={String(interactive)} title="HTML artifact preview" data-testid="artifact-html"
    srcDoc={html} sandbox={interactive ? 'allow-scripts' : ''} referrerPolicy="no-referrer"
    allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'"
    style={{ flex: 1, display: 'block', width: '100%', minHeight: 280, border: 0, background: dark ? '#18221D' : '#FFFFFF' }} />;
}
