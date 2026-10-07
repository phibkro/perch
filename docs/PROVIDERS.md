# Provider coverage for a modular Perch

Audited 7 October 2026. Counts describe the pinned source catalogs, not accounts that have been tested.

**Use each harness's provider registry.** Perch can offer a broad model chooser without shipping dozens of provider SDKs or storing their keys on the phone. The host advertises its available models; the app selects the exact `provider` and `modelId` pair and presents the resulting conversation and artifacts.

## How much coverage does that give us?

| Source inspected | Chat catalog IDs | IDs with provider definitions | Chat entries under those definitions |
| --- | ---: | ---: | ---: |
| Pi AI **1.0.4**, installed in the Pi bridge | 41 | **41** | **1,537** |
| OMP **18.6.2**, at Perch's vendored Collab revision | 72 | **71** | **5,417** |
| OMP **18.7.0**, current source snapshot | 72 | **71** | **5,428** |

The supported integration candidates are therefore **41 Pi routes and 71 OMP routes with explicit provider definitions and bundled chat models**. This is code and catalog coverage; no provider account has been tested. OMP has further discovery-backed routes outside this bundled-model count.

These definition-backed sets contain **83 literal provider IDs in their union**, with 29 exact matches. Five clear naming differences reduce the union to **78 display groups: 34 shared, seven present only in Pi's definition-backed set, and 37 present only in OMP's**. Regional endpoints and separately named subscription plans remain separate.

These numbers are computed by [the reproducible audit](provider-audit/README.md), from Pi's installed package and OMP's [pinned catalog](https://github.com/can1357/oh-my-pi/blob/3f7276200adf434fda1d97357ccc7fcd344066fe/packages/catalog/src/models.json) and [current catalog snapshot](https://github.com/can1357/oh-my-pi/blob/d7c8dec22296740f71e879b62b564362617ee594/packages/catalog/src/models.json). The [source manifest](provider-audit/sources.json) records exact revisions, package integrity, and input hashes.

A **model entry is one provider/model route**. Several providers can serve the same underlying model; historical aliases and regional variants can also appear. These totals do not measure distinct model weights, quality, current service availability, or subscription entitlement. Runtime discovery can add models, replace stale rows, or remove models an account cannot use. OMP explicitly distinguishes configured authentication from successful credential validation. [OMP provider availability](https://github.com/can1357/oh-my-pi/blob/d7c8dec22296740f71e879b62b564362617ee594/docs/providers.md#how-omp-decides-a-provider-is-available)

One concrete example of that distinction: OMP's full bundle has **5,425** chat entries at the pinned revision and **5,436** at the newer revision, but eight of them belong to `minimax-cn`, which has no matching descriptor or authentication policy. Those rows are excluded from the definition-backed figures above. Pi has its own valid `minimax-cn` definition, so the combined namespace count is unchanged. We could explicitly configure that route in OMP later; this audit does not count that unimplemented setup. Eleven other OMP descriptors supply discovery/local routes without bundled rows. [Registry details](provider-audit/omp-18.7.0.json)

## Four meanings of “supported”

| Layer | Pi through Perch | OMP through Perch |
| --- | --- | --- |
| **Harness provider support** | Pi owns API conversion, authentication, tools, and model compatibility | OMP owns the same concerns |
| **Phone transport** | Existing Pi RPC bridge carries normalized snapshots and commands | Existing encrypted Collab adapter carries the host conversation |
| **Model selection on the phone** | Implemented for models advertised by the bridge; idle sessions only | Current model is displayed; the existing Collab adapter has no catalog or model-switch command |
| **Authenticated provider testing** | No external provider account tested; the real Pi process was tested against a synthetic local model endpoint | No external provider account tested; Collab was tested against an independent encrypted protocol fixture |

Perch's transport already avoids a provider allowlist. The Pi bridge loads `get_available_models` and sends sanitized IDs and names to the phone. It validates a requested pair against that host list before calling `set_model`. The current bridge loads the list at startup; a host configuration change needs a refresh mechanism or bridge restart. See [the harness boundary](../src/harness/README.md), [the bridge](../server/pi-bridge/bridge.ts), and [Pi's RPC commands](https://pi.dev/docs/latest/rpc-commands#model).

The provider count does **not** enable every model feature in the phone interface. Vision input, reasoning controls, attachments, hosted tools, structured output, and media generation each need appropriate adapter and UI support. A compatible endpoint is a starting point for verification, not proof that its tool calls or streaming behavior match another server. [Pi custom providers](https://pi.dev/docs/latest/custom-provider)

## Which providers overlap?

Shared examples cover the major direct APIs and gateways: Anthropic, OpenAI, Google Gemini, Vertex AI, Amazon Bedrock, Azure, Mistral, DeepSeek, xAI, Meta, MiniMax, NVIDIA, Groq, Cerebras, Together, Fireworks, Hugging Face, OpenRouter, Vercel AI Gateway, Cloudflare AI Gateway, OpenCode Go, and the coding-plan routes below. The [complete per-provider table](provider-audit/README.md#complete-bundled-chat-catalog) includes exact IDs and both model counts.

### Same display group, different host IDs

| Display group | Pi ID | OMP ID |
| --- | --- | --- |
| OpenCode Zen | `opencode` | `opencode-zen` |
| Kimi Code | `kimi-coding` | `kimi-code` |
| Moonshot AI, global | `moonshotai` | `moonshot` |
| QwenCloud Token Plan, global | `qwen-token-plan` | `alibaba-token-plan` |
| Zhipu / Z.AI coding plan, China | `zai-coding-cn` | `zhipu-coding-plan` |

These are display mappings supported by the provider names and serving endpoints in the audited catalogs. They are **not command aliases**. The host's raw IDs, credential scope, and model list remain authoritative. For example, Pi's separate Qwen individual-plan catalog is not merged merely because it shares an endpoint with another plan.

### Pi routes without a matching OMP definition in this audit

| Provider ID | Chat entries | Meaning for Perch |
| --- | ---: | --- |
| `ant-ling` | 3 | Another direct model provider through Pi |
| `cloudflare-workers-ai` | 18 | Cloudflare inference as a selectable model provider |
| `minimax-cn` | 3 | Pi has a provider definition; OMP has catalog rows only at these revisions |
| `moonshotai-cn` | 4 | Separate China endpoint |
| `qwen-token-plan-cn` | 20 | Separate China token-plan endpoint |
| `qwen-token-plan-individual` | 9 | Separately scoped individual-plan catalog |
| `radius` | 28 | Pi's native gateway provider and refreshed catalog |

### Present only in OMP's definition-backed set after those mappings

These are source-supported candidates through OMP; they are not endorsements or tested account connections.

| Group | Exact provider IDs |
| --- | --- |
| Additional hosted APIs and gateways | `abliteration`, `aiand`, `aimlapi`, `coreweave`, `deepinfra`, `gmi-cloud`, `nanogpt`, `novita`, `qianfan`, `sakana`, `snowflake`, `stepfun`, `venice`, `wafer-serverless`, `zenmux` |
| Coding services and plan routes | `alibaba-coding-plan`, `cline-pass`, `commandcode`, `cursor`, `devin`, `firepass`, `gitlab-duo`, `gitlab-duo-agent`, `helmcode`, `kilo`, `minimax-code`, `minimax-code-cn`, `muse-code`, `synthetic`, `umans`, `yolo-auto` |
| Additional cloud and account routes | `bedrock-mantle`, `google-antigravity`, `google-gemini-cli`, `ollama-cloud`, `qwen-portal`, `xai-oauth` |

“Only” refers to these bundled catalog snapshots. It does not mean the other harness cannot add the service through configuration or an extension.

## Self-hosted models and additional providers

Both harnesses support custom providers. A compatible server is configured once on the host; Perch consumes its advertised models. A service with a different protocol can use a host provider extension while keeping the same mobile conversation boundary. [Pi configuration](https://pi.dev/docs/latest/models#configure-a-compatible-endpoint), [Pi provider extensions](https://pi.dev/docs/latest/custom-provider), [OMP provider configuration](https://github.com/can1357/oh-my-pi/blob/d7c8dec22296740f71e879b62b564362617ee594/docs/models.md)

| Server or requirement | Pi path | OMP path |
| --- | --- | --- |
| Ollama, LM Studio, vLLM, SGLang, compatible proxy | Host `models.json` with the correct API and model metadata | Host `models.yml`, supported discovery, or extension |
| Ollama, llama.cpp, LM Studio discovery | Configure or register a provider; dynamic refresh is supported | Built-in local discovery |
| Custom authentication or live catalogs | Provider extension with auth/discovery hooks | Provider extension and provider registry |
| Unsupported wire protocol | Host `stream` / `streamSimple` implementation | Host provider/API extension |

Pi's audited chat catalog uses **ten transport families**, including native Anthropic, Google, Vertex, Bedrock, Azure, Mistral, and OpenAI implementations. The host already carries the provider libraries. Perch should add a provider SDK only if a concrete requirement cannot pass through that harness boundary. [Pi custom provider API implementations](https://pi.dev/docs/latest/custom-provider#reuse-a-supported-streaming-api)

OMP has **11 additional catalog descriptors without bundled rows** at the audited revision: `apple`, `charm-hyper`, `factory-droid`, `litellm`, `lm-studio`, `ollama`, `siliconflow`, `siliconflow-cn`, `singularityapi-dev`, `singularityapi-tech`, and `vllm`. Its `llama.cpp` discovery and some login aliases also live outside that descriptor count. These are recorded separately in the JSON audit. Apple Foundation Models needs a supported Apple host; it does not make the Pixel run Apple's model. [OMP local engines](https://github.com/can1357/oh-my-pi/blob/d7c8dec22296740f71e879b62b564362617ee594/docs/providers.md#built-in-local-engines)

## Bring your own subscription

**Authentication and billing are separate dimensions.** An API key can authorize a subscription, and an OAuth flow can authorize a metered API. The product should show the specific plan or billing route reported by the host instead of calling every browser login a subscription.

| Route | Observed support | Product treatment |
| --- | --- | --- |
| OpenCode Go | Both catalogs contain `opencode-go`; existing Pi bridge setup is included | Keep the Go key on the host; identify the coding subscription clearly |
| OpenCode Zen | Pi `opencode`; OMP `opencode-zen` | Separate credit-billed choice; no automatic switch from Go |
| Harness account logins | Pi source exposes subscription-labeled OAuth for Anthropic, Copilot, Kimi Code, Meta, OpenAI, legacy Codex, and xAI; OMP has additional account flows | Technical source support only; use each service's supported authorization path and verify its current conditions |
| OpenRouter or Radius OAuth | Pi source does not label these as subscription auth | Browser authorization alone does not imply bundled usage |
| Self-hosted model | Host URL and optional host-managed key | Show the local/custom provider and the actual selected model |

OpenCode Go explicitly supports compatible coding agents and lists Pi among validated clients. Its client identity and session attribution matter. The existing Pi provider supplies those headers. See [OpenCode Go](https://opencode.ai/docs/go/) and the [included bridge setup](../server/pi-bridge/README.md#opencode-go-subscription).

A login implementation in open-source code is not a provider permission grant. In particular, Anthropic's current rules restrict using consumer OAuth credentials through third-party applications; its allowed hosting route for Claude Code has separate conditions. We should use API credentials or the expressly permitted integration path rather than advertise universal Claude subscription reuse. [Anthropic authentication restrictions](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use)

## Pi Durable: keep provider choice independent

Pi Durable can be built with Pi AI's provider registry. The **optional Cloudflare `agents/models/pi-ai` provider is a different path**: it sends model requests through Workers AI or AI Gateway. It supports its `cloudflare-ai` API plus Anthropic Messages and OpenAI Responses/Completions routes. Cloudflare explicitly excludes direct Google, Vertex, Bedrock, Azure Responses, Codex, and Mistral Conversations routes from this wrapper, and documents limits on reasoning-format conversion. [Cloudflare Pi AI provider](https://developers.cloudflare.com/agents/models/pi-ai/)

Therefore, make gateway routing optional. Keep direct Pi provider objects available where the Workers runtime and authentication method support them. Treat the 41-provider source catalog as the compatibility target; it is not proof that every SDK and credential flow runs unchanged in a Durable Object. Container-hosted Pi remains useful for providers or extensions that require a normal Linux process. [Cloudflare PiHarness](https://developers.cloudflare.com/agents/harnesses/pi/)

## Artifacts remain a separate concern

Pi's catalog also contains **60 image-generation entries and 23 classifier entries**. OMP's current snapshot contains **77 image, 31 video, 16 judge, 36 embedding, nine rerank, 12 speech-to-text, four text-to-speech, eight tiny-model, and 21 search entries**. They are deliberately excluded from the chat totals. The pure `typesafe` provider is classifier/judge-only in these snapshots; OMP's `local` and `web` namespaces contain role-specific runners. [Audit data](provider-audit/comparison.json), [OMP model kinds](https://github.com/can1357/oh-my-pi/blob/d7c8dec22296740f71e879b62b564362617ee594/packages/catalog/src/types.ts)

Those operations provide useful future tools for the integrated workspace, but model catalog membership does not create a media viewer or download API. Perch's current Markdown, code, and isolated HTML readers consume normalized artifact content independently of the provider. New media support should add explicit artifact types, storage references, retrieval authorization, and appropriate native viewers. [Artifact boundary](ARTIFACTS.md)

## Integration priorities

1. **Discover from the connected host.** Present only its available choices, with search and provider grouping. Use `provider + modelId` for selection, deduplication, and selected-state checks.
2. **Refresh deliberately.** Refresh catalog metadata after provider setup and when reconnecting to a changed host. Preserve the old selection until a host confirms a replacement.
3. **Keep credential setup on the host.** A later phone account flow can broker host authentication without exporting provider tokens to the mobile model picker.
4. **Verify useful combinations.** Exercise text streaming, cancellation, a real tool cycle, context/reasoning behavior, and artifact output for each provider/account combination we claim is tested.
5. **Preserve capability differences.** Provider switching, attachments, approvals, remote sessions, and media tools are separate capabilities. Enable each from evidence supplied by its adapter.

The audit itself performs no logins, inference requests, key validation, catalog refresh against provider accounts, or billable operations. It reads public source and the already installed package. Run `node docs/provider-audit/audit.mjs --verify` to recheck the saved counts against the installed Pi package.
