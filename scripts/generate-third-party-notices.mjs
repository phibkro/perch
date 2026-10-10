import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// This is a conservative notice inventory for Bun's locked production package
// graph, not a claim that every transitive build/web package enters the APK.
// Keep the generated header independent of Perch's own release version.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destination = path.join(root, 'android/app/src/main/assets/third-party-notices.txt');
const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--check')) throw new Error('Usage: bun scripts/generate-third-party-notices.mjs [--check]');
const check = args.includes('--check');
const json = (file) => JSON.parse(readFileSync(file, 'utf8'));
if (typeof Bun === 'undefined' || !Bun.JSONC?.parse || !Bun.semver?.satisfies) {
  throw new Error('Run this helper with the project-pinned Bun: bun scripts/generate-third-party-notices.mjs [--check]');
}
const lock = Bun.JSONC.parse(readFileSync(path.join(root, 'bun.lock'), 'utf8'));
const snapshots = json(path.join(root, 'scripts/third-party-license-supplements.json')).licenses;
const knownLicenses = new Set([
  'MIT', 'BSD-3-Clause', '(MIT OR CC0-1.0)', 'ISC', '0BSD', 'Apache-2.0',
  'BlueOak-1.0.0', '(BSD-3-Clause OR GPL-2.0)', 'Python-2.0',
  '(MIT OR Apache-2.0)', 'Unlicense', 'CC-BY-4.0', 'MPL-2.0', 'BSD-2-Clause', 'CC0-1.0',
  // Mermaid 12.1.0: DOMPurify publishes both complete license alternatives;
  // elkjs publishes EPL-2.0. Preserve their full texts and source links below.
  '(MPL-2.0 OR Apache-2.0)', 'EPL-2.0',
]);
const clean = (text) => text.replace(/\r\n?/g, '\n').trim();
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const error = (message) => { throw new Error(message); };
if (lock.lockfileVersion !== 2 || !lock.packages || !lock.workspaces?.['']) error('Unsupported or unresolved bun.lock format; regenerate with the project-pinned Bun.');

// Fail on damaged or edited upstream snapshots instead of silently emitting a
// license that differs from the recorded Git blob.
for (const [name, entry] of Object.entries(snapshots)) {
  const text = Buffer.from(entry.text, 'utf8');
  const sha = createHash('sha1').update(`blob ${text.length}\0`).update(text).digest('hex');
  if (sha !== entry.gitBlobSha) error(`License supplement checksum differs: ${name}`);
}

function snapshot(name) {
  const entry = snapshots[name];
  if (!entry) error(`Unresolved license supplement: ${name}`);
  return {
    source: `${entry.source}\nUpstream license Git blob: ${entry.gitBlobSha}`,
    text: clean(entry.text),
  };
}

function installedLicense(packageName, expectedVersion, file = 'LICENSE') {
  const directory = path.join(root, 'node_modules', packageName);
  const manifest = json(path.join(directory, 'package.json'));
  if (manifest.version !== expectedVersion || manifest.license !== 'MIT') {
    error(`Shared license mapping needs review: ${packageName}@${manifest.version}`);
  }
  return { source: `${packageName}@${expectedVersion}/${file} (shared upstream license)`, text: clean(readFileSync(path.join(directory, file), 'utf8')) };
}

const reactNativeNames = new Set([
  '@react-native/assets-registry', '@react-native/babel-plugin-codegen',
  '@react-native/babel-preset', '@react-native/codegen', '@react-native/community-cli-plugin',
  '@react-native/debugger-shell', '@react-native/dev-middleware', '@react-native/gradle-plugin',
  '@react-native/js-polyfills', '@react-native/metro-babel-transformer', '@react-native/metro-config',
  '@react-native/normalize-colors', '@react-native/virtualized-lists',
]);
const metroNames = new Set([
  'metro', 'metro-babel-transformer', 'metro-cache', 'metro-cache-key', 'metro-config',
  'metro-core', 'metro-file-map', 'metro-minify-terser', 'metro-resolver', 'metro-runtime',
  'metro-source-map', 'metro-symbolicate', 'metro-transform-plugins', 'metro-transform-worker', 'ob1',
]);
const explicitSnapshots = {
  'react-remove-scroll-bar@2.3.8': ['react-remove-scroll-bar'],
  '@jsamr/counter-style@2.0.2': ['react-native-li'],
  '@jsamr/react-native-li@2.3.1': ['react-native-li'],
  'svg-parser@2.1.0': ['svg-parser'],
  'boolbase@1.0.0': ['boolbase'],
  'tr46@0.0.3': ['tr46'],
  'jimp-compact@0.16.1': ['jimp'],
  'fb-dotslash@0.5.8': ['facebook-mit', 'facebook-apache'],
  'hermes-compiler@250829098.0.17': ['hermes'],
  // fb-watchman's published manifest still says Apache-2.0, while its source
  // header says MIT. Preserve both texts and the source attribution below.
  'fb-watchman@2.0.2': ['watchman-mit', 'facebook-apache'],
  'bser@2.1.1': ['facebook-apache'],
};

function supplementalNotices(manifest, directory) {
  const key = `${manifest.name}@${manifest.version}`;
  if (explicitSnapshots[key]) return explicitSnapshots[key].map(snapshot);
  if ((reactNativeNames.has(manifest.name) && manifest.version === '0.86.3') || key === '@react-native/normalize-colors@0.74.89') {
    return [installedLicense('react-native', '0.86.3')];
  }
  if (metroNames.has(manifest.name) && manifest.version === '0.84.5') {
    return [snapshot('metro')];
  }
  if (['@expo/ui@57.0.21', 'expo-updates@57.0.24', 'expo-structured-headers@57.0.1'].includes(key)) {
    return [installedLicense('expo', '57.0.26')];
  }
  if (['babel-plugin-react-compiler@1.0.0', 'react-devtools-core@6.1.5'].includes(key)) {
    return [installedLicense('react', '19.2.3')];
  }
  if (key === '@react-native/debugger-frontend@0.86.3') {
    // Its nested Chromium/Meta BSD license is also copied by licenseFiles().
    return [installedLicense('react-native', '0.86.3')];
  }
  if (key === 'bplist-parser@0.3.1') {
    const readme = readFileSync(path.join(directory, 'README.md'), 'utf8');
    const start = readme.indexOf('(The MIT License)');
    if (start < 0 || !readme.includes('Permission is hereby granted')) error(`Unresolved README license: ${key}`);
    return [{ source: 'README.md, License section', text: clean(readme.slice(start)) }];
  }
  if (key === 'structured-headers@0.4.1') {
    // This exact published package declares MIT and its author, but includes no
    // copyright statement or license text. Record that limitation explicitly;
    // do not invent a copyright date/holder or silently guess a license.
    if (manifest.license !== 'MIT' || manifest.author !== 'Evert Pot <me@evertpot.com>') error(`Declared-license fallback needs review: ${key}`);
    const mit = snapshot('facebook-mit').text;
    const permission = mit.slice(mit.indexOf('Permission is hereby granted'));
    if (!permission.startsWith('Permission is hereby granted')) error('MIT permission text is unresolved');
    return [{
      source: 'Published structured-headers@0.4.1/package.json declares MIT and names the author. No standalone license or copyright statement is supplied in that tarball. Standard MIT permission and warranty text follows; author attribution is not an invented copyright statement.',
      text: `Author: ${manifest.author}\n\nMIT License\n\n${permission}`,
    }];
  }
  return [];
}

function licenseFiles(directory) {
  const found = [];
  const ignored = new Set(['node_modules', '.git', '.gradle', '.kotlin', '.cxx', 'Pods', 'coverage']);
  function walk(current) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name)) walk(full);
      } else if (entry.isFile() && /(?:^|[._-])(?:licen[cs]e|unlicense|copying|notice)(?:[._-]|$)/i.test(entry.name)) {
        const text = readFileSync(full, 'utf8');
        if (text.includes('\0') || text.includes('\uFFFD')) error(`Non-text notice requires review: ${path.relative(root, full)}`);
        if (text.trim()) found.push({ source: path.relative(directory, full).split(path.sep).join('/'), text: clean(text) });
      }
    }
  }
  walk(directory);
  return found.sort((a, b) => compare(a.source, b.source));
}

function sourceHeaders(directory, manifest) {
  // These tarballs omit a root notice or contain prebundled third-party code.
  // Keep their available copyright/license comments in addition to full texts.
  const paths = ['index.js'];
  if (manifest.name === 'babel-plugin-react-compiler') paths.push('dist/index.js');
  if (manifest.name === 'react-devtools-core') paths.push('dist/backend.js');
  const blocks = new Map();
  for (const relative of paths) {
    const file = path.join(directory, relative);
    if (!existsSync(file)) continue;
    for (const match of readFileSync(file, 'utf8').matchAll(/\/\*[\s\S]*?\*\//g)) {
      if (/copyright|@license|licensed under|Permission is hereby/i.test(match[0])) {
        const text = clean(match[0]);
        if (!blocks.has(text)) blocks.set(text, relative);
      }
    }
  }
  return [...blocks].map(([text, source]) => ({ source: `${source}, source notice`, text }));
}

function repositoryUrl(manifest) {
  const value = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url;
  if (!value) return undefined;
  const normalized = value.replace(/^git\+/, '').replace(/^github:/, 'https://github.com/').replace(/^git@github.com:/, 'https://github.com/').replace(/^ssh:\/\/(?:git@)?github.com\//, 'https://github.com/').replace(/^git:\/\/github.com\//, 'https://github.com/').replace(/\.git$/, '');
  if (/^[\w.-]+\/[\w.-]+$/.test(normalized)) return `https://github.com/${normalized}`;
  const url = new URL(normalized);
  if (url.username || url.password || !['https:', 'http:', 'git:'].includes(url.protocol)) error(`Repository URL requires review: ${manifest.name}`);
  return url.href;
}

// Keep package identity separate from its physical node_modules location. Bun
// may hoist the same locked package differently from npm or a previous install.
// Derive the closure from bun.lock, then verify the packages Node would load.
const hostCompilers = {
  lightningcss: {
    versions: new Set(['1.30.1', '1.32.0', '1.33.0']),
    prefix: 'lightningcss-',
    licenseSha256: '5c8fb0796b67b431098fdf9e9a5f6467350bce1fe83d7de82ec90c7526ead20d',
  },
  '@tailwindcss/oxide': {
    versions: new Set(['4.3.3']),
    prefix: '@tailwindcss/oxide-',
    licenseSha256: 'fdd854c84f367147ac4376837dee5002b0d2db39e8effed810ebc48f9bb70318',
  },
};

function keyParts(key) {
  const segments = key.split('/');
  const parts = [];
  for (let i = 0; i < segments.length; i += 1) {
    if (segments[i]) parts.push(segments[i].startsWith('@') ? `${segments[i]}/${segments[++i]}` : segments[i]);
  }
  return parts;
}

function lockedDependency(name, parentKey) {
  const parts = keyParts(parentKey);
  while (true) {
    const key = [...parts, name].join('/');
    if (lock.packages[key]) return key;
    if (!parts.length) return undefined;
    parts.pop();
  }
}

function installedDependency(name, parentDirectory) {
  // Look up manifests directly: many packages do not export package.json.
  let directory = parentDirectory;
  while (directory === root || directory.startsWith(root + path.sep)) {
    if (path.basename(directory) !== 'node_modules') {
      const candidate = path.join(directory, 'node_modules', name);
      if (existsSync(path.join(candidate, 'package.json'))) {
        const resolved = realpathSync(candidate);
        if (!resolved.startsWith(path.join(root, 'node_modules') + path.sep)) error(`External linked dependency requires a reviewed publication notice: ${name}`);
        return resolved;
      }
    }
    if (directory === root) return undefined;
    directory = path.dirname(directory);
  }
  return undefined;
}

function expectedPackage(key) {
  const entry = lock.packages[key];
  const separator = entry?.[0]?.lastIndexOf('@');
  if (!Array.isArray(entry) || separator < 1 || typeof entry[2] !== 'object') error(`Unsupported package resolution in bun.lock: ${key}`);
  const name = entry[0].slice(0, separator);
  const version = entry[0].slice(separator + 1);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) error(`Non-registry dependency needs a reviewed notice resolver: ${key}`);
  return { name, version, identity: entry[0], info: entry[2] };
}

function validateRange(name, range, manifest, from) {
  let packageName = name;
  if (range.startsWith('npm:')) {
    const target = range.slice(4);
    const separator = target.lastIndexOf('@');
    packageName = target.slice(0, separator);
    range = target.slice(separator + 1);
  }
  if (manifest.name !== packageName || !Bun.semver.satisfies(manifest.version, range)) {
    error(`Installed dependency does not satisfy ${from} -> ${name} (${range}). Run bun install --frozen-lockfile and remove obsolete package placements.`);
  }
}

function hostBinding(manifest, directory, name) {
  const family = hostCompilers[manifest.name];
  if (!family || !name.startsWith(family.prefix) || !Object.hasOwn(manifest.optionalDependencies || {}, name)) return false;
  if (!family.versions.has(manifest.version)) error(`Host compiler license mapping needs review: ${manifest.name}@${manifest.version}`);
  const text = clean(readFileSync(path.join(directory, 'LICENSE'), 'utf8'));
  const hash = createHash('sha256').update(text).digest('hex');
  if (hash !== family.licenseSha256) error(`Host compiler license changed: ${manifest.name}@${manifest.version}`);
  // These compiler bindings run on the build host; none is shipped as Android
  // runtime code. Their portable parent notice is always included. The eight
  // previously installed GNU/musl binding texts matched these hashes exactly.
  // Skipping every host binding, including its WASM fallback subtree, keeps the
  // checked output identical across Linux/macOS/Windows and glibc/musl installs.
  return true;
}

const rootManifest = json(path.join(root, 'package.json'));
const orderedEntries = (record) => Object.entries(record || {}).sort(([a], [b]) => compare(a, b));
for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']) {
  if (JSON.stringify(orderedEntries(rootManifest[field])) !== JSON.stringify(orderedEntries(lock.workspaces[''][field]))) {
    error(`package.json ${field} differ from bun.lock. Run bun install and commit the reviewed lockfile.`);
  }
}
const locations = new Set();
const visited = new Set();
function visit(key, directory, manifest) {
  const pair = `${key}\0${directory}`;
  if (visited.has(pair)) return;
  visited.add(pair);
  const locked = key ? expectedPackage(key) : { info: lock.workspaces[''] };
  if (key && locked.identity !== `${manifest.name}@${manifest.version}`) error(`Installed package differs from bun.lock: ${key}`);
  if (key && (manifest.os || manifest.cpu)) error(`Unreviewed platform-specific dependency in the mobile notice graph: ${locked.identity}`);
  if (key) locations.add(directory);
  const dependencies = { ...locked.info.peerDependencies, ...locked.info.dependencies, ...locked.info.optionalDependencies };
  const declared = { ...manifest.peerDependencies, ...manifest.dependencies, ...manifest.optionalDependencies };
  if (JSON.stringify(orderedEntries(declared)) !== JSON.stringify(orderedEntries(dependencies))) error(`Dependency metadata differs from bun.lock: ${manifest.name}`);
  const optional = new Set([...Object.keys(locked.info.optionalDependencies || {}), ...(locked.info.optionalPeers || [])]);
  for (const [name, range] of orderedEntries(dependencies)) {
    if (typeof range !== 'string' || declared[name] !== range) error(`Dependency metadata differs from bun.lock: ${manifest.name} -> ${name}`);
    if (hostBinding(manifest, directory, name)) continue;
    const targetKey = lockedDependency(name, key);
    if (!targetKey) {
      if (optional.has(name)) continue;
      error(`Required dependency is absent from bun.lock: ${manifest.name} -> ${name}`);
    }
    const target = installedDependency(name, directory);
    if (!target) error(`Locked dependency is not installed: ${manifest.name} -> ${name}. Run bun install --frozen-lockfile before generating notices.`);
    const targetManifest = json(path.join(target, 'package.json'));
    const expected = expectedPackage(targetKey);
    if (`${targetManifest.name}@${targetManifest.version}` !== expected.identity) error(`Installed dependency differs from bun.lock: ${manifest.name} -> ${name}; expected ${expected.identity}. Run bun install --frozen-lockfile and remove obsolete package placements.`);
    validateRange(name, range, targetManifest, manifest.name);
    visit(targetKey, target, targetManifest);
  }
}
visit('', root, rootManifest);
if (!locations.size) error('No installed production dependencies found. Run bun install --frozen-lockfile first.');
const packages = new Map();
const omissions = [];
for (const directory of [...locations].sort(compare)) {
  const relative = path.relative(root, directory).split(path.sep).join('/');
  if (!relative.startsWith('node_modules/')) error('External linked dependency requires a reviewed publication notice.');
  const manifest = json(path.join(directory, 'package.json'));
  const identity = `${manifest.name}@${manifest.version}`;
  let license = manifest.license;
  let licenseSource;
  if (identity === 'khroma@2.1.0' && license === undefined) {
    // The published package omits the manifest field but includes this full MIT
    // license. Require the reviewed bytes; future packages need another review.
    const hash = createHash('sha256').update(readFileSync(path.join(directory, 'license'))).digest('hex');
    if (hash !== '66b333b0f66759a0b710459e03f7029abe17f4358114a128d2c972e642961b49') error('The reviewed khroma license changed.');
    license = 'MIT'; licenseSource = 'Published license file; package.json omits the license field.';
  }
  if (!knownLicenses.has(license)) error(`Unknown or unresolved license for ${identity}: ${JSON.stringify(license)}`);
  const notices = licenseFiles(directory);
  const rootNotice = notices.some((entry) => !entry.source.includes('/') && entry.text.length > 200);
  const extra = supplementalNotices(manifest, directory);
  if (!rootNotice && !extra.length && !notices.some((entry) => entry.text.length > 400)) error(`Full license text unresolved for ${identity}; add a reviewed, version-pinned source before publishing.`);
  if (!rootNotice || extra.length) notices.push(...extra, ...sourceHeaders(directory, manifest));
  if (identity === 'structured-headers@0.4.1') omissions.push('structured-headers@0.4.1: published metadata supplies MIT and author attribution; its tarball omits a separate copyright/license notice. This specific fallback is documented in the packaged entry.');
  const repo = repositoryUrl(manifest);
  const entry = packages.get(identity) || { identity, license, licenseSource, repo, notices: new Map() };
  for (const notice of notices) {
    if (!notice.text) error(`Empty license text for ${identity}`);
    const hash = createHash('sha256').update(notice.text).digest('hex');
    if (!entry.notices.has(hash)) entry.notices.set(hash, notice);
  }
  packages.set(identity, entry);
}

const sections = [
  'PERCH — THIRD-PARTY SOFTWARE NOTICES',
  'Generated by scripts/generate-third-party-notices.mjs. Keep this file with distributed app copies.\n\nThis is a conservative inventory of Bun\'s locked production package graph used by the Android build and the explicitly vendored runtime sources. The generator verifies the installed dependency versions against bun.lock before copying their notices. This graph includes web support and build tools; listing a package does not imply that all its code enters the APK. Optional peers absent from the lockfile are excluded. Platform-specific Lightning CSS and Tailwind Oxide compiler bindings, which run on the build host, are represented by the full notices of their portable parent packages; their host-only binary/WASM subtrees are excluded. Development skills remain source-only and have their notices in THIRD_PARTY_NOTICES.md. Native Android dependencies may also retain their own notices in the APK metadata.\n\nFull published license/NOTICE files are copied below, with version-pinned upstream supplements where a tarball omits a shared license. These notices describe third-party components and do not assign a license to Perch itself.',
  `Package identities: ${packages.size}\nSource distributions: https://www.npmjs.com/package/<package>/v/<version> (substitute the exact package name and version shown in each entry).`,
];
for (const entry of [...packages.values()].sort((a, b) => compare(a.identity, b.identity))) {
  sections.push(`PACKAGE: ${entry.identity}\nDeclared license: ${entry.license}${entry.licenseSource ? `\nLicense source: ${entry.licenseSource}` : ''}${entry.repo ? `\nUpstream source: ${entry.repo}` : ''}`);
  for (const notice of entry.notices.values()) sections.push(`NOTICE SOURCE: ${notice.source}\n\n${notice.text}`);
}
for (const [title, file] of [
  ['Vendored OMP Collab client and wire types', 'src/vendor/omp/LICENSE'],
  ['Vendored assistant-ui native registry elements', 'src/chat/registry/LICENSE'],
]) {
  sections.push(`VENDORED RUNTIME: ${title}\nSource notice: ${file}\n\n${clean(readFileSync(path.join(root, file), 'utf8'))}`);
}
const output = sections.join('\n\n' + '='.repeat(78) + '\n\n') + '\n';
if (check) {
  if (!existsSync(destination) || readFileSync(destination, 'utf8') !== output) error('Packaged third-party notices are missing or stale. Run bun scripts/generate-third-party-notices.mjs and commit the generated asset.');
} else {
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, output);
}
console.log(`${check ? 'Verified' : 'Generated'} packaged notices: ${packages.size} package identities, ${Buffer.byteLength(output)} bytes.`);
for (const note of omissions) console.log(`Documented upstream omission: ${note}`);
