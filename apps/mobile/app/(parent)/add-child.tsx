import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { ParentHeader } from '../../src/components/parent/chrome';
import {
  Banner,
  Body,
  Card,
  Field,
  Helper,
  PageTitle,
  ParentScreen,
  PrimaryButton,
  Segmented,
} from '../../src/components/parent/index';
import { useApp } from '../../src/state/app-context';

/**
 * Mirrors `apps/api/src/routes/children.ts` exactly, rather than guessing a
 * "reasonable age" from the current date: the client only needs to catch an
 * obvious typo, and the server is the one source of truth for a valid year.
 */
const MIN_BIRTH_YEAR = 2000;
const MAX_BIRTH_YEAR = 2100;

/**
 * Add a child.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE FORM GIVES NO HINT THAT MORE COULD BE ASKED FOR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A first name or nickname, a birth month and year, and one language. No
 * surname, no photo, no school, no address — and, importantly, no greyed-out
 * fields for any of them and no "optional" section a parent might feel they
 * should fill in. There is no column for those anywhere in the database
 * (PRIVACY.md §3), and the form is the honest shape of that.
 *
 * Birth month and year exist for exactly one reason: the age band decides what
 * the character may say and which characters are offered at all. A date of
 * birth would be more precise and would buy nothing.
 */
export default function AddChild() {
  const { api, setChild } = useApp();
  const [displayName, setDisplayName] = useState('');
  const [birthYear, setBirthYear] = useState('');
  const [birthMonth, setBirthMonth] = useState('');
  const [language, setLanguage] = useState<'en' | 'ur'>('en');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const submit = async () => {
    setError(undefined);

    const name = displayName.trim();
    const year = Number(birthYear);
    const month = Number(birthMonth);

    if (name === '') {
      setError("Enter the child's first name or nickname.");
      return;
    }
    if (!Number.isInteger(year) || year < MIN_BIRTH_YEAR || year > MAX_BIRTH_YEAR) {
      setError('Enter a valid birth year.');
      return;
    }
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      setError('Enter a birth month between 1 and 12.');
      return;
    }

    setSubmitting(true);
    const result = await api.post<{ id: string }>('/v1/children', {
      displayName: name,
      birthYear: year,
      birthMonth: month,
      languages: [{ languageCode: language, isPrimary: true }],
    });
    setSubmitting(false);

    if (!result.ok) {
      setError('We could not add that child. Check the details and try again.');
      return;
    }

    if (result.data === undefined) {
      router.replace('/(parent)/(tabs)/children');
      return;
    }

    // Straight on to consent, which is the one thing standing between this child
    // and a conversation. Sending a parent back to the list first means they
    // discover the gate later, from the child's side of the phone.
    setChild({ childId: result.data.id, childName: name });
    router.replace({ pathname: '/(parent)/consent', params: { childName: name } });
  };

  return (
    <>
      <ParentHeader
        title="Add a child"
        onBack={() => {
          router.back();
        }}
      />
      <ParentScreen testID="screen-add-child" gap={14}>
        <PageTitle>Add a child</PageTitle>
        <Body>
          We ask for as little as possible — just enough to pitch the conversation at the right age.
        </Body>

        {error !== undefined && <Banner tone="danger">{error}</Banner>}

        <Field
          label="First name or nickname"
          value={displayName}
          onChangeText={setDisplayName}
          autoCapitalize="words"
          testID="add-child-name"
        />

        <View style={{ flexDirection: 'row', gap: 12 }}>
          <View style={{ flex: 1 }}>
            <Field
              label="Birth year"
              value={birthYear}
              onChangeText={setBirthYear}
              keyboardType="number-pad"
              placeholder="2019"
              testID="add-child-birth-year"
            />
          </View>
          <View style={{ flex: 1 }}>
            <Field
              label="Birth month (1–12)"
              value={birthMonth}
              onChangeText={setBirthMonth}
              keyboardType="number-pad"
              placeholder="4"
              testID="add-child-birth-month"
            />
          </View>
        </View>

        <View style={{ gap: 8 }}>
          <Helper>Language</Helper>
          <Segmented
            value={language}
            onChange={setLanguage}
            options={[
              { value: 'en', label: 'English' },
              { value: 'ur', label: 'اردو Urdu' },
            ]}
            testID="add-child-language"
          />
        </View>

        <Card>
          <Helper>
            No surname, no photo, no school and no address. We have no field for them.
          </Helper>
        </Card>

        <PrimaryButton
          label="Add child"
          loading={submitting}
          onPress={() => {
            void submit();
          }}
          testID="add-child-submit"
        />
      </ParentScreen>
    </>
  );
}
