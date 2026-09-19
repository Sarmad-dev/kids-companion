import * as THREE from 'three';

import type { CharacterSlug } from '../theme/child-theme';

import type { RigNodes } from './useDioramaMood';

/**
 * The cast and their sets, built entirely from primitive geometry at runtime.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS ALONGSIDE THE `.glb` PIPELINE IN `character-rig.ts`
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This is a direct, line-for-line port of `diorama.js` — the `<kc-diorama>`
 * web component the Claude Design project renders on the conversation screen
 * mockup. That design never shipped a Blender asset: every sphere, capsule,
 * cylinder and torus below is exactly what the design's own `<script
 * type="module">` builds in a browser. Porting it here (rather than pointing
 * `useGLTF` at a new file) is what makes the conversation screen's diorama the
 * SAME 3D objects the design shows, not a look-alike modelled independently.
 *
 * The numbers — positions, radii, colours, rotations — are transcribed rather
 * than re-derived, for the same reason `character-rig.ts` transcribes its
 * `.glb` node names: a value that "looks about right" drifts from the design
 * the first time either side is touched.
 *
 * Only the conversation screen uses this. The character preview screen
 * (`app/(child)/character/[slug].tsx`) still renders the `.glb` cast via
 * `Diorama` — this module and its rig are never imported there.
 */

const DARK = 0x2b2118;

interface MaterialExtra {
  readonly transparent?: boolean;
  readonly opacity?: number;
  readonly emissive?: number;
  readonly emissiveIntensity?: number;
}

const mat = (
  color: number,
  roughness = 0.62,
  metalness = 0.02,
  extra?: MaterialExtra,
): THREE.MeshStandardMaterial =>
  new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra });

const meshOf = (
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  name = '',
): THREE.Mesh => {
  const m = new THREE.Mesh(geometry, material);
  m.name = name;
  return m;
};

const sph = (r: number, seg = 32): THREE.SphereGeometry =>
  new THREE.SphereGeometry(r, seg, seg / 2);
const cap = (r: number, l: number): THREE.CapsuleGeometry => new THREE.CapsuleGeometry(r, l, 8, 24);
const cyl = (rt: number, rb: number, h: number, seg = 20): THREE.CylinderGeometry =>
  new THREE.CylinderGeometry(rt, rb, h, seg);
const box = (w: number, h: number, d: number): THREE.BoxGeometry =>
  new THREE.BoxGeometry(w, h, d, 1, 1, 1);

/* ---------- shared face parts ---------- */

/** One eye, as a single group: blinking scales the whole thing on `y`. */
const faceEye = (r: number, dark = false): THREE.Group => {
  const g = new THREE.Group();
  g.add(meshOf(sph(r, 20), mat(0xffffff, 0.35), 'eye-white'));
  const pupil = meshOf(sph(r * 0.52, 16), mat(dark ? 0x1a1c1f : DARK, 0.3), 'pupil');
  pupil.position.z = r * 0.62;
  g.add(pupil);
  const glint = meshOf(sph(r * 0.18, 12), mat(0xffffff, 0.1), 'glint');
  glint.position.set(r * 0.22, r * 0.24, r * 0.78);
  g.add(glint);
  return g;
};

const browMesh = (w: number, color: number): THREE.Mesh => {
  const b = meshOf(cap(w * 0.22, w), mat(color, 0.7), 'brow');
  b.rotation.z = Math.PI / 2;
  return b;
};

/* ---------- characters ---------- */

interface Built {
  readonly group: THREE.Group;
  readonly parts: RigNodes;
}

const buildBuddy = (): Built => {
  const C = 0xf2a03d;
  const CREAM = 0xffe3bd;
  const group = new THREE.Group();
  const body = mat(C, 0.66);
  const cream = mat(CREAM, 0.6);
  const dark = mat(DARK, 0.42);

  const chest = new THREE.Group();
  chest.position.y = 0.82;
  group.add(chest);
  const torso = meshOf(cap(0.3, 0.5), body, 'torso');
  torso.rotation.z = Math.PI / 2;
  chest.add(torso);
  const belly = meshOf(sph(0.27, 24), cream, 'belly');
  belly.position.set(0, -0.09, 0.14);
  belly.scale.set(0.95, 0.85, 0.62);
  chest.add(belly);

  const neck = meshOf(cyl(0.16, 0.2, 0.16, 16), body, 'neck');
  neck.position.set(0, 0.24, 0.2);
  neck.rotation.x = -0.35;
  chest.add(neck);
  const head = new THREE.Group();
  head.position.set(0, 0.4, 0.26);
  chest.add(head);
  head.add(meshOf(sph(0.315, 32), body, 'head'));
  const snout = meshOf(cap(0.135, 0.16), cream, 'snout');
  snout.rotation.x = Math.PI / 2;
  snout.position.set(0, -0.075, 0.3);
  head.add(snout);
  const nose = meshOf(sph(0.072, 20), dark, 'nose');
  nose.position.set(0, -0.035, 0.415);
  head.add(nose);

  const mouth = meshOf(cap(0.028, 0.13), dark, 'mouth');
  mouth.rotation.z = Math.PI / 2;
  mouth.position.set(0, -0.165, 0.345);
  head.add(mouth);

  const eyes: THREE.Object3D[] = [];
  let browL: THREE.Object3D | undefined;
  let browR: THREE.Object3D | undefined;
  ([-1, 1] as const).forEach((s) => {
    const e = faceEye(0.08);
    e.position.set(0.125 * s, 0.075, 0.265);
    head.add(e);
    eyes.push(e);
    const b = browMesh(0.078, 0xc9762a);
    b.position.set(0.125 * s, 0.215, 0.255);
    head.add(b);
    if (s < 0) browL = b;
    else browR = b;
  });

  const wings: THREE.Object3D[] = [];
  ([-1, 1] as const).forEach((s) => {
    const pivot = new THREE.Group();
    pivot.position.set(0.25 * s, 0.2, -0.04);
    head.add(pivot);
    const ear = meshOf(cap(0.105, 0.3), mat(0xd9822b, 0.7), 'ear');
    ear.scale.set(0.8, 1, 0.5);
    ear.position.y = -0.19;
    pivot.add(ear);
    pivot.rotation.z = 0.3 * s;
    wings.push(pivot);
  });

  const tailPivot = new THREE.Group();
  tailPivot.position.set(0, 0.1, -0.36);
  chest.add(tailPivot);
  const tail = meshOf(cyl(0.04, 0.09, 0.34, 14), body, 'tail');
  tail.position.y = 0.17;
  tailPivot.add(tail);
  tailPivot.rotation.x = -0.7;

  const legs: THREE.Object3D[] = [];
  (
    [
      [-0.19, 0.22],
      [0.19, 0.22],
      [-0.19, -0.22],
      [0.19, -0.22],
    ] as const
  ).forEach(([x, z]) => {
    const p = new THREE.Group();
    p.position.set(x, 0.5, z);
    group.add(p);
    const leg = meshOf(cap(0.075, 0.26), body, 'leg');
    leg.position.y = -0.2;
    p.add(leg);
    const paw = meshOf(sph(0.09, 16), cream, 'paw');
    paw.position.y = -0.375;
    paw.scale.set(1, 0.62, 1.15);
    p.add(paw);
    legs.push(p);
  });

  return {
    group,
    parts: {
      chest,
      head,
      brows: [browL, browR].filter((n): n is THREE.Object3D => n !== undefined),
      eyes,
      mouth,
      limbs: legs,
      wings,
      tail: tailPivot,
      root: group,
      mouthHinges: false,
      hovers: false,
    },
  };
};

const buildLily = (): Built => {
  const C = 0xa978d8;
  const SKIN = 0xf3d3b6;
  const group = new THREE.Group();
  const dress = mat(C, 0.6);
  const skin = mat(SKIN, 0.55);
  const hair = mat(0x6b4a8f, 0.65);
  const dark = mat(DARK, 0.42);

  const chest = new THREE.Group();
  chest.position.y = 0.88;
  group.add(chest);
  const gown = meshOf(cyl(0.2, 0.4, 0.62, 28), dress, 'gown');
  gown.position.y = -0.26;
  chest.add(gown);
  chest.add(meshOf(cap(0.17, 0.16), dress, 'bodice'));
  const collar = meshOf(
    new THREE.TorusGeometry(0.17, 0.035, 10, 28),
    mat(0xf7e6a8, 0.4, 0.25),
    'collar',
  );
  collar.rotation.x = Math.PI / 2;
  collar.position.y = 0.13;
  chest.add(collar);

  const head = new THREE.Group();
  head.position.y = 0.4;
  chest.add(head);
  head.add(meshOf(sph(0.26, 32), skin, 'head'));
  const hairBack = meshOf(sph(0.285, 28), hair, 'hair');
  hairBack.position.set(0, 0.03, -0.05);
  hairBack.scale.set(1, 1.05, 1);
  head.add(hairBack);
  const bun = meshOf(sph(0.13, 20), hair, 'bun');
  bun.position.set(0, 0.24, -0.12);
  head.add(bun);
  const fringe = meshOf(sph(0.275, 24), mat(0x8256ad, 0.65), 'fringe');
  fringe.position.set(0, 0.205, 0.015);
  fringe.scale.set(0.99, 0.36, 0.99);
  head.add(fringe);

  const eyes: THREE.Object3D[] = [];
  let browL: THREE.Object3D | undefined;
  let browR: THREE.Object3D | undefined;
  ([-1, 1] as const).forEach((s) => {
    const e = faceEye(0.07);
    e.position.set(0.105 * s, -0.005, 0.215);
    head.add(e);
    eyes.push(e);
    const b = browMesh(0.07, 0x9d78c4);
    b.position.set(0.105 * s, 0.105, 0.225);
    head.add(b);
    if (s < 0) browL = b;
    else browR = b;
  });
  const cheekL = meshOf(sph(0.05, 14), mat(0xf0a9b4, 0.6), 'cheek');
  cheekL.position.set(-0.165, -0.055, 0.17);
  cheekL.scale.set(1, 0.6, 0.4);
  head.add(cheekL);
  const cheekR = cheekL.clone();
  cheekR.position.x = 0.165;
  head.add(cheekR);
  const mouth = meshOf(cap(0.022, 0.07), dark, 'mouth');
  mouth.rotation.z = Math.PI / 2;
  mouth.position.set(0, -0.11, 0.235);
  head.add(mouth);

  const wings: THREE.Object3D[] = [];
  ([-1, 1] as const).forEach((s) => {
    const pivot = new THREE.Group();
    pivot.position.set(0.14 * s, 0.02, -0.14);
    chest.add(pivot);
    const wm = mat(0xf6efff, 0.2, 0, { transparent: true, opacity: 0.86 });
    const up = meshOf(sph(0.34, 22), wm, 'wing-upper');
    up.scale.set(0.46, 1, 0.12);
    up.position.set(0.28 * s, 0.24, -0.06);
    up.rotation.z = -0.55 * s;
    pivot.add(up);
    const lo = meshOf(sph(0.24, 20), wm, 'wing-lower');
    lo.scale.set(0.46, 1, 0.12);
    lo.position.set(0.26 * s, -0.1, -0.06);
    lo.rotation.z = -0.95 * s;
    pivot.add(lo);
    pivot.rotation.y = 0.3 * s;
    wings.push(pivot);
  });

  const arms: THREE.Object3D[] = [];
  ([-1, 1] as const).forEach((s) => {
    const p = new THREE.Group();
    p.position.set(0.17 * s, 0.06, 0.02);
    chest.add(p);
    const a = meshOf(cap(0.045, 0.22), skin, 'arm');
    a.position.y = -0.15;
    p.add(a);
    const h = meshOf(sph(0.058, 14), skin, 'hand');
    h.position.y = -0.29;
    p.add(h);
    p.rotation.z = 0.28 * s;
    arms.push(p);
  });
  const legs: THREE.Object3D[] = [];
  ([-1, 1] as const).forEach((s) => {
    const p = new THREE.Group();
    p.position.set(0.09 * s, 0.3, 0);
    group.add(p);
    const l = meshOf(cap(0.045, 0.16), skin, 'leg');
    l.position.y = -0.11;
    p.add(l);
    const f = meshOf(sph(0.07, 14), mat(0xf7e6a8, 0.5), 'shoe');
    f.position.set(0, -0.21, 0.02);
    f.scale.set(1, 0.55, 1.3);
    p.add(f);
    legs.push(p);
  });

  return {
    group,
    parts: {
      chest,
      head,
      brows: [browL, browR].filter((n): n is THREE.Object3D => n !== undefined),
      eyes,
      mouth,
      limbs: legs.concat(arms),
      wings,
      tail: undefined,
      root: group,
      mouthHinges: false,
      hovers: true,
    },
  };
};

const buildSky = (): Built => {
  const C = 0x3d8ce0;
  const SUIT = 0xe8eef7;
  const SKIN = 0xd9a06b;
  const group = new THREE.Group();
  const suit = mat(SUIT, 0.55);
  const accent = mat(C, 0.5);
  const skin = mat(SKIN, 0.55);
  const dark = mat(DARK, 0.42);
  const glassM = mat(0xdcefff, 0.08, 0.1, { transparent: true, opacity: 0.34 });

  const chest = new THREE.Group();
  chest.position.y = 0.86;
  group.add(chest);
  chest.add(meshOf(cap(0.24, 0.3), suit, 'suit-torso'));
  const bib = meshOf(box(0.26, 0.22, 0.06), accent, 'chest-panel');
  bib.position.set(0, 0.02, 0.23);
  chest.add(bib);
  const belt = meshOf(new THREE.TorusGeometry(0.245, 0.045, 10, 28), accent, 'belt');
  belt.rotation.x = Math.PI / 2;
  belt.position.y = -0.2;
  chest.add(belt);
  const pack = meshOf(box(0.3, 0.34, 0.16), mat(0xbcc7d6, 0.5, 0.2), 'backpack');
  pack.position.set(0, 0.02, -0.28);
  chest.add(pack);

  const head = new THREE.Group();
  head.position.y = 0.42;
  chest.add(head);
  head.add(meshOf(sph(0.215, 32), skin, 'head'));
  const helmet = meshOf(sph(0.3, 32), glassM, 'helmet');
  head.add(helmet);
  const ring = meshOf(new THREE.TorusGeometry(0.285, 0.032, 10, 30), accent, 'helmet-ring');
  ring.rotation.x = Math.PI / 2;
  ring.position.y = -0.09;
  head.add(ring);

  const eyes: THREE.Object3D[] = [];
  let browL: THREE.Object3D | undefined;
  let browR: THREE.Object3D | undefined;
  ([-1, 1] as const).forEach((s) => {
    const e = faceEye(0.058);
    e.position.set(0.082 * s, 0.025, 0.185);
    head.add(e);
    eyes.push(e);
    const b = browMesh(0.08, 0x54402c);
    b.position.set(0.082 * s, 0.125, 0.19);
    head.add(b);
    if (s < 0) browL = b;
    else browR = b;
  });
  const mouth = meshOf(cap(0.024, 0.075), dark, 'mouth');
  mouth.rotation.z = Math.PI / 2;
  mouth.position.set(0, -0.095, 0.2);
  head.add(mouth);

  const limbs: THREE.Object3D[] = [];
  ([-1, 1] as const).forEach((s) => {
    const p = new THREE.Group();
    p.position.set(0.235 * s, 0.1, 0);
    chest.add(p);
    const a = meshOf(cap(0.062, 0.2), suit, 'arm');
    a.position.y = -0.14;
    p.add(a);
    const g = meshOf(sph(0.072, 16), accent, 'glove');
    g.position.y = -0.27;
    p.add(g);
    p.rotation.z = 0.3 * s;
    limbs.push(p);
  });
  ([-1, 1] as const).forEach((s) => {
    const p = new THREE.Group();
    p.position.set(0.105 * s, 0.3, 0);
    group.add(p);
    const l = meshOf(cap(0.072, 0.16), suit, 'leg');
    l.position.y = -0.12;
    p.add(l);
    const b = meshOf(box(0.14, 0.1, 0.2), mat(0x4a556b, 0.6), 'boot');
    b.position.set(0, -0.245, 0.03);
    p.add(b);
    limbs.push(p);
  });

  return {
    group,
    parts: {
      chest,
      head,
      brows: [browL, browR].filter((n): n is THREE.Object3D => n !== undefined),
      eyes,
      mouth,
      limbs,
      wings: [],
      tail: undefined,
      root: group,
      mouthHinges: false,
      hovers: false,
    },
  };
};

const buildOwl = (): Built => {
  const C = 0x3fa37a;
  const PALE = 0xcfe8d8;
  const BEAK = 0xe8a33d;
  const group = new THREE.Group();
  const feather = mat(C, 0.7);
  const pale = mat(PALE, 0.62);
  const beakM = mat(BEAK, 0.45);

  const chest = new THREE.Group();
  chest.position.y = 0.7;
  group.add(chest);
  const body = meshOf(sph(0.42, 32), feather, 'body');
  body.scale.set(0.92, 1.08, 0.9);
  chest.add(body);
  const front = meshOf(sph(0.33, 26), pale, 'breast');
  front.position.set(0, -0.06, 0.2);
  front.scale.set(1, 1.05, 0.5);
  chest.add(front);

  const head = new THREE.Group();
  head.position.y = 0.4;
  chest.add(head);
  head.add(meshOf(sph(0.33, 32), feather, 'head'));
  const disc = meshOf(sph(0.3, 28), pale, 'face-disc');
  disc.position.set(0, 0.02, 0.14);
  disc.scale.set(1.02, 0.92, 0.42);
  head.add(disc);

  const eyes: THREE.Object3D[] = [];
  let browL: THREE.Object3D | undefined;
  let browR: THREE.Object3D | undefined;
  const tufts: THREE.Object3D[] = [];
  ([-1, 1] as const).forEach((s) => {
    const wrap = new THREE.Group();
    wrap.position.set(0.125 * s, 0.055, 0.235);
    head.add(wrap);
    const ring = meshOf(
      new THREE.TorusGeometry(0.105, 0.022, 10, 26),
      mat(0xf7e6a8, 0.5),
      'eye-ring',
    );
    ring.position.z = 0.01;
    wrap.add(ring);
    const e = faceEye(0.093);
    wrap.add(e);
    eyes.push(wrap);
    const b = browMesh(0.12, 0x2c6d52);
    b.position.set(0, 0.155, 0.02);
    wrap.add(b);
    if (s < 0) browL = b;
    else browR = b;
  });
  ([-1, 1] as const).forEach((s) => {
    const p = new THREE.Group();
    p.position.set(0.2 * s, 0.24, 0.02);
    head.add(p);
    const t = meshOf(cyl(0.005, 0.075, 0.19, 12), feather, 'ear-tuft');
    t.position.y = 0.09;
    p.add(t);
    p.rotation.z = 0.35 * s;
    tufts.push(p);
  });
  const beakTop = meshOf(cyl(0.005, 0.085, 0.15, 4), beakM, 'beak-upper');
  beakTop.rotation.x = -Math.PI / 2 - 0.15;
  beakTop.position.set(0, -0.055, 0.3);
  head.add(beakTop);
  const hinge = new THREE.Group();
  hinge.position.set(0, -0.075, 0.255);
  head.add(hinge);
  const beakLow = meshOf(cyl(0.005, 0.07, 0.11, 4), mat(0xc07f22, 0.5), 'beak-lower');
  beakLow.rotation.x = -Math.PI / 2 + 0.35;
  beakLow.position.set(0, -0.02, 0.05);
  hinge.add(beakLow);

  const wings: THREE.Object3D[] = [];
  ([-1, 1] as const).forEach((s) => {
    const p = new THREE.Group();
    p.position.set(0.36 * s, 0.05, 0);
    chest.add(p);
    const w = meshOf(sph(0.3, 22), feather, 'wing');
    w.scale.set(0.3, 1, 0.62);
    w.position.y = -0.1;
    p.add(w);
    p.rotation.z = 0.12 * s;
    wings.push(p);
  });
  const legs: THREE.Object3D[] = [];
  ([-1, 1] as const).forEach((s) => {
    const p = new THREE.Group();
    p.position.set(0.13 * s, 0.34, 0.02);
    group.add(p);
    const l = meshOf(cyl(0.045, 0.05, 0.12, 12), beakM, 'leg');
    l.position.y = -0.06;
    p.add(l);
    const f = meshOf(sph(0.085, 14), beakM, 'talon');
    f.position.set(0, -0.13, 0.03);
    f.scale.set(1, 0.4, 1.4);
    p.add(f);
    legs.push(p);
  });

  return {
    group,
    parts: {
      chest,
      head,
      brows: [browL, browR].filter((n): n is THREE.Object3D => n !== undefined),
      eyes,
      mouth: hinge,
      limbs: legs,
      wings: wings.concat(tufts),
      tail: undefined,
      root: group,
      mouthHinges: true,
      hovers: false,
    },
  };
};

/* ---------- the five the database had and the app did not ----------------- */

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THESE FIVE ARE BUILT THE SAME WAY THE FIRST FOUR ARE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Pip, Nano, Mira, Zia and Dada Jee have no `.glb`. They could have had one —
 * `character-rig.ts` would load it — but a Blender asset is a binary an artist
 * has to re-export for every change, and the four that exist already diverged
 * from the design once (which is why `ProceduralDiorama` exists at all).
 *
 * Built here instead, each of the five is:
 *   - the same primitives, the same `mat()` roughness, the same eye and brow
 *     helpers the first four use, so nine characters read as one cast;
 *   - riggable with no name lookup, so `useResolvedRigMood` drives all nine
 *     from the same formulas — every one of them breathes, blinks, sways,
 *     wanders, and opens its mouth while it is speaking;
 *   - a silhouette nobody else has, which is the only thing that actually
 *     matters on a grid of nine cards: ears, a box, a crescent, a brim, a beard.
 */

const buildPip = (): Built => {
  const C = 0xe0603d;
  const CREAM = 0xffe8da;
  const group = new THREE.Group();
  const fur = mat(C, 0.68);
  const cream = mat(CREAM, 0.6);
  const dark = mat(DARK, 0.42);
  const deep = mat(0xb8472a, 0.72);

  // Sitting, not standing. Buddy is a standing quadruped two cards away, and
  // the pose is what tells them apart before either face resolves.
  const chest = new THREE.Group();
  chest.position.y = 0.66;
  group.add(chest);
  chest.add(meshOf(cap(0.23, 0.28), fur, 'torso'));
  const bib = meshOf(sph(0.2, 24), cream, 'bib');
  bib.position.set(0, -0.05, 0.13);
  bib.scale.set(0.92, 1.05, 0.52);
  chest.add(bib);

  ([-1, 1] as const).forEach((s) => {
    const haunch = meshOf(sph(0.2, 20), fur, 'haunch');
    haunch.position.set(0.19 * s, -0.42, -0.04);
    haunch.scale.set(0.85, 0.9, 1.05);
    chest.add(haunch);
  });

  const head = new THREE.Group();
  head.position.set(0, 0.33, 0.02);
  chest.add(head);
  head.add(meshOf(sph(0.28, 32), fur, 'head'));
  ([-1, 1] as const).forEach((s) => {
    const ruff = meshOf(sph(0.14, 18), cream, 'cheek-ruff');
    ruff.position.set(0.2 * s, -0.07, 0.05);
    ruff.scale.set(0.78, 0.72, 0.78);
    head.add(ruff);
  });

  const snout = meshOf(cyl(0.035, 0.12, 0.3, 16), cream, 'snout');
  snout.rotation.x = Math.PI / 2;
  snout.position.set(0, -0.06, 0.27);
  head.add(snout);
  const nose = meshOf(sph(0.055, 18), dark, 'nose');
  nose.position.set(0, -0.045, 0.415);
  head.add(nose);

  const mouth = meshOf(cap(0.024, 0.1), dark, 'mouth');
  mouth.rotation.z = Math.PI / 2;
  mouth.position.set(0, -0.15, 0.3);
  head.add(mouth);

  const eyes: THREE.Object3D[] = [];
  const brows: THREE.Object3D[] = [];
  ([-1, 1] as const).forEach((s) => {
    const e = faceEye(0.075);
    e.position.set(0.115 * s, 0.06, 0.235);
    head.add(e);
    eyes.push(e);
    const b = browMesh(0.075, 0xa83d22);
    b.position.set(0.115 * s, 0.19, 0.225);
    head.add(b);
    brows.push(b);
  });

  // Ears in `wings` rather than `limbs`: they mirror each other. A fox whose
  // ears alternated would be shaking its head, not listening.
  const ears: THREE.Object3D[] = [];
  ([-1, 1] as const).forEach((s) => {
    const pivot = new THREE.Group();
    pivot.position.set(0.16 * s, 0.22, -0.02);
    head.add(pivot);
    const outer = meshOf(cyl(0.004, 0.11, 0.32, 12), deep, 'ear');
    outer.position.y = 0.16;
    pivot.add(outer);
    const inner = meshOf(cyl(0.003, 0.07, 0.22, 10), cream, 'ear-inner');
    inner.position.set(0, 0.13, 0.035);
    pivot.add(inner);
    pivot.rotation.z = 0.26 * s;
    ears.push(pivot);
  });

  const tailPivot = new THREE.Group();
  tailPivot.position.set(0, -0.14, -0.22);
  chest.add(tailPivot);
  (
    [
      [0.13, 0.0],
      [0.16, 0.2],
      [0.145, 0.4],
    ] as const
  ).forEach(([r, along]) => {
    const seg = meshOf(sph(r, 18), fur, 'tail-segment');
    seg.position.set(0, along * 0.55, -0.1 - along * 0.55);
    tailPivot.add(seg);
  });
  const tip = meshOf(sph(0.115, 16), cream, 'tail-tip');
  tip.position.set(0, 0.35, -0.42);
  tailPivot.add(tip);
  tailPivot.rotation.x = -0.55;

  const legs: THREE.Object3D[] = [];
  ([-1, 1] as const).forEach((s) => {
    const p = new THREE.Group();
    p.position.set(0.13 * s, 0.44, 0.17);
    group.add(p);
    const leg = meshOf(cap(0.055, 0.2), fur, 'foreleg');
    leg.position.y = -0.14;
    p.add(leg);
    const paw = meshOf(sph(0.075, 14), cream, 'paw');
    paw.position.set(0, -0.27, 0.03);
    paw.scale.set(1, 0.66, 1.25);
    p.add(paw);
    legs.push(p);
  });

  return {
    group,
    parts: {
      chest,
      head,
      brows,
      eyes,
      mouth,
      limbs: legs,
      wings: ears,
      tail: tailPivot,
      root: group,
      mouthHinges: false,
      hovers: false,
    },
  };
};

const buildNano = (): Built => {
  const C = 0x2ba7b4;
  const DEEP = 0x0f3d43;
  const GLOW = 0x8ff0f7;
  const group = new THREE.Group();
  const shell = mat(C, 0.4, 0.28);
  const trim = mat(0x1c7d88, 0.4, 0.3);
  const deep = mat(DEEP, 0.35, 0.2);
  const lit = mat(GLOW, 0.2, 0, { emissive: GLOW, emissiveIntensity: 0.85 });
  const lamp = mat(0xffe27a, 0.2, 0, { emissive: 0xffe27a, emissiveIntensity: 1 });

  const chest = new THREE.Group();
  chest.position.y = 1.0;
  group.add(chest);
  chest.add(meshOf(cap(0.25, 0.2), shell, 'chassis'));
  const panel = meshOf(box(0.24, 0.18, 0.05), deep, 'chest-panel');
  panel.position.set(0, 0.0, 0.23);
  chest.add(panel);
  const gauge = meshOf(box(0.15, 0.045, 0.02), lit, 'gauge');
  gauge.position.set(0, 0.0, 0.27);
  chest.add(gauge);
  const collar = meshOf(new THREE.TorusGeometry(0.16, 0.035, 10, 26), trim, 'collar');
  collar.rotation.x = Math.PI / 2;
  collar.position.y = 0.2;
  chest.add(collar);
  // A hover skirt rather than legs on the ground — the thing that makes the
  // float below read as deliberate instead of as a character stuck mid-jump.
  const skirt = meshOf(cyl(0.22, 0.1, 0.14, 18), trim, 'thruster');
  skirt.position.y = -0.3;
  chest.add(skirt);
  const wash = meshOf(cyl(0.09, 0.16, 0.1, 18), lit, 'thruster-glow');
  wash.position.y = -0.41;
  chest.add(wash);

  const head = new THREE.Group();
  head.position.y = 0.44;
  chest.add(head);
  const skull = meshOf(sph(0.24, 32), shell, 'head');
  skull.scale.set(1, 0.94, 0.96);
  head.add(skull);
  const visor = meshOf(sph(0.235, 28), deep, 'visor');
  visor.scale.set(0.98, 0.58, 0.66);
  visor.position.set(0, 0.015, 0.09);
  head.add(visor);
  ([-1, 1] as const).forEach((s) => {
    const disc = meshOf(cyl(0.055, 0.055, 0.04, 16), trim, 'ear-disc');
    disc.rotation.z = Math.PI / 2;
    disc.position.set(0.24 * s, -0.01, 0);
    head.add(disc);
  });

  const eyes: THREE.Object3D[] = [];
  const brows: THREE.Object3D[] = [];
  ([-1, 1] as const).forEach((s) => {
    const e = faceEye(0.065);
    e.position.set(0.09 * s, 0.025, 0.2);
    head.add(e);
    eyes.push(e);
    const b = browMesh(0.075, 0x1c7d88);
    b.position.set(0.09 * s, 0.135, 0.19);
    head.add(b);
    brows.push(b);
  });

  // A lit bar rather than a drawn line. It still SCALES on `y` like everyone
  // else's mouth, so the one talking formula covers the robot too.
  const mouth = meshOf(cap(0.02, 0.09), lit, 'mouth');
  mouth.rotation.z = Math.PI / 2;
  mouth.position.set(0, -0.115, 0.2);
  head.add(mouth);

  const antennae: THREE.Object3D[] = [];
  ([-1, 1] as const).forEach((s) => {
    const pivot = new THREE.Group();
    pivot.position.set(0.08 * s, 0.21, -0.01);
    head.add(pivot);
    const rod = meshOf(cyl(0.011, 0.014, 0.18, 8), trim, 'antenna');
    rod.position.y = 0.09;
    pivot.add(rod);
    const bulb = meshOf(sph(0.045, 14), lamp, 'antenna-bulb');
    bulb.position.y = 0.2;
    pivot.add(bulb);
    pivot.rotation.z = 0.22 * s;
    antennae.push(pivot);
  });

  const limbs: THREE.Object3D[] = [];
  ([-1, 1] as const).forEach((s) => {
    const p = new THREE.Group();
    p.position.set(0.27 * s, 0.08, 0);
    chest.add(p);
    const upper = meshOf(cyl(0.032, 0.032, 0.16, 10), trim, 'arm');
    upper.position.y = -0.1;
    p.add(upper);
    // Detached mitts. A floating hand is a robot shorthand a five-year-old
    // reads instantly, and it removes an elbow nobody has to animate.
    const mitt = meshOf(sph(0.075, 16), shell, 'mitt');
    mitt.position.y = -0.28;
    p.add(mitt);
    p.rotation.z = 0.26 * s;
    limbs.push(p);
  });

  return {
    group,
    parts: {
      chest,
      head,
      brows,
      eyes,
      mouth,
      limbs,
      wings: antennae,
      tail: undefined,
      root: group,
      mouthHinges: false,
      hovers: true,
    },
  };
};

const buildMira = (): Built => {
  const C = 0x7b86d8;
  const PALE = 0xf6f3ff;
  const group = new THREE.Group();
  const robe = mat(C, 0.62);
  const moon = mat(PALE, 0.55);
  const crater = mat(0xe2ddf4, 0.7);
  const cloud = mat(0xf2f3ff, 0.9, 0, { transparent: true, opacity: 0.9 });
  const star = mat(0xfff3c4, 0.2, 0, { emissive: 0xffe9a0, emissiveIntensity: 1 });

  const chest = new THREE.Group();
  chest.position.y = 1.02;
  group.add(chest);
  const gown = meshOf(cyl(0.17, 0.33, 0.5, 26), robe, 'gown');
  gown.position.y = -0.24;
  chest.add(gown);
  chest.add(meshOf(cap(0.155, 0.14), robe, 'bodice'));
  const sash = meshOf(new THREE.TorusGeometry(0.16, 0.03, 10, 26), mat(0xffe27a, 0.4), 'sash');
  sash.rotation.x = Math.PI / 2;
  sash.position.y = -0.09;
  chest.add(sash);

  const head = new THREE.Group();
  head.position.y = 0.38;
  chest.add(head);
  head.add(meshOf(sph(0.27, 32), moon, 'head'));
  (
    [
      [-0.15, 0.13, 0.19, 0.06],
      [0.17, -0.08, 0.17, 0.05],
      [-0.1, -0.15, 0.2, 0.042],
    ] as const
  ).forEach(([x, y, z, r]) => {
    const c = meshOf(sph(r, 14), crater, 'crater');
    c.position.set(x, y, z);
    c.scale.set(1, 1, 0.4);
    head.add(c);
  });

  const eyes: THREE.Object3D[] = [];
  const brows: THREE.Object3D[] = [];
  ([-1, 1] as const).forEach((s) => {
    const e = faceEye(0.07, true);
    e.position.set(0.105 * s, -0.01, 0.222);
    head.add(e);
    eyes.push(e);
    const b = browMesh(0.07, 0x9aa2e0);
    b.position.set(0.105 * s, 0.1, 0.225);
    head.add(b);
    brows.push(b);
  });
  ([-1, 1] as const).forEach((s) => {
    const cheek = meshOf(sph(0.05, 14), mat(0xefc0cf, 0.6), 'cheek');
    cheek.position.set(0.17 * s, -0.06, 0.175);
    cheek.scale.set(1, 0.6, 0.4);
    head.add(cheek);
  });
  const mouth = meshOf(cap(0.02, 0.07), mat(0x6b6690, 0.5), 'mouth');
  mouth.rotation.z = Math.PI / 2;
  mouth.position.set(0, -0.12, 0.235);
  head.add(mouth);

  const nightcap = new THREE.Group();
  nightcap.position.set(0, 0.2, -0.03);
  head.add(nightcap);
  const cone = meshOf(cyl(0.006, 0.19, 0.38, 16), robe, 'nightcap');
  cone.position.set(0.09, 0.17, -0.04);
  cone.rotation.z = -0.55;
  nightcap.add(cone);
  const pompom = meshOf(sph(0.065, 14), moon, 'pompom');
  pompom.position.set(0.28, 0.29, -0.08);
  nightcap.add(pompom);

  // Two drifting puffs rather than wings. They mirror on the wing period, so
  // Mira is never motionless even when she is doing nothing but breathing.
  const puffs: THREE.Object3D[] = [];
  ([-1, 1] as const).forEach((s) => {
    const pivot = new THREE.Group();
    pivot.position.set(0.3 * s, -0.08, -0.06);
    chest.add(pivot);
    (
      [
        [0, 0, 0.11],
        [0.1, 0.04, 0.085],
        [-0.1, 0.02, 0.08],
      ] as const
    ).forEach(([x, y, r]) => {
      const p = meshOf(sph(r, 16), cloud, 'puff');
      p.position.set(x * s, y, 0);
      p.scale.set(1, 0.78, 0.7);
      pivot.add(p);
    });
    pivot.rotation.z = 0.18 * s;
    puffs.push(pivot);
  });

  const arms: THREE.Object3D[] = [];
  ([-1, 1] as const).forEach((s) => {
    const p = new THREE.Group();
    p.position.set(0.16 * s, 0.04, 0.02);
    chest.add(p);
    const a = meshOf(cap(0.042, 0.2), robe, 'arm');
    a.position.y = -0.14;
    p.add(a);
    const h = meshOf(sph(0.055, 14), moon, 'hand');
    h.position.y = -0.27;
    p.add(h);
    p.rotation.z = 0.26 * s;
    arms.push(p);
  });

  // A star on a thread, trailing behind her. It swings on the tail formula —
  // the one part of the rig a child watches for, borrowed from Buddy's wag.
  const trail = new THREE.Group();
  trail.position.set(0, -0.12, -0.18);
  chest.add(trail);
  const thread = meshOf(cyl(0.006, 0.006, 0.3, 6), mat(0xd7d9f2, 0.6), 'thread');
  thread.position.set(0, -0.12, -0.12);
  thread.rotation.x = 0.7;
  trail.add(thread);
  const spark = meshOf(sph(0.06, 14), star, 'trail-star');
  spark.position.set(0, -0.24, -0.24);
  trail.add(spark);

  return {
    group,
    parts: {
      chest,
      head,
      brows,
      eyes,
      mouth,
      limbs: arms,
      wings: puffs,
      tail: trail,
      root: group,
      mouthHinges: false,
      hovers: true,
    },
  };
};

const buildZia = (): Built => {
  const C = 0x7aa53c;
  const KHAKI = 0xcbb98a;
  const SKIN = 0xd9a06b;
  const group = new THREE.Group();
  const shirt = mat(KHAKI, 0.65);
  const kit = mat(C, 0.6);
  const deep = mat(0x4f6b26, 0.65);
  const skin = mat(SKIN, 0.55);
  const dark = mat(DARK, 0.42);

  const chest = new THREE.Group();
  chest.position.y = 0.86;
  group.add(chest);
  chest.add(meshOf(cap(0.22, 0.28), shirt, 'shirt'));
  ([-1, 1] as const).forEach((s) => {
    const lapel = meshOf(box(0.1, 0.3, 0.06), kit, 'vest-panel');
    lapel.position.set(0.11 * s, 0.0, 0.2);
    chest.add(lapel);
  });
  const belt = meshOf(new THREE.TorusGeometry(0.225, 0.042, 10, 26), deep, 'belt');
  belt.rotation.x = Math.PI / 2;
  belt.position.y = -0.19;
  chest.add(belt);
  const pack = meshOf(box(0.28, 0.3, 0.14), deep, 'pack');
  pack.position.set(0, 0.0, -0.26);
  chest.add(pack);
  const scarf = meshOf(new THREE.TorusGeometry(0.155, 0.045, 10, 26), mat(0xd9b24a, 0.6), 'scarf');
  scarf.rotation.x = Math.PI / 2;
  scarf.position.y = 0.21;
  chest.add(scarf);

  const head = new THREE.Group();
  head.position.y = 0.42;
  chest.add(head);
  head.add(meshOf(sph(0.21, 32), skin, 'head'));
  const hair = meshOf(sph(0.215, 26), mat(0x2f2620, 0.7), 'hair');
  hair.position.set(0, 0.01, -0.05);
  hair.scale.set(1, 1, 0.9);
  head.add(hair);

  // The brim is the silhouette. It reads at 30pt on a card and from any angle
  // the child can drag the camera to.
  const brim = meshOf(cyl(0.38, 0.38, 0.028, 30), kit, 'hat-brim');
  brim.position.y = 0.14;
  head.add(brim);
  const crown = meshOf(sph(0.19, 26), kit, 'hat-crown');
  crown.scale.set(1, 0.72, 1);
  crown.position.y = 0.2;
  head.add(crown);
  const band = meshOf(new THREE.TorusGeometry(0.185, 0.026, 10, 28), deep, 'hat-band');
  band.rotation.x = Math.PI / 2;
  band.position.y = 0.155;
  head.add(band);

  const eyes: THREE.Object3D[] = [];
  const brows: THREE.Object3D[] = [];
  ([-1, 1] as const).forEach((s) => {
    const e = faceEye(0.058);
    e.position.set(0.082 * s, -0.005, 0.185);
    head.add(e);
    eyes.push(e);
    const b = browMesh(0.08, 0x3c2f22);
    b.position.set(0.082 * s, 0.092, 0.188);
    head.add(b);
    brows.push(b);
  });
  const mouth = meshOf(cap(0.024, 0.075), dark, 'mouth');
  mouth.rotation.z = Math.PI / 2;
  mouth.position.set(0, -0.1, 0.195);
  head.add(mouth);

  const limbs: THREE.Object3D[] = [];
  ([-1, 1] as const).forEach((s) => {
    const p = new THREE.Group();
    p.position.set(0.225 * s, 0.09, 0);
    chest.add(p);
    const a = meshOf(cap(0.058, 0.2), shirt, 'arm');
    a.position.y = -0.14;
    p.add(a);
    const h = meshOf(sph(0.068, 16), skin, 'hand');
    h.position.y = -0.27;
    p.add(h);
    p.rotation.z = 0.3 * s;
    limbs.push(p);
  });
  ([-1, 1] as const).forEach((s) => {
    const p = new THREE.Group();
    p.position.set(0.1 * s, 0.3, 0);
    group.add(p);
    const l = meshOf(cap(0.068, 0.16), kit, 'leg');
    l.position.y = -0.12;
    p.add(l);
    const b = meshOf(box(0.13, 0.1, 0.19), mat(0x4a3b28, 0.7), 'boot');
    b.position.set(0, -0.24, 0.03);
    p.add(b);
    limbs.push(p);
  });

  return {
    group,
    parts: {
      chest,
      head,
      brows,
      eyes,
      mouth,
      limbs,
      wings: [],
      tail: undefined,
      root: group,
      mouthHinges: false,
      hovers: false,
    },
  };
};

const buildDada = (): Built => {
  const C = 0xb05c74;
  const KURTA = 0xece2d4;
  const SKIN = 0xe0b184;
  const BEARD = 0xf4f1ec;
  const group = new THREE.Group();
  const kurta = mat(KURTA, 0.7);
  const shawl = mat(C, 0.68);
  const skin = mat(SKIN, 0.55);
  const hair = mat(BEARD, 0.72);

  const chest = new THREE.Group();
  chest.position.y = 0.92;
  group.add(chest);
  const robe = meshOf(cyl(0.19, 0.34, 0.64, 26), kurta, 'kurta');
  robe.position.y = -0.26;
  chest.add(robe);
  chest.add(meshOf(cap(0.17, 0.15), kurta, 'bodice'));
  const drape = meshOf(sph(0.26, 26), shawl, 'shawl');
  drape.scale.set(1.04, 0.52, 0.86);
  drape.position.y = 0.07;
  chest.add(drape);
  const fall = meshOf(box(0.1, 0.52, 0.05), shawl, 'shawl-end');
  fall.position.set(0.19, -0.22, 0.09);
  chest.add(fall);

  const head = new THREE.Group();
  head.position.y = 0.4;
  chest.add(head);
  head.add(meshOf(sph(0.25, 32), skin, 'head'));

  // Cap, then beard, then moustache, then the mouth on top of the beard —
  // built in that order for the same reason the flat avatar is: a mouth drawn
  // before the beard is a mouth nobody ever sees.
  const cap1 = meshOf(cyl(0.2, 0.225, 0.15, 22), mat(0x5b4a55, 0.7), 'cap');
  cap1.position.y = 0.22;
  head.add(cap1);
  const rim = meshOf(cyl(0.222, 0.222, 0.05, 22), mat(0x46383f, 0.7), 'cap-rim');
  rim.position.y = 0.15;
  head.add(rim);

  const beard = meshOf(sph(0.21, 26), hair, 'beard');
  beard.scale.set(1, 1.18, 0.86);
  beard.position.set(0, -0.14, 0.05);
  head.add(beard);

  const mouth = meshOf(cap(0.024, 0.075), mat(0x7a4a42, 0.5), 'mouth');
  mouth.rotation.z = Math.PI / 2;
  mouth.position.set(0, -0.09, 0.215);
  head.add(mouth);

  const tache = meshOf(cap(0.03, 0.12), hair, 'moustache');
  tache.rotation.z = Math.PI / 2;
  tache.position.set(0, -0.025, 0.205);
  head.add(tache);

  const eyes: THREE.Object3D[] = [];
  const brows: THREE.Object3D[] = [];
  ([-1, 1] as const).forEach((s) => {
    const e = faceEye(0.062);
    e.position.set(0.1 * s, 0.035, 0.205);
    head.add(e);
    eyes.push(e);
    const b = browMesh(0.085, BEARD);
    b.position.set(0.1 * s, 0.128, 0.2);
    head.add(b);
    brows.push(b);
  });
  ([-1, 1] as const).forEach((s) => {
    const cheek = meshOf(sph(0.05, 14), mat(0xcf8a76, 0.6), 'cheek');
    cheek.position.set(0.165 * s, -0.035, 0.155);
    cheek.scale.set(1, 0.6, 0.4);
    head.add(cheek);
  });

  const limbs: THREE.Object3D[] = [];
  ([-1, 1] as const).forEach((s) => {
    const p = new THREE.Group();
    p.position.set(0.18 * s, 0.05, 0.02);
    chest.add(p);
    const a = meshOf(cap(0.05, 0.22), kurta, 'arm');
    a.position.y = -0.15;
    p.add(a);
    const h = meshOf(sph(0.062, 14), skin, 'hand');
    h.position.y = -0.29;
    p.add(h);
    p.rotation.z = 0.24 * s;
    limbs.push(p);
  });
  ([-1, 1] as const).forEach((s) => {
    const p = new THREE.Group();
    p.position.set(0.09 * s, 0.28, 0);
    group.add(p);
    const l = meshOf(cap(0.05, 0.14), mat(0xd6cab6, 0.75), 'leg');
    l.position.y = -0.1;
    p.add(l);
    const f = meshOf(sph(0.075, 14), mat(0x6b4a34, 0.6), 'sandal');
    f.position.set(0, -0.2, 0.03);
    f.scale.set(1, 0.42, 1.35);
    p.add(f);
    limbs.push(p);
  });

  // The stick stays put while the hand swings past it. A stick parented to a
  // swinging arm sweeps the floor, which reads as a fall rather than a lean.
  const stick = meshOf(cyl(0.017, 0.021, 0.78, 10), mat(0x8a5f3c, 0.8), 'stick');
  stick.position.set(0.27, 0.39, 0.06);
  stick.rotation.z = 0.06;
  group.add(stick);

  return {
    group,
    parts: {
      chest,
      head,
      brows,
      eyes,
      mouth,
      limbs,
      wings: [],
      tail: undefined,
      root: group,
      mouthHinges: false,
      hovers: false,
    },
  };
};

const BUILDERS: Readonly<Record<CharacterSlug, () => Built>> = {
  'buddy-the-dog': buildBuddy,
  'lily-the-fairy': buildLily,
  'captain-sky': buildSky,
  'professor-owl': buildOwl,
  'pip-the-fox': buildPip,
  'nano-the-robot': buildNano,
  'mira-the-moon': buildMira,
  'captain-zia': buildZia,
  'dada-jee': buildDada,
};

export const buildCharacter = (slug: CharacterSlug): Built => BUILDERS[slug]();

/* ---------- sets ---------- */

const groundDisc = (color: number, r: number): THREE.Mesh => {
  const g = meshOf(new THREE.CircleGeometry(r, 56), mat(color, 0.9), 'ground');
  g.rotation.x = -Math.PI / 2;
  g.position.y = 0.001;
  return g;
};

/** The bounce colour under each set — grass, moss, hull plating, floorboards. */
const GROUND_COLOR: Readonly<Record<CharacterSlug, number>> = {
  'buddy-the-dog': 0x8fc46b,
  'lily-the-fairy': 0x77b48a,
  'captain-sky': 0x8d9bb5,
  'professor-owl': 0xa97f57,
  'pip-the-fox': 0xc9a64a,
  'nano-the-robot': 0x9aa3ad,
  'mira-the-moon': 0x8f97d6,
  'captain-zia': 0x6f8f4a,
  'dada-jee': 0xb08a63,
};

export const buildSet = (slug: CharacterSlug): THREE.Group => {
  const s = new THREE.Group();
  s.name = 'set';
  s.add(groundDisc(GROUND_COLOR[slug], 5.2));

  if (slug === 'buddy-the-dog') {
    const rail = mat(0xe8cf9f, 0.75);
    for (let i = -4; i <= 4; i += 1) {
      const p = meshOf(box(0.13, 0.9, 0.06), rail, 'fence-picket');
      p.position.set(i * 0.42, 0.45, -2.2);
      s.add(p);
      const capMesh = meshOf(cyl(0.07, 0.07, 0.09, 6), rail, 'picket-cap');
      capMesh.position.set(i * 0.42, 0.93, -2.2);
      s.add(capMesh);
    }
    (
      [
        [-1.5, -1.5, 0.5],
        [1.7, -1.2, 0.42],
        [1.2, 1.5, 0.34],
      ] as const
    ).forEach(([x, z, r]) => {
      const b = meshOf(sph(r, 20), mat(0x5e9b46, 0.85), 'bush');
      b.position.set(x, r * 0.72, z);
      b.scale.y = 0.8;
      s.add(b);
    });
    const bone = meshOf(cap(0.05, 0.22), mat(0xf4ead6, 0.7), 'bone');
    bone.rotation.set(0, 0.4, Math.PI / 2);
    bone.position.set(0.95, 0.06, 0.75);
    s.add(bone);
  } else if (slug === 'lily-the-fairy') {
    (
      [
        [-1.9, -1.4, 1],
        [2.0, -1.7, 0.85],
        [-2.3, 0.6, 0.7],
      ] as const
    ).forEach(([x, z, k]) => {
      const t = meshOf(cyl(0.16 * k, 0.24 * k, 2.4 * k, 14), mat(0x7a5c42, 0.85), 'trunk');
      t.position.set(x, 1.2 * k, z);
      s.add(t);
      const c1 = meshOf(sph(0.95 * k, 22), mat(0x4e8f63, 0.9), 'canopy');
      c1.position.set(x, 2.5 * k, z);
      s.add(c1);
      const c2 = meshOf(sph(0.6 * k, 18), mat(0x63a877, 0.9), 'canopy');
      c2.position.set(x + 0.5 * k, 2.1 * k, z + 0.3);
      s.add(c2);
    });
    (
      [
        [0.85, 0.7, 0.16],
        [1.05, 0.45, 0.1],
        [-0.95, 0.9, 0.13],
      ] as const
    ).forEach(([x, z, r]) => {
      const st = meshOf(cyl(r * 0.4, r * 0.5, r * 1.6, 12), mat(0xf6ecd9, 0.8), 'mushroom-stem');
      st.position.set(x, r * 0.8, z);
      s.add(st);
      const cp = meshOf(sph(r, 18), mat(0xd8607a, 0.7), 'mushroom-cap');
      cp.position.set(x, r * 1.65, z);
      cp.scale.y = 0.6;
      s.add(cp);
    });
    for (let i = 0; i < 14; i += 1) {
      const f = meshOf(
        sph(0.035, 8),
        mat(0xfff3c4, 0.2, 0, { emissive: 0xffe9a0, emissiveIntensity: 0.9 }),
        'firefly',
      );
      f.position.set(
        (Math.random() - 0.5) * 4,
        0.6 + Math.random() * 1.8,
        (Math.random() - 0.5) * 3,
      );
      s.add(f);
    }
  } else if (slug === 'captain-sky') {
    const ground = s.children[0];
    if (ground !== undefined) ground.visible = false;
    const plat = meshOf(cyl(1.12, 1.3, 0.18, 8), mat(0xb9c4d4, 0.5, 0.35), 'platform');
    plat.position.y = -0.09;
    s.add(plat);
    const inlay = meshOf(cyl(0.6, 0.6, 0.03, 8), mat(0x5f7aa2, 0.45, 0.3), 'platform-inlay');
    inlay.position.y = 0.012;
    s.add(inlay);
    for (let i = 0; i < 10; i += 1) {
      const a = (i / 10) * Math.PI * 2;
      const p = meshOf(cyl(0.03, 0.03, 0.3, 8), mat(0x8fa3c2, 0.4, 0.4), 'rail-post');
      p.position.set(Math.cos(a) * 1.02, 0.15, Math.sin(a) * 1.02);
      s.add(p);
    }
    const rail = meshOf(
      new THREE.TorusGeometry(1.02, 0.032, 8, 44),
      mat(0xdce6f4, 0.35, 0.5),
      'rail',
    );
    rail.rotation.x = Math.PI / 2;
    rail.position.y = 0.3;
    s.add(rail);
    const planet = meshOf(sph(1.05, 30), mat(0xd8825f, 0.8), 'planet');
    planet.position.set(-3.6, 1.15, -7.2);
    s.add(planet);
    const ring = meshOf(
      new THREE.TorusGeometry(1.65, 0.075, 8, 48),
      mat(0xe6c294, 0.6),
      'planet-ring',
    );
    ring.rotation.set(1.28, 0.3, 0.22);
    ring.position.copy(planet.position);
    s.add(ring);
    for (let i = 0; i < 90; i += 1) {
      const st = meshOf(
        sph(0.03 + Math.random() * 0.03, 6),
        mat(0xffffff, 0.2, 0, { emissive: 0xffffff, emissiveIntensity: 0.7 }),
        'star',
      );
      const R = 9 + Math.random() * 4;
      const th = Math.random() * Math.PI * 2;
      const ph = Math.random() * 0.9;
      st.position.set(
        Math.cos(th) * R * Math.cos(ph),
        1 + Math.sin(ph) * R * 0.7,
        Math.sin(th) * R * Math.cos(ph),
      );
      s.add(st);
    }
  } else if (slug === 'professor-owl') {
    const rug = meshOf(new THREE.CircleGeometry(2.0, 40), mat(0xb85c52, 0.9), 'rug');
    rug.rotation.x = -Math.PI / 2;
    rug.position.y = 0.003;
    s.add(rug);
    const wood = mat(0x8a5f3c, 0.8);
    const back = meshOf(box(5.0, 3.2, 0.25), wood, 'shelf-back');
    back.position.set(0, 1.6, -2.3);
    s.add(back);
    const spines = [0xd8607a, 0x3d8ce0, 0xe8a33d, 0x6b4a8f, 0x3fa37a, 0xb85c52, 0xf2a03d];
    for (let r = 0; r < 3; r += 1) {
      const shelf = meshOf(box(4.6, 0.1, 0.5), mat(0x6f4a2e, 0.8), 'shelf');
      shelf.position.set(0, 0.55 + r * 1.0, -2.05);
      s.add(shelf);
      for (let i = 0; i < 18; i += 1) {
        const h = 0.5 + Math.random() * 0.22;
        const spine = spines[(i + r) % spines.length] ?? 0xd8607a;
        const bk = meshOf(box(0.16 + Math.random() * 0.08, h, 0.34), mat(spine, 0.75), 'book');
        bk.position.set(-2.1 + i * 0.245, 0.6 + r * 1.0 + h / 2, -2.02);
        bk.rotation.z = Math.random() < 0.12 ? 0.22 : 0;
        s.add(bk);
      }
    }
    const table = meshOf(cyl(0.55, 0.5, 0.09, 20), wood, 'table');
    table.position.set(1.5, 0.62, 0.5);
    s.add(table);
    const post = meshOf(cyl(0.09, 0.13, 0.62, 12), wood, 'table-post');
    post.position.set(1.5, 0.31, 0.5);
    s.add(post);
    const shade = meshOf(
      cyl(0.1, 0.26, 0.3, 18),
      mat(0xf7d98a, 0.5, 0, { emissive: 0xffdf9e, emissiveIntensity: 0.55 }),
      'lamp-shade',
    );
    shade.position.set(1.5, 0.92, 0.5);
    s.add(shade);
  } else if (slug === 'pip-the-fox') {
    /* An autumn meadow. Warm and low — no canopy over the character, because
     * Pip is for the youngest children and a dark set above a small face is
     * the one thing that makes a diorama read as somewhere else rather than
     * as somewhere nice. */
    const bark = mat(0x8a6a4a, 0.85);
    const log = meshOf(cyl(0.34, 0.36, 1.9, 16), bark, 'log');
    log.rotation.set(0, 0.3, Math.PI / 2);
    log.position.set(-1.7, 0.34, -0.7);
    s.add(log);
    const hollow = meshOf(cyl(0.24, 0.24, 0.06, 16), mat(0x4a3526, 0.9), 'log-hollow');
    hollow.rotation.set(0, 0.3, Math.PI / 2);
    hollow.position.set(-0.78, 0.34, -0.42);
    s.add(hollow);

    const grass = mat(0xa8b84a, 0.9);
    for (let i = 0; i < 26; i += 1) {
      const a = (i / 26) * Math.PI * 2;
      const r = 1.9 + Math.random() * 2.6;
      const blade = meshOf(cyl(0.004, 0.035, 0.5 + Math.random() * 0.45, 6), grass, 'grass');
      blade.position.set(Math.cos(a) * r, 0.3, Math.sin(a) * r);
      blade.rotation.z = (Math.random() - 0.5) * 0.4;
      s.add(blade);
    }

    (
      [
        [1.35, -0.9, 0.15],
        [1.6, -0.55, 0.1],
        [-1.1, 1.2, 0.12],
      ] as const
    ).forEach(([x, z, r]) => {
      const st = meshOf(cyl(r * 0.4, r * 0.5, r * 1.7, 12), mat(0xf6ecd9, 0.8), 'toadstool-stem');
      st.position.set(x, r * 0.85, z);
      s.add(st);
      const cp = meshOf(sph(r, 18), mat(0xe06a4a, 0.7), 'toadstool-cap');
      cp.position.set(x, r * 1.75, z);
      cp.scale.y = 0.58;
      s.add(cp);
    });

    // Leaves on the ground, and four more still coming down. The airborne ones
    // are the set's only moving parts a child can point at and name.
    const leafColours = [0xe0603d, 0xd9a03d, 0xb8472a, 0xc9a64a];
    for (let i = 0; i < 22; i += 1) {
      const colour = leafColours[i % leafColours.length] ?? 0xe0603d;
      const leaf = meshOf(sph(0.1, 10), mat(colour, 0.8), 'leaf');
      leaf.scale.set(1, 0.12, 0.62);
      const a = Math.random() * Math.PI * 2;
      const r = 0.9 + Math.random() * 3.2;
      leaf.position.set(Math.cos(a) * r, 0.015, Math.sin(a) * r);
      leaf.rotation.y = Math.random() * Math.PI;
      s.add(leaf);
    }

    (
      [
        [-2.4, -2.1, 1],
        [2.5, -2.4, 0.86],
        [2.9, 0.8, 0.7],
      ] as const
    ).forEach(([x, z, k]) => {
      const t = meshOf(cyl(0.13 * k, 0.2 * k, 2.2 * k, 12), mat(0xe8e0d2, 0.85), 'birch-trunk');
      t.position.set(x, 1.1 * k, z);
      s.add(t);
      const c1 = meshOf(sph(0.85 * k, 20), mat(0xd9a03d, 0.9), 'birch-canopy');
      c1.position.set(x, 2.3 * k, z);
      c1.scale.y = 0.82;
      s.add(c1);
      const c2 = meshOf(sph(0.55 * k, 16), mat(0xe0603d, 0.9), 'birch-canopy');
      c2.position.set(x + 0.45 * k, 1.95 * k, z + 0.3);
      s.add(c2);
    });
  } else if (slug === 'nano-the-robot') {
    /* A workshop, lit from inside. Everything Nano talks about — how a thing
     * works — is a thing that is visibly in the room with him. */
    const steel = mat(0xb4bcc6, 0.45, 0.35);
    const painted = mat(0x2f6d75, 0.55, 0.15);

    const wall = meshOf(box(6.0, 3.4, 0.2), mat(0x5d7a82, 0.7), 'pegboard');
    wall.position.set(0, 1.7, -2.5);
    s.add(wall);
    for (let i = 0; i < 9; i += 1) {
      const hook = meshOf(cyl(0.02, 0.02, 0.18, 6), steel, 'peg');
      hook.rotation.x = Math.PI / 2;
      hook.position.set(-2.2 + i * 0.55, 2.35, -2.36);
      s.add(hook);
      const tool =
        i % 3 === 0
          ? meshOf(box(0.1, 0.44, 0.06), steel, 'tool')
          : meshOf(cyl(0.05, 0.07, 0.4, 10), painted, 'tool');
      tool.position.set(-2.2 + i * 0.55, 2.1, -2.3);
      s.add(tool);
    }

    const benchTop = meshOf(box(2.6, 0.12, 0.8), mat(0x9a6f45, 0.8), 'bench-top');
    benchTop.position.set(-1.7, 0.82, -1.4);
    s.add(benchTop);
    (
      [
        [-2.8, -1.7],
        [-0.7, -1.7],
        [-2.8, -1.1],
        [-0.7, -1.1],
      ] as const
    ).forEach(([x, z]) => {
      const leg = meshOf(box(0.1, 0.78, 0.1), steel, 'bench-leg');
      leg.position.set(x, 0.39, z);
      s.add(leg);
    });

    (
      [
        [1.9, -1.5, 0.5],
        [2.3, -0.9, 0.36],
        [1.75, -1.0, 0.3],
      ] as const
    ).forEach(([x, z, k]) => {
      const crate = meshOf(box(k, k, k), mat(0xc79a5e, 0.85), 'crate');
      crate.position.set(x, k / 2, z);
      crate.rotation.y = Math.random() * 0.5;
      s.add(crate);
    });

    // Cogs hanging in the air. They are the only thing in the set that is not
    // sitting on something, which is what makes the room feel busy.
    (
      [
        [-1.3, 1.9, -1.0, 0.26],
        [1.4, 2.25, -1.4, 0.19],
        [0.3, 2.55, -1.8, 0.15],
      ] as const
    ).forEach(([x, y, z, r]) => {
      const cog = meshOf(new THREE.TorusGeometry(r, r * 0.3, 8, 14), painted, 'cog');
      cog.position.set(x, y, z);
      cog.rotation.set(0.4, 0.3, 0.2);
      s.add(cog);
      const hub = meshOf(cyl(r * 0.28, r * 0.28, r * 0.5, 10), steel, 'cog-hub');
      hub.rotation.set(0.4 + Math.PI / 2, 0.3, 0.2);
      hub.position.set(x, y, z);
      s.add(hub);
    });

    const shade = meshOf(
      cyl(0.12, 0.42, 0.34, 20),
      mat(0xf7d98a, 0.5, 0, { emissive: 0xffe9b0, emissiveIntensity: 0.7 }),
      'lamp-shade',
    );
    shade.position.set(0.4, 2.55, -0.4);
    s.add(shade);
    const flex = meshOf(cyl(0.015, 0.015, 0.9, 6), steel, 'lamp-flex');
    flex.position.set(0.4, 3.15, -0.4);
    s.add(flex);
  } else if (slug === 'mira-the-moon') {
    /* Above the clouds, at night. The ground disc is hidden the same way
     * Captain Sky's is: a circle of grass under a moon is the one detail that
     * would say "this is a room with a poster in it". */
    const ground = s.children[0];
    if (ground !== undefined) ground.visible = false;

    const cloudMat = mat(0xe9ecff, 0.95, 0, { transparent: true, opacity: 0.96 });
    const puff = (x: number, y: number, z: number, r: number, name: string): void => {
      const p = meshOf(sph(r, 18), cloudMat, name);
      p.position.set(x, y, z);
      p.scale.set(1, 0.62, 0.92);
      s.add(p);
    };
    // The platform: one bank of cloud she stands on, built wide enough that the
    // camera never finds its edge at the zoom a child can pinch to.
    (
      [
        [0, -0.28, 0, 1.15],
        [-0.85, -0.34, 0.3, 0.8],
        [0.9, -0.33, 0.15, 0.85],
        [0.15, -0.36, -0.85, 0.75],
        [-0.5, -0.38, -0.7, 0.62],
      ] as const
    ).forEach(([x, y, z, r]) => {
      puff(x, y, z, r, 'platform-cloud');
    });
    (
      [
        [-3.2, 0.9, -3.4, 0.95],
        [-2.5, 0.75, -3.1, 0.7],
        [3.4, 1.4, -3.8, 1.05],
        [2.6, 1.25, -3.5, 0.78],
        [0.4, 2.3, -5.2, 1.2],
      ] as const
    ).forEach(([x, y, z, r]) => {
      puff(x, y, z, r, 'far-cloud');
    });

    for (let i = 0; i < 80; i += 1) {
      const st = meshOf(
        sph(0.028 + Math.random() * 0.032, 6),
        mat(0xffffff, 0.2, 0, { emissive: 0xfff1c0, emissiveIntensity: 0.8 }),
        'star',
      );
      const R = 8 + Math.random() * 4;
      const th = Math.random() * Math.PI * 2;
      const ph = Math.random() * 0.95;
      st.position.set(
        Math.cos(th) * R * Math.cos(ph),
        1 + Math.sin(ph) * R * 0.75,
        Math.sin(th) * R * Math.cos(ph),
      );
      s.add(st);
    }

    // Lanterns on threads. Warm points at a child's eye height, so the set has
    // something close as well as something infinitely far.
    (
      [
        [-1.55, 1.5, 0.5],
        [1.7, 1.85, -0.2],
        [0.9, 1.35, 1.0],
      ] as const
    ).forEach(([x, y, z]) => {
      const thread = meshOf(cyl(0.006, 0.006, 1.6, 6), mat(0xb9c0e8, 0.7), 'lantern-thread');
      thread.position.set(x, y + 0.9, z);
      s.add(thread);
      const glass = meshOf(
        sph(0.15, 16),
        mat(0xffe6a8, 0.25, 0, { emissive: 0xffd98a, emissiveIntensity: 1.1 }),
        'lantern',
      );
      glass.position.set(x, y, z);
      glass.scale.y = 1.25;
      s.add(glass);
    });

    const planet = meshOf(sph(1.0, 30), mat(0x4f7fc4, 0.85), 'planet');
    planet.position.set(-3.9, 2.0, -7.6);
    s.add(planet);
    const landmass = meshOf(sph(1.01, 26), mat(0x5fa06b, 0.9), 'planet-land');
    landmass.scale.set(0.55, 0.45, 0.55);
    landmass.position.set(-3.55, 2.3, -7.0);
    s.add(landmass);
  } else if (slug === 'captain-zia') {
    /* A river jetty, with the boat already tied up. The expedition has not
     * left yet, which is the point: the child decides where it goes. */
    const water = meshOf(
      new THREE.CircleGeometry(4.2, 44),
      mat(0x2f7e86, 0.25, 0.1, { transparent: true, opacity: 0.9 }),
      'water',
    );
    water.rotation.x = -Math.PI / 2;
    water.position.set(0.4, 0.02, -3.4);
    s.add(water);

    const plank = mat(0xa97f57, 0.85);
    for (let i = 0; i < 7; i += 1) {
      const p = meshOf(box(1.7, 0.08, 0.28), plank, 'jetty-plank');
      p.position.set(0.3, 0.16, -0.7 - i * 0.32);
      s.add(p);
    }
    (
      [
        [-0.5, -0.6],
        [1.1, -0.6],
        [-0.5, -2.5],
        [1.1, -2.5],
      ] as const
    ).forEach(([x, z]) => {
      const post = meshOf(cyl(0.08, 0.09, 0.5, 10), mat(0x7a5c42, 0.9), 'jetty-post');
      post.position.set(x, 0.1, z);
      s.add(post);
    });

    const hull = meshOf(sph(0.62, 22), mat(0xd9b24a, 0.6), 'boat-hull');
    hull.scale.set(0.55, 0.42, 1.5);
    hull.position.set(1.95, 0.24, -2.1);
    hull.rotation.y = 0.22;
    s.add(hull);
    const mast = meshOf(cyl(0.035, 0.045, 1.25, 10), plank, 'mast');
    mast.position.set(1.95, 0.9, -2.1);
    s.add(mast);
    const sail = meshOf(box(0.06, 0.7, 0.62), mat(0xf2ead6, 0.8), 'sail');
    sail.position.set(2.0, 1.1, -1.85);
    sail.rotation.y = 0.22;
    s.add(sail);

    const reed = mat(0x5f8f3a, 0.9);
    for (let i = 0; i < 18; i += 1) {
      const a = Math.random() * Math.PI * 2;
      const r = 2.6 + Math.random() * 1.6;
      const blade = meshOf(cyl(0.005, 0.03, 0.9 + Math.random() * 0.6, 6), reed, 'reed');
      blade.position.set(Math.cos(a) * r, 0.5, -1.6 + Math.sin(a) * r * 0.5);
      blade.rotation.z = (Math.random() - 0.5) * 0.35;
      s.add(blade);
    }

    (
      [
        [-2.6, 0.9, 1],
        [2.9, 1.4, 0.85],
        [-3.0, -1.2, 0.7],
      ] as const
    ).forEach(([x, z, k]) => {
      const t = meshOf(cyl(0.12 * k, 0.2 * k, 2.6 * k, 12), mat(0x7a5c42, 0.88), 'palm-trunk');
      t.position.set(x, 1.3 * k, z);
      t.rotation.z = 0.1 * (x > 0 ? -1 : 1);
      s.add(t);
      for (let f = 0; f < 5; f += 1) {
        const a = (f / 5) * Math.PI * 2;
        const frond = meshOf(sph(0.62 * k, 14), mat(0x4e8f4a, 0.9), 'frond');
        frond.scale.set(1, 0.14, 0.34);
        frond.position.set(x + Math.cos(a) * 0.5 * k, 2.55 * k, z + Math.sin(a) * 0.5 * k);
        frond.rotation.set(0, -a, 0.22);
        s.add(frond);
      }
    });

    const crate = meshOf(box(0.46, 0.46, 0.46), mat(0xc79a5e, 0.85), 'crate');
    crate.position.set(-1.35, 0.23, 0.55);
    crate.rotation.y = 0.35;
    s.add(crate);
    const lamp = meshOf(
      sph(0.14, 14),
      mat(0xffe6a8, 0.25, 0, { emissive: 0xffd98a, emissiveIntensity: 1 }),
      'jetty-lamp',
    );
    lamp.position.set(-0.5, 1.1, -0.6);
    s.add(lamp);
  } else {
    /* A courtyard at dusk, with the charpai already pulled out. Everything in
     * it is something to sit on, eat from, or sit under — which is the whole
     * of what happens in it. */
    const rug = meshOf(new THREE.CircleGeometry(1.9, 44), mat(0x9c4a58, 0.9), 'rug');
    rug.rotation.x = -Math.PI / 2;
    rug.position.y = 0.004;
    s.add(rug);
    (
      [
        [1.5, 0xd9b24a],
        [1.1, 0x9c4a58],
        [0.7, 0xe8d6b8],
      ] as const
    ).forEach(([r, colour], i) => {
      const ring = meshOf(new THREE.CircleGeometry(r, 40), mat(colour, 0.9), 'rug-ring');
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.006 + i * 0.002;
      s.add(ring);
    });

    const wood = mat(0x8a5f3c, 0.82);
    const frame = meshOf(box(1.7, 0.1, 1.0), mat(0xd6c39a, 0.85), 'charpai-weave');
    frame.position.set(-1.75, 0.42, -0.5);
    s.add(frame);
    (
      [
        [-2.5, -0.95],
        [-1.0, -0.95],
        [-2.5, -0.05],
        [-1.0, -0.05],
      ] as const
    ).forEach(([x, z]) => {
      const leg = meshOf(cyl(0.07, 0.08, 0.42, 10), wood, 'charpai-leg');
      leg.position.set(x, 0.21, z);
      s.add(leg);
    });

    const trunk = meshOf(cyl(0.38, 0.52, 2.6, 16), mat(0x6f5138, 0.9), 'banyan-trunk');
    trunk.position.set(2.5, 1.3, -1.9);
    s.add(trunk);
    (
      [
        [2.5, 3.0, -1.9, 1.35],
        [1.5, 2.7, -1.5, 0.9],
        [3.4, 2.8, -2.4, 1.0],
      ] as const
    ).forEach(([x, y, z, r]) => {
      const canopy = meshOf(sph(r, 22), mat(0x3f7a4a, 0.92), 'banyan-canopy');
      canopy.position.set(x, y, z);
      canopy.scale.y = 0.72;
      s.add(canopy);
    });
    for (let i = 0; i < 7; i += 1) {
      const root = meshOf(cyl(0.02, 0.026, 1.1 + Math.random() * 0.7, 6), wood, 'aerial-root');
      root.position.set(1.6 + Math.random() * 1.9, 1.95, -1.2 - Math.random() * 1.2);
      s.add(root);
    }

    const wall = meshOf(box(5.6, 1.5, 0.22), mat(0xd8b98c, 0.9), 'courtyard-wall');
    wall.position.set(-0.4, 0.75, -2.7);
    s.add(wall);
    for (let i = 0; i < 6; i += 1) {
      const niche = meshOf(box(0.26, 0.34, 0.06), mat(0xb9945f, 0.9), 'wall-niche');
      niche.position.set(-2.4 + i * 0.8, 1.05, -2.57);
      s.add(niche);
    }

    // The string of lights across the courtyard. Dusk is the character: the
    // lanterns are what make it dusk rather than dark.
    for (let i = 0; i < 7; i += 1) {
      const t = i / 6;
      const lantern = meshOf(
        sph(0.11, 14),
        mat(0xffdc96, 0.25, 0, { emissive: 0xffc46a, emissiveIntensity: 1.1 }),
        'lantern',
      );
      // A slack line between the wall and the tree, not a straight one.
      lantern.position.set(-2.3 + t * 4.6, 2.1 - Math.sin(t * Math.PI) * 0.45, -2.2);
      s.add(lantern);
    }

    const stool = meshOf(cyl(0.26, 0.24, 0.34, 14), wood, 'stool');
    stool.position.set(1.15, 0.17, 0.7);
    s.add(stool);
    const pot = meshOf(sph(0.18, 18), mat(0xc2ccd4, 0.45, 0.35), 'chai-pot');
    pot.scale.y = 0.85;
    pot.position.set(1.15, 0.45, 0.7);
    s.add(pot);
    const spout = meshOf(cyl(0.025, 0.04, 0.2, 8), mat(0xc2ccd4, 0.45, 0.35), 'chai-spout');
    spout.rotation.z = -0.9;
    spout.position.set(1.36, 0.5, 0.7);
    s.add(spout);
  }

  return s;
};

/**
 * The soft blob of shadow under a character's feet.
 *
 * The design draws this as a canvas-textured radial gradient — a DOM API this
 * app's JS runtime does not have (no `document`, no 2D canvas). A tiny
 * fragment shader reproduces the same two-stop gradient
 * (rgba(58,42,20,.42) → rgba(58,42,20,.16) → transparent) without one.
 */
export const buildContactShadow = (radius: number): THREE.Mesh => {
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec2 vUv;
      void main() {
        float d = distance(vUv, vec2(0.5));
        float a;
        if (d < 0.275) {
          a = mix(0.42, 0.16, d / 0.275);
        } else {
          a = mix(0.16, 0.0, clamp((d - 0.275) / 0.225, 0.0, 1.0));
        }
        gl_FragColor = vec4(0.227, 0.165, 0.078, max(a, 0.0));
      }
    `,
  });
  const shadowMesh = meshOf(
    new THREE.PlaneGeometry(radius * 2, radius * 2),
    material,
    'contact-shadow',
  );
  shadowMesh.rotation.x = -Math.PI / 2;
  shadowMesh.position.y = 0.012;
  return shadowMesh;
};
