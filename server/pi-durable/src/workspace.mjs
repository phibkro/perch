import { WORKSPACE_PROTOCOL, parseManifest } from '../../../src/workspace/protocol.ts';
import { HttpError } from './http.mjs';

/** The authenticated token selects the workspace; callers cannot override it. */
export function workspaceManifest(env, workspace) {
  try {
    return parseManifest({ protocol: WORKSPACE_PROTOCOL, version: 1,
      workspace: { id: workspace, name: env.PERCH_WORKSPACE_NAME ?? 'Perch workspace',
        deployment: env.PERCH_DEPLOYMENT ?? 'self-hosted' },
      defaultConnectionId: 'durable',
      connections: [{ id: 'durable', name: 'Pi Durable', kind: 'durable', path: '' }],
    });
  } catch { throw new HttpError(503, 'Workspace discovery is not configured.'); }
}
