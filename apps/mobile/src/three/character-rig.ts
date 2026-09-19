import buddyModel from '../../assets/models/Buddy.glb';
import captainSkyModel from '../../assets/models/CaptainSky.glb';
import lilyModel from '../../assets/models/Lily.glb';
import professorOwlModel from '../../assets/models/ProfessorOwl.glb';

/**
 * The 3D character rigs.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS SEPARATELY FROM THE SCENE COMPONENT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Each `.glb` is a small diorama an artist built in Blender — a character rig
 * PLUS its set (Buddy's yard, Sky's space platform, Lily's glade, Owl's study)
 * PLUS a hero camera and a three-point lighting rig, all exported as named,
 * empty transform nodes (`<Character>_HeroCamera`, `_KeyLight`, `_FillLight`,
 * `_RimLight`). None of the four carry baked animation clips — there is
 * nothing in `gltf.animations` — so everything that moves has to be driven at
 * runtime by naming the exact bone-equivalent nodes and tweening them.
 *
 * That naming is NOT uniform: Buddy is a quadruped with ears and a tail, Lily
 * and Sky are bipeds with arms and (for Lily) wings, and Owl has no separate
 * neck or spine node at all — just a head and a body. Scattering
 * `nodes['Buddy_Ear_L']`-style string literals through the animation code
 * would mean four characters' worth of special-casing bleeding into every
 * function that plays an idle loop or a talking cycle.
 *
 * Centralising the mapping here means the animation controller
 * (`useDioramaMood.ts`) is written ONCE, entirely against the semantic
 * roles below (`head`, `mouth`, `eyesLeft`, …), and simply skips a role a
 * given character does not have — Owl has no `tail`, Buddy has no `wings`,
 * and neither animation loop needs to know that explicitly.
 */

export type CharacterSlug = 'buddy-the-dog' | 'lily-the-fairy' | 'captain-sky' | 'professor-owl';

/** Guards a string slug from the API/nav state into the fixed set this app ships models for. */
export const isCharacterSlug = (slug: string): slug is CharacterSlug =>
  slug === 'buddy-the-dog' ||
  slug === 'lily-the-fairy' ||
  slug === 'captain-sky' ||
  slug === 'professor-owl';

/**
 * The semantic bone roles the animation controller knows how to move.
 *
 * A single node (`head`) or a small group that must scale together to read as
 * one part (`eyesLeft` — the sclera, iris, pupil and highlight are exported as
 * four sibling nodes, not a parent/child chain, so a blink has to shrink all
 * four in lock-step or the iris is left floating in mid-air).
 *
 * Every field is optional: the controller only animates what a given rig
 * actually has.
 */
export interface CharacterRig {
  /** The node that bounds the character alone, excluding the set — used to auto-frame the camera. */
  readonly root: string;
  readonly heroCamera?: string;
  readonly keyLight?: string;
  readonly fillLight?: string;
  readonly rimLight?: string;

  readonly head?: string;
  readonly neck?: string;
  /** Chest/spine — whichever this rig calls its one torso bone. */
  readonly spine?: string;
  /** The jaw or beak node that opens and closes while talking. */
  readonly mouth?: string;
  readonly browLeft?: string;
  readonly browRight?: string;
  readonly eyesLeft?: readonly string[];
  readonly eyesRight?: readonly string[];

  readonly earLeft?: string;
  readonly earRight?: string;
  readonly tail?: string;
  /** Everything the character stands on. Swings on the limb period, phase-offset. */
  readonly legs?: readonly string[];

  readonly wingLeft?: string;
  readonly wingRight?: string;
  readonly armUpperLeft?: string;
  readonly armUpperRight?: string;
  readonly armLowerLeft?: string;
  readonly armLowerRight?: string;

  /**
   * Whether `mouth` is a hinge or a shape.
   *
   * Owl's beak is a real lower jaw that rotates open. Everybody else's mouth is
   * a drawn line that scales vertically — visually the same event, two entirely
   * different transforms, and getting it backwards makes a dog's muzzle rotate
   * off its face.
   */
  readonly mouthHinges?: boolean;
  /** Lily does not stand on the ground; she bobs above it. */
  readonly hovers?: boolean;
}

export interface CharacterDefinition {
  readonly slug: CharacterSlug;
  /** The Metro asset module id for this character's `.glb`. */
  readonly model: number;
  readonly rig: CharacterRig;
}

const CHARACTERS: Readonly<Record<CharacterSlug, CharacterDefinition>> = {
  'buddy-the-dog': {
    slug: 'buddy-the-dog',
    model: buddyModel,
    rig: {
      root: 'Buddy_Root',
      heroCamera: 'Buddy_HeroCamera',
      keyLight: 'Buddy_KeyLight',
      fillLight: 'Buddy_FillLight',
      rimLight: 'Buddy_RimLight',
      head: 'Buddy_Head',
      neck: 'Buddy_Neck',
      spine: 'Buddy_Spine',
      mouth: 'Buddy_Mouth',
      browLeft: 'Buddy_Brow_L',
      browRight: 'Buddy_Brow_R',
      eyesLeft: ['Buddy_Eye_L', 'Buddy_EyeHighlight_L'],
      eyesRight: ['Buddy_Eye_R', 'Buddy_EyeHighlight_R'],
      earLeft: 'Buddy_Ear_L',
      earRight: 'Buddy_Ear_R',
      tail: 'Buddy_Tail',
      legs: ['Buddy_Leg_Front_L', 'Buddy_Leg_Front_R', 'Buddy_Leg_Back_L', 'Buddy_Leg_Back_R'],
    },
  },

  'lily-the-fairy': {
    slug: 'lily-the-fairy',
    model: lilyModel,
    rig: {
      root: 'Lily_Root',
      heroCamera: 'Lily_HeroCamera',
      keyLight: 'Lily_KeyLight',
      fillLight: 'Lily_FillLight',
      rimLight: 'Lily_RimLight',
      head: 'Lily_Head',
      neck: 'Lily_Neck',
      spine: 'Lily_Chest',
      mouth: 'Lily_Mouth',
      browLeft: 'Lily_Brow_L',
      browRight: 'Lily_Brow_R',
      eyesLeft: ['Lily_EyeWhite_L', 'Lily_Iris_L', 'Lily_Pupil_L', 'Lily_EyeHighlight_L'],
      eyesRight: ['Lily_EyeWhite_R', 'Lily_Iris_R', 'Lily_Pupil_R', 'Lily_EyeHighlight_R'],
      wingLeft: 'Lily_Wing_L',
      wingRight: 'Lily_Wing_R',
      armUpperLeft: 'Lily_Arm_Upper_L',
      armUpperRight: 'Lily_Arm_Upper_R',
      armLowerLeft: 'Lily_Arm_Lower_L',
      armLowerRight: 'Lily_Arm_Lower_R',
      legs: ['Lily_Leg_L', 'Lily_Leg_R'],
      hovers: true,
    },
  },

  'captain-sky': {
    slug: 'captain-sky',
    model: captainSkyModel,
    rig: {
      root: 'Sky_Root',
      heroCamera: 'Sky_HeroCamera',
      keyLight: 'Sky_KeyLight',
      fillLight: 'Sky_FillLight',
      rimLight: 'Sky_RimLight',
      head: 'Sky_Head',
      neck: 'Sky_Neck',
      spine: 'Sky_Chest',
      mouth: 'Sky_Mouth',
      browLeft: 'Sky_Brow_L',
      browRight: 'Sky_Brow_R',
      eyesLeft: ['Sky_EyeWhite_L', 'Sky_Iris_L', 'Sky_Pupil_L', 'Sky_EyeHighlight_L'],
      eyesRight: ['Sky_EyeWhite_R', 'Sky_Iris_R', 'Sky_Pupil_R', 'Sky_EyeHighlight_R'],
      armUpperLeft: 'Sky_Arm_Upper_L',
      armUpperRight: 'Sky_Arm_Upper_R',
      armLowerLeft: 'Sky_Arm_Lower_L',
      armLowerRight: 'Sky_Arm_Lower_R',
      legs: ['Sky_Leg_L', 'Sky_Leg_R'],
    },
  },

  'professor-owl': {
    slug: 'professor-owl',
    model: professorOwlModel,
    rig: {
      root: 'Owl_Root',
      heroCamera: 'Owl_HeroCamera',
      keyLight: 'Owl_KeyLight',
      fillLight: 'Owl_FillLight',
      rimLight: 'Owl_RimLight',
      head: 'Owl_Head',
      // Owl has no separate neck/spine node — the body itself is the one torso bone.
      spine: 'Owl_Body',
      // The lower beak hinges open — this rig's stand-in for a mouth.
      mouth: 'Owl_BeakLower',
      browLeft: 'Owl_Brow_L',
      browRight: 'Owl_Brow_R',
      eyesLeft: ['Owl_EyeWhite_L', 'Owl_Iris_L', 'Owl_Pupil_L', 'Owl_EyeHighlight_L'],
      eyesRight: ['Owl_EyeWhite_R', 'Owl_Iris_R', 'Owl_Pupil_R', 'Owl_EyeHighlight_R'],
      wingLeft: 'Owl_Wing_L',
      wingRight: 'Owl_Wing_R',
      legs: ['Owl_Foot_L', 'Owl_Foot_R'],
      // The lower beak really does hinge; nobody else's mouth does.
      mouthHinges: true,
    },
  },
};

/** Buddy is the fallback everywhere else in the app already defaults to. */
export const DEFAULT_CHARACTER_SLUG: CharacterSlug = 'buddy-the-dog';

/**
 * Whether this slug has a `.glb` in `assets/models`.
 *
 * Four of the nine characters do; the five added later are built from
 * primitives in `procedural-cast.ts` instead. `characterDefinitionFor` falls
 * back to Buddy for anything it does not know, which is right for a typo in a
 * route param and WRONG for Pip — it would quietly show a child the dog they
 * did not choose. So callers that can render either kind ask this first, and
 * `CharacterStage` is the one that does.
 */
export const hasBundledModel = (slug: string): slug is CharacterSlug => isCharacterSlug(slug);

export const characterDefinitionFor = (slug: string): CharacterDefinition =>
  isCharacterSlug(slug) ? CHARACTERS[slug] : CHARACTERS[DEFAULT_CHARACTER_SLUG];
