import { Linking, Platform, StyleSheet, Text, View } from 'react-native';

import {
  Body,
  Card,
  Display,
  Helper,
  ParentScreen,
  PrimaryButton,
} from '../../src/components/parent/index';
import { parentTheme } from '../../src/theme/parent-theme';

/**
 * Update required.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * BLOCKING, AND IT SAYS WHY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * There is no back button and no dismiss: a build the server has stopped
 * talking to is a build that would fail halfway through a conversation rather
 * than cleanly. Stopping it is the kind thing; leaving it half-working is not.
 *
 * The card is the part that matters to a parent standing next to a confused
 * child: their friend is saying "let's play again a bit later", with no error
 * and no version number. Knowing what the child is seeing is the difference
 * between "the app is broken" and "I need to tap update".
 */
export default function UpdateRequired() {
  const store =
    Platform.OS === 'ios'
      ? 'https://apps.apple.com/app/id0000000000'
      : 'https://play.google.com/store/apps/details?id=app.kidscompanion.placeholder';

  return (
    <ParentScreen testID="screen-update" centred gap={16}>
      <View style={styles.icon}>
        <Text style={styles.iconGlyph}>⬆️</Text>
      </View>

      <Display>Time for an update</Display>
      <Body>
        This version can no longer talk to our servers safely, so we&apos;ve stopped it rather than
        let it run half-working. The update is small.
      </Body>

      <Card>
        <Helper>
          Your child sees their friend saying &quot;let&apos;s play again a bit later&quot; — no
          error, no version number.
        </Helper>
      </Card>

      <PrimaryButton
        label="Update now"
        testID="update-now"
        onPress={() => {
          void Linking.openURL(store);
        }}
      />
    </ParentScreen>
  );
}

const styles = StyleSheet.create({
  icon: {
    width: 52,
    height: 52,
    borderRadius: parentTheme.radii.control,
    backgroundColor: parentTheme.colors.actionWash,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconGlyph: { fontSize: 24 },
});
