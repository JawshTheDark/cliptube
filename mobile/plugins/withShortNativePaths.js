// Windows builds: CMake names object files after their full source path, and for sources outside a module's
// CMake folder (react-native-gesture-handler, reanimated, worklets...) that path is nested inside the build
// folder, passing Windows' 260-character limit. CMAKE_OBJECT_PATH_MAX makes CMake shorten such names with a
// hash. Android builds never set it (the default is 1000), so this sets it for every native module.
// It goes in settings.gradle so the hook is in place before any module is configured.
const { withSettingsGradle } = require('expo/config-plugins');

const MARK = '// cliptube: short native object paths on Windows';
const BLOCK = `
${MARK}
if (System.getProperty('os.name').toLowerCase().contains('windows')) {
  gradle.beforeProject { p ->
    ['com.android.library', 'com.android.application'].each { id ->
      p.plugins.withId(id) {
        p.androidComponents.finalizeDsl { ext ->
          ext.defaultConfig.externalNativeBuild.cmake.arguments.add('-DCMAKE_OBJECT_PATH_MAX=250')
        }
      }
    }
  }
}
`;

module.exports = function withShortNativePaths(config) {
  return withSettingsGradle(config, (cfg) => {
    if (!cfg.modResults.contents.includes(MARK)) cfg.modResults.contents += BLOCK;
    return cfg;
  });
};
