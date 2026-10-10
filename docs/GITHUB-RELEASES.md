# GitHub builds, prototype releases, and Obtainium

Perch's source and Android prototype releases live at **[github.com/phibkro/perch](https://github.com/phibkro/perch)**. The [Android prototype workflow](../.github/workflows/android.yml) builds a standalone ARM64 APK. A new app version pushed to the repository's default branch is published automatically as a **GitHub prerelease** after verification.

The workflow uses the repository and default-branch values supplied by GitHub. Forks or repository renames do not require editing an owner name in the workflow. Its push filter is `main`; update that filter if the default branch is renamed. Feature branches build through pull requests or a manual run, avoiding two builds for every PR commit. Changes limited to `docs/**`, `README.md`, or `.agents/**` skip push/PR builds; version tags and manual runs remain available.

## Install and follow updates with Obtainium

In Obtainium, choose **Add App** and use these settings:

| Setting | Value |
| --- | --- |
| App source URL | `https://github.com/phibkro/perch` |
| Source | GitHub, normally detected automatically |
| Include prereleases | Enabled; some versions label this **Allow prereleases** |
| Filter APKs by regular expression | `^perch-prototype-arm64\.apk$` |
| Verify Latest Tag | Disabled for this prototype prerelease channel |
| Version detection | Keep enabled |

Open the matching release in Obtainium, install its APK, and allow Android's install permission when requested. The package is `dev.perch.assistant`; the development client with package `dev.perch.assistant.dev` is a separate app. This channel always provides one matching APK, so the checksum and JSON files cannot be mistaken for installable assets.

Obtainium reads GitHub release data through the API and supports filename and release filters. Its **Verify Latest Tag** option follows GitHub's designated latest release; prototype releases here are explicitly prereleases and are not marked latest. Leave that option off and allow prereleases. A public repository normally requires no token; a token can help with API rate limits. Background installation depends on Android and Obtainium settings, so update discovery does not guarantee silent installation. See the official [source/filter guide](https://wiki.obtainium.imranr.dev/sources/) and [version and background update guide](https://wiki.obtainium.imranr.dev/app_tracking/).

## What each push does

| Event | Checks and ARM64 build | Actions artifacts | GitHub prerelease |
| --- | --- | --- | --- |
| Pull request | Yes | APK, checksums, metadata; diagnostic log | No |
| Push to another branch | Only through its pull request or a manual run | On those runs | No |
| Push to the default branch (`main` here) | Yes | Yes | Creates the current app version if it has no release |
| Push an existing `vX.Y.Z` version tag | Yes, with tag and ancestry checks | Yes | Creates it if it has no release |
| Manual workflow, publish input off | Yes | Yes | No |
| Manual workflow on a version tag, publish input on | Yes, with tag and ancestry checks | Yes | Creates it if it has no release |

The quick job runs app TypeScript, native keyboard-layout regression, session/protocol and artifact checks, workspace pairing and gateway integration, OpenCode protocol fixtures, durable driver fixtures, durable backend/provider/setup tests and its bundle build. It also checks release guards, runtime-readiness diagnostics, and deterministic third-party license notices. These checks use local fixtures and require no real model, backend, Cloudflare, or Expo credentials. The keyboard regression exercises the native component's layout contract; device painting and animation still need a phone or emulator.

The native job uses `bun run apk`, which dispatches the existing Node build script, preserves enabled lint, builds only `arm64-v8a`, embeds the application bundle, and checks the binary package/version. It then verifies the final signer, SDK levels, non-debuggable status, ABI, bundle contents, embedded notices, ZIP uniqueness, 16 KB ZIP alignment and every native ELF LOAD segment's alignment.

Successful builds upload an Actions artifact containing exactly:

- `perch-prototype-arm64.apk`
- `SHA256SUMS`, covering the APK and metadata
- `release-metadata.json`, including package/version, source SHA, run URL, signer fingerprint and verification results

Actions artifacts are retained for 14 days; diagnostic logs and available app lint reports for seven. Phone updates use the persistent [GitHub Releases](https://github.com/phibkro/perch/releases) assets. GitHub documents these as separate mechanisms: [workflow artifacts](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts) and [repository releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases).

## Prepare the next version

See [GitHub Releases](https://github.com/phibkro/perch/releases) for the latest published prototype. Each distributed update must increase both the app version and Android version code. The code must exceed every previously distributed code, including local builds. Never delete or reuse a released version/tag. Android uses `versionCode` for upgrade ordering; see [Android versioning](https://developer.android.com/studio/publish/versioning).

For example, after 0.9.0/code 10, prepare 0.9.1/code 11:

```sh
git fetch origin --tags
bun run release:version 0.9.1 --check
bun run release:version 0.9.1
bun run release:check
```

`--check` previews the proposed change without writing. The version helper defaults to the current code plus one; use `--code 11` when you need an explicit code. It updates all version locations together, validates them before writing, and preserves unrelated edits:

| File | Version values |
| --- | --- |
| `package.json` | `version` |
| `app.json` | `expo.version` and `expo.android.versionCode` |
| `android/app/build.gradle` | `versionName` and `versionCode` |
| `App.tsx` | Visible Perch version in the footer |

The four version files are separate from `bun.lock`. Bun's text lockfile records the dependency graph and does not carry the root app version, so a version-only bump leaves it unchanged. CI requires committed, nonempty root and backend lockfiles and uses frozen installs to detect dependency/manifest drift. When dependencies change, regenerate the relevant Bun lockfile and third-party notices before committing them.

Review the diff, run the app checks relevant to the change, commit the version and application changes, and push or merge them to `main`. A successful default-branch workflow creates the matching version tag at the exact built commit and publishes the APK as a prototype prerelease. No separate local GitHub release token or signing secret is needed.

Wait for that release before starting another release version. An ordinary later push that retains an already-published version still produces a CI artifact; it leaves the existing release unchanged. Bump the version when you want Obtainium to deliver new app bytes.

## Tag and manual recovery paths

You can create an annotated version tag yourself after its commit reaches `main`:

```sh
git tag -a v0.6.1 -m 'Perch 0.6.1 prototype'
git push origin v0.6.1
```

The tag must exactly match the app version and resolve to a commit on the fetched default branch. Versions and codes must exceed earlier version tags. The workflow accepts annotated or lightweight tags, and never moves an existing tag.

If publication stopped after creating a tag but before creating a release, rerun that workflow or use **Actions → Android prototype → Run workflow**, select the existing version tag and enable `publish_prerelease`. Selecting a branch with that manual publish input is rejected. A tag pointing to another commit cannot be replaced by a later same-version main push. Build and publish that original tag, or prepare a new version.

If a release or draft already exists, the workflow leaves it intact. Inspect it before deciding how to recover; there is no automatic asset replacement or deletion. The final write uses [`gh release create`](https://cli.github.com/manual/gh_release_create) with `--verify-tag --prerelease --latest=false` and exactly the three verified assets. GitHub's repository settings can additionally enable [immutable releases](https://docs.github.com/en/repositories/releasing-projects-on-github/immutable-releases); this workflow's own no-overwrite rule does not prevent an administrator from changing repository refs outside the workflow.

## Build environment and cache

The native runner is `ubuntu-24.04`, with **Bun 1.4.2**, Node 24, Temurin JDK 21 for Gradle and JDK 17 for plugin toolchains. `package.json` pins `packageManager: bun@1.4.2`, which the Bun setup action reads. Official `sdkmanager` installs Platform 36, Build Tools 35.0.0 and 36.0.0, NDK 27.1.12297006 and CMake 3.22.1. The committed wrapper supplies Gradle 9.3.1. Exact Android components are installed explicitly rather than relying on a changing runner image; see the [runner inventory](https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md) and [`sdkmanager` documentation](https://developer.android.com/tools/sdkmanager).

Bun installs packages with `bun ci` or `bun install --frozen-lockfile` and runs package scripts with `bun run`. The existing Expo, React Native, Node test-runner and backend scripts retain their Node runtime. Bun normally honors Node shebangs, and the workflow does not force `--bun`. The license-notice generator explicitly uses Bun's JSONC parser for `bun.lock`. See the official [frozen installation guidance](https://bun.com/docs/pm/cli/install) and [script runtime behavior](https://bun.com/docs/runtime).

Runner Gradle user-home properties keep the Gradle heap at 2 GB with 1 GB metaspace, and the separate Kotlin daemon at 1.5 GB heap with 768 MB metaspace. Gradle allows two workers with project parallelism off. A user-home init script adds CMake compile/link pools of one job each to application and library modules, covering direct Ninja invocations too. These settings passed both the local build and the first hosted Android build recorded below. See [ANDROID-BUILD.md](ANDROID-BUILD.md).

`gradle/actions/setup-gradle` is pinned to v6.4.0's immutable commit and explicitly selects **`cache-provider: basic`**. Default-branch builds can write the shared Gradle cache; tags, other branches and PRs only read it. This lets tags reuse default-branch cache entries. `setup-java` does not add a second Gradle cache. See the official [Gradle caching guide](https://github.com/gradle/actions/blob/v6.4.0/docs/setup-gradle.md).

Bun's package cache at `~/.bun/install/cache` is restored separately with the OS, architecture, Bun version and lockfile hashes in its key. Only successful default-branch pushes save that cache; PRs and tag/manual builds only restore it. Bun's setup action caches its downloaded executable separately and disables that executable cache for PRs. The Node setup action's package-manager cache is disabled. Neither `node_modules`, the checkout nor `android/app/build` is cached. See [Bun's cache documentation](https://bun.com/docs/pm/global-cache) and the [setup-bun inputs](https://github.com/oven-sh/setup-bun/tree/v2.2.0).

The other action pins were verified against official releases on 2026-10-07: [checkout 7.0.1](https://github.com/actions/checkout/releases/tag/v7.0.1), [setup-node 7.0.0](https://github.com/actions/setup-node/releases/tag/v7.0.0), [setup-java 6.0.1](https://github.com/actions/setup-java/releases/tag/v6.0.1), [upload-artifact 7.0.1](https://github.com/actions/upload-artifact/releases/tag/v7.0.1) and download-artifact 8.0.1. The download action's full SHA and pairing with upload-artifact 7.0.1 are also recorded in [GitHub's maintained workflow](https://github.com/github/gh-aw/blob/main/.github/workflows/developer-docs-consolidator.lock.yml). Review and update immutable pins deliberately as upstream actions change.

The Bun migration adds [setup-bun 2.2.0](https://github.com/oven-sh/setup-bun/releases/tag/v2.2.0), pinned to `0c5077e51419868618aeaa5fe8019c62421857d6`, and [cache restore/save 6.1.0](https://github.com/actions/cache/tree/v6.1.0), pinned to `55cc8345863c7cc4c66a329aec7e433d2d1c52a9`. Both full tag targets were verified against their official Git repositories; the cache action's restore/save inputs were also checked at that tag.

## Signing and publication boundary

This channel intentionally preserves `android/app/debug.keystore` and the existing prototype identity:

```text
Package: dev.perch.assistant
Certificate SHA-256:
fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c
```

The private key material in this prototype keystore is publicly available in source. It provides update continuity for this prototype; it does not establish exclusive publisher control. The preflight rejects keystore drift, and the final APK check rejects certificate drift. **Before production distribution, provision and back up a private permanent signing key and plan the installation migration.** An ordinary Android update cannot simply switch from this signer to an unrelated key. See [Android app signing](https://developer.android.com/studio/publish/app-signing).

Only the publishing job has `contents: write`; it uses the repository-scoped `GITHUB_TOKEN`, supplied to the final publishing step. The build jobs remain read-only. There is no `pull_request_target`, production signing-secret configuration, Cloudflare deployment, or device credential. The final job verifies the exact artifact handoff before creating a missing tag and prerelease. A newer default-branch push does not cancel an active publication.

CI establishes build and packaging evidence. Native startup, in-place upgrade behavior on the Pixel/GrapheneOS device, keyboard and WebView behavior, and live-host connections still need device verification for the released build.

## Local validation of the release automation

The implementation was checked locally on 2026-10-07 without triggering a remote workflow or another native build:

```sh
node --test scripts/ci-android.test.mjs scripts/release-prototype.test.mjs
python3 scripts/ci-android-package.test.py
bash -n scripts/ci-android-setup.sh
node --check scripts/ci-android-version.mjs
node --check scripts/release-prototype.mjs
actionlint .github/workflows/android.yml
```

All 15 Node guard tests and six Python artifact handoff tests passed. They cover version/key drift, missing Bun locks and unpinned package-manager versions, tag ancestry, increasing versions/codes, PR and manual-publication restrictions, automatic default-branch publication, existing-release idempotence, conflicting tags, API authorization failures, altered APK bytes, a wrong source commit, extra assets and missing signature evidence. Publication tests use local command doubles, so they do not create actual GitHub tags or releases.

Separate version-helper fixtures checked invalid and regressive versions/codes, a read-only preview, all version locations, signing preservation, refusal of changed inputs, explicit code/minor-version updates, and refusal to reuse a proposed version that already has a tag. The helper stages replacement and backup bytes beside each target, then uses atomic file renames. Fault injection confirmed that a partial temporary-file write leaves every original intact, a failure on the second replacement restores the first, and a successful update leaves consistent versions with no temporary directories. These are per-file atomic replacements with compensation for caught failures, not a filesystem transaction across all version files.

The workflow YAML was parsed and its triggers, immutable action pins, permission boundaries, cancellation rules, shell environment handling and Gradle cache policy were checked. **actionlint 1.7.12 passed** on the final Bun workflow; its Linux binary was downloaded from the [official release](https://github.com/rhysd/actionlint/releases/tag/v1.7.12) and verified against the release's published archive checksum before execution.

After the Bun migration, all 15 Node guards and six Python artifact tests passed again without npm-lock assumptions. An actual Bun 1.4.2 command fixture verified that `bun run --cwd` uses the requested directory and dispatches an explicit `node` package script under Node 24.19.0. The app and native backend runtime have not been switched to Bun by changing the package manager.

The pre-notice APK was also inspected with the real Android tools: its identity, signer, SDK, ABI, embedded bundle and ELF checks passed, and the newly required notice gate correctly rejected it before writing distribution files. The final local Bun APK subsequently passed the same packaging command with the exact committed notices and a clean source tree at `44bc088014567ce16db4399b741dac9a06e97652`. Its 47,736,890 bytes have SHA-256 `4389a727cde3d69cc8581d7736ff3933bfefea88d459ca5e722980eb47b59bc3`.

## Current hosted release: 0.6.0 verified

[Run 37598249819](https://github.com/phibkro/perch/actions/runs/37598249819)
passed all three jobs on its first attempt on 7 October 2026, from
[`a78c4f976426dc24eb691ede260fc72839c66007`](https://github.com/phibkro/perch/commit/a78c4f976426dc24eb691ede260fc72839c66007).
The publisher created `v0.6.0` at that exact source commit and published the
[0.6.0/code 7 prerelease](https://github.com/phibkro/perch/releases/tag/v0.6.0)
at 09:24:10 UTC. The run took 18 minutes 16 seconds overall, with a 46-second
source job, 17-minute Android job, and 18-second publication job. The native
compile/lint step reported 15 minutes 56 seconds. These are observed timings,
not a promise for subsequent builds.

| Published asset | Bytes | SHA-256 |
| --- | ---: | --- |
| `perch-prototype-arm64.apk` | 47,793,490 | `8111032dfa12381868b6c2ee016beacaa20ddeedde007c4c91b74b16d046f34a` |
| `release-metadata.json` | 3,927 | `bee4a9a95976ba893a561c7e458c8550dffeab3c42296ccdfad3f1cae0a6c7e3` |
| `SHA256SUMS` | 180 | `30ffbae152308868ff634f4018f2a40d4b51353fa4c53c5a6ac8fb03b6b71f90` |

All three assets were downloaded independently and verified at 09:25:42 UTC.
Their complete bytes match GitHub's digests and the checksum file. The tag,
metadata, successful run, and downloaded binary agree on source and version.
The actual APK passed package, SDK, ARM64, non-debuggable, preserved signer,
signature v2, 16 KB ZIP, and all 21 native ELF alignment checks. Its embedded
bundle matches the published metadata, and its notices match the exact source
blob. CI separately checks the bundle against its generated build output.

The delivered APK is this GitHub-built binary. No separate local 0.6 APK was
built. Pixel installation, keyboard painting, and live provider/Cloudflare
qualification remain device and account checks. See the current records in
[VERIFICATION.md](VERIFICATION.md) and [ANDROID-BUILD.md](ANDROID-BUILD.md).

## First hosted release: verified

[Run 37590202398](https://github.com/phibkro/perch/actions/runs/37590202398)
passed on its first attempt on 7 October 2026, from
[`44bc088014567ce16db4399b741dac9a06e97652`](https://github.com/phibkro/perch/commit/44bc088014567ce16db4399b741dac9a06e97652).
The first runner had no existing repository Bun/Gradle cache. Source checks,
the native build, final APK verification, artifact upload, cache saving, and the
isolated publisher all completed successfully. No workflow correction or rerun
was needed.

| Observed stage | Duration |
| --- | --- |
| Complete workflow, 07:53:52–08:08:24 UTC | 14 minutes 32 seconds |
| App, protocol, and backend job | 42 seconds |
| Android job, including setup and cache save | 13 minutes 26 seconds |
| Lint-enabled native build step | 12 minutes 15 seconds |
| Verified release publication job | 14 seconds |

Gradle itself reported 12 minutes 14 seconds and 875 tasks: 745 executed and
130 from its build cache. This cache reuse within the first build does not imply
a pre-existing repository Actions cache. The workflow now has saved Bun and
Gradle caches for later runs; no future duration is guaranteed.

The publisher created `v0.5.0` at the exact built commit and published the
[Perch 0.5.0 prerelease](https://github.com/phibkro/perch/releases/tag/v0.5.0)
at 08:08:21 UTC. It is a public prerelease, not a draft.

| Published asset | Bytes | SHA-256 |
| --- | ---: | --- |
| `perch-prototype-arm64.apk` | 47,736,738 | `2f43af6ab3788e4387e71a9293124ec8492218fb513d1cd64829b3ff1bfe235e` |
| `release-metadata.json` | 3,927 | `f080857336204e2eac495095ae1f4a5062a38b70740403930f1d62f58849850f` |
| `SHA256SUMS` | 180 | `7e313ff3d8e7c9f30a53d7a3d857fc7da80760996ff5e9574ab5822f70a6f8fb` |

The published APK is the GitHub-built binary. The separately verified local
binary above has its own checksum; it is not described as byte-identical to the
hosted build. Obtainium downloads the published asset. Device installation and
upgrade behavior have not been exercised on a Pixel in this workspace.

All three public assets were downloaded independently after publication. Their
complete bytes match the GitHub asset digests, and `SHA256SUMS` matches the APK
and metadata. The metadata identifies the clean built commit, Bun 1.4.2 and this
workflow run. The downloaded APK's embedded application bundle and full notice
asset also match the verified local build exactly.
