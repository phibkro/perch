#!/usr/bin/env bash
set -euo pipefail

# Only the ephemeral runner's Gradle user home and SDK are configured here.
# The checked-in native project, HOME, and signing material are untouched.
: "${ANDROID_HOME:?GitHub runner must provide ANDROID_HOME}"
: "${JAVA_HOME_17_X64:?Install Temurin 17 before configuring Gradle}"
: "${JAVA_HOME_21_X64:?Install Temurin 21 before configuring Gradle}"
perch_gradle_home="${GRADLE_USER_HOME:-$HOME/.gradle}"
perch_sdkmanager="$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager"
test -x "$perch_sdkmanager"
mkdir -p "$perch_gradle_home/init.d"
cat > "$perch_gradle_home/gradle.properties" <<'PROPERTIES'
org.gradle.jvmargs=-Xmx2048m -XX:MaxMetaspaceSize=1024m
kotlin.daemon.jvmargs=-Xmx1536m -XX:MaxMetaspaceSize=768m
org.gradle.parallel=false
org.gradle.workers.max=2
org.gradle.caching=true
org.gradle.java.installations.fromEnv=JAVA_HOME_17_X64,JAVA_HOME_21_X64
org.gradle.java.installations.auto-download=false
android.cmakeVersion=3.22.1
PROPERTIES
cp .github/gradle/perch-cmake-limits.gradle "$perch_gradle_home/init.d/perch-cmake-limits.gradle"

# sdkmanager can close stdin after accepting licenses; ignore only yes's SIGPIPE.
set +o pipefail
yes | "$perch_sdkmanager" --licenses > /dev/null
set -o pipefail
"$perch_sdkmanager" --install --channel=0 \
  'platform-tools' \
  'platforms;android-36' \
  'build-tools;35.0.0' \
  'build-tools;36.0.0' \
  'ndk;27.1.12297006' \
  'cmake;3.22.1'

"$JAVA_HOME_21_X64/bin/java" -version
"$JAVA_HOME_17_X64/bin/java" -version
"$ANDROID_HOME/cmake/3.22.1/bin/cmake" --version
