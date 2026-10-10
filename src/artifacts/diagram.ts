/** Mermaid is parsed by Mermaid itself, never by a second partial grammar. */
export const MAX_DIAGRAM_CHARACTERS = 20_000;
export const MAX_DIAGRAM_EDGES = 200;

export interface DiagramTheme {
  scheme: 'light' | 'dark'; background: string; surface: string; ink: string;
  muted: string; primary: string; primarySoft: string; line: string;
}

export function isMermaidLanguage(language: string): boolean {
  return /^(?:mermaid|mmd)$/i.test(language.trim());
}

export function diagramSourceProblem(source: string): string | undefined {
  if (!source.trim()) return 'This diagram is empty.';
  if (source.length > MAX_DIAGRAM_CHARACTERS) return 'This diagram is larger than the preview limit. Open Source to read it, or export the complete file.';
  return undefined;
}

/** Serialize data, not executable interpolation. A label cannot close its script. */
export function diagramJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

export function diagramCsp(nonce: string): string {
  if (!/^[a-zA-Z0-9_-]{16,80}$/.test(nonce)) throw new Error('Invalid diagram script nonce.');
  return [
    "default-src 'none'", "base-uri 'none'", "form-action 'none'", "connect-src 'none'",
    "frame-src 'none'", "child-src 'none'", "object-src 'none'", "worker-src 'none'",
    "img-src data:", "media-src 'none'", "font-src 'none'", "style-src 'unsafe-inline'",
    "script-src 'nonce-" + nonce + "'",
  ].join('; ');
}

/** The same policy is owned by both the outer document and the opaque child. */
export function buildDiagramDocument(source: string, theme: DiagramTheme, nonce: string, runtime: string): string {
  const problem = diagramSourceProblem(source);
  if (problem) throw new Error(problem);
  if (/<\/script/i.test(runtime)) throw new Error('Invalid diagram renderer bundle.');
  const csp = diagramCsp(nonce);
  const data = diagramJson({ source, theme, maxTextSize: MAX_DIAGRAM_CHARACTERS, maxEdges: MAX_DIAGRAM_EDGES });
  const boot = `
const input = ${data};
const status = document.getElementById('status');
const output = document.getElementById('output');
const controls = document.getElementById('controls');
let diagram = null, naturalWidth = 0, scale = 1;
function fail(message) {
  output.replaceChildren(); controls.hidden = true;
  status.hidden = false; status.dataset.state = 'error';
  status.textContent = 'Diagram could not be rendered. ' + message + ' Open Source to inspect the complete diagram.';
}
function size(next) {
  if (!diagram) return;
  scale = Math.max(0.15, Math.min(4, next));
  diagram.style.width = Math.round(naturalWidth * scale) + 'px';
  diagram.style.height = 'auto'; diagram.style.maxWidth = 'none';
  document.getElementById('zoom').textContent = Math.round(scale * 100) + '%';
}
function fit() { size(Math.min(1, (output.clientWidth - 32) / naturalWidth)); }
document.getElementById('minus').addEventListener('click', () => size(scale / 1.25));
document.getElementById('plus').addEventListener('click', () => size(scale * 1.25));
document.getElementById('fit').addEventListener('click', fit);
window.addEventListener('error', () => fail('The renderer stopped.'));
window.addEventListener('unhandledrejection', () => fail('The renderer stopped.'));
document.addEventListener('securitypolicyviolation', event => {
  // Ignored by the frame's policy. Surface the missing dependency to the reader.
  if (event.blockedURI && event.blockedURI !== 'inline') fail('This diagram requires a resource that the offline reader cannot load.');
});
(async () => {
  try {
    if (!globalThis.mermaid) throw new Error('The offline renderer is unavailable.');
    const t = input.theme;
    document.documentElement.style.colorScheme = t.scheme;
    document.body.style.background = t.surface;
    document.body.style.color = t.ink;
    controls.style.background = t.surface;
    controls.style.borderColor = t.line;
    mermaid.initialize({
      startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true,
      maxTextSize: input.maxTextSize, maxEdges: input.maxEdges,
      htmlLabels: false, fontFamily: 'system-ui, sans-serif',
      legacyMathML: false, forceLegacyMathML: false,
      deterministicIds: true, deterministicIDSeed: 'perch',
      theme: 'base', themeVariables: {
        darkMode: t.scheme === 'dark', background: t.surface,
        primaryColor: t.primarySoft, primaryTextColor: t.ink,
        primaryBorderColor: t.primary, secondaryColor: t.background,
        tertiaryColor: t.surface, lineColor: t.muted, textColor: t.ink,
        mainBkg: t.primarySoft, nodeBorder: t.primary,
        clusterBkg: t.background, clusterBorder: t.line,
        titleColor: t.ink, edgeLabelBackground: t.surface,
        actorBkg: t.primarySoft, actorTextColor: t.ink,
        actorBorder: t.primary, signalColor: t.ink, signalTextColor: t.ink,
        labelBoxBkgColor: t.background, labelBoxBorderColor: t.line,
        labelTextColor: t.ink, loopTextColor: t.ink, noteBkgColor: t.primarySoft,
        noteTextColor: t.ink, noteBorderColor: t.line,
      },
      secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges',
        'suppressErrorRendering', 'htmlLabels', 'fontFamily', 'legacyMathML',
        'forceLegacyMathML', 'theme', 'themeVariables', 'themeCSS',
        'deterministicIds', 'deterministicIDSeed'],
    });
    await mermaid.parse(input.source, { suppressErrors: false });
    const rendered = await mermaid.render('perch-diagram', input.source);
    const template = document.createElement('template');
    template.innerHTML = rendered.svg;
    const svg = template.content.querySelector('svg');
    if (!svg) throw new Error('The renderer returned no diagram.');
    // This is a read-only artifact. Do not bind Mermaid's click callbacks.
    for (const link of svg.querySelectorAll('a')) link.replaceWith(...link.childNodes);
    output.replaceChildren(svg); diagram = svg;
    naturalWidth = svg.viewBox.baseVal.width || svg.getBBox().width;
    if (!Number.isFinite(naturalWidth) || naturalWidth <= 0) throw new Error('The diagram has no visible content.');
    status.hidden = true; status.dataset.state = 'ready'; controls.hidden = false; fit();
  } catch (error) {
    fail(error instanceof Error ? error.message.slice(0, 1000) : 'Check the diagram syntax.');
  }
})();`;
  const inner = '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta http-equiv="Content-Security-Policy" content="' + csp + '">' +
    '<meta name="referrer" content="no-referrer">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<style>html,body{width:100%;height:100%;margin:0;font:14px system-ui,sans-serif;overflow:hidden}' +
    '*{box-sizing:border-box}[hidden]{display:none!important}body{display:flex;flex-direction:column}' +
    '#status{padding:24px;white-space:pre-wrap;overflow:auto;line-height:1.6}' +
    '#output{flex:1;min-height:0;overflow:auto;padding:16px}#output svg{display:block;margin:auto}' +
    '#controls{display:flex;gap:8px;align-items:center;flex-shrink:0;padding:8px 12px;border-bottom:1px solid}' +
    'button{min-width:44px;min-height:44px;padding:8px 12px;border:1px solid currentColor;border-radius:8px;background:transparent;color:inherit;font:inherit}' +
    '#zoom{min-width:44px;text-align:center;font-variant-numeric:tabular-nums}</style></head><body>' +
    '<div id="controls" hidden><button id="minus" aria-label="Zoom out">−</button><span id="zoom"></span>' +
    '<button id="plus" aria-label="Zoom in">+</button><button id="fit">Fit</button></div>' +
    '<div id="status" role="status" data-state="loading">Rendering diagram…</div><div id="output"></div>' +
    '<script nonce="' + nonce + '">' + runtime + '</script><script nonce="' + nonce + '">' + boot + '</script></body></html>';
  const escaped = inner.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta http-equiv="Content-Security-Policy" content="' + csp + '">' +
    '<meta name="referrer" content="no-referrer">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<style>html,body{width:100%;height:100%;margin:0;overflow:hidden}iframe{width:100%;height:100%;border:0;display:block}</style>' +
    '</head><body><iframe title="Mermaid diagram" sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="' + escaped + '"></iframe></body></html>';
}
