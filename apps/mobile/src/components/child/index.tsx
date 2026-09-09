import { useEffect, useRef, type ReactNode } from 'react';
import {
  Animated,
  Easing,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useReducedMotion } from '../../hooks/reduced-motion';
import { useApp } from '../../state/app-context';
import { childTheme } from '../../theme/child-theme';
import { fonts } from '../../theme/fonts';

import { Avatar } from './Avatar';

export { Avatar } from './Avatar';

/**
 * The child-mode component kit.
 *
 * Three rules run through all of it, which is why the pieces look repetitive
 * and why that repetition is the point: a child learns one screen and knows
 * them all.
 *
 * **Big.** Nothing tappable is smaller than 72pt, and the one primary action on
 * a screen is 88. A missed tap does not read as "I missed" to a four-year-old.
 *
 * **Three channels, always.** Every control carries a face AND a colour AND a
 * word. No state is signalled by colour alone or by motion alone, which is what
 * makes Reduce Motion cost nothing at all.
 *
 * **Calm.** Nothing flashes, nothing is on a timer, and nothing competes for
 * attention. A child who wanders off mid-sentence comes back to a screen that
 * waited.
 */

/* -------------------------------------------------------------------------- */
/* Type                                                                        */
/* -------------------------------------------------------------------------- */

export const Hero = ({ children }: { children: ReactNode }) => (
  <Text style={styles.hero}>{children}</Text>
);

export const Title = ({
  children,
  style,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) => (
  <Text style={[styles.title, style]} accessibilityRole="header">
    {children}
  </Text>
);

/** The character speaking, or a line addressed to the child. 20pt, never less. */
export const Body = ({ children }: { children: ReactNode }) => (
  <Text style={styles.body}>{children}</Text>
);

/** The floor: 18pt. There is no small print in child mode. */
export const Aside = ({ children }: { children: ReactNode }) => (
  <Text style={styles.aside}>{children}</Text>
);

/* -------------------------------------------------------------------------- */
/* Frame                                                                       */
/* -------------------------------------------------------------------------- */

/** Roughly what the offline banner occupies. See `(child)/_layout.tsx`. */
const OFFLINE_BANNER_HEIGHT = 40;

/**
 * A child screen.
 *
 * Cream ground, generous padding, and a scroll view only where a screen can
 * genuinely overflow. `Spacer` pins whatever follows it to the bottom the way
 * `margin-top:auto` does in the design — the "Go home" pill on every screen
 * that has one sits there, in the same place, every time.
 *
 * Safe-area top is added here rather than in the layout, because the one screen
 * that must NOT have it — the conversation stage, whose diorama runs behind the
 * status bar — is also the one screen that does not use this component.
 */
export const Screen = ({
  children,
  scroll = false,
  padding = childTheme.spacing.lg,
  background = childTheme.colors.background,
  testID,
  style,
}: {
  children: ReactNode;
  scroll?: boolean;
  padding?: number;
  background?: string;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}) => {
  const insets = useSafeAreaInsets();
  const { online } = useApp();

  const inner = [
    {
      paddingTop: insets.top + padding + (online ? 0 : OFFLINE_BANNER_HEIGHT),
      paddingBottom: Math.max(insets.bottom, padding),
      paddingHorizontal: padding,
    },
    style,
  ];

  return scroll ? (
    <ScrollView
      testID={testID}
      style={{ backgroundColor: background }}
      contentContainerStyle={[styles.scrollContent, inner]}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      {children}
    </ScrollView>
  ) : (
    <View testID={testID} style={[styles.screen, { backgroundColor: background }, inner]}>
      {children}
    </View>
  );
};

/** Pushes whatever follows it to the bottom of a `Screen`. */
export const Spacer = () => <View style={styles.spacer} />;

/* -------------------------------------------------------------------------- */
/* Motion                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The idle float.
 *
 * The character rises and falls 7pt over 4.2s — slow enough to read as alive
 * rather than as urgent. Held perfectly still under Reduce Motion, where the
 * pose alone does the job.
 */
export const Float = ({
  children,
  style,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) => {
  const t = useRef(new Animated.Value(0)).current;
  const reduced = useReducedMotion();

  useEffect(() => {
    if (reduced) {
      t.setValue(0);
      return;
    }
    const half = childTheme.motion.float / 2;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(t, {
          toValue: 1,
          duration: half,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(t, {
          toValue: 0,
          duration: half,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => {
      loop.stop();
    };
  }, [reduced, t]);

  const translateY = t.interpolate({ inputRange: [0, 1], outputRange: [0, -7] });
  return <Animated.View style={[style, { transform: [{ translateY }] }]}>{children}</Animated.View>;
};

/** The one-shot pop a badge and a feedback face make on arrival. */
export const Pop = ({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) => {
  const t = useRef(new Animated.Value(0)).current;
  const reduced = useReducedMotion();

  useEffect(() => {
    if (reduced) {
      t.setValue(1);
      return;
    }
    Animated.spring(t, { toValue: 1, friction: 5, tension: 90, useNativeDriver: true }).start();
  }, [reduced, t]);

  const scale = t.interpolate({ inputRange: [0, 1], outputRange: [0.86, 1] });
  return (
    <Animated.View style={[style, { opacity: t, transform: [{ scale }] }]}>
      {children}
    </Animated.View>
  );
};

/* -------------------------------------------------------------------------- */
/* Buttons                                                                     */
/* -------------------------------------------------------------------------- */

type ButtonSize = 'hero' | 'primary' | 'medium' | 'small';

const SIZES: Readonly<Record<ButtonSize, { height: number; font: number }>> = {
  hero: { height: childTheme.touch.primary, font: 26 },
  primary: { height: childTheme.touch.primary, font: childTheme.text.button },
  medium: { height: 80, font: 22 },
  small: { height: childTheme.touch.min, font: childTheme.text.label + 1 },
};

/**
 * The general-purpose child button.
 *
 * A face, a label, and a colour — three channels for the same meaning, so a
 * child who cannot read the label can still tell the buttons apart. Every one
 * says what happens: never "OK", never "Continue".
 */
export const BigButton = ({
  label,
  face,
  colour = childTheme.colors.accent,
  textColour = '#ffffff',
  size = 'primary',
  onPress,
  disabled = false,
  fullWidth = true,
  testID,
  style,
}: {
  label: string;
  face?: string;
  colour?: string;
  textColour?: string;
  size?: ButtonSize;
  onPress: () => void;
  disabled?: boolean;
  fullWidth?: boolean;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}) => {
  const spec = SIZES[size];
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      style={({ pressed }) => [
        styles.bigButton,
        childTheme.shadows.raised,
        { minHeight: spec.height, backgroundColor: colour },
        fullWidth ? styles.fullWidth : styles.hugContent,
        pressed && styles.pressed,
        // Disabled keeps its label. A greyed control with no words is a puzzle.
        disabled && styles.dimmed,
        style,
      ]}
    >
      <Text style={[styles.bigButtonLabel, { fontSize: spec.font, color: textColour }]}>
        {label}
      </Text>
      {face !== undefined && <Text style={{ fontSize: spec.font + 2 }}>{face}</Text>}
    </Pressable>
  );
};

/**
 * The quieter of two choices — including, deliberately, the route into the
 * parent area. The door a grown-up needs is never the prettier button.
 */
export const QuietButton = ({
  label,
  face,
  onPress,
  fullWidth = true,
  soft = false,
  testID,
  style,
}: {
  label: string;
  face?: string;
  onPress: () => void;
  fullWidth?: boolean;
  soft?: boolean;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}) => (
  <Pressable
    testID={testID}
    onPress={onPress}
    accessibilityRole="button"
    accessibilityLabel={label}
    style={({ pressed }) => [
      styles.quietButton,
      { backgroundColor: soft ? childTheme.colors.mutedSoft : childTheme.colors.muted },
      fullWidth ? styles.fullWidth : styles.hugContent,
      pressed && styles.pressed,
      style,
    ]}
  >
    {face !== undefined && <Text style={styles.quietFace}>{face}</Text>}
    <Text style={styles.quietLabel}>{label}</Text>
  </Pressable>
);

/** The same pill, in the same place, on every screen that has one. */
export const GoHomeButton = ({
  onPress,
  testID = 'home-button',
}: {
  onPress: () => void;
  testID?: string;
}) => <QuietButton label="Go home" face="🏠" onPress={onPress} fullWidth={false} testID={testID} />;

/* -------------------------------------------------------------------------- */
/* The talk button                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The single most important control in the app.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 168pt. NEVER MOVES, NEVER RESIZES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Face, fill and label change together across all seven states, so nothing
 * depends on colour alone or on motion alone — which is what makes the Reduce
 * Motion variant lose no information at all. It breathes while recording; under
 * Reduce Motion the breath is replaced by a static ring, because "the mic is
 * open" must stay visible when the animation does not run.
 *
 * RECORDING IS GREEN, NOT RED. Red means stop, and a child pressing a red
 * button to speak is being taught the wrong thing.
 */
export const TalkButton = ({
  face,
  label,
  fill,
  breathing,
  tappable,
  onPress,
  testID = 'talk-button',
}: {
  face: string;
  label: string;
  fill: string;
  breathing: boolean;
  tappable: boolean;
  onPress: () => void;
  testID?: string;
}) => {
  const pulse = useRef(new Animated.Value(1)).current;
  const reduced = useReducedMotion();
  const ring = breathing && reduced;

  useEffect(() => {
    if (!breathing || reduced) {
      pulse.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1.08,
          duration: childTheme.motion.pulse / 2,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 1,
          duration: childTheme.motion.pulse / 2,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => {
      loop.stop();
    };
  }, [breathing, pulse, reduced]);

  return (
    <Animated.View style={[ring && styles.talkRing, { transform: [{ scale: pulse }] }]}>
      <Pressable
        testID={testID}
        onPress={onPress}
        disabled={!tappable}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint="Tap to talk to your friend"
        accessibilityState={{ disabled: !tappable }}
        style={({ pressed }) => [
          styles.talkButton,
          childTheme.shadows.talk,
          { backgroundColor: fill },
          !tappable && styles.dimmed,
          pressed && styles.pressed,
        ]}
      >
        <Text style={styles.talkFace}>{face}</Text>
        <Text style={styles.talkLabel}>{label}</Text>
      </Pressable>
    </Animated.View>
  );
};

/* -------------------------------------------------------------------------- */
/* Speech                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * What the character just said.
 *
 * Carries its own white background rather than relying on what happens to be
 * behind it: on the conversation screen that is a live 3D diorama, and a
 * transparent caption over a moving set is unreadable half the time.
 */
export const SpeechBubble = ({ text, testID }: { text: string; testID?: string }) => (
  <View style={[styles.bubble, childTheme.shadows.bubble]} testID={testID}>
    <Text style={styles.bubbleText}>{text}</Text>
  </View>
);

/** The resting invitation, before anyone has spoken. */
export const PromptPill = ({ text, testID }: { text: string; testID?: string }) => (
  <View style={[styles.promptPill, childTheme.shadows.bubble]} testID={testID}>
    <Text style={styles.bubbleText}>{text}</Text>
  </View>
);

/* -------------------------------------------------------------------------- */
/* Cards, tiles, badges                                                        */
/* -------------------------------------------------------------------------- */

/** A white card that sits on the cream ground. */
export const Card = ({
  children,
  onPress,
  colour = childTheme.colors.surface,
  testID,
  style,
}: {
  children: ReactNode;
  onPress?: () => void;
  colour?: string;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}) => {
  const body = (pressed: boolean) => (
    <View
      style={[
        styles.card,
        childTheme.shadows.card,
        { backgroundColor: colour },
        pressed && styles.pressed,
        style,
      ]}
    >
      {children}
    </View>
  );

  return onPress === undefined ? (
    <View testID={testID}>{body(false)}</View>
  ) : (
    <Pressable testID={testID} onPress={onPress} accessibilityRole="button">
      {({ pressed }) => body(pressed)}
    </Pressable>
  );
};

/**
 * A home tile.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POSITION IS THE LABEL
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Six tiles, fixed order, forever. A pre-reader navigates by muscle memory, so
 * reordering by "recent" or "suggested" would break the app for the youngest
 * users it exists for. Icon disc, colour and word on every one.
 */
export const Tile = ({
  icon,
  label,
  colour,
  onPress,
  testID,
}: {
  icon: string;
  label: string;
  colour: string;
  onPress: () => void;
  testID?: string;
}) => (
  <Pressable
    testID={testID}
    onPress={onPress}
    accessibilityRole="button"
    accessibilityLabel={label}
    style={styles.tileWrap}
  >
    {({ pressed }) => (
      <View style={[styles.tile, childTheme.shadows.card, pressed && styles.pressed]}>
        <View style={[styles.tileDisc, { backgroundColor: colour }]}>
          <Text style={styles.tileIcon}>{icon}</Text>
        </View>
        <Text style={styles.tileLabel}>{label}</Text>
      </View>
    )}
  </Pressable>
);

/**
 * A reward.
 *
 * Unearned badges keep their tile, their position and their name at 35% — a
 * child sees what is coming without being told they have missed it. Never
 * hidden, and never counted: there is no "3 of 7" anywhere a child can see.
 */
export const BadgeTile = ({
  icon,
  label,
  earned,
  testID,
}: {
  icon: string;
  label: string;
  earned: boolean;
  testID?: string;
}) => (
  <View
    testID={testID}
    accessible
    accessibilityLabel={earned ? `${label}, earned` : `${label}, not yet`}
    style={[styles.badge, childTheme.shadows.card, !earned && styles.unearned]}
  >
    <View
      style={[
        styles.badgeDisc,
        { backgroundColor: earned ? childTheme.colors.tileStars : childTheme.colors.tileLocked },
      ]}
    >
      <Text style={styles.badgeIcon}>{icon}</Text>
    </View>
    <Text style={styles.badgeLabel}>{label}</Text>
  </View>
);

/**
 * A bar that fills. Never a number, never a total, never a comparison.
 *
 * "12 of 50" teaches a child they are behind. A bar that is fuller than it was
 * last time teaches them they are growing, which is the only true statement of
 * the two.
 */
export const ProgressBar = ({
  fraction,
  colour = childTheme.colors.accent,
  testID,
}: {
  fraction: number;
  colour?: string;
  testID?: string;
}) => {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0));
  return (
    <View style={styles.progressTrack} testID={testID} accessibilityRole="progressbar">
      <View
        style={[
          styles.progressFill,
          { width: `${String(clamped * 100)}%` as `${number}%`, backgroundColor: colour },
        ]}
      />
    </View>
  );
};

/* -------------------------------------------------------------------------- */
/* States                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Loading.
 *
 * Never a bare spinner and never a percentage: a child cannot read a progress
 * bar, and a bare spinner is what a broken app looks like. The character stays,
 * and is simply thinking. On the conversation screen the 3D rig does this job
 * instead, and this never appears.
 */
export const Thinking = ({ slug, testID }: { slug: string | undefined; testID?: string }) => {
  const spin = useRef(new Animated.Value(0)).current;
  const reduced = useReducedMotion();

  useEffect(() => {
    if (reduced) {
      spin.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.timing(spin, {
        toValue: 1,
        duration: 1000,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => {
      loop.stop();
    };
  }, [reduced, spin]);

  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });

  return (
    <View style={styles.centred} testID={testID}>
      <Float>
        <Avatar slug={slug} size={160} />
      </Float>
      <Animated.View style={[styles.spinner, { transform: [{ rotate }] }]} />
      <Text style={styles.thinkingText}>Thinking…</Text>
    </View>
  );
};

/**
 * A failure.
 *
 * ONE WARM SENTENCE IN THE CHARACTER'S VOICE. No code, no status, no request id,
 * no provider name, and no "error" — and "Try again" only when a retry could
 * plausibly help. The bubble apologises; the button never scolds.
 */
export const FriendlyError = ({
  message,
  slug,
  onRetry,
  onHome,
  testID = 'friendly-error',
}: {
  message: string;
  slug: string | undefined;
  onRetry?: () => void;
  onHome?: () => void;
  testID?: string;
}) => (
  <View style={styles.errorStage} testID={testID}>
    <Avatar slug={slug} size={160} />
    <SpeechBubble text={message} />
    {onRetry !== undefined && (
      <BigButton
        label="Try again"
        face="🔄"
        size="medium"
        fullWidth={false}
        onPress={onRetry}
        testID="retry-button"
      />
    )}
    {onHome !== undefined && <GoHomeButton onPress={onHome} />}
  </View>
);

/**
 * The offline banner.
 *
 * Persistent rather than a toast: a child who missed a toast has no way to find
 * out why nothing is working. Phrased as a fact about the world, not a fault —
 * and never as something the child did.
 */
export const OfflineBanner = ({ visible }: { visible: boolean }) =>
  visible ? (
    <View style={styles.offline} testID="offline-banner" accessibilityRole="alert">
      <Text style={styles.offlineText}>📡 No internet right now — some things are resting.</Text>
    </View>
  ) : null;

/* -------------------------------------------------------------------------- */

const styles = StyleSheet.create({
  screen: { flex: 1 },
  scrollContent: { flexGrow: 1 },
  spacer: { flex: 1, minHeight: childTheme.spacing.md },
  centred: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: childTheme.spacing.lg,
  },

  hero: {
    fontFamily: fonts.child.heavy,
    fontSize: childTheme.text.hero,
    lineHeight: childTheme.text.hero * 1.4,
    color: childTheme.colors.ink,
    textAlign: 'center',
  },
  title: {
    fontFamily: fonts.child.heavy,
    fontSize: childTheme.text.title,
    lineHeight: childTheme.text.title * 1.4,
    color: childTheme.colors.ink,
    textAlign: 'center',
  },
  body: {
    fontFamily: fonts.child.regular,
    fontSize: childTheme.text.body,
    lineHeight: childTheme.text.body * 1.4,
    color: childTheme.colors.inkSoft,
    textAlign: 'center',
  },
  aside: {
    fontFamily: fonts.child.regular,
    fontSize: childTheme.text.aside,
    lineHeight: childTheme.text.aside * 1.4,
    color: childTheme.colors.inkSoft,
    textAlign: 'center',
  },

  bigButton: {
    borderRadius: childTheme.radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: childTheme.spacing.sm + 2,
    paddingHorizontal: childTheme.spacing.lg + 6,
  },
  bigButtonLabel: { fontFamily: fonts.child.heavy, color: '#ffffff' },
  fullWidth: { alignSelf: 'stretch' },
  hugContent: { alignSelf: 'center' },

  quietButton: {
    minHeight: childTheme.touch.min,
    borderRadius: childTheme.radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: childTheme.spacing.sm,
    paddingHorizontal: childTheme.spacing.lg + 4,
  },
  quietFace: { fontSize: 22 },
  quietLabel: {
    fontFamily: fonts.child.bold,
    fontSize: childTheme.text.aside,
    color: childTheme.colors.inkSoft,
  },

  pressed: { opacity: 0.85 },
  dimmed: { opacity: 0.72 },

  talkButton: {
    width: childTheme.touch.talkButton,
    height: childTheme.touch.talkButton,
    borderRadius: childTheme.touch.talkButton / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  /* Reduce Motion: the breath becomes a ring, so "the mic is open" is still
   * visible when nothing is allowed to move. */
  talkRing: {
    borderWidth: 5,
    borderColor: 'rgba(255,255,255,0.9)',
    borderRadius: 999,
    padding: 6,
  },
  talkFace: { fontSize: 60, lineHeight: 66 },
  talkLabel: {
    fontFamily: fonts.child.bold,
    fontSize: 17,
    color: '#ffffff',
    textShadowColor: 'rgba(58,42,20,0.25)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },

  bubble: {
    backgroundColor: childTheme.colors.surface,
    borderRadius: childTheme.radii.card,
    paddingVertical: childTheme.spacing.md + 2,
    paddingHorizontal: childTheme.spacing.md + 4,
    maxWidth: '90%',
  },
  promptPill: {
    backgroundColor: 'rgba(255,255,255,0.92)',
    borderRadius: childTheme.radii.pill,
    paddingVertical: 14,
    paddingHorizontal: childTheme.spacing.lg,
    maxWidth: '90%',
  },
  bubbleText: {
    fontFamily: fonts.child.regular,
    fontSize: childTheme.text.body,
    lineHeight: childTheme.text.body * 1.4,
    color: childTheme.colors.ink,
    textAlign: 'center',
  },

  card: {
    backgroundColor: childTheme.colors.surface,
    borderRadius: childTheme.radii.bigCard,
    padding: childTheme.spacing.md,
    justifyContent: 'center',
  },

  tileWrap: { flexGrow: 1, flexBasis: '46%' },
  tile: {
    minHeight: 112,
    backgroundColor: childTheme.colors.surface,
    borderRadius: childTheme.radii.card,
    alignItems: 'center',
    justifyContent: 'center',
    gap: childTheme.spacing.sm,
    padding: childTheme.spacing.sm + 4,
  },
  tileDisc: {
    width: 58,
    height: 58,
    borderRadius: 29,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tileIcon: { fontSize: 30 },
  tileLabel: {
    fontFamily: fonts.child.bold,
    fontSize: childTheme.text.aside,
    color: childTheme.colors.ink,
  },

  badge: {
    flexGrow: 1,
    flexBasis: '46%',
    minHeight: 132,
    backgroundColor: childTheme.colors.surface,
    borderRadius: childTheme.radii.card,
    alignItems: 'center',
    justifyContent: 'center',
    gap: childTheme.spacing.sm,
    padding: childTheme.spacing.sm + 4,
  },
  unearned: { opacity: 0.35 },
  badgeDisc: {
    width: 62,
    height: 62,
    borderRadius: 31,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeIcon: { fontSize: 30 },
  badgeLabel: {
    fontFamily: fonts.child.bold,
    fontSize: 16,
    lineHeight: 16 * 1.3,
    color: childTheme.colors.ink,
    textAlign: 'center',
  },

  progressTrack: {
    height: 20,
    borderRadius: childTheme.radii.pill,
    backgroundColor: childTheme.colors.muted,
    overflow: 'hidden',
  },
  progressFill: { height: '100%', borderRadius: childTheme.radii.pill },

  spinner: {
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 5,
    borderColor: childTheme.colors.muted,
    borderTopColor: childTheme.colors.thinking,
  },
  thinkingText: {
    fontFamily: fonts.child.bold,
    fontSize: childTheme.text.body,
    color: childTheme.colors.inkSoft,
  },

  errorStage: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: childTheme.spacing.lg,
    paddingHorizontal: childTheme.spacing.lg,
  },

  offline: {
    backgroundColor: childTheme.colors.warning,
    paddingVertical: 9,
    paddingHorizontal: childTheme.spacing.lg - 4,
  },
  offlineText: {
    fontFamily: fonts.child.semibold,
    fontSize: 15,
    lineHeight: 15 * 1.4,
    color: '#ffffff',
    textAlign: 'center',
  },
});

/** The two-column grid every child list uses. */
export const gridStyles = StyleSheet.create({
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: childTheme.spacing.sm + 4,
  },
});
