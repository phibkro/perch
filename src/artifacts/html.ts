/**
 * The preview is an isolated document. Its CSP precedes all generated markup,
 * so a generated meta tag cannot loosen it. No app data or tokens are injected.
 */
export const ARTIFACT_ORIGIN = 'https://artifact.perch.invalid';

/** Opt-in belongs to one exact artifact, including the first render after selection. */
export function permitsInlineInteraction(artifactId: string, streaming: boolean, enabledArtifactId: string | null): boolean {
  return !streaming && enabledArtifactId === artifactId;
}

export function previewCsp(interactive: boolean): string {
  return [
    "default-src 'none'", "base-uri 'none'", "form-action 'none'",
    "connect-src 'none'", "frame-src 'none'", "child-src 'none'",
    "object-src 'none'", "worker-src 'none'",
    'img-src data: blob:', 'media-src data: blob:', 'font-src data:',
    "style-src 'unsafe-inline'", interactive ? "script-src 'unsafe-inline'" : "script-src 'none'",
  ].join('; ');
}

export function buildHtmlPreview(content: string, interactive = false, dark = false): string {
  const csp = previewCsp(interactive);
  return '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta http-equiv="Content-Security-Policy" content="' + csp + '">' +
    '<meta name="referrer" content="no-referrer">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<style>:root{color-scheme:' + (dark ? 'dark' : 'light') + '}' +
    'html{overflow-wrap:anywhere}body{margin:0;padding:16px;font-family:system-ui,sans-serif}' +
    'img,svg,video{max-width:100%;height:auto}pre{overflow:auto}*{box-sizing:border-box}</style>' +
    '</head><body>' + content + '</body></html>';
}

/**
 * A trusted outer document owns the frame policy. Untrusted content lives in a
 * second, opaque-origin srcdoc frame and cannot change that policy or its owner.
 * frame-src also constrains attempted remote navigation of that inner frame.
 * Inline styles and optional inline scripts work; remote dependencies do not.
 */
export function buildIsolatedHtmlPreview(content: string, interactive = false, dark = false): string {
  const inner = buildHtmlPreview(content, interactive, dark)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta http-equiv="Content-Security-Policy" content="' + previewCsp(interactive) + '">' +
    '<meta name="referrer" content="no-referrer">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<style>html,body{width:100%;height:100%;margin:0;overflow:hidden}' +
    'iframe{width:100%;height:100%;border:0;display:block}</style>' +
    '</head><body><iframe title="Generated HTML" sandbox="' + (interactive ? 'allow-scripts' : '') +
    '" referrerpolicy="no-referrer" srcdoc="' + inner + '"></iframe></body></html>';
}

/** Only the local source document may navigate; external links are inert. */
export function permitsPreviewNavigation(url: string): boolean {
  return url === 'about:blank' || url === ARTIFACT_ORIGIN || url === ARTIFACT_ORIGIN + '/' ||
    url.startsWith(ARTIFACT_ORIGIN + '/#') || url.startsWith('about:blank#');
}
