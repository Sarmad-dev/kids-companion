import { router } from 'expo-router';

import {
  Avatar,
  BigButton,
  Body,
  Float,
  Hero,
  QuietButton,
  Screen,
  Spacer,
} from '../../src/components/child/index';
import { useApp } from '../../src/state/app-context';
import { castMember } from '../../src/theme/child-theme';

/**
 * Welcome.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ONLY DOOR INTO PARENT MODE, AND DELIBERATELY THE DULLER OF TWO BUTTONS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "Let's play!" is accent orange, 88pt tall, and says what happens. "For
 * grown-ups" is cream-grey, lighter, 72pt, and carries a lock. A child who
 * wanders into the parent area is not a security problem — the arithmetic gate
 * and a real password are — but a child who finds it *attractive* is a design
 * problem, and this is where that is settled.
 */
export default function Welcome() {
  const { child } = useApp();
  const member = castMember(child.characterSlug);

  return (
    <Screen testID="screen-welcome" padding={24}>
      <Spacer />
      <Float style={{ alignSelf: 'center' }}>
        <Avatar slug={child.characterSlug} size={180} />
      </Float>
      <Hero>Hello!</Hero>
      <Body>I&apos;m {member.short}. Shall we talk?</Body>
      <Spacer />
      <BigButton
        label="Let's play!"
        face="👋"
        size="hero"
        onPress={() => {
          router.push('/(child)/child-select');
        }}
        testID="start-button"
      />
      <QuietButton
        label="For grown-ups"
        face="🔒"
        onPress={() => {
          router.push('/(parent)/gate');
        }}
        testID="grownup-button"
      />
    </Screen>
  );
}
