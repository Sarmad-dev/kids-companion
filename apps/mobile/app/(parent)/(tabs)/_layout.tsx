import { Redirect, Stack } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { ParentTabBar } from '../../../src/components/parent/chrome';
import { useApp } from '../../../src/state/app-context';
import { parentTheme } from '../../../src/theme/parent-theme';

/**
 * The five tabbed screens, and the boundary that guards them.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TWO LOCKS, AND THEY GUARD DIFFERENT THINGS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `signedIn` is the real one: a parent's password, checked by the server, and
 * the only thing standing between anybody and this family's data. Everything in
 * here is refused server-side without it, so this redirect is a convenience
 * rather than a defence.
 *
 * `gatePassed` is the other one, and it defends nothing at all from an adult —
 * it is arithmetic a nine-year-old can do. Its job is to stop a CHILD wandering
 * in, which it does, and to make the boundary explicit to the parent. Neither
 * is a substitute for the other and neither is claimed to be.
 */
export default function TabsLayout() {
  const { signedIn, gatePassed } = useApp();

  // `undefined` means the launch check has not answered yet. Redirecting on it
  // would bounce a signed-in parent to the gate every cold start.
  if (signedIn === false) return <Redirect href="/(parent)/sign-in" />;
  if (signedIn === true && !gatePassed) return <Redirect href="/(parent)/gate" />;

  return (
    <View style={styles.root}>
      <Stack
        screenOptions={{
          headerShown: false,
          // Tabs are places, not steps; a slide between them would imply depth
          // that is not there.
          animation: 'none',
          contentStyle: { backgroundColor: parentTheme.colors.background },
        }}
      />
      <ParentTabBar />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: parentTheme.colors.background },
});
