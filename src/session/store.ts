import type { CollabDriver, CollabUpdate, Message, PendingQuestion, SessionSnapshot, SessionSummary, ToolActivity, AgentSummary, PiConnection, OpenCodeConnection, DurableConnection, RemoteConnection } from './types';
import type { StoredArtifact } from '../harness/durable';
import { DEMO_CAPABILITIES, DEMO_HARNESS, OMP_CAPABILITIES, OMP_HARNESS, PI_CAPABILITIES, PI_HARNESS, OPENCODE_CAPABILITIES, OPENCODE_HARNESS, DURABLE_CAPABILITIES, DURABLE_HARNESS, REMOTE_CAPABILITIES, REMOTE_HARNESS } from '../harness/capabilities';
import { DEMO_ARTIFACT_REPLY } from '../harness/demo-artifacts';

type Thread = {
  summary: SessionSummary;
  messages: Message[];
  tools: ToolActivity[];
  question: PendingQuestion | null;
  agents: AgentSummary[];
};

const DEMO_CONNECTION = { status: 'demo' as const, label: 'Demo · simulated server' };
let sequence = 0;
const id = (prefix: string) => `${prefix}-${++sequence}`;
const message = (role: Message['role'], text: string): Message => ({ id: id('message'), role, text, createdAt: Date.now() });

function emptyThread(): Thread {
  return {
    summary: { id: id('chat'), title: 'New chat', project: 'Demo', status: 'idle' },
    messages: [], tools: [], question: null, agents: [],
  };
}

function seedThreads(): Map<string, Thread> {
  const starter = emptyThread();
  return new Map<string, Thread>([
    [starter.summary.id, starter],
    ['artifacts', {
      summary: { id: 'artifacts', title: 'A workspace you can preview', project: 'artifact-examples', status: 'idle' },
      messages: [message('user', 'Make a short plan, an HTML card, and a TypeScript helper for the mobile workspace.'), message('assistant', DEMO_ARTIFACT_REPLY)],
      tools: [], question: null, agents: [],
    }],
    ['mobile', {
      summary: { id: 'mobile', title: 'Mobile companion', project: 'tern-pocket', status: 'idle' },
      messages: [
        message('user', 'Help me make a calmer mobile workspace.'),
        message('assistant', 'The native layout is ready to review. One check needs attention: the composer can overlap the keyboard on a small screen. Ask me to investigate and I’ll walk through a simulated fix.'),
      ],
      tools: [{ id: 'seed-check', name: 'check', label: 'Check mobile layout', status: 'error', detail: '1 layout check needs attention', output: 'composer.keyboard-inset\nExpected: composer above the keyboard\nObserved: composer overlaps by 24 px', progress: 1 }],
      question: null,
      agents: [{ id: 'layout-agent', name: 'Layout reviewer', task: 'Small-screen layout review', status: 'idle' }],
    }],
    ['design', {
      summary: { id: 'design', title: 'A calmer mobile workspace', project: 'design-notes', status: 'idle' },
      messages: [message('user', 'What should a phone-sized assistant feel like?'), message('assistant', 'One conversation at a time. Put the current question within reach, collapse routine tool output, and make reconnecting easy to understand. This is a separate synthetic conversation.')],
      tools: [], question: null, agents: [],
    }],
    ['handoff', {
      summary: { id: 'handoff', title: 'Reconnect without losing context', project: 'session-bridge', status: 'idle' },
      messages: [message('user', 'What happens when I put my phone away?'), message('assistant', 'The server can keep working while the phone disconnects. Start a demo turn here, then use Disconnect and Reconnect to see this conversation catch up. No prompt is resent.')],
      tools: [], question: null, agents: [],
    }],
  ]);
}

/** A single authoritative demo host, with a distinct history and job per thread. */
export class SessionStore {
  private listeners = new Set<() => void>();
  private threads = seedThreads();
  private active = this.threads.keys().next().value!;
  private snapshot!: SessionSnapshot;
  private mode: SessionSnapshot['mode'] = 'demo';
  private connection: SessionSnapshot['connection'] = DEMO_CONNECTION;
  private displayName = 'You';
  private jobs = new Map<string, { token: object; timer?: ReturnType<typeof setTimeout> }>();
  private disconnected = false;
  private driver: CollabDriver | null = null;
  private connectionGeneration = 0;
  private liveUpdate: CollabUpdate | null = null;
  private disposed = false;

  constructor() { this.publish(); }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): SessionSnapshot => this.snapshot;

  private publish() {
    if (this.disposed) return;
    if (this.mode !== 'demo') {
      const live = this.liveUpdate;
      this.snapshot = {
        mode: this.mode, connection: { ...this.connection }, displayName: this.displayName, connectionEpoch: this.connectionGeneration,
        harness: live?.harness ?? ({ pi: PI_HARNESS, collab: OMP_HARNESS, opencode: OPENCODE_HARNESS, durable: DURABLE_HARNESS, remote: REMOTE_HARNESS }[this.mode]),
        capabilities: live?.capabilities ?? ({ pi: PI_CAPABILITIES, collab: OMP_CAPABILITIES, opencode: OPENCODE_CAPABILITIES, durable: DURABLE_CAPABILITIES, remote: REMOTE_CAPABILITIES }[this.mode]),
        model: live?.model, availableModels: live?.availableModels,
        sessions: live ? (live.sessions ?? [live.session]).map(session => ({ ...session })) : [], activeSessionId: live?.session.id ?? 'connecting',
        sessionAction: live?.sessionAction,
        messages: live ? [...live.messages] : [], tools: live ? [...live.tools] : [],
        storedArtifacts: live?.storedArtifacts?.map(artifact => ({ ...artifact })) ?? [],
        pendingQuestion: live?.pendingQuestion ? { ...live.pendingQuestion } : null,
        agents: live ? [...live.agents] : [], isWorking: live?.isWorking ?? false, readOnly: live?.readOnly ?? true,
        remote: live?.remote, insights: live?.insights,
      };
    } else if (this.disconnected && this.snapshot?.mode === 'demo') {
      // The simulated host continues privately; the disconnected phone retains its last view.
      this.snapshot = { ...this.snapshot, connection: { ...this.connection } };
    } else {
      const thread = this.threads.get(this.active)!;
      this.snapshot = {
        mode: 'demo', connection: { ...this.connection }, displayName: this.displayName, connectionEpoch: this.connectionGeneration,
        harness: DEMO_HARNESS, capabilities: DEMO_CAPABILITIES,
        sessions: [...this.threads.values()].map(t => ({ ...t.summary })), activeSessionId: this.active,
        messages: thread.messages.map(m => ({ ...m })), tools: thread.tools.map(t => ({ ...t })),
        storedArtifacts: [],
        pendingQuestion: thread.question ? { ...thread.question } : null,
        agents: thread.agents.map(a => ({ ...a })), isWorking: thread.summary.status === 'working', readOnly: false,
      };
    }
    for (const listener of this.listeners) listener();
  }

  selectSession = (sessionId: string): void => {
    if (this.disposed) return;
    if (this.mode !== 'demo') {
      if (this.connection.status === 'live' && this.liveUpdate?.capabilities.sessionSelection && !this.liveUpdate.sessionAction && this.snapshot.sessions.some(session => session.id === sessionId)) this.driver?.selectSession?.(sessionId);
      return;
    }
    if (this.disconnected || !this.threads.has(sessionId)) return;
    this.active = sessionId;
    this.publish();
  };

  /** Leave the live attachment; the host runtime and its work keep running. */
  detachSession = (): void => {
    if (!this.disposed && this.mode === 'remote') this.driver?.detachSession?.();
  };

  startNewChat = (): string | undefined => {
    if (this.disposed || this.mode !== 'demo' || this.disconnected) return;
    const thread = emptyThread();
    this.threads = new Map([[thread.summary.id, thread], ...this.threads]);
    this.active = thread.summary.id;
    this.publish();
    return this.active;
  };

  /** The driver owns remote create identity and any protocol-specific reconciliation. */
  createSession = async (): Promise<string | undefined> => {
    if (this.disposed) return;
    if (this.mode === 'demo') return this.startNewChat();
    const live = this.liveUpdate;
    if (this.connection.status !== 'live' || !live?.capabilities.sessionCreation || live.readOnly || live.sessionAction || !this.driver?.createSession) return;
    const generation = this.connectionGeneration;
    const created = await this.driver.createSession();
    if (generation !== this.connectionGeneration || this.disposed) return;
    return created;
  };

  sendPrompt = (text: string): void => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (this.mode !== 'demo') {
      if (this.connection.status === 'live' && this.liveUpdate?.capabilities.prompt && !this.liveUpdate.readOnly && !this.liveUpdate.sessionAction && this.liveUpdate.session.status !== 'needs-input') this.driver?.sendPrompt(trimmed);
      return;
    }
    if (this.disconnected) return;
    const thread = this.threads.get(this.active)!;
    if (thread.summary.status !== 'idle') return;
    if (thread.messages.length === 0) {
      const title = Array.from(trimmed.replace(/\s+/g, ' '));
      thread.summary.title = title.length > 56 ? `${title.slice(0, 55).join('')}…` : title.join('');
    }
    thread.messages.push(message('user', trimmed));
    thread.question = null;
    thread.summary.status = 'working';
    if (thread.summary.id === 'artifacts') {
      const token = this.beginJob(thread.summary.id);
      this.stream(thread, token, DEMO_ARTIFACT_REPLY, () => this.finish(thread));
      this.publish(); return;
    }
    thread.agents = [{ id: 'layout-agent', name: 'Layout reviewer', task: 'Checking the native composer', status: 'working' }];
    const token = this.beginJob(thread.summary.id);
    this.stream(thread, token, 'I’ll check the keyboard inset and the composer spacing. This demo simulates server-side work; no files or commands are being run.', () => {
      const tool: ToolActivity = { id: id('tool'), name: 'read', label: 'Inspect composer layout', status: 'running', detail: 'Reading the synthetic layout fixture', progress: 0.1 };
      thread.tools.push(tool); this.publish();
      this.later(thread.summary.id, token, 650, () => {
        tool.progress = 0.55; tool.detail = 'Checking keyboard and safe-area insets'; this.publish();
        this.later(thread.summary.id, token, 700, () => {
          tool.progress = 1; tool.status = 'done'; tool.detail = 'Found two insets applied to one composer';
          tool.output = 'Synthetic finding\nKeyboard inset: 24 px\nExtra composer inset: 24 px\nProposed fix: use one keyboard-aware inset.';
          this.stream(thread, token, 'The simulated check found a doubled inset. I can apply the proposed adjustment and rerun the check, or explain the change first.', () => {
            thread.summary.status = 'needs-input';
            thread.agents[0].status = 'idle';
            thread.question = {
              id: id('question'), kind: 'choice', title: 'How should I proceed?',
              prompt: 'Choose the next step for the demo layout fix.',
              options: [
                { id: 'fix', label: 'Apply fix and rerun', description: 'Simulate the adjustment and verification.' },
                { id: 'instructions', label: 'Add instructions', description: 'Write a note before the next step.' },
                { id: 'explain', label: 'Explain only', description: 'Keep the current layout.' },
              ],
            };
            this.jobs.delete(thread.summary.id); this.publish();
          });
        });
      });
    });
    this.publish();
  };

  interrupt = (): void => {
    if (this.mode !== 'demo') {
      if (this.connection.status === 'live' && !this.liveUpdate?.readOnly && !this.liveUpdate?.sessionAction) this.driver?.interrupt();
      return;
    }
    if (this.disconnected) return;
    const thread = this.threads.get(this.active)!;
    if (thread.summary.status === 'idle') return;
    this.cancelJob(thread.summary.id);
    thread.question = null;
    thread.summary.status = 'idle';
    thread.messages = thread.messages.map(m => ({ ...m, streaming: false }));
    thread.tools.forEach(t => { if (t.status === 'running') { t.status = 'interrupted'; t.detail = 'Stopped by you'; } });
    thread.agents.forEach(a => { a.status = 'idle'; });
    thread.messages.push(message('system', 'Demo work interrupted. You can send a new message.'));
    this.publish();
  };

  /** Pass the displayed questionId to prevent an old sheet answering a newer question. */
  answerQuestion = (answer: string, questionId?: string): void => {
    if (this.mode !== 'demo') {
      const q = this.liveUpdate?.pendingQuestion;
      if (this.connection.status !== 'live' || this.liveUpdate?.readOnly || this.liveUpdate?.sessionAction || !q || q.answering || (questionId && questionId !== q.id)) return;
      this.driver?.answerQuestion(q, answer);
      return;
    }
    if (this.disconnected) return;
    const thread = this.threads.get(this.active)!;
    const q = thread.question;
    if (!q || (questionId && questionId !== q.id)) return;
    if (q.kind === 'choice' && !q.options?.some(option => option.id === answer)) return;
    if (q.kind === 'choice' && answer === 'instructions') {
      thread.question = { id: id('question'), kind: 'editor', title: 'Add a note', prompt: 'What should the assistant keep in mind?', initialValue: 'Keep the composer comfortable to use with one hand.' };
      this.publish(); return;
    }
    thread.question = null;
    thread.messages.push(message('user', q.kind === 'editor' ? (answer.trim() || 'Continue with the proposed fix.') : q.options!.find(o => o.id === answer)!.label));
    thread.summary.status = 'working';
    const token = this.beginJob(thread.summary.id);
    if (answer === 'explain' && q.kind === 'choice') {
      this.stream(thread, token, 'Use a single keyboard-aware inset around the composer, then apply the device safe area once. In this simulation, that removes the 24 px overlap. No changes were applied.', () => this.finish(thread));
      return;
    }
    const tool: ToolActivity = { id: id('tool'), name: 'check', label: 'Rerun layout check', status: 'running', detail: 'Applying the synthetic adjustment', progress: 0.1 };
    thread.tools.push(tool); this.publish();
    this.later(thread.summary.id, token, 550, () => {
      tool.detail = 'Checking small-screen and keyboard cases'; tool.progress = 0.65; this.publish();
      this.later(thread.summary.id, token, 850, () => {
        tool.status = 'done'; tool.progress = 1; tool.detail = '3 simulated layout checks passed';
        tool.output = 'PASS composer.keyboard-inset\nPASS composer.safe-area\nPASS composer.large-text';
        this.stream(thread, token, 'The demo check now passes. The composer stays above the keyboard, the bottom inset is applied once, and the larger-text case still fits. Your real workspace has not been changed.', () => this.finish(thread));
      });
    });
  };

  simulateDisconnect = (): void => {
    if (this.mode !== 'demo' || this.disconnected) return;
    this.disconnected = true;
    this.connection = { status: 'offline', label: 'Demo · phone disconnected' };
    this.publish();
  };

  reconnect = (): void => {
    if (this.mode !== 'demo') { this.driver?.reconnect(); return; }
    if (!this.disconnected || this.connection.status === 'reconnecting') return;
    this.connection = { status: 'reconnecting', label: 'Demo · catching up' }; this.publish();
    const generation = this.connectionGeneration;
    setTimeout(() => {
      if (this.mode !== 'demo' || generation !== this.connectionGeneration || this.disposed) return;
      this.disconnected = false; this.connection = DEMO_CONNECTION; this.publish();
    }, 650);
  };

  connectCollab = async (link: string, name = 'Perch'): Promise<void> => {
    const generation = ++this.connectionGeneration;
    this.driver?.close(); this.driver = null;
    this.cancelAllJobs();
    this.mode = 'collab'; this.liveUpdate = null; this.disconnected = false;
    this.displayName = name.trim() || 'Perch';
    this.connection = { status: 'connecting', label: 'Connecting to OMP' }; this.publish();
    try {
      const { createCollabDriver } = await import('./collab');
      const driver = await createCollabDriver(link.trim(), this.displayName, update => {
        if (generation !== this.connectionGeneration || this.disposed) return;
        this.liveUpdate = update; this.connection = update.connection; this.publish();
      });
      if (generation !== this.connectionGeneration || this.disposed) { driver.close(); return; }
      this.driver = driver;
      driver.connect();
    } catch (error) {
      if (generation !== this.connectionGeneration || this.disposed) return;
      this.connection = { status: 'error', label: 'Could not connect', error: error instanceof Error ? error.message : 'Connection failed.' };
      this.publish();
    }
  };

  /** An explicit user submission is the only path that starts a pi connection. */
  connectPi = async (config: PiConnection, name = 'Perch'): Promise<void> => {
    const generation = ++this.connectionGeneration;
    this.driver?.close(); this.driver = null;
    this.cancelAllJobs(); this.mode = 'pi'; this.liveUpdate = null; this.disconnected = false;
    this.displayName = name.trim() || 'Perch';
    this.connection = { status: 'connecting', label: 'Connecting to pi' }; this.publish();
    try {
      const { createPiDriver } = await import('./pi');
      const driver = createPiDriver(config, update => {
        if (generation !== this.connectionGeneration || this.disposed) return;
        this.liveUpdate = update; this.connection = update.connection; this.publish();
      });
      if (generation !== this.connectionGeneration || this.disposed) { driver.close(); return; }
      this.driver = driver; driver.connect();
    } catch (error) {
      if (generation !== this.connectionGeneration || this.disposed) return;
      this.connection = { status: 'error', label: 'Could not connect', error: error instanceof Error ? error.message : 'Connection failed.' };
      this.publish();
    }
  };

  connectOpenCode = async (config: OpenCodeConnection, name = 'Perch'): Promise<void> => {
    const generation = ++this.connectionGeneration;
    this.driver?.close(); this.driver = null;
    this.cancelAllJobs(); this.mode = 'opencode'; this.liveUpdate = null; this.disconnected = false;
    this.displayName = name.trim() || 'Perch';
    this.connection = { status: 'connecting', label: 'Connecting to OpenCode' }; this.publish();
    try {
      const { createOpenCodeDriver } = await import('./opencode');
      const driver = await createOpenCodeDriver(config, update => {
        if (generation !== this.connectionGeneration || this.disposed) return;
        this.liveUpdate = update; this.connection = update.connection; this.publish();
      });
      if (generation !== this.connectionGeneration || this.disposed) { driver.close(); return; }
      this.driver = driver; driver.connect();
    } catch (error) {
      if (generation !== this.connectionGeneration || this.disposed) return;
      this.connection = { status: 'error', label: 'Could not connect', error: error instanceof Error ? error.message : 'Connection failed.' };
      this.publish();
    }
  };

  connectDurable = async (config: DurableConnection, name = 'Perch'): Promise<void> => {
    const generation = ++this.connectionGeneration;
    this.driver?.close(); this.driver = null;
    this.cancelAllJobs(); this.mode = 'durable'; this.liveUpdate = null; this.disconnected = false;
    this.displayName = name.trim() || 'Perch';
    this.connection = { status: 'connecting', label: 'Connecting to Pi Durable' }; this.publish();
    try {
      const { createDurableDriver } = await import('./durable');
      const driver = await createDurableDriver(config, update => {
        if (generation !== this.connectionGeneration || this.disposed) return;
        this.liveUpdate = update; this.connection = update.connection; this.publish();
      });
      if (generation !== this.connectionGeneration || this.disposed) { driver.close(); return; }
      this.driver = driver; driver.connect();
    } catch (error) {
      if (generation !== this.connectionGeneration || this.disposed) return;
      this.connection = { status: 'error', label: 'Could not connect', error: error instanceof Error ? error.message : 'Connection failed.' };
      this.publish();
    }
  };

  /** Connecting lists host sessions. Only a later selection attaches a transcript. */
  connectRemote = async (config: RemoteConnection, name = 'Perch'): Promise<void> => {
    const generation = ++this.connectionGeneration;
    this.driver?.close(); this.driver = null;
    this.cancelAllJobs(); this.mode = 'remote'; this.liveUpdate = null; this.disconnected = false;
    this.displayName = name.trim() || 'Perch';
    this.connection = { status: 'connecting', label: 'Connecting to host sessions' }; this.publish();
    try {
      const { createRemoteDriver } = await import('./remote');
      const driver = createRemoteDriver(config, update => {
        if (generation !== this.connectionGeneration || this.disposed) return;
        this.liveUpdate = update; this.connection = update.connection; this.publish();
      });
      if (generation !== this.connectionGeneration || this.disposed) { driver.close(); return; }
      this.driver = driver; driver.connect();
    } catch (error) {
      if (generation !== this.connectionGeneration || this.disposed) return;
      this.connection = { status: 'error', label: 'Could not connect', error: error instanceof Error ? error.message : 'Connection failed.' };
      this.publish();
    }
  };

  /** Only fetch an immutable reference from the currently selected credential scope. */
  loadArtifact = async (reference: StoredArtifact): Promise<string> => {
    const generation = this.connectionGeneration;
    const sessionId = this.liveUpdate?.session.id;
    const artifact = this.liveUpdate?.storedArtifacts?.find(item =>
      item.id === reference.id && item.sha256 === reference.sha256 && item.sessionId === reference.sessionId);
    if (this.disposed || !this.driver?.loadArtifact || !artifact || artifact.sessionId !== sessionId) {
      throw new Error('This artifact is no longer available in the selected workspace.');
    }
    const content = await this.driver.loadArtifact(artifact);
    if (this.disposed || generation !== this.connectionGeneration || sessionId !== this.liveUpdate?.session.id) {
      throw new Error('The workspace changed while the artifact was opening. Open it again.');
    }
    return content;
  };

  setModel = (provider: string, modelId: string): void => {
    if (this.mode === 'demo' || this.connection.status !== 'live' || this.liveUpdate?.readOnly || !this.liveUpdate?.capabilities.modelSelection || this.liveUpdate.isWorking || this.liveUpdate.pendingQuestion || this.liveUpdate.sessionAction) return;
    this.driver?.setModel?.(provider, modelId);
  };

  setThinking = (level: string): void => {
    const live = this.liveUpdate;
    if (this.mode === 'demo' || this.connection.status !== 'live' || !live?.capabilities.thinkingSelection
        || live.readOnly || live.isWorking || live.pendingQuestion || live.sessionAction) return;
    this.driver?.setThinking?.(level);
  };

  renameSession = (title: string): void => {
    const live = this.liveUpdate;
    if (this.mode === 'demo' || this.connection.status !== 'live' || !live?.capabilities.sessionRename
        || live.readOnly || live.isWorking || live.pendingQuestion || live.sessionAction) return;
    this.driver?.renameSession?.(title);
  };

  focusSession = (): void => {
    const live = this.liveUpdate;
    if (this.mode === 'demo' || this.connection.status !== 'live' || !live?.capabilities.focusSession || live.readOnly || live.sessionAction) return;
    this.driver?.focusSession?.();
  };

  useDemo = (): void => {
    ++this.connectionGeneration;
    this.driver?.close(); this.driver = null; this.liveUpdate = null;
    this.cancelAllJobs(); this.threads = seedThreads(); this.active = this.threads.keys().next().value!;
    this.mode = 'demo'; this.connection = DEMO_CONNECTION; this.disconnected = false; this.displayName = 'You';
    this.publish();
  };

  dispose = (): void => {
    ++this.connectionGeneration; this.disposed = true; this.driver?.close(); this.cancelAllJobs(); this.listeners.clear();
  };

  private beginJob(threadId: string): object {
    this.cancelJob(threadId);
    const token = {};
    this.jobs.set(threadId, { token });
    return token;
  }

  private later(threadId: string, token: object, delay: number, action: () => void) {
    const job = this.jobs.get(threadId);
    if (!job || job.token !== token) return;
    job.timer = setTimeout(() => {
      if (this.jobs.get(threadId)?.token !== token || this.disposed) return;
      action();
    }, delay);
  }

  private stream(thread: Thread, token: object, text: string, done: () => void) {
    const current = { ...message('assistant', ''), streaming: true };
    thread.messages.push(current);
    const pieces = text.match(/\S+\s*/g) ?? [text];
    let index = 0;
    const tick = () => {
      if (this.jobs.get(thread.summary.id)?.token !== token) return;
      current.text += pieces.slice(index, index + 3).join(''); index += 3;
      if (index >= pieces.length) { current.streaming = false; this.publish(); done(); }
      else { this.publish(); this.later(thread.summary.id, token, 75, tick); }
    };
    this.later(thread.summary.id, token, 180, tick);
  }

  private finish(thread: Thread) {
    thread.summary.status = 'idle'; thread.agents.forEach(a => { a.status = 'done'; });
    this.jobs.delete(thread.summary.id); this.publish();
  }

  private cancelJob(threadId: string) {
    const job = this.jobs.get(threadId); if (job?.timer) clearTimeout(job.timer); this.jobs.delete(threadId);
  }

  private cancelAllJobs() { for (const key of this.jobs.keys()) this.cancelJob(key); }
}

export const sessionStore = new SessionStore();
