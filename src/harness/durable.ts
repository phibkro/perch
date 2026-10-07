import type { HarnessUpdate, ModelMetadata, SessionSummary } from '../session/types.js';

/** Perch's durable HTTP contract. Provider and Pi internals remain on the host. */
export const DURABLE_PROTOCOL = 1;
export const DURABLE_SERVICE = 'perch-durable';
export const MAX_DURABLE_PROMPT = 100_000;
export const MAX_STORED_ARTIFACT_BYTES = 2_000_000;

export interface StoredArtifact {
  id: string;
  sessionId: string;
  title: string;
  filename: string;
  mimeType: string;
  language: string;
  /** Content hash also identifies this immutable artifact revision. */
  sha256: string;
  bytes: number;
  createdAt: number;
  sourceId: string;
}

export interface DurableHealth {
  service: typeof DURABLE_SERVICE;
  protocol: typeof DURABLE_PROTOCOL;
  harness: { name: 'Pi Durable'; version: string };
  models: readonly ModelMetadata[];
  /** Explicitly labeled when the server uses the integration-test provider. */
  synthetic: boolean;
}

export interface DurableReceipt {
  operationId: string;
  session: string;
  accepted: boolean;
}

export interface DurableOperation {
  operationId: string;
  status: 'queued' | 'running' | 'done' | 'unanswered';
}

export interface DurableSnapshot {
  protocol: typeof DURABLE_PROTOCOL;
  state: HarnessUpdate;
  operations: readonly DurableOperation[];
}

export interface DurableSessionList { sessions: readonly SessionSummary[] }
export interface DurableCreateResult { session: SessionSummary; accepted: boolean }
