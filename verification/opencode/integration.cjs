/* Actual pinned OpenCode + actual gateway + phone adapter. Only synthetic loopback model data. */
const http = require('node:http');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { assert, fs, path, os, project, wait, until, compile, listen, close } = require('./helpers.cjs');

async function main() {
  const code = compile(); const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'perch-opencode-integration-'));
  const workspace = path.join(temp, 'workspace'); fs.mkdirSync(workspace);
  const providerKey = 'public-synthetic-provider-key'; const upstreamPassword = 'public-upstream-fixture-password'; const phonePassword = 'public-phone-fixture-password';
  const modelRequests = []; let child; let gateway; let driver; let state; let logs = ''; let serverUrl; let interruptedModel = false;
  const contents = '<!doctype html><html><body><h1>Perch real OpenCode fixture</h1></body></html>';
  const filename = path.join(workspace, 'preview.html');
  const model = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)); modelRequests.push(body);
    assert.equal(req.headers.authorization, `Bearer ${providerKey}`);
    const text = JSON.stringify(body.messages);
    const tools = body.tools || [];
    const lastUserIndex = body.messages.findLastIndex(message => message.role === 'user');
    const abortTurn = JSON.stringify(body.messages[lastUserIndex]).includes('PERCH_INTEGRATION_ABORT');
    const tail = body.messages.slice(lastUserIndex + 1);
    const hasResult = tail.some(message => message.role === 'tool');
    let tool;
    if (tools.length && !abortTurn && !hasResult && text.includes('PERCH_INTEGRATION_WRITE')) tool = { name: 'write', arguments: JSON.stringify({ filePath: filename, content: contents }) };
    if (tools.length && !abortTurn && !hasResult && text.includes('PERCH_INTEGRATION_QUESTION')) tool = { name: 'question', arguments: JSON.stringify({ questions: [{ question: 'Which artifact should be read?', header: 'Artifact', options: [{ label: 'HTML', description: 'Open the generated page' }, { label: 'Markdown', description: 'Read the notes' }], multiple: false }] }) };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: `chatcmpl_${modelRequests.length}`, object: 'chat.completion.chunk', created: 1700000000, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    chunk({ role: 'assistant' });
    if (tool) {
      chunk({ tool_calls: [{ index: 0, id: `call_${modelRequests.length}`, type: 'function', function: tool }] }); chunk({}, 'tool_calls');
    } else {
      const answer = abortTurn ? 'Synthetic interruption stream. '.repeat(50) : tools.length ? '# Fixture artifact\n\nThe real OpenCode harness finished using the local synthetic model.\n\n```html filename="answer.html"\n<h1>OpenCode artifact answer</h1>\n```' : 'Perch fixture session';
      for (const part of answer.match(/.{1,32}|\n/g) || []) { if (res.destroyed) break; chunk({ content: part }); await wait(120); }
      if (abortTurn && res.destroyed) interruptedModel = true;
      if (!res.destroyed) chunk({}, 'stop');
    }
    if (!res.destroyed) res.end('data: [DONE]\n\n');
  });
  const modelUrl = await listen(model);
  try {
    const settings = { model: 'perch-fixture/test-model', small_model: 'perch-fixture/test-model', enabled_providers: ['perch-fixture'], provider: { 'perch-fixture': { npm: '@ai-sdk/openai-compatible', name: 'Perch fixture', options: { baseURL: modelUrl + '/v1', apiKey: providerKey }, models: { 'test-model': { name: 'Synthetic test model', limit: { context: 128000, output: 8192 } }, 'alternate-model': { name: 'Alternate synthetic model', limit: { context: 128000, output: 8192 } } } } }, permission: { edit: 'ask', question: 'allow' }, share: 'disabled', autoupdate: false };
    child = spawn(path.join(__dirname, 'node_modules/.bin/opencode'), ['serve', '--hostname', '127.0.0.1', '--port', '0', '--pure'], { cwd: workspace, env: { PATH: process.env.PATH, TERM: 'dumb', XDG_CONFIG_HOME: path.join(temp, 'config'), XDG_CACHE_HOME: path.join(temp, 'cache'), XDG_DATA_HOME: path.join(temp, 'data'), XDG_STATE_HOME: path.join(temp, 'state'), OPENCODE_CONFIG_CONTENT: JSON.stringify(settings), OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: '1', OPENCODE_PURE: '1', OPENCODE_SERVER_PASSWORD: upstreamPassword } });
    const capture = chunk => { logs = (logs + chunk).slice(-80_000); const match = logs.match(/http:\/\/127\.0\.0\.1:\d+/); if (match) serverUrl = match[0]; };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    await until(() => serverUrl || child.exitCode !== null, 'OpenCode server start', 30_000);
    if (!serverUrl) throw new Error(`OpenCode did not start: ${logs.slice(-4000)}`);
    const { configuration, createGateway } = await import(pathToFileURL(path.join(project, 'server/opencode-gateway/index.mjs')));
    gateway = createGateway(configuration({ OPENCODE_URL: serverUrl, OPENCODE_SERVER_PASSWORD: upstreamPassword, PERCH_OPENCODE_PASSWORD: phonePassword, PERCH_OPENCODE_PORT: '0' }));
    const gatewayUrl = await listen(gateway);
    const upstreamAuth = `Basic ${Buffer.from(`opencode:${upstreamPassword}`).toString('base64')}`;
    const phoneAuth = `Basic ${Buffer.from(`perch:${phonePassword}`).toString('base64')}`;
    // This host-side read proves why the mobile gateway is required; all values are synthetic.
    const raw = await fetch(`${serverUrl}/provider?directory=${encodeURIComponent(workspace)}`, { headers: { Authorization: upstreamAuth } });
    assert.equal(raw.status, 200, 'Raw OpenCode catalog available');
    assert((await raw.text()).includes(providerKey), 'Pinned raw OpenCode catalog contains the configured synthetic key');
    const sanitized = await fetch(`${gatewayUrl}/provider?directory=${encodeURIComponent(workspace)}`, { headers: { Authorization: phoneAuth } });
    assert.equal(sanitized.status, 200); const safeText = await sanitized.text(); assert(!safeText.includes(providerKey)); assert(!safeText.includes(upstreamPassword));
    const updates = []; const connect = async () => { driver = await code.createOpenCodeDriver({ url: gatewayUrl, username: 'perch', password: phonePassword }, update => { state = update; updates.push(update); }); driver.connect(); await until(() => state?.connection.status === 'live' || state?.connection.status === 'error', 'Phone connects through real gateway', 30_000); assert.equal(state.connection.status, 'live', JSON.stringify(state.connection)); };
    await connect(); assert.equal(state.sessions.length, 0); assert.equal(state.capabilities.prompt, false); assert.equal(state.harness.version, '1.18.35');
    const first = await driver.createSession(); assert(first); assert.equal(state.session.id, first); assert.equal(state.availableModels.length, 2);
    driver.setModel('perch-fixture', 'alternate-model');
    driver.sendPrompt('PERCH_INTEGRATION_WRITE: Create the synthetic preview file.');
    await until(() => state.pendingQuestion || state.connection.status !== 'live', 'Real write permission', 30_000);
    assert.equal(state.pendingQuestion?.title, 'OpenCode permission', JSON.stringify(state.connection));
    assert.equal(fs.existsSync(filename), false, 'No file before explicit permission');
    driver.answerQuestion(state.pendingQuestion, 'once');
    await until(() => fs.existsSync(filename) && !state.isWorking && state.messages.some(message => message.text.includes('OpenCode artifact answer')), 'Real tool and artifact response', 30_000);
    assert.equal(fs.readFileSync(filename, 'utf8'), contents);
    assert(state.tools.some(tool => tool.name === 'write' && tool.status === 'done' && tool.artifact?.content === contents));
    assert(modelRequests.some(request => request.model === 'alternate-model'), 'Selected model reaches actual provider request');
    assert(updates.some(update => update.messages.some(message => message.streaming && message.text)), 'Actual streaming text projected');
    assert(state.messages.some(message => message.role === 'user' && message.text.includes('PERCH_INTEGRATION_WRITE')), 'Actual user prompt remains in the normalized transcript');
    assert(!JSON.stringify(state).includes(providerKey)); assert(!JSON.stringify(state).includes(upstreamPassword));
    const second = await driver.createSession(); assert(second && second !== first); assert.equal(state.messages.length, 0);
    driver.sendPrompt('PERCH_INTEGRATION_QUESTION: Ask the synthetic artifact choice.');
    await until(() => state.pendingQuestion?.id.startsWith('question:'), 'Real question tool', 30_000);
    driver.answerQuestion(state.pendingQuestion, 'option:0');
    await until(() => !state.pendingQuestion && !state.isWorking && state.messages.some(message => message.text.includes('OpenCode artifact answer')), 'Real question reply and completion', 30_000);
    driver.sendPrompt('PERCH_INTEGRATION_ABORT: Stream a synthetic answer until interrupted.');
    await until(() => state.isWorking && state.messages.some(message => message.streaming && message.text.includes('Synthetic interruption stream.')), 'Actual model response before interrupt', 30_000);
    driver.interrupt(); await until(() => !state.isWorking && interruptedModel, 'Actual OpenCode model request cancellation', 10_000);
    driver.selectSession(first); await until(() => state.session.id === first && !state.sessionAction, 'Real session selection');
    assert(state.tools.some(tool => tool.artifact?.content === contents));
    const before = modelRequests.length; driver.close(); await connect();
    assert.equal(modelRequests.length, before, 'Reconnect makes no model request');
    assert.equal(state.sessions.length, 2, 'Server-owned history survives phone driver replacement');
    driver.selectSession(first); await until(() => state.session.id === first, 'First session after reconnect'); assert(state.tools.some(tool => tool.artifact?.content === contents));
    console.log(`PASS actual OpenCode ${state.harness.version}: isolated synthetic model, credential-sanitizing gateway, two server-owned sessions, selected provider model, incremental text, explicit write permission, actual file output/artifact, question tool, model interruption, session switching, reconnect without model replay.`);
  } catch (error) {
    if (logs) console.error('Synthetic OpenCode fixture log tail:', logs.slice(-4000));
    throw error;
  } finally {
    driver?.close(); if (gateway) await close(gateway);
    if (child && child.exitCode === null) { child.kill('SIGTERM'); await Promise.race([new Promise(resolve => child.once('exit', resolve)), wait(3000)]); if (child.exitCode === null) child.kill('SIGKILL'); }
    await close(model); code.close(); fs.rmSync(temp, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
