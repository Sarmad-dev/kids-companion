import { router } from 'expo-router';

import { ParentHeader } from '../../src/components/parent/chrome';
import {
  Body,
  Card,
  Helper,
  ParentScreen,
  SecondaryButton,
  SectionTitle,
} from '../../src/components/parent/index';

/**
 * The privacy centre.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * PLAIN LANGUAGE, BECAUSE LEGALESE HERE WOULD BE A DARK PATTERN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Everything below is written to be READ by a non-technical parent in the two
 * minutes they will actually give it. A policy nobody can read is a policy
 * nobody consented to, whatever a checkbox says — and for a product whose users
 * are children, "they clicked agree" is not a defence anyone should want to be
 * relying on.
 *
 * "What we cannot promise" is the section that has to be here. No safety filter
 * catches everything, a model can still say something odd, and a product that
 * implies otherwise is setting a parent up to trust it more than it deserves.
 */
const SECTIONS = [
  {
    head: 'What we store about your child',
    body: 'A first name or nickname, a birth month and year, the language they speak, and what they said to the character if you have transcripts turned on. Nothing else. There is no field for a surname, a photo, a school or an address.',
  },
  {
    head: 'Voice recordings',
    body: 'The audio goes to our speech service, becomes text, and is deleted within hours. It is never used to train a model and never sent anywhere else.',
  },
  {
    head: 'What is sent to the AI provider',
    body: "The text of the conversation, the age band, and the character's personality. Not your child's name, not your email, not your location, not your device.",
  },
  {
    head: 'What we do not do',
    body: 'No advertising. No selling or sharing data with anyone for their own purposes. No profiling for marketing. No child-to-child contact anywhere in the product — there is no messaging, no sharing and no social surface to build one on.',
  },
  {
    head: 'What we cannot promise',
    body: 'No safety filter catches everything. A model can still say something odd or wrong. We screen every message, we do not let you turn that off, and we would rather tell you this plainly than imply we are perfect.',
  },
  {
    head: 'Getting data deleted',
    body: 'Delete a child and their data goes within the hour. Delete your account and everything goes within 30 days. Backups age out on their own schedule and we cannot pull a single record out of one early — that is a real limit, not a policy.',
  },
] as const;

export default function Privacy() {
  return (
    <>
      <ParentHeader
        title="Privacy centre"
        onBack={() => {
          router.back();
        }}
      />
      <ParentScreen testID="screen-privacy" gap={10}>
        <Helper>
          Written to be read. If any of this is unclear, that&apos;s our fault — tell us and
          we&apos;ll rewrite it.
        </Helper>

        {SECTIONS.map((section) => (
          <Card key={section.head} gap={8}>
            <SectionTitle>{section.head}</SectionTitle>
            <Body>{section.body}</Body>
          </Card>
        ))}

        <SecondaryButton
          label="Export or delete our data"
          testID="privacy-your-data"
          onPress={() => {
            router.push('/(parent)/your-data');
          }}
        />
      </ParentScreen>
    </>
  );
}
