import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { projectRoot, developmentEnvironment } from '../tooling/environment.mjs';

function findAapt2(env) {
  // Keep the launcher's environment/local.json precedence. Gradle's generated
  // local.properties also supports SDK installs without environment variables.
  let sdk = env.ANDROID_HOME || env.ANDROID_SDK_ROOT;
  const propertiesPath = path.join(projectRoot, 'android', 'local.properties');
  if (!sdk && existsSync(propertiesPath)) {
    const value = readFileSync(propertiesPath, 'utf8').match(/^\s*sdk\.dir\s*[:=]\s*(.*?)\s*$/m)?.[1];
    if (value) {
      const unescaped = value.replace(/\\u([\da-fA-F]{4})|\\(.)/g, (_match, unicode, character) => unicode ? String.fromCharCode(parseInt(unicode, 16)) : character);
      sdk = path.resolve(projectRoot, 'android', unescaped);
    }
  }
  if (!sdk) throw new Error('Cannot verify APK: configure ANDROID_HOME, ANDROID_SDK_ROOT, tooling/local.json androidHome, or android/local.properties sdk.dir.');
  const buildTools = path.resolve(projectRoot, sdk, 'build-tools');
  const executable = process.platform === 'win32' ? 'aapt2.exe' : 'aapt2';
  const versions = existsSync(buildTools) ? readdirSync(buildTools, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name) : [];
  const aapt2 = versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).map(version => path.join(buildTools, version, executable)).find(existsSync);
  if (!aapt2) throw new Error(`Cannot verify APK: no aapt2 found in ${buildTools}. Install Android SDK Build Tools for the configured SDK.`);
  return aapt2;
}

/** Verify the final binary, not Gradle's potentially stale output metadata. */
export function verifyAndroidApk(apkPath, { development = false, env = developmentEnvironment() } = {}) {
  const { expo } = JSON.parse(readFileSync(path.join(projectRoot, 'app.json'), 'utf8'));
  if (!expo?.android?.package || !expo.version || !Number.isInteger(expo.android.versionCode)) {
    throw new Error('Cannot verify APK: app.json must declare expo.android.package, expo.version, and expo.android.versionCode.');
  }
  const expected = {
    packageName: `${expo.android.package}${development ? '.dev' : ''}`,
    versionName: `${expo.version}${development ? '-dev' : ''}`,
    versionCode: String(expo.android.versionCode),
  };
  if (!existsSync(apkPath)) throw new Error(`Cannot verify APK: output does not exist: ${apkPath}`);
  const result = spawnSync(findAapt2(env), ['dump', 'badging', apkPath], { cwd: projectRoot, env, encoding: 'utf8' });
  if (result.error) throw new Error(`Cannot inspect APK with aapt2: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`Cannot inspect APK with aapt2 (exit ${result.status}): ${result.stderr.trim()}`);
  const packageLine = result.stdout.match(/^package: (.+)$/m)?.[1];
  const fields = Object.fromEntries([...(packageLine || '').matchAll(/\b(name|versionName|versionCode)='([^']*)'/g)].map(match => [match[1], match[2]]));
  const actual = { packageName: fields.name, versionName: fields.versionName, versionCode: fields.versionCode };
  const mismatches = Object.keys(expected).filter(key => actual[key] !== expected[key]);
  if (mismatches.length) {
    throw new Error(`APK identity mismatch: ${apkPath}\n${mismatches.map(key => `  ${key}: expected ${expected[key]}, found ${actual[key] ?? '(missing)'}`).join('\n')}\nThe binary does not match app.json and must not be used as this build. Inspect stale Android build outputs before retrying.`);
  }
  return actual;
}
