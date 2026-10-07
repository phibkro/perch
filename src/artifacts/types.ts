import type { StoredArtifact } from '../harness/durable';

/** Display metadata is independent of where the file's bytes are held. */
interface ArtifactDetails {
  id: string;
  title: string;
  filename: string;
  kind: 'markdown' | 'html' | 'code';
  language: string;
  sourceId: string;
  sourceLabel: string;
  createdAt: number;
  streaming: boolean;
}

/** Only a readable artifact can be copied, exported, or passed to a renderer. */
export interface ReadableArtifact extends ArtifactDetails {
  content: string;
  stored?: StoredArtifact;
}

/** A saved reference is not an empty generated file. */
export type Artifact = ReadableArtifact | (ArtifactDetails & {
  stored: StoredArtifact;
  content?: undefined;
});

export type ArtifactLoader = (reference: StoredArtifact) => Promise<string>;

export interface ArtifactMessage {
  id: string;
  role: string;
  text: string;
  createdAt: number;
  streaming?: boolean;
}

export interface ArtifactTool {
  id: string;
  label: string;
  status: string;
  output?: string;
  artifact?: { filename: string; content: string; language?: string };
}
