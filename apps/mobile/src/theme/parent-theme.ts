import { colors, radii, spacing, touchTargets } from '@kids/ui';

/**
 * Parent-mode theme.
 *
 * The opposite audience to `child-theme`, and deliberately sharing nothing with
 * it. Grey-white, IBM Plex Sans, 6pt radii, 44pt targets, dense labelled forms:
 * a parent is reading a settings screen, not being delighted.
 *
 * ONE BLUE for action. ONE RED, reserved strictly for irreversible things. ONE
 * AMBER for "we need you to know". Nothing decorative — a colour that means
 * something everywhere means nothing anywhere.
 *
 * Mono is reserved for values a parent might need to quote to support. It is
 * the only place in the product a reference code appears at all, and a child
 * never reaches it.
 */

export const parentTheme = {
  colors: {
    ...colors,

    background: '#f4f5f7',
    surface: '#ffffff',
    border: '#dcdfe4',
    /** A border under a pointer, and the chevron at the end of a row. */
    borderStrong: '#b8bdc6',
    /** Segmented-control troughs, muted note blocks, and hairlines inside cards. */
    inset: '#eceef1',
    hairline: '#eceef1',

    action: '#1a4fa0',
    actionDark: '#12377a',
    actionWash: '#e8eef8',
    actionWashBorder: '#c3d3ec',
    actionWashText: '#12377a',

    danger: '#b3261e',
    dangerWash: '#fdecea',
    dangerBorder: '#f0c4bf',
    dangerText: '#8f1d17',

    warn: '#a86800',
    warnWash: '#fdf3e0',
    warnBorder: '#e5cfa4',
    warnText: '#6b4300',

    good: '#1f7a4d',
    goodWash: '#e7f4ec',
    goodBorder: '#bfe0cd',

    ink: '#1a1c1f',
    inkSoft: '#5b6069',
    inkFaint: '#8b9099',
    disabled: '#a8adb6',
    /** The switch track when off. */
    trackOff: '#c6cad1',
  },

  spacing,
  radii: {
    ...radii,
    /** Everything in parent mode. Nothing here is round. */
    control: 6,
    /** The one exception: a segment inside a 6pt trough. */
    segment: 5,
    /** Status pills next to a row title. */
    tag: 4,
  },

  text: {
    display: 32,
    title: 22,
    /** A card heading, or the nav bar title. */
    section: 17,
    cardTitle: 14,
    /** A settings row's own label. */
    rowLabel: 15,
    /** A form field label, and the uppercase group heading. */
    label: 12,
    body: 14,
    /** Field text. 16 so iOS does not zoom the form. */
    input: 16,
    helper: 12.5,
    caption: 12,
    mono: 12,
  },

  /** 44pt — the adult accessibility floor — and 48 for a form's primary action. */
  touch: {
    min: touchTargets.parent,
    primary: 48,
    /** The nav bar, and each bottom tab. */
    bar: 52,
  },

  shadows: {
    knob: {
      shadowColor: '#000000',
      shadowOpacity: 0.28,
      shadowRadius: 3,
      shadowOffset: { width: 0, height: 1 },
      elevation: 2,
    },
  },
} as const;

/**
 * The five bottom tabs.
 *
 * Fixed, in this order. The parent area is a settings app, and a settings app
 * that reorders its own navigation is one a parent has to re-learn every visit.
 */
export const PARENT_TABS = [
  { href: '/(parent)/(tabs)/dashboard', icon: '📊', label: 'Home' },
  { href: '/(parent)/(tabs)/children', icon: '👶', label: 'Children' },
  { href: '/(parent)/(tabs)/controls', icon: '🛡️', label: 'Controls' },
  { href: '/(parent)/(tabs)/conversations', icon: '💬', label: 'Chats' },
  { href: '/(parent)/(tabs)/account', icon: '⚙️', label: 'Account' },
] as const;
