import type { SessionStore } from '../session/store';
import { connectionUrl, MAX_SAVED_WORKSPACES, parseManifest, validateCredentials, type Deployment, type SavedWorkspace, type WorkspaceCredentials, type WorkspaceManifest } from './protocol';
import type { WorkspacePersistence } from './persistence';

export type WorkspaceSummary = Omit<SavedWorkspace, 'token'>;
export type ConnectionSummary = { id: string; name: string; kind: 'durable' | 'pi' | 'opencode' | 'omp' };
export type WorkspaceSnapshot = {
  loaded: boolean; busy: boolean; persistent: boolean; profiles: WorkspaceSummary[];
  active?: WorkspaceSummary; connections: ConnectionSummary[]; selectedConnectionId?: string;
  error?: string; storageError?: string;
};
type Sessions = Pick<SessionStore, 'connectDurable' | 'connectPi' | 'connectOpenCode' | 'connectCollab' | 'useDemo'>;
type Dependencies = {
  sessions: Sessions; persistence: WorkspacePersistence;
  discover: (credentials: WorkspaceCredentials, signal: AbortSignal) => Promise<WorkspaceManifest>;
  newId?: () => string;
};
const publicProfile = ({ token: _token, ...profile }: SavedWorkspace): WorkspaceSummary => ({ ...profile });

/** Workspace discovery owns connection credentials; the session store still owns chat state. */
export class WorkspaceManager {
  private profiles: SavedWorkspace[] = [];
  private manifest?: WorkspaceManifest;
  private active?: SavedWorkspace;
  private listeners = new Set<() => void>();
  private generation = 0;
  private controller?: AbortController;
  private loading?: Promise<void>;
  private deleting = false;
  private snapshot: WorkspaceSnapshot;
  constructor(private readonly dependencies: Dependencies) {
    this.snapshot = { loaded: false, busy: false, persistent: dependencies.persistence.durable, profiles: [], connections: [] };
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.snapshot;
  private publish(patch: Partial<WorkspaceSnapshot> = {}) {
    this.snapshot = { ...this.snapshot, ...patch,
      profiles: this.profiles.map(publicProfile), active: this.active && publicProfile(this.active),
      connections: this.manifest?.connections.map(({ id, name, kind }) => ({ id, name, kind })) ?? [],
      selectedConnectionId: this.active?.lastConnectionId,
    };
    for (const listener of this.listeners) listener();
  }
  initialize = (): Promise<void> => {
    if (!this.loading) this.loading = this.dependencies.persistence.load().then(profiles => {
      this.profiles = profiles; this.publish({ loaded: true });
    }).catch(() => {
      this.publish({ loaded: true, storageError: 'Saved workspaces could not be read. Unlock this device and reopen the app. You can still pair for this visit.' });
    });
    return this.loading;
  };

  private async connect(credentials: WorkspaceCredentials, expected?: SavedWorkspace, expectedDeployment?: Deployment): Promise<void> {
    await this.initialize();
    if (this.deleting) throw new Error('Wait for workspace removal to finish before connecting.');
    const current = ++this.generation; this.controller?.abort();
    const controller = new AbortController(); this.controller = controller;
    const timeout = setTimeout(() => controller.abort(), 15_000);
    this.publish({ busy: true, error: undefined });
    try {
      const verified = validateCredentials(credentials);
      const manifest = parseManifest(await this.dependencies.discover(verified, controller.signal));
      if (current !== this.generation) return;
      if (controller.signal.aborted) throw new Error('Workspace discovery timed out.');
      if (expected && manifest.workspace.id !== expected.workspaceId) throw new Error('This address now identifies a different workspace. Pair again with its current code.');
      if (expectedDeployment && manifest.workspace.deployment !== expectedDeployment) throw new Error(`This code belongs to a ${manifest.workspace.deployment === 'cloudflare' ? 'Cloudflare' : 'self-hosted'} workspace. Choose that setup option and try again.`);
      const previous = expected ?? this.profiles.find(item => item.url === verified.url && item.workspaceId === manifest.workspace.id);
      if (!previous && this.profiles.length >= MAX_SAVED_WORKSPACES) throw new Error('Remove a saved workspace before adding another.');
      const profile: SavedWorkspace = { ...verified, id: previous?.id ?? this.dependencies.newId?.() ?? `workspace-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
        workspaceId: manifest.workspace.id, name: manifest.workspace.name, deployment: manifest.workspace.deployment,
        lastConnectionId: previous && manifest.connections.some(item => item.id === previous.lastConnectionId) ? previous.lastConnectionId : manifest.defaultConnectionId };
      this.active = profile; this.manifest = manifest;
      this.profiles = [...this.profiles.filter(item => item.id !== profile.id), profile];
      await this.remember(profile);
      if (current !== this.generation) return;
      await this.startConnection(profile.lastConnectionId);
    } catch (error) {
      if (current !== this.generation) return;
      const message = controller.signal.aborted ? 'The workspace did not respond in time. Check its address and network, then try again.' : error instanceof Error ? error.message : 'The workspace could not be loaded.';
      this.publish({ error: message }); throw new Error(message);
    } finally { clearTimeout(timeout); if (current === this.generation) this.publish({ busy: false }); }
  }
  private async remember(profile: SavedWorkspace) {
    try { await this.dependencies.persistence.put(profile); this.publish({ storageError: undefined }); }
    catch { this.publish({ storageError: 'This connection works for this visit, but its token could not be saved on this device. Pair again after restarting.' }); }
  }
  private startConnection(id: string): Promise<void> {
    const profile = this.active; const connection = this.manifest?.connections.find(item => item.id === id);
    if (!profile || !connection) return Promise.reject(new Error('This harness is no longer available. Reconnect the workspace to refresh its list.'));
    this.active = { ...profile, lastConnectionId: id };
    this.profiles = this.profiles.map(item => item.id === profile.id ? this.active! : item);
    this.publish();
    const sessions = this.dependencies.sessions;
    if (connection.kind === 'omp') return sessions.connectCollab(connection.collabLink, 'Perch');
    const url = connectionUrl(profile, connection);
    if (connection.kind === 'durable') return sessions.connectDurable({ url, token: profile.token });
    if (connection.kind === 'pi') return sessions.connectPi({ url, token: profile.token });
    return sessions.connectOpenCode({ url, username: 'perch', password: profile.token });
  }
  join = (credentials: WorkspaceCredentials, deployment?: Deployment): Promise<void> => this.connect(credentials, undefined, deployment);
  open = async (id: string): Promise<void> => {
    await this.initialize(); const profile = this.profiles.find(item => item.id === id);
    if (!profile) throw new Error('This saved workspace is no longer available.');
    await this.connect(profile, profile);
  };
  chooseConnection = async (id: string): Promise<void> => {
    if (this.snapshot.busy || this.deleting) return;
    const current = ++this.generation; this.controller?.abort();
    await this.startConnection(id);
    if (current === this.generation && !this.deleting && this.active) await this.remember(this.active);
  };
  /** Leaving the workspace does not cancel work on the host. */
  detach = (): void => {
    ++this.generation; this.controller?.abort(); this.active = undefined; this.manifest = undefined;
    this.publish({ busy: false, error: undefined });
  };
  forget = async (id: string): Promise<void> => {
    if (this.deleting) throw new Error('Wait for workspace removal to finish.');
    this.deleting = true;
    // Invalidate discovery before deletion so a slow response cannot save it again.
    ++this.generation; this.controller?.abort();
    this.publish({ busy: true });
    try {
      await this.initialize();
      await this.dependencies.persistence.remove(id);
      if (this.active?.id === id) { this.detach(); this.dependencies.sessions.useDemo(); }
      this.profiles = this.profiles.filter(item => item.id !== id); this.publish({ storageError: undefined });
    } finally { this.deleting = false; this.publish({ busy: false }); }
  };
}
