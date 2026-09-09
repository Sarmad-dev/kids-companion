/**
 * The wording shown when consent is asked for.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THE TEXT LIVES IN A CONSTANT RATHER THAN INLINE IN THE SCREEN
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * `POST /v1/consent` hashes `policyText` and stores the digest as proof of what
 * was agreed to (`apps/api/src/routes/consent.ts`). That proof is worth nothing
 * unless the string sent is the string the parent actually read. Rendering and
 * sending from one constant is what makes that true by construction, rather
 * than true until someone edits one of two copies.
 *
 * PLAIN LANGUAGE IS A REQUIREMENT, NOT A STYLE PREFERENCE. PRIVACY.md §4.2:
 * "Plain language a non-technical parent actually reads. Legalese is a dark
 * pattern here."
 *
 * WHAT IS DELIBERATELY ABSENT: the optional consents (`transcript_retention`,
 * `product_analytics`, and anything for model improvement). They do not block
 * conversation, they are off by default, and asking for them in the same breath
 * as the required ones — behind the same single button — is exactly the
 * bundling PRIVACY.md §4.2 forbids. They belong in the parent dashboard, next
 * to the switch that withdraws them.
 */

/** Every consent this screen knows how to ask for. Each one blocks conversation. */
export type BlockingConsentType = 'terms_of_service' | 'privacy_policy' | 'child_data_processing';

export interface ConsentCopy {
  /** The heading, in the parent's language, not the schema's. */
  readonly title: string;
  /** The exact wording shown AND sent as `policyText`. */
  readonly body: string;
}

export const CONSENT_COPY: Readonly<Record<BlockingConsentType, ConsentCopy>> = {
  terms_of_service: {
    title: 'Terms of service',
    body:
      'You are agreeing to let your family use this app. You can close your account at any ' +
      'time, and we will delete it. We can suspend an account that is being used to harm ' +
      'someone. Nothing here is a purchase — paid plans are agreed to separately, and you are ' +
      'told the price before you are charged.',
  },
  privacy_policy: {
    title: 'What we collect, and what we delete',
    body:
      'We collect what the app needs to work and nothing else: your email address, and for each ' +
      'child a first name or nickname, a birth month and year, and the language they speak. We ' +
      'do not ask for a surname, an address, a school, or a photograph, and there is nowhere to ' +
      'put them. What your child says is turned into text so the character can answer, and the ' +
      'recording itself is discarded straight afterwards — it is not kept. You can see what is ' +
      'stored, and delete it, from your parent dashboard.',
  },
  child_data_processing: {
    title: 'Permission for this child',
    body:
      'You are giving permission, on behalf of this child, for us to process what they say to ' +
      'the character so it can reply, and to check it for anything unsafe. You are consenting ' +
      'for them because they cannot consent for themselves. This permission is for this child ' +
      'only — you give it again for each child you add, and you can withdraw it at any time, ' +
      'which stops any new conversation and deletes what was kept.',
  },
};

/** Whether this is a consent type the screen has wording for. */
export const isBlockingConsentType = (value: string): value is BlockingConsentType =>
  Object.prototype.hasOwnProperty.call(CONSENT_COPY, value);
