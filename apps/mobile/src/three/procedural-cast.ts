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

const meshOf = (geometry: THREE.BufferGeometry, material: THREE.Material, name = ''): THREE.Mesh => {
  const m = new THREE.Mesh(geometry, material);
  m.name = name;
  return m;
};

const sph = (r: number, seg = 32): THREE.SphereGeometry => new THREE.SphereGeometry(r, seg, seg / 2);
const cap = (r: number, l: number): THREE.CapsuleGeometry => new THREE.CapsuleGeometry(r, l, 8, 24);
const cyl = (rt: number, rb: number, h: number, seg = 20): THREE.CylinderGeometry =>
  new THREE.CylinderGeometry(rt, rb, h, seg);
const box = (w: number, h: number, d: number): THREE.BoxGeometry => new THREE.BoxGeometry(w, h, d, 1, 1, 1);

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
  ([
    [-0.19, 0.22],
    [0.19, 0.22],
    [-0.19, -0.22],
    [0.19, -0.22],
  ] as const).forEach(([x, z]) => {
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
  const collar = meshOf(new THREE.TorusGeometry(0.17, 0.035, 10, 28), mat(0xf7e6a8, 0.4, 0.25), 'collar');
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
    const ring = meshOf(new THREE.TorusGeometry(0.105, 0.022, 10, 26), mat(0xf7e6a8, 0.5), 'eye-ring');
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

const BUILDERS: Readonly<Record<CharacterSlug, () => Built>> = {
  'buddy-the-dog': buildBuddy,
  'lily-the-fairy': buildLily,
  'captain-sky': buildSky,
  'professor-owl': buildOwl,
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
    ([
      [-1.5, -1.5, 0.5],
      [1.7, -1.2, 0.42],
      [1.2, 1.5, 0.34],
    ] as const).forEach(([x, z, r]) => {
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
    ([
      [-1.9, -1.4, 1],
      [2.0, -1.7, 0.85],
      [-2.3, 0.6, 0.7],
    ] as const).forEach(([x, z, k]) => {
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
    ([
      [0.85, 0.7, 0.16],
      [1.05, 0.45, 0.1],
      [-0.95, 0.9, 0.13],
    ] as const).forEach(([x, z, r]) => {
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
      f.position.set((Math.random() - 0.5) * 4, 0.6 + Math.random() * 1.8, (Math.random() - 0.5) * 3);
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
    const rail = meshOf(new THREE.TorusGeometry(1.02, 0.032, 8, 44), mat(0xdce6f4, 0.35, 0.5), 'rail');
    rail.rotation.x = Math.PI / 2;
    rail.position.y = 0.3;
    s.add(rail);
    const planet = meshOf(sph(1.05, 30), mat(0xd8825f, 0.8), 'planet');
    planet.position.set(-3.6, 1.15, -7.2);
    s.add(planet);
    const ring = meshOf(new THREE.TorusGeometry(1.65, 0.075, 8, 48), mat(0xe6c294, 0.6), 'planet-ring');
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
      st.position.set(Math.cos(th) * R * Math.cos(ph), 1 + Math.sin(ph) * R * 0.7, Math.sin(th) * R * Math.cos(ph));
      s.add(st);
    }
  } else {
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
  const shadowMesh = meshOf(new THREE.PlaneGeometry(radius * 2, radius * 2), material, 'contact-shadow');
  shadowMesh.rotation.x = -Math.PI / 2;
  shadowMesh.position.y = 0.012;
  return shadowMesh;
};
