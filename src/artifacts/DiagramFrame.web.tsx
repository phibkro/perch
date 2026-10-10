import React from 'react';
import type { DiagramFrameProps } from './DiagramFrame';

export function DiagramFrame({ html }: DiagramFrameProps) {
  return <iframe title="Mermaid diagram preview" data-testid="artifact-diagram" srcDoc={html}
    sandbox="allow-scripts" referrerPolicy="no-referrer"
    allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'"
    style={{ flex: 1, display: 'block', width: '100%', height: '100%', border: 0 }} />;
}
