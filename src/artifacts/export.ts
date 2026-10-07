import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import type { ReadableArtifact } from './types';
import { safeFilename } from './model';

export async function exportArtifact(artifact: ReadableArtifact): Promise<string> {
  if (!await Sharing.isAvailableAsync()) throw new Error('File sharing is unavailable on this device.');
  const directory = new Directory(Paths.cache, 'perch-exports', String(Date.now()));
  directory.create({ intermediates: true, idempotent: true });
  const file = new File(directory, safeFilename(artifact.filename));
  file.write(artifact.content);
  await Sharing.shareAsync(file.uri, {
    dialogTitle: artifact.filename,
    mimeType: artifact.kind === 'html' ? 'text/html' : artifact.kind === 'markdown' ? 'text/markdown' : 'text/plain',
  });
  return 'Export opened. Choose an app or location to keep the file.';
}
