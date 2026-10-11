const { getDefaultConfig } = require('expo/metro-config');

/**
 * whisper.rn pulls in `safe-buffer`, which does `require('buffer')` — a Node
 * core module the RN runtime doesn't have. The `buffer` npm package is the
 * standard browser/RN-safe polyfill for it; aliasing it here is the
 * documented fix (https://docs.expo.dev/workflow/using-libraries/) for any
 * dependency that reaches for Node core modules.
 */
const config = getDefaultConfig(__dirname);
config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  buffer: require.resolve('buffer'),
};

module.exports = config;
