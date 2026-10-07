# Reproducible Pi and OMP provider audit

The human findings are in [PROVIDERS.md](../PROVIDERS.md). This folder contains a source manifest, deterministic catalog snapshots, and their exact comparison.

| File | Purpose |
| --- | --- |
| `sources.json` | Pi package integrity and source hashes; exact OMP revisions, URLs, and hashes |
| `pi-1.0.4.json` | Installed Pi provider metadata, auth-method labels, and model identities |
| `omp-18.6.2.json` | Catalog at Perch's vendored Collab source revision |
| `omp-18.7.0.json` | Current-source catalog at the fixed audit revision |
| `comparison.json` | Exact-ID overlap and the five explicit display mappings |
| `audit.mjs` | Reproduce or verify all of the above without provider credentials |

## Counting rules

- A model entry is a **provider/ID route**, not a distinct underlying model. Provider names are not model manufacturers: gateways may list many of the same weights.
- Pi's `type` discriminant separates `chat`, `image`, and `classifier`. The script cross-checks each static chat count against that provider's `getModels()` result.
- OMP's `kind` discriminant defaults to `chat`, following its source `modelKind()` implementation. Role-specific entries are excluded from chat counts.
- The raw catalog comparison includes IDs with at least one bundled chat row. The **definition-backed** comparison additionally requires a registered Pi provider factory or an OMP catalog descriptor plus auth policy. The findings headline uses the latter. Empty catalogs, runtime discovery, extension providers, and optional login aliases are recorded separately.
- Five display mappings join clearly corresponding names. They never rewrite a command or imply shared credentials or identical model lists.
- No current provider account entitlement, throughput, quality, pricing, vision behavior, or tool compatibility was measured.

## Reproduce

Use the repository's locked bridge dependencies, then run the offline verification:

```sh
bun install --cwd server/pi-bridge --frozen-lockfile
node docs/provider-audit/audit.mjs --verify
```

`--verify` recomputes the saved counts and comparisons, checks the selected installed Pi package-file hashes, and reproduces its catalog. It does not fetch OMP upstream sources or contact a model provider.

To reproduce the OMP snapshots from their exact public upstream files as well:

```sh
node docs/provider-audit/audit.mjs --refresh
```

`--refresh` downloads the eight pinned OMP inputs listed in `sources.json`, verifies their SHA-256 hashes, reads the installed Pi definitions, and rewrites the three snapshots plus comparison deterministically. It makes no provider account or inference request. It does not install or execute OMP.

If the pinned source files have already been downloaded, use this layout and avoid network access entirely:

```sh
node docs/provider-audit/audit.mjs --refresh --upstream-root /path/to/source-cache
```

The cache must contain `omp-pinned/<source path>` and `omp-current/<source path>` for each manifest entry. A hash or version mismatch stops the audit; an update requires an explicit new source manifest.

## Observed verification

On 7 October 2026, both the public-source `--refresh` and offline `--verify` completed successfully. No provider account credentials were supplied. The snapshots preserve the OMP registry mismatch for `minimax-cn`: it has bundled chat rows but no matching descriptor/auth policy, so catalog membership alone is not treated as operational readiness.

## Provenance

Pi AI and OMP are MIT-licensed projects. This audit stores derived catalog facts and metadata, not their runtime implementations. Source code and complete license terms remain at [Pi](https://github.com/earendil-works/pi/tree/7c10bd4337495ee613f2224843ecdf349b80d1df) and [OMP](https://github.com/can1357/oh-my-pi/tree/d7c8dec22296740f71e879b62b564362617ee594). OMP's vendored client license is separately preserved by Perch in `src/vendor/omp/LICENSE`.

## Complete bundled chat catalog

The table below groups the two current source snapshots for comparison. A dash means no corresponding **bundled** chat catalog in this audit. Dynamic/custom providers can still supply that route. Counts were generated from the JSON snapshots.

<!-- PROVIDER_TABLE -->

| Pi provider ID | Pi chat entries | OMP provider ID | OMP chat entries |
| --- | ---: | --- | ---: |
| — | — | `abliteration` | 3 |
| — | — | `aiand` | 13 |
| — | — | `aimlapi` | 349 |
| — | — | `alibaba-coding-plan` | 12 |
| `qwen-token-plan` | 20 | `alibaba-token-plan` | 8 |
| `amazon-bedrock` | 185 | `amazon-bedrock` | 210 |
| `ant-ling` | 3 | — | — |
| `anthropic` | 16 | `anthropic` | 27 |
| `azure` | 45 | `azure` | 43 |
| `baseten` | 22 | `baseten` | 11 |
| — | — | `bedrock-mantle` | 5 |
| `cerebras` | 2 | `cerebras` | 8 |
| — | — | `cline-pass` | 17 |
| `cloudflare-ai-gateway` | 54 | `cloudflare-ai-gateway` | 101 |
| `cloudflare-workers-ai` | 18 | — | — |
| — | — | `commandcode` | 85 |
| — | — | `coreweave` | 41 |
| — | — | `cursor` | 123 |
| — | — | `deepinfra` | 97 |
| `deepseek` | 2 | `deepseek` | 4 |
| — | — | `devin` | 2 |
| — | — | `firepass` | 2 |
| `fireworks` | 22 | `fireworks` | 35 |
| `github-copilot` | 34 | `github-copilot` | 53 |
| — | — | `gitlab-duo` | 16 |
| — | — | `gitlab-duo-agent` | 1 |
| — | — | `gmi-cloud` | 1 |
| `google` | 22 | `google` | 43 |
| — | — | `google-antigravity` | 21 |
| — | — | `google-gemini-cli` | 7 |
| `google-vertex` | 14 | `google-vertex` | 34 |
| `groq` | 7 | `groq` | 20 |
| — | — | `helmcode` | 4 |
| `huggingface` | 76 | `huggingface` | 77 |
| — | — | `kilo` | 602 |
| `kimi-coding` | 4 | `kimi-code` | 7 |
| `meta` | 5 | `meta` | 6 |
| `minimax` | 3 | `minimax` | 8 |
| `minimax-cn` | 3 | `minimax-cn` † | 8 |
| — | — | `minimax-code` | 10 |
| — | — | `minimax-code-cn` | 10 |
| `mistral` | 32 | `mistral` | 34 |
| `moonshotai` | 4 | `moonshot` | 17 |
| `moonshotai-cn` | 4 | — | — |
| — | — | `muse-code` | 5 |
| — | — | `nanogpt` | 1139 |
| — | — | `novita` | 119 |
| `nvidia` | 21 | `nvidia` | 172 |
| — | — | `ollama-cloud` | 51 |
| `openai` | 44 | `openai` | 60 |
| `openai-codex` | 9 | `openai-codex` | 7 |
| `opencode-go` | 29 | `opencode-go` | 42 |
| `opencode` | 80 | `opencode-zen` | 109 |
| `openrouter` | 398 | `openrouter` | 562 |
| — | — | `qianfan` | 1 |
| — | — | `qwen-portal` | 2 |
| `qwen-token-plan-cn` | 20 | — | — |
| `qwen-token-plan-individual` | 9 | — | — |
| `radius` | 28 | — | — |
| — | — | `sakana` | 3 |
| — | — | `snowflake` | 15 |
| — | — | `stepfun` | 4 |
| — | — | `synthetic` | 12 |
| `together` | 17 | `together` | 39 |
| — | — | `umans` | 10 |
| — | — | `venice` | 167 |
| `vercel-ai-gateway` | 252 | `vercel-ai-gateway` | 333 |
| — | — | `wafer-serverless` | 21 |
| `xai` | 4 | `xai` | 32 |
| — | — | `xai-oauth` | 10 |
| `xiaomi` | 6 | `xiaomi` | 9 |
| `xiaomi-token-plan-ams` | 4 | `xiaomi-token-plan-ams` | 6 |
| `xiaomi-token-plan-cn` | 4 | `xiaomi-token-plan-cn` | 7 |
| `xiaomi-token-plan-sgp` | 4 | `xiaomi-token-plan-sgp` | 6 |
| — | — | `yolo-auto` | 3 |
| `zai` | 7 | `zai` | 18 |
| — | — | `zenmux` | 282 |
| `zai-coding-cn` | 4 | `zhipu-coding-plan` | 15 |

† Catalog rows exist, but this snapshot has no corresponding provider descriptor/auth policy. Excluded from the definition-backed comparison.
