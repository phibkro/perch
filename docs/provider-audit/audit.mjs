#!/usr/bin/env node
/** Reproduce the provider audit from pinned public sources. No credentials or inference calls. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const repository = resolve(directory, '../..');
const sources = JSON.parse(await readFile(join(directory, 'sources.json'), 'utf8'));
const args = process.argv.slice(2);
const refresh = args.includes('--refresh');
const sourceIndex = args.indexOf('--upstream-root');
const upstreamRoot = sourceIndex < 0 ? undefined : args[sourceIndex + 1];
if (sourceIndex >= 0 && !upstreamRoot) throw new Error('--upstream-root requires a path.');
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--upstream-root') { i++; continue; }
  if (!['--verify', '--refresh'].includes(args[i])) throw new Error(`Unknown option: ${args[i]}`);
}

// Display grouping only. Never rewrite a model command or move a credential between these IDs.
const displayMappings = [
  { pi: 'kimi-coding', omp: 'kimi-code', label: 'Kimi Code' },
  { pi: 'moonshotai', omp: 'moonshot', label: 'Moonshot AI, global' },
  { pi: 'opencode', omp: 'opencode-zen', label: 'OpenCode Zen' },
  { pi: 'qwen-token-plan', omp: 'alibaba-token-plan', label: 'QwenCloud Token Plan, global' },
  { pi: 'zai-coding-cn', omp: 'zhipu-coding-plan', label: 'Zhipu / Z.AI coding plan, China' },
];

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const sorted = values => [...values].sort();
const count = values => Object.fromEntries(sorted(new Set(values)).map(value => [value, values.filter(v => v === value).length]));
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const normalizeModel = (model, kind) => ({ id: model.id, kind, api: model.api });

function summary(providers) {
  const models = providers.flatMap(provider => provider.models);
  return {
    catalogProviderIds: providers.length,
    chatProviderIds: providers.filter(provider => provider.models.some(model => model.kind === 'chat')).length,
    chatProviderIdsWithDefinition: providers.filter(provider => provider.hasProviderDefinition && provider.models.some(model => model.kind === 'chat')).length,
    modelEntries: models.length,
    chatModelEntries: models.filter(model => model.kind === 'chat').length,
    chatModelEntriesWithDefinition: providers.filter(provider => provider.hasProviderDefinition)
      .flatMap(provider => provider.models).filter(model => model.kind === 'chat').length,
    entriesByKind: count(models.map(model => model.kind)),
    chatApis: sorted(new Set(models.filter(model => model.kind === 'chat').map(model => model.api))),
  };
}

function validateSnapshot(snapshot) {
  assert.equal(new Set(snapshot.providers.map(p => p.id)).size, snapshot.providers.length, 'Provider IDs must be unique.');
  for (const provider of snapshot.providers) {
    const keys = provider.models.map(model => `${model.kind}:${model.id}`);
    assert.equal(new Set(keys).size, keys.length, `Duplicate model in ${provider.id}`);
    for (const model of provider.models) {
      assert.equal(typeof model.id, 'string');
      assert.equal(typeof model.api, 'string');
      assert.equal(typeof model.kind, 'string');
    }
  }
  assert.deepEqual(snapshot.summary, summary(snapshot.providers));
}

async function piSnapshot() {
  const root = join(repository, sources.pi.installedPath);
  for (const input of sources.pi.files) {
    const bytes = await readFile(join(root, input.path));
    assert.equal(hash(bytes), input.sha256, `Pi source changed: ${input.path}`);
  }
  const pkg = await readJson(join(root, 'package.json'));
  assert.equal(pkg.version, sources.pi.version);
  const manifest = await readJson(join(root, 'dist/providers/data/.manifest.json'));
  const { builtinProviders } = await import(pathToFileURL(join(root, 'dist/providers/all.js')).href);
  // Constructing the definitions and reading the static models does not resolve auth or refresh catalogs.
  const definitions = builtinProviders();
  const providers = [];
  for (const provider of definitions) {
    const data = await readJson(join(root, `dist/providers/data/${provider.id}.json`));
    const all = Object.values(data).flatMap(rows => Object.values(rows));
    const models = all.map(model => normalizeModel(model, model.type ?? 'chat'))
      .sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`, 'en'));
    assert.equal(provider.getModels().length, models.filter(model => model.kind === 'chat').length);
    providers.push({
      id: provider.id,
      name: provider.name,
      hasProviderDefinition: true,
      baseUrls: sorted(new Set(all.map(model => model.baseUrl))),
      authentication: Object.entries(provider.auth ?? {}).map(([type, method]) => ({
        type,
        label: method.name,
        subscriptionLabelInSource: method.isSubscription === true,
      })),
      models,
    });
  }
  providers.sort((a, b) => a.id.localeCompare(b.id, 'en'));
  return {
    schemaVersion: 1,
    harness: 'pi',
    version: pkg.version,
    revision: sources.pi.revision,
    catalogGeneratedAt: manifest.generatedAt,
    accountRequestsMade: 0,
    summary: summary(providers),
    providers,
  };
}

async function readOmpInput(snapshot, input) {
  let bytes;
  if (upstreamRoot) bytes = await readFile(join(upstreamRoot, `omp-${snapshot.snapshot}`, input.path));
  else {
    const response = await fetch(input.url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`Fetch failed (${response.status}): ${input.url}`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  assert.equal(hash(bytes), input.sha256, `OMP source changed: ${snapshot.snapshot}/${input.path}`);
  return bytes;
}

async function ompSnapshot(source) {
  const files = await Promise.all(source.files.map(async input => [input.path, await readOmpInput(source, input)]));
  const data = Object.fromEntries(files);
  const pkg = JSON.parse(data['packages/ai/package.json'].toString());
  assert.equal(pkg.version, source.version);
  const catalog = JSON.parse(data['packages/catalog/src/models.json'].toString());
  const rules = JSON.parse(data['packages/catalog/src/compat/rules.json'].toString());
  const auth = new Map(rules.auth.providers.map(provider => [provider.id, provider]));
  const providers = Object.entries(catalog).map(([id, rows]) => {
    const values = Object.values(rows);
    for (const [key, model] of Object.entries(rows)) assert.equal(key, model.id);
    const policy = auth.get(id);
    return {
      id,
      name: policy?.name ?? id,
      hasProviderDefinition: !!policy && Object.hasOwn(rules.providers, id),
      baseUrls: sorted(new Set(values.map(model => model.baseUrl))),
      authentication: policy ? {
        loginMethod: policy.login?.kind ?? null,
        loginHook: policy.login?.hook ?? null,
        credentialResult: policy.result ?? null,
        envVarsInCatalog: rules.providers[id]?.envVars ?? [],
        envPolicy: policy.env ?? null,
      } : null,
      models: values.map(model => normalizeModel(model, model.kind ?? 'chat'))
        .sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`, 'en')),
    };
  }).sort((a, b) => a.id.localeCompare(b.id, 'en'));
  const unbundled = Object.entries(rules.providers).filter(([id]) => !Object.hasOwn(catalog, id))
    .map(([id, descriptor]) => ({
      id,
      name: auth.get(id)?.name ?? id,
      defaultModel: descriptor.defaultModel ?? null,
      seedModelCount: descriptor.seed?.models?.length ?? 0,
      loginMethod: auth.get(id)?.login?.kind ?? null,
      envVarsInCatalog: descriptor.envVars ?? [],
    })).sort((a, b) => a.id.localeCompare(b.id, 'en'));
  return {
    schemaVersion: 1,
    harness: 'omp',
    version: pkg.version,
    revision: source.revision,
    accountRequestsMade: 0,
    summary: summary(providers),
    registrySummary: {
      catalogDescriptorIds: Object.keys(rules.providers).length,
      authenticationPolicyIds: rules.auth.providers.length,
      bundledChatProviderIdsWithDescriptor: providers.filter(provider =>
        provider.models.some(model => model.kind === 'chat') && Object.hasOwn(rules.providers, provider.id)).length,
      unbundledCatalogDescriptorIds: unbundled.length,
      bundledIdsWithoutCatalogDescriptor: sorted(Object.keys(catalog).filter(id => !Object.hasOwn(rules.providers, id))),
    },
    unbundledCatalogDescriptors: unbundled,
    otherAuthenticationPolicies: rules.auth.providers.filter(provider => !Object.hasOwn(rules.providers, provider.id))
      .map(provider => ({ id: provider.id, name: provider.name, loginMethod: provider.login?.kind ?? null, storesAs: provider.storeAs ?? null })),
    providers,
  };
}

function compare(pi, omp, definitionsOnly = false) {
  const ids = snapshot => new Set(snapshot.providers.filter(p => (!definitionsOnly || p.hasProviderDefinition)
    && p.models.some(m => m.kind === 'chat')).map(p => p.id));
  const p = ids(pi), o = ids(omp);
  const shared = sorted([...p].filter(id => o.has(id)));
  const piOnly = sorted([...p].filter(id => !o.has(id)));
  const ompOnly = sorted([...o].filter(id => !p.has(id)));
  const mapping = new Map(displayMappings.map(m => [m.pi, m.omp]));
  for (const entry of displayMappings) { assert(p.has(entry.pi)); assert(o.has(entry.omp)); }
  const normalizedPi = new Set([...p].map(id => mapping.get(id) ?? id));
  return {
    piVersion: pi.version,
    ompVersion: omp.version,
    exactIdCounts: { shared: shared.length, piOnly: piOnly.length, ompOnly: ompOnly.length, union: new Set([...p, ...o]).size },
    exactSharedIds: shared,
    exactPiOnlyIds: piOnly,
    exactOmpOnlyIds: ompOnly,
    displayMappings,
    displayGroupedCounts: {
      shared: [...normalizedPi].filter(id => o.has(id)).length,
      piOnly: [...normalizedPi].filter(id => !o.has(id)).length,
      ompOnly: [...o].filter(id => !normalizedPi.has(id)).length,
      union: new Set([...normalizedPi, ...o]).size,
    },
    displayGroupedPiOnly: sorted([...normalizedPi].filter(id => !o.has(id))),
    displayGroupedOmpOnly: sorted([...o].filter(id => !normalizedPi.has(id))),
  };
}

function providerTable(pi, omp) {
  const chatProviders = snapshot => snapshot.providers.filter(p => p.models.some(m => m.kind === 'chat'));
  const mappings = new Map(displayMappings.map(entry => [entry.pi, entry.omp]));
  const p = new Map(chatProviders(pi).map(provider => [mappings.get(provider.id) ?? provider.id, provider]));
  const o = new Map(chatProviders(omp).map(provider => [provider.id, provider]));
  const rows = [
    '| Pi provider ID | Pi chat entries | OMP provider ID | OMP chat entries |',
    '| --- | ---: | --- | ---: |',
  ];
  const models = provider => provider ? provider.models.filter(model => model.kind === 'chat').length : '—';
  const id = provider => provider ? `\`${provider.id}\`${provider.hasProviderDefinition ? '' : ' †'}` : '—';
  for (const key of sorted(new Set([...p.keys(), ...o.keys()]))) {
    rows.push(`| ${id(p.get(key))} | ${models(p.get(key))} | ${id(o.get(key))} | ${models(o.get(key))} |`);
  }
  return `${rows.join('\n')}\n\n† Catalog rows exist, but this snapshot has no corresponding provider descriptor/auth policy. Excluded from the definition-backed comparison.\n`;
}

const names = ['pi-1.0.4.json', ...sources.omp.map(source => `omp-${source.version}.json`)];
let snapshots;
if (refresh) {
  snapshots = await Promise.all([piSnapshot(), ...sources.omp.map(ompSnapshot)]);
  await mkdir(directory, { recursive: true });
  for (let index = 0; index < names.length; index++) {
    validateSnapshot(snapshots[index]);
    await writeFile(join(directory, names[index]), json(snapshots[index]));
  }
} else {
  snapshots = await Promise.all(names.map(name => readJson(join(directory, name))));
  for (const snapshot of snapshots) validateSnapshot(snapshot);
  try {
    await access(join(repository, sources.pi.installedPath));
  } catch {
    throw new Error('Install the locked Pi bridge dependencies before verifying: npm ci --prefix server/pi-bridge');
  }
  assert.deepEqual(await piSnapshot(), snapshots[0], 'Installed Pi catalog does not reproduce the saved snapshot.');
}
const [pi, pinned, current] = snapshots;
const comparison = {
  schemaVersion: 1,
  auditedOn: sources.auditedOn,
  countingUnit: 'A chat model entry is a provider/id route; it is not a distinct model weight or a tested account entitlement.',
  actualProviderAccountTests: 0,
  pinned: compare(pi, pinned),
  current: compare(pi, current),
  definitionBacked: {
    countingRule: 'Pi registered provider factory; OMP bundled chat rows with both a catalog descriptor and an authentication policy. Runtime-only descriptors are reported separately.',
    pinned: compare(pi, pinned, true),
    current: compare(pi, current, true),
  },
};
if (refresh) await writeFile(join(directory, 'comparison.json'), json(comparison));
else assert.deepEqual(await readJson(join(directory, 'comparison.json')), comparison);
const marker = '<!-- PROVIDER_TABLE -->';
const readme = await readFile(join(directory, 'README.md'), 'utf8');
assert(readme.includes(marker), 'README table marker is missing.');
const table = providerTable(pi, current);
if (refresh) await writeFile(join(directory, 'README.md'), `${readme.split(marker)[0]}${marker}\n\n${table}`);
else assert.equal(readme.split(marker)[1].trim(), table.trim(), 'README counts do not match the audited catalogs.');
for (const snapshot of snapshots) {
  console.log(`${snapshot.harness} ${snapshot.version}: ${snapshot.summary.chatProviderIds} chat catalog IDs; ${snapshot.summary.chatProviderIdsWithDefinition} with provider definitions; ${snapshot.summary.chatModelEntries} chat entries.`);
}
console.log(`Current overlap: ${comparison.current.exactIdCounts.shared} exact shared IDs; ${comparison.current.exactIdCounts.union} exact IDs in union.`);
console.log(`After five display-name mappings: ${comparison.current.displayGroupedCounts.union} namespaces. Commands retain each host's raw IDs.`);
console.log(`Definition-backed overlap: ${comparison.definitionBacked.current.displayGroupedCounts.shared} display groups shared; ${comparison.definitionBacked.current.displayGroupedCounts.union} in union.`);
console.log(refresh ? 'Saved deterministic provider audit snapshots.' : 'Provider audit verified without network or account requests.');
