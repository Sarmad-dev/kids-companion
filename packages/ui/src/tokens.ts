/**
 * Design tokens, shared by mobile and web.
 *
 * Tokens are shared; components are not assumed to be. Child mode and parent mode
 * have genuinely different requirements — see the package README — so this file
 * holds the vocabulary both agree on and nothing else.
 */

export const colors = {
  // Parent-mode surface: conventional, calm, information-dense.
  surface: '#ffffff',
  surfaceMuted: '#f4f5f7',
  border: '#dcdfe4',
  text: '#1a1c1f',
  textMuted: '#5b6069',

  // Child-mode surface: high contrast, saturated, warm.
  playBackground: '#fff6e5',
  playAccent: '#ff8a3d',

  // Semantic.
  success: '#1f7a4d',
  warning: '#a86800',
  danger: '#b3261e',
  info: '#1a4fa0',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 40,
  xxl: 64,
} as const;

export const radii = {
  sm: 6,
  md: 12,
  /** Child-mode controls are round. Nothing a small child taps has a sharp corner. */
  pill: 999,
} as const;

export const fontSizes = {
  caption: 12,
  body: 16,
  title: 22,
  display: 32,
  /** Child mode runs large — a pre-reader relies on shape, not on reading. */
  playPrimary: 28,
} as const;

/**
 * Minimum touch target, in points.
 *
 * 44 is the common accessibility floor for adults. Child mode uses a larger
 * target because a 4-year-old's tap accuracy is materially worse, and a missed
 * tap on a talk button reads as "it's broken".
 */
export const touchTargets = {
  parent: 44,
  child: 72,
} as const;

export type Colors = typeof colors;
export type Spacing = typeof spacing;
