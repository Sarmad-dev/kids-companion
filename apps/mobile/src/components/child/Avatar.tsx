import { memo } from 'react';
import Svg, { Circle, Ellipse, G, Path, Rect } from 'react-native-svg';

import {
  castMember,
  DEFAULT_CHARACTER,
  isCharacterSlug,
  type CharacterSlug,
} from '../../theme/child-theme';

/**
 * The cast, as flat art.
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

const ART: Readonly<Record<CharacterSlug, React.ReactElement>> = {
  'buddy-the-dog': BUDDY,
  'lily-the-fairy': LILY,
  'captain-sky': SKY,
  'professor-owl': OWL,
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
