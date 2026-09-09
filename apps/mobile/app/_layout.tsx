import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { LogBox, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AppProvider } from '../src/state/app-context';
import { childTheme } from '../src/theme/child-theme';
import { useAppFonts } from '../src/theme/fonts';

/**
 * The root layout.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY EXPO ROUTER, GIVEN CHILD MODE HAS NO BACK BUTTON
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Child mode really does not need a router: a four-year-old has no history they
 * remember taking, and the old hand-rolled state machine served them fine. What
 * it could not serve is the other half of the product. Parent mode is thirty-odd
 * screens, five tabs, per-child sub-screens, a back button that has to mean the
 * ordinary thing, and deep links from a verification email and a password reset
 * that have to land on a specific screen with a token in hand. That is a router,
 * and writing a second one by hand next to the first is how two navigation
 * models end up disagreeing about what "back" means.
 *
 * So both halves are routes, and the difference between them is enforced by
 * layout rather than by hoping: `(child)` has no headers and no gestures,
 * `(parent)` has a header, a back affordance and tabs. A child cannot swipe
 * their way into the parent area, because there is nothing there to swipe from.
 *
 * The route groups are also the permission boundary that `navigation/routes.ts`
 * used to be — see `(child)/_layout.tsx` and `(parent)/_layout.tsx`.
 */

/* Three known-noisy logs from the 3D stack, and nothing else. A blanket
 * `LogBox.ignoreAllLogs()` would hide the next real one. */
LogBox.ignoreLogs([
  'THREE.Clock: This module has been deprecated. Please use THREE.Timer instead.',
  'THREE.WARNING: Multiple instances of Three.js being imported.',
  "EXGL: gl.pixelStorei() doesn't support this parameter yet!",
]);

// Held until the fonts are ready. Baloo 2 and IBM Plex Sans ARE the difference
// between the two products, and one frame of the system face reflowing into
// them is the first thing a user would see.
void SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const fontsReady = useAppFonts();

  useEffect(() => {
    if (fontsReady) void SplashScreen.hideAsync();
  }, [fontsReady]);

  if (!fontsReady) return null;

  return (
    <SafeAreaProvider>
      <AppProvider>
        <View style={{ flex: 1, backgroundColor: childTheme.colors.background }}>
          {/* Light only. There is no dark mode: a cream ground and a
              grey-white one are both design decisions, not defaults. */}
          <StatusBar style="dark" />
          <Stack
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: childTheme.colors.background },
            }}
          />
        </View>
      </AppProvider>
    </SafeAreaProvider>
  );
}
