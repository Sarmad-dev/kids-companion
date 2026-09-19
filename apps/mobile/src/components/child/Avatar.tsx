import { memo } from 'react';
import Svg, { Circle, Ellipse, G, Path, Rect } from 'react-native-svg';

import {
  castMember,
  DEFAULT_CHARACTER,
  isCharacterSlug,
  type CharacterSlug,
} from '../../theme/child-theme';

/**
 * The nine-character cast, as flat art.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS GEOMETRY AND NOT AN EMOJI, AND NOT A PNG
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * These appear at 30pt on a parent's child-list row and at 200pt on a child's
 * splash screen — the same drawing, seven times the size. FILLS ONLY, no
 * strokes: a stroke width that reads at 132pt is a smear at 30pt and a hairline
 * at 200pt, so there are none, and the shapes hold at every size in between.
 *
 * An emoji would have been the cheap version of this and is what the app used
 * to do. It fails twice: the glyph is a different drawing on every platform and
 * OS version, so the character a child recognises is not stable; and there is
 * no emoji for "Captain Sky" at all, which is how 🚀 came to stand in for a
 * person. A child navigates this app by face. The face has to be ours.
 *
 * The 3D diorama on the conversation screen is the same cast rendered from
 * `.glb` — see `src/three/Diorama.tsx`. This is the flat register: lists,
 * grids, loading states, and every screen where a live GL context would be
 * eight contexts for no benefit a still face does not already give.
 */

export interface AvatarProps {
  readonly slug: string | undefined;
  readonly size?: number;
  readonly testID?: string;
}

const BUDDY = (
  <G>
    <Ellipse cx={15} cy={40} rx={12} ry={21} fill="#d9822b" />
    <Ellipse cx={85} cy={40} rx={12} ry={21} fill="#d9822b" />
    <Circle cx={50} cy={50} r={48} fill="#f2a03d" />
    <Rect x={28} y={30} width={15} height={4.5} rx={2.25} fill="#c9762a" />
    <Rect x={57} y={30} width={15} height={4.5} rx={2.25} fill="#c9762a" />
    <Ellipse cx={50} cy={66} rx={23} ry={17} fill="#ffe3bd" />
    <Circle cx={36} cy={45} r={7} fill="#ffffff" />
    <Circle cx={64} cy={45} r={7} fill="#ffffff" />
    <Circle cx={36.5} cy={46} r={3.8} fill="#1a1c1f" />
    <Circle cx={64.5} cy={46} r={3.8} fill="#1a1c1f" />
    <Ellipse cx={50} cy={59} rx={7} ry={5.5} fill="#2b2118" />
    <Path d="M39 70 Q50 79 61 70 Q50 74.5 39 70 Z" fill="#2b2118" />
  </G>
);

const LILY = (
  <G>
    <Ellipse cx={9} cy={44} rx={11} ry={24} fill="#e4d4f7" />
    <Ellipse cx={91} cy={44} rx={11} ry={24} fill="#e4d4f7" />
    <Circle cx={50} cy={50} r={48} fill="#a978d8" />
    <Circle cx={50} cy={45} r={42} fill="#6b4a8f" />
    <Circle cx={50} cy={58} r={34} fill="#f3d3b6" />
    <Rect x={27} y={42} width={13} height={4} rx={2} fill="#9d78c4" />
    <Rect x={60} y={42} width={13} height={4} rx={2} fill="#9d78c4" />
    <Circle cx={34} cy={55} r={6.4} fill="#ffffff" />
    <Circle cx={66} cy={55} r={6.4} fill="#ffffff" />
    <Circle cx={34.5} cy={56} r={3.4} fill="#1a1c1f" />
    <Circle cx={66.5} cy={56} r={3.4} fill="#1a1c1f" />
    <Ellipse cx={24} cy={66} rx={6} ry={4} fill="#f0a9b4" />
    <Ellipse cx={76} cy={66} rx={6} ry={4} fill="#f0a9b4" />
    <Path d="M42 70 Q50 78 58 70 Q50 73.5 42 70 Z" fill="#7a4a52" />
    <Circle cx={50} cy={14} r={6} fill="#f7e6a8" />
  </G>
);

const SKY = (
  <G>
    <Circle cx={50} cy={50} r={48} fill="#3d8ce0" />
    <Circle cx={50} cy={50} r={41} fill="#dcefff" />
    <Circle cx={50} cy={53} r={31} fill="#d9a06b" />
    <Ellipse
      cx={33}
      cy={30}
      rx={13}
      ry={8}
      fill="#ffffff"
      opacity={0.55}
      transform="rotate(-28 33 30)"
    />
    <Rect x={30} y={40} width={13} height={4} rx={2} fill="#54402c" />
    <Rect x={57} y={40} width={13} height={4} rx={2} fill="#54402c" />
    <Circle cx={36} cy={51} r={6.2} fill="#ffffff" />
    <Circle cx={64} cy={51} r={6.2} fill="#ffffff" />
    <Circle cx={36.5} cy={52} r={3.3} fill="#1a1c1f" />
    <Circle cx={64.5} cy={52} r={3.3} fill="#1a1c1f" />
    <Path d="M41 66 Q50 75 59 66 Q50 70 41 66 Z" fill="#2b2118" />
    <Rect x={20} y={76} width={60} height={9} rx={4.5} fill="#3d8ce0" />
  </G>
);

const OWL = (
  <G>
    <Path d="M18 20 L26 4 L36 20 Z" fill="#2c6d52" />
    <Path d="M82 20 L74 4 L64 20 Z" fill="#2c6d52" />
    <Circle cx={50} cy={50} r={48} fill="#3fa37a" />
    <Ellipse cx={50} cy={62} rx={30} ry={30} fill="#cfe8d8" />
    <Circle cx={33} cy={45} r={18} fill="#f7e6a8" />
    <Circle cx={67} cy={45} r={18} fill="#f7e6a8" />
    <Circle cx={33} cy={45} r={14} fill="#ffffff" />
    <Circle cx={67} cy={45} r={14} fill="#ffffff" />
    <Circle cx={34} cy={46} r={7} fill="#1a1c1f" />
    <Circle cx={66} cy={46} r={7} fill="#1a1c1f" />
    <Circle cx={36} cy={43} r={2.2} fill="#ffffff" />
    <Circle cx={68} cy={43} r={2.2} fill="#ffffff" />
    <Path d="M50 56 L43 66 L57 66 Z" fill="#e8a33d" />
    <Path d="M43 66 L50 74 L57 66 Z" fill="#c07f22" />
  </G>
);

/**
 * Pip. The silhouette does the work: two sharp ears are the only pointed pair
 * in the cast, so Pip is tellable from Buddy at 30pt even though both are warm
 * and both are a muzzle on a circle.
 */
const PIP = (
  <G>
    <Path d="M14 34 L19 1 L44 20 Z" fill="#b8472a" />
    <Path d="M86 34 L81 1 L56 20 Z" fill="#b8472a" />
    <Path d="M21 30 L24 11 L38 23 Z" fill="#ffd0bd" />
    <Path d="M79 30 L76 11 L62 23 Z" fill="#ffd0bd" />
    <Circle cx={50} cy={50} r={48} fill="#e0603d" />
    <Ellipse cx={9} cy={62} rx={11} ry={9} fill="#ffe8da" />
    <Ellipse cx={91} cy={62} rx={11} ry={9} fill="#ffe8da" />
    <Rect x={27} y={29} width={15} height={4.5} rx={2.25} fill="#a83d22" />
    <Rect x={58} y={29} width={15} height={4.5} rx={2.25} fill="#a83d22" />
    <Ellipse cx={50} cy={69} rx={26} ry={18} fill="#ffe8da" />
    <Circle cx={35} cy={45} r={7} fill="#ffffff" />
    <Circle cx={65} cy={45} r={7} fill="#ffffff" />
    <Circle cx={35.5} cy={46} r={3.8} fill="#1a1c1f" />
    <Circle cx={65.5} cy={46} r={3.8} fill="#1a1c1f" />
    <Path d="M50 65 L41 56 L59 56 Z" fill="#2b2118" />
    <Path d="M42 74 Q50 82 58 74 Q50 78 42 74 Z" fill="#2b2118" />
  </G>
);

/**
 * Nano. The only rectangle in the cast, and the only face where the eyes and
 * the mouth are lit rather than drawn — a robot reads as a robot from the
 * silhouette alone, before any of the detail resolves.
 */
const NANO = (
  <G>
    <Rect x={47} y={0} width={6} height={18} rx={3} fill="#1c7d88" />
    <Circle cx={50} cy={3} r={8} fill="#ffe27a" />
    <Circle cx={2} cy={56} r={9} fill="#1c7d88" />
    <Circle cx={98} cy={56} r={9} fill="#1c7d88" />
    <Rect x={6} y={16} width={88} height={78} rx={28} fill="#2ba7b4" />
    <Rect x={16} y={28} width={68} height={46} rx={18} fill="#0f3d43" />
    <Circle cx={36} cy={46} r={8} fill="#8ff0f7" />
    <Circle cx={64} cy={46} r={8} fill="#8ff0f7" />
    <Circle cx={38} cy={43.5} r={2.6} fill="#ffffff" />
    <Circle cx={66} cy={43.5} r={2.6} fill="#ffffff" />
    <Rect x={38} y={59} width={24} height={7} rx={3.5} fill="#8ff0f7" />
    <Rect x={30} y={82} width={40} height={6} rx={3} fill="#1c7d88" />
  </G>
);

/**
 * Mira. A pale moon on a night sky, with craters instead of hair and a low,
 * soft brow — the calmest face in the cast, which is what a child choosing
 * her at bedtime is choosing.
 */
const MIRA = (
  <G>
    <Circle cx={8} cy={18} r={4} fill="#ffe27a" />
    <Circle cx={93} cy={26} r={3} fill="#ffe27a" />
    <Circle cx={86} cy={84} r={3.5} fill="#ffe27a" />
    <Circle cx={50} cy={50} r={48} fill="#7b86d8" />
    <Circle cx={50} cy={50} r={40} fill="#f6f3ff" />
    <Ellipse cx={27} cy={33} rx={7} ry={6} fill="#e2ddf4" />
    <Ellipse cx={71} cy={68} rx={6} ry={5} fill="#e2ddf4" />
    <Ellipse cx={31} cy={72} rx={5} ry={4} fill="#e2ddf4" />
    <Rect x={26} y={39} width={15} height={4} rx={2} fill="#9aa2e0" />
    <Rect x={59} y={39} width={15} height={4} rx={2} fill="#9aa2e0" />
    <Circle cx={34} cy={53} r={6.4} fill="#ffffff" />
    <Circle cx={66} cy={53} r={6.4} fill="#ffffff" />
    <Circle cx={34.5} cy={54} r={3.4} fill="#2b2a44" />
    <Circle cx={66.5} cy={54} r={3.4} fill="#2b2a44" />
    <Ellipse cx={23} cy={64} rx={6} ry={4} fill="#efc0cf" />
    <Ellipse cx={77} cy={64} rx={6} ry={4} fill="#efc0cf" />
    <Path d="M43 69 Q50 76 57 69 Q50 72.5 43 69 Z" fill="#6b6690" />
  </G>
);

/**
 * Zia. The brim is the recognisable part and it runs past the box on both
 * sides, so her card never reads as another circle with a face on it.
 */
const ZIA = (
  <G>
    <Ellipse cx={50} cy={17} rx={25} ry={16} fill="#7aa53c" />
    <Ellipse cx={50} cy={29} rx={54} ry={11} fill="#6b9134" />
    <Rect x={25} y={22} width={50} height={8} fill="#4f6b26" />
    <Circle cx={50} cy={55} r={42} fill="#d9a06b" />
    <Ellipse cx={14} cy={58} rx={7} ry={13} fill="#2f2620" />
    <Ellipse cx={86} cy={58} rx={7} ry={13} fill="#2f2620" />
    <Rect x={28} y={43} width={14} height={4.5} rx={2.25} fill="#3c2f22" />
    <Rect x={58} y={43} width={14} height={4.5} rx={2.25} fill="#3c2f22" />
    <Circle cx={36} cy={55} r={6.6} fill="#ffffff" />
    <Circle cx={64} cy={55} r={6.6} fill="#ffffff" />
    <Circle cx={36.5} cy={56} r={3.5} fill="#1a1c1f" />
    <Circle cx={64.5} cy={56} r={3.5} fill="#1a1c1f" />
    <Ellipse cx={24} cy={66} rx={6} ry={4} fill="#c97d55" />
    <Ellipse cx={76} cy={66} rx={6} ry={4} fill="#c97d55" />
    <Path d="M40 71 Q50 81 60 71 Q50 76 40 71 Z" fill="#2b2118" />
    <Rect x={18} y={88} width={64} height={12} rx={6} fill="#d9b24a" />
  </G>
);

/**
 * Dada Jee. Beard first, then mouth, then moustache — in that order, so the
 * mouth sits ON the beard the way a mouth in a beard does, rather than being
 * painted over by it.
 */
const DADA = (
  <G>
    <Ellipse cx={50} cy={15} rx={30} ry={14} fill="#5b4a55" />
    <Rect x={20} y={22} width={60} height={9} rx={4.5} fill="#46383f" />
    <Circle cx={50} cy={54} r={42} fill="#e0b184" />
    <Ellipse cx={50} cy={88} rx={31} ry={21} fill="#f4f1ec" />
    <Ellipse cx={50} cy={77} rx={8} ry={5} fill="#7a4a42" />
    <Ellipse cx={50} cy={69} rx={19} ry={6.5} fill="#f4f1ec" />
    <Rect x={25} y={36} width={17} height={5} rx={2.5} fill="#f4f1ec" />
    <Rect x={58} y={36} width={17} height={5} rx={2.5} fill="#f4f1ec" />
    <Circle cx={35} cy={51} r={6.2} fill="#ffffff" />
    <Circle cx={65} cy={51} r={6.2} fill="#ffffff" />
    <Circle cx={35.5} cy={52} r={3.3} fill="#1a1c1f" />
    <Circle cx={65.5} cy={52} r={3.3} fill="#1a1c1f" />
    <Ellipse cx={22} cy={62} rx={6} ry={4} fill="#cf8a76" />
    <Ellipse cx={78} cy={62} rx={6} ry={4} fill="#cf8a76" />
    <Rect x={10} y={94} width={80} height={12} rx={6} fill="#b05c74" />
  </G>
);

const ART: Readonly<Record<CharacterSlug, React.ReactElement>> = {
  'buddy-the-dog': BUDDY,
  'lily-the-fairy': LILY,
  'captain-sky': SKY,
  'professor-owl': OWL,
  'pip-the-fox': PIP,
  'nano-the-robot': NANO,
  'mira-the-moon': MIRA,
  'captain-zia': ZIA,
  'dada-jee': DADA,
};

/**
 * One character's face.
 *
 * `overflow: visible` is deliberate: Buddy's ears and Lily's wings sit outside
 * the 0–100 box on purpose, so the silhouette is not a plain circle at a glance.
 */
export const Avatar = memo(({ slug, size = 140, testID }: AvatarProps) => {
  const member = castMember(slug);

  return (
    <Svg
      {...(testID === undefined ? {} : { testID })}
      width={size}
      height={size}
      viewBox="0 0 100 100"
      accessibilityRole="image"
      accessibilityLabel={member.name}
      style={{ overflow: 'visible' }}
    >
      {ART[isCharacterSlug(slug) ? slug : DEFAULT_CHARACTER]}
    </Svg>
  );
});

Avatar.displayName = 'Avatar';
