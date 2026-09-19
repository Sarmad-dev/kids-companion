import { hasBundledModel } from './character-rig';
import { Diorama, type DioramaProps } from './Diorama';
import { ProceduralDiorama } from './ProceduralDiorama';

/**
 * One character's stage, whichever kind of character it is.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THERE ARE TWO KINDS AT ALL
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Buddy, Lily, Sky and Owl ship as `.glb` dioramas an artist built in Blender.
 * Pip, Nano, Mira, Zia and Dada Jee are built from primitives at runtime by
 * `procedural-cast.ts`. Both render through the same camera, the same lights,
 * the same orbit gesture, the same wash and the same flat fallback — the only
 * difference is where the geometry comes from.
 *
 * Without this component the choice is made by `characterDefinitionFor`, which
 * falls back to Buddy for a slug it does not recognise. That is the right
 * answer for a mistyped route param and the wrong one for Pip: a child who
 * chose the fox would meet the dog, and nothing anywhere would report it.
 *
 * `Diorama` and `ProceduralDiorama` both remain exported and directly usable —
 * the conversation screen goes straight to `ProceduralDiorama` because it is
 * the design's own scene and never wants the `.glb` one. This is for the
 * screens that render WHATEVER the child picked.
 */
export const CharacterStage = (props: DioramaProps) =>
  hasBundledModel(props.slug) ? <Diorama {...props} /> : <ProceduralDiorama {...props} />;
