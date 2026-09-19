import { useGLTF } from '@react-three/drei/native';
import { Canvas, useFrame, useThree } from '@react-three/fiber/native';
import { Component, Suspense, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { Animated, Easing, PanResponder, StyleSheet, View } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import * as THREE from 'three';

import { Avatar, Float } from '../components/child/index';
import type { TalkState } from '../hooks/recorder-machine';
import { useReducedMotion } from '../hooks/reduced-motion';
import { castMember } from '../theme/child-theme';

import { characterDefinitionFor, type CharacterRig } from './character-rig';
import { moodFor } from './moods';
import { useDioramaMood } from './useDioramaMood';
import { useLocalGlbUri } from './useLocalGlbUri';

/**
 * The conversation screen's 3D diorama.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE DIORAMA IS THE SCREEN, NOT A PICTURE ON IT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * It runs full-bleed, edge to edge, behind the status bar, and the talk button
 * and speech bubble float on top of it. Everything that is not a button lets a
 * drag through to the canvas, so a child can spin the character by dragging
 * anywhere — which is the first thing every child tries.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT IS IN EACH `.glb`, AND WHY THAT MATTERS HERE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Each file is a whole set, not a character on a plinth: Buddy's yard with its
 * fence, flowers and doghouse; Lily's glade with mushrooms, fireflies and a
 * pond; Sky's platform with a rocket, a telescope and fourteen stars; Owl's
 * study with two bookshelves, a globe and a chalkboard. Plus a hero camera and
 * three light markers, as named empty transforms.
 *
 * None of them carries an animation clip. Everything that moves is driven at
 * runtime from the mood table — see `useDioramaMood` — which is what lets the
 * character's body carry the latency instead of a spinner.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THE CAMERA IS COMPUTED AND THE ARTIST'S IS NOT ADOPTED WHOLESALE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every hero camera was framed at 16:9 landscape with a ~21° vertical field of
 * view, 1.7–3.6 units from a character barely 1.2 units tall. Taking that
 * camera and overwriting `aspect` with a phone's ~0.46 keeps the vertical
 * framing and crops the horizontal to a slit — the whole set is still there,
 * just outside the frustum. So the hero camera is used for the one thing it is
 * genuinely authoritative about, the DIRECTION the artist chose to look from,
 * and the distance is fitted per device from the character's measured bounds.
 */

/* The three-point rig, art-directed once here rather than guessed per model:
 * the `_KeyLight` / `_FillLight` / `_RimLight` nodes in the files are plain
 * empties an artist placed by eye and carry no light data of their own. */
const KEY_LIGHT = '#fff3d6';
const FILL_LIGHT = '#cfe3ff';
const RIM_LIGHT = '#e8f1ff';
const SKY_LIGHT = '#fff6e5';

/** The bounce colour under each set — grass, moss, hull plating, floorboards. */
export const GROUND_LIGHT: Readonly<Record<string, string>> = {
  'buddy-the-dog': '#8fc46b',
  'lily-the-fairy': '#77b48a',
  'captain-sky': '#8d9bb5',
  'professor-owl': '#a97f57',
  /* Autumn meadow, workshop concrete, night cloud, river grass, courtyard
   * earth. Each one is the colour the set's own floor already is, so bounce
   * light reads as coming from the place rather than from a studio. */
  'pip-the-fox': '#c9a64a',
  'nano-the-robot': '#9aa3ad',
  'mira-the-moon': '#8f97d6',
  'captain-zia': '#6f8f4a',
  'dada-jee': '#b08a63',
};

export const STAGE_FOV = 50;
/** The character's own height, as a fraction of the viewport, once framed. */
const HEIGHT_FRACTION = 0.36;
/** Its width — the binding constraint on a tablet. */
const WIDTH_FRACTION = 0.52;
export const MIN_ZOOM = 0.45;
export const MAX_ZOOM = 3;
/** Never below the horizon, and never straight down onto the character's head. */
export const MIN_ELEVATION = 0.03;
export const MAX_ELEVATION = 1.02;
/** Radians of yaw per point dragged, and of elevation per point. */
export const YAW_PER_POINT = 0.008;
export const PITCH_PER_POINT = 0.005;

export interface OrbitState {
  az: number;
  el: number;
  zoom: number;
  targetAz: number;
  targetEl: number;
  targetZoom: number;
  pinchDistance: number;
  /** Whether the child has moved the camera. Stops a re-measure resetting them. */
  touched: boolean;
}

export const freshOrbit = (): OrbitState => ({
  az: 0.32,
  el: 0.2,
  zoom: 1,
  targetAz: 0.32,
  targetEl: 0.2,
  targetZoom: 1,
  pinchDistance: 0,
  touched: false,
});

export interface Framing {
  readonly centre: THREE.Vector3;
  readonly direction: THREE.Vector3;
  readonly size: THREE.Vector3;
  readonly sceneRadius: number;
}

/**
 * Measures what is actually drawn.
 *
 * Meshes only: the camera and light empties are scattered well outside the set,
 * and letting them into the box pushes the camera back far enough to make the
 * character a speck in the middle of an empty frame.
 */
export const meshBounds = (root: THREE.Object3D): THREE.Box3 => {
  const box = new THREE.Box3();
  root.traverse((object) => {
    if (object instanceof THREE.Mesh) box.expandByObject(object);
  });
  return box;
};

const measure = (scene: THREE.Group, rig: CharacterRig): Framing => {
  scene.updateMatrixWorld(true);

  const whole = meshBounds(scene);
  const rigRoot = scene.getObjectByName(rig.root);
  const character = rigRoot ? meshBounds(rigRoot) : whole;
  const source = character.isEmpty() ? whole : character;

  const centre = source.getCenter(new THREE.Vector3());
  const size = source.getSize(new THREE.Vector3());

  // Aim a little above the middle of the character: a face two-thirds up the
  // frame reads as eye contact, and dead-centre reads as a specimen.
  centre.y = source.min.y + size.y * 0.58;

  const direction = new THREE.Vector3(0, 0.35, -1);
  const hero = rig.heroCamera === undefined ? undefined : scene.getObjectByName(rig.heroCamera);
  if (hero) {
    hero.getWorldPosition(direction).sub(centre);
    // A hero camera sitting exactly on the character tells us nothing.
    if (direction.lengthSq() < 1e-6) direction.set(0, 0.35, -1);
  }
  direction.normalize();

  const sceneRadius = whole.isEmpty()
    ? Math.max(size.length(), 1)
    : Math.max(whole.getBoundingSphere(new THREE.Sphere()).radius, 1);

  return { centre, direction, size, sceneRadius };
};

/**
 * The distance at which the character fills its share of THIS viewport.
 *
 * Fitted on both axes, larger wins: a tall phone pulls back to keep the
 * character's width in frame rather than cropping it, and a wide tablet does
 * not shove it into the distance to satisfy a constraint that only bound in
 * portrait.
 */
export const fitDistance = (framing: Framing, aspect: number): number => {
  const halfVertical = Math.tan(THREE.MathUtils.degToRad(STAGE_FOV) / 2);
  const halfHorizontal = halfVertical * Math.max(aspect, 0.2);

  const forHeight = framing.size.y / HEIGHT_FRACTION / 2 / halfVertical;
  const forWidth = framing.size.x / WIDTH_FRACTION / 2 / halfHorizontal;

  // Plus half the character's own depth: the fit above frames a flat card, and
  // a dog is most of a unit of nose-to-tail closer to the lens than that.
  return Math.max(forHeight, forWidth) + framing.size.z / 2;
};

/**
 * The camera, under the child's finger.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS NOT `OrbitControls`
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * drei's controls scale every drag by `domElement.clientHeight`, which on the
 * native canvas shim is the DRAWING BUFFER height in physical pixels while the
 * pointer coordinates React Native supplies are in density-independent points.
 * On a 3× phone that silently makes every gesture a third as far as it should
 * be, and the character barely turns. That was previously patched by scaling
 * the speeds back up by the same ratio — a correction that has to be right on
 * every density, for a library whose only job here is two gestures.
 *
 * A `PanResponder` on the wrapping view gives both gestures directly, in points,
 * with no shim in between and no per-density arithmetic. It also lets the limits
 * be exactly the ones the design asks for: the camera stops at the horizon, the
 * distance stops either side of the fitted framing, and both ease rather than
 * snap — so a four-year-old who flings the camera cannot lose the character,
 * and there is no "reset view" for them to fail to find.
 */
export const StageCamera = ({
  framing,
  orbit,
}: {
  framing: Framing;
  orbit: React.RefObject<OrbitState>;
}) => {
  const set = useThree((state) => state.set);
  const width = useThree((state) => state.size.width);
  const height = useThree((state) => state.size.height);

  const camera = useMemo(() => new THREE.PerspectiveCamera(STAGE_FOV, 1, 0.1, 1000), []);
  const distance = useMemo(
    () => fitDistance(framing, height > 0 ? width / height : 1),
    [framing, width, height],
  );

  /* The artist's chosen viewpoint, as an angle rather than a position: this is
   * the one thing the baked hero camera is genuinely authoritative about, and
   * it is where the child's orbit starts from. */
  useEffect(() => {
    const o = orbit.current;
    if (o.touched) return;
    const az = Math.atan2(framing.direction.x, framing.direction.z);
    const el = Math.min(
      MAX_ELEVATION,
      Math.max(MIN_ELEVATION, Math.asin(THREE.MathUtils.clamp(framing.direction.y, -1, 1))),
    );
    o.az = az;
    o.el = el;
    o.targetAz = az;
    o.targetEl = el;
  }, [framing, orbit]);

  useEffect(() => {
    if (width <= 0 || height <= 0) return;
    camera.aspect = width / height;
    camera.near = Math.max(0.05, distance * 0.02);
    // Far enough for the whole set plus the furthest a child can pinch out to.
    camera.far = distance * MAX_ZOOM + framing.sceneRadius * 4;
    camera.updateProjectionMatrix();
    set({ camera });
  }, [camera, framing, distance, width, height, set]);

  useFrame((_state, rawDelta) => {
    const delta = Math.min(rawDelta, 0.1);
    const o = orbit.current;

    // Eased toward the committed view rather than snapped to it. The easing is
    // what makes a flung camera feel like a thing with weight instead of a
    // teleport, and it is why the character always settles back into frame.
    o.az += (o.targetAz - o.az) * Math.min(1, delta * 9);
    o.el += (o.targetEl - o.el) * Math.min(1, delta * 9);
    o.zoom += (o.targetZoom - o.zoom) * Math.min(1, delta * 7);

    const d = distance * o.zoom;
    const ring = Math.cos(o.el) * d;
    camera.position.set(
      Math.sin(o.az) * ring,
      framing.centre.y + Math.sin(o.el) * d,
      Math.cos(o.az) * ring,
    );
    camera.lookAt(framing.centre);
  });

  return null;
};

/**
 * Three-point lighting, positioned from the marker nodes in the file.
 *
 * The hemisphere light's ground colour is the set's own — grass under Buddy,
 * hull plating under Sky — so bounce light reads as coming from the place the
 * character is standing in rather than from a neutral studio.
 */
/** A light's world position, or `undefined` when the rig has no marker for it. */
type LightPosition = readonly [number, number, number] | undefined;

/** Resolves the three marker nodes' world positions once per scene. */
const lightPositionsFor = (
  scene: THREE.Group,
  rig: CharacterRig,
): { key: LightPosition; fill: LightPosition; rim: LightPosition } => {
  scene.updateMatrixWorld(true);
  const at = (name: string | undefined): LightPosition => {
    if (name === undefined) return undefined;
    const found = scene.getObjectByName(name);
    if (!found) return undefined;
    const v = new THREE.Vector3();
    found.getWorldPosition(v);
    return [v.x, v.y, v.z];
  };
  return { key: at(rig.keyLight), fill: at(rig.fillLight), rim: at(rig.rimLight) };
};

export const StageLights = ({
  keyPosition,
  fillPosition,
  rimPosition,
  groundColor,
}: {
  keyPosition: LightPosition;
  fillPosition: LightPosition;
  rimPosition: LightPosition;
  groundColor: string;
}) => (
  <>
    <hemisphereLight args={[SKY_LIGHT, groundColor, 0.62]} />
    {keyPosition !== undefined && (
      <directionalLight position={keyPosition} color={KEY_LIGHT} intensity={2.5} />
    )}
    {fillPosition !== undefined && (
      <directionalLight position={fillPosition} color={FILL_LIGHT} intensity={0.85} />
    )}
    {rimPosition !== undefined && (
      <directionalLight position={rimPosition} color={RIM_LIGHT} intensity={1.25} />
    )}
  </>
);

const Stage = ({
  slug,
  talkState,
  still,
  orbit,
}: {
  slug: string;
  talkState: TalkState;
  still: boolean;
  orbit: React.RefObject<OrbitState>;
}) => {
  const definition = characterDefinitionFor(slug);
  const uri = useLocalGlbUri(definition.model);
  const { scene, nodes } = useGLTF(uri);

  useDioramaMood(nodes, definition.rig, moodFor(talkState), still);

  const framing = useMemo(() => measure(scene, definition.rig), [scene, definition.rig]);
  const lightPositions = useMemo(
    () => lightPositionsFor(scene, definition.rig),
    [scene, definition.rig],
  );
  const ground = GROUND_LIGHT[definition.slug] ?? GROUND_LIGHT['buddy-the-dog'] ?? '#8fc46b';

  return (
    <>
      <StageCamera framing={framing} orbit={orbit} />
      <StageLights
        keyPosition={lightPositions.key}
        fillPosition={lightPositions.fill}
        rimPosition={lightPositions.rim}
        groundColor={ground}
      />
      <primitive object={scene} />
    </>
  );
};

/* -------------------------------------------------------------------------- */
/* Flat register                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The wash.
 *
 * The same 170° gradient the design puts behind every character — their own
 * colour at the top, falling to the cream ground at the bottom. It shows
 * through wherever the diorama does not reach, which is why the canvas keeps
 * its alpha channel, and it is the entire background in the flat register.
 */
export const CharacterWash = ({ slug }: { slug: string | undefined }) => {
  const wash = castMember(slug).wash;
  return (
    <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
      <Defs>
        <LinearGradient id="wash" x1="0.09" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={wash} />
          <Stop offset="0.46" stopColor={wash} />
          <Stop offset="1" stopColor="#fff6e5" />
        </LinearGradient>
      </Defs>
      <Rect x="0" y="0" width="100%" height="100%" fill="url(#wash)" />
    </Svg>
  );
};

/** Three calm dots. No percentage — a percentage is a number a child would read. */
const LoadingDots = () => {
  const t = useRef(new Animated.Value(0)).current;
  const reduced = useReducedMotion();

  useEffect(() => {
    if (reduced) {
      t.setValue(0.6);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(t, {
          toValue: 1,
          duration: 600,
          easing: Easing.linear,
          useNativeDriver: true,
        }),
        Animated.timing(t, {
          toValue: 0,
          duration: 600,
          easing: Easing.linear,
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => {
      loop.stop();
    };
  }, [reduced, t]);

  return (
    <View style={styles.dots}>
      {[0, 0.2, 0.4].map((offset) => (
        <Animated.View
          key={offset}
          style={[
            styles.dot,
            {
              opacity: t.interpolate({
                inputRange: [0, 1],
                outputRange: [0.28 + offset * 0.4, 1 - offset * 0.4],
              }),
            },
          ]}
        />
      ))}
    </View>
  );
};

/**
 * The flat register: loading, and the fallback when 3D is unavailable.
 *
 * The SAME screens, with the animated circular avatar on the character's colour
 * wash. Nothing about the conversation depends on the 3D being there — the
 * character, the bubble and the talk button all still say what they said.
 */
export const FlatStage = ({ slug, loading }: { slug: string | undefined; loading: boolean }) => (
  <View style={styles.flat}>
    <CharacterWash slug={slug} />
    {loading ? (
      <View style={styles.flatInner}>
        <Avatar slug={slug} size={72} />
        <LoadingDots />
      </View>
    ) : (
      <Float>
        <Avatar slug={slug} size={160} />
      </Float>
    )}
  </View>
);

/* -------------------------------------------------------------------------- */

interface BoundaryState {
  readonly failed: boolean;
}

/**
 * Catches a failed model load — a corrupt on-device cache, an out-of-memory GL
 * context, a device with no usable GL at all — and falls back to the flat
 * character rather than a crashed screen. A child mid-conversation loses the
 * diorama and keeps the conversation.
 *
 * React error boundaries must be classes, and this is the only place in the app
 * that needs to be one.
 */
export class StageBoundary extends Component<
  { slug: string | undefined; children: ReactNode },
  BoundaryState
> {
  override state: BoundaryState = { failed: false };

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true };
  }

  override render(): ReactNode {
    if (this.state.failed) return <FlatStage slug={this.props.slug} loading={false} />;
    return this.props.children;
  }
}

export interface DioramaProps {
  readonly slug: string;
  readonly talkState: TalkState;
  /** Forces the flat register — used by the character preview's still frame. */
  readonly flat?: boolean;
  readonly interactive?: boolean;
  readonly testID?: string;
}

/**
 * The camera orbit, under the child's finger — shared by every stage,
 * `.glb`-driven or procedural.
 *
 * A new character is a new set: `orbit` restarts from the framing the artist
 * chose rather than from wherever the child left the last one.
 */
export const useDioramaOrbit = (
  slug: string,
  interactive: boolean,
): {
  orbit: React.RefObject<OrbitState>;
  panHandlers: ReturnType<typeof PanResponder.create>['panHandlers'];
} => {
  const orbit = useRef<OrbitState>(freshOrbit());

  useEffect(() => {
    orbit.current = freshOrbit();
  }, [slug]);

  /* The running total the last move reported, so each frame's delta is the
   * movement since the previous frame rather than since the finger landed. */
  const lastGesture = useRef({ dx: 0, dy: 0 });

  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => interactive,
        onMoveShouldSetPanResponder: () => interactive,
        onPanResponderGrant: () => {
          orbit.current.pinchDistance = 0;
          lastGesture.current = { dx: 0, dy: 0 };
        },
        onPanResponderMove: (event, gesture) => {
          const o = orbit.current;
          const touches = event.nativeEvent.touches;

          if (touches.length >= 2) {
            const [a, b] = touches;
            if (a === undefined || b === undefined) return;
            const spread = Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);
            o.touched = true;
            if (o.pinchDistance > 0 && spread > 0) {
              o.targetZoom = Math.min(
                MAX_ZOOM,
                Math.max(MIN_ZOOM, o.targetZoom * (o.pinchDistance / spread)),
              );
            }
            o.pinchDistance = spread;
            return;
          }

          o.pinchDistance = 0;
          // Deltas rather than cumulative offsets: `dx`/`dy` are the whole
          // gesture, and integrating them would square the movement.
          const dx = gesture.dx - lastGesture.current.dx;
          const dy = gesture.dy - lastGesture.current.dy;
          lastGesture.current = { dx: gesture.dx, dy: gesture.dy };

          o.touched = true;
          o.targetAz -= dx * YAW_PER_POINT;
          o.targetEl = Math.min(
            MAX_ELEVATION,
            Math.max(MIN_ELEVATION, o.targetEl + dy * PITCH_PER_POINT),
          );
        },
        onPanResponderRelease: () => {
          lastGesture.current = { dx: 0, dy: 0 };
          orbit.current.pinchDistance = 0;
        },
        onPanResponderTerminate: () => {
          lastGesture.current = { dx: 0, dy: 0 };
          orbit.current.pinchDistance = 0;
        },
      }),
    [interactive],
  );

  return { orbit, panHandlers: pan.panHandlers };
};

export const Diorama = ({
  slug,
  talkState,
  flat = false,
  interactive = true,
  testID,
}: DioramaProps) => {
  const reduced = useReducedMotion();
  const { orbit, panHandlers } = useDioramaOrbit(slug, interactive);

  if (flat) return <FlatStage slug={slug} loading={false} />;

  return (
    <View style={styles.stage} testID={testID} {...panHandlers}>
      <CharacterWash slug={slug} />
      <StageBoundary slug={slug}>
        <Canvas style={styles.canvas} gl={{ alpha: true, antialias: true }}>
          {/* The wash shows through until the set is on screen, so the moment
              between mounting and the first frame is a colour rather than a
              black rectangle. */}
          <Suspense fallback={null}>
            <Stage slug={slug} talkState={talkState} still={reduced} orbit={orbit} />
          </Suspense>
        </Canvas>
      </StageBoundary>
    </View>
  );
};

/**
 * Fills the parent, as a plain style object.
 *
 * `StyleSheet.absoluteFill` is a registered style ID rather than an object, so
 * it cannot be spread into one; `absoluteFillObject` is absent from this
 * version's typings. Writing the four edges out is the version that compiles
 * and is the version that will keep compiling.
 */
const FILL_PARENT = { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 } as const;

export const styles = StyleSheet.create({
  stage: { ...FILL_PARENT, overflow: 'hidden' },
  canvas: { flex: 1 },
  flat: {
    ...FILL_PARENT,
    alignItems: 'center',
    justifyContent: 'center',
  },
  flatInner: { alignItems: 'center', gap: 16 },
  dots: { flexDirection: 'row', gap: 6 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: 'rgba(58,42,20,0.5)' },
});
