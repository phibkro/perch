import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  checkMonotonicVersions, checkTrustedTag, expectTag, githubPublicationRequest, inspectVersions, projectRoot,
} from './ci-android-version.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'perch-release-guard-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'android/app'), { recursive: true });
  for (const name of ['app.json', 'package.json', 'bun.lock', 'App.tsx', 'android/app/build.gradle', 'android/app/debug.keystore']) {
    copyFileSync(path.join(projectRoot, name), path.join(root, name));
  }
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '--initial-branch=main');
  git('config', 'user.email', 'ci-fixture@example.invalid');
  git('config', 'user.name', 'Perch release guard fixture');
  git('add', '.');
  git('-c', 'commit.gpgsign=false', 'commit', '-m', 'Current source');
  return { root, git, version: inspectVersions(root) };
}

test('cross-file version drift fails before a build', t => {
  const { root } = fixture(t);
  const appPath = path.join(root, 'app.json');
  const app = JSON.parse(readFileSync(appPath, 'utf8'));
  app.expo.android.versionCode += 1;
  writeFileSync(appPath, JSON.stringify(app));
  assert.throws(() => inspectVersions(root), /Native versionCode must match/);
});

test('a changed prototype keystore fails before a build', t => {
  const { root } = fixture(t);
  writeFileSync(path.join(root, 'android/app/debug.keystore'), 'a different key');
  assert.throws(() => inspectVersions(root), /original prototype keystore changed/);
});

test('a missing Bun lock cannot fall through to an unlocked install', t => {
  const { root } = fixture(t);
  rmSync(path.join(root, 'bun.lock'));
  assert.throws(() => inspectVersions(root), /Commit a nonempty bun.lock/);
});

test('an unpinned Bun package manager fails before installation', t => {
  const { root } = fixture(t);
  const pkgPath = path.join(root, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  pkg.packageManager = 'bun@latest';
  writeFileSync(pkgPath, JSON.stringify(pkg));
  assert.throws(() => inspectVersions(root), /pin the supported Bun package manager/);
});

test('an existing matching tag on the default branch is eligible', t => {
  const { root, git, version } = fixture(t);
  const tag = `v${version.versionName}`;
  const commit = git('rev-parse', 'HEAD');
  git('tag', tag);
  git('update-ref', 'refs/remotes/origin/main', commit);
  assert.equal(checkTrustedTag(root, version, tag, 'main', commit), commit);
  assert.throws(() => expectTag(version, 'v0.0.1;echo bad'), /Release tag must exactly/);
});

test('a tag outside the default branch cannot publish', t => {
  const { root, git, version } = fixture(t);
  const original = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/main', original);
  writeFileSync(path.join(root, 'unmerged.txt'), 'unmerged source');
  git('add', 'unmerged.txt');
  git('-c', 'commit.gpgsign=false', 'commit', '-m', 'Unmerged branch');
  git('tag', `v${version.versionName}`);
  assert.throws(() => checkTrustedTag(root, version, `v${version.versionName}`, 'main', git('rev-parse', 'HEAD')), /already on the fetched default branch/);
});

test('reusing an older Android versionCode is rejected', t => {
  const { root, git, version } = fixture(t);
  const current = git('rev-parse', 'HEAD');
  const app = JSON.parse(readFileSync(path.join(root, 'app.json'), 'utf8'));
  app.expo.version = '0.0.1';
  app.expo.android.versionCode = version.versionCode;
  writeFileSync(path.join(root, 'app.json'), JSON.stringify(app));
  git('add', 'app.json');
  git('-c', 'commit.gpgsign=false', 'commit', '-m', 'Historical version fixture');
  git('tag', 'v0.0.1');
  git('checkout', '--detach', current);
  assert.throws(() => checkMonotonicVersions(root, version), /versionCode .* must exceed/);
});

test('releasing below an existing version tag is rejected', t => {
  const { root, git, version } = fixture(t);
  git('tag', 'v999.0.0');
  assert.throws(() => checkMonotonicVersions(root, version), /must be newer than existing release tag/);
});

test('PRs and ordinary branch runs cannot request publication', () => {
  assert.deepEqual(githubPublicationRequest({ GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/pull/1/merge', PERCH_PUBLISH_PRERELEASE: 'true' }), { publish: false, tag: '', source: '' });
  assert.deepEqual(githubPublicationRequest({ GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/feature', PERCH_DEFAULT_BRANCH: 'main' }), { publish: false, tag: '', source: '' });
  assert.throws(() => githubPublicationRequest({ GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', PERCH_PUBLISH_PRERELEASE: 'true' }), /existing version tag/);
});

test('tag pushes publish; manual tag builds require the publish input', () => {
  assert.deepEqual(githubPublicationRequest({ GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/tags/v1.0.0' }), { publish: true, tag: 'v1.0.0', source: 'tag' });
  assert.deepEqual(githubPublicationRequest({ GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/tags/v1.0.0', PERCH_PUBLISH_PRERELEASE: 'false' }), { publish: false, tag: 'v1.0.0', source: 'tag' });
  assert.deepEqual(githubPublicationRequest({ GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/tags/v1.0.0', PERCH_PUBLISH_PRERELEASE: 'true' }), { publish: true, tag: 'v1.0.0', source: 'tag' });
});

test('only a default-branch push requests automatic version publication', () => {
  const version = { versionName: '1.2.3' };
  assert.deepEqual(githubPublicationRequest({ GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', PERCH_DEFAULT_BRANCH: 'main' }, version),
    { publish: true, tag: 'v1.2.3', source: 'default-branch' });
  assert.deepEqual(githubPublicationRequest({ GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', PERCH_DEFAULT_BRANCH: 'main', PERCH_PUBLISH_PRERELEASE: 'false' }, version),
    { publish: false, tag: '', source: '' });
});
