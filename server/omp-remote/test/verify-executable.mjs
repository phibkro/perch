/** Opt-in qualification of an actual OMP CLI executable; only a synthetic loopback model is used. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { createServer as netServer } from 'node:net';
assert.ok(process.env.OMP_BIN, 'Set OMP_BIN to the separately supplied OMP executable.');
const binary = resolve(process.env.OMP_BIN);
const repository = fileURLToPath(new URL('../../..', import.meta.url));
const root = await mkdtemp(join(tmpdir(), 'perch-omp-executable-'));
const hash = createHash('sha256');
for await (const chunk of createReadStream(binary))
    hash.update(chunk);
const binarySha256 = hash.digest('hex');
await mkdir(root, { recursive: true });
await mkdir(join(root, 'profile'), { recursive: true });
await mkdir(join(root, 'work'), { recursive: true });
const fixtureToken = 'perch_local_inert_binary_qualification_20261010';
const savedContent = '<!doctype html>\r\n<title>Saved file 🦜</title>\r\n<p>Exact bytes from the stock write tool.</p>\r\n';
let calls = 0, child, stdout = '', stderr = '', frames = [], buffer = '';
const recorded = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const provider = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req)
        body += chunk;
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.writeHead(404);
        res.end('fixture route only');
        return;
    }
    const input = JSON.parse(body);
    assert.equal(input.model, 'fixed');
    calls++;
    const number = calls;
    recorded.push({ number, path: req.url });
    if (number === 5)
        await sleep(3000);
    if (res.destroyed)
        return;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: `fixture-${number}`, object: 'chat.completion.chunk', created: 1, model: 'fixed', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    chunk({ role: 'assistant' });
    if (number === 1 || number === 3) {
        chunk({ tool_calls: [{ index: 0, id: `inert-${number}`, type: 'function', function: { name: 'perch_fixture', arguments: JSON.stringify({ note: 'This uploaded executable must ask for this inert tool.' }) } }] });
        chunk({}, 'tool_calls');
    }
    else if (number === 7) {
        chunk({ tool_calls: [{ index: 0, id: 'saved-file-7', type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: 'captured-preview.html', content: savedContent }) } }] });
        chunk({}, 'tool_calls');
    }
    else {
        chunk({ content: number === 2 ? 'The denied fixture did not execute.' : number === 4 ? 'The approved fixture executed once.' : number === 6 ? 'The uploaded process continued after reconnect.' : number === 8 ? 'The stock write saved the complete file.' : 'This delayed response should be aborted.' });
        chunk({}, 'stop');
    }
    res.end('data: [DONE]\n\n');
});
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
const providerUrl = `http://127.0.0.1:${provider.address().port}/v1`;
const portProbe = netServer();
await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
const port = portProbe.address().port;
await new Promise(resolve => portProbe.close(resolve));
await writeFile(join(root, 'remote.json'), JSON.stringify({ version: 1, id: 'omp_upload_fixture', name: 'Uploaded OMP fixture', hostId: 'fixture_host', hostName: 'Private fixture', token: fixtureToken, port }), { mode: 0o600 });
await writeFile(join(root, 'fixture-extension.ts'), `
import {appendFileSync} from 'node:fs';
const log=${JSON.stringify(join(root, 'events.jsonl'))};
export default function(api){
 let id;
 const record=value=>appendFileSync(log,JSON.stringify({pid:process.pid,sessionId:id,...value})+'\\n');
 api.registerProvider('perch-fixture',{api:'openai-completions',baseUrl:${JSON.stringify(providerUrl)},apiKey:'inert-local-fixture',models:[{id:'fixed',name:'Private deterministic fixture',reasoning:true,thinking:{mode:'effort',efforts:['low','medium','high']},input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32768,maxTokens:2048}]});
 api.registerTool({name:'perch_fixture',label:'Perch fixture',description:'An inert tool used only by this executable verifier.',parameters:api.zod.object({note:api.zod.string()}),approval:args=>({tier:'exec',reason:args.note}),execute:async(_id,args)=>{record({type:'tool-executed',args});return {content:[{type:'text',text:'No side effects.'}]};}});
 api.on('session_start',(_event,ctx)=>{id=ctx.sessionManager.getSessionId();record({type:'started',version:api.pi.VERSION,hasUI:ctx.hasUI,mode:ctx.mode,writeSource:api.getAllTools().find(tool=>tool.name==='write')?.sourceInfo});});
 api.on('tool_approval_requested',event=>record(event));
 api.on('tool_approval_resolved',event=>record(event));
 api.on('tool_execution_end',event=>{if(event.toolName==='write')record({type:'stock-write-completed',toolCallId:event.toolCallId,isError:event.isError});});
 api.on('agent_end',event=>record({type:'agent_end'}));
}
`);
await writeFile(join(root, 'events.jsonl'), '');
const env = { ...process.env, PI_CODING_AGENT_DIR: join(root, 'profile'), PI_TEST_RUNTIME: '1', PERCH_OMP_CONFIG: join(root, 'remote.json'), NO_PROXY: '127.0.0.1,localhost,::1', no_proxy: '127.0.0.1,localhost,::1' };
for (const key of Object.keys(env))
    if (key.includes('API_KEY') || key.endsWith('OAUTH_TOKEN') || key.endsWith('ACCESS_TOKEN'))
        delete env[key];
const rpc = value => child.stdin.write(JSON.stringify(value) + '\n');
const until = async (read, accept, label) => {
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline && child.exitCode === null) {
        const value = await read();
        if (accept(value))
            return value;
        await sleep(100);
    }
    throw new Error(`${label} did not arrive. exit=${child.exitCode}. stderr=${stderr.slice(-3000)}. frames=${JSON.stringify(frames.slice(-5)).slice(-5000)}`);
};
const request = async (path, value) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: value ? 'POST' : 'GET', headers: { authorization: `Bearer ${fixtureToken}`, 'content-type': 'application/json' }, body: value ? JSON.stringify(value) : undefined, signal: AbortSignal.timeout(5000) });
    const result = await response.json();
    if (response.status === 409)
        assert.equal(result.status, 'rejected', JSON.stringify(result));
    else
        assert.equal(response.status, 200, JSON.stringify(result));
    return result;
};
const events = async () => (await readFile(join(root, 'events.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
try {
    child = spawn(binary, ['--mode', 'rpc-ui', '--no-extensions', '--no-skills', '--no-rules', '--no-lsp', '--no-title', '--no-session', '--tools', 'perch_fixture,write', '--model', 'perch-fixture/fixed', '--thinking', 'off', '--approval-mode', 'always-ask', '--extension', join(root, 'fixture-extension.ts'), '--extension', join(repository, 'server/omp-remote/extension.ts')], { cwd: join(root, 'work'), env, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => { stdout += chunk; buffer += chunk; for (;;) {
        const i = buffer.indexOf('\n');
        if (i < 0)
            break;
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        try {
            frames.push(JSON.parse(line));
        }
        catch { }
    } });
    child.stderr.on('data', chunk => stderr += chunk);
    await until(events, values => values.some(x => x.type === 'started'), 'extension startup');
    const health = await request('/perch/health');
    const catalog = await request('/perch/sessions');
    const session = catalog.sessions[0];
    assert.ok(session);
    assert.equal(session.pid, child.pid);
    const path = `/perch/sessions/${session.id}`;
    const command = (id, type, extra = {}) => ({ id, epoch: health.epoch, generation: session.generation, conversationId: session.conversationId, type, ...extra });
    const post = value => request(`${path}/commands`, value);
    const read = () => request(path);
    const initial = await read();
    assert.equal(initial.capabilities.prompt, true);
    assert.equal(initial.capabilities.sessionRename, true);
    assert.ok(initial.insights.tools.some(tool => tool.name === 'perch_fixture' && tool.active));
    assert.equal((await post(command('rename', 'rename-session', { title: 'Executable verification 🦜' }))).status, 'forwarded');
    await until(read, x => x.session.title === 'Executable verification 🦜', 'renamed owner session');
    assert.equal(initial.capabilities.thinkingSelection, true);
    assert.ok(initial.insights.thinking.availableLevels.includes('low'));
    assert.equal((await post(command('thinking', 'set-thinking', { provider: 'perch-fixture', modelId: 'fixed', level: 'low' }))).status, 'forwarded');
    await until(read, x => x.insights.thinking.level === 'low', 'applied owner thinking level');
    assert.equal((await post(command('stale-model', 'set-thinking', { provider: 'perch-fixture', modelId: 'different', level: 'low' }))).status, 'rejected');
    assert.equal(calls, 0);
    await post(command('first-tool', 'prompt', { text: 'Run the first inert approval fixture.' }));
    const first = await until(() => frames, values => values.find(x => x.type === 'extension_ui_request' && x.method === 'select'), 'first real RPC approval');
    const question1 = first.find(x => x.type === 'extension_ui_request' && x.method === 'select');
    assert.ok(question1.options.includes('Deny'));
    rpc({ type: 'extension_ui_response', id: question1.id, value: 'Deny' });
    await until(read, x => x.messages.some(m => m.text.includes('The denied fixture did not execute.')), 'denied result');
    assert.equal((await events()).filter(x => x.type === 'tool-executed').length, 0);
    await post(command('second-tool', 'prompt', { text: 'Run the same inert approval fixture again.' }));
    const second = await until(() => frames, values => values.find(x => x.type === 'extension_ui_request' && x.method === 'select' && x.id !== question1.id), 'second real RPC approval');
    const question2 = second.find(x => x.type === 'extension_ui_request' && x.method === 'select' && x.id !== question1.id);
    assert.ok(question2.options.includes('Approve'));
    rpc({ type: 'extension_ui_response', id: question2.id, value: 'Approve' });
    await until(read, x => x.messages.some(m => m.text.includes('The approved fixture executed once.')), 'approved result');
    assert.equal((await events()).filter(x => x.type === 'tool-executed').length, 1);
    const repeat = await post(command('second-tool', 'prompt', { text: 'Run the same inert approval fixture again.' }));
    assert.equal(repeat.status, 'forwarded');
    assert.equal(calls, 4);
    await request('/perch/health');
    await request('/perch/sessions');
    await read();
    assert.equal(calls, 4);
    await post(command('slow-turn', 'prompt', { text: 'Keep working while the phone reconnects.' }));
    await until(() => calls, n => n === 5, 'delayed turn start');
    await post(command('interrupt', 'interrupt'));
    await until(read, x => x.session.status !== 'working', 'interrupted idle state');
    await post(command('continued', 'prompt', { text: 'Continue the same conversation after interruption.' }));
    await until(read, x => x.messages.some(m => m.text.includes('The uploaded process continued after reconnect.')), 'continued same process');
    const final = await read();
    assert.equal(final.session.conversationId, session.conversationId);
    assert.equal(final.session.pid, child.pid);
    assert.equal(calls, 6);
    assert.equal(final.insights.context.contextWindow, 32768);
    assert.ok(final.insights.context.tokens >= 0);
    const started = (await events()).find(event => event.type === 'started');
    assert.equal(started.writeSource.source, 'builtin');
    const saveCommand = command('save-file', 'prompt', { text: 'Use the stock write tool to save the private HTML fixture.' });
    assert.equal((await post(saveCommand)).status, 'forwarded');
    const third = await until(() => frames, values => values.find(x => x.type === 'extension_ui_request' && x.method === 'select' && x.id !== question1.id && x.id !== question2.id), 'stock write approval');
    const question3 = third.find(x => x.type === 'extension_ui_request' && x.method === 'select' && x.id !== question1.id && x.id !== question2.id);
    assert.ok(question3.options.includes('Approve'));
    rpc({ type: 'extension_ui_response', id: question3.id, value: 'Approve' });
    const saved = await until(read, x => x.storedArtifacts?.length === 1 && x.messages.some(m => m.text.includes('The stock write saved the complete file.')), 'captured stock write');
    const manifest = saved.storedArtifacts[0], expected = Buffer.from(savedContent);
    assert.equal(manifest.filename, 'captured-preview.html');
    assert.equal(manifest.mimeType, 'text/html');
    assert.equal(manifest.sourceId, 'tool:saved-file-7');
    assert.equal(manifest.bytes, expected.length);
    assert.equal(manifest.sha256, createHash('sha256').update(expected).digest('hex'));
    assert.deepEqual(await readFile(join(root, 'work', 'captured-preview.html')), expected);
    const download = async () => {
        const response = await fetch(`http://127.0.0.1:${port}${path}/artifacts/${manifest.id}`, { headers: { authorization: `Bearer ${fixtureToken}` }, signal: AbortSignal.timeout(5000) });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('etag'), `"${manifest.sha256}"`);
        assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected);
    };
    await download();
    await writeFile(join(root, 'work', 'captured-preview.html'), 'A later independent edit.');
    await download();
    assert.equal((await post(saveCommand)).status, 'forwarded');
    await read();
    assert.equal(calls, 8);
    assert.equal((await events()).filter(event => event.type === 'stock-write-completed' && event.isError === false).length, 1);
    const result = { verified: true, binaryVersion: started.version, binarySha256, pid: child.pid, conversationId: session.conversationId, modelCalls: calls, paidProviderCalls: 0, inertToolExecutions: 1, stockWriteExecutions: 1, capturedArtifacts: 1, checks: ['Uploaded executable loads the production Perch extension.', 'Authenticated Perch catalog identifies the actual CLI process and canonical conversation.', 'Perch prompt invokes the synthetic local provider in that same owner process.', 'Actual RPC-UI owner Deny prevents the inert tool; Approve executes once.', 'Duplicate command receipt and reconnect reads do not replay prompts.', 'Perch interrupt preserves the owner process and conversation.', 'A subsequent phone prompt completes in the original conversation.', 'Session rename, declared thinking selection, stale-model rejection, context estimate and active tool catalog work through the uploaded owner.', 'Public tool sourceInfo identifies the stock write; its successful event produces an exact SHA256 artifact download.', 'Captured bytes stay unchanged after an independent file edit; receipt replay does not run write again.'], limitations: ['Uses RPC-UI owner callbacks for approval; Perch direct extension still has no stock owner approval resolver.', 'No paid provider, user session, physical phone, or Tern in this isolated CLI qualification.'] };
    if (process.env.PERCH_OMP_EXECUTABLE_RESULT)
        await writeFile(process.env.PERCH_OMP_EXECUTABLE_RESULT, JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result, null, 2));
}
catch (error) {
    console.error(error.stack ?? error);
    process.exitCode = 1;
}
finally {
    if (child && child.exitCode === null) {
        child.kill('SIGTERM');
        await Promise.race([new Promise(r => child.once('exit', r)), sleep(1000)]);
        if (child.exitCode === null)
            child.kill('SIGKILL');
    }
    await writeFile(join(root, 'stdout.jsonl'), stdout);
    await writeFile(join(root, 'stderr.log'), stderr);
    await writeFile(join(root, 'provider-calls.json'), JSON.stringify(recorded, null, 2) + '\n');
    provider.closeAllConnections();
    await new Promise(r => provider.close(r));
    if (process.env.PERCH_OMP_EXECUTABLE_KEEP_FAILURE === '1' && process.exitCode)
        console.error('Kept private fixture directory: ' + root);
    else
        await rm(root, { recursive: true, force: true });
}
