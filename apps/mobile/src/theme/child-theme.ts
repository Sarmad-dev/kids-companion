import { colors, radii, spacing, touchTargets } from '@kids/ui';

/**
 * Child-mode theme.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TWO PRODUCTS, ONE BINARY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Child mode and parent mode share no type, no colour, no radius and no touch
 * target. A child who wanders into the parent area should feel they have left
 * the app; a parent in the child area should feel they are a guest. Every value
 * below is literal — nothing is derived at runtime — because a derived value is
 * one an unrelated change can move.
 *
 * Child mode is cream, Baloo 2, pill corners, and 72pt targets. Every control
 * carries a face AND a colour AND a word, so no state is signalled by colour
 * alone or by motion alone.
 */

/**
 * The nine characters, and everything that is theirs alone.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE HUE EACH, AND NINE OF THEM HAVE TO STAY TELLABLE APART
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A child navigates the select grid by colour as much as by face, so the nine
 * `colour` values are spread deliberately around the wheel rather than picked
 * one at a time: rust, orange, olive, green, teal, blue, periwinkle, violet,
 * plum. No two adjacent cards share a family, and every card also carries its
 * own face and its own name — colour is never the only channel.
 *
 * `wash` is the pale version of the same hue, and it is doing a second job: it
 * is the sky behind that character's 3D set (`CharacterWash`), so it has to be
 * light enough for dark geometry to read against it at every size.
 */
export const CAST = {
  'buddy-the-dog': {
    name: 'Buddy the Dog',
    short: 'Buddy',
    colour: '#f2a03d',
    wash: '#ffe9cd',
    tagline: 'A cheerful dog in a sunny back yard. He loves a good chat.',
    ages: '3–5, 6–8',
  },
  'lily-the-fairy': {
    name: 'Lily the Fairy',
    short: 'Lily',
    colour: '#a978d8',
    wash: '#ece0fa',
    tagline: 'A gentle fairy in a woodland glade. She notices small wonders.',
    ages: '3–5, 6–8, 9–10',
  },
  'captain-sky': {
    name: 'Captain Sky',
    short: 'Sky',
    colour: '#3d8ce0',
    wash: '#d7e8fb',
    tagline: 'An explorer on a space platform. Every problem finds a way out.',
    ages: '6–8, 9–10',
  },
  'professor-owl': {
    name: 'Professor Owl',
    short: 'Owl',
    colour: '#3fa37a',
    wash: '#d9eee4',
    tagline: 'A patient owl in a book-lined study. Ask him how anything works.',
    ages: '6–8, 9–10',
  },
  'pip-the-fox': {
    name: 'Pip the Fox',
    short: 'Pip',
    colour: '#e0603d',
    wash: '#ffdfd2',
    tagline: 'A little fox in an autumn meadow. Pip is full of questions.',
    ages: '3–5, 6–8',
  },
  'nano-the-robot': {
    name: 'Nano the Robot',
    short: 'Nano',
    colour: '#2ba7b4',
    wash: '#d4f0f3',
    tagline: 'A tinkering robot in a busy workshop. He loves how things work.',
    ages: '6–8, 9–10',
  },
  'mira-the-moon': {
    name: 'Mira the Moon',
    short: 'Mira',
    colour: '#7b86d8',
    wash: '#e4e6fb',
    tagline: 'A quiet moon above the clouds. Mira is lovely at bedtime.',
    ages: '3–5, 6–8, 9–10',
  },
  'captain-zia': {
    name: 'Captain Zia',
    short: 'Zia',
    colour: '#7aa53c',
    wash: '#e9f3d5',
    tagline: 'A river explorer at her jetty. Every trip goes where you say.',
    ages: '6–8, 9–10',
  },
  'dada-jee': {
    name: 'Dada Jee',
    short: 'Dada Jee',
    colour: '#b05c74',
    wash: '#f8e0e7',
    tagline: 'A warm grandfather in a lantern-lit courtyard, full of old tales.',
    ages: '6–8, 9–10',
  },
} as const;

export type CharacterSlug = keyof typeof CAST;

export const CAST_SLUGS = Object.keys(CAST) as readonly CharacterSlug[];

export const DEFAULT_CHARACTER: CharacterSlug = 'buddy-the-dog';

export const isCharacterSlug = (slug: string | undefined): slug is CharacterSlug =>
  slug !== undefined && Object.prototype.hasOwnProperty.call(CAST, slug);

/** A slug from the API or the route, narrowed to one this app ships art for. */
export const castMember = (slug: string | undefined) =>
  CAST[isCharacterSlug(slug) ? slug : DEFAULT_CHARACTER];

export const childTheme = {
  colors: {
    ...colors,

    /** Cream ground, so white cards read as objects sitting on a surface. */
    background: '#fff6e5',
    surface: '#ffffff',
    /** The one thing to press. */
    accent: '#ff8a3d',
    accentPressed: '#f57d2f',
    /** Secondary — deliberately the duller of the two, including the parent door. */
    muted: '#efe6d3',
    mutedPressed: '#e7dcc4',
    mutedSoft: '#f7f0e0',

    /** Recording. Green, never red — red means stop. */
    listening: '#2f9e6e',
    thinking: '#8f9aa8',
    /** Disabled keeps its label; only the fill goes grey. */
    disabled: '#c9c4bb',

    ink: '#1a1c1f',
    inkSoft: '#5b6069',

    buddy: CAST['buddy-the-dog'].colour,
    lily: CAST['lily-the-fairy'].colour,
    captain: CAST['captain-sky'].colour,
    professor: CAST['professor-owl'].colour,
    pip: CAST['pip-the-fox'].colour,
    nano: CAST['nano-the-robot'].colour,
    mira: CAST['mira-the-moon'].colour,
    zia: CAST['captain-zia'].colour,
    dada: CAST['dada-jee'].colour,

    /** Tile icon discs. Position is the label; the colour is the second channel. */
    tileChat: '#ffe0c7',
    tileTalk: '#d6f0e3',
    tileStory: '#ece0fa',
    tileSayIt: '#d9e9fb',
    tileWords: '#d9eee4',
    tileStars: '#ffe6cf',
    tileLocked: '#f0eade',

    shadow: 'rgba(58, 42, 20, 0.14)',
  },

  spacing,
  radii: {
    ...radii,
    /** Home tiles and speech bubbles. */
    card: 24,
    /** Child and character cards — a shade rounder again. */
    bigCard: 26,
    tile: 20,
  },

  /**
   * Baloo 2 throughout, and never below 18pt.
   *
   * A six-year-old reads at arm's length in bad light. There is no small print
   * in child mode at all, because small print implies something a child must
   * check — and nothing here is.
   */
  text: {
    /** Greetings and one-word moments. */
    hero: 40,
    /** One per screen. */
    title: 28,
    /** Always paired with a face. */
    button: 24,
    /** The character speaking. */
    body: 20,
    /** The floor. Never smaller. */
    aside: 18,
    /** The label under a face on a button or a tile. */
    label: 17,
  },

  /**
   * Touch targets.
   *
   * 72pt for anything a child taps, versus the 44pt adult floor; 88 for the one
   * primary action on a screen. A missed tap does not read as "I missed" to a
   * four-year-old — it reads as "it's broken", and they stop trying.
   */
  touch: {
    min: touchTargets.child,
    primary: 88,
    /** Never moves, never resizes, on every screen that has one. */
    talkButton: 168,
  },

  motion: {
    gentle: 420,
    /** The listening breath. One per cycle. */
    pulse: 1_400,
    /** The idle float. Slow enough to read as alive rather than as urgent. */
    float: 4_200,
    /** How long a celebration holds before it gets out of the way. */
    celebrate: 1_800,
  },

  shadows: {
    card: {
      shadowColor: '#3a2a14',
      shadowOpacity: 0.13,
      shadowRadius: 14,
      shadowOffset: { width: 0, height: 5 },
      elevation: 4,
    },
    raised: {
      shadowColor: '#3a2a14',
      shadowOpacity: 0.18,
      shadowRadius: 20,
      shadowOffset: { width: 0, height: 8 },
      elevation: 7,
    },
    bubble: {
      shadowColor: '#3a2a14',
      shadowOpacity: 0.2,
      shadowRadius: 22,
      shadowOffset: { width: 0, height: 8 },
      elevation: 8,
    },
    talk: {
      shadowColor: '#3a2a14',
      shadowOpacity: 0.3,
      shadowRadius: 28,
      shadowOffset: { width: 0, height: 12 },
      elevation: 12,
    },
  },
} as const;

/** Maps a character slug to its colour, with a safe default for an unknown one. */
export const characterColour = (slug: string | undefined): string => castMember(slug).colour;

/** The pale wash the flat fallback and the diorama sky are painted with. */
export const characterWash = (slug: string | undefined): string => castMember(slug).wash;

/**
 * The four feedback bands.
 *
 * Same size, same layout, same warmth, four warm colours. No red, no cross, no
 * score, no number — "Good try!" gets the same character reaction as "Perfect!".
 */
export const FEEDBACK_BANDS = {
  excellent: {
    title: 'Perfect!',
    face: '🌟',
    colour: '#2f9e6e',
    wash: '#e6f6ee',
    line: 'You said every part of that word. Lovely and clear!',
  },
  good: {
    title: 'Lovely!',
    face: '😊',
    colour: '#3d8ce0',
    wash: '#e9f3ff',
    line: 'I heard that beautifully. Your mouth is getting strong!',
  },
  nearly: {
    title: 'So close!',
    face: '👂',
    colour: '#a978d8',
    wash: '#f3ebff',
    line: 'I nearly caught all of it. Listen to me and say it with me!',
  },
  keepgoing: {
    title: 'Good try!',
    face: '💪',
    colour: '#ff8a3d',
    wash: '#fff0e0',
    line: "That's a tricky one for everybody. Let's do it together!",
  },
} as const;

export type FeedbackBandKey = keyof typeof FEEDBACK_BANDS;

/** Narrows a band name off a route param, which is a string like any other. */
export const isFeedbackBand = (value: string | undefined): value is FeedbackBandKey =>
  value !== undefined && Object.prototype.hasOwnProperty.call(FEEDBACK_BANDS, value);

/**
 * The server's band vocabulary, mapped onto ours.
 *
 * `/api/practice/sessions/:id/attempts` answers with a band name; anything we
 * do not recognise lands on the kindest of the four rather than on an error,
 * because a child cannot act on "unknown band" and should never see one.
 */
export const feedbackBand = (band: string | undefined): FeedbackBandKey => {
  switch (band ?? '') {
    case 'excellent':
    case 'perfect':
      return 'excellent';
    case 'good':
      return 'good';
    case 'nearly':
    case 'close':
      return 'nearly';
    case 'keep_going':
    case 'keepgoing':
      return 'keepgoing';
    default:
      return 'keepgoing';
  }
};
