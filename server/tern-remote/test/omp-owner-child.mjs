/** Real OMP fixture run in the Tern verifier's PTY. Never connects to a model provider. */
import assert from 'node:assert/strict';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [log, directory] = process.argv.slice(2);
assert.ok(log && directory, 'This fixture requires its private log and work directory.');
const runtime = resolve(process.env.PERCH_OMP_RUNTIME || fileURLToPath(new URL('../../omp-remote/upstream', import.meta.url)));
const load = name => import(Bun.resolveSync(name, runtime));
const sdkPath = Bun.resolveSync('@oh-my-pi/pi-coding-agent/sdk', runtime);
const version = JSON.parse(await readFile(join(dirname(dirname(sdkPath)), 'package.json'), 'utf8')).version;
assert.equal(version, '18.8.7');
process.env.PI_CODING_AGENT_DIR = directory;
process.env.PI_TEST_RUNTIME = '1';
process.env.PI_TUI_NATIVE = '1';
// Test isolation normally disables terminal I/O. This contract test uses a real
// Tern PTY, so enable the public terminal-test override and native probe before
// constructing it. PI_TEST_RUNTIME alone also suppresses that probe.
const { setTerminalHeadless } = await load('@oh-my-pi/pi-utils');
setTerminalHeadless(false);
const record = value => appendFile(log, JSON.stringify({ pid: process.pid,
  sessionId: session?.sessionManager.getSessionId(), ...value }) + '\n');
const [{ createAgentSession }, { AuthStorage }, { SessionManager }, { ModelRegistry }, { Settings },
  { createMockModel }, { getBundledModel }, { InteractiveMode }, { initTheme }, { submitInteractiveInput }] = await Promise.all([
  load('@oh-my-pi/pi-coding-agent/sdk'), load('@oh-my-pi/pi-coding-agent/session/auth-storage'),
  load('@oh-my-pi/pi-coding-agent/session/session-manager'), load('@oh-my-pi/pi-coding-agent/config/model-registry'),
  load('@oh-my-pi/pi-coding-agent/config/settings'), load('@oh-my-pi/pi-ai/providers/mock'),
  load('@oh-my-pi/pi-catalog/models'), load('@oh-my-pi/pi-coding-agent/modes/interactive-mode'),
  load('@oh-my-pi/pi-tui/theme'), load('@oh-my-pi/pi-coding-agent/main'),
]);
let session, auth, mode;
try {
  auth = await AuthStorage.create(join(directory, 'auth.db'));
  auth.keys.setRuntime('openai', 'local-fixture-only');
  const model = getBundledModel('openai', 'gpt-4o-mini'); assert.ok(model);
  const mock = createMockModel({ responses: [
    { content: [{ type: 'toolCall', name: 'perch_fixture', arguments: { note: 'This exact inert tool requires a decision.' } }] },
    { content: ['The denied fixture did not execute.'] },
    { content: [{ type: 'toolCall', name: 'perch_fixture', arguments: { note: 'This exact inert tool requires a decision.' } }] },
    { content: ['The approved fixture executed once.'] },
    { content: ['The explicit phone feedback reached the same planning session.'] },
    { content: ['The approved plan continued through the original session.'] },
  ] });
  const created = await createAgentSession({ cwd: directory, agentDir: directory, authStorage: auth,
    modelRegistry: new ModelRegistry(auth, join(directory, 'models.yml')), model,
    settings: Settings.isolated({ 'compaction.enabled': false, 'retry.maxRetries': 0, 'tools.approvalMode': 'always-ask' }),
    sessionManager: SessionManager.inMemory(directory), disableExtensionDiscovery: true,
    extensions: [api => {
      api.registerTool({ name: 'perch_fixture', label: 'Perch fixture', description: 'An inert verifier tool.',
        approval: args => ({ tier: 'exec', reason: args.note }), parameters: api.zod.object({ note: api.zod.string() }),
        execute: async (_id, args) => { await record({ type: 'tool-executed', args }); return { content: [{ type: 'text', text: 'No side effect.' }] }; } });
      api.on('tool_approval_requested', async event => { await record({ ...event, type: 'approval-requested' }); });
      api.on('tool_approval_resolved', async event => { await record({ ...event, type: 'approval-resolved' }); });
    }], skills: [], contextFiles: [], promptTemplates: [], slashCommands: [], rules: [], preloadedCustomToolPaths: [],
    enableMCP: false, enableLsp: false, skipPythonPreflight: true, cacheWarming: false, toolNames: ['perch_fixture'] });
  session = created.session;
  session.agent.streamFn = mock.stream;
  await Settings.init({ inMemory: true, cwd: directory }); await initTheme();
  mode = new InteractiveMode(session, version, undefined, created.setToolUIContext);
  await mode.init({ suppressWelcomeIntro: true, autoStartCollab: false });
  const nativeDeadline = Date.now() + 10_000;
  while (!mode.ui.nativeRendering && Date.now() < nativeDeadline) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(mode.ui.nativeRendering, true, 'The real Tern PTY must negotiate native TSP before owner controls are tested.');
  const originalSession = session.sessionManager.getSessionId();
  assert.ok(typeof originalSession === 'string' && originalSession.trim().length > 0);
  await record({ type: 'started', version, sessionId: originalSession, native: mode.ui.nativeRendering });
  await session.prompt('Run the first inert approval fixture.');
  await record({ type: 'first-turn-complete', calls: mock.calls.length });
  await session.prompt('Run the same inert approval fixture again.');
  await record({ type: 'second-turn-complete', calls: mock.calls.length });

  const planFilePath = join(directory, 'owner-plan.md');
  const plan = '# Phone owner controls\n\n## Goal\n\nReview a real OMP plan from Perch.\n\n## Work\n\nKeep the original harness and session on the host.\n';
  await writeFile(planFilePath, plan);
  mode.planModeEnabled = true; mode.planModePlanFilePath = planFilePath;
  session.setPlanModeState({ enabled: true, planFilePath });
  await record({ type: 'plan-ready' });
  await mode.handlePlanApproval({ planFilePath, planExists: true, title: 'Phone owner controls' });
  assert.equal(mode.planModeEnabled, true);
  await record({ type: 'plan-refined', calls: mock.calls.length });
  const input = await mode.getUserInput();
  await record({ type: 'phone-feedback', text: input.text });
  await submitInteractiveInput(mode, session, input);
  await record({ type: 'feedback-complete', calls: mock.calls.length });

  await mode.handlePlanApproval({ planFilePath, planExists: true, title: 'Phone owner controls' });
  assert.equal(mode.planModeEnabled, false);
  await record({ type: 'plan-approved', calls: mock.calls.length });
  assert.equal(session.sessionManager.getSessionId(), originalSession);
  await record({ type: 'done', sessionId: originalSession, paidProviderCalls: 0, modelCalls: mock.calls.length });
  // Keep the real session visible until the verifier has read its final state.
  await new Promise(resolveExit => process.once('SIGTERM', resolveExit));
} catch (error) {
  await record({ type: 'error', message: error.stack ?? String(error) });
  process.exitCode = 1;
} finally {
  mode?.stop(); await session?.dispose(); auth?.close();
}
