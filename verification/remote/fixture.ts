import { createServer, type ServerResponse } from 'node:http';
import { parseRemoteCommand, type RemoteHealth, type RemoteReceipt, type RemoteSnapshot } from '../../src/harness/remote';

export async function remoteFixture() {
  const token = 'remote-public-fixture-device-token-at-least-32-characters';
  const health: RemoteHealth = { protocol: 'perch-remote', version: 1, host: { id: 'fixture-host', name: 'Controlled remote host' }, adapter: 'omp', epoch: 'epoch-one', synchronization: 'snapshot', limitations: ['Controlled protocol fixture; no model or user host is involved.'] };
  const snapshots = new Map<string, RemoteSnapshot>();
  let revision = 1;
  for (const id of ['session_one', 'session_two']) snapshots.set(id, {
    protocol: 'perch-remote', version: 1, epoch: health.epoch, revision,
    session: { id, generation: 'generation-one', runtimeId: `runtime-${id}`, conversationId: `conversation-${id}`, title: id === 'session_one' ? 'Existing OMP session' : 'Another host session', project: '/synthetic/project', status: 'idle', harness: 'omp', pid: id === 'session_one' ? 321 : 654, model: { provider: 'local', id: 'model-one' } },
    capabilities: { prompt: true, interrupt: true, modelSelection: true }, readOnly: false,
    messages: [{ id: `${id}-history`, role: 'assistant', text: `Saved host history for ${id}`, createdAt: 1 }], tools: [], availableModels: [{ provider: 'local', id: 'model-one' }, { provider: 'other', id: 'model-two' }], truncated: false, notices: [],
  });
  const requests: { path: string; method: string; authorized: boolean; body?: unknown }[] = [];
  const operations = new Map<string, RemoteReceipt>();
  const gates = new Map<string, { started: boolean; wait: Promise<void>; release: () => void }>();
  const overrides = new Map<string, { status?: number; body?: string; headers?: Record<string, string> }>();
  let commandMode: 'normal' | 'accepted-drop' | 'unrecorded-drop' | 'pending' | 'rejected' = 'normal';
  const json = (response: ServerResponse, value: unknown, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
  const update = () => { ++revision; for (const snapshot of snapshots.values()) { snapshot.epoch = health.epoch; snapshot.revision = revision; } };
  const server = createServer((request, response) => {
    void (async () => {
      const path = new URL(request.url!, 'http://fixture').pathname; const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
      const authorized = request.headers.authorization === `Bearer ${token}`;
      requests.push({ path, method: request.method || 'GET', authorized, body });
      if (!authorized) return json(response, { privateDiagnostic: token }, 401);
      const value = overrides.get(path);
      if (value) { response.writeHead(value.status ?? 200, { 'Content-Type': 'application/json', ...value.headers }); response.end(value.body ?? '{}'); return; }
      // Capture a response before its gate so a delayed read really is stale.
      const snapshotMatch = /^\/perch\/sessions\/([A-Za-z0-9_-]+)$/.exec(path);
      const captured = snapshotMatch && snapshots.get(snapshotMatch[1]);
      const capturedSnapshot = captured && structuredClone(captured);
      const gate = gates.get(path);
      if (gate) { gate.started = true; await gate.wait; }
      if (path === '/perch/health') return json(response, { ...health, privateCredential: 'do-not-project' });
      if (path === '/perch/sessions') return json(response, { protocol: health.protocol, version: 1, epoch: health.epoch, revision, sessions: [...snapshots.values()].map(snapshot => snapshot.session) });
      if (snapshotMatch) return capturedSnapshot ? json(response, capturedSnapshot) : json(response, {}, 404);
      const receipt = /^\/perch\/sessions\/([A-Za-z0-9_-]+)\/operations\/([A-Za-z0-9_-]+)$/.exec(path);
      if (receipt) return operations.has(receipt[2]) ? json(response, operations.get(receipt[2])) : json(response, {}, 404);
      const commandMatch = /^\/perch\/sessions\/([A-Za-z0-9_-]+)\/commands$/.exec(path);
      if (commandMatch && request.method === 'POST') {
        const snapshot = snapshots.get(commandMatch[1]); const command = parseRemoteCommand(body);
        if (!snapshot || command.epoch !== health.epoch || command.generation !== snapshot.session.generation || command.conversationId !== snapshot.session.conversationId) return json(response, {}, 409);
        if (snapshot.readOnly) return json(response, {}, 403);
        if (command.type === 'answer') {
          const question = snapshot.pendingQuestion;
          if (!snapshot.capabilities.questions || !question?.actionable || question.id !== command.requestId || question.revision !== command.requestRevision
              || question.kind === 'choice' && !question.options?.some(option => option.id === command.answer && !option.disabled)) return json(response, {}, 409);
        }
        if (commandMode === 'unrecorded-drop') { response.destroy(); return; }
        if (operations.has(command.id)) return json(response, operations.get(command.id));
        const next: RemoteReceipt = { protocol: health.protocol, version: 1, id: command.id, epoch: command.epoch, generation: command.generation, conversationId: command.conversationId, sessionId: snapshot.session.id,
          status: commandMode === 'pending' ? 'pending' : commandMode === 'rejected' ? 'rejected' : 'forwarded' };
        if (commandMode !== 'rejected') {
          if (command.type === 'prompt') { snapshot.messages.push({ id: command.id, role: 'user', text: command.text, createdAt: Date.now() }); snapshot.session.status = 'working'; }
          if (command.type === 'interrupt') snapshot.session.status = 'idle';
          if (command.type === 'set-model') snapshot.session.model = { provider: command.provider, id: command.modelId };
          update();
        }
        operations.set(command.id, next);
        if (commandMode === 'accepted-drop') { response.destroy(); return; }
        return json(response, next);
      }
      return json(response, {}, 404);
    })().catch(() => { if (!response.destroyed) json(response, {}, 500); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture did not bind.');
  return {
    url: `http://127.0.0.1:${address.port}`, token, requests, health, snapshots, operations, overrides, update,
    setCommandMode(mode: typeof commandMode) { commandMode = mode; },
    hold(path: string) {
      let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
      const gate = { started: false, wait, release: () => { gates.delete(path); release(); } }; gates.set(path, gate); return gate;
    },
    async close() {
      for (const gate of gates.values()) gate.release();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => {
        // Bun can close the listener while terminating its final connection.
        if (error && !('code' in error && error.code === 'ERR_SERVER_NOT_RUNNING')) reject(error); else resolve();
      }));
    },
  };
}
