import { Asset } from 'expo-asset';
import { suspend } from 'suspend-react';

/**
 * Resolves a bundled `.glb` (a Metro asset module id) to a URI `useGLTF` can
 * actually fetch.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS INDIRECTION EXISTS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `useGLTF` (from `@react-three/drei/native`) takes a URL, not a Metro module
 * id — it hands whatever string it is given straight to three's `GLTFLoader`,
 * which fetches it. In development that module id resolves to an HTTP URL the
 * Metro dev server happens to be serving, which works by accident. In a
 * standalone build there is no dev server: the asset is embedded in the app
 * bundle, and `Asset.fromModule(id).uri` alone is not guaranteed to be
 * fetchable until `downloadAsync()` has run once, which is what actually
 * copies (or locates) the file and populates `localUri`.
 *
 * Suspense rather than a loading flag: this hook is called from inside a
 * component already wrapped in `<Suspense>` for `useGLTF` itself (which
 * suspends the same way), so the character model and its own asset
 * resolution share one fallback instead of the caller juggling two.
 *
 * Cached by `suspend-react` on the module id, so re-mounting the same
 * character (switching screens, coming back to `ConversationScreen`) does not
 * re-download an asset already on disk.
 */
export const useLocalGlbUri = (assetModuleId: number): string =>
  suspend(
    async (moduleId: number): Promise<string> => {
      const asset = Asset.fromModule(moduleId);
      if (asset.localUri === null) {
        // Mutates `asset.localUri` as a side effect — read fresh below rather
        // than in an early-return branch, so TypeScript does not carry the
        // narrowing from this check past a call it cannot see the effect of.
        await asset.downloadAsync();
      }
      return asset.localUri ?? asset.uri;
    },
    [assetModuleId],
  );
