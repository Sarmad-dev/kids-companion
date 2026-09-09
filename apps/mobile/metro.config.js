// Learn more: https://docs.expo.dev/guides/monorepos/
const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// Watch the whole workspace so edits to @kids/ui and @kids/types trigger a
// rebuild rather than serving a stale bundle.
config.watchFolders = [workspaceRoot];

// Resolve from the app first, then the workspace root.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

// Do not walk further up the filesystem looking for modules.
config.resolver.disableHierarchicalLookup = true;

// Metro's default asset list has no notion of 3D models. Without this, a
// `require('./assets/models/*.glb')` fails to resolve at all — the character
// scenes need these treated as opaque binary assets, same as an image.
config.resolver.assetExts = [...config.resolver.assetExts, 'glb', 'gltf', 'bin'];

// Ensure a single instance of three is resolved across dependencies,
// avoiding dual-instantiation from ESM/CJS package exports.
const threeCjsPath = path.resolve(workspaceRoot, 'node_modules/three/build/three.cjs');

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === 'three') {
    return {
      filePath: threeCjsPath,
      type: 'sourceFile',
    };
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
