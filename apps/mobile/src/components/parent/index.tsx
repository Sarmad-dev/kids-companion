import { useState, type ReactNode } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type KeyboardTypeOptions,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';

import { fonts } from '../../theme/fonts';
import { parentTheme } from '../../theme/parent-theme';

/**
 * The parent-mode component kit.
 *
 * Dense, neutral, and legible at 12pt — a parent is reading a settings screen,
 * not being delighted. 44pt targets, 6pt radii, IBM Plex Sans, and one blue for
 * action. Nothing here shares a token with `components/child`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE DESTRUCTIVE LADDER
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Red is reserved for irreversible things, and the filled red button is only
 * reachable after typing the child's name — see `DangerButton`'s `enabled`
 * prop and the delete screen that uses it. Separating the gesture from the
 * consequence is the whole point: a parent who taps by accident has not deleted
 * their child's history.
 */

/* -------------------------------------------------------------------------- */
/* Frame                                                                       */
/* -------------------------------------------------------------------------- */

export const ParentScreen = ({
  children,
  padded = true,
  centred = false,
  gap = 12,
  testID,
}: {
  children: ReactNode;
  padded?: boolean;
  /** Terminal screens (update, maintenance) centre their content vertically. */
  centred?: boolean;
  gap?: number;
  testID?: string;
}) => (
  <ScrollView
    testID={testID}
    style={styles.screen}
    contentContainerStyle={[
      styles.screenContent,
      padded && styles.screenPadding,
      centred && styles.screenCentred,
      { gap },
    ]}
    keyboardShouldPersistTaps="handled"
  >
    {children}
  </ScrollView>
);

/* -------------------------------------------------------------------------- */
/* Type                                                                        */
/* -------------------------------------------------------------------------- */

export const Display = ({ children }: { children: ReactNode }) => (
  <Text style={styles.display} accessibilityRole="header">
    {children}
  </Text>
);

export const PageTitle = ({ children }: { children: ReactNode }) => (
  <Text style={styles.pageTitle} accessibilityRole="header">
    {children}
  </Text>
);

export const CardTitle = ({ children }: { children: ReactNode }) => (
  <Text style={styles.cardTitle}>{children}</Text>
);

export const SectionTitle = ({ children }: { children: ReactNode }) => (
  <Text style={styles.sectionTitle}>{children}</Text>
);

/** The uppercase group heading inside a dense card. */
export const GroupLabel = ({ children }: { children: ReactNode }) => (
  <Text style={styles.groupLabel}>{children}</Text>
);

export const Body = ({
  children,
  style,
}: {
  children: ReactNode;
  style?: StyleProp<TextStyle>;
}) => <Text style={[styles.body, style]}>{children}</Text>;

export const Helper = ({ children }: { children: ReactNode }) => (
  <Text style={styles.helper}>{children}</Text>
);

export const Faint = ({ children }: { children: ReactNode }) => (
  <Text style={styles.faint}>{children}</Text>
);

/** Values a parent may need to quote to support. The only mono in the product. */
export const Mono = ({ children }: { children: ReactNode }) => (
  <Text style={styles.mono} selectable>
    {children}
  </Text>
);

/* -------------------------------------------------------------------------- */
/* Surfaces                                                                    */
/* -------------------------------------------------------------------------- */

export const Card = ({
  children,
  tone = 'plain',
  gap = 10,
  testID,
  style,
}: {
  children: ReactNode;
  tone?: 'plain' | 'action' | 'danger' | 'good';
  gap?: number;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}) => (
  <View
    testID={testID}
    style={[
      styles.card,
      { gap },
      tone === 'action' && { borderColor: parentTheme.colors.actionWashBorder },
      tone === 'danger' && { borderColor: parentTheme.colors.dangerBorder },
      tone === 'good' && { borderColor: parentTheme.colors.goodBorder },
      style,
    ]}
  >
    {children}
  </View>
);

/** A muted explanatory block. Grey, never a colour that implies a state. */
export const Note = ({ children }: { children: ReactNode }) => (
  <View style={styles.note}>
    <Text style={styles.noteText}>{children}</Text>
  </View>
);

export type BannerTone = 'good' | 'danger' | 'warn' | 'info';

/**
 * The four banners.
 *
 * A save confirmation says where the change was applied, because "Saved" alone
 * invites a parent to assume the device did it — and these are enforced on our
 * servers, which is the only reason they are worth anything.
 */
export const Banner = ({ tone, children }: { tone: BannerTone; children: ReactNode }) => {
  const palette = {
    good: {
      bg: parentTheme.colors.goodWash,
      border: parentTheme.colors.goodBorder,
      fg: parentTheme.colors.good,
    },
    danger: {
      bg: parentTheme.colors.dangerWash,
      border: parentTheme.colors.dangerBorder,
      fg: parentTheme.colors.dangerText,
    },
    warn: {
      bg: parentTheme.colors.warnWash,
      border: parentTheme.colors.warnBorder,
      fg: parentTheme.colors.warnText,
    },
    info: {
      bg: parentTheme.colors.actionWash,
      border: parentTheme.colors.actionWashBorder,
      fg: parentTheme.colors.actionWashText,
    },
  }[tone];

  return (
    <View
      accessibilityRole="alert"
      style={[styles.banner, { backgroundColor: palette.bg, borderColor: palette.border }]}
    >
      <Text style={[styles.bannerText, { color: palette.fg }]}>{children}</Text>
    </View>
  );
};

/** The parent-mode offline strip. Quieter than the child's, and it says what waits. */
export const OfflineBanner = ({ visible }: { visible: boolean }) =>
  visible ? (
    <View style={styles.offline} testID="parent-offline-banner" accessibilityRole="alert">
      <Text style={styles.offlineText}>
        📡 You&apos;re offline. Showing the last saved data; changes will wait.
      </Text>
    </View>
  ) : null;

export const Tag = ({
  label,
  bg = parentTheme.colors.inset,
  fg = parentTheme.colors.inkSoft,
}: {
  label: string;
  bg?: string;
  fg?: string;
}) => (
  <View style={[styles.tag, { backgroundColor: bg }]}>
    <Text style={[styles.tagText, { color: fg }]}>{label}</Text>
  </View>
);

/** The three tags every list in the parent area uses. */
export const TAG_TONES = {
  good: { bg: parentTheme.colors.goodWash, fg: parentTheme.colors.good },
  warn: { bg: parentTheme.colors.warnWash, fg: parentTheme.colors.warnText },
  neutral: { bg: parentTheme.colors.inset, fg: parentTheme.colors.inkSoft },
  action: { bg: parentTheme.colors.actionWash, fg: parentTheme.colors.actionWashText },
} as const;

/* -------------------------------------------------------------------------- */
/* Buttons                                                                     */
/* -------------------------------------------------------------------------- */

export const PrimaryButton = ({
  label,
  onPress,
  loading = false,
  disabled = false,
  testID,
}: {
  label: string;
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
  testID?: string;
}) => (
  <Pressable
    testID={testID}
    onPress={onPress}
    disabled={disabled || loading}
    accessibilityRole="button"
    accessibilityState={{ disabled: disabled || loading, busy: loading }}
    style={({ pressed }) => [
      styles.primaryButton,
      (disabled || loading) && styles.buttonInert,
      pressed && styles.pressed,
    ]}
  >
    <Text style={styles.primaryLabel}>{loading ? 'Just a moment…' : label}</Text>
  </Pressable>
);

export const SecondaryButton = ({
  label,
  onPress,
  disabled = false,
  testID,
  style,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}) => (
  <Pressable
    testID={testID}
    onPress={onPress}
    disabled={disabled}
    accessibilityRole="button"
    style={({ pressed }) => [
      styles.secondaryButton,
      disabled && styles.buttonInert,
      pressed && styles.pressed,
      style,
    ]}
  >
    <Text style={styles.secondaryLabel}>{label}</Text>
  </Pressable>
);

/** Reversible destructive: outlined, so it reads as serious rather than final. */
export const DangerOutlineButton = ({
  label,
  onPress,
  testID,
}: {
  label: string;
  onPress: () => void;
  testID?: string;
}) => (
  <Pressable
    testID={testID}
    onPress={onPress}
    accessibilityRole="button"
    style={({ pressed }) => [styles.dangerOutline, pressed && styles.pressed]}
  >
    <Text style={styles.dangerOutlineLabel}>{label}</Text>
  </Pressable>
);

/**
 * Irreversible.
 *
 * Filled red, and inert until `enabled` — which every caller ties to a
 * confirmation the parent has typed themselves. Disabled it keeps its label:
 * a greyed control with no words is a puzzle in either mode.
 */
export const DangerButton = ({
  label,
  onPress,
  enabled = true,
  testID,
}: {
  label: string;
  onPress: () => void;
  enabled?: boolean;
  testID?: string;
}) => (
  <Pressable
    testID={testID}
    onPress={onPress}
    disabled={!enabled}
    accessibilityRole="button"
    accessibilityState={{ disabled: !enabled }}
    style={({ pressed }) => [
      styles.dangerButton,
      !enabled && styles.dangerButtonInert,
      pressed && enabled && styles.pressed,
    ]}
  >
    <Text style={[styles.dangerLabel, !enabled && styles.dangerLabelInert]}>{label}</Text>
  </Pressable>
);

export const LinkButton = ({
  label,
  onPress,
  tone = 'action',
  testID,
  style,
}: {
  label: string;
  onPress: () => void;
  tone?: 'action' | 'quiet';
  testID?: string;
  style?: StyleProp<ViewStyle>;
}) => (
  <Pressable
    testID={testID}
    onPress={onPress}
    accessibilityRole="button"
    style={({ pressed }) => [styles.linkButton, pressed && styles.pressed, style]}
  >
    <Text style={[styles.linkLabel, tone === 'quiet' && { color: parentTheme.colors.inkSoft }]}>
      {label}
    </Text>
  </Pressable>
);

/* -------------------------------------------------------------------------- */
/* Fields                                                                      */
/* -------------------------------------------------------------------------- */

export type FieldState = 'rest' | 'error' | 'valid';

/**
 * A labelled field.
 *
 * Validated INLINE rather than on submit — the 12-character password rule is
 * stated up front and answered as it is typed, so nobody discovers it after
 * filling in a form. `error` and `hint` are separate: the error says what is
 * wrong now, the hint says what good looks like, and a field can want both.
 */
export const Field = ({
  label,
  value,
  onChangeText,
  placeholder,
  secureTextEntry,
  keyboardType,
  autoCapitalize,
  autoComplete,
  multiline = false,
  state = 'rest',
  error,
  success,
  hint,
  editable = true,
  testID,
}: {
  label?: string;
  value: string;
  onChangeText: (next: string) => void;
  placeholder?: string;
  secureTextEntry?: boolean;
  keyboardType?: KeyboardTypeOptions;
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  autoComplete?: 'email' | 'password' | 'password-new' | 'off';
  multiline?: boolean;
  state?: FieldState;
  error?: string;
  /** The green counterpart of `error`: what good looks like, once it does. */
  success?: string;
  hint?: string;
  editable?: boolean;
  testID?: string;
}) => {
  const [focused, setFocused] = useState(false);
  const borderColor =
    state === 'error'
      ? parentTheme.colors.danger
      : state === 'valid'
        ? parentTheme.colors.good
        : focused
          ? parentTheme.colors.action
          : parentTheme.colors.border;

  return (
    <View style={styles.field}>
      {label !== undefined && <Text style={styles.fieldLabel}>{label}</Text>}
      <TextInput
        testID={testID}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={parentTheme.colors.inkFaint}
        secureTextEntry={secureTextEntry}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
        autoComplete={autoComplete}
        multiline={multiline}
        editable={editable}
        onFocus={() => {
          setFocused(true);
        }}
        onBlur={() => {
          setFocused(false);
        }}
        style={[
          styles.input,
          multiline && styles.inputMultiline,
          { borderColor },
          focused && state === 'rest' && styles.inputFocusRing,
          !editable && styles.inputDisabled,
        ]}
      />
      {error !== undefined && <Text style={styles.fieldError}>{error}</Text>}
      {success !== undefined && <Text style={styles.fieldSuccess}>{success}</Text>}
      {hint !== undefined && <Text style={styles.fieldHint}>{hint}</Text>}
    </View>
  );
};

/* -------------------------------------------------------------------------- */
/* Controls                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A switch.
 *
 * Used for the REVERSIBLE settings only — pause, notifications, an optional
 * consent. Anything irreversible needs a form and a typed confirmation, never
 * a control a sleeve can catch.
 */
export const Switch = ({
  on,
  onToggle,
  label,
  large = false,
  tone = 'action',
  testID,
}: {
  on: boolean;
  onToggle: () => void;
  label: string;
  large?: boolean;
  tone?: 'action' | 'warn';
  testID?: string;
}) => {
  const w = large ? 52 : 48;
  const h = large ? 30 : 28;
  const knob = large ? 24 : 22;
  const onColour = tone === 'warn' ? parentTheme.colors.warn : parentTheme.colors.action;

  return (
    <Pressable
      testID={testID}
      onPress={onToggle}
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: on }}
      hitSlop={8}
      style={[
        styles.track,
        {
          width: w,
          height: h,
          borderRadius: h / 2,
          backgroundColor: on ? onColour : parentTheme.colors.trackOff,
          alignItems: on ? 'flex-end' : 'flex-start',
        },
      ]}
    >
      <View
        style={[
          styles.knob,
          parentTheme.shadows.knob,
          { width: knob, height: knob, borderRadius: knob / 2 },
        ]}
      />
    </Pressable>
  );
};

/** A settings row: label, optional hint, and one control at the end. */
export const SettingRow = ({
  label,
  hint,
  children,
  last = false,
  emphasis = false,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  last?: boolean;
  emphasis?: boolean;
}) => (
  <View style={[styles.settingRow, last && styles.noHairline]}>
    <View style={styles.settingText}>
      <Text style={emphasis ? styles.settingLabelStrong : styles.settingLabel}>{label}</Text>
      {hint !== undefined && <Text style={styles.settingHint}>{hint}</Text>}
    </View>
    {children}
  </View>
);

export interface SegmentedOption<T extends string> {
  readonly value: T;
  readonly label: string;
}

/** Two or three exclusive choices, in a trough. */
export const Segmented = <T extends string>({
  value,
  options,
  onChange,
  testID,
}: {
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (next: T) => void;
  testID?: string;
}) => (
  <View style={styles.segmentTrough} testID={testID}>
    {options.map((option) => {
      const on = option.value === value;
      return (
        <Pressable
          key={option.value}
          onPress={() => {
            onChange(option.value);
          }}
          accessibilityRole="radio"
          accessibilityState={{ selected: on }}
          style={[styles.segment, on && styles.segmentOn]}
        >
          <Text style={[styles.segmentLabel, on && styles.segmentLabelOn]}>{option.label}</Text>
        </Pressable>
      );
    })}
  </View>
);

/** A ± stepper. Never a free-text number, so an invalid value cannot be typed. */
export const Stepper = ({
  label,
  range,
  value,
  onDecrement,
  onIncrement,
  error,
  testID,
}: {
  label: string;
  range: string;
  value: string;
  onDecrement: () => void;
  onIncrement: () => void;
  error?: string;
  testID?: string;
}) => (
  <View style={styles.stepperBlock} testID={testID}>
    <View style={styles.stepperHead}>
      <Text style={styles.settingLabel}>{label}</Text>
      <Text style={styles.rangeText}>{range}</Text>
    </View>
    <View style={styles.stepperRow}>
      <Pressable
        onPress={onDecrement}
        accessibilityRole="button"
        accessibilityLabel={`Decrease ${label}`}
        style={({ pressed }) => [styles.stepperButton, pressed && styles.pressed]}
      >
        <Text style={styles.stepperGlyph}>−</Text>
      </Pressable>
      <Text style={styles.stepperValue}>{value}</Text>
      <Pressable
        onPress={onIncrement}
        accessibilityRole="button"
        accessibilityLabel={`Increase ${label}`}
        style={({ pressed }) => [styles.stepperButton, pressed && styles.pressed]}
      >
        <Text style={styles.stepperGlyph}>+</Text>
      </Pressable>
    </View>
    {error !== undefined && <Text style={styles.fieldError}>{error}</Text>}
  </View>
);

/** A selectable chip: allowed days, topics of interest, a child filter. */
export const Chip = ({
  label,
  on,
  onPress,
  grow = false,
  testID,
}: {
  label: string;
  on: boolean;
  onPress: () => void;
  grow?: boolean;
  testID?: string;
}) => (
  <Pressable
    testID={testID}
    onPress={onPress}
    accessibilityRole="checkbox"
    accessibilityState={{ checked: on }}
    style={({ pressed }) => [
      styles.chip,
      grow && styles.chipGrow,
      on ? styles.chipOn : styles.chipOff,
      pressed && styles.pressed,
    ]}
  >
    <Text style={[styles.chipLabel, on && styles.chipLabelOn]}>{label}</Text>
  </Pressable>
);

/** One of a set. The dot is filled, the card is washed, and the border moves. */
export const RadioRow = ({
  label,
  hint,
  on,
  onPress,
  leading,
  trailing,
  testID,
}: {
  label: string;
  hint?: string;
  on: boolean;
  onPress: () => void;
  leading?: ReactNode;
  trailing?: string;
  testID?: string;
}) => (
  <Pressable
    testID={testID}
    onPress={onPress}
    accessibilityRole="radio"
    accessibilityState={{ selected: on }}
    style={({ pressed }) => [
      styles.optionRow,
      on ? styles.optionOn : styles.optionOff,
      pressed && styles.pressed,
    ]}
  >
    <View style={[styles.radioDot, on ? styles.radioDotOn : styles.radioDotOff]} />
    {leading}
    <View style={styles.optionText}>
      <Text style={styles.optionLabel}>{label}</Text>
      {hint !== undefined && <Text style={styles.settingHint}>{hint}</Text>}
    </View>
    {trailing !== undefined && <Text style={styles.faint}>{trailing}</Text>}
  </Pressable>
);

/** Any number of a set — the character allow-list. Tick none to allow every one. */
export const CheckRow = ({
  label,
  on,
  onPress,
  leading,
  trailing,
  testID,
}: {
  label: string;
  on: boolean;
  onPress: () => void;
  leading?: ReactNode;
  trailing?: string;
  testID?: string;
}) => (
  <Pressable
    testID={testID}
    onPress={onPress}
    accessibilityRole="checkbox"
    accessibilityState={{ checked: on }}
    style={({ pressed }) => [
      styles.optionRow,
      on ? styles.optionOn : styles.optionOff,
      pressed && styles.pressed,
    ]}
  >
    <View style={[styles.checkBox, on ? styles.checkBoxOn : styles.checkBoxOff]}>
      {on && <Text style={styles.checkMark}>✓</Text>}
    </View>
    {leading}
    <View style={styles.optionText}>
      <Text style={styles.optionLabel}>{label}</Text>
    </View>
    {trailing !== undefined && <Text style={styles.faint}>{trailing}</Text>}
  </Pressable>
);

/** A tappable row that leads somewhere. */
export const ListRow = ({
  label,
  meta,
  onPress,
  tone = 'plain',
  tag,
  sublabel,
  testID,
}: {
  label: string;
  meta?: string;
  onPress: () => void;
  tone?: 'plain' | 'danger';
  tag?: { label: string; bg: string; fg: string };
  sublabel?: string;
  testID?: string;
}) => (
  <Pressable
    testID={testID}
    onPress={onPress}
    accessibilityRole="button"
    style={({ pressed }) => [styles.listRow, pressed && styles.rowPressed]}
  >
    <View style={styles.listRowText}>
      <Text
        style={[styles.listRowLabel, tone === 'danger' && { color: parentTheme.colors.danger }]}
      >
        {label}
      </Text>
      {sublabel !== undefined && <Text style={styles.listRowSub}>{sublabel}</Text>}
    </View>
    {tag !== undefined && <Tag label={tag.label} bg={tag.bg} fg={tag.fg} />}
    {meta !== undefined && <Text style={styles.faint}>{meta}</Text>}
    <Text style={styles.chevron}>›</Text>
  </Pressable>
);

/* -------------------------------------------------------------------------- */
/* Data display                                                                */
/* -------------------------------------------------------------------------- */

/** One headline figure. Always carries what it is OF, never a bare number. */
export const StatTile = ({
  caption,
  value,
  unit,
  meta,
  tone = 'plain',
  testID,
}: {
  caption: string;
  value: string;
  unit?: string;
  meta?: string;
  tone?: 'plain' | 'danger';
  testID?: string;
}) => (
  <View
    testID={testID}
    style={[styles.statTile, tone === 'danger' && { borderColor: parentTheme.colors.dangerBorder }]}
  >
    <Text
      style={[styles.statCaption, tone === 'danger' && { color: parentTheme.colors.dangerText }]}
    >
      {caption}
    </Text>
    <Text style={styles.statValueRow}>
      <Text style={[styles.statValue, tone === 'danger' && { color: parentTheme.colors.danger }]}>
        {value}
      </Text>
      {unit !== undefined && <Text style={styles.statUnit}> {unit}</Text>}
    </Text>
    {meta !== undefined && <Text style={styles.statMeta}>{meta}</Text>}
  </View>
);

/** A small compact stat, used in the dashboard's 2-up grid. */
export const MiniStat = ({ value, caption }: { value: string; caption: string }) => (
  <View style={styles.miniStat}>
    <Text style={styles.miniValue}>{value}</Text>
    <Text style={styles.miniCaption}>{caption}</Text>
  </View>
);

/**
 * A bar chart.
 *
 * `values` are already normalised to 0–1 by the caller, because the caller is
 * the one that knows what the ceiling means. Bars never fall below a hairline,
 * so a quiet day reads as a quiet day rather than as missing data.
 */
export const BarChart = ({
  values,
  colour = parentTheme.colors.action,
  height = 104,
  gap = 2,
  highlight,
  highlightColour = parentTheme.colors.warn,
  testID,
}: {
  values: readonly number[];
  colour?: string;
  height?: number;
  gap?: number;
  /** Bars at or above this fraction get the second colour. */
  highlight?: number;
  highlightColour?: string;
  testID?: string;
}) => (
  <View style={[styles.chart, { height, gap }]} testID={testID}>
    {values.map((raw, index) => {
      const value = Math.min(1, Math.max(0, Number.isFinite(raw) ? raw : 0));
      const isHigh = highlight !== undefined && value >= highlight;
      return (
        <View
          // Bars have no identity of their own — position IS the identity.
          key={index}
          style={[
            styles.bar,
            {
              height: `${String(Math.max(3, Math.round(value * 100)))}%` as `${number}%`,
              backgroundColor: isHigh ? highlightColour : colour,
            },
          ]}
        />
      );
    })}
  </View>
);

export const ChartHeader = ({ title, meta }: { title: string; meta: string }) => (
  <View style={styles.chartHead}>
    <CardTitle>{title}</CardTitle>
    <Text style={styles.faint}>{meta}</Text>
  </View>
);

/**
 * A level, as four segments and a phrase.
 *
 * DESCRIPTIVE BANDS, NEVER SCORES. "growing steadily" is a thing a parent can
 * do something with; "62%" is a thing they will compare to another child.
 */
export const LevelMeter = ({
  name,
  band,
  filled,
  total = 4,
}: {
  name: string;
  band: string;
  filled: number;
  total?: number;
}) => (
  <View style={styles.levelBlock}>
    <View style={styles.levelHead}>
      <Text style={styles.levelName}>{name}</Text>
      <Text style={styles.levelBand}>{band}</Text>
    </View>
    <View style={styles.levelSegments}>
      {Array.from({ length: total }, (_, index) => (
        <View
          // A segment is its position in the meter and nothing else.
          key={index}
          style={[
            styles.levelSegment,
            {
              backgroundColor:
                index < filled ? parentTheme.colors.action : parentTheme.colors.border,
            },
          ]}
        />
      ))}
    </View>
  </View>
);

/** A horizontal count bar, used for safety categories. */
export const CountBar = ({
  label,
  count,
  fraction,
}: {
  label: string;
  count: number;
  fraction: number;
}) => (
  <View style={styles.countRow}>
    <Text style={styles.countLabel}>{label}</Text>
    <View style={styles.countTrack}>
      <View
        style={[
          styles.countFill,
          {
            width:
              `${String(Math.round(Math.min(1, Math.max(0, fraction)) * 100))}%` as `${number}%`,
          },
        ]}
      />
    </View>
    <Text style={styles.countValue}>{count}</Text>
  </View>
);

/** A ✓ line in a list of what a plan allows, or what still works. */
export const TickLine = ({ children }: { children: ReactNode }) => (
  <View style={styles.tickLine}>
    <Text style={styles.tickMark}>✓</Text>
    <Text style={styles.tickText}>{children}</Text>
  </View>
);

/** A − line in a list of what a deletion takes away. */
export const LossLine = ({ children }: { children: ReactNode }) => (
  <View style={styles.tickLine}>
    <Text style={styles.lossMark}>–</Text>
    <Text style={styles.tickText}>{children}</Text>
  </View>
);

/** A read-only pill: a practised sound, a new word. */
export const Pill = ({ label, mono = false }: { label: string; mono?: boolean }) => (
  <View style={styles.pill}>
    <Text style={mono ? styles.pillMono : styles.pillText}>{label}</Text>
  </View>
);

export const Row = ({
  children,
  gap = 12,
  align = 'center',
  style,
}: {
  children: ReactNode;
  gap?: number;
  align?: 'center' | 'flex-start' | 'baseline' | 'stretch';
  style?: StyleProp<ViewStyle>;
}) => <View style={[{ flexDirection: 'row', gap, alignItems: align }, style]}>{children}</View>;

export const Wrap = ({ children, gap = 8 }: { children: ReactNode; gap?: number }) => (
  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap }}>{children}</View>
);

/* -------------------------------------------------------------------------- */

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: parentTheme.colors.background },
  screenContent: { flexGrow: 1 },
  screenPadding: { padding: 16, paddingTop: 14, paddingBottom: 28 },
  screenCentred: { justifyContent: 'center', paddingHorizontal: 24 },

  display: {
    fontFamily: fonts.parent.bold,
    fontSize: parentTheme.text.display,
    lineHeight: parentTheme.text.display * 1.2,
    color: parentTheme.colors.ink,
  },
  pageTitle: {
    fontFamily: fonts.parent.bold,
    fontSize: parentTheme.text.title,
    lineHeight: parentTheme.text.title * 1.3,
    color: parentTheme.colors.ink,
  },
  sectionTitle: {
    fontFamily: fonts.parent.bold,
    fontSize: parentTheme.text.section,
    color: parentTheme.colors.ink,
  },
  cardTitle: {
    fontFamily: fonts.parent.bold,
    fontSize: parentTheme.text.cardTitle,
    color: parentTheme.colors.ink,
  },
  groupLabel: {
    fontFamily: fonts.parent.semibold,
    fontSize: 11,
    letterSpacing: 0.66,
    textTransform: 'uppercase',
    color: parentTheme.colors.inkFaint,
  },
  body: {
    fontFamily: fonts.parent.regular,
    fontSize: parentTheme.text.body,
    lineHeight: parentTheme.text.body * 1.55,
    color: parentTheme.colors.ink,
  },
  helper: {
    fontFamily: fonts.parent.regular,
    fontSize: parentTheme.text.helper,
    lineHeight: parentTheme.text.helper * 1.6,
    color: parentTheme.colors.inkSoft,
  },
  faint: {
    fontFamily: fonts.parent.regular,
    fontSize: parentTheme.text.caption,
    lineHeight: parentTheme.text.caption * 1.5,
    color: parentTheme.colors.inkFaint,
  },
  mono: {
    fontFamily: fonts.mono,
    fontSize: parentTheme.text.mono,
    color: parentTheme.colors.inkSoft,
  },

  card: {
    backgroundColor: parentTheme.colors.surface,
    borderWidth: 1,
    borderColor: parentTheme.colors.border,
    borderRadius: parentTheme.radii.control,
    padding: 14,
  },
  note: {
    backgroundColor: parentTheme.colors.inset,
    borderRadius: parentTheme.radii.control,
    padding: 12,
  },
  noteText: {
    fontFamily: fonts.parent.regular,
    fontSize: parentTheme.text.caption,
    lineHeight: parentTheme.text.caption * 1.6,
    color: parentTheme.colors.inkSoft,
  },

  banner: {
    borderWidth: 1,
    borderRadius: parentTheme.radii.control,
    paddingVertical: 11,
    paddingHorizontal: 13,
  },
  bannerText: {
    fontFamily: fonts.parent.medium,
    fontSize: parentTheme.text.helper,
    lineHeight: parentTheme.text.helper * 1.55,
  },
  offline: {
    backgroundColor: parentTheme.colors.warnWash,
    borderBottomWidth: 1,
    borderBottomColor: parentTheme.colors.warnBorder,
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  offlineText: {
    fontFamily: fonts.parent.medium,
    fontSize: parentTheme.text.caption,
    color: parentTheme.colors.warnText,
  },

  tag: {
    borderRadius: parentTheme.radii.tag,
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
  tagText: { fontFamily: fonts.parent.semibold, fontSize: 11 },

  primaryButton: {
    minHeight: parentTheme.touch.primary,
    borderRadius: parentTheme.radii.control,
    backgroundColor: parentTheme.colors.action,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  primaryLabel: { fontFamily: fonts.parent.semibold, fontSize: 15, color: '#ffffff' },
  secondaryButton: {
    minHeight: parentTheme.touch.min,
    borderRadius: parentTheme.radii.control,
    backgroundColor: parentTheme.colors.surface,
    borderWidth: 1,
    borderColor: parentTheme.colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  secondaryLabel: {
    fontFamily: fonts.parent.semibold,
    fontSize: parentTheme.text.body,
    color: parentTheme.colors.action,
  },
  dangerOutline: {
    minHeight: parentTheme.touch.min,
    borderRadius: parentTheme.radii.control,
    backgroundColor: parentTheme.colors.surface,
    borderWidth: 1,
    borderColor: parentTheme.colors.dangerBorder,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  dangerOutlineLabel: {
    fontFamily: fonts.parent.semibold,
    fontSize: parentTheme.text.body,
    color: parentTheme.colors.danger,
  },
  dangerButton: {
    minHeight: parentTheme.touch.primary,
    borderRadius: parentTheme.radii.control,
    backgroundColor: parentTheme.colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  dangerButtonInert: { backgroundColor: parentTheme.colors.inset },
  dangerLabel: { fontFamily: fonts.parent.semibold, fontSize: 15, color: '#ffffff' },
  dangerLabelInert: { color: parentTheme.colors.disabled },
  buttonInert: { opacity: 0.55 },
  pressed: { opacity: 0.8 },
  rowPressed: { borderColor: parentTheme.colors.borderStrong },

  linkButton: {
    minHeight: parentTheme.touch.min,
    alignItems: 'center',
    justifyContent: 'center',
  },
  linkLabel: {
    fontFamily: fonts.parent.medium,
    fontSize: parentTheme.text.body,
    color: parentTheme.colors.action,
  },

  field: { gap: 6 },
  fieldLabel: {
    fontFamily: fonts.parent.semibold,
    fontSize: parentTheme.text.label,
    color: parentTheme.colors.inkSoft,
  },
  input: {
    minHeight: parentTheme.touch.primary,
    borderWidth: 1,
    borderRadius: parentTheme.radii.control,
    paddingHorizontal: 12,
    fontFamily: fonts.parent.regular,
    fontSize: parentTheme.text.input,
    color: parentTheme.colors.ink,
    backgroundColor: parentTheme.colors.surface,
  },
  inputMultiline: { minHeight: 88, paddingTop: 10, textAlignVertical: 'top' },
  inputFocusRing: {
    shadowColor: parentTheme.colors.action,
    shadowOpacity: 0.14,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 0 },
    elevation: 1,
  },
  inputDisabled: { backgroundColor: parentTheme.colors.inset, color: parentTheme.colors.inkSoft },
  fieldError: {
    fontFamily: fonts.parent.semibold,
    fontSize: parentTheme.text.label,
    color: parentTheme.colors.danger,
  },
  fieldSuccess: {
    fontFamily: fonts.parent.semibold,
    fontSize: parentTheme.text.label,
    color: parentTheme.colors.good,
  },
  fieldHint: {
    fontFamily: fonts.parent.regular,
    fontSize: parentTheme.text.label,
    lineHeight: parentTheme.text.label * 1.5,
    color: parentTheme.colors.inkSoft,
  },

  track: { padding: 3, justifyContent: 'center' },
  knob: { backgroundColor: '#ffffff' },

  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 56,
    borderBottomWidth: 1,
    borderBottomColor: parentTheme.colors.hairline,
  },
  noHairline: { borderBottomWidth: 0 },
  settingText: { flex: 1, gap: 2 },
  settingLabel: {
    fontFamily: fonts.parent.medium,
    fontSize: parentTheme.text.body,
    color: parentTheme.colors.ink,
  },
  settingLabelStrong: {
    fontFamily: fonts.parent.semibold,
    fontSize: parentTheme.text.rowLabel,
    color: parentTheme.colors.ink,
  },
  settingHint: {
    fontFamily: fonts.parent.regular,
    fontSize: parentTheme.text.caption,
    lineHeight: parentTheme.text.caption * 1.5,
    color: parentTheme.colors.inkFaint,
  },

  segmentTrough: {
    flexDirection: 'row',
    backgroundColor: parentTheme.colors.inset,
    borderRadius: parentTheme.radii.control,
    padding: 3,
    gap: 3,
  },
  segment: {
    flex: 1,
    minHeight: 42,
    borderRadius: parentTheme.radii.segment,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmentOn: { backgroundColor: parentTheme.colors.surface },
  segmentLabel: {
    fontFamily: fonts.parent.semibold,
    fontSize: 13,
    color: parentTheme.colors.inkSoft,
  },
  segmentLabelOn: { color: parentTheme.colors.ink },

  stepperBlock: { gap: 8 },
  stepperHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  rangeText: {
    fontFamily: fonts.parent.regular,
    fontSize: 11.5,
    color: parentTheme.colors.inkFaint,
  },
  stepperRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  stepperButton: {
    width: parentTheme.touch.min,
    height: parentTheme.touch.min,
    borderWidth: 1,
    borderColor: parentTheme.colors.border,
    borderRadius: parentTheme.radii.control,
    backgroundColor: parentTheme.colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepperGlyph: {
    fontFamily: fonts.parent.regular,
    fontSize: 20,
    color: parentTheme.colors.action,
  },
  stepperValue: {
    flex: 1,
    textAlign: 'center',
    fontFamily: fonts.parent.bold,
    fontSize: 18,
    color: parentTheme.colors.ink,
  },

  chip: {
    minHeight: parentTheme.touch.min,
    borderRadius: parentTheme.radii.control,
    borderWidth: 1,
    paddingHorizontal: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipGrow: { flex: 1, paddingHorizontal: 4 },
  chipOn: {
    backgroundColor: parentTheme.colors.actionWash,
    borderColor: parentTheme.colors.action,
  },
  chipOff: { backgroundColor: parentTheme.colors.surface, borderColor: parentTheme.colors.border },
  chipLabel: {
    fontFamily: fonts.parent.medium,
    fontSize: 13,
    color: parentTheme.colors.inkSoft,
  },
  chipLabelOn: { fontFamily: fonts.parent.semibold, color: parentTheme.colors.actionWashText },

  optionRow: {
    minHeight: 52,
    borderRadius: parentTheme.radii.control,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  optionOn: {
    backgroundColor: parentTheme.colors.actionWash,
    borderColor: parentTheme.colors.action,
  },
  optionOff: {
    backgroundColor: parentTheme.colors.surface,
    borderColor: parentTheme.colors.border,
  },
  optionText: { flex: 1, gap: 1 },
  optionLabel: {
    fontFamily: fonts.parent.semibold,
    fontSize: 13.5,
    color: parentTheme.colors.ink,
  },
  radioDot: { width: 18, height: 18, borderRadius: 9, borderWidth: 2 },
  radioDotOn: {
    borderColor: parentTheme.colors.action,
    backgroundColor: parentTheme.colors.action,
  },
  radioDotOff: { borderColor: parentTheme.colors.borderStrong, backgroundColor: 'transparent' },
  checkBox: {
    width: 20,
    height: 20,
    borderRadius: 4,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkBoxOn: {
    borderColor: parentTheme.colors.action,
    backgroundColor: parentTheme.colors.action,
  },
  checkBoxOff: { borderColor: parentTheme.colors.borderStrong, backgroundColor: '#ffffff' },
  checkMark: { fontFamily: fonts.parent.bold, fontSize: 13, color: '#ffffff', lineHeight: 16 },

  listRow: {
    minHeight: 56,
    backgroundColor: parentTheme.colors.surface,
    borderWidth: 1,
    borderColor: parentTheme.colors.border,
    borderRadius: parentTheme.radii.control,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  listRowText: { flex: 1, gap: 3 },
  listRowLabel: {
    fontFamily: fonts.parent.medium,
    fontSize: parentTheme.text.body,
    color: parentTheme.colors.ink,
  },
  listRowSub: {
    fontFamily: fonts.parent.regular,
    fontSize: 12.5,
    color: parentTheme.colors.inkSoft,
  },
  chevron: {
    fontFamily: fonts.parent.regular,
    fontSize: 18,
    color: parentTheme.colors.borderStrong,
  },

  statTile: {
    flex: 1,
    backgroundColor: parentTheme.colors.surface,
    borderWidth: 1,
    borderColor: parentTheme.colors.border,
    borderRadius: parentTheme.radii.control,
    padding: 14,
  },
  statCaption: {
    fontFamily: fonts.parent.semibold,
    fontSize: parentTheme.text.caption,
    color: parentTheme.colors.inkSoft,
  },
  statValueRow: { marginTop: 6 },
  statValue: {
    fontFamily: fonts.parent.bold,
    fontSize: 32,
    lineHeight: 32 * 1.15,
    color: parentTheme.colors.ink,
  },
  statUnit: {
    fontFamily: fonts.parent.semibold,
    fontSize: 15,
    color: parentTheme.colors.inkSoft,
  },
  statMeta: {
    fontFamily: fonts.parent.regular,
    fontSize: parentTheme.text.caption,
    color: parentTheme.colors.inkFaint,
    marginTop: 2,
  },

  miniStat: {
    flexGrow: 1,
    flexBasis: '46%',
    backgroundColor: parentTheme.colors.surface,
    borderWidth: 1,
    borderColor: parentTheme.colors.border,
    borderRadius: parentTheme.radii.control,
    padding: 12,
  },
  miniValue: { fontFamily: fonts.parent.bold, fontSize: 22, color: parentTheme.colors.ink },
  miniCaption: {
    fontFamily: fonts.parent.semibold,
    fontSize: parentTheme.text.caption,
    lineHeight: parentTheme.text.caption * 1.4,
    color: parentTheme.colors.inkSoft,
    marginTop: 2,
  },

  chart: { flexDirection: 'row', alignItems: 'flex-end', marginTop: 12 },
  bar: { flex: 1, minWidth: 0, borderTopLeftRadius: 2, borderTopRightRadius: 2 },
  chartHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },

  levelBlock: { gap: 7 },
  levelHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  levelName: { fontFamily: fonts.parent.medium, fontSize: 13, color: parentTheme.colors.ink },
  levelBand: {
    fontFamily: fonts.parent.semibold,
    fontSize: parentTheme.text.caption,
    color: parentTheme.colors.action,
  },
  levelSegments: { flexDirection: 'row', gap: 4 },
  levelSegment: { flex: 1, height: 6, borderRadius: 3 },

  countRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  countLabel: {
    flex: 1,
    fontFamily: fonts.parent.medium,
    fontSize: 13,
    color: parentTheme.colors.ink,
  },
  countTrack: {
    width: 96,
    height: 8,
    borderRadius: 4,
    backgroundColor: parentTheme.colors.inset,
    overflow: 'hidden',
  },
  countFill: { height: '100%', borderRadius: 4, backgroundColor: parentTheme.colors.warn },
  countValue: {
    width: 18,
    textAlign: 'right',
    fontFamily: fonts.parent.semibold,
    fontSize: 13,
    color: parentTheme.colors.ink,
  },

  tickLine: { flexDirection: 'row', gap: 8 },
  tickMark: { fontFamily: fonts.parent.regular, fontSize: 13.5, color: parentTheme.colors.good },
  lossMark: { fontFamily: fonts.parent.regular, fontSize: 13.5, color: parentTheme.colors.danger },
  tickText: {
    flex: 1,
    fontFamily: fonts.parent.regular,
    fontSize: 13.5,
    lineHeight: 13.5 * 1.5,
    color: parentTheme.colors.ink,
  },

  pill: {
    borderRadius: parentTheme.radii.control,
    backgroundColor: parentTheme.colors.background,
    paddingVertical: 7,
    paddingHorizontal: 11,
  },
  pillText: { fontFamily: fonts.parent.medium, fontSize: 13, color: parentTheme.colors.ink },
  pillMono: { fontFamily: fonts.mono, fontSize: 12.5, color: parentTheme.colors.ink },
});
