const { withAppBuildGradle } = require('expo/config-plugins');

// Keep debug installs beside the standalone Perch app, including after prebuild.
module.exports = function withPerchDevelopment(config) {
  return withAppBuildGradle(config, (config) => {
    if (config.modResults.language !== 'groovy') throw new Error('Perch development plugin expects Groovy app/build.gradle.');
    const marker = '// Perch development identity';
    if (!config.modResults.contents.includes(marker)) {
      const target = /(buildTypes\s*\{\s*debug\s*\{)/;
      if (!target.test(config.modResults.contents)) throw new Error('Perch could not locate the Android debug build type.');
      config.modResults.contents = config.modResults.contents.replace(target, `$1\n            ${marker}\n            applicationIdSuffix ".dev"\n            versionNameSuffix "-dev"`);
    }
    return config;
  });
};
