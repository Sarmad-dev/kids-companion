import { Stack } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { OfflineBanner } from '../../src/components/parent/index';
import { useApp } from '../../src/state/app-context';
import { parentTheme } from '../../src/theme/parent-theme';

/**
 * Parent mode.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A DIFFERENT PRODUCT, ENFORCED BY LAYOUT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Grey-white ground, a real back affordance, a slide transition, and an offline
 * strip that says what happens to changes rather than what is resting. None of
 * the child layout's decisions apply here and none of these apply there — a
 * parent should feel they have arrived somewhere ordinary, and a child who gets
 * this far should feel immediately that they have left the app.
 *
 * The gate is not enforced here. It is enforced at the one door into this
 * group — see `(parent)/gate.tsx` and `(tabs)/_layout.tsx` — because the sign-in
 * and password-reset screens have to be reachable BEFORE anyone has passed
 * anything.
 */
export default function ParentLayout() {
  const { online } = useApp();

  return (
    <View style={styles.root}>
      <OfflineBanner visible={!online} />
      <Stack
        screenOptions={{
          headerShown: false,
          animation: 'slide_from_right',
          contentStyle: { backgroundColor: parentTheme.colors.background },
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: parentTheme.colors.background },
});
