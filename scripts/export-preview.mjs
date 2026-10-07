#!/usr/bin/env node
/** Build a standalone HTML preview from the real Expo web export. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outputIndex = args.indexOf('--output');
if (outputIndex !== -1 && !args[outputIndex + 1]) throw new Error('--output needs a filename.');
const output = outputIndex === -1
  ? path.resolve(project, '../outputs/perch-prototype.html')
  : path.resolve(process.cwd(), args[outputIndex + 1]);
const dist = path.join(project, 'dist-web');
const notices = readFileSync(path.join(project, 'android/app/src/main/assets/third-party-notices.txt'), 'utf8');
if (!notices.includes('Permission is hereby granted')) throw new Error('Generate complete third-party notices before distributing the preview.');

if (!args.includes('--skip-export')) {
  // Expo may retain chunks from previous builds. This is our generated output
  // directory, so clear it before exporting rather than mixing module graphs.
  rmSync(dist, { recursive: true, force: true });
  const result = spawnSync(process.execPath, [
    path.join(project, 'node_modules/expo/bin/cli'), 'export', '--platform', 'web', '--output-dir', 'dist-web',
  ], { cwd: project, stdio: 'inherit', env: { ...process.env, CI: '1' } });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function walk(directory) {
  return readdirSync(directory).flatMap(name => {
    const filename = path.join(directory, name);
    return statSync(filename).isDirectory() ? walk(filename) : [filename];
  });
}

function localFile(url) {
  if (/^(?:[a-z][a-z\d+.-]*:)?\/\//i.test(url) || url.startsWith('data:')) {
    throw new Error(`The preview cannot depend on an external asset: ${url}`);
  }
  const filename = path.resolve(dist, decodeURIComponent(url.replace(/^\//, '').split(/[?#]/)[0]));
  if (!filename.startsWith(dist + path.sep) || !existsSync(filename)) throw new Error(`Missing exported asset: ${url}`);
  return filename;
}

const mimeTypes = {
  '.ico': 'image/x-icon', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.gif': 'image/gif', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
};

function dataUrl(filename) {
  return `data:${mimeTypes[path.extname(filename)] ?? 'application/octet-stream'};base64,${readFileSync(filename).toString('base64')}`;
}

let html = readFileSync(path.join(dist, 'index.html'), 'utf8');
const scriptTags = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>\s*<\/script>/gi)];
if (scriptTags.length < 1) throw new Error('No Expo entry scripts were found.');
// SDK 57 may split the runtime and common module definitions from the entry.
// Preserve the HTML's order: runtime, shared modules, application entry.
const initialPaths = scriptTags.map(tag => localFile(tag[1]));
if (new Set(initialPaths).size !== initialPaths.length) throw new Error('Duplicate initial scripts in Expo export.');
const entryPath = initialPaths[initialPaths.length - 1];
const beforeEntry = initialPaths.slice(0, -1).map(filename => readFileSync(filename, 'utf8'));
if (beforeEntry.some(source => /\n__r\(/.test(source))) throw new Error('An earlier Expo script has application startup. Inspect its ordering before inlining.');
let entry = readFileSync(entryPath, 'utf8');

// Expo's lazy imports first attempt Metro's already-registered module table.
// Register every referenced lazy chunk after the runtime but before app startup,
// keeping the real application/Collab modules and avoiding file:// chunk fetches.
const startup = entry.match(/\n((?:__r\(\d+\);\s*)+)$/);
if (!startup) throw new Error('Unrecognized Metro startup footer. Refusing to produce a partially working preview.');
entry = entry.slice(0, startup.index);
// Follow only the current entry's dependency graph. Even --skip-export must
// ignore leftover entries/chunks from an earlier ordinary Expo export.
const reachable = new Map();
function collectChunks(source) {
  for (const match of source.matchAll(/["'](\/?_expo\/static\/js\/web\/[^"'\s]+\.js)["']/g)) {
    const filename = localFile(match[1]);
    if (initialPaths.includes(filename) || reachable.has(filename)) continue;
    const chunk = readFileSync(filename, 'utf8');
    reachable.set(filename, chunk);
    collectChunks(chunk);
  }
}
for (const source of [...beforeEntry, entry]) collectChunks(source);
const chunks = [...reachable.keys()].sort();
for (const filename of chunks) {
  if (/\n__r\(/.test(readFileSync(filename, 'utf8'))) throw new Error(`Lazy chunk unexpectedly has its own startup: ${path.basename(filename)}`);
}
let bundle = [...beforeEntry, entry, ...chunks.map(filename => readFileSync(filename, 'utf8')), startup[1]].join('\n');
bundle = bundle.replace(/^\/\/# sourceMappingURL=.*$/gm, '');

// Direct local assets in JavaScript and CSS are replaced with data URLs. Current
// Perch uses SVG icon components/system fonts; its only emitted image is favicon.
const assets = walk(dist).filter(filename => mimeTypes[path.extname(filename)]);
for (const filename of assets) {
  const exportedUrl = '/' + path.relative(dist, filename).split(path.sep).join('/');
  const inlineUrl = dataUrl(filename);
  for (const quote of ['"', "'"]) bundle = bundle.split(quote + exportedUrl + quote).join(quote + inlineUrl + quote);
}
if (bundle.includes('perch-local-fixture') || bundle.includes('src/session/verify.cjs')) {
  throw new Error('Protocol verification tooling accidentally entered the app bundle.');
}

html = html.replace(/<link\b[^>]*\brel=["']icon["'][^>]*>/gi, tag => {
  const href = tag.match(/\bhref=["']([^"']+)["']/i)?.[1];
  return href ? tag.replace(href, dataUrl(localFile(href))) : tag;
});

const styles = [];
// Preload hints for now-inline resources must not trigger file-origin requests.
html = html.replace(/<link\b[^>]*\brel=["'](?:preload|modulepreload)["'][^>]*>/gi, tag => {
  const href = tag.match(/\bhref=["']([^"']+)["']/i)?.[1];
  if (href) localFile(href);
  return '';
});
html = html.replace(/<link\b[^>]*\brel=["']stylesheet["'][^>]*>/gi, tag => {
  const href = tag.match(/\bhref=["']([^"']+)["']/i)?.[1];
  if (!href) throw new Error('Stylesheet without href.');
  const filename = localFile(href);
  let css = readFileSync(filename, 'utf8');
  css = css.replace(/url\(\s*["']?([^)'"\s]+)["']?\s*\)/g, (original, url) => {
    if (url.startsWith('data:') || url.startsWith('#')) return original;
    const asset = url.startsWith('/') ? localFile(url) : path.resolve(path.dirname(filename), url);
    if (!asset.startsWith(dist + path.sep)) throw new Error('CSS asset escaped the export directory.');
    return `url("${dataUrl(asset)}")`;
  });
  if (/@import\s/i.test(css)) throw new Error('CSS @import requires explicit inlining.');
  styles.push(Buffer.from(css).toString('base64'));
  return '';
});

const payload = Buffer.from(bundle, 'utf8').toString('base64');
const metadata = {
  format: 'Perch standalone Expo preview', version: 2,
  appVersion: JSON.parse(readFileSync(path.join(project, 'package.json'), 'utf8')).version,
  source: 'Actual production Expo web export; no separate mockup',
  chunks: initialPaths.length + chunks.length,
  liveAdapterIncluded: chunks.some(filename => path.basename(filename).startsWith('collab-')),
  piAdapterIncluded: chunks.some(filename => path.basename(filename).startsWith('pi-')),
  bundleSha256: createHash('sha256').update(bundle).digest('hex'),
};

// Base64 keeps arbitrary exported JS away from HTML's script tokenizer. Decode
// to textContent only after parsing, so literal </script>, comments, and Unicode
// cannot truncate or corrupt the application. No eval or external script needed.
const bootstrap = `
<script id="perch-expo-code" type="application/octet-stream">${payload}</script>
<script>
(function () {
  const decode = function (value) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return new TextDecoder().decode(bytes);
  };
  globalThis.__PERCH_PREVIEW__ = Object.freeze(${JSON.stringify(metadata)});
  ${JSON.stringify(styles)}.forEach(function (value) {
    const style = document.createElement('style');
    style.textContent = decode(value);
    document.head.appendChild(style);
  });
  const payload = document.getElementById('perch-expo-code');
  const script = document.createElement('script');
  script.textContent = decode(payload.textContent) + '\\n//# sourceURL=perch-expo-preview.js';
  payload.remove();
  document.body.appendChild(script);
})();
</script>`;

for (let index = 0; index < scriptTags.length; index++) {
  html = html.replace(scriptTags[index][0], index === scriptTags.length - 1 ? bootstrap : '');
}
html = html.replace('<title>Perch</title>', '<title>Perch · interactive prototype</title>');
// Keep dependency notices inside the standalone file. Template text is inert;
// escape markup so upstream license text cannot alter the application document.
const escapedNotices = notices.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
html = html.replace('</head>', `<template id="perch-third-party-notices">${escapedNotices}</template>\n</head>`);
html = html.replace('</head>', '<meta name="description" content="Perch: a model and harness independent AI workspace built with native assistant-ui. Explore Markdown, HTML and code artifacts offline, or connect your own OMP session or Pi bridge."/>\n</head>');
if (/<(?:script|link)\b[^>]*(?:src|href)=["']\/(?!\/)/i.test(html)) throw new Error('The final HTML still refers to an external exported script or stylesheet.');
mkdirSync(path.dirname(output), { recursive: true });
writeFileSync(output, html);
console.log(`Standalone preview: ${output}`);
console.log(`${Buffer.byteLength(html).toLocaleString()} bytes · ${metadata.chunks} Expo chunks inlined · Collab adapter ${metadata.liveAdapterIncluded ? 'included' : 'not detected'}`);
