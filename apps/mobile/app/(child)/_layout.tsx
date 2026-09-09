import { Stack } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { OfflineBanner } from '../../src/components/child/index';
import { useApp } from '../../src/state/app-context';
import { childTheme } from '../../src/theme/child-theme';

/**
 * Child mode.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NO HEADER, NO BACK GESTURE, NO HISTORY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A four-year-old pressing back eleven times should reach home, not retrace a
 * path they do not remember taking. So there is no header bar to press, the
 * platform back gesture is off, and every screen carries its own explicit "Go
 * home" — in the same place, on every screen, at 72pt.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THE BANNER FLOATS RATHER THAN PUSHING
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The conversation screen's diorama runs edge to edge, BEHIND the status bar —
 * that full bleed is what makes the character a place the child is in rather
 * than a picture on a card. A banner in the layout's flow would push every
 * screen down, including that one, and put a cream strip across the top of the
 * sky. So it is an overlay, and the screens that are not full-bleed leave room
 * for it themselves (see `Screen`'s offline inset).
 */
export default function ChildLayout() {
  const { online } = useApp();
  const insets = useSafeAreaInsets();

  return (
    <View style={styles.root}>
      <Stack
        screenOptions={{
          headerShown: false,
          gestureEnabled: false,
          animation: 'fade',
          contentStyle: { backgroundColor: childTheme.colors.background },
        }}
      />
      {!online && (
        <View style={[styles.bannerLayer, { paddingTop: insets.top }]} pointerEvents="box-none">
          <OfflineBanner visible />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: childTheme.colors.background },
  bannerLayer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    backgroundColor: childTheme.colors.warning,
  },
});
