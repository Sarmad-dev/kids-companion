import { Canvas, useFrame } from '@react-three/fiber/native';
import { useMemo } from 'react';
import { View } from 'react-native';
import * as THREE from 'three';

import type { TalkState } from '../hooks/recorder-machine';
import { useReducedMotion } from '../hooks/reduced-motion';
import { DEFAULT_CHARACTER, isCharacterSlug, type CharacterSlug } from '../theme/child-theme';

import type { ActionRequest } from './actions';
import {
  CharacterWash,
  type DioramaProps,
  FlatStage,
  type Framing,
  GROUND_LIGHT,
  meshBounds,
  type OrbitState,
  StageBoundary,
  StageCamera,
  StageLights,
  styles,
  useDioramaOrbit,
} from './Diorama';
import { moodFor } from './moods';
import { buildCharacter, buildContactShadow, buildSet } from './procedural-cast';
import { useResolvedRigMood } from './useDioramaMood';

/**
 * The conversation screen's diorama, rendered from the Claude Design project
 * rather than from a Blender `.glb`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY A SEPARATE COMPONENT FROM `Diorama`
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The character preview screen (`app/(child)/character/[slug].tsx`) still
 * shows the Blender cast via `Diorama` — that screen was not part of this
 * change. This component is a drop-in replacement for `Diorama` on the
 * conversation screen ONLY: same props, same camera feel, same gesture rules,
 * same flat-mode fallback, built instead from `procedural-cast.ts` — a direct
 * port of the design's own `diorama.js`. The camera math, the orbit gesture,
 * the wash, the loading/fallback screens and the error boundary are the exact
 * same code as `Diorama`, imported rather than re-implemented, so the two
 * stages feel identical to a child's thumb even though one loads a file and
 * the other builds its geometry in code.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE FIXED LOOK DIRECTION
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `<kc-diorama>` has no per-character hero camera — every character starts
 * the child's orbit at the same fixed angle (az 0.32 rad, el 0.20 rad, the
 * same numbers `freshOrbit` already seeds the camera with). `DEFAULT_DIRECTION`
 * below is that angle expressed as a look direction, purely so it can flow
 * through the same `StageCamera` the `.glb` stage uses — which derives its
 * starting az/el from a direction vector — without giving that shared
 * component a second, procedural-only code path.
 */
const KEY_LIGHT_POSITION: readonly [number, number, number] = [2.6, 3.6, 2.4];
const FILL_LIGHT_POSITION: readonly [number, number, number] = [-3.0, 1.4, 1.8];
const RIM_LIGHT_POSITION: readonly [number, number, number] = [-1.2, 2.2, -3.2];

const DEFAULT_DIRECTION = new THREE.Vector3(
  Math.sin(0.32),
  Math.sin(0.2),
  Math.cos(0.32),
).normalize();

/** Frames the character alone — the set is built around it, not measured for it. */
const measureCharacter = (characterGroup: THREE.Group, sceneRoot: THREE.Group): Framing => {
  sceneRoot.updateMatrixWorld(true);
  const character = meshBounds(characterGroup);
  const whole = meshBounds(sceneRoot);

  const centre = character.getCenter(new THREE.Vector3());
  const size = character.getSize(new THREE.Vector3());
  // Aim a little above the middle of the character — see `Diorama.tsx`'s `measure`.
  centre.y = character.min.y + size.y * 0.58;

  const sceneRadius = whole.isEmpty()
    ? Math.max(size.length(), 1)
    : Math.max(whole.getBoundingSphere(new THREE.Sphere()).radius, 1);

  return { centre, direction: DEFAULT_DIRECTION.clone(), size, sceneRadius };
};

const ProceduralStage = ({
  slug,
  talkState,
  still,
  orbit,
  action,
}: {
  slug: CharacterSlug;
  action?: ActionRequest | undefined;
  talkState: TalkState;
  still: boolean;
  orbit: React.RefObject<OrbitState>;
}) => {
  const { group: characterGroup, parts } = useMemo(() => buildCharacter(slug), [slug]);
  const setGroup = useMemo(() => buildSet(slug), [slug]);

  const { root, shadow } = useMemo(() => {
    const g = new THREE.Group();
    g.add(setGroup);
    g.add(characterGroup);
    const size = meshBounds(characterGroup).getSize(new THREE.Vector3());
    const contact = buildContactShadow(Math.max(size.x, size.z) * 0.85);
    g.add(contact);
    return { root: g, shadow: contact };
  }, [characterGroup, setGroup]);

  /* The framing is measured ONCE, from the character at rest. Re-measuring it
   * as the character drifts would move the camera with it, which cancels the
   * drift exactly — the character would look pinned to the middle of the frame
   * while the whole set slid about behind it. */
  const framing = useMemo(() => measureCharacter(characterGroup, root), [characterGroup, root]);
  const ground = GROUND_LIGHT[slug] ?? GROUND_LIGHT['buddy-the-dog'] ?? '#8fc46b';

  useResolvedRigMood(parts, moodFor(talkState), still, action);

  /* The shadow is a SIBLING of the character, not a child of it: parented, it
   * would rise with Lily, Nano and Mira as they hover, and a shadow that
   * leaves the ground stops being a shadow. So it tracks x and z only, and its
   * own y never changes. */
  useFrame(() => {
    shadow.position.x = characterGroup.position.x;
    shadow.position.z = characterGroup.position.z;
  });

  return (
    <>
      <StageCamera framing={framing} orbit={orbit} />
      <StageLights
        keyPosition={KEY_LIGHT_POSITION}
        fillPosition={FILL_LIGHT_POSITION}
        rimPosition={RIM_LIGHT_POSITION}
        groundColor={ground}
      />
      <primitive object={root} />
    </>
  );
};

export const ProceduralDiorama = ({
  slug,
  talkState,
  flat = false,
  interactive = true,
  action,
  onPoke,
  testID,
}: DioramaProps) => {
  const reduced = useReducedMotion();
  const { orbit, panHandlers } = useDioramaOrbit(slug, interactive, onPoke);
  const characterSlug = isCharacterSlug(slug) ? slug : DEFAULT_CHARACTER;

  if (flat) return <FlatStage slug={slug} loading={false} />;

  return (
    <View style={styles.stage} testID={testID} {...panHandlers}>
      <CharacterWash slug={slug} />
      <StageBoundary slug={slug}>
        <Canvas style={styles.canvas} gl={{ alpha: true, antialias: true }}>
          <ProceduralStage
            slug={characterSlug}
            talkState={talkState}
            still={reduced}
            orbit={orbit}
            action={action}
          />
        </Canvas>
      </StageBoundary>
    </View>
  );
};
