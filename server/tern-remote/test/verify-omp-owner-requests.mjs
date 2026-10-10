/** Optional same-process owner controls check against separately installed OMP. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { OmpTspTerminal } from './omp-tsp-terminal.mjs';

const runtime = resolve(process.env.PERCH_OMP_RUNTIME || fileURLToPath(new URL('../../omp-remote/upstream', import.meta.url)));
const load = name => import(Bun.resolveSync(name, runtime));
const sdkPath = Bun.resolveSync('@oh-my-pi/pi-coding-agent/sdk', runtime);
const version = JSON.parse(await readFile(join(dirname(dirname(sdkPath)), 'package.json'), 'utf8')).version;
assert.equal(version, '18.8.7', 'This verifier is pinned to OMP 18.8.7.');
const directory = await mkdtemp(join(tmpdir(), 'perch-omp-owner-'));
process.env.PI_CODING_AGENT_DIR = directory;
process.env.PI_TEST_RUNTIME = '1';
const [{ createAgentSession }, { AuthStorage }, { SessionManager }, { ModelRegistry }, { Settings },
  { createMockModel }, { getBundledModel }, { InteractiveMode }, { Composer }, { initTheme },
  { TspDocument }, { splitTspMessage }, { TSP_KINDS }] = await Promise.all([
  load('@oh-my-pi/pi-coding-agent/sdk'), load('@oh-my-pi/pi-coding-agent/session/auth-storage'),
  load('@oh-my-pi/pi-coding-agent/session/session-manager'), load('@oh-my-pi/pi-coding-agent/config/model-registry'),
  load('@oh-my-pi/pi-coding-agent/config/settings'), load('@oh-my-pi/pi-ai/providers/mock'),
  load('@oh-my-pi/pi-catalog/models'), load('@oh-my-pi/pi-coding-agent/modes/interactive-mode'),
  load('@oh-my-pi/pi-tui/prompt/composer'), load('@oh-my-pi/pi-tui/theme'),
  load('@oh-my-pi/pi-tui/native/apply'), load('@oh-my-pi/pi-tui/native/encode'),
  load('@oh-my-pi/pi-wire'),
]);

const until = async (check, label, timeout = 10_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = check(); if (result) return result; await Bun.sleep(10); }
  throw new Error(`Timed out: ${label}`);
};
const text = value => typeof value === 'string' ? value : Array.isArray(value) ? value.map(item => item.t ?? item.text ?? '').join('') : '';
const descendants = root => [root, ...(root.c ?? []).flatMap(descendants)];
const fixtures = {};
const checks = [];
const approvalEvents = [];
const executions = [];
let session, auth, mode, terminal;
try {
  auth = await AuthStorage.create(join(directory, 'auth.db'));
  auth.keys.setRuntime('openai', 'local-fixture-only');
  const model = getBundledModel('openai', 'gpt-4o-mini');
  assert.ok(model);
  const mock = createMockModel({ responses: [
    { content: [{ type: 'toolCall', name: 'perch_fixture', arguments: { note: 'User must approve this exact inert fixture.' } }] },
    { content: ['The fixture decision was received.'] },
    { content: [{ type: 'toolCall', name: 'perch_fixture', arguments: { note: 'User must approve this exact inert fixture.' } }] },
    { content: ['The second fixture decision was received.'] },
  ] });
  const created = await createAgentSession({ cwd: directory, agentDir: directory, authStorage: auth,
    modelRegistry: new ModelRegistry(auth, join(directory, 'models.yml')), model,
    settings: Settings.isolated({ 'compaction.enabled': false, 'retry.maxRetries': 0, 'tools.approvalMode': 'always-ask' }),
    sessionManager: SessionManager.inMemory(directory), disableExtensionDiscovery: true,
    extensions: [api => {
      api.registerTool({ name: 'perch_fixture', label: 'Perch fixture', description: 'An inert verifier tool.',
        approval: args => ({ tier: 'exec', reason: args.note }), parameters: api.zod.object({ note: api.zod.string() }),
        execute: async (_id, args) => { executions.push(args); return { content: [{ type: 'text', text: 'No side effect.' }] }; } });
      api.on('tool_approval_requested', event => { approvalEvents.push(event); });
      api.on('tool_approval_resolved', event => { approvalEvents.push(event); });
    }], skills: [], contextFiles: [], promptTemplates: [], slashCommands: [], rules: [], preloadedCustomToolPaths: [],
    enableMCP: false, enableLsp: false, skipPythonPreflight: true, cacheWarming: false, toolNames: ['perch_fixture'] });
  session = created.session;
  session.agent.streamFn = mock.stream;
  await Settings.init({ inMemory: true, cwd: directory });
  await initTheme();
  terminal = new OmpTspTerminal({ TspDocument, splitTspMessage, kinds: TSP_KINDS });
  mode = new InteractiveMode(session, version, undefined, created.setToolUIContext, undefined, undefined, undefined,
    new Composer({ terminal }));
  await mode.init({ suppressWelcomeIntro: true, autoStartCollab: false });
  await until(() => mode.ui.nativeRendering && terminal.snapshot(), 'actual OMP native renderer');
  const originalPid = process.pid, originalSession = session.sessionManager.getSessionId();
  const picker = () => terminal.find(node => node.k === 'picker' && node.p?.items?.some(item => text(item.label) === 'Approve'));
  const activate = (node, item) => terminal.event({ ev: 'activate', sf: terminal.surface, id: node.id, item });

  const firstTurn = session.prompt('Request the inert approval fixture.');
  const first = await until(picker, 'real tool approval picker');
  fixtures.approvalPicker = structuredClone(terminal.snapshot());
  assert.match(text(first.p.title) + '\n' + text(first.p.subtitle), /User must approve this exact inert fixture/);
  assert.equal(executions.length, 0);
  activate(first, first.p.items.find(item => text(item.label) === 'Deny').id);
  await firstTurn;
  assert.equal(executions.length, 0);
  assert.equal(approvalEvents.at(-1).approved, false);
  await until(() => !picker(), 'dismissed approval picker');
  checks.push('A TSP activate reaches the stock tool approval selector and Deny prevents the inert tool from executing.');

  const secondTurn = session.prompt('Request the same inert approval fixture again.');
  const second = await until(picker, 'second identical approval picker');
  assert.notEqual(second.id, first.id);
  activate(first, first.p.items.find(item => text(item.label) === 'Approve').id);
  await Bun.sleep(30);
  assert.equal(executions.length, 0);
  assert.equal(picker()?.id, second.id);
  activate(second, second.p.items.find(item => text(item.label) === 'Approve').id);
  await secondTurn;
  assert.equal(executions.length, 1);
  assert.equal(approvalEvents.at(-1).approved, true);
  await until(() => !picker(), 'second approval dismissal');
  checks.push('A new identical approval has a different component ID; an old event cannot approve it, while its own Approve executes the inert tool once.');

  let fallbackSettled = false;
  const fallbackAnswer = mode.showHookSelector('Allow tool: perch_fixture\nReason: disabled choice fixture',
    ['Approve', 'Deny'], { disabledIndices: [0] },
    { slider: { caption: 'Fixture tier', index: 0, segments: [{ label: 'default', detail: 'Inert local fixture' }] } });
  void fallbackAnswer.then(() => { fallbackSettled = true; });
  const fallbackRoot = await until(() => terminal.find(node => node.p?.role === 'omp.overlay.hook-select'), 'fallback selector');
  fixtures.approvalFallback = structuredClone(terminal.snapshot());
  const fallbackList = descendants(fallbackRoot).find(node => node.k === 'list');
  assert.ok(fallbackList);
  activate(fallbackList, fallbackList.c[0].id);
  await Bun.sleep(30); assert.equal(fallbackSettled, false);
  activate(fallbackList, fallbackList.c[1].id);
  assert.equal(await fallbackAnswer, 'Deny');
  checks.push('The actual fallback selector accepts its fully qualified list/item IDs and rejects a disabled option.');

  // Real InteractiveMode plan handler: refine dismisses the review and keeps
  // planning active. No plan execution, network call, or private replacement.
  const planFilePath = join(directory, 'perch-owner-plan.md');
  const plan = '# Owner controls\n\n## Goal\n\nReview this plan from the phone.\n\n## Next step\n\nKeep the same host process.\n';
  const planPath = planFilePath;
  await mkdir(dirname(planPath), { recursive: true }); await writeFile(planPath, plan);
  mode.planModeEnabled = true;
  mode.planModePlanFilePath = planFilePath;
  session.setPlanModeState({ enabled: true, planFilePath });
  const planAnswer = mode.handlePlanApproval({ planFilePath, planExists: true, title: 'Owner controls' });
  const planOptions = await until(() => terminal.find(node => node.p?.role === 'omp.plan.options'), 'real plan review');
  fixtures.planReview = structuredClone(terminal.snapshot());
  const refine = planOptions.c.find(item => text(item.p?.label) === 'Refine plan');
  assert.ok(refine);
  const body = terminal.find(node => node.p?.role === 'omp.plan.body');
  const displayedPlan = descendants(body).filter(node => node.k === 'md').map(node => text(node.p?.text)).join('\n\n');
  assert.equal(displayedPlan, '## Goal\n\nReview this plan from the phone.\n\n\n\n## Next step\n\nKeep the same host process.\n');
  assert.notEqual(displayedPlan, plan, 'OMP omits the sheet title from the body and emits separate Markdown sections.');
  activate(planOptions, refine.id);
  await planAnswer;
  await until(() => !terminal.find(node => node.p?.role === 'omp.plan.options'), 'plan review dismissal');
  assert.equal(mode.planModeEnabled, true);
  assert.equal(mock.calls.length, 4);
  checks.push('A TSP plan choice resolves the stock InteractiveMode plan handler; Refine plan dismisses review, keeps plan mode, and makes no new provider call.');
  checks.push('The native plan matches the known source sections; it omits the source title from the body, so the displayed projection is not an exact plan file export.');

  const ui = mode.getToolUIContext(); assert.ok(ui);
  const editorAbort = new AbortController();
  let editorSettled = false;
  const editorAnswer = ui.editor('Plan follow-up fixture', 'Existing text', { signal: editorAbort.signal });
  void editorAnswer.then(() => { editorSettled = true; });
  const inputRoot = await until(() => terminal.find(node => node.p?.role === 'omp.overlay.hook-editor'), 'real editor request');
  fixtures.editor = structuredClone(terminal.snapshot());
  const editor = descendants(inputRoot).find(node => ['editor', 'input'].includes(node.k));
  assert.ok(editor); assert.equal(editor.p.sendable, false);
  const reply = 'Phone feedback 🦜\nKeep the plan focused.';
  terminal.event({ ev: 'send', sf: terminal.surface, id: editor.id, text: reply });
  await Bun.sleep(30);
  assert.equal(editorSettled, false);
  editorAbort.abort(); assert.equal(await editorAnswer, undefined);
  checks.push('The stock rich editor advertises sendable:false and ignores atomic send; it must remain unsupported by this first remote request slice.');

  const inputAbort = new AbortController();
  let inputSettled = false;
  const inputAnswer = ui.input('Simple request fixture', undefined, { signal: inputAbort.signal });
  void inputAnswer.then(() => { inputSettled = true; });
  const simpleRoot = await until(() => terminal.find(node => node.p?.role === 'omp.overlay.hook-input'), 'simple input request');
  fixtures.input = structuredClone(terminal.snapshot());
  const input = descendants(simpleRoot).find(node => ['editor', 'input'].includes(node.k));
  assert.ok(input); assert.equal(input.p.sendable, false);
  terminal.event({ ev: 'send', sf: terminal.surface, id: input.id, text: reply });
  await Bun.sleep(30); assert.equal(inputSettled, false);
  inputAbort.abort(); assert.equal(await inputAnswer, undefined);
  checks.push('The stock simple input also advertises sendable:false and ignores atomic send; it remains unsupported.');

  assert.equal(session.sessionManager.getSessionId(), originalSession);
  assert.equal(process.pid, originalPid);
  assert.deepEqual(terminal.errors, []);
  const result = { verified: true, ompVersion: version, agentSessionsCreated: 1, sameConversation: true,
    modelCalls: mock.calls.length, paidProviderCalls: 0, inertToolExecutions: executions.length, checks,
    planProjection: { sourceCharacters: plan.length, displayedCharacters: displayedPlan.length,
      sourceSha256: new Bun.CryptoHasher('sha256').update(plan).digest('hex'),
      displayedSha256: new Bun.CryptoHasher('sha256').update(displayedPlan).digest('hex'), byteIdenticalToFile: false },
    limitations: ['Protocol terminal recorder, not a Tern binary or physical phone.',
      'TSP activate has no expected-document revision; fresh host inspection is not an atomic cross-process compare-and-resolve.',
      'Refine plan leaves feedback to the next explicit prompt; section annotation editing is separate.',
      'Both extension rich editors and simple inputs lack atomic native send in this pinned OMP build.'] };
  const output = process.env.PERCH_OMP_REQUEST_FIXTURES;
  if (output) await writeFile(resolve(output), JSON.stringify({ result, fixtures }, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally {
  mode?.stop(); await session?.dispose(); auth?.close();
  await rm(directory, { recursive: true, force: true });
}
