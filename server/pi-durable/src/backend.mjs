import { DurableObject } from 'cloudflare:workers';
import { Lifecycle } from 'agents/lifecycle';
import { PiHarness } from 'agents/harness/pi';
import { Harness, createRegistry } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT as BG } from '@earendil-works/chord/context';
import { DURABLE_PROTOCOL, DURABLE_SERVICE } from '../../../src/harness/durable.ts';
import { SessionData, artifactTool, artifactKey, attachmentHeaders, sha256 } from './artifacts.mjs';
import { projectSnapshot } from './projector.mjs';
import { workspaceManifest } from './workspace.mjs';
import { HttpError, ID, authenticate, createInput, errorResponse, fail, fields, id, jsonBody,
  originFor, parseAccess, preflight, secureResponse, submitInput } from './http.mjs';

const META_KEY = 'perch:identity:v1';
const sessionName = (workspace, session) => `perch:session:${workspace}:${session}`;
const catalogName = workspace => `perch:catalog:${workspace}`;
const privateRequest = (path, value) => new Request(`https://perch.internal${path}`, value === undefined
  ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
const summary = metadata => ({ id: metadata.id, title: metadata.title, project: 'Durable workspace', status: metadata.status ?? 'idle' });
const safeModels = runtime => runtime.safeModels.map(({ id, name, provider }) => ({ id, name, provider }));
function assertBindings(env) {
  if (!env.PERCH_CATALOGS || !env.PERCH_SESSIONS || !env.ARTIFACTS) fail(503, 'Backend storage is not configured.');
}
async function privateJson(stub, path, value) {
  const response = await stub.fetch(privateRequest(path, value));
  if (!response.ok) {
    let message = 'Backend request failed.';
    try { message = (await response.json()).error ?? message; } catch {}
    throw new HttpError(response.status, message);
  }
  return response.json();
}

/** The only fixture seam. Production supplies a real provider; tests import this
 * factory in a separate entry and retain the same auth, storage, tools and API. */
export function createBackend({ createRuntime, synthetic = false, onSessionStart, onArtifactStored, onArtifactCommitted } = {}) {
  if (typeof createRuntime !== 'function') throw new Error('createRuntime is required');
  const hooks = { onSessionStart, onArtifactStored, onArtifactCommitted };

  class PerchCatalog extends DurableObject {
    constructor(ctx, env) {
      super(ctx, env);
      ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS perch_sessions (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, metadata TEXT NOT NULL)');
      ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS perch_creates (operation_id TEXT PRIMARY KEY, title TEXT NOT NULL, session_id TEXT NOT NULL)');
    }
    async fetch(request) {
      try {
        const url = new URL(request.url);
        if (request.method === 'GET' && url.pathname === '/internal/list') {
          const rows = this.ctx.storage.sql.exec('SELECT metadata FROM perch_sessions ORDER BY created_at DESC, id DESC').toArray();
          return Response.json({ sessions: rows.map(row => summary(JSON.parse(row.metadata))) });
        }
        const body = await jsonBody(request);
        if (url.pathname === '/internal/get') {
          const row = this.ctx.storage.sql.exec('SELECT metadata FROM perch_sessions WHERE id = ?', id(body.id)).toArray()[0];
          if (!row) fail(404, 'Session not found.');
          return Response.json(JSON.parse(row.metadata));
        }
        if (url.pathname === '/internal/create') {
          const input = createInput({ operationId: body.operationId, title: body.title });
          const workspace = id(body.workspaceId);
          if (this.ctx.id.name && this.ctx.id.name !== catalogName(workspace)) fail(403, 'Workspace mismatch.');
          const result = this.ctx.storage.transactionSync(() => {
            const previous = this.ctx.storage.sql.exec('SELECT title, session_id FROM perch_creates WHERE operation_id = ?', input.operationId).toArray()[0];
            if (previous) {
              if (previous.title !== input.title) fail(409, 'Operation ID already has different input.');
              const row = this.ctx.storage.sql.exec('SELECT metadata FROM perch_sessions WHERE id = ?', previous.session_id).toArray()[0];
              return { metadata: JSON.parse(row.metadata), accepted: false };
            }
            const count = this.ctx.storage.sql.exec('SELECT COUNT(*) AS count FROM perch_sessions').toArray()[0].count;
            if (count >= 2000) fail(429, 'Workspace session limit reached.');
            const metadata = { id: crypto.randomUUID(), workspaceId: workspace,
              title: input.title.trim() || 'New chat', createdAt: Date.now(), status: 'idle' };
            this.ctx.storage.sql.exec('INSERT INTO perch_sessions (id, created_at, metadata) VALUES (?, ?, ?)', metadata.id, metadata.createdAt, JSON.stringify(metadata));
            this.ctx.storage.sql.exec('INSERT INTO perch_creates (operation_id, title, session_id) VALUES (?, ?, ?)', input.operationId, input.title, metadata.id);
            return { metadata, accepted: true };
          });
          await this.ctx.storage.sync();
          return Response.json(result);
        }
        if (url.pathname === '/internal/status') {
          const row = this.ctx.storage.sql.exec('SELECT metadata FROM perch_sessions WHERE id = ?', id(body.id)).toArray()[0];
          if (!row) fail(404, 'Session not found.');
          if (!['idle', 'working'].includes(body.status)) fail(400, 'Invalid status.');
          const metadata = JSON.parse(row.metadata);
          metadata.status = body.status;
          this.ctx.storage.sql.exec('UPDATE perch_sessions SET metadata = ? WHERE id = ?', JSON.stringify(metadata), metadata.id);
          return Response.json({ ok: true });
        }
        fail(404, 'Route not found.');
      } catch (error) { return errorResponse(error); }
    }
  }

  class PerchSession extends DurableObject {
    constructor(ctx, env) {
      super(ctx, env);
      this.bootId = crypto.randomUUID(); this.activatedBy = undefined; this.metadata = undefined;
      this.monitors = new Set(); this.mutations = Promise.resolve();
      this.runtime = createRuntime(env, this);
      this.models = safeModels(this.runtime);
      this.lifecycle = new Lifecycle(this);
      this.harness = new PiHarness({ defaults: { model: this.runtime.defaultModel },
        harness: async ({ storage, context }) => {
          const registry = this.runtime.registry ?? createRegistry();
          registry.install({ name: 'perch.artifacts', tools: [artifactTool(this, hooks)],
            sections: [{ key: 'perch', render: () => 'You are a helpful assistant. Use write_artifact for complete Markdown documents, HTML pages, or source-code files. Artifacts are saved for the user to open on their phone. Do not claim a file was saved unless the tool succeeded.' }] });
          return Harness.open(storage, { models: this.runtime.models, registry,
            ...(this.runtime.settings ? { settings: this.runtime.settings } : {}),
            onReport: () => console.error('Pi Durable reported a runtime error; provider diagnostics are withheld.'),
          }, context);
        } });
      this.lifecycle.use(this.harness);
    }
    exclusive(action) {
      const run = this.mutations.then(action); this.mutations = run.catch(() => {}); return run;
    }
    async loadMetadata() {
      this.metadata ??= await this.ctx.storage.get(META_KEY);
      return this.metadata;
    }
    async fetch(request) {
      try {
        this.activatedBy ??= 'fetch';
        const url = new URL(request.url);
        if (url.pathname === '/internal/init' && request.method === 'POST') {
          const metadata = await jsonBody(request);
          id(metadata.id); id(metadata.workspaceId);
          if (this.ctx.id.name && this.ctx.id.name !== sessionName(metadata.workspaceId, metadata.id)) fail(403, 'Session mismatch.');
          await this.ctx.blockConcurrencyWhile(async () => {
            const previous = await this.loadMetadata();
            if (previous && (previous.id !== metadata.id || previous.workspaceId !== metadata.workspaceId)) fail(409, 'Session identity conflict.');
            if (!previous) { await this.ctx.storage.put(META_KEY, metadata); this.metadata = metadata; }
          });
          return Response.json({ ok: true });
        }
        if (!await this.loadMetadata()) fail(404, 'Session not found.');
        const response = await this.lifecycle.fetch(request);
        // Lifecycle's startup-error fallback contains an error stack. Never
        // expose that SDK fallback (and possible provider diagnostics) to clients.
        return response.status >= 500 ? errorResponse(new Error('Lifecycle request failed')) : response;
      } catch (error) { return errorResponse(error); }
    }
    async alarm() {
      this.activatedBy ??= 'alarm';
      if (!await this.loadMetadata()) return;
      return this.lifecycle.alarm();
    }
    async onStart() {
      const pi = await this.harness.pi();
      const data = await pi.snapshot(SessionData, BG);
      // A crash between reservation and admission is reconciled with the same
      // operation ID. Pi's own idempotency record remains authoritative.
      for (const admission of data?.admissions ?? []) {
        const stored = await this.operation(admission.operationId);
        if (!stored) await this.harness.submit(admission.text, { operationId: admission.operationId });
        if (!stored || stored.status === 'queued' || stored.status === 'running') this.monitor(admission.operationId);
      }
      await hooks.onSessionStart?.(this);
    }
    async operation(operationId) {
      const storage = await this.harness.storage();
      const record = await storage.submissionByRequest(1, operationId, BG);
      return record ? { operationId, status: record.status === 'placed' ? 'running' : record.status } : undefined;
    }
    monitor(operationId) {
      if (this.monitors.has(operationId)) return;
      this.monitors.add(operationId);
      const work = this.harness.wait(operationId).then(() => this.refreshCatalogStatus())
        .catch(() => console.error('Session completion observer failed.'))
        .finally(() => this.monitors.delete(operationId));
      this.ctx.waitUntil(work);
    }
    async refreshCatalogStatus() {
      const pending = await this.harness.pending();
      const catalog = this.env.PERCH_CATALOGS.get(this.env.PERCH_CATALOGS.idFromName(catalogName(this.metadata.workspaceId)));
      await privateJson(catalog, '/internal/status', { id: this.metadata.id, status: pending.length ? 'working' : 'idle' });
    }
    async onRequest(request) {
      // Lifecycle converts every thrown application error to a stack-bearing 500.
      // Translate expected HTTP failures here, before that SDK boundary.
      try { return await this.handleRequest(request); }
      catch (error) { return errorResponse(error); }
    }
    async handleRequest(request) {
      const url = new URL(request.url);
      const path = url.pathname;
      if (request.method === 'GET' && path.endsWith('/snapshot')) {
        const pi = await this.harness.pi();
        // One immutable view pairs the transcript with its live generation's
        // task identity, preserving message/artifact identity on completion.
        const watch = await (await pi.root(BG)).watch(BG);
        const view = watch.value; await watch.stop();
        const data = await pi.snapshot(SessionData, BG);
        const operations = (await Promise.all((data?.admissions ?? []).map(item => this.operation(item.operationId)))).filter(Boolean);
        return Response.json(projectSnapshot({ metadata: this.metadata, view, operations,
          manifests: data?.artifacts ?? [], models: this.models, synthetic }));
      }
      const operationMatch = /\/operations\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/.exec(path);
      if (request.method === 'GET' && operationMatch) {
        const operation = await this.operation(operationMatch[1]);
        if (!operation) fail(404, 'Operation not found.');
        return Response.json(operation);
      }
      const artifactMatch = /\/artifacts\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/.exec(path);
      if (request.method === 'GET' && artifactMatch) {
        const data = await (await this.harness.pi()).snapshot(SessionData, BG);
        const manifest = data?.artifacts.find(item => item.id === artifactMatch[1]);
        if (!manifest) fail(404, 'Artifact not found.');
        const object = await this.env.ARTIFACTS.get(artifactKey(this.metadata, manifest.sha256));
        if (!object || object.size !== manifest.bytes) fail(503, 'Artifact content is unavailable.');
        const bytes = await object.arrayBuffer();
        if (await sha256(bytes) !== manifest.sha256) fail(503, 'Artifact content failed verification.');
        return new Response(bytes, { headers: attachmentHeaders(manifest) });
      }
      if (request.method !== 'POST') fail(404, 'Route not found.');
      const body = await jsonBody(request);
      return this.exclusive(async () => {
        if (path.endsWith('/submit')) {
          const input = submitInput(body); const pi = await this.harness.pi();
          const current = await pi.snapshot(SessionData, BG);
          const previous = current?.admissions.find(item => item.operationId === input.operationId);
          if (previous && previous.text !== input.text) fail(409, 'Operation ID already has different input.');
          if (!previous && (current?.admissions.length ?? 0) >= 2000) fail(429, 'Session operation limit reached.');
          // HTTP admissions are serialized by exclusive(). Tools can concurrently
          // update artifacts, so append to the newest document inside Pi's commit.
          if (!previous) await pi.commit(async tx => {
              const doc = await tx.doc(SessionData);
              doc.admissions.push(input);
          }, BG);
          const receipt = await this.harness.submit(input.text, { operationId: input.operationId });
          this.monitor(input.operationId);
          this.ctx.waitUntil(this.refreshCatalogStatus().catch(() => {}));
          return Response.json({ operationId: input.operationId, session: this.metadata.id, accepted: receipt.accepted });
        }
        if (path.endsWith('/abort')) {
          fields(body, ['operationId']); if (body.operationId !== undefined) id(body.operationId);
          await this.harness.abort({ operationId: body.operationId });
          return Response.json({ ok: true });
        }
        if (path.endsWith('/model')) {
          fields(body, ['provider', 'modelId'], ['provider', 'modelId']);
          if (!this.models.some(model => model.provider === body.provider && model.id === body.modelId)) fail(400, 'Model is not configured on this host.');
          if (await this.harness.session().busy() || (await this.harness.pending()).length) fail(409, 'Wait for the session to become idle before changing model.');
          await this.harness.session().setModel({ provider: body.provider, id: body.modelId });
          return Response.json({ ok: true });
        }
        fail(404, 'Route not found.');
      });
    }
  }

  async function fetch(request, env) {
    let origin;
    try {
      const url = new URL(request.url);
      if (!url.pathname.startsWith('/perch/') || url.search) fail(404, 'Route not found.');
      const access = parseAccess(env); origin = originFor(request, access);
      if (request.method === 'OPTIONS') return secureResponse(preflight(request), origin);
      const workspace = authenticate(request, access); assertBindings(env);
      const runtime = createRuntime(env); const models = safeModels(runtime);
      let response;
      if (request.method === 'GET' && url.pathname === '/perch/workspace') {
        response = Response.json(workspaceManifest(env, workspace));
      } else if (request.method === 'GET' && url.pathname === '/perch/health') {
        response = Response.json({ service: DURABLE_SERVICE, protocol: DURABLE_PROTOCOL,
          harness: { name: 'Pi Durable', version: '1.0.4' }, models, synthetic });
      } else {
        const catalog = env.PERCH_CATALOGS.get(env.PERCH_CATALOGS.idFromName(catalogName(workspace)));
        if (url.pathname === '/perch/sessions' && request.method === 'GET') {
          response = await catalog.fetch(privateRequest('/internal/list'));
        } else if (url.pathname === '/perch/sessions' && request.method === 'POST') {
          const input = createInput(await jsonBody(request));
          const created = await privateJson(catalog, '/internal/create', { ...input, workspaceId: workspace });
          const stub = env.PERCH_SESSIONS.get(env.PERCH_SESSIONS.idFromName(sessionName(workspace, created.metadata.id)));
          await privateJson(stub, '/internal/init', created.metadata);
          response = Response.json({ session: summary(created.metadata), accepted: created.accepted });
        } else {
          const match = /^\/perch\/sessions\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})(?:\/(submit|abort|model|operations\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}|artifacts\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}))?$/.exec(url.pathname);
          if (!match) fail(404, 'Route not found.');
          const expectedMethod = ['submit', 'abort', 'model'].includes(match[2]) ? 'POST' : 'GET';
          if (request.method !== expectedMethod) fail(404, 'Route not found.');
          // Looking up in the authorized workspace prevents unknown reads from
          // instantiating cells and prevents guessed IDs crossing workspaces.
          const metadata = await privateJson(catalog, '/internal/get', { id: match[1] });
          if (metadata.workspaceId !== workspace) fail(404, 'Session not found.');
          const stub = env.PERCH_SESSIONS.get(env.PERCH_SESSIONS.idFromName(sessionName(workspace, metadata.id)));
          await privateJson(stub, '/internal/init', metadata);
          const target = new URL(`https://perch.internal/session/${match[2] ?? 'snapshot'}`);
          response = await stub.fetch(new Request(target, { method: request.method,
            headers: { 'Content-Type': 'application/json' },
            ...(request.method === 'POST' ? { body: request.body, duplex: 'half' } : {}) }));
        }
      }
      return secureResponse(response, origin);
    } catch (error) { return secureResponse(errorResponse(error), origin); }
  }
  return { fetch, PerchCatalog, PerchSession };
}
