import { useFrame } from '@react-three/fiber/native';
import { useMemo, useRef } from 'react';
import type * as THREE from 'three';

import type { CharacterRig } from './character-rig';
import { BLINK_SECONDS, MOODS, MOUTH_ENVELOPE_HZ, MOUTH_HZ, type Mood } from './moods';

/**
 * Drives one character rig from one mood, every frame.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS A PER-FRAME POSE FUNCTION AND NOT A TWEEN LIBRARY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This replaced a GSAP timeline that built and tore down two dozen tweens on
 * every mood change. That worked, but it made the character's motion a function
 * of WHEN a tween was created rather than of what the mood is: a child who
 * tapped twice in a second got two overlapping breath loops, and a mood change
 * mid-breath landed the chest wherever the interpolation happened to be.
 *
 * Here, every property is a pure function of `(mood, elapsed)`. A mood change
 * takes effect on the next frame with no teardown, no baseline snapshotting and
 * no possibility of two loops fighting over one bone — because there are no
 * loops at all, only a formula evaluated once per frame. It also removes the
 * whole GSAP dependency from the app.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY REST VALUES ARE CAPTURED, NOT ASSUMED TO BE ZERO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The `.glb` rigs are posed: Buddy's ears sit at ±0.30 rad, Lily's wings at
 * ±0.3 rad, arms at ±0.28. Writing an absolute rotation onto those would snap
 * them to a pose the artist never drew. Every offset below is applied relative
 * to a rest value read once, on the first frame the node exists.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * REDUCE MOTION HOLDS EACH MOOD AS A POSE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Not "no animation" — a frozen T-pose would lose the lean-in that carries
 * "I am listening". Time is pinned instead, and each cyclic term collapses to a
 * representative constant, so the character still leans in, still tilts to
 * think, and still holds its mouth open while speaking. It simply does not move.
 */

const TWO_PI = Math.PI * 2;

/**
 * Every node this controller may touch, resolved once per model.
 *
 * Exported so a rig built procedurally (rather than loaded from a `.glb` and
 * resolved by name — see `resolveNodes` below) can hand this same shape to
 * `useResolvedRigMood` directly, with no name lookup in between.
 */
export interface RigNodes {
  /* `| undefined` rather than `?`: every field is always PRESENT and often
   * empty, because a rig either has a tail or does not and the resolver says
   * which either way. Optional properties would additionally allow "we forgot
   * to look", which is not a state this can be in. */
  readonly chest: THREE.Object3D | undefined;
  readonly head: THREE.Object3D | undefined;
  readonly brows: readonly THREE.Object3D[];
  readonly eyes: readonly THREE.Object3D[];
  readonly mouth: THREE.Object3D | undefined;
  /** Ears, arms, legs — anything that swings on the limb period. */
  readonly limbs: readonly THREE.Object3D[];
  /** Wings and ear tufts, which mirror rather than alternate. */
  readonly wings: readonly THREE.Object3D[];
  readonly tail: THREE.Object3D | undefined;
  readonly root: THREE.Object3D | undefined;
  /** Whether the mouth node hinges (a beak) or scales (a drawn line). */
  readonly mouthHinges: boolean;
  /** Lily hovers rather than stands. */
  readonly hovers: boolean;
}

interface RestPose {
  chestY: number;
  chestScale: THREE.Vector3;
  headRotation: THREE.Euler;
  browY: number[];
  browRotX: number[];
  limbRotX: number[];
  wingRotZ: number[];
  tailRotY: number;
  mouthRotX: number;
  mouthScaleY: number;
  rootY: number;
  rootX: number;
  rootZ: number;
  rootRotY: number;
}

const pick = (
  nodes: Readonly<Record<string, THREE.Object3D>>,
  name: string | undefined,
): THREE.Object3D | undefined => (name === undefined ? undefined : nodes[name]);

const pickAll = (
  nodes: Readonly<Record<string, THREE.Object3D>>,
  names: readonly (string | undefined)[],
): THREE.Object3D[] =>
  names
    .map((name) => pick(nodes, name))
    .filter((node): node is THREE.Object3D => node !== undefined);

const resolveNodes = (
  nodes: Readonly<Record<string, THREE.Object3D>>,
  rig: CharacterRig,
): RigNodes => ({
  chest: pick(nodes, rig.spine) ?? pick(nodes, rig.neck),
  head: pick(nodes, rig.head),
  brows: pickAll(nodes, [rig.browLeft, rig.browRight]),
  /* Each eye is several sibling nodes — sclera, iris, pupil, highlight —
   * exported flat rather than parented, so a blink has to squash all of them in
   * lock-step or the iris is left floating in mid-air. */
  eyes: pickAll(nodes, [...(rig.eyesLeft ?? []), ...(rig.eyesRight ?? [])]),
  mouth: pick(nodes, rig.mouth),
  limbs: pickAll(nodes, [
    rig.earLeft,
    rig.earRight,
    rig.armUpperLeft,
    rig.armUpperRight,
    rig.armLowerLeft,
    rig.armLowerRight,
    ...(rig.legs ?? []),
  ]),
  wings: pickAll(nodes, [rig.wingLeft, rig.wingRight]),
  tail: pick(nodes, rig.tail),
  root: pick(nodes, rig.root),
  mouthHinges: rig.mouthHinges === true,
  hovers: rig.hovers === true,
});

export const useDioramaMood = (
  nodes: Readonly<Record<string, THREE.Object3D>>,
  rig: CharacterRig,
  mood: Mood,
  still: boolean,
): void => {
  const resolved = useMemo(() => resolveNodes(nodes, rig), [nodes, rig]);
  useResolvedRigMood(resolved, mood, still);
};

/**
 * Drives an already-resolved rig from one mood, every frame.
 *
 * This is the per-frame half of `useDioramaMood`, split out so a procedurally
 * built rig — which already holds direct object references and has no names
 * to resolve — can be driven by the exact same formulas rather than a second,
 * drifting copy of them.
 */
export const useResolvedRigMood = (rig: RigNodes, mood: Mood, still: boolean): void => {
  // Aliased rather than mutated-through-directly: the nodes below are mutated
  // every frame, and `no-param-reassign` reads any assignment through `rig`
  // itself as reassigning the parameter.
  const resolved = rig;

  /** Captured on the first frame, so a posed rig is never snapped to zero. */
  const rest = useRef<RestPose | undefined>(undefined);
  const clock = useRef({ t: 0, nextBlink: 1.5, blink: 0 });

  useFrame((_state, rawDelta) => {
    // A backgrounded app hands back one enormous delta on resume. Capped, so
    // the character does not teleport through half a breath on the way back.
    const delta = Math.min(rawDelta, 0.1);
    const M = MOODS[mood];
    const c = clock.current;

    rest.current ??= {
      chestY: resolved.chest?.position.y ?? 0,
      chestScale: resolved.chest?.scale.clone() ?? ({ x: 1, y: 1, z: 1 } as THREE.Vector3),
      headRotation: resolved.head?.rotation.clone() ?? ({ x: 0, y: 0, z: 0 } as THREE.Euler),
      browY: resolved.brows.map((b) => b.position.y),
      browRotX: resolved.brows.map((b) => b.rotation.x),
      limbRotX: resolved.limbs.map((l) => l.rotation.x),
      wingRotZ: resolved.wings.map((w) => w.rotation.z),
      tailRotY: resolved.tail?.rotation.y ?? 0,
      mouthRotX: resolved.mouth?.rotation.x ?? 0,
      mouthScaleY: resolved.mouth?.scale.y ?? 1,
      rootY: resolved.root?.position.y ?? 0,
      rootX: resolved.root?.position.x ?? 0,
      rootZ: resolved.root?.position.z ?? 0,
      rootRotY: resolved.root?.rotation.y ?? 0,
    };
    const R = rest.current;

    if (!still) c.t += delta;
    const t = still ? 0 : c.t;

    /* ---- chest: one breath ------------------------------------------------ */
    // Held mid-inhale under Reduce Motion rather than at either extreme: a
    // character frozen fully deflated reads as unwell.
    const breath = still ? 0.4 : (Math.sin(t * (TWO_PI / M.breathPeriod)) + 1) / 2;
    if (resolved.chest) {
      const swell = M.breathAmount * breath;
      resolved.chest.scale.set(
        R.chestScale.x * (1 + swell * 0.8),
        R.chestScale.y * (1 + swell),
        R.chestScale.z * (1 + swell * 0.8),
      );
      resolved.chest.position.y = R.chestY + swell * 0.35;
    }

    /* ---- head: sway, tilt, turn, and the talking bob ---------------------- */
    if (resolved.head) {
      const sway = still ? 0.35 : Math.sin(t * (TWO_PI / M.swayPeriod));
      const bob = !still && M.bobPeriod > 0 ? Math.sin(t * (TWO_PI / M.bobPeriod)) * 0.05 : 0;
      resolved.head.rotation.z = R.headRotation.z + sway * M.swayAmount * 0.35;
      resolved.head.rotation.x = R.headRotation.x + M.tilt * 0.6 + bob;
      resolved.head.rotation.y =
        R.headRotation.y + M.turn * (still ? 1 : 0.6 + 0.4 * Math.sin(t * 0.7));
    }

    /* ---- brows: held, not animated. A lowered brow also rotates. ---------- */
    for (let i = 0; i < resolved.brows.length; i += 1) {
      const brow = resolved.brows[i];
      if (brow === undefined) continue;
      brow.position.y = (R.browY[i] ?? 0) + M.brow;
      brow.rotation.x = (R.browRotX[i] ?? 0) + (M.brow < 0 ? 0.35 : 0);
    }

    /* ---- blink ------------------------------------------------------------ */
    if (!still) {
      c.nextBlink -= delta;
      if (c.nextBlink <= 0) {
        c.blink = BLINK_SECONDS;
        // Jittered, so two characters on screen never blink in unison and one
        // character never becomes metronomic.
        c.nextBlink = M.blinkPeriod * (0.7 + Math.random() * 0.6);
      }
      if (c.blink > 0) c.blink -= delta;
    }
    const lid =
      !still && c.blink > 0
        ? Math.max(0.08, 1 - Math.sin(((BLINK_SECONDS - c.blink) / BLINK_SECONDS) * Math.PI) * 0.95)
        : 1;
    for (const eye of resolved.eyes) {
      eye.scale.y = lid;
    }

    /* ---- mouth ------------------------------------------------------------ */
    if (resolved.mouth) {
      /* Two terms, not one: the fast one is the syllable, the slow one is how
       * much of it is said. See MOUTH_ENVELOPE_HZ. Floored at 0.35 so the mouth
       * never fully stops mid-sentence, which would read as the audio cutting
       * out rather than as an unstressed syllable. */
      const stress = 0.35 + 0.65 * Math.abs(Math.sin(t * MOUTH_ENVELOPE_HZ));
      if (resolved.mouthHinges) {
        resolved.mouth.rotation.x = M.mouth
          ? R.mouthRotX +
            (still ? 0.28 : 0.1 + 0.42 * stress * Math.abs(Math.sin(t * (MOUTH_HZ + 0.4))))
          : R.mouthRotX + 0.02;
      } else {
        const open = M.mouth
          ? still
            ? 2.1
            : 1 + 3.0 * stress * Math.abs(Math.sin(t * MOUTH_HZ))
          : 1;
        resolved.mouth.scale.y = R.mouthScaleY * open;
      }
    }

    /* ---- limbs, wings, tail ----------------------------------------------- */
    for (let i = 0; i < resolved.limbs.length; i += 1) {
      const limb = resolved.limbs[i];
      if (limb === undefined) continue;
      limb.rotation.x =
        (R.limbRotX[i] ?? 0) +
        (still
          ? M.limb * 0.3
          : // Phase-offset per limb, so four legs do not move as one plank.
            Math.sin(t * (TWO_PI / M.limbPeriod) + i * 1.7) * M.limb * 0.55);
    }

    for (let i = 0; i < resolved.wings.length; i += 1) {
      const wing = resolved.wings[i];
      if (wing === undefined) continue;
      // Wings mirror rather than alternate: both go up together, or the
      // character looks like it is rowing.
      const mirror = i % 2 === 0 ? -1 : 1;
      wing.rotation.z =
        (R.wingRotZ[i] ?? 0) +
        (still
          ? M.limb * 0.25 * mirror
          : Math.sin(t * (TWO_PI / M.limbPeriod) + i) * M.limb * 0.5 * mirror);
    }

    if (resolved.tail) {
      resolved.tail.rotation.y =
        R.tailRotY +
        (still
          ? 0.2
          : // A wag is twice the limb rate and much wider — it is the one part
            // of a dog that a child watches for.
            Math.sin(t * (TWO_PI / Math.max(0.5, M.limbPeriod * 0.5))) * M.limb * 1.6);
    }

    /* ---- the whole character, drifting around its spot ------------------- */
    if (resolved.root) {
      if (still) {
        // Reduce Motion holds the POSE, so the drift collapses to its own
        // starting value rather than to a different place every mood change.
        resolved.root.position.x = R.rootX;
        resolved.root.position.z = R.rootZ;
        resolved.root.rotation.y = R.rootRotY;
      } else {
        const period = Math.max(0.5, M.wanderPeriod);
        // Two incommensurate periods on x and z, so the path is a slow figure
        // rather than a line the character paces back and forth along.
        const phase = t * (TWO_PI / period);
        resolved.root.position.x = R.rootX + Math.sin(phase) * M.wander;
        resolved.root.position.z = R.rootZ + Math.sin(phase * 0.61 + 1.1) * M.wander * 0.55;
        // It turns to follow where it is going, at a fraction of the angle —
        // enough to read as intent, not enough to ever show the child a back.
        resolved.root.rotation.y = R.rootRotY + Math.sin(phase + 0.5) * M.wander * 1.6;
      }
    }

    if (resolved.hovers && resolved.root) {
      resolved.root.position.y = R.rootY + (still ? 0.02 : 0.03 + Math.sin(t * 0.9) * 0.035);
    }
  });
};
