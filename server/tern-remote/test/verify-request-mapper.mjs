/** Run the unchanged pure request mapper in the user's installed Tern Luau VM. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRemoteQuestion } from '../../../src/harness/remote.ts';

const tern = process.env.TERN_BIN;
if (!tern) throw new Error('Set TERN_BIN to the installed Tern executable.');
const here = dirname(fileURLToPath(import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'perch-request-mapper-'));
const crate = join(directory, 'crates/tern');
const plugin = join(directory, 'crates/plugins/fixtures/perch-mapper-test');
let child, logs = '';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function run(args) {
  const proc = spawn(tern, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', error = '';
  proc.stdout.on('data', bytes => { output += bytes; }); proc.stderr.on('data', bytes => { error += bytes; });
  const timeout = setTimeout(() => proc.kill('SIGKILL'), 15_000);
  try {
    const code = await new Promise((resolve, reject) => { proc.once('error', reject); proc.once('exit', resolve); });
    if (code !== 0) throw new Error(error || output || 'Tern command failed.');
    return output;
  } finally { clearTimeout(timeout); }
}

try {
  await mkdir(join(crate, 'goldens'), { recursive: true });
  await mkdir(plugin, { recursive: true });
  await copyFile(join(here, '../plugin/requests.luau'), join(plugin, 'requests.luau'));
  await copyFile(join(here, 'fixtures/omp-owner-requests.json'), join(plugin, 'fixtures.json'));
  await writeFile(join(plugin, 'plugin.toml'), 'schema = 1\nid = "perch-mapper-test"\nname = "Perch mapper tests"\nversion = "0.1.0"\nwindow = "window.luau"\n');
  await writeFile(join(plugin, 'window.luau'), String.raw`
local Requests = require("./requests")
local data = tern.json.decode(tern.fs.read("fixtures.json", 512_000)).fixtures
local checks = tern.json.array()
local examples = tern.json.array()
local count = 0
local failed = nil
local function copy(value) return tern.json.decode(tern.json.encode(value)) end
local function find(node, accept)
  if type(node) ~= "table" then return nil end
  if accept(node) then return node end
  for _, child in ipairs(node.c or {}) do local found = find(child, accept); if found then return found end end
end
local function role(node, value) return find(node, function(n) return n.p and n.p.role == value end) end
local source = nil
local omitted = false
local fake = { session = {} }
function fake.session:surface(_pane, opts)
  local root = find(source, function(n) return n.id == opts.root end)
  return { surface = { id = "s:1", role = "omp.session", mode = "inline" }, main = root, more = omitted and 1 or nil }
end
local function check(name, fn)
  count += 1
  tern.command({ id = "case-" .. tostring(count), title = name, run = function(_cx)
    local ok, err = pcall(fn)
    if ok then table.insert(checks, name) else failed = tostring(err) end
    tern.fs.write("mapper-results.json", tern.json.encode({ success = failed == nil, error = failed, checks = checks, examples = examples }))
  end })
end
local function fails(fn)
  local success = pcall(fn)
  assert(not success, "Expected this answer to be rejected")
end
tern.on("window_start", function(_cx)
  local success, failure = pcall(function()
    check("Exact stock approval picker becomes a complete request and emits the Deny item", function()
      source = copy(data.approvalPicker)
      local tracker = Requests.new()
      local q = tracker:read(fake, 2, "generation-1")
      assert(q and q.category == "approval" and q.actionable and q.options[1].label == "Approve")
      assert(q.prompt:find("inert fixture", 1, true))
      table.insert(examples, q)
      local event = tracker:prepare(fake, 2, "generation-1", { requestId = q.id, requestRevision = q.revision, answer = "2" })
      local picker = find(source, function(n) return n.k == "picker" end)
      assert(event.ev == "activate" and event.sf == "s:1" and event.id == picker.id and event.item == "1")
      local consumed = tracker:read(fake, 2, "generation-1")
      assert(consumed.id == q.id and not consumed.actionable)
      picker.p.subtitle ..= " Changed after dispatch."
      local changed = tracker:read(fake, 2, "generation-1")
      assert(changed.id == q.id and changed.revision ~= q.revision and not changed.actionable)
      fails(function() tracker:prepare(fake, 2, "generation-1", { requestId = changed.id, requestRevision = changed.revision, answer = "1" }) end)
    end)
    check("An identical replacement component receives a new request identity", function()
      source = copy(data.approvalPicker)
      local tracker = Requests.new()
      local first = tracker:read(fake, 2, "1")
      find(source, function(n) return n.k == "picker" end).id = "new.^picker"
      local next = tracker:read(fake, 2, "1")
      assert(next.id ~= first.id)
      fails(function() tracker:prepare(fake, 2, "1", { requestId = first.id, requestRevision = first.revision, answer = "1" }) end)
    end)
    check("Plan document and disabled choices retain owner state; revised plans reject old answers", function()
      source = copy(data.planReview)
      local tracker = Requests.new()
      local q = tracker:read(fake, 2, "1")
      assert(q and q.category == "plan" and q.actionable and q.document.content:find("Keep the same host process", 1, true))
      local options = role(source, "omp.plan.options")
      assert(#q.options == #options.c)
      table.insert(examples, q)
      local body = role(source, "omp.plan.body")
      find(body, function(n) return n.k == "md" end).p.text ..= "\nChanged by the owner."
      local changed = tracker:read(fake, 2, "1")
      assert(changed.id == q.id and changed.revision ~= q.revision)
      fails(function() tracker:prepare(fake, 2, "1", { requestId = q.id, requestRevision = q.revision, answer = "1" }) end)
      options.c[1].p.disabled = true
      changed = tracker:read(fake, 2, "1")
      assert(changed.options[1].disabled)
      fails(function() tracker:prepare(fake, 2, "1", { requestId = changed.id, requestRevision = changed.revision, answer = "1" }) end)
      local chosen
      for i, option in ipairs(changed.options) do if option.label == "Refine plan" then chosen = tostring(i) end end
      assert(chosen)
      local event = tracker:prepare(fake, 2, "1", { requestId = changed.id, requestRevision = changed.revision, answer = chosen })
      assert(event.id == options.id and event.item == options.c[tonumber(chosen)].id)
    end)
    check("Oversized and omitted plan content cannot authorize a response", function()
      source = copy(data.planReview)
      local tracker = Requests.new()
      find(role(source, "omp.plan.body"), function(n) return n.k == "md" end).p.text = string.rep("x", 65_000)
      local q = tracker:read(fake, 2, "1")
      assert(q and not q.actionable and #q.document.content <= 60_000)
      table.insert(examples, q)
      source = copy(data.planReview)
      omitted = true
      q = tracker:read(fake, 2, "1")
      assert(q and not q.actionable)
      omitted = false
    end)
    check("Unrelated modal, filtered selection, and checkbox requests stay on the host", function()
      source = copy(data.planReview)
      local layer = find(source, function(n) return n.id == "layer" end)
      table.insert(layer.c, { id = "cover", k = "overlay", p = { modal = true } })
      assert(not Requests.new():read(fake, 2, "1").actionable)
      source = copy(data.approvalPicker)
      local picker = find(source, function(n) return n.k == "picker" end)
      picker.p.current = tern.json.array({ "0" })
      assert(not Requests.new():read(fake, 2, "1").actionable)
      picker.p.current = nil; picker.p.query = "Approve"; picker.p.order = tern.json.array({ "0" })
      assert(not Requests.new():read(fake, 2, "1").actionable)
    end)
    check("Both stock extension editors remain visible but cannot be answered atomically", function()
      for _, name in ipairs({ "input", "editor" }) do
        source = copy(data[name])
        local q = Requests.new():read(fake, 2, "1")
        assert(q and not q.actionable and q.notice:find("atomic", 1, true))
        table.insert(examples, q)
      end
    end)
    check("Fallback selectors with a strategy slider are read-only", function()
      source = copy(data.approvalFallback)
      local q = Requests.new():read(fake, 2, "1")
      assert(q and not q.actionable and q.options[1].disabled)
      table.insert(examples, q)
    end)
    check("Long approval titles remain complete in the body rather than silently clipped", function()
      source = copy(data.approvalPicker)
      local picker = find(source, function(n) return n.k == "picker" end)
      picker.p.title = "Allow tool: " .. string.rep("detail ", 300) .. "final approval argument"
      local q = Requests.new():read(fake, 2, "1")
      assert(q and q.actionable and q.title == "Host request" and q.prompt:find(picker.p.title, 1, true))
      table.insert(examples, q)
    end)
    check("The selected execution model detail is complete and changes the plan revision", function()
      source = copy(data.planReview)
      local root = role(source, "omp.overlay.planReview")
      local detail = { id = "12.sliderDetail", k = "text", p = { spans = { { t = "Resolved model: provider/model-one" } } } }
      table.insert(root.c, { id = "12.tabs", k = "tabs", p = { role = "omp.plan.strategy", active = "t1",
        items = { { id = "t1", label = "Balanced" } } } })
      table.insert(root.c, detail)
      local tracker = Requests.new()
      local q = tracker:read(fake, 2, "1")
      assert(q and q.actionable and q.prompt:find("Execution strategy: Balanced", 1, true)
        and q.prompt:find("provider/model-one", 1, true))
      detail.p.spans[1].t = "Resolved model: provider/model-two"
      local changed = tracker:read(fake, 2, "1")
      assert(changed.id == q.id and changed.revision ~= q.revision and changed.prompt:find("provider/model-two", 1, true))
      fails(function() tracker:prepare(fake, 2, "1", { requestId = q.id, requestRevision = q.revision, answer = "1" }) end)
      table.insert(examples, changed)
    end)
    check("A mounted annotation chooser blocks plan answers and invalidates the visible revision", function()
      source = copy(data.planReview)
      local tracker = Requests.new()
      local q = tracker:read(fake, 2, "1")
      assert(q and q.actionable)
      local root = role(source, "omp.overlay.planReview")
      table.insert(root.c, { id = "12.chooserHead", k = "text", p = { text = "Edit annotation" } })
      table.insert(root.c, { id = "12.chooser", k = "list", c = { { id = "12.chooser/c0", k = "item", p = { label = "Existing note" } } } })
      local changed = tracker:read(fake, 2, "1")
      assert(changed.id == q.id and changed.revision ~= q.revision and not changed.actionable)
      fails(function() tracker:prepare(fake, 2, "1", { requestId = q.id, requestRevision = q.revision, answer = "1" }) end)
      fails(function() tracker:prepare(fake, 2, "1", { requestId = changed.id, requestRevision = changed.revision, answer = "1" }) end)
      table.insert(examples, changed)
    end)
  end)
  tern.fs.write("mapper-results.json", tern.json.encode({ success = success, error = success and nil or tostring(failure), checks = checks, examples = examples }))
end)
`);
  child = spawn(tern, ['serve', '--control', '0', '--out', join(directory, 'shots')], {
    cwd: directory, env: { ...process.env, STENCIL_FIXTURE_ROOT: crate, TERN_CONFIG_DIR: join(directory, 'config'),
      LP_NUM_THREADS: process.env.LP_NUM_THREADS || '1',
      STENCIL_LOG_DIR: join(directory, 'logs'), STENCIL_LOG: 'warn,tern::plugin=debug' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let port;
  child.stdout.on('data', bytes => {
    logs += bytes;
    for (const line of String(bytes).split('\n')) {
      try { const value = JSON.parse(line); if (value.control?.port) port = value.control.port; } catch {}
    }
  });
  child.stderr.on('data', bytes => { logs += bytes; });
  const deadline = Date.now() + 15_000;
  while (!port && Date.now() < deadline && child.exitCode === null) await pause(25);
  assert.ok(port, logs);
  assert.equal(JSON.parse(await run(['ctl', '--control', String(port), 'plugins', 'fixtures'])).ok, true);
  for (let i = 1; i <= 10; i++) assert.equal(JSON.parse(await run(['ctl', '--control', String(port), 'plugins', 'run', `plugin.perch-mapper-test.case-${i}`])).ok, true);
  const result = JSON.parse(await readFile(join(plugin, 'mapper-results.json'), 'utf8').catch(error => { throw new Error(`${error.message}\n${logs}`); }));
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.checks.length, 10, `${JSON.stringify(result)}\n${logs}`);
  for (const question of result.examples) parseRemoteQuestion(question);
  console.log(JSON.stringify({ verified: true, version: (await run(['--version'])).trim(), checks: result.checks,
    validProtocolExamples: result.examples.length,
    limitations: ['Pure mapper in the real Luau VM, using captured stock OMP trees; separate tests cover live Tern reads/event delivery.'] }, null, 2));
} finally {
  if (child?.exitCode === null) {
    child.kill('SIGTERM'); await Promise.race([new Promise(resolve => child.once('exit', resolve)), pause(1000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  await rm(directory, { recursive: true, force: true });
}
