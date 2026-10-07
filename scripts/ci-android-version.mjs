import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const prototypePackage = 'dev.perch.assistant';
export const bunVersion = '1.4.2';
// Preserved identity from docs/ANDROID-BUILD.md; this key is intentionally public.
export const prototypeKeystoreSha256 = '221e0a3106aa4c3ccc154e0a418b55020b3f9ea6e84f92e8749cd9e2f39f5e58';
export const prototypeCertificateSha256 = 'fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c';
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function singleMatch(text, pattern, label) {
  const matches = [...text.matchAll(pattern)];
  assert.equal(matches.length, 1, `Expected exactly one ${label}; review the version checker if the source layout changed.`);
  return matches[0][1];
}

export function inspectVersions(root = projectRoot) {
  const read = name => readFileSync(path.join(root, name), 'utf8');
  const app = JSON.parse(read('app.json')).expo;
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.packageManager, `bun@${bunVersion}`, 'package.json must pin the supported Bun package manager.');
  assert(existsSync(path.join(root, 'bun.lock')) && read('bun.lock').trim(),
    'Commit a nonempty bun.lock; frozen installation is a separate CI gate.');
  assert.match(app.version, versionPattern, 'Use a canonical X.Y.Z app version. GitHub supplies the prerelease label.');
  assert(Number.isInteger(app.android?.versionCode) && app.android.versionCode > 0 && app.android.versionCode <= 2100000000,
    'app.json android.versionCode must be a positive Android version code.');
  assert.equal(app.android.package, prototypePackage, 'The prototype package identity must remain unchanged.');
  assert.equal(pkg.version, app.version, 'package.json version must match app.json.');
  const gradle = read('android/app/build.gradle');
  assert.equal(singleMatch(gradle, /^\s*versionName\s+["']([^"']+)["']\s*$/gm, 'native versionName'), app.version,
    'Native versionName must match app.json.');
  assert.equal(Number(singleMatch(gradle, /^\s*versionCode\s+(\d+)\s*$/gm, 'native versionCode')), app.android.versionCode,
    'Native versionCode must match app.json.');
  assert.equal(singleMatch(gradle, /^\s*applicationId\s+["']([^"']+)["']\s*$/gm, 'applicationId'), prototypePackage);
  assert.equal(singleMatch(gradle, /^\s*namespace\s+["']([^"']+)["']\s*$/gm, 'namespace'), prototypePackage);
  const footer = singleMatch(read('App.tsx'), />Perch (\d+\.\d+(?:\.\d+)?) ·/g, 'App footer version');
  assert(footer === app.version || (app.version.endsWith('.0') && footer === app.version.slice(0, -2)),
    'App.tsx footer must show this version (a zero patch component may be omitted).');
  const keyHash = createHash('sha256').update(readFileSync(path.join(root, 'android/app/debug.keystore'))).digest('hex');
  assert.equal(keyHash, prototypeKeystoreSha256, 'The original prototype keystore changed. Do not rotate it in this release path.');
  return {
    versionName: app.version,
    versionCode: app.android.versionCode,
    packageManager: pkg.packageManager,
    packageName: prototypePackage,
    keystoreSha256: prototypeKeystoreSha256,
    certificateSha256: prototypeCertificateSha256,
  };
}

export function expectTag(version, tag) {
  assert.equal(tag, `v${version.versionName}`, 'Release tag must exactly equal v plus the app version.');
}

function compareVersions(left, right) {
  const a = left.split('.').map(BigInt);
  const b = right.split('.').map(BigInt);
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

export function checkMonotonicVersions(root, version, currentTag = `v${version.versionName}`) {
  const tags = git(root, 'tag', '--list', 'v*').split('\n').filter(Boolean);
  for (const tag of tags) {
    if (tag === currentTag || !versionPattern.test(tag.slice(1))) continue;
    assert(compareVersions(version.versionName, tag.slice(1)) > 0, `Version must be newer than existing release tag ${tag}.`);
    const previous = JSON.parse(git(root, 'show', `refs/tags/${tag}:app.json`)).expo;
    assert.equal(previous?.version, tag.slice(1), `Existing tag ${tag} has inconsistent app metadata; resolve this before publishing.`);
    assert(Number.isInteger(previous?.android?.versionCode), `Existing tag ${tag} has no valid Android versionCode.`);
    assert(version.versionCode > previous.android.versionCode,
      `versionCode ${version.versionCode} must exceed ${tag}'s code ${previous.android.versionCode}.`);
  }
}

export function checkTrustedTag(root, version, tag, defaultBranch, expectedCommit) {
  expectTag(version, tag);
  assert(defaultBranch, 'The repository default branch is required for release publication.');
  git(root, 'check-ref-format', `refs/heads/${defaultBranch}`);
  const commit = git(root, 'rev-parse', '--verify', `refs/tags/${tag}^{commit}`);
  assert.equal(git(root, 'rev-parse', 'HEAD'), commit, 'The checkout must be the exact tagged commit.');
  if (expectedCommit) assert.equal(commit, expectedCommit, 'The event SHA must match the checked-out tag.');
  try {
    git(root, 'merge-base', '--is-ancestor', commit, `refs/remotes/origin/${defaultBranch}`);
  } catch {
    throw new Error(`Release tag ${tag} must point to a commit already on the fetched default branch ${defaultBranch}.`);
  }
  checkMonotonicVersions(root, version, tag);
  return commit;
}

export function checkDefaultBranch(root, version, defaultBranch, expectedCommit) {
  assert(defaultBranch, 'The repository default branch is required for release publication.');
  git(root, 'check-ref-format', `refs/heads/${defaultBranch}`);
  const commit = git(root, 'rev-parse', 'HEAD');
  assert.equal(commit, expectedCommit, 'The build checkout must match the event SHA.');
  try {
    git(root, 'merge-base', '--is-ancestor', commit, `refs/remotes/origin/${defaultBranch}`);
  } catch {
    throw new Error('Automatic publication requires a commit already on the fetched default branch.');
  }
  checkMonotonicVersions(root, version);
  return commit;
}

export function githubPublicationRequest(env, version) {
  const tagRef = env.GITHUB_REF?.startsWith('refs/tags/');
  const taggedPush = env.GITHUB_EVENT_NAME === 'push' && tagRef;
  const manualPublish = env.GITHUB_EVENT_NAME === 'workflow_dispatch' && env.PERCH_PUBLISH_PRERELEASE === 'true';
  const defaultBranchPush = env.GITHUB_EVENT_NAME === 'push' && Boolean(env.PERCH_DEFAULT_BRANCH) &&
    env.GITHUB_REF === `refs/heads/${env.PERCH_DEFAULT_BRANCH}`;
  if (manualPublish) assert(tagRef, 'Manual publishing requires selecting an existing version tag; a branch dispatch can only build artifacts.');
  const publish = Boolean(taggedPush || manualPublish || defaultBranchPush);
  const tag = tagRef ? env.GITHUB_REF.slice('refs/tags/'.length) : defaultBranchPush ? `v${version.versionName}` : '';
  return { publish, tag, source: defaultBranchPush ? 'default-branch' : tagRef ? 'tag' : '' };
}

function main() {
  const { values } = parseArgs({ options: {
    json: { type: 'boolean' }, github: { type: 'boolean' },
    'expect-tag': { type: 'string' }, 'check-monotonic': { type: 'boolean' },
  } });
  const version = inspectVersions();
  if (values['expect-tag']) expectTag(version, values['expect-tag']);
  if (values['check-monotonic']) checkMonotonicVersions(projectRoot, version);
  let publication = { publish: false, tag: '', source: '' };
  if (values.github) {
    publication = githubPublicationRequest(process.env, version);
    if (publication.tag) expectTag(version, publication.tag);
    if (publication.publish && publication.source === 'tag') {
      checkTrustedTag(projectRoot, version, publication.tag, process.env.PERCH_DEFAULT_BRANCH, process.env.GITHUB_SHA);
    } else if (publication.publish) {
      checkDefaultBranch(projectRoot, version, process.env.PERCH_DEFAULT_BRANCH, process.env.GITHUB_SHA);
    }
    assert(process.env.GITHUB_OUTPUT, '--github requires the GitHub Actions output file.');
    appendFileSync(process.env.GITHUB_OUTPUT,
      `version=${version.versionName}\nversion_code=${version.versionCode}\nrelease_tag=${publication.tag}\npublish=${publication.publish}\n`);
  }
  console.log(values.json ? JSON.stringify(version) :
    `Verified ${version.packageName} ${version.versionName} (code ${version.versionCode}); preserved prototype key.${publication.publish ? ` Publish candidate: ${publication.tag}.` : ''}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
