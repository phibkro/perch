import type { ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent/extensibility/extensions/types';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { OmpRemoteBridge } from './bridge.mjs';
import { readConfiguration } from './configuration.mjs';

/** The factory receives OMP's current extension API; it never creates an agent. */
export function attachRemoteExtension(api: ExtensionAPI, bridge: OmpRemoteBridge) {
  const observe = (event: { type: string }, context: ExtensionContext) => bridge.observe(event, context);
  api.on('session_start', observe);
  api.on('session_switch', observe);
  api.on('session_branch', observe);
  api.on('session_tree', observe);
  api.on('session_compact', observe);
  // OMP's public transition hooks keep an async extension dispatch from drifting
  // into a different desktop conversation while authentication/admission settles.
  api.on('session_before_switch', (_event, context) => bridge.beforeTransition(context));
  api.on('session_before_branch', (_event, context) => bridge.beforeTransition(context));
  api.on('session_before_tree', (_event, context) => bridge.beforeTransition(context));
  api.on('session_before_compact', (_event, context) => bridge.beforeTransition(context));
  api.on('session_shutdown', observe);
  api.on('agent_start', observe);
  api.on('agent_end', observe);
  api.on('message_start', observe);
  api.on('message_update', observe);
  api.on('message_end', observe);
  api.on('tool_execution_start', observe);
  api.on('tool_execution_update', observe);
  api.on('tool_execution_end', observe);
  api.on('tool_approval_requested', observe);
  api.on('tool_approval_resolved', observe);
  api.registerCommand('perch-remote-reset', {
    description: 'Reset an unconfirmed Perch prompt only after checking this host session',
    handler: async (_args, context) => {
      if (!context.hasUI || context.agent.kind !== 'main' || !context.isIdle() || context.hasPendingMessages()) {
        context.ui.notify('Wait for this host session to become idle before resetting Perch admission.', 'warning');
        return;
      }
      const confirmed = await context.ui.confirm('Reset Perch prompt admission?',
        'Only continue after checking that the earlier phone prompt is not waiting to start. This clears the admission guard without resending or cancelling that prompt.');
      if (!confirmed) return;
      if (bridge.resetAdmission(context)) context.ui.notify('Perch admission was reset. Refresh the phone catalog and attach again.', 'info');
      else context.ui.notify('The host state changed. Perch admission was not reset.', 'warning');
    },
  });
}

export default function perchRemote(api: ExtensionAPI) {
  const path = process.env.PERCH_OMP_CONFIG || join(homedir(), '.config', 'perch', 'omp-remote.json');
  attachRemoteExtension(api, new OmpRemoteBridge(api, readConfiguration(path)));
}
