# Develop and verify Perch

Perch is an Expo SDK 57 native React Native app. The Android app is the primary target. The local workflow requires no Expo account or Google Play services. Hosted Expo services remain optional, and over-the-air updates are disabled in this checkout.

## Install the project tools

Use Bun 1.4.2, Node 24, JDK 21, and the Android SDK. Bun manages dependencies and script commands; the Expo, Android, and agent scripts retain their Node runtime. Install Android Platform 36, Build Tools 36.0.0 and 35.0.0, Platform Tools, NDK 27.1.12297006, and CMake 3.22.1. Set `JAVA_HOME` and `ANDROID_HOME` for your machine. The checked-in Gradle wrapper downloads Gradle 9.3.1.

```sh
bun install --frozen-lockfile
bun run tools:install
bun run tools:doctor
```

`tools:install` installs the separate, locked `tooling/` package with Bun, then downloads Maestro 2.11.0 from its official GitHub release and verifies the official SHA-256 checksum. The tool pins are agent-device 0.21.22 and EAS CLI 24.11.0. Expo MCP 0.2.4 is an app development dependency. Installed native packages include expo-dev-client 57.0.19 and expo-updates 57.0.24.

Each installable package pins `bun@1.4.2`. The Bun lockfiles preserve the previous
dependency versions, and the hoisted linker keeps the Node/React Native module
layout. Use `bun install --frozen-lockfile` for reproduction and CI. After a
deliberate dependency change, regenerate the packaged third-party notices with
`bun scripts/generate-third-party-notices.mjs` and commit the changed lockfile
and notice asset together.

When migrating an existing npm checkout, start with a fresh dependency directory
before installing with Bun. The migration audit caught obsolete nested npm
packages that could shadow the locked Bun versions. A fresh clone or clean CI
checkout avoids that leftover layout. Keep Node 24 installed: changing the
package manager does not change the runtime required by Expo and the existing
agent and Android scripts.

The launchers use environment variables first. If convenient, create an ignored `tooling/local.json` with `javaHome`, `androidHome`, and `gradleUserHome` paths. `javaTrustStore` and `useEnvironmentProxyForGradle` are optional settings for an environment that uses a trusted HTTPS proxy; they are unnecessary on an ordinary workstation. Do not copy this workspace's paths to your computer.

## Iterate on a connected Pixel

Enable Developer options and USB debugging on the Pixel, connect an appropriate USB cable, unlock it, and accept the computer's debugging key. On GrapheneOS, the USB-C port setting must allow the data connection. `adb devices -l` must show the device as authorized before testing.

```sh
bun run dev:android
```

This builds and installs the debug variant, selects a device, and starts Metro. Its package ID is **dev.perch.assistant.dev**, so it can coexist with the standalone **dev.perch.assistant** app. A source edit normally uses Fast Refresh; a native dependency or native configuration change requires a new development build. The development APK needs a reachable Metro server and is not a standalone release.

For USB development, Expo normally configures ADB reverse. If connection setup fails, run `adb reverse tcp:8081 tcp:8081` and reopen the development server from the development client's launcher. The app needs GrapheneOS network permission for a remote host or Metro. No FCM/push-notification service has been added.

To produce installable ARM64 APKs locally:

```sh
bun run apk
bun run apk:development
```

Outputs are `android/app/build/outputs/apk/release/app-release.apk` and `android/app/build/outputs/apk/debug/app-debug.apk`. The release task sets `NODE_ENV=production` and embeds the JavaScript bundle. Both prototype variants use the existing development signing key. Preserve `android/app/debug.keystore` when regenerating native files; changing it prevents updating an existing installation. Use a private release key before production distribution. The config plugin in `plugins/with-perch-development.js` preserves the distinct debug package suffix after Expo prebuild.

The local APK commands verify the final binary package, version name, and version code with SDK `aapt2` before reporting success. These values must match `app.json`, including the development suffixes. A mismatch fails with the expected and actual identities. This caught stale incremental resources during the 0.3 build; see [ANDROID-BUILD.md](ANDROID-BUILD.md) for the targeted correction and complete artifact checks.

## Develop the durable backend

The Pi Durable service is a separate package in `server/pi-durable`; its server
SDKs are not installed in the native bundle. Follow [DURABLE-BACKEND.md](DURABLE-BACKEND.md)
for token, model, origin, and bucket configuration. Build before starting the
provided celld development command, because the sample configuration points to
`dist/worker.mjs` and the launcher disables file watching.

```sh
bun install --cwd server/pi-durable --frozen-lockfile
bun run --cwd server/pi-durable test
bun run --cwd server/pi-durable build
bun run --cwd verification/durable test
CELLD_BIN=/absolute/path/to/celld node verification/durable-runtime/verify.mjs
CELLD_BIN=/absolute/path/to/celld node verification/durable-runtime/verify.mjs --production-provider
```

The root dependencies must also be installed for the actual client/store fixture.
The runtime checks create their own isolated local development storage and public
test credentials. They do not use a user's backend or invoke paid inference.
Keep heavy Android builds separate from celld recovery tests on a memory-limited
machine: celld may shed a runtime when total cgroup memory crosses its threshold.
Do not disable that protection to obtain a passing result. See the
[runtime verifier](../verification/durable-runtime/README.md) for exact scope.

## Inspect and test the native app

The local agent-device and Maestro MCP servers are configured in `.mcp.json`. Start your MCP client from the project root, or resolve the relative launcher arguments against this checkout when importing the config. No global agent configuration has been changed. A client must explicitly load this project configuration; the config file does not itself attach tools to an already-running chat.

For an installed standalone app on an authorized device:

```sh
node tooling/run.mjs agent-device open dev.perch.assistant --platform android --foreground
node tooling/run.mjs agent-device snapshot -i
node tooling/run.mjs agent-device screenshot artifacts/device/perch.png
node tooling/run.mjs agent-device close
```

Use the returned accessibility references for actions and refresh them after the screen changes. For the development app, use `dev.perch.assistant.dev` and keep Metro running. Create `artifacts/device` before saving captures. Captures can contain host conversation content; keep them local unless you deliberately share them.

Use one device controller at a time: close the agent-device session before running Maestro. Maestro flows exercise the standalone demo without connecting a host or calling a model. **They clear Perch's app data** to establish a deterministic starting point.

```sh
bun run test:device
node tooling/run.mjs maestro test .maestro/demo-turn.yml
```

The smoke flow checks draft entry, navigation, Markdown preview, copying an artifact, HTML preview, and source switching. The second flow checks the simulated tool/question/answer cycle. These use real accessibility labels from the app. Run on the Pixel to verify keyboard overlap, safe-area insets, font scaling, touch targets, and WebView behavior; a successful source check cannot prove those device behaviors.

Read-only setup checks are also available:

```sh
node tooling/check-mcp.mjs
node tooling/run.mjs maestro check-syntax .maestro/smoke.yml
node tooling/run.mjs maestro check-syntax .maestro/demo-turn.yml
```

The MCP handshake check discovers tools only; it does not open apps, control a device, or run a cloud job. The project launchers disable optional Expo and Maestro CLI analytics.

## Use assistant-ui skills

All 17 official assistant-ui skills are included as complete, unmodified directories in `.agents/skills`, alongside the Expo skills. Their 90 reference files and sibling links are preserved. No additional install command is needed after extracting this source checkout.

| Area | Included skills |
| --- | --- |
| Architecture and setup | `assistant-ui`, `setup`, `update` |
| Native and terminal surfaces | `react-native`, `ink` |
| Chat and generated content | `elements`, `primitives`, `markdown`, `generative-ui` |
| State, transports, and tools | `runtime`, `streaming`, `tools`, `thread-list`, `react-mcp`, `copilots` |
| Optional services and diagnostics | `cloud`, `observability` |

For Perch, start with `react-native` and its references, then `runtime` for shared state and adapter concepts. The root `AGENTS.md` routes native UI, harness, and artifact work to their relevant guides. The generic `elements`, `primitives`, `markdown`, and `react-mcp` guides contain web/DOM examples; apply their ideas through native APIs. Check all examples against this project's pinned package versions and installed exports before changing code. The upstream bundle also describes newer web and AI SDK APIs.

Clients that discover `.agents/skills` can load the guides directly. Other clients can read `AGENTS.md` and the named `SKILL.md` paths. These files provide development guidance; installing them does not configure cloud services or add mobile runtime dependencies.

The source is [assistant-ui/skills at commit `139674dc888ee076982b6726e8e6f5d0fe0b5f67`](https://github.com/assistant-ui/skills/tree/139674dc888ee076982b6726e8e6f5d0fe0b5f67). `.agents/skills/ASSISTANT_UI_PROVENANCE.json` records the revision and SHA-256 of every copied file. `ASSISTANT_UI_UPSTREAM_README.md` preserves the upstream inventory and MIT declaration; each skill retains its own MIT frontmatter declaration. Upstream supplies no separate LICENSE file.

## Use Expo skills and MCP

Eight official Expo skills are installed as complete project-local directories in `.agents/skills`: Expo overview, Expo UI, development clients, native modules, data fetching, EAS Workflows, EAS Update, and SDK upgrades. `PROVENANCE.json` records the immutable upstream commit and a SHA-256 hash for every copied file; `EXPO_LICENSE` preserves the upstream license. The files are unmodified upstream guidance. Agent clients that support `.agents/skills` can discover them directly; other clients can read the relevant `SKILL.md` explicitly.

The `expo` entry in `.mcp.json` points to `https://mcp.expo.dev/mcp` and requires Expo OAuth in an MCP-capable client. The local Expo CLI also needs its own signed-in session (`node tooling/run.mjs eas login`); authenticating the MCP client alone does not supply the CLI tunnel credentials. With an authorized Android device attached, start the development build with MCP support:

```sh
bun run dev:mcp
```

This uses the same explicit development package ID as `dev:android`, builds/installs that variant, and starts Metro with Expo's documented `EXPO_UNSTABLE_MCP_SERVER=1` flag and the installed expo-mcp package. The remote integration can relay development context through Expo; it is separate from the fully local Maestro and agent-device servers. No Expo OAuth session was created here.

## Optional hosted builds and workflows

`eas.json` defines three prototype profiles: `development` builds a debug development client; `preview` builds a standalone ARM64 APK; `device-test` includes ARM64 and x86_64 for a hosted Android emulator. The native project already supplies the prototype signing key, so these profiles use `withoutCredentials` rather than creating new hosted signing credentials. They do not define production store distribution.

After deliberately signing into your Expo account and linking this checkout to your own project, validate the workflow files before running them:

```sh
node tooling/run.mjs eas login
node tooling/run.mjs eas init
node tooling/run.mjs eas workflow:validate .eas/workflows/preview.yml --non-interactive
node tooling/run.mjs eas workflow:validate .eas/workflows/device-test.yml --non-interactive
```

The optional commands below upload the project and start hosted work. Plan quotas or charges may apply. They were not run in this workspace.

```sh
node tooling/run.mjs eas build --platform android --profile development
node tooling/run.mjs eas build --platform android --profile preview
node tooling/run.mjs eas workflow:run .eas/workflows/preview.yml
node tooling/run.mjs eas workflow:run .eas/workflows/device-test.yml
```

The workflow files have manual triggers only. The preview workflow checks TypeScript, session behavior, and artifact handling before building. The device-test workflow builds an emulator-compatible APK, then runs the Maestro smoke flow. Hosted Maestro jobs have separate plan availability and remain labeled alpha in Expo's current documentation. No push/schedule trigger, store submission, or update publication is configured. `eas build --local` still expects EAS account/project setup; use `bun run apk` for an account-free local build.

## Optional updates: deliberately disabled

The expo-updates native library is installed, but `updates.enabled` is false. There is no fabricated Expo project ID, update URL, runtime version, channel, or published update. To adopt EAS Update later, link your real project, run the canonical `node tooling/run.mjs eas update:configure` flow, review its resulting runtime/update configuration, enable updates, and rebuild the native clients before publishing any update. Choose release branches/channels for your own deployment. A JavaScript update cannot add a missing native module.

## Verification performed in this workspace

On 2026-10-07, the local CLI versions and Java compiler were verified. ADB returned no connected devices. EAS returned **Not logged in**, and the app had no Expo project ID. Local MCP initialization and tool listing succeeded for agent-device (59 tools) and Maestro (10 tools). Maestro accepted both flow files with `check-syntax`.

Both EAS workflow validation commands were attempted and stopped at the required Expo login. The official workflow-schema endpoint also returned HTTP 403 in this environment. The templates use current official syntax/job documentation, but **server validation and hosted execution remain unverified**. No workflow was submitted. No physical Pixel, emulator, user-host, or external inference-provider test was run here. The real pi RPC runtime was separately tested against a synthetic local model endpoint. See [ANDROID-BUILD.md](ANDROID-BUILD.md) for APK-specific verification and the constrained native-build recovery used in this environment.

## Primary references

- [Expo development builds](https://docs.expo.dev/develop/development-builds/introduction/)
- [Expo local Android development](https://docs.expo.dev/guides/local-app-development/)
- [Expo official skills](https://github.com/expo/skills/tree/d4f484024fec15196bfd3c272e953e3f983972cf)
- [assistant-ui official skills](https://github.com/assistant-ui/skills/tree/139674dc888ee076982b6726e8e6f5d0fe0b5f67) and [installation documentation](https://www.assistant-ui.com/docs/llm)
- [Expo MCP](https://docs.expo.dev/mcp/)
- [agent-device](https://docs.expo.dev/agents/agent-device/) and its installed `help physical-device` guide
- [Maestro CLI release 2.11.0](https://github.com/mobile-dev-inc/Maestro/releases/tag/cli-2.11.0)
- [EAS Build](https://docs.expo.dev/build/introduction/), [workflow syntax](https://docs.expo.dev/eas/workflows/syntax/), [workflow jobs](https://docs.expo.dev/eas/workflows/pre-packaged-jobs/), and [service plans](https://expo.dev/pricing)
- [EAS Update setup](https://docs.expo.dev/eas-update/getting-started/)
- [GrapheneOS USB-C port controls](https://grapheneos.org/usage#usb-c-port)
