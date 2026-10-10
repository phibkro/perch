/* Verify extracted content and preview policy without a model or network. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const project = path.resolve(__dirname, '../..');
// Place temporary output within the project so ESM marked resolves from node_modules.
const build = fs.mkdtempSync(path.join(project, '.artifact-test-'));
async function main() {
  try {
    execFileSync(process.execPath, [path.join(project, 'node_modules/typescript/bin/tsc'),
      'src/artifacts/model.ts', 'src/artifacts/html.ts', 'src/artifacts/read.ts', 'src/artifacts/diagram.ts', '--rootDir', 'src', '--outDir', build,
      '--module', 'commonjs', '--moduleResolution', 'node', '--target', 'es2022', '--lib', 'es2023,dom',
      '--esModuleInterop', '--skipLibCheck', '--strict'], { cwd: project, stdio: 'pipe' });
    const model = require(path.join(build, 'artifacts/model.js'));
    const html = require(path.join(build, 'artifacts/html.js'));
    const reader = require(path.join(build, 'artifacts/read.js'));
    const diagrams = require(path.join(build, 'artifacts/diagram.js'));
    assert.equal(html.permitsInlineInteraction('html-a', false, null), false);
    assert.equal(html.permitsInlineInteraction('html-a', false, 'html-a'), true);
    assert.equal(html.permitsInlineInteraction('html-b', false, 'html-a'), false, 'A new selection never inherits script permission, even before effects');
    assert.equal(html.permitsInlineInteraction('html-a', true, 'html-a'), false, 'Streaming content cannot run inline scripts');
    const fence = String.fromCharCode(96).repeat(3);
    const message = (text, streaming = false) => ({ id: 'a1', role: 'assistant', text, createdAt: 7, streaming });
    const source = '<main><h1>Ærlig HTML</h1></main>';
    const response = message('# A useful report\n\nA readable introduction.\n\n' + fence + 'html filename="preview.html"\n' + source + '\n' + fence);
    const artifacts = model.deriveArtifacts([response]);
    assert.equal(artifacts.length, 2);
    assert.equal(artifacts[0].kind, 'markdown');
    assert.equal(artifacts[0].sourceId, 'message:a1');
    assert.equal(artifacts[0].content, response.text);
    assert.equal(artifacts[1].kind, 'html');
    assert.equal(artifacts[1].sourceId, 'message:a1');
    assert.equal(artifacts[1].filename, 'preview.html');
    assert.equal(artifacts[1].content, source);
    const partial = model.deriveArtifacts([message(fence + 'ts filename="src/app.ts"\nconst a = ', true)])[0];
    const final = model.deriveArtifacts([message(fence + 'ts filename="src/app.ts"\nconst a = 1;\n' + fence)])[0];
    assert.equal(partial.id, final.id, 'Selection survives streaming completion');
    assert.equal(partial.streaming, true);
    assert.equal(final.streaming, false);
    assert.equal(final.filename, 'app.ts');
    assert.equal(final.language, 'typescript');
    assert.equal(model.deriveArtifacts([{ ...response, role: 'user' }]).length, 0);
    assert.equal(model.deriveArtifacts([message('Okay, understood.')]).length, 0);
    assert.equal(model.deriveArtifacts([message('~~~markdown title="notes.md"\n# Notes\n~~~')])[0].kind, 'markdown');
    const diagramText = 'flowchart TD\n  A[Perch] --> B[Tern]\n  B --> C[OMP]';
    const diagramArtifact = model.deriveArtifacts([message(fence + 'mmd filename="workspace.mmd"\n' + diagramText + '\n' + fence)])[0];
    assert.equal(diagramArtifact.language, 'mermaid');
    assert.equal(diagramArtifact.content, diagramText, 'A rendered diagram retains exact source for copy/export');
    assert.equal(diagrams.isMermaidLanguage(diagramArtifact.language), true);
    assert.equal(diagrams.isMermaidLanguage('javascript'), false);
    assert.equal(diagrams.diagramSourceProblem(' '.repeat(20)), 'This diagram is empty.');
    assert.equal(diagrams.diagramSourceProblem(diagramText), undefined);
    assert(diagrams.diagramSourceProblem('x'.repeat(diagrams.MAX_DIAGRAM_CHARACTERS + 1)));
    assert.equal(model.safeFilename('../../private/token.txt'), 'token.txt');
    assert.equal(model.safeFilename('C:\\private\\token.txt'), 'token.txt');
    assert.equal(model.safeFilename('...'), 'artifact.txt');
    assert.equal(model.safeFilename('..／private／token.txt'), 'token.txt', 'Normalize Unicode separators before extracting the export basename');
    const file = model.deriveArtifacts([], [{ id: 'write1', label: 'Write file', status: 'done',
      artifact: { filename: '/srv/report.md', content: '# Actual file content' } }])[0];
    assert.equal(file.kind, 'markdown');
    assert.equal(file.filename, 'report.md');
    assert.equal(file.content, '# Actual file content');
    assert.equal(model.deriveArtifacts([], [{ id: 'log1', label: 'Read output', status: 'done',
      output: fence + 'html filename="fragment.html"\n<main>Partial log excerpt</main>\n' + fence }]).length, 0,
      'Arbitrary tool logs do not become full-file artifacts');

    const reference = (changes = {}) => ({ id: 'artifact-1', sessionId: 'session-1', title: 'Saved report',
      filename: '/work/report.md', mimeType: 'text/markdown; charset=utf-8', language: 'markdown',
      sha256: 'a'.repeat(64), bytes: 127, createdAt: 42, sourceId: 'tool:write-1', ...changes });
    const saved = model.storedArtifactsToArtifacts([reference()])[0];
    assert.equal(saved.kind, 'markdown');
    assert.equal(saved.filename, 'report.md');
    assert.equal(saved.content, undefined, 'Unloaded bytes are not an empty generated file');
    assert.equal(saved.sourceId, 'tool:write-1');
    assert.equal(saved.stored.filename, '/work/report.md', 'The exact manifest reaches the driver; display/export use the safe basename');
    assert.equal(model.storedArtifactsToArtifacts([reference(), reference()]).length, 1);
    assert.equal(model.storedArtifactsToArtifacts([reference({ title: 'Renamed' })])[0].id, saved.id);
    assert.notEqual(model.storedArtifactsToArtifacts([reference({ sessionId: 'session-2' })])[0].id, saved.id);
    assert.notEqual(model.storedArtifactsToArtifacts([reference({ sha256: 'b'.repeat(64) })])[0].id, saved.id);
    const page = model.storedArtifactsToArtifacts([reference({ filename: '../../page.html', mimeType: 'TEXT/HTML', language: 'html' })])[0];
    assert.equal(page.kind, 'html');
    assert.equal(page.filename, 'page.html');
    const unknown = model.storedArtifactsToArtifacts([reference({ filename: 'page.html', mimeType: 'application/x-unknown', language: 'html' })])[0];
    assert.equal(unknown.kind, 'code', 'Unknown MIME never opts into an HTML reader by filename or language');
    assert.equal(unknown.language, 'text');
    assert.equal(model.storedArtifactsToArtifacts([reference({ mimeType: '__proto__', language: 'constructor' })])[0].language, 'text');
    assert.equal(model.storedArtifactsToArtifacts([reference({ mimeType: 'text/plain', filename: 'constructor', language: 'constructor' })])[0].language, 'text', 'Metadata cannot select inherited object properties as a language');
    const plain = model.storedArtifactsToArtifacts([reference({ filename: 'page.html', mimeType: 'text/plain', language: 'html' })])[0];
    assert.equal(plain.kind, 'code', 'Explicit plain text remains source even with HTML syntax');
    assert.equal(plain.language, 'html');
    const code = model.storedArtifactsToArtifacts([reference({ filename: 'src/main.tsx', mimeType: 'text/plain', language: '' })])[0];
    assert.equal(code.kind, 'code');
    assert.equal(code.language, 'tsx');
    assert.equal(model.storedArtifactsToArtifacts([reference({ filename: 'image.svg', mimeType: 'image/svg+xml' })])[0].kind, 'code');

    const flush = () => new Promise(resolve => setImmediate(resolve));
    const loads = [];
    const loader = async () => '# Verified saved bytes';
    assert.equal(reader.artifactReadState(saved, null, loader).status, 'loading');
    assert.equal(reader.artifactReadState({ ...saved, content: 'Unverified bytes' }, null, loader).status, 'loading', 'A manifest cannot smuggle inline content past the loader');
    assert.equal(reader.artifactReadState(saved, null).status, 'unavailable');
    reader.beginArtifactLoad(saved.stored, loader, value => loads.push(value));
    assert.equal(loads[0].status, 'loading');
    await flush();
    const ready = loads.at(-1);
    assert.equal(reader.artifactReadState(saved, ready, loader).artifact.content, '# Verified saved bytes');
    assert.equal(reader.artifactReadState(page, ready, loader).status, 'loading', 'Another manifest cannot reuse loaded bytes');
    assert.equal(reader.artifactReadState(saved, ready, async () => 'New connection').status, 'loading', 'A connection change hides old bytes before any effects run');
    assert.equal(reader.artifactReadState(saved, ready).status, 'unavailable', 'Disconnect immediately revokes readable remote content');
    const changedLength = model.storedArtifactsToArtifacts([reference({ bytes: 128 })])[0];
    assert.equal(reader.artifactReadState(changedLength, ready, loader).status, 'loading');
    assert.equal(reader.artifactReadState(file, ready, loader).artifact.content, file.content, 'Local files are independent of remote loads');

    const cancelledLoads = [];
    let resolveLate;
    const cancel = reader.beginArtifactLoad(saved.stored, () => new Promise(resolve => { resolveLate = resolve; }), value => cancelledLoads.push(value));
    await flush();
    cancel();
    resolveLate('<script>late old connection</script>');
    await flush();
    assert.deepEqual(cancelledLoads.map(value => value.status), ['loading'], 'Cancelled loads never publish a ready result');
    const failures = [];
    const failingLoader = async () => { throw new Error('Artifact checksum did not match.'); };
    reader.beginArtifactLoad(saved.stored, failingLoader, value => failures.push(value));
    await flush();
    assert.deepEqual(reader.artifactReadState(saved, failures.at(-1), failingLoader), { status: 'error', message: 'Artifact checksum did not match.' });
    const emptyLoads = [];
    const emptyLoader = async () => '';
    const empty = model.storedArtifactsToArtifacts([reference({ bytes: 0 })])[0];
    reader.beginArtifactLoad(empty.stored, emptyLoader, value => emptyLoads.push(value));
    await flush();
    assert.equal(reader.artifactReadState(empty, emptyLoads.at(-1), emptyLoader).artifact.content, '', 'A successfully loaded empty file differs from an unloaded reference');
    const payload = '</body><script>fetch("https://outside.invalid")</script><meta http-equiv="Content-Security-Policy" content="default-src *">';
    const document = html.buildHtmlPreview(payload, true);
    assert(document.indexOf('connect-src') < document.indexOf(payload), 'Policy precedes generated markup');
    assert(document.includes("connect-src 'none'"));
    assert(document.includes("form-action 'none'"));
    assert(document.includes("frame-src 'none'"));
    assert(document.includes("script-src 'unsafe-inline'"));
    assert(html.buildHtmlPreview(payload).includes("script-src 'none'"));
    const isolated = html.buildIsolatedHtmlPreview(payload + '" onload="bad()', true);
    assert(isolated.includes('sandbox="allow-scripts"'));
    assert(!isolated.includes('allow-same-origin'));
    assert(!isolated.includes(payload), 'Generated markup is encoded inside srcdoc');
    assert(isolated.includes('&lt;script&gt;'));
    assert.equal((isolated.match(/<iframe /g) || []).length, 1);
    assert(html.buildIsolatedHtmlPreview(payload).includes('sandbox=""'));
    assert.equal(html.permitsPreviewNavigation('https://outside.invalid'), false);
    assert.equal(html.permitsPreviewNavigation('file:///private/token'), false);
    assert.equal(html.permitsPreviewNavigation('javascript:alert(1)'), false);
    assert.equal(html.permitsPreviewNavigation(html.ARTIFACT_ORIGIN + '.evil.invalid'), false);
    assert.equal(html.permitsPreviewNavigation('about:blank'), true);
    assert.equal(html.permitsPreviewNavigation(html.ARTIFACT_ORIGIN + '/#section'), true);
    const diagramTheme = { scheme: 'dark', background: '#171719', surface: '#202024', ink: '#eeeeee', muted: '#aaaaaa', primary: '#cc9977', primarySoft: '#302822', line: '#39393f' };
    const nonce = 'PerchDiagramFixtureNonce123456';
    const scriptBoundary = '</script><script>globalThis.hostCompromised=true</script>\u2028\u2029';
    assert(!diagrams.diagramJson(scriptBoundary).includes('<'));
    assert.equal(JSON.parse(diagrams.diagramJson(scriptBoundary)), scriptBoundary, 'Embedding cannot change literal source characters');
    const diagramDocument = diagrams.buildDiagramDocument(scriptBoundary, diagramTheme, nonce, 'globalThis.mermaid={};');
    assert(!diagramDocument.includes(scriptBoundary));
    assert(diagramDocument.includes('sandbox="allow-scripts"'));
    assert(!diagramDocument.includes('allow-same-origin'));
    assert(diagramDocument.includes("script-src 'nonce-" + nonce + "'"));
    assert(!diagramDocument.includes("script-src 'unsafe-inline'"));
    assert(diagramDocument.includes("connect-src 'none'"));
    assert(diagramDocument.includes("worker-src 'none'"));
    assert.throws(() => diagrams.diagramCsp('bad\"nonce'));
    assert.throws(() => diagrams.buildDiagramDocument('x'.repeat(diagrams.MAX_DIAGRAM_CHARACTERS + 1), diagramTheme, nonce, ''));
    assert.throws(() => diagrams.buildDiagramDocument(diagramText, diagramTheme, nonce, '</script>'));
    console.log('PASS artifacts: extraction, stored MIME/identity mapping, lazy-read gating and cancellation, exact content, filename boundaries, isolated HTML/diagram policy and source serialization');
  } finally { fs.rmSync(build, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
