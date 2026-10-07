# Perch 0.1 historical build notes

This file records the earlier 0.1 prototype. For the current 0.2 APKs, use [Android build verification](docs/ANDROID-BUILD.md); for the local development tools, use [Development](docs/DEVELOPMENT.md).

Perch is an Expo SDK 57 / React Native project. Its Android action controls use `@expo/ui`, which renders Jetpack Compose controls inside a native `Host`. The web preview uses the package's web implementation; a successful web preview does not validate Compose layout on a phone.

## Versions and reproducibility

The project pins Expo 57.0.26, React Native 0.86.3, React 19.2.3, `@expo/ui` 57.0.21, and TypeScript 5.9.3. `package-lock.json` records the installed dependency graph. The Expo packages match the installed SDK's compatibility manifest. Native AES-GCM is provided by `expo-crypto` 57.0.3.

```sh
npm ci
npm run typecheck
npm run web
npm run export:web
npm run bundle:android
```

`dist-web` is a static production web preview. Serve it through HTTP (for example, `python3 -m http.server 8080 --directory dist-web`). `dist-android` contains a production Hermes JavaScript bundle, not an installable Android application.

## Android installation build

Use a supported Node release (20.19.4+, 22.13.0+, or 24.3.0+; this workspace uses Node 24.19.0), a JDK compatible with the generated Gradle build (this workspace uses JDK 21), and a local Android SDK. The generated app selects Android platform 36, build tools 36.0.0, NDK 27.1.12297006 and CMake 3.22.1. Gradle also installed build tools 35.0.0 for native library subprojects. Set `JAVA_HOME` and `ANDROID_HOME` for that installation.

```sh
npm ci
npm run prebuild:android
npm run apk
```

The `apk` script requests an arm64 release build for the Pixel 8a. Release bundles JavaScript into the APK and does not require a Metro development server. The expected output is `android/app/build/outputs/apk/release/app-release.apk`.

The generated Expo release configuration uses the template's development signing key. This is suitable for a local prototype; replace it with your own signing configuration before publishing or maintaining a production release. A different signing key cannot update an already installed copy in place.

For development with a connected Android device, `npm run android` builds and launches the development variant, which uses Metro. The optional `eas.json` includes an APK preview profile if you later choose an EAS build; no EAS account, cloud build or publishing was used here.

## Verification in this workspace

- Installed dependencies successfully and generated `package-lock.json`.
- `expo install --check` passed using the installed SDK's offline compatibility manifest. The online check timed out through this environment's proxy.
- Expo Android prebuild completed successfully with real native Android sources.
- Production web export passed: 2,265 modules.
- Production Android export passed: 2,735 modules and a roughly 4 MB Hermes bytecode bundle.
- Local JDK 21, Gradle 9.3.1 and required Android SDK / NDK / CMake packages were installed successfully.
- Standalone `assembleRelease` succeeded for `arm64-v8a`: 340 Gradle tasks, including native C++ / Kotlin / Java compilation and release lint.
- APK signature verification passed with APK Signature Scheme v2. The signer is the Expo template's Android development certificate.
- APK inspection confirms package `dev.perch.assistant`, version `0.1.0` (code 1), minimum API 24 and target API 36; it is a release application, not marked debuggable.
- The APK contains a 3,073,560-byte Hermes bundle at `assets/index.android.bundle` and only `arm64-v8a` native libraries. Its JavaScript was bundled after the final frozen `App.tsx` change.
- Native Expo UI, Expo Crypto and Jetpack Compose Material 3 classes are present in the packaged DEX files.
- `zipalign -c -P 16 4` passed. All 17 packaged native libraries have 16 KB ELF load-segment alignment.
- The final manifest requests Internet, vibration, and AndroidX's internal signature-protected receiver permission. Microphone, overlays, legacy storage, biometric and fingerprint permissions are absent.

APK size: **36,852,152 bytes** (35.15 MiB). SHA-256:

```text
bd3f10df8248e3961aa8c524f03022b7f75cb2e4804211a918e61ce7762ddaa9
```

The native application has not been run on a Pixel 8a, an Android emulator, or GrapheneOS in this workspace. Keyboard resize, touch behavior and native Compose layout require that device check. No push-notification transport, Google Play service, WebGPU renderer, Tern terminal renderer, or TSP client is added by the project scaffolding.
