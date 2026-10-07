# Android build verification — Perch 0.4

Both variants were built and inspected on **2026-10-07** from application source frozen at **`56842963ac6c04386ed882b5edfd1a053770dfb4`**. Both build records captured that revision. The standalone build regenerated and embedded its application bundle. The development APK loads application JavaScript from Metro.

## Verified delivery

| Check | Standalone | Development |
| --- | --- | --- |
| Delivery file | `perch-prototype-arm64.apk` | `perch-development-arm64.apk` |
| Native output | `android/app/build/outputs/apk/release/app-release.apk` | `android/app/build/outputs/apk/debug/app-debug.apk` |
| Bytes | 47,585,578 | 91,443,795 |
| Package | `dev.perch.assistant` | `dev.perch.assistant.dev` |
| Version / code | `0.4.0` / `4` | `0.4.0-dev` / `4` |
| Minimum / target / compile SDK | 24 / 36 / 36 | 24 / 36 / 36 |
| ABI | `arm64-v8a` only | `arm64-v8a` only |
| Debuggable | No | Yes |
| Main application bundle | Embedded, 6,346,424 bytes | Absent; requires Metro |
| APK signature | v2 verified; original signer | v2 verified; original signer |
| ZIP alignment | `zipalign -c -P 16 4` passed | `zipalign -c -P 16 4` passed |
| Native ELF alignment | Every LOAD segment in all 21 libraries uses 16,384-byte alignment | Every LOAD segment in all 22 libraries uses 16,384-byte alignment |

Standalone APK SHA-256:

```text
92d8237e103c1455471002f3bf42b4fcbd33a5ff937215b1c78a837f6a6d4a65
```

Development APK SHA-256:

```text
a954f4338b3022e00f166a6f55047eda738c1a9e7d3d8343c592622622e4a3f0
```

Embedded standalone bundle SHA-256:

```text
c8e860e5a45c1cefa4839dafcd8fc2c22cf1b7c08896431941f93f7013e24edf
```

The embedded `assets/index.android.bundle` matches `android/app/build/generated/assets/react/release/index.android.bundle` byte for byte. The generated file's timestamp falls within the frozen-source release build, and the build log records the bundle generation. The development APK contains no `.bundle` or `.hbc` entry. Both delivery copies were rehashed after copying and match their inspected native outputs.

The standalone retains the original prototype package and signer. The development client has a separate package ID and can coexist with it; start Metro with `npm run dev:android`. Installation and upgrade behavior still need device validation.

## Commands and observed results

```sh
npm run apk
npm run apk:development
```

The helper invokes `:app:assembleRelease` or `:app:assembleDebug` with `-PreactNativeArchitectures=arm64-v8a --no-daemon --max-workers=2`. It sets `NODE_ENV=production` for standalone and `NODE_ENV=development` for the development client. Builds ran sequentially and reused the existing native caches.

| Build | Gradle result | Complete command wall time | Artifact result |
| --- | --- | --- | --- |
| Standalone | 1m 36s; 875 tasks, 45 executed / 830 up-to-date | 97.325s | Exit 0; binary identity `0.4.0` / code `4`; all inspection checks passed |
| Development | 35s; 521 tasks, 36 executed / 485 up-to-date | 36.735s | Exit 0; binary identity `0.4.0-dev` / code `4`; all inspection checks passed |

Both variants passed their first actual Gradle invocation after the targeted preflight below. A timing-wrapper attempt stopped before invoking npm because `/usr/bin/time` was unavailable; Node subprocess timing was then used with the same build commands. No Android build or APK identity failure occurred in the 0.4 runs.

The logs include warnings about npm's `http-proxy` environment setting, deprecated Gradle features, and manifest merge directives with no matching declaration. The standalone build also reported an empty Metro cache and conflicting color environment settings. These warnings did not prevent either build or the subsequent artifact checks.

### Targeted resource and packaging preflight

The existing native APKs were inspected before invalidation and identified as 0.3 / code 3. Because the earlier 0.3 build exposed stale linked binary resources, only these generated output locations were moved to a task-specific scratch backup before the 0.4 builds:

| Generated location beneath `android/app/build` | Observed action |
| --- | --- |
| `intermediates/linked_resources_binary_format/release` | Moved aside |
| `intermediates/linked_resources_binary_format/debug` | Moved aside |
| `intermediates/optimized_processed_res/release` | Moved aside |
| `intermediates/optimized_processed_res/debug` | Already absent |
| `intermediates/incremental/packageRelease` | Moved aside |
| `intermediates/incremental/packageDebug` | Moved aside |
| `outputs/apk/release` | Moved aside |
| `outputs/apk/debug` | Moved aside |

The normal build commands regenerated the required outputs. Native object directories, Gradle caches, dependencies, and signing material were preserved. No broad clean or application/tooling source change was used for this build.

### Build command checks the final binary

`scripts/verify-android-apk.mjs` reads the final APK with the configured SDK's `aapt2 dump badging`. The launcher compares package, version name, and version code with `app.json`, including the development suffixes, before printing success. SDK discovery reuses `tooling/environment.mjs`, with `android/local.properties` as a fallback.

The guard accepted both final 0.4 binaries. Independent inspection also checked the SDK levels, debuggable flag, ABI, signature, bundle contents, and alignment. The configured SDK path was exercised in these builds; the fallback was not needed.

## Inspection tools and environment

The build used JDK 21.0.12.1, Gradle 9.3.1, Android Platform 36, Build Tools 36.0.0, NDK 27.1.12297006, CMake 3.22.1, Kotlin 2.1.20, and the unchanged pinned Expo 57 dependency graph. Tool locations were resolved through `tooling/environment.mjs` and the local configuration.

```sh
"$ANDROID_HOME/build-tools/36.0.0/apksigner" verify --verbose --print-certs APK_PATH
"$ANDROID_HOME/build-tools/36.0.0/zipalign" -c -P 16 4 APK_PATH
"$ANDROID_HOME/build-tools/36.0.0/aapt2" dump badging APK_PATH
"$ANDROID_HOME/build-tools/36.0.0/aapt2" dump xmltree --file AndroidManifest.xml APK_PATH
"$ANDROID_HOME/ndk/27.1.12297006/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-readelf" -lW EXTRACTED_LIBRARY_PATH
sha256sum APK_PATH
```

ZIP inspection checked the exact main-bundle entry, all ABI directories, the native library counts, and the absence of duplicate entries. NDK `llvm-readelf -lW` checked every LOAD segment in every packaged `.so`. ZIP page alignment and ELF alignment are separate checks; both passed for both variants.

Original keystore SHA-256:

```text
221e0a3106aa4c3ccc154e0a418b55020b3f9ea6e84f92e8749cd9e2f39f5e58
```

Preserved signer certificate SHA-256:

```text
fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c
```

Both APKs have one signer and use the original prototype development signing key. This is not a private production signing identity.

## Previous 0.3 build and stale-resource evidence

The 0.3 artifacts were built on 2026-10-07 from application source **`c56c8665e12f6f35df6a4586f8e2f013f7502f2e`**. The historical accepted standalone was 47,542,494 bytes; the accepted development APK was 91,443,854 bytes. Their versions were `0.3.0` / code `3` and `0.3.0-dev` / code `3`. Their signature, ARM64 ABI, 24 / 36 / 36 SDK levels, and 16 KB alignment checks passed. The embedded standalone bundle was 6,303,340 bytes and matched its generated bundle.

| Historical 0.3 artifact | SHA-256 |
| --- | --- |
| Standalone APK | `9574ae33726190dff746f9b8e40da2cf8baedb8e7d3adb659b4d051bec2a0165` |
| Development APK | `5b45e7b204621586fd3a88a02c05bb9b762450637a7ed555c33538dbdd3f6a38` |
| Embedded standalone bundle | `8eb5ac352d15e4106558b9bbfb2bf7647f87ea58c14a76218f74354cc1d4cf32` |

| Historical build step | Gradle result | Artifact result |
| --- | --- | --- |
| Initial release | 1m 42s; 875 tasks, 44 executed / 831 up-to-date | Rejected: binary still identified itself as 0.2 / code 2 |
| Packaging-only regeneration | 30s; 21 executed / 854 up-to-date | Rejected: fresh package metadata and JavaScript, but stale binary manifest |
| Resource and packaging regeneration | 29s; 23 executed / 852 up-to-date | Accepted: 0.3.0 / code 3 and all checks passed |
| Development build | 34s; 521 tasks, 36 executed / 485 up-to-date | Accepted: 0.3.0-dev / code 3 and all checks passed |

The merged and packaged source manifests and metadata contained 0.3 / code 3, while `linked-resources-binary-format-release.ap_` retained the earlier binary manifest for 0.2 / code 2. Regenerating the linked resources, optimized resources, incremental package, and final APK output corrected the mismatch. The corresponding existing debug outputs were invalidated before its build. The lower-level reason that incremental tasks retained those outputs was not established.

The binary identity guard was added after those application builds. It rejected the actual stale 0.2 APK and accepted both final 0.3 APKs. Node syntax checks passed; the configured SDK path was exercised, and the `local.properties` fallback was source-inspected. This history motivated the limited 0.4 preflight and the continued inspection of final binaries.

## Verification boundary

These checks establish Android compilation, packaging, expected identity, ABI, signature, current embedded release code, and 16 KB alignment. **No physical Pixel or emulator was attached.** Native startup, installation or upgrade behavior, keyboard clearance, drawer geometry, Compose layout, WebView enforcement, GrapheneOS permissions, and live-host networking still need device validation.

See [VERIFICATION.md](VERIFICATION.md) for application/protocol/DOM evidence and [DEVELOPMENT.md](DEVELOPMENT.md) for the prepared device tools. The earlier [0.2 build record](ANDROID-BUILD-0.2.md) retains the cold-build evidence and constrained Ninja recovery procedure for a low-memory workstation; the 0.3 and 0.4 builds reused those native caches.


## Perch 0.5 standalone release — 2026-10-07

The standalone APK was built from application source matching **`3ab26d43c247be855710b207343b19e4b44796b0`**. SHA-256 records for 79 code, configuration and asset files matched that commit and remained unchanged through the final build. The captured files exclude Markdown documentation. The later documentation and release-automation work does not change the embedded application.

| Check | Verified standalone result |
| --- | --- |
| Delivery file | `perch-prototype-arm64.apk` |
| Native output | `android/app/build/outputs/apk/release/app-release.apk` |
| Bytes | 47,641,794 |
| Package | `dev.perch.assistant` |
| Version / code | `0.5.0` / `5` |
| Minimum / target / compile SDK | 24 / 36 / 36 |
| ABI | `arm64-v8a` only |
| Debuggable | No |
| Embedded application bundle | `assets/index.android.bundle`, 6,402,640 bytes |
| Signature | v2 verified; original prototype signer |
| ZIP alignment | `zipalign -c -P 16 4` passed |
| Native ELF alignment | Every LOAD segment in all 21 packaged libraries has alignment of at least 16,384 bytes |

APK SHA-256:

```text
458b7dbe3cc2fc1f962ec279137367a79aeb7aa6bb37b25915dc2610a3bb5d37
```

Embedded application bundle SHA-256:

```text
1b40b00a568d69662c4a4b1846fa177e146b275611f74e17d114eaf0cab8cbbf
```

The inspected APK's bundle matches `android/app/build/generated/assets/react/release/index.android.bundle` byte for byte. The bundle was generated during the cold build and reused by the successful final invocation after the source hashes were checked again. The copied delivery APK was rehashed and matches its native build output. ZIP inspection found no duplicate entries. The original keystore hash and signer certificate recorded earlier in this document remain unchanged.

### Successful command and retained build gates

`npm run apk` completed with **BUILD SUCCESSFUL in 1m 3s**, with **875 actionable tasks: 57 executed and 818 up-to-date**. The measured complete command ran from `2026-10-07T07:00:03.368Z` to `2026-10-07T07:01:07.283Z`. It used the existing ARM64 release task with a production bundle and final binary identity guard.

The previously failing SVG and WebView `lintVitalAnalyzeRelease` tasks and the application's lint analysis executed successfully in this final invocation. No lint finding was suppressed. Reanimated and Worklets lint tasks retain their upstream disabled configuration. The standard build helper now invokes the Unix Gradle wrapper through `sh`, so an extracted source archive can build even if its executable permission was lost. Windows behavior is unchanged.

### Cold build recovery and bounded memory

The earlier SDK/JDK, Gradle and native build caches had been pruned. The toolchain was restored from official upstream downloads with published checksums: Corretto JDK 21.0.12.1, Gradle 9.3.1, Android Platform 36, Build Tools 35.0.0 and 36.0.0, NDK 27.1.12297006 and CMake 3.22.1. The Gradle plugin also requested and installed its Adoptium JDK 17 toolchain. Existing native source, package identifiers and signing material were preserved.

| Attempt | Observed result | Targeted recovery |
| --- | --- | --- |
| First complete release attempt | Failed after 5m 14s while Plugin Portal returned HTTP 403 for five public dependency POM HEAD requests. | Each original Maven Central POM returned HTTP 200, matched its cached bytes and published checksum. A workstation Gradle init script placed official Maven Central before Plugin Portal for plugin resolution. No dependency coordinate or access control changed. |
| Cold native build after repository correction | Native compilation and bundling progressed, then SVG/WebView lint failed; cleanup emitted repeated `java.lang.OutOfMemoryError: Metaspace`. | The failed process was interrupted after preserving its outputs and logs. Gradle kept its 2 GB heap while its workstation metaspace allowance rose from 512 MB to 1 GB. Kotlin's separate daemon was bounded to 1.5 GB heap / 768 MB metaspace. The 8 GB cgroup limit was unchanged. |
| First warm resume | Failed in 35s during asset merging because a zero-byte Hermes temporary file, `index.android.bundle.hbc.c61aaf`, remained and was reported as a duplicate resource. | Moved that temporary file and only the generated asset-merge/compression state aside. The real bundle and native objects were retained. |
| Final warm resume | Passed all enabled release tasks and the binary identity guard. | Performed signature, SDK/ABI, bundle, ZIP and ELF alignment checks on the resulting APK; rehashed the delivery copy. |

Parallel project execution was disabled for recovery. Gradle remained capped at two workers. Workstation CMake arguments set a one-slot compile pool and a one-slot link pool; the generated app/Worklets CMake cache and Ninja rules confirmed those limits. This avoided unbounded native compiler fan-out. These are build-resource settings; they do not change app logic or raise the workspace's memory cap.

The repository-order correction follows [Gradle's guidance about Maven Central dependencies used by plugins](https://plugins.gradle.org/docs/mirroring). The failed coordinates were `org.jetbrains.kotlin:kotlin-gradle-plugin-idea-proto:2.1.20`, `org.jetbrains.kotlin:kotlin-gradle-plugin-annotations:2.1.20`, `com.google.code.gson:gson:2.11.0`, `org.jetbrains.kotlin:kotlin-util-klib:2.1.20`, and `org.jetbrains.kotlinx:kotlinx-coroutines-core-jvm:1.8.0`. A representative Google Maven Android builder POM was also checked successfully against its publisher checksum.

### Scope of this release check

Only the standalone 0.5 APK was built in this run. No physical device or emulator execution was performed. These checks establish successful compilation/packaging, the committed embedded application, expected identity and signing continuity, ARM64 ABI, and 16 KB alignment. Installation/upgrade behavior, native startup, touch/keyboard geometry, Android WebView enforcement and GrapheneOS live-host networking remain device checks.
