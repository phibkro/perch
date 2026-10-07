import { Type } from '@earendil-works/pi-ai';
import { defineDoc, defineTool } from '@earendil-works/pi-durable';
import { MAX_STORED_ARTIFACT_BYTES } from '../../../src/harness/durable.ts';

// All session writes use Pi's commit queue. Raw host SQL must not interleave with
// an in-flight Pi transaction on the same SQLite connection.
export const SessionData = defineDoc({ kind: 'perch.session.v1', version: 1, scope: 'session',
  initial: () => ({ admissions: [], artifacts: [] }) });
export const sha256 = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
  .map(value => value.toString(16).padStart(2, '0')).join('');

export function artifactInput(args) {
  if (!args || !['markdown', 'html', 'code'].includes(args.kind)
      || typeof args.filename !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._ -]{0,119}$/.test(args.filename)
      || args.filename === '.' || args.filename === '..' || /[ .]$/.test(args.filename)
      || typeof args.title !== 'string' || !args.title.trim() || args.title.length > 160 || /[\u0000-\u001f\u007f]/.test(args.title)
      || typeof args.content !== 'string' || args.content.length > MAX_STORED_ARTIFACT_BYTES
      || (args.language !== undefined && (typeof args.language !== 'string' || !/^[A-Za-z0-9_+#.-]{1,48}$/.test(args.language)))) {
    throw new Error('Invalid artifact. Supply a short basename, title, kind, and complete text.');
  }
  const bytes = new TextEncoder().encode(args.content);
  if (bytes.byteLength > MAX_STORED_ARTIFACT_BYTES) throw new Error('Artifact exceeds two million UTF-8 bytes.');
  return { bytes, mimeType: args.kind === 'html' ? 'text/html' : args.kind === 'markdown' ? 'text/markdown' : 'text/plain',
    language: args.kind === 'html' ? 'html' : args.kind === 'markdown' ? 'markdown' : (args.language ?? 'text') };
}

export async function storeImmutable(bucket, key, bytes, digest) {
  // A retry converges on the same content-addressed object. Do not overwrite an
  // existing object, even if storage is damaged or misconfigured.
  const written = await bucket.put(key, bytes, {
    onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'application/octet-stream' },
    customMetadata: { sha256: digest },
  });
  if (!written) {
    const existing = await bucket.get(key);
    if (!existing || existing.size !== bytes.byteLength) throw new Error('Artifact object could not be verified.');
    const recovered = await existing.arrayBuffer();
    if (await sha256(recovered) !== digest) throw new Error('Artifact object failed integrity verification.');
  }
}

export function artifactTool(session, hooks) {
  return defineTool({
    name: 'write_artifact', description: 'Save a complete Markdown document, HTML page, or source-code file for the mobile artifact reader. Use this for substantial generated files. Each call creates an immutable revision.',
    replay: 'safe',
    parameters: Type.Object({
      kind: Type.Union([Type.Literal('markdown'), Type.Literal('html'), Type.Literal('code')]),
      filename: Type.String({ minLength: 1, maxLength: 120 }),
      title: Type.String({ minLength: 1, maxLength: 160 }),
      content: Type.String({ maxLength: MAX_STORED_ARTIFACT_BYTES }),
      language: Type.Optional(Type.String({ minLength: 1, maxLength: 48 })),
    }, { additionalProperties: false }),
    async execute(args, api, context) {
      const { bytes, mimeType, language } = artifactInput(args);
      const digest = await sha256(bytes);
      const stable = await api.memo('perch.artifact.identity', { id: crypto.randomUUID(), createdAt: Date.now() }, context);
      const metadata = session.metadata;
      const manifest = { id: stable.id, sessionId: metadata.id, title: args.title, filename: args.filename,
        mimeType, language, sha256: digest, bytes: bytes.byteLength, createdAt: stable.createdAt,
        sourceId: `tool:${metadata.id}:tool-task:${api.taskId}` };
      const key = artifactKey(metadata, digest);
      const existing = (await api.snapshot(SessionData, context))?.artifacts.find(item => item.id === manifest.id);
      if (existing && JSON.stringify(existing) !== JSON.stringify(manifest)) throw new Error('Artifact identity conflicts with recorded content.');
      await storeImmutable(session.env.ARTIFACTS, key, bytes, digest);
      await hooks.onArtifactStored?.(session, manifest);
      // Byte durability precedes a visible manifest. A crash before this commit
      // can leave an orphan blob; replay safely finishes the same manifest.
      await api.commit(async tx => {
        const doc = await tx.doc(SessionData);
        const previous = doc.artifacts.find(item => item.id === manifest.id);
        if (previous) {
          if (JSON.stringify(previous) !== JSON.stringify(manifest)) throw new Error('Artifact identity conflict.');
        } else {
          if (doc.artifacts.length >= 1000) throw new Error('This session reached its artifact limit.');
          doc.artifacts.push(manifest);
        }
      }, context);
      await hooks.onArtifactCommitted?.(session, manifest);
      await api.details({ artifactId: manifest.id, filename: manifest.filename, sha256: digest }, context);
      return { content: [{ type: 'text', text: `Saved ${manifest.filename} as artifact ${manifest.id}.` }] };
    },
  });
}

export const artifactKey = (metadata, digest) => `perch/v1/${metadata.workspaceId}/${metadata.id}/sha256/${digest}`;
export function attachmentHeaders(manifest) {
  return { 'Content-Type': 'application/octet-stream', 'Content-Length': String(manifest.bytes),
    'Content-Disposition': `attachment; filename="${manifest.filename}"`, 'ETag': `"${manifest.sha256}"`,
    'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" };
}
