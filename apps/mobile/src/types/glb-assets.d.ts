/**
 * `.glb` files are bundled by Metro exactly like images — see the added
 * `assetExts` entry in `metro.config.js`. Metro resolves `import model from
 * './x.glb'` to a numeric asset module id, the same shape it gives a `.png`.
 */
declare module '*.glb' {
  const assetModuleId: number;
  export default assetModuleId;
}

/** The background-music loop; `wav` is already one of Metro's default asset extensions. */
declare module '*.wav' {
  const assetModuleId: number;
  export default assetModuleId;
}
