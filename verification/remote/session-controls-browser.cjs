#!/usr/bin/env node
/** Actual exported Expo UI + real Chromium. No model, account, or real host. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { createSessionControlsFixture } = require('./session-controls-fixture.cjs');

const args = process.argv.slice(2);
const preview = args[0];
if (!preview) throw new Error('Provide the current standalone Expo HTML preview as the first argument.');
const outputIndex = args.indexOf('--output');
const output = path.resolve(outputIndex < 0 ? 'verification-output/session-controls-browser' : args[outputIndex + 1]);
const source = fs.readFileSync(preview);
const fixture = createSessionControlsFixture();
const checks = [], errors = [], blocked = [], warnings = [], layoutIssues = [];
const check = message => { checks.push(message); console.log(message); };
let browser, server, page;

async function until(test, message, timeout = 18000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    assert.deepEqual(errors, [], `browser errors while waiting for ${message}`);
    if (await test()) return;
    await new Promise(resolve => setTimeout(resolve, 75));
  }
  throw new Error(`Timed out: ${message}`);
}

(async () => {
  fs.mkdirSync(output, { recursive: true });
  for (const filename of ['result.json', 'failure.json', 'failure.png', 'failure-dom.txt']) fs.rmSync(path.join(output, filename), { force: true });
  for (const filename of fs.readdirSync(output)) if (/^layout-failure-\d+\.png$/.test(filename)) fs.rmSync(path.join(output, filename));
  try {
    const moduleName = process.env.PERCH_PLAYWRIGHT_MODULE;
    const { chromium } = await import(moduleName ? pathToFileURL(path.resolve(moduleName)).href : 'playwright');
    server = http.createServer((request, response) => {
      if (request.url !== '/') { response.writeHead(404); response.end(); return; }
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(source);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const appOrigin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.PERCH_CHROMIUM_EXECUTABLE || undefined,
      args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
    page = await browser.newPage({ viewport: { width: 412, height: 844 }, deviceScaleFactor: 1, locale: 'en-US' });
    page.on('pageerror', error => errors.push(String(error)));
    page.on('console', message => { if (message.type() === 'warning') warnings.push(message.text()); });
    await page.route('**/*', async route => {
      const request = route.request(); const url = new URL(request.url());
      if (url.origin === appOrigin) return route.continue();
      if (url.origin !== fixture.origin) { blocked.push(request.url()); return route.abort('blockedbyclient'); }
      const cors = { 'Access-Control-Allow-Origin': appOrigin, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'authorization, content-type' };
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      try {
        const response = await fixture.fetch(request.url(), { method: request.method(), headers: request.headers(), body: request.postData() });
        return route.fulfill({ status: response.status, headers: { ...Object.fromEntries(response.headers), ...cors }, body: Buffer.from(await response.arrayBuffer()) });
      } catch (error) {
        if (String(error).includes('Synthetic host offline')) return route.abort('connectionfailed');
        errors.push(String(error)); return route.abort('failed');
      }
    });
    const label = name => page.getByRole('button', { name, exact: true });
    const controls = () => page.getByTestId('session-controls');
    const titleInput = () => page.getByRole('textbox', { name: 'Chat title', exact: true });
    const thinking = level => page.getByRole('radio', { name: `Thinking level ${level}`, exact: true });
    async function sidebar() { if (!await page.getByTestId('chat-sidebar').count()) await label('Open sidebar').click(); }
    async function openControls() { await label('Host session controls').click(); await controls().waitFor({ state: 'visible' }); }
    async function closeSheet() { await label('Close sheet').click(); await controls().waitFor({ state: 'hidden' }); }
    async function settings() { await sidebar(); await label('Connection').click(); }
    async function capture(name) { await page.screenshot({ path: path.join(output, `${name}.png`), animations: 'disabled' }); }
    async function noHorizontalOverflow(locator, description) {
      const issue = await locator.evaluate(element => {
        if (element.scrollWidth <= element.clientWidth + 1) return null;
        const right = element.getBoundingClientRect().right;
        return { clientWidth: element.clientWidth, scrollWidth: element.scrollWidth,
          children: [...element.querySelectorAll('*')].filter(child => child.getBoundingClientRect().right > right + 1).slice(-6)
            .map(child => ({ text: child.textContent.slice(0, 100), width: child.getBoundingClientRect().width,
              minWidth: getComputedStyle(child).minWidth, whiteSpace: getComputedStyle(child).whiteSpace, overflowWrap: getComputedStyle(child).overflowWrap })) };
      });
      if (issue) {
        layoutIssues.push({ description, ...issue });
        await capture(`layout-failure-${layoutIssues.length}`);
        console.warn(`Layout issue recorded: ${description}`);
      }
    }
    async function mutationsUnavailable(description, focusAvailable = false) {
      const before = fixture.commands().length;
      if (await titleInput().count()) assert.equal(await titleInput().isEditable(), false);
      for (const control of [page.getByTestId('save-session-title'), thinking('High'), thinking('Off')]) {
        if (await control.count()) {
          assert.equal(await control.isEnabled(), false, `${description}: mutation is disabled`);
          await control.dispatchEvent('click');
        }
      }
      const focus = label('Show session in Tern');
      if (await focus.count()) {
        assert.equal(await focus.isEnabled(), focusAvailable, `${description}: pane focus follows its separate guard`);
        if (!focusAvailable) await focus.dispatchEvent('click');
      }
      assert.equal(fixture.commands().length, before, `${description}: no command dispatched`);
      if (focusAvailable) {
        await focus.click();
        await until(() => fixture.commands().length === before + 1, `${description}: host fallback focus command`);
        assert.equal(fixture.commands().at(-1).body.type, 'focus-session');
        await until(async () => await focus.count() && await focus.isEnabled(), `${description}: focus receipt reconciled`);
      }
    }

    await page.goto(appOrigin);
    await page.getByTestId('new-chat-welcome').waitFor();
    assert.equal(await page.getByTestId('chat-header').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(251, 251, 250)');
    const dock = await page.getByTestId('chat-composer-dock').boundingBox();
    assert.ok(dock && dock.y + dock.height <= 844 && dock.y > 550, 'composer sits at the bottom of the actual mobile viewport');
    await noHorizontalOverflow(page.locator('body'), 'light shell fits 412 px');
    await capture('new-chat-light'); check('light shell renders a bottom composer at 412 × 844');

    await settings();
    await page.getByTestId('open-connect').click();
    const pairing = 'perch://pair#' + Buffer.from(JSON.stringify({ version: 1, url: fixture.origin, token: fixture.token })).toString('base64url');
    await page.getByLabel('Workspace pairing code', { exact: true }).fill(pairing);
    await page.getByTestId('join-workspace').click();
    await page.getByTestId('remote-session-browser').waitFor();
    assert.equal(fixture.commands().length, 0);
    await label(`Attach to ${fixture.initialTitle}`).click();
    await label('Host session controls').waitFor();
    await openControls();
    assert.equal(await titleInput().inputValue(), fixture.initialTitle);
    assert.deepEqual(await controls().getByRole('radio').evaluateAll(elements => elements.map(element => element.getAttribute('aria-label'))),
      ['Thinking level Off', 'Thinking level Medium', 'Thinking level High']);
    assert.equal(await thinking('Medium').getAttribute('aria-checked'), 'true');
    assert.deepEqual(await controls().getByRole('progressbar', { name: 'Context window used' }).evaluate(element =>
      ['aria-valuemin', 'aria-valuemax', 'aria-valuenow', 'aria-valuetext'].map(name => element.getAttribute(name))),
    ['0', '100', '32', '32 percent used']);
    assert.ok((await controls().innerText()).includes('64,000 / 200,000 tokens'));
    assert.ok((await controls().innerText()).includes('Current branch'));
    await noHorizontalOverflow(controls(), 'long title and model fit the sheet');
    await capture('session-controls-light'); check('real remote attachment projects only advertised thinking levels, context and branch usage');

    await thinking('High').click();
    await until(() => fixture.commands().length === 1, 'thinking command');
    assert.equal(fixture.commands()[0].body.type, 'set-thinking'); assert.equal(fixture.commands()[0].body.level, 'high');
    await until(async () => await thinking('Medium').count() && await thinking('Medium').getAttribute('aria-checked') === 'true', 'old host level stays selected after dispatch');
    fixture.confirmLast();
    await until(async () => await thinking('High').count() && await thinking('High').getAttribute('aria-checked') === 'true', 'confirmed host thinking level');
    check('thinking command is scoped to the current provider/model and selection waits for host data');

    await titleInput().fill('  A title confirmed by the host  ');
    await page.getByTestId('save-session-title').click();
    await until(() => fixture.commands().length === 2, 'rename command');
    assert.equal(fixture.commands()[1].body.title, 'A title confirmed by the host');
    assert.equal(fixture.snapshot.session.title, fixture.initialTitle);
    assert.ok((await controls().innerText()).includes(fixture.initialTitle));
    fixture.confirmLast();
    await until(async () => await titleInput().count() && await titleInput().inputValue() === 'A title confirmed by the host', 'confirmed title');
    check('explicit Save sends a trimmed scoped title; dispatch alone does not claim a saved title');

    await label('Show session in Tern').click();
    await until(() => fixture.commands().length === 3, 'focus command');
    assert.equal(fixture.commands()[2].body.type, 'focus-session');
    assert.equal(await page.getByTestId('session-tool-catalog').getAttribute('aria-expanded'), 'false');
    await page.getByTestId('session-tool-catalog').click();
    assert.equal(await page.getByTestId('session-tool-catalog').getAttribute('aria-expanded'), 'true');
    assert.ok((await controls().innerText()).includes('inspect_a_deliberately_long_tool_name_to_check_mobile_wrapping'));
    assert.ok((await controls().innerText()).includes('Inactive'));
    await noHorizontalOverflow(controls(), 'expanded long tool labels fit the sheet');
    await controls().getByText('Tool selection is managed on the host.', { exact: true }).scrollIntoViewIfNeeded();
    await capture('host-tools-light'); check('advertised Tern focus dispatches once; read-only tool details expand');

    fixture.patch(value => { value.readOnly = true; });
    await until(async () => (await controls().innerText()).includes('This session is view only.'), 'view-only state');
    await mutationsUnavailable('view only');
    fixture.patch(value => { value.readOnly = false; value.session.status = 'working'; });
    await until(async () => (await controls().innerText()).includes('when the assistant is idle'), 'working state');
    await mutationsUnavailable('working', true);
    fixture.patch(value => { value.session.status = 'needs-input'; value.pendingQuestion = { id: 'controls-question', revision: 'question-one', kind: 'choice', category: 'approval', actionable: true,
      title: 'Synthetic approval', prompt: 'Continue this synthetic operation?', options: [{ id: 'allow', label: 'Allow' }, { id: 'deny', label: 'Deny' }] }; });
    await until(async () => (await controls().innerText()).includes('Answer the current request'), 'pending question');
    await mutationsUnavailable('question pending', true);
    fixture.patch(value => { value.pendingQuestion = null; value.session.status = 'idle'; });
    await until(async () => await titleInput().count() && await titleInput().isEditable(), 'idle again');
    check('view-only blocks commands; working and pending questions block settings while preserving advertised Tern focus');

    await closeSheet(); await sidebar();
    const releaseSnapshot = fixture.holdNextSnapshot('controls_alternate');
    try {
      await label(`Open ${fixture.alternateTitle}`).click();
      await until(() => fixture.isSnapshotHeld(), 'delayed session attachment');
      await openControls();
      await mutationsUnavailable('session opening');
      assert.ok((await controls().innerText()).includes('A title confirmed by the host'), 'current conversation remains visible until its replacement is ready');
      assert.ok(await controls().getByRole('progressbar').count(), 'host metadata remains readable while opening');
    } finally { releaseSnapshot(); }
    await until(async () => await titleInput().count() && await titleInput().inputValue() === fixture.alternateTitle, 'alternate conversation attached');
    await closeSheet(); await sidebar();
    await label(`Open ${fixture.snapshot.session.title}`).click();
    await openControls();
    await until(async () => await titleInput().count() && await titleInput().inputValue() === fixture.snapshot.session.title, 'original conversation attached');
    assert.equal(fixture.commands().length, 5); check('a held session attachment keeps current content visible and blocks mutation until the new session is ready');

    fixture.setOffline(true);
    await until(async () => (await controls().innerText()).includes('Reconnect to change'), 'offline state');
    await mutationsUnavailable('offline');
    fixture.setOffline(false);
    await closeSheet(); await label('Retry').click();
    await until(async () => !await label('Retry').count(), 'explicit reconnect');
    await openControls();
    await until(async () => await titleInput().count() && await titleInput().isEditable(), 'reconnected controls');
    check('connection loss disables controls and reconnection restores them without replay');

    fixture.patch(value => { value.capabilities.thinkingSelection = false; value.capabilities.sessionRename = false; value.capabilities.focusSession = false; });
    await until(async () => !await titleInput().count() && !await thinking('High').count() && !await label('Show session in Tern').count(), 'capabilities removed');
    assert.ok(await controls().getByRole('progressbar').count()); assert.ok(await page.getByTestId('session-tool-catalog').count());
    assert.equal(fixture.commands().length, 5); check('removing capabilities hides actions while read-only metadata remains available');
    fixture.patch(value => { value.capabilities.thinkingSelection = true; value.capabilities.sessionRename = true; value.capabilities.focusSession = true; });
    await until(async () => await titleInput().count(), 'capabilities restored');
    await titleInput().fill('This unsaved title belongs to the old generation');
    fixture.replaceGeneration();
    await until(async () => !await titleInput().count(), 'old generation detached');
    await closeSheet();
    await label('Attach to Replacement host conversation').click();
    await openControls();
    assert.equal(await titleInput().inputValue(), 'Replacement host conversation');
    assert.equal(fixture.commands().length, 5); check('a replacement generation requires attachment and cannot inherit the old title draft');

    await closeSheet(); await settings();
    await page.getByText('Dark appearance', { exact: true }).click();
    await until(async () => await page.getByTestId('chat-header').evaluate(element => getComputedStyle(element).backgroundColor) === 'rgb(15, 15, 18)', 'dark scheme selected');
    await label('Back to chat').click();
    await capture('chat-dark');
    await openControls(); await noHorizontalOverflow(controls(), 'dark controls fit 412 px');
    assert.equal(await controls().getByRole('progressbar').getAttribute('aria-valuenow'), '32');
    await capture('session-controls-dark');
    await page.getByTestId('session-tool-catalog').click(); await noHorizontalOverflow(controls(), 'dark expanded tools fit 412 px');
    await controls().getByText('Tool selection is managed on the host.', { exact: true }).scrollIntoViewIfNeeded();
    await capture('host-tools-dark');
    check('the real appearance switch updates the native shell and registry-backed chat in dark mode');
    assert.deepEqual(errors, []); assert.deepEqual(blocked, []); assert.equal(fixture.commands().length, 5);
    assert.deepEqual(layoutIssues, [], 'mobile shell and expanded controls have no horizontal overflow in either scheme');
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ result: 'PASS', viewport: { width: 412, height: 844 }, checks, errors, blocked, warnings,
      preview: { sha256: createHash('sha256').update(source).digest('hex'), metadata: await page.evaluate(() => globalThis.__PERCH_PREVIEW__) },
      commands: fixture.commands().map(call => ({ type: call.body.type, generation: call.body.generation })),
      scope: 'Actual exported Expo web UI in Chromium with synthetic remote wire data. No physical Android, real host, model, or subscription.' }, null, 2) + '\n');
    console.log(`PASS: ${checks.length} checks; screenshots and result.json in ${output}`);
  } catch (error) {
    if (page && !page.isClosed()) {
      await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
      fs.writeFileSync(path.join(output, 'failure-dom.txt'), await page.locator('body').innerText().catch(() => ''));
    }
    fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: String(error.stack || error), checks, errors, blocked, warnings, layoutIssues }, null, 2) + '\n');
    console.error(error); process.exitCode = 1;
  } finally {
    await browser?.close();
    await new Promise(resolve => server ? server.close(resolve) : resolve());
  }
})();
