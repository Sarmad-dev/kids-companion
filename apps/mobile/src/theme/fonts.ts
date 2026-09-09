/* Deep imports, one face per line, rather than the packages' root indexes.
 *
 * `@expo-google-fonts/ibm-plex-sans`'s index re-exports all fourteen weights
 * AND their italics. Metro follows that and bundles every one: importing four
 * faces through the index shipped 3.2MB of fonts, of which 2.4MB was never
 * referenced — thin, extra-light, light, and every italic. On a low-end Android
 * phone on a metered connection, which is most of this product's audience, that
 * is a download a family pays for and never uses. */
import { Baloo2_400Regular } from '@expo-google-fonts/baloo-2/400Regular';
import { Baloo2_500Medium } from '@expo-google-fonts/baloo-2/500Medium';
import { Baloo2_600SemiBold } from '@expo-google-fonts/baloo-2/600SemiBold';
import { Baloo2_700Bold } from '@expo-google-fonts/baloo-2/700Bold';
import { Baloo2_800ExtraBold } from '@expo-google-fonts/baloo-2/800ExtraBold';
import { IBMPlexSans_400Regular } from '@expo-google-fonts/ibm-plex-sans/400Regular';
import { IBMPlexSans_500Medium } from '@expo-google-fonts/ibm-plex-sans/500Medium';
import { IBMPlexSans_600SemiBold } from '@expo-google-fonts/ibm-plex-sans/600SemiBold';
import { IBMPlexSans_700Bold } from '@expo-google-fonts/ibm-plex-sans/700Bold';
import { useFonts } from 'expo-font';
import { Platform } from 'react-native';

/**
 * The two typefaces, and why there are exactly two.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TYPE IS THE FASTEST SIGNAL THAT YOU HAVE CHANGED PRODUCTS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Baloo 2 is child mode: round, warm, heavy, and never below 18pt. IBM Plex
 * Sans is parent mode: neutral, dense, legible at 12pt. Neither appears in the
 * other's screens, which is what makes a child who wanders into the parent area
 * feel immediately that they have left the app — before they have read a word.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY WEIGHTS ARE NAMED FAMILIES RATHER THAN `fontWeight`
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * React Native on Android does not synthesise a weight from a custom family: a
 * `fontFamily: 'Baloo2_400Regular'` with `fontWeight: '800'` renders at 400,
 * silently. Every weight therefore ships as its own loaded family and is
 * selected by name, so an 800 title is 800 on both platforms rather than 800 on
 * one of them.
 */

export const fonts = {
  child: {
    regular: 'Baloo2_400Regular',
    medium: 'Baloo2_500Medium',
    semibold: 'Baloo2_600SemiBold',
    bold: 'Baloo2_700Bold',
    heavy: 'Baloo2_800ExtraBold',
  },
  parent: {
    regular: 'IBMPlexSans_400Regular',
    medium: 'IBMPlexSans_500Medium',
    semibold: 'IBMPlexSans_600SemiBold',
    bold: 'IBMPlexSans_700Bold',
  },
  /**
   * Reserved for values a parent may need to quote to support — a diagnostic
   * reference and nothing else. The platform face rather than a fifth webfont:
   * one string on one screen does not earn a 200KB download, and a monospaced
   * reference reads as monospaced either way.
   */
  mono: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
} as const;

const FACES = {
  Baloo2_400Regular,
  Baloo2_500Medium,
  Baloo2_600SemiBold,
  Baloo2_700Bold,
  Baloo2_800ExtraBold,
  IBMPlexSans_400Regular,
  IBMPlexSans_500Medium,
  IBMPlexSans_600SemiBold,
  IBMPlexSans_700Bold,
};

/**
 * Loads both families.
 *
 * Returns whether they are ready, NOT a fallback flag: the root layout holds
 * the native splash until this is true. Rendering the child's home screen in
 * the system face and reflowing it a beat later is worse than one extra moment
 * of the splash a child was already looking at.
 */
export const useAppFonts = (): boolean => {
  const [loaded, error] = useFonts(FACES);
  // A font that failed to load is not a reason to hold the app hostage behind a
  // splash screen forever. The system face is an ugly fallback, and an app that
  // never opens is a worse one.
  return loaded || error !== null;
};
