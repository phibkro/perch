import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const toolingRoot = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.dirname(toolingRoot);
export function developmentEnvironment() {
  const localPath = path.join(toolingRoot, 'local.json');
  const local = fs.existsSync(localPath) ? JSON.parse(fs.readFileSync(localPath, 'utf8')) : {};
  const env = { ...process.env };
  env.MAESTRO_CLI_NO_ANALYTICS ||= "1";
  env.MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED ||= "true";
  env.EXPO_NO_TELEMETRY ||= "1";
  env.DO_NOT_TRACK ||= "1";
  env.JAVA_HOME ||= local.javaHome;
  env.ANDROID_HOME ||= env.ANDROID_SDK_ROOT || local.androidHome;
  env.ANDROID_SDK_ROOT ||= env.ANDROID_HOME;
  env.GRADLE_USER_HOME ||= local.gradleUserHome;
  env.PATH = [env.JAVA_HOME && path.join(env.JAVA_HOME, 'bin'), env.ANDROID_HOME && path.join(env.ANDROID_HOME, 'platform-tools'), env.PATH].filter(Boolean).join(path.delimiter);
  if (local.javaTrustStore && !env.JAVA_TOOL_OPTIONS?.includes('-Djavax.net.ssl.trustStore=')) {
    env.JAVA_TOOL_OPTIONS = [env.JAVA_TOOL_OPTIONS, `-Djavax.net.ssl.trustStore=${local.javaTrustStore}`, '-Djavax.net.ssl.trustStorePassword=changeit'].filter(Boolean).join(' ');
  }
  if (local.useEnvironmentProxyForGradle && env.HTTPS_PROXY) {
    const proxy = new URL(env.HTTPS_PROXY);
    if (proxy.username || proxy.password) throw new Error('Authenticated Gradle proxies must be configured outside the project launcher.');
    const port = proxy.port || (proxy.protocol === 'https:' ? '443' : '80');
    env.GRADLE_OPTS = [env.GRADLE_OPTS, `-Dhttps.proxyHost=${proxy.hostname}`, `-Dhttps.proxyPort=${port}`, `-Dhttp.proxyHost=${proxy.hostname}`, `-Dhttp.proxyPort=${port}`].filter(Boolean).join(' ');
  }
  return Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined));
}
