# Android build verification — Perch 0.2

Both variants were built from the project with production application source frozen at **`7a14dfeeebfe6a30fbf280c68716119a6554a206`**. Later changes concern documentation and development launch/build scripts. Both APKs were built and inspected on 2026-10-07. The standalone variant embeds that application source; the development variant loads application JavaScript from Metro.

## Standalone APK

| Check | Verified result |
| --- | --- |
| Delivery file | `perch-prototype-arm64.apk` |
| Native output | `android/app/build/outputs/apk/release/app-release.apk` |
| Size | 47,519,218 bytes (45.32 MiB) |
| SHA-256 | `2762206abb1e0238b413f382e69bad281cd0981b2b15f1d91fdff235c3990d23` |
| Package | `dev.perch.assistant` |
| Version | `0.2.0` / versionCode `2` |
| Minimum / target / compile SDK | 24 / 36 / 36 |
| Packaged ABI | `arm64-v8a` only |
| Debuggable | No |
| Embedded main JavaScript | `assets/index.android.bundle`, 6,280,064 bytes |
| APK signature | v2 verified; original prototype signer preserved |
| ZIP alignment | `zipalign -c -P 16 4` passed |
| ELF alignment | All LOAD segments in all 21 packaged `.so` files are aligned to at least 16,384 bytes |

The release APK embeds its JavaScript and does not require Metro. It retains the existing package and signing certificate, so it can update the earlier Perch prototype.

## Development APK

| Check | Verified result |
| --- | --- |
| Delivery file | `perch-development-arm64.apk` |
| Native output | `android/app/build/outputs/apk/debug/app-debug.apk` |
| Size | 91,443,791 bytes (87.21 MiB) |
| SHA-256 | `7e78b39fa61feac0ef9faf34282ad3964a287d00da83a58a92ca557ad1ffd57b` |
| Package | `dev.perch.assistant.dev` |
| Version | `0.2.0-dev` / versionCode `2` |
| Minimum / target / compile SDK | 24 / 36 / 36 |
| Packaged ABI | `arm64-v8a` only |
| Debuggable | Yes |
| Embedded main JavaScript | No `assets/index.android.bundle`; Metro is required |
| APK signature | v2 verified; original prototype signer preserved |
| ZIP alignment | `zipalign -c -P 16 4` passed |
| ELF alignment | All LOAD segments in all 22 packaged `.so` files are aligned to at least 16,384 bytes |

The development client can coexist with the standalone app because it has a separate package ID. Start its development server and device flow with `npm run dev:android`. This APK is intended for Fast Refresh, native inspection, and development testing; it does not contain the standalone main app bundle.

## Build and inspection commands

The successful release invocation was `npm run apk`, which ran Gradle `assembleRelease -PreactNativeArchitectures=arm64-v8a --no-daemon --max-workers=2` with `NODE_ENV=production`. It completed successfully in **9m 43s**, with **955 actionable tasks: 919 executed and 36 up-to-date**. A prior attempt stopped before bundling because Google Maven returned HTTP 403 for an AndroidX POM; the same official URL became accessible, and an unchanged-dependency retry succeeded.

The build helper now uses the equivalent app-specific `:app:assembleRelease` / `:app:assembleDebug` tasks. This avoids packaging unused library AAR outputs after the app APK is already built.

The first development build passed Java/Kotlin compilation and DEX generation, then overloaded this approximately 10 GB, no-swap environment during native C++ compilation. AGP started two Ninja processes without a `-j` limit; Gradle's `--max-workers=2` did not limit their compiler subprocesses. The app and Expo Core object-file timestamps remained unchanged for over twelve minutes, system load reached about 35, and the Gradle daemon then disappeared. The attempted targeted interruption found that the build had already exited. No dependency or application-source change was needed.

Recovery reused the configured build directories and completed objects. The same targets were compiled sequentially with explicit Ninja parallelism before resuming the app Gradle task:

```sh
"$ANDROID_HOME/cmake/3.22.1/bin/ninja" -j2 \
  -C android/app/.cxx/Debug/4x3m6r5q/arm64-v8a \
  appmodules react_codegen_rnsvg react_codegen_safeareacontext
"$ANDROID_HOME/cmake/3.22.1/bin/ninja" -j2 \
  -C node_modules/expo-modules-core/android/.cxx/Debug/14j2u2u1/arm64-v8a \
  expo-modules-core
npm run apk:development
```

Those hash-named directories are specific to this build. For another workstation, read the generated `build/intermediates/cxx/Debug/.../logs/arm64-v8a/build_command_*` files to locate its configured directories and targets. Do not run a second Ninja process against a directory already being built. The regular helper caps Gradle workers, but it does not yet impose a global native compiler limit; a low-memory clean build may need the constrained native step above.

The app native recovery completed in **59.7 seconds** and Expo Core in **28.9 seconds**. The resumed `:app:assembleDebug -PreactNativeArchitectures=arm64-v8a --no-daemon --max-workers=2` invocation, with `NODE_ENV=development`, then completed successfully in **43 seconds**, with **521 actionable tasks: 48 executed and 473 up-to-date**. The package, signature, ABI, embedded-bundle, and both alignment checks were performed on the completed development APK, and its copied delivery file matched the recorded SHA-256.

```sh
npm run apk
npm run apk:development
```

The build used JDK 21.0.12.1, Gradle 9.3.1, Android Platform 36, Build Tools 36.0.0, NDK 27.1.12297006, CMake 3.22.1, Kotlin 2.1.20, and the pinned SDK 57 npm dependency graph. The project-local launchers read standard `JAVA_HOME` / `ANDROID_HOME` settings, or optional ignored workstation settings described in [DEVELOPMENT.md](DEVELOPMENT.md).

For each output, the checks use Android Build Tools and the NDK:

```sh
"$ANDROID_HOME/build-tools/36.0.0/apksigner" verify --verbose --print-certs APK_PATH
"$ANDROID_HOME/build-tools/36.0.0/zipalign" -c -P 16 4 APK_PATH
"$ANDROID_HOME/build-tools/36.0.0/aapt2" dump badging APK_PATH
"$ANDROID_HOME/build-tools/36.0.0/aapt2" dump xmltree --file AndroidManifest.xml APK_PATH
sha256sum APK_PATH
```

The APK ZIP contents were inspected for the exact embedded main-bundle entry and ABI directory set. Each packaged `.so` was extracted to a temporary directory and inspected with NDK `llvm-readelf -lW`; every LOAD segment alignment was checked against 16,384 bytes. ZIP page alignment and ELF segment alignment are separate checks, and both passed for both variants.

Original keystore file SHA-256:

```text
221e0a3106aa4c3ccc154e0a418b55020b3f9ea6e84f92e8749cd9e2f39f5e58
```

Preserved signer certificate SHA-256:

```text
fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c
```

This is the prototype development signing key, including for the standalone release variant. It is not a private production signing identity.

## Verification boundary

These checks prove that Android compiled and packaged the app, the outputs have the expected identity/ABI/signature, and the inspected native binaries meet 16 KB alignment requirements. They do not prove runtime behavior on a phone. **No physical Pixel or emulator was attached**, so native startup, keyboard insets, Compose layout, Android WebView behavior, GrapheneOS permission behavior, and device-side live-host networking remain untested. See [VERIFICATION.md](VERIFICATION.md) for the separately verified application/protocol/preview behavior and [DEVELOPMENT.md](DEVELOPMENT.md) for the prepared device tools.
