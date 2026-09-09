import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { View } from 'react-native';

import { ParentHeader } from '../../src/components/parent/chrome';
import {
  Body,
  Card,
  Field,
  GroupLabel,
  LinkButton,
  PageTitle,
  ParentScreen,
  PrimaryButton,
  SectionTitle,
} from '../../src/components/parent/index';
import { useApp } from '../../src/state/app-context';

/**
 * The parental gate.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS IS FOR, AND WHAT IT IS EMPHATICALLY NOT FOR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * It stops a CHILD wandering into the parent area. That is all it does and all
 * it is claimed to do. It is arithmetic with the numbers written as words —
 * trivial for an adult, uninteresting to a four-year-old, and solvable by a
 * determined nine-year-old, which is fine: behind it is a password the server
 * checks, and that is the lock that matters.
 *
 * Grey, dense, no character, no colour reward for getting it right. A gate that
 * congratulated you would be a puzzle worth solving.
 */

/** A small pool, so the same sum does not appear every time. */
const SUMS = [
  { question: 'What is seventeen minus nine?', answer: 8 },
  { question: 'What is twelve plus six?', answer: 18 },
  { question: 'What is twenty-one minus five?', answer: 16 },
  { question: 'What is nine plus eight?', answer: 17 },
  { question: 'What is thirty minus fourteen?', answer: 16 },
] as const;

export default function ParentGate() {
  const { signedIn, passGate } = useApp();
  const [value, setValue] = useState('');
  const [wrong, setWrong] = useState(false);

  /* Chosen once per visit. Re-rolling on every keystroke would change the
   * question under someone who is halfway through answering it.
   *
   * `Math.random` is right here and a CSPRNG would be theatre: the gate is not
   * a security control, the answer is eight, and an attacker who can predict
   * which of five sums appears has predicted something they could also just
   * read off the screen. The lock is the password behind this. */
  // eslint-disable-next-line no-restricted-properties
  const sum = useMemo(() => SUMS[Math.floor(Math.random() * SUMS.length)] ?? SUMS[0], []);

  const submit = () => {
    if (Number.parseInt(value.trim(), 10) !== sum.answer) {
      setWrong(true);
      return;
    }
    passGate();
    // A parent who has not signed in on this device still has to; the gate is
    // not a credential and must never be treated as one.
    router.replace(signedIn === true ? '/(parent)/(tabs)/dashboard' : '/(parent)/sign-in');
  };

  return (
    <>
      <ParentHeader title="Grown-ups" />
      <ParentScreen testID="screen-parent-gate" gap={16}>
        <PageTitle>Just checking you&apos;re a grown-up</PageTitle>
        <Body>
          Answer this to open the parent area. Your child stays in their own part of the app.
        </Body>

        <Card gap={12}>
          <GroupLabel>Question</GroupLabel>
          <SectionTitle>{sum.question}</SectionTitle>
          <Field
            value={value}
            onChangeText={(next) => {
              setValue(next);
              setWrong(false);
            }}
            placeholder="Type the number"
            keyboardType="number-pad"
            state={wrong ? 'error' : 'rest'}
            {...(wrong ? { error: "That's not right. Have another go." } : {})}
            testID="gate-answer"
          />
        </Card>

        <View style={{ gap: 4 }}>
          <PrimaryButton label="Continue" onPress={submit} testID="gate-submit" />
          <LinkButton
            label="Back to playing"
            onPress={() => {
              router.replace('/(child)/welcome');
            }}
            testID="gate-back"
          />
        </View>
      </ParentScreen>
    </>
  );
}
