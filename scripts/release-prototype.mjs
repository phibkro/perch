import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { checkDefaultBranch, checkTrustedTag, githubPublicationRequest, inspectVersions, projectRoot } from './ci-android-version.mjs';

// This is deliberately separate from the build: GH_TOKEN is supplied only to
// the final publication step of a trusted default-branch/tag workflow job.
const { values } = parseArgs({ options: {
  directory: { type: 'string' }, notes: { type: 'string' },
} });
assert(values.directory && values.notes, 'Pass the verified asset directory and release notes file.');
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Publish through the guarded GitHub Actions job.');
assert(process.env.GH_TOKEN, 'The publishing job requires its repository-scoped GitHub token.');
const repository = process.env.GITHUB_REPOSITORY;
assert.match(repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
const version = inspectVersions();
const request = githubPublicationRequest(process.env, version);
assert(request.publish, 'This event cannot publish a release.');
const tag = request.tag;
const commit = process.env.GITHUB_SHA;
assert.match(commit, /^[a-f0-9]{40}$/);
if (request.source === 'default-branch') {
  checkDefaultBranch(projectRoot, version, process.env.PERCH_DEFAULT_BRANCH, commit);
} else {
  checkTrustedTag(projectRoot, version, tag, process.env.PERCH_DEFAULT_BRANCH, commit);
}
const directory = path.resolve(values.directory);
const notes = path.resolve(values.notes);
execFileSync('python3', ['scripts/ci-android-package.py', 'verify-bundle', '--directory', directory, '--tag', tag, '--notes', notes],
  { cwd: projectRoot, stdio: 'inherit' });

function api(endpoint, fields) {
  const args = ['api', endpoint];
  if (fields) {
    args.push('--method', 'POST');
    for (const [key, value] of Object.entries(fields)) args.push('--raw-field', `${key}=${value}`);
  }
  const result = spawnSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error) throw result.error;
  if (result.status === 0) return JSON.parse(result.stdout);
  // A read failure other than a confirmed missing resource must never cause a write.
  if (!fields && /\(HTTP 404\)/.test(result.stderr)) return null;
  throw new Error(`GitHub API failed for ${endpoint}: ${result.stderr.trim()}`);
}

const release = api(`repos/${repository}/releases/tags/${tag}`);
if (release) {
  console.log(`Release ${tag} already exists; its tag and assets are unchanged. Bump the app version for another release.`);
  process.exit(0);
}
let ref = api(`repos/${repository}/git/ref/tags/${tag}`);
if (ref) {
  let object = ref.object;
  // Accept existing annotated tags as well as the lightweight tags created here.
  for (let depth = 0; object.type === 'tag' && depth < 8; depth++) {
    object = api(`repos/${repository}/git/tags/${object.sha}`)?.object;
    assert(object, 'Cannot resolve the existing annotated tag.');
  }
  assert.equal(object.type, 'commit', 'The existing version tag must resolve to a commit.');
  assert.equal(object.sha, commit,
    'This version tag points to another commit and has no release. Run the workflow on that tag, or use a new version; tags are never moved.');
} else {
  assert.equal(request.source, 'default-branch', 'An explicit tag build must already have its remote tag.');
  ref = api(`repos/${repository}/git/refs`, { ref: `refs/tags/${tag}`, sha: commit });
  assert.equal(ref.object.sha, commit, 'GitHub created an unexpected version tag.');
}

execFileSync('gh', ['release', 'create', tag,
  path.join(directory, 'perch-prototype-arm64.apk'), path.join(directory, 'SHA256SUMS'), path.join(directory, 'release-metadata.json'),
  '--repo', repository, '--verify-tag', '--prerelease', '--latest=false',
  '--title', `Perch ${tag} prototype (ARM64)`, '--notes-file', notes], { stdio: 'inherit' });
