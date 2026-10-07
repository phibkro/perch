import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inspectVersions, projectRoot } from './ci-android-version.mjs';

// Exercise the actual publication CLI's ordering and refusal paths. GitHub,
// git history, and the already-tested artifact-verification boundary are local
// command doubles: no network requests, actual tags, releases, or credentials.
function publishFixture(t, scenario) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'perch-publish-guard-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  const commit = 'a'.repeat(40);
  const tag = `v${inspectVersions().versionName}`;
  const log = path.join(root, 'calls.jsonl');
  const executable = (name, source) => {
    const target = path.join(bin, name);
    writeFileSync(target, `#!${process.execPath}\n${source}`);
    chmodSync(target, 0o755);
  };
  executable('git', `
    const args = process.argv.slice(2);
    if (args[0] === 'rev-parse') console.log('${commit}');
    else if (!['check-ref-format', 'merge-base', 'tag'].includes(args[0])) process.exit(90);
  `);
  executable('python3', `
    const fs = require('node:fs');
    fs.appendFileSync(process.env.PERCH_TEST_LOG, JSON.stringify({ verifiedBundle: true }) + '\\n');
  `);
  executable('gh', `
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    fs.appendFileSync(process.env.PERCH_TEST_LOG, JSON.stringify({ gh: args }) + '\\n');
    const scenario = process.env.PERCH_TEST_SCENARIO;
    const missing = () => { console.error('gh: Not Found (HTTP 404)'); process.exit(1); };
    if (args[0] === 'release' && args[1] === 'create') { console.log('Mock release created'); }
    else if (args[0] !== 'api') process.exit(91);
    else if (args[1].includes('/releases/tags/')) {
      if (scenario === 'existing') console.log(JSON.stringify({ id: 1 }));
      else if (scenario === 'forbidden') { console.error('gh: Forbidden (HTTP 403)'); process.exit(1); }
      else missing();
    } else if (args[1].includes('/git/ref/tags/')) {
      if (scenario === 'moved') console.log(JSON.stringify({ object: { type: 'commit', sha: '${'b'.repeat(40)}' } }));
      else missing();
    } else if (args[1].endsWith('/git/refs') && args.includes('POST')) {
      console.log(JSON.stringify({ object: { type: 'commit', sha: '${commit}' } }));
    } else process.exit(92);
  `);
  const result = spawnSync(process.execPath, ['scripts/release-prototype.mjs', '--directory', root, '--notes', path.join(root, 'notes.md')], {
    cwd: projectRoot,
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, GITHUB_ACTIONS: 'true',
      GH_TOKEN: 'local-command-double-only', GITHUB_REPOSITORY: 'example/perch', GITHUB_EVENT_NAME: 'push',
      GITHUB_REF: 'refs/heads/main', GITHUB_SHA: commit, PERCH_DEFAULT_BRANCH: 'main',
      PERCH_TEST_LOG: log, PERCH_TEST_SCENARIO: scenario },
    encoding: 'utf8',
  });
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  return { result, calls, root, commit, tag };
}

test('an existing release causes no tag or asset write', t => {
  const { result, calls } = publishFixture(t, 'existing');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /already exists/);
  assert.deepEqual(calls.map(call => call.gh?.[0] ?? 'verify'), ['verify', 'api']);
});

test('a new default-branch version verifies assets, creates its exact tag, then prereleases', t => {
  const { result, calls, commit, tag } = publishFixture(t, 'new');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(calls[0].verifiedBundle, true);
  const tagWrite = calls.find(call => call.gh?.includes('POST')).gh;
  assert(tagWrite.includes(`ref=refs/tags/${tag}`));
  assert(tagWrite.includes(`sha=${commit}`));
  const releaseWrite = calls.at(-1).gh;
  assert.deepEqual(releaseWrite.slice(0, 3), ['release', 'create', tag]);
  for (const flag of ['--verify-tag', '--prerelease', '--latest=false']) assert(releaseWrite.includes(flag));
  assert.equal(releaseWrite.filter(argument => argument.endsWith('.apk')).length, 1);
  assert(!releaseWrite.includes('--clobber'));
});

test('a conflicting tag cannot be moved or published', t => {
  const { result, calls } = publishFixture(t, 'moved');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /tag points to another commit/);
  assert(!calls.some(call => call.gh?.includes('POST') || call.gh?.[0] === 'release'));
});

test('an API authorization failure cannot be treated as a missing release', t => {
  const { result, calls } = publishFixture(t, 'forbidden');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /HTTP 403/);
  assert(!calls.some(call => call.gh?.includes('POST') || call.gh?.[0] === 'release'));
});
