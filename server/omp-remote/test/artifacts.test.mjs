import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ENTRY_LIMIT, FILE_LIMIT, OmpArtifactRegistry, TOTAL_LIMIT } from '../artifacts.mjs';
import { artifact as parseStoredArtifact } from '../../../src/session/durable/projection.ts';

const directories = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'perch-captured-artifacts-'));
  directories.push(directory);
  const cwd = join(directory, 'work'), outside = join(directory, 'outside');
  await mkdir(cwd); await mkdir(outside);
  const registry = new OmpArtifactRegistry({ sessionId: 'omp_runtime' });
  registry.reset('conversation');
  return { directory, cwd, outside, registry,
    capture: (path = 'report.md', toolCallId = 'write-1', conversationId = 'conversation') =>
      registry.capture({ cwd, path, toolCallId, conversationId }) };
}

describe('captured OMP file revisions', () => {
  test('copies exact saved UTF-8 bytes and supplies the existing StoredArtifact shape', async () => {
    const { cwd, registry, capture } = await fixture();
    const content = Buffer.from('\ufeff# Report 🦜\r\n\r\nThe original line endings remain.\r\n');
    await writeFile(join(cwd, 'report.md'), content);
    const result = await capture();
    expect(result.status).toBe('captured');
    expect(result.manifest).toMatchObject({ sessionId: 'omp_runtime', title: 'report.md', filename: 'report.md',
      mimeType: 'text/markdown', language: 'markdown', bytes: content.length, sourceId: 'tool:write-1',
      sha256: createHash('sha256').update(content).digest('hex') });
    expect(result.manifest.id).toMatch(/^[a-f0-9-]{36}$/);
    expect(result.manifest.createdAt).toBeGreaterThan(0);
    expect(registry.read({ conversationId: 'conversation', id: result.manifest.id }).bytes).toEqual(content);
  });

  test('copied revisions remain immutable after the file changes and after callers mutate returned data', async () => {
    const { cwd, registry, capture } = await fixture();
    await writeFile(join(cwd, 'report.md'), 'original');
    const first = await capture();
    const id = first.manifest.id;
    first.manifest.sha256 = 'not the stored digest';
    const publicEntry = registry.read({ conversationId: 'conversation', id });
    publicEntry.bytes.fill(0); publicEntry.manifest.filename = 'changed.md';
    registry.manifest('conversation')[0].filename = 'changed-again.md';
    await writeFile(join(cwd, 'report.md'), 'new file contents');
    expect((await capture()).manifest.id).toBe(id);
    expect(registry.read({ conversationId: 'conversation', id }).bytes.toString()).toBe('original');
    expect(registry.manifest('conversation')[0].filename).toBe('report.md');
    const next = await capture('report.md', 'write-2');
    expect(next.manifest.id).not.toBe(id);
    expect(next.manifest.sha256).not.toBe(publicEntry.manifest.sha256);
    expect(registry.read({ conversationId: 'conversation', id: next.manifest.id }).bytes.toString()).toBe('new file contents');
  });

  test('does not bind a repeated tool-call ID to another file', async () => {
    const { cwd, capture } = await fixture();
    await writeFile(join(cwd, 'report.md'), 'first'); await writeFile(join(cwd, 'other.md'), 'second');
    expect((await capture()).status).toBe('captured');
    expect(await capture('other.md')).toEqual({ status: 'skipped', reason: 'tool-identity-conflict' });
  });

  test('reset fences already queued work and also invalidates the same conversation generation', async () => {
    const { cwd, registry, capture } = await fixture();
    await writeFile(join(cwd, 'report.md'), 'old generation');
    const pending = capture();
    registry.reset('conversation');
    expect(await pending).toEqual({ status: 'skipped', reason: 'stale-scope' });
    expect(registry.manifest('conversation')).toEqual([]);
    const fresh = await capture();
    expect(fresh.status).toBe('captured');
    registry.reset('new-conversation');
    expect(registry.manifest('conversation')).toEqual([]);
    expect(registry.read({ conversationId: 'new-conversation', id: fresh.manifest.id })).toBeUndefined();
    expect(await capture()).toEqual({ status: 'skipped', reason: 'stale-scope' });
    registry.reset();
    expect(registry.manifest('new-conversation')).toEqual([]);
  });

  test('rejects paths outside the canonical workspace, including an escaping ancestor symlink', async () => {
    const { cwd, outside, capture } = await fixture();
    await writeFile(join(outside, 'private.md'), 'outside');
    expect(await capture(join(outside, 'private.md'))).toEqual({ status: 'skipped', reason: 'outside-workspace' });
    expect(await capture('../outside/private.md')).toEqual({ status: 'skipped', reason: 'outside-workspace' });
    await symlink(outside, join(cwd, 'linked-directory'));
    expect(await capture('linked-directory/private.md')).toEqual({ status: 'skipped', reason: 'outside-workspace' });
  });

  test('rejects a final symlink, a directory, a missing file, and unsupported internal URIs', async () => {
    const { cwd, capture } = await fixture();
    await writeFile(join(cwd, 'real.md'), 'inside');
    await symlink('real.md', join(cwd, 'linked.md'));
    await mkdir(join(cwd, 'directory.md'));
    expect(await capture('linked.md')).toEqual({ status: 'skipped', reason: 'not-regular-file' });
    expect(await capture('directory.md')).toEqual({ status: 'skipped', reason: 'not-regular-file' });
    expect(await capture('missing.md')).toEqual({ status: 'skipped', reason: 'file-unavailable' });
    expect(await capture('local://plan.md')).toEqual({ status: 'skipped', reason: 'invalid-input' });
    expect(await capture('bad\u0000name.md')).toEqual({ status: 'skipped', reason: 'invalid-input' });
  });

  test('only captures allowlisted text files with strict UTF-8', async () => {
    const { cwd, capture } = await fixture();
    for (const [name, content, reason] of [
      ['image.png', 'not really a PNG', 'unsupported-format'],
      ['credentials.env', 'text', 'unsupported-format'],
      ['broken.md', Buffer.from([0xc3, 0x28]), 'not-utf8-text'],
      ['binary.json', Buffer.from([0, 1, 2]), 'not-utf8-text'],
    ]) {
      await writeFile(join(cwd, name), content);
      expect(await capture(name)).toEqual({ status: 'skipped', reason });
    }
  });

  test('every supported format produces a valid shared manifest; only HTML files enable the HTML reader', async () => {
    const { cwd, capture } = await fixture();
    for (const [name, mimeType, language] of [['preview.HTML', 'text/html', 'html'], ['data.json', 'application/json', 'json'],
      ['Widget.tsx', 'text/plain', 'typescript'], ['Page.svelte', 'text/plain', 'html'], ['icon.svg', 'text/plain', 'xml'],
      ['flow.mmd', 'text/plain', 'mermaid'], ['flow.mermaid', 'text/plain', 'mermaid']]) {
      await writeFile(join(cwd, name), '<div>Test</div>');
      expect((await capture(name, name)).manifest).toMatchObject({ mimeType, language });
    }
    const extensions = 'md markdown mdown html htm txt text log json jsonc yaml yml xml svg mmd mermaid csv tsv js mjs cjs jsx ts mts cts tsx css scss less toml sql py rs go java kt kts swift sh bash zsh fish nix rb php c h cpp cc cxx hpp hxx cs fs fsx clj cljs edn lua luau ex exs erl hrl zig vue svelte astro mdx diff patch'.split(' ');
    for (const extension of extensions) {
      const single = await fixture();
      const filename = `fixture.${extension}`;
      await writeFile(join(single.cwd, filename), 'plain UTF-8');
      const result = await single.capture(filename, extension);
      expect(result.status).toBe('captured');
      expect(parseStoredArtifact(result.manifest, 'omp_runtime')).toEqual(result.manifest);
    }
  });

  test('accepts empty files and the existing byte cap; rejects larger files before reading them', async () => {
    const { cwd, registry, capture } = await fixture();
    await writeFile(join(cwd, 'empty.md'), '');
    const empty = await capture('empty.md', 'empty');
    expect(empty.manifest.bytes).toBe(0);
    expect(registry.read({ conversationId: 'conversation', id: empty.manifest.id }).bytes.length).toBe(0);
    await writeFile(join(cwd, 'limit.txt'), Buffer.alloc(FILE_LIMIT, 97));
    expect((await capture('limit.txt', 'limit')).manifest.bytes).toBe(FILE_LIMIT);
    await truncate(join(cwd, 'limit.txt'), FILE_LIMIT + 1);
    expect(await capture('limit.txt', 'too-large')).toEqual({ status: 'skipped', reason: 'file-too-large' });
  });

  test('serialized concurrent captures cannot exceed the total copied-byte budget', async () => {
    const { cwd, registry, capture } = await fixture();
    await writeFile(join(cwd, 'large.txt'), Buffer.alloc(FILE_LIMIT, 97));
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => capture('large.txt', `write-${index}`)));
    const expected = Math.floor(TOTAL_LIMIT / FILE_LIMIT);
    expect(results.filter(result => result.status === 'captured')).toHaveLength(expected);
    expect(results.filter(result => result.reason === 'total-limit')).toHaveLength(8 - expected);
    expect(registry.manifest('conversation').reduce((sum, manifest) => sum + manifest.bytes, 0)).toBeLessThanOrEqual(TOTAL_LIMIT);
    registry.reset('conversation');
    expect((await capture('large.txt', 'after-reset')).status).toBe('captured');
  });

  test('retains at most 32 entries without evicting an already advertised revision', async () => {
    const { cwd, registry, capture } = await fixture();
    await writeFile(join(cwd, 'small.md'), 'small');
    for (let index = 0; index < ENTRY_LIMIT; index++) expect((await capture('small.md', `write-${index}`)).status).toBe('captured');
    const first = registry.manifest('conversation')[0];
    expect(await capture('small.md', 'one-too-many')).toEqual({ status: 'skipped', reason: 'entry-limit' });
    expect(registry.read({ conversationId: 'conversation', id: first.id }).bytes.toString()).toBe('small');
  });

  test('uses safe basenames and refuses a source identity that cannot fit the manifest contract', async () => {
    const { cwd, capture } = await fixture();
    const name = 'Résumé 🦜.md';
    await writeFile(join(cwd, name), 'text');
    const result = await capture(name, 'x'.repeat(507));
    expect(result.manifest.filename).toMatch(/^[A-Za-z0-9][A-Za-z0-9._ -]{0,119}$/);
    expect(result.manifest.sourceId.length).toBe(512);
    expect(await capture(name, 'x'.repeat(508))).toEqual({ status: 'skipped', reason: 'invalid-input' });
  });
});
