import { sessionStore } from '../session';
import { discoverWorkspace } from './discovery';
import { WorkspaceManager } from './manager';
import { workspacePersistence } from './storage';

export const workspaceManager = new WorkspaceManager({ sessions: sessionStore, discover: discoverWorkspace, persistence: workspacePersistence });
export { parsePairingCode, validateCredentials } from './protocol';
export type { Deployment, WorkspaceCredentials } from './protocol';
export type { WorkspaceSnapshot, WorkspaceSummary } from './manager';
