import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { projectRoot, developmentEnvironment } from '../tooling/environment.mjs';
import { verifyAndroidApk } from './verify-android-apk.mjs';

const development = process.argv.includes('--development');
const unknown = process.argv.slice(2).filter((arg) => arg !== '--development');
if (unknown.length) throw new Error(`Unknown arguments: ${unknown.join(', ')}`);
const env = { ...developmentEnvironment(), NODE_ENV: development ? 'development' : 'production' };
function run(command, args, cwd = projectRoot) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
if (!existsSync(path.join(projectRoot, 'android', 'gradlew'))) {
  run(process.execPath, ['node_modules/expo/bin/cli', 'prebuild', '--platform', 'android', '--no-install']);
}
// Source archives may not preserve executable permissions on the Unix wrapper.
const gradle = process.platform === 'win32' ? 'gradlew.bat' : 'sh';
const wrapper = process.platform === 'win32' ? [] : ['./gradlew'];
run(gradle, [...wrapper, development ? ':app:assembleDebug' : ':app:assembleRelease', '-PreactNativeArchitectures=arm64-v8a', '--no-daemon', '--max-workers=2'], path.join(projectRoot, 'android'));
const apkPath = path.join(projectRoot, 'android/app/build/outputs/apk', development ? 'debug/app-debug.apk' : 'release/app-release.apk');
const identity = verifyAndroidApk(apkPath, { development, env });
console.log(`\nAPK: ${path.relative(projectRoot, apkPath)}`);
console.log(`Verified binary manifest: ${identity.packageName}, version ${identity.versionName} (code ${identity.versionCode}).`);
console.log(development ? `Development client: ${identity.packageName}. Start Metro with bun run dev:android; this APK is not standalone.` : `Standalone ARM64 app: ${identity.packageName}. The JavaScript bundle is embedded.`);
console.log('Both local prototypes use the preserved development signing key. Use a private release key before production distribution.');
