import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { checkMonotonicVersions, inspectVersions, projectRoot } from './ci-android-version.mjs';

const canonicalVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function planVersion(nextVersion, { root = projectRoot, code } = {}) {
  const current = inspectVersions(root);
  assert.match(nextVersion, canonicalVersion, 'Choose a canonical X.Y.Z version, such as 0.5.1.');
  const nextParts = nextVersion.split('.').map(BigInt);
  const oldParts = current.versionName.split('.').map(BigInt);
  const changedPart = nextParts.findIndex((value, index) => value !== oldParts[index]);
  assert(changedPart >= 0 && nextParts[changedPart] > oldParts[changedPart], 'The new version must be greater than the current version.');
  const nextCode = code ?? current.versionCode + 1;
  assert(Number.isInteger(nextCode) && nextCode > current.versionCode && nextCode <= 2100000000,
    'The Android version code must increase and stay at or below 2100000000.');
  const version = { ...current, versionName: nextVersion, versionCode: nextCode };
  // A bump must be unused; unlike validating a release, no existing tag is exempt.
  checkMonotonicVersions(root, version, '');

  const files = [];
  const edit = (name, transform) => {
    const file = path.join(root, name);
    const before = readFileSync(file, 'utf8');
    const after = transform(before);
    assert.notEqual(before, after, `${name} did not receive its expected version change.`);
    files.push({ name, file, before, after });
  };
  const json = update => source => {
    const value = JSON.parse(source);
    update(value);
    return `${JSON.stringify(value, null, 2)}\n`;
  };
  edit('package.json', json(value => { value.version = nextVersion; }));
  // Bun's root workspace lock entry has no app version. A version-only bump
  // leaves dependency resolution unchanged; CI checks its frozen lockfile.
  edit('app.json', json(value => {
    value.expo.version = nextVersion;
    value.expo.android.versionCode = nextCode;
  }));
  edit('android/app/build.gradle', source => source
    .replace(/^(\s*versionName\s+["'])[^"']+(["']\s*)$/m, (_, before, after) => `${before}${nextVersion}${after}`)
    .replace(/^(\s*versionCode\s+)\d+(\s*)$/m, (_, before, after) => `${before}${nextCode}${after}`));
  edit('App.tsx', source => source.replace(/>Perch \d+\.\d+(?:\.\d+)? ·/,
    `>Perch ${nextVersion.endsWith('.0') ? nextVersion.slice(0, -2) : nextVersion} ·`));
  return { root, current, version, files };
}

export function applyVersion(plan) {
  const unchanged = file => assert.equal(readFileSync(file.file, 'utf8'), file.before,
    `${file.name} changed while preparing the version bump; rerun the command.`);
  plan.files.forEach(unchanged);
  const staged = [];
  const replaced = [];
  try {
    for (const file of plan.files) {
      // A partial write affects only a temporary file, never the original.
      // Same-directory staging keeps each replacement on the same filesystem.
      const directory = mkdtempSync(path.join(path.dirname(file.file), '.perch-version-'));
      const stage = { ...file, directory, next: path.join(directory, 'next'), previous: path.join(directory, 'previous') };
      staged.push(stage);
      const options = { encoding: 'utf8', mode: statSync(file.file).mode & 0o777 };
      writeFileSync(stage.next, file.after, options);
      writeFileSync(stage.previous, file.before, options);
    }
    staged.forEach(unchanged);
    for (const file of staged) {
      unchanged(file);
      renameSync(file.next, file.file);
      replaced.push(file);
    }
    assert.deepEqual(inspectVersions(plan.root), plan.version, 'The written version metadata failed its consistency check.');
  } catch (error) {
    const restoreErrors = [];
    for (const file of replaced.reverse()) {
      try {
        // Restore only this command's own replacements, preserving concurrent edits.
        assert.equal(readFileSync(file.file, 'utf8'), file.after, `${file.name} changed concurrently and was not restored.`);
        renameSync(file.previous, file.file);
      } catch (restoreError) { restoreErrors.push(restoreError); }
    }
    if (restoreErrors.length) throw new AggregateError([error, ...restoreErrors], 'The version update failed; inspect the reported files before retrying.');
    throw error;
  } finally {
    for (const file of staged) rmSync(file.directory, { recursive: true, force: true });
  }
}

function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    check: { type: 'boolean' }, code: { type: 'string' },
  } });
  assert.equal(positionals.length, 1, 'Usage: bun run release:version X.Y.Z [--code INTEGER] [--check]');
  if (values.code !== undefined) assert.match(values.code, /^[1-9]\d*$/, '--code must be a positive integer.');
  const plan = planVersion(positionals[0], { code: values.code === undefined ? undefined : Number(values.code) });
  if (!values.check) applyVersion(plan);
  console.log(`${values.check ? 'Checked' : 'Updated'} Perch ${plan.current.versionName} → ${plan.version.versionName}; Android code ${plan.current.versionCode} → ${plan.version.versionCode}.`);
  console.log(`${plan.files.map(file => file.name).join('\n')}\n${values.check ? 'No files changed.' : 'Review the diff, commit, and push main to publish the next prototype prerelease.'}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
