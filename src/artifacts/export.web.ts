import type { ReadableArtifact } from './types';
import { safeFilename } from './model';

export async function exportArtifact(artifact: ReadableArtifact): Promise<string> {
  const mime = artifact.kind === 'html' ? 'text/html' : artifact.kind === 'markdown' ? 'text/markdown' : 'text/plain';
  const url = URL.createObjectURL(new Blob([artifact.content], { type: mime + ';charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = safeFilename(artifact.filename); anchor.rel = 'noopener';
  document.body.appendChild(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return 'Download started.';
}
