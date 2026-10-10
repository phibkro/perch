export type SessionStatus = 'idle' | 'working' | 'needs-input';
export type ConnectionStatus = 'demo' | 'connecting' | 'live' | 'offline' | 'reconnecting' | 'ended' | 'error';

/** Transport and harness are independent of the selected model/provider. */
export interface HarnessMetadata {
  id: 'demo' | 'omp' | 'pi' | 'opencode' | 'pi-durable' | 'tern';
  name: string;
  transport: 'simulation' | 'omp-collab' | 'pi-rpc' | 'opencode-http' | 'durable-http' | 'remote-http';
  version?: string;
}
export interface ModelMetadata { id: string; name?: string; provider?: string }
/** Bounded host facts. Missing values stay unknown; usage covers the current branch. */
export interface SessionInsights {
  context?: { tokens: number; contextWindow: number; percent: number };
  thinking?: { level?: string; availableLevels: readonly string[] };
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost?: number; scope: 'current-branch' };
  tools?: readonly { name: string; description: string; active: boolean }[];
}
/** Implemented adapter features; readOnly and connection state still govern writes. */
export interface HarnessCapabilities {
  prompt: boolean;
  interrupt: boolean;
  questions: boolean;
  steer: boolean;
  attachments: boolean;
  modelSelection: boolean;
  sessionSelection: boolean;
  /** Absent on older hosts; only true when this adapter can create a session. */
  sessionCreation?: boolean;
  thinkingSelection?: boolean;
  sessionRename?: boolean;
  focusSession?: boolean;
}
export interface PiConnection { url: string; token: string }
/** A workspace token for the durable API; provider credentials remain on the server. */
export interface DurableConnection { url: string; token: string }
/** A device credential for the host session adapter, never a provider credential. */
export interface RemoteConnection { url: string; token: string }
/** Server authentication only. Model/provider credentials stay on the host. */
export interface OpenCodeConnection { url: string; username: string; password: string; directory?: string }

export interface SessionSummary {
  id: string;
  title: string;
  project: string;
  status: SessionStatus;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  createdAt: number;
  streaming?: boolean;
}

export interface ToolActivity {
  id: string;
  name: string;
  label: string;
  status: 'running' | 'done' | 'error' | 'interrupted' | 'unknown';
  detail: string;
  output?: string;
  progress?: number;
  /** Full content from a known write-tool input, never inferred from its log. */
  artifact?: { filename: string; content: string; language?: string };
}

export interface QuestionOption {
  id: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

export interface PendingQuestion {
  id: string;
  kind: 'choice' | 'editor';
  title: string;
  prompt: string;
  options?: QuestionOption[];
  initialValue?: string;
  /** Real answers remain visible until the host dismisses the request. */
  answering?: boolean;
  category?: 'question' | 'approval' | 'plan';
  document?: { title: string; content: string; format: 'markdown' | 'text' };
  disabledReason?: string;
  answerState?: 'sending' | 'forwarded' | 'unknown';
}

export interface AgentSummary {
  id: string;
  name: string;
  task: string;
  status: 'working' | 'idle' | 'done' | 'interrupted';
}

export interface SessionSnapshot {
  mode: 'demo' | 'collab' | 'pi' | 'opencode' | 'durable' | 'remote';
  /** Changes when the connection's credential scope changes, even on the same session ID. */
  connectionEpoch?: number;
  harness: HarnessMetadata;
  model?: ModelMetadata;
  availableModels?: readonly ModelMetadata[];
  capabilities: HarnessCapabilities;
  connection: { status: ConnectionStatus; label: string; error?: string };
  sessions: readonly SessionSummary[];
  activeSessionId: string;
  /** Retain the current transcript until a remote session change is authoritative. */
  sessionAction?: 'creating' | 'switching';
  messages: readonly Message[];
  tools: readonly ToolActivity[];
  storedArtifacts?: readonly StoredArtifact[];
  pendingQuestion: PendingQuestion | null;
  agents: readonly AgentSummary[];
  isWorking: boolean;
  displayName: string;
  readOnly: boolean;
  remote?: RemoteSessionView;
  insights?: SessionInsights;
}

/** Display metadata from the remote host; an absent attachment means browse only. */
export interface RemoteSessionView {
  host?: RemoteHealth['host'];
  epoch?: string;
  sessions: RemoteCatalog['sessions'];
  attached?: RemoteSnapshot['session'];
  synchronization: 'snapshot';
  truncated: boolean;
  notices: readonly string[];
}

/** The driver is deliberately independent of the app's native presentation. */
export interface CollabDriver {
  connect(): void;
  close(): void;
  sendPrompt(text: string): void;
  interrupt(): void;
  answerQuestion(question: PendingQuestion, answer: string): void;
  reconnect(): void;
  setModel?(provider: string, modelId: string): void;
  setThinking?(level: string): void;
  renameSession?(title: string): void;
  focusSession?(): void;
  selectSession?(sessionId: string): void;
  /** Stop observing this session without interrupting or terminating its host. */
  detachSession?(): void;
  createSession?(): Promise<string | undefined>;
  loadArtifact?(artifact: StoredArtifact): Promise<string>;
}

export interface CollabUpdate {
  harness: HarnessMetadata;
  model?: ModelMetadata;
  availableModels?: readonly ModelMetadata[];
  capabilities: HarnessCapabilities;
  connection: SessionSnapshot['connection'];
  session: SessionSummary;
  /** Remote history, when the harness can list and select independent sessions. */
  sessions?: readonly SessionSummary[];
  sessionAction?: SessionSnapshot['sessionAction'];
  messages: readonly Message[];
  tools: readonly ToolActivity[];
  storedArtifacts?: readonly StoredArtifact[];
  pendingQuestion: PendingQuestion | null;
  agents: readonly AgentSummary[];
  isWorking: boolean;
  readOnly: boolean;
  remote?: RemoteSessionView;
  insights?: SessionInsights;
}

export type HarnessDriver = CollabDriver;
export type HarnessUpdate = CollabUpdate;
import type { StoredArtifact } from '../harness/durable.js';
import type { RemoteCatalog, RemoteHealth, RemoteSnapshot } from '../harness/remote.js';
