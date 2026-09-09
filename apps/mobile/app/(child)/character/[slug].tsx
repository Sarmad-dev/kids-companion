import { router, useLocalSearchParams } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { BigButton, Body, Title } from '../../../src/components/child/index';
import { castMember, childTheme } from '../../../src/theme/child-theme';
import { Diorama } from '../../../src/three/Diorama';

/**
 * Meeting a character before committing to one.
 *
 * The live diorama fills the top 56% of the screen — draggable, so the first
 * thing a child learns about the character is that it is a real place they can
 * look around. Then a tagline in body type, and exactly one button, in the
 * character's own colour, which says who they are about to play with by name.
 *
 * The rig is held at `resting` here rather than reacting to anything: this
 * screen is an introduction, and a character that starts listening before the
 * child has chosen it is jumping the gun.
 */
export default function CharacterDetail() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const member = castMember(slug);

  return (
    <View style={styles.screen} testID="screen-character-detail">
      <View style={styles.stage}>
        <Diorama slug={slug} talkState="idle" testID="character-preview" />
      </View>

      <View style={styles.body}>
        <Title>{member.name}</Title>
        <Body>{member.tagline}</Body>
        <View style={styles.grow} />
        <BigButton
          label={`Let's play with ${member.short}!`}
          colour={member.colour}
          onPress={() => {
            // The id was recorded on the select screen; this screen only
            // confirms the choice, so there is nothing further to store.
            router.replace('/(child)/home');
          }}
          testID="choose-character"
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: childTheme.colors.background },
  /* 56% — enough for the set to read as a place, and still leaving room for a
   * 88pt button that never has to be scrolled to. */
  stage: {
    height: '56%',
    overflow: 'hidden',
    borderBottomLeftRadius: 32,
    borderBottomRightRadius: 32,
  },
  body: {
    flex: 1,
    alignItems: 'center',
    paddingHorizontal: childTheme.spacing.lg,
    paddingTop: 22,
    paddingBottom: 22,
    gap: childTheme.spacing.sm + 2,
  },
  grow: { flex: 1, minHeight: childTheme.spacing.md },
});
