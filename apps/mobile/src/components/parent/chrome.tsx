import { router, usePathname } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { fonts } from '../../theme/fonts';
import { PARENT_TABS, parentTheme } from '../../theme/parent-theme';

/**
 * The parent-mode chrome: a header bar and a tab bar.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THESE ARE HAND-BUILT RATHER THAN THE ROUTER'S OWN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Expo Router's `Stack` header and `Tabs` bar are platform-native by design:
 * they look like an iOS app on iOS and a Material app on Android, and they
 * change with the OS version. That is the right default for most apps and the
 * wrong one here, because the ENTIRE point of the parent surface is that it
 * looks like a different product from the child surface — same 6pt radii, same
 * IBM Plex Sans, same one blue, on both platforms and every OS version.
 *
 * A header that is ours is also a header that can carry the one thing the
 * native one cannot: a "Save" action whose enabled state is owned by the screen
 * beneath it.
 */

export const ParentHeader = ({
  title,
  onBack,
  action,
}: {
  title: string;
  /** Omitted on the screens a parent must not be able to back out of. */
  onBack?: () => void;
  action?: { label: string; onPress: () => void; disabled?: boolean };
}) => {
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.header, { paddingTop: insets.top }]}>
      <View style={styles.headerRow}>
        {onBack === undefined ? (
          <View style={styles.backSpacer} />
        ) : (
          <Pressable
            onPress={onBack}
            accessibilityRole="button"
            accessibilityLabel="Back"
            hitSlop={6}
            style={({ pressed }) => [styles.back, pressed && styles.backPressed]}
          >
            <Text style={styles.backGlyph}>‹</Text>
          </Pressable>
        )}

        <Text style={styles.title} numberOfLines={1} accessibilityRole="header">
          {title}
        </Text>

        {action !== undefined && (
          <Pressable
            onPress={action.onPress}
            disabled={action.disabled}
            accessibilityRole="button"
            accessibilityState={{ disabled: action.disabled }}
            style={({ pressed }) => [
              styles.action,
              action.disabled === true && styles.actionDisabled,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.actionLabel}>{action.label}</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
};

/**
 * The five tabs.
 *
 * `replace` rather than `push`: a tab is a place, not a step, and a parent who
 * taps Home → Children → Home should not have to press back twice to leave.
 */
export const ParentTabBar = () => {
  const insets = useSafeAreaInsets();
  const pathname = usePathname();

  return (
    <View style={[styles.tabBar, { paddingBottom: Math.max(insets.bottom, 4) }]}>
      {PARENT_TABS.map((tab) => {
        // The pathname the router reports has the group segments stripped, so
        // the last segment is what identifies the tab.
        const active = pathname.endsWith(tab.href.slice(tab.href.lastIndexOf('/')));
        return (
          <Pressable
            key={tab.href}
            testID={`tab-${tab.label.toLowerCase()}`}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            accessibilityLabel={tab.label}
            style={styles.tab}
            onPress={() => {
              router.replace(tab.href);
            }}
          >
            <Text style={styles.tabIcon}>{tab.icon}</Text>
            <Text
              style={[
                styles.tabLabel,
                { color: active ? parentTheme.colors.action : parentTheme.colors.inkFaint },
              ]}
            >
              {tab.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
};

const styles = StyleSheet.create({
  header: {
    backgroundColor: parentTheme.colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: parentTheme.colors.border,
  },
  headerRow: {
    height: parentTheme.touch.bar,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 8,
  },
  back: {
    minWidth: parentTheme.touch.min,
    height: parentTheme.touch.min,
    borderRadius: parentTheme.radii.control,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backPressed: { backgroundColor: '#eef2f8' },
  backSpacer: { width: 8 },
  backGlyph: {
    fontFamily: fonts.parent.regular,
    fontSize: 26,
    lineHeight: 30,
    color: parentTheme.colors.action,
  },
  title: {
    flex: 1,
    minWidth: 0,
    fontFamily: fonts.parent.bold,
    fontSize: parentTheme.text.section,
    color: parentTheme.colors.ink,
  },
  action: {
    minHeight: 36,
    borderRadius: parentTheme.radii.control,
    backgroundColor: parentTheme.colors.action,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
    marginRight: 4,
  },
  actionDisabled: { backgroundColor: parentTheme.colors.inset },
  actionLabel: { fontFamily: fonts.parent.semibold, fontSize: 13, color: '#ffffff' },
  pressed: { opacity: 0.8 },

  tabBar: {
    flexDirection: 'row',
    backgroundColor: parentTheme.colors.surface,
    borderTopWidth: 1,
    borderTopColor: parentTheme.colors.border,
    paddingTop: 6,
    paddingHorizontal: 4,
  },
  tab: {
    flex: 1,
    minHeight: parentTheme.touch.primary,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
  },
  tabIcon: { fontSize: 17, lineHeight: 20 },
  tabLabel: { fontFamily: fonts.parent.semibold, fontSize: 10 },
});
