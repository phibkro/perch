import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/** Explicitly loaded by local verification only; never auto-loaded by the bridge. */
export default function fixture(pi: ExtensionAPI) {
  pi.registerCommand('perch-secret-check', {
    description: 'Check that bridge credentials are not inherited by the agent',
    handler: async (_args, ctx) => ctx.ui.notify(process.env.PERCH_BRIDGE_TOKEN === undefined ? 'Bridge token is absent from agent environment.' : 'Bridge token unexpectedly inherited.', 'info'),
  });
  pi.registerCommand('perch-question', {
    description: 'Synthetic protocol verification question',
    handler: async (_args, ctx) => {
      const answer = await ctx.ui.select('Synthetic fixture choice', ['Preview', 'Cancel'], { timeout: 15_000 });
      ctx.ui.notify(`Fixture received: ${answer ?? 'cancelled'}`, 'info');
    },
  });
  pi.registerCommand('perch-editor', {
    description: 'Synthetic protocol verification editor',
    handler: async (_args, ctx) => {
      const answer = await ctx.ui.editor('Synthetic fixture note', 'Keep this concise.');
      ctx.ui.notify(`Fixture note: ${answer ?? 'cancelled'}`, 'info');
    },
  });
}
