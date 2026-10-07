import type { StoredArtifact } from '../harness/durable';
import type { Artifact, ArtifactLoader, ReadableArtifact } from './types';

type LoadIdentity = { key: string; loader: ArtifactLoader };
export type ArtifactLoad = LoadIdentity & (
  { status: 'loading' } |
  { status: 'ready'; content: string } |
  { status: 'error'; message: string }
);

export type ArtifactReadState =
  | { status: 'ready'; artifact: ReadableArtifact }
  | { status: 'loading' }
  | { status: 'unavailable' }
  | { status: 'error'; message: string };

/** Stable across snapshot objects; changed metadata invalidates an earlier load. */
export function artifactReferenceKey(reference: StoredArtifact): string {
  return JSON.stringify([reference.sessionId, reference.id, reference.sha256, reference.bytes,
    reference.mimeType, reference.filename, reference.language, reference.title,
    reference.sourceId, reference.createdAt]);
}

/** A connection change hides earlier bytes immediately, before React effects. */
export function artifactReadState(artifact: Artifact, load: ArtifactLoad | null, loader?: ArtifactLoader): ArtifactReadState {
  if (!artifact.stored) return typeof artifact.content === 'string'
    ? { status: 'ready', artifact: { ...artifact, content: artifact.content } }
    : { status: 'unavailable' };
  if (!loader) return { status: 'unavailable' };
  if (!load || load.loader !== loader || load.key !== artifactReferenceKey(artifact.stored)) return { status: 'loading' };
  if (load.status === 'ready') return { status: 'ready', artifact: { ...artifact, content: load.content } };
  if (load.status === 'error') return { status: 'error', message: load.message };
  return { status: 'loading' };
}

/** The driver authenticates and verifies bytes; this layer only owns display lifetime. */
export function beginArtifactLoad(reference: StoredArtifact, loader: ArtifactLoader, publish: (load: ArtifactLoad) => void): () => void {
  let active = true;
  const identity = { key: artifactReferenceKey(reference), loader };
  publish({ ...identity, status: 'loading' });
  void Promise.resolve().then(() => active ? loader(reference) : undefined).then(content => {
    if (!active) return;
    if (typeof content !== 'string') throw new Error('The host did not return readable artifact content.');
    publish({ ...identity, status: 'ready', content });
  }).catch(error => {
    if (active) publish({ ...identity, status: 'error', message: error instanceof Error ? error.message : 'This saved artifact could not be opened.' });
  });
  // The public loader need not support AbortSignal. A late network result is
  // discarded after selection changes, connection changes, retry, or unmount.
  return () => { active = false; };
}
