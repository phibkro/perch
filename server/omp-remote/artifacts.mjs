import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { MAX_STORED_ARTIFACT_BYTES } from '../../src/harness/durable.ts';

export const FILE_LIMIT = MAX_STORED_ARTIFACT_BYTES;
export const TOTAL_LIMIT = 8 * 1024 * 1024;
export const ENTRY_LIMIT = 32;

const formats = new Map();
const format = (extensions, mimeType, language) => {
  for (const extension of extensions.split(' ')) formats.set(extension, { mimeType, language });
};
format('md markdown mdown', 'text/markdown', 'markdown');
format('html htm', 'text/html', 'html');
format('txt text log', 'text/plain', 'text');
format('json jsonc', 'application/json', 'json');
format('yaml yml', 'text/yaml', 'yaml');
format('xml', 'application/xml', 'xml');
format('svg', 'text/plain', 'xml');
format('mmd mermaid', 'text/plain', 'mermaid');
format('csv', 'text/csv', 'text');
format('tsv', 'text/tab-separated-values', 'text');
for (const [extensions, language] of [
  ['js mjs cjs jsx', 'javascript'], ['ts mts cts tsx', 'typescript'], ['css', 'css'],
  ['scss', 'scss'], ['less', 'less'], ['toml', 'toml'], ['sql', 'sql'], ['py', 'python'],
  ['rs', 'rust'], ['go', 'go'], ['java', 'java'], ['kt kts', 'kotlin'], ['swift', 'swift'],
  ['sh bash zsh fish', 'bash'], ['nix', 'nix'], ['rb', 'ruby'], ['php', 'php'],
  ['c h', 'c'], ['cpp cc cxx hpp hxx', 'cpp'], ['cs', 'csharp'], ['fs fsx', 'fsharp'],
  ['clj cljs edn', 'clojure'], ['lua luau', 'lua'], ['ex exs', 'elixir'], ['erl hrl', 'erlang'],
  ['zig', 'zig'], ['vue svelte astro', 'html'], ['mdx', 'mdx'], ['diff patch', 'diff'],
]) format(extensions, 'text/plain', language);

const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 512
  && !/[\u0000-\u001f\u007f]/.test(value);
const inside = (directory, path) => {
  const rest = relative(directory, path);
  return rest !== '' && rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest);
};
const sameFile = (left, right) => left.dev === right.dev && left.ino === right.ino;
const unchanged = (left, right) => sameFile(left, right) && left.size === right.size
  && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
const skipped = reason => ({ status: 'skipped', reason });
const publicManifest = entry => ({ ...entry.manifest });

function exportName(path) {
  // Match the existing download contract's short, header-safe basename.
  const name = basename(path).replace(/[^A-Za-z0-9._ -]/g, '_').replace(/[ .]+$/g, '');
  const prefixed = /^[A-Za-z0-9]/.test(name) ? name : `artifact-${name}`;
  if (prefixed.length <= 120) return prefixed;
  const extension = extname(prefixed).slice(0, 20);
  return prefixed.slice(0, 120 - extension.length).replace(/[ .]+$/g, '') + extension;
}

/**
 * A bounded cache of file revisions observed after successful host tool writes.
 * Callers supply a trusted host event, never a path from a download request.
 * Nothing here proves the tool's success; the bridge must establish that first.
 */
export class OmpArtifactRegistry {
  #sessionId;
  #conversationId;
  #generation = 0;
  #entries = new Map();
  #calls = new Map();
  #bytes = 0;
  #pending = 0;
  #queue = Promise.resolve();

  constructor({ sessionId }) {
    if (typeof sessionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(sessionId)) {
      throw new Error('An artifact registry requires a valid remote session ID.');
    }
    this.#sessionId = sessionId;
  }

  /** Every call invalidates queued and in-flight work, including for the same conversation. */
  reset(conversationId) {
    if (conversationId !== undefined && !validId(conversationId)) throw new Error('Invalid artifact conversation ID.');
    this.#generation++;
    this.#conversationId = conversationId;
    this.#entries.clear();
    this.#calls.clear();
    this.#bytes = 0;
  }

  manifest(conversationId) {
    if (conversationId !== this.#conversationId || !validId(conversationId)) return [];
    return [...this.#entries.values()].map(publicManifest);
  }

  /** An opaque ID selects already copied bytes. This method cannot read a host path. */
  read({ conversationId, id }) {
    if (conversationId !== this.#conversationId || !validId(conversationId)) return undefined;
    const entry = this.#entries.get(id);
    return entry ? { manifest: publicManifest(entry), bytes: Buffer.from(entry.bytes) } : undefined;
  }

  capture(input) {
    if (!input || !validId(input.conversationId) || !validId(input.toolCallId) || input.toolCallId.length > 507
        || typeof input.cwd !== 'string' || !isAbsolute(input.cwd) || input.cwd.length > 4096
        || /[\u0000-\u001f\u007f]/.test(input.cwd)
        || typeof input.path !== 'string' || !input.path || input.path.length > 4096
        || /[\u0000-\u001f\u007f]/.test(input.path) || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(input.path)) {
      return Promise.resolve(skipped('invalid-input'));
    }
    if (input.conversationId !== this.#conversationId) return Promise.resolve(skipped('stale-scope'));
    if (this.#pending >= ENTRY_LIMIT) return Promise.resolve(skipped('capture-queue-full'));
    const request = { cwd: input.cwd, path: input.path, conversationId: input.conversationId, toolCallId: input.toolCallId };
    const generation = this.#generation;
    this.#pending++;
    const result = this.#queue.then(() => this.#capture(request, generation));
    this.#queue = result.then(() => {}, () => {});
    return result.finally(() => { this.#pending--; });
  }

  async #capture(request, generation) {
    const current = () => generation === this.#generation && request.conversationId === this.#conversationId;
    if (!current()) return skipped('stale-scope');
    const requestedPath = resolve(request.cwd, request.path);
    const previous = this.#calls.get(request.toolCallId);
    if (previous) return previous.path === requestedPath
      ? { status: 'captured', manifest: publicManifest(previous) } : skipped('tool-identity-conflict');
    const extension = extname(requestedPath).slice(1).toLowerCase();
    const type = formats.get(extension);
    if (!type) return skipped('unsupported-format');
    if (this.#entries.size >= ENTRY_LIMIT) return skipped('entry-limit');
    let handle;
    try {
      const directory = await realpath(request.cwd);
      const original = await lstat(requestedPath, { bigint: true });
      if (original.isSymbolicLink() || !original.isFile()) return skipped('not-regular-file');
      const canonical = await realpath(requestedPath);
      if (!inside(directory, canonical)) return skipped('outside-workspace');
      // NONBLOCK prevents a swapped FIFO from blocking before fstat can reject it.
      handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || !sameFile(original, before)) return skipped('file-changed');
      if (before.size > BigInt(FILE_LIMIT)) return skipped('file-too-large');
      const size = Number(before.size);
      if (this.#bytes + size > TOTAL_LIMIT) return skipped('total-limit');
      // Linux exposes the opened descriptor's actual path. Checking that path
      // closes the ancestor-symlink race between realpath and open. Fail closed
      // when the host cannot establish the descriptor's workspace membership.
      if (process.platform !== 'linux') return skipped('descriptor-path-unavailable');
      const openedPath = await realpath(`/proc/self/fd/${handle.fd}`);
      if (!inside(directory, openedPath)) return skipped('outside-workspace');
      if (openedPath !== canonical) return skipped('file-changed');
      if (!current()) return skipped('stale-scope');
      // Read at most the observed size plus one byte, even if a writer grows it.
      const buffer = Buffer.alloc(size + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      if (!unchanged(before, after) || length !== size) return skipped('file-changed');
      const finalPath = await realpath(`/proc/self/fd/${handle.fd}`);
      if (finalPath !== openedPath || !inside(directory, finalPath)) return skipped('file-changed');
      const content = buffer.subarray(0, length);
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(content); }
      catch { return skipped('not-utf8-text'); }
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) return skipped('not-utf8-text');
      if (!current()) return skipped('stale-scope');
      const filename = exportName(requestedPath);
      const manifest = Object.freeze({ id: randomUUID(), sessionId: this.#sessionId,
        title: filename, filename, ...type, sha256: createHash('sha256').update(content).digest('hex'),
        bytes: length, createdAt: Date.now(), sourceId: `tool:${request.toolCallId}` });
      const entry = { manifest, bytes: Buffer.from(content), path: requestedPath };
      this.#entries.set(manifest.id, entry);
      this.#calls.set(request.toolCallId, entry);
      this.#bytes += length;
      return { status: 'captured', manifest: publicManifest(entry) };
    } catch {
      return skipped(current() ? 'file-unavailable' : 'stale-scope');
    } finally { await handle?.close().catch(() => {}); }
  }
}
