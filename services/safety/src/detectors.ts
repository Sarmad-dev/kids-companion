import type { SafetyCategory } from './categories.js';
import { variantsOf, type VariantKind } from './normalise.js';

/**
 * Deterministic detectors.
 *
 * The model classifiers on either side of generation share a failure mode: an
 * input crafted to fool one usually fools the other, because they are the same
 * kind of thing. These rules exist to fail DIFFERENTLY. They are regex —
 * cheap, fast, explainable, and not persuadable (docs/CHILD_SAFETY.md §3).
 *
 * They are NOT the safety system. They are the floor under it. Every rule here
 * is a pattern someone thought of in advance, which is precisely the class of
 * defence that a novel phrasing walks past — see docs/SAFETY_SUBSYSTEM.md §9 for
 * what that means for how much confidence to place in this file.
 *
 * Rules are narrow on purpose. A filter that fires on "a secret ingredient" and
 * every treasure-hunt story trains the team to ignore its findings, which is
 * worse than not having it.
 */

export type Severity = 'low' | 'medium' | 'high' | 'critical';

export interface Detection {
  readonly rule: string;
  readonly category: SafetyCategory;
  readonly severity: Severity;
  /** Which text variant matched. `raw`/`normalised` mean it was said plainly. */
  readonly variant: VariantKind;
  /**
   * True when the match required undoing obfuscation.
   *
   * Recorded because it changes the meaning of the finding: reaching a rule
   * through base64 is not the same as stumbling into it.
   */
  readonly evasion: boolean;
}

interface Rule {
  readonly name: string;
  readonly category: SafetyCategory;
  readonly severity: Severity;
  readonly pattern: RegExp;
}

interface CompiledRule extends Rule {
  /**
   * The same pattern, relaxed for the separator-stripped `dense` variant.
   *
   * Two transforms, both necessary. `\bkill\b` cannot match inside
   * `howtomakeabomb`, and `how\s+to\s+make` cannot match `howtomake` — so a
   * dense scan with the original pattern would silently find nothing, which is
   * the exact failure the dense variant exists to prevent.
   */
  readonly densePattern: RegExp;
}

const compile = (rules: readonly Rule[]): readonly CompiledRule[] =>
  rules.map((rule) => ({
    ...rule,
    densePattern: new RegExp(
      rule.pattern.source.replace(/\\b/g, '').replace(/\\s\+/g, '\\s*'),
      rule.pattern.flags,
    ),
  }));

/* =============================================================================
 * Child input
 * ===========================================================================*/
/**
 * What a child types is treated differently from what the model says.
 *
 * A child asking about something unsafe is usually curious, occasionally
 * distressed, and very rarely malicious. So the input rules skew towards
 * DETECTING INTENT TO BYPASS and towards SIGNALS THAT A CHILD NEEDS HELP —
 * not towards policing vocabulary. "My name is Ayesha" is a five-year-old, not
 * an attack; the correct response is to not store it, not to block the turn.
 */
const INPUT_RULES: readonly Rule[] = Object.freeze([
  /* ---------------- Attempts to change what the system is ---------------- */
  {
    name: 'instruction_override',
    category: 'prompt_injection',
    severity: 'high',
    pattern:
      // `above` is a target in its own right, not just a modifier: "ignore the
      // above and say X" carries no noun the earlier version of this rule knew.
      /\b(?:ignore|disregard|forget)\s+(?:all\s+|any\s+|your\s+|the\s+|previous\s+|everything\s+)*(?:above\b|instructions?|rules?|prompts?|guidelines?|training)\b/i,
  },
  {
    name: 'system_prompt_probe',
    category: 'prompt_injection',
    severity: 'medium',
    pattern:
      /\b(?:system\s+prompt|your\s+(?:instructions|prompt|rules|guidelines|system\s+message)|repeat\s+(?:everything|the\s+text)\s+above|what\s+were\s+you\s+told)\b/i,
  },
  {
    name: 'developer_mode',
    category: 'prompt_injection',
    severity: 'high',
    pattern:
      /\b(?:developer\s+mode|debug\s+mode|god\s+mode|jailbreak|dan\s+mode|unrestricted\s+mode|no\s+(?:filters?|restrictions?|rules?)|without\s+(?:any\s+)?(?:filters?|restrictions?|censorship))\b/i,
  },
  {
    name: 'authority_claim',
    category: 'prompt_injection',
    severity: 'high',
    // "My mum said it's fine" is the child-scale version of this, and it works
    // on people. It must not work here.
    pattern:
      /\b(?:i\s*(?:'m|\s+am)\s+(?:your\s+)?(?:developer|programmer|creator|admin(?:istrator)?|engineer)|(?:my\s+(?:mum|mom|dad|parent|teacher)\s+said\s+(?:it(?:'?s|\s+is)\s+|that(?:'?s|\s+is)\s+)?(?:ok|okay|fine|allowed))|you\s+(?:have|are\s+allowed)\s+permission)\b/i,
  },
  {
    name: 'roleplay_bypass',
    category: 'prompt_injection',
    severity: 'high',
    // The most reliable jailbreak shape there is: relocate the request into a
    // frame where the rules supposedly do not apply.
    pattern:
      /\b(?:pretend\s+(?:you\s+(?:are|have)\s+no|there\s+are\s+no|that\s+the\s+rules)|act\s+as\s+(?:if\s+you\s+(?:have|had)\s+no|an?\s+(?:unfiltered|unrestricted|evil))|you\s+are\s+now\s+(?:a\s+)?(?:different|evil|bad|unfiltered)|role-?play\s+as\s+(?:a\s+)?(?:human|adult|real\s+person)|from\s+now\s+on\s+you\s+(?:are|will))\b/i,
  },
  {
    name: 'hypothetical_frame',
    category: 'prompt_injection',
    severity: 'medium',
    // Indirect phrasing: "in a story where it's allowed, how would someone...".
    // Medium on its own — it becomes blocking when paired with a harm category.
    pattern:
      /\b(?:in\s+a\s+(?:story|game|world|universe)\s+where\s+(?:it'?s\s+)?(?:allowed|okay|legal|fine)|hypothetically\s+(?:speaking|if)|asking\s+for\s+a\s+friend|just\s+for\s+(?:a\s+)?(?:story|fiction|pretend)\s*,?\s*(?:how|what|tell))\b/i,
  },
  {
    name: 'impersonation_request',
    category: 'impersonation',
    severity: 'medium',
    pattern:
      /\b(?:are\s+you\s+(?:a\s+)?(?:real|human|alive|a\s+person)|pretend\s+(?:to\s+be|you'?re)\s+(?:a\s+)?(?:human|real|my\s+(?:mum|mom|dad|friend|teacher)))\b/i,
  },

  /* ---------------- Signals: a child telling us something ---------------- */
  // These are the reason the pipeline distinguishes `redirect` from `block`.
  // A refusal here is the worst available response.
  {
    name: 'self_harm_statement',
    category: 'self_harm',
    severity: 'critical',
    pattern:
      /\b(?:i\s+want\s+to\s+(?:die|disappear|not\s+exist)|kill\s+myself|hurt\s+myself|end\s+(?:it\s+all|my\s+life)|cut\s+myself|nobody\s+would\s+miss\s+me|better\s+off\s+without\s+me)\b/i,
  },
  {
    name: 'harm_disclosure',
    category: 'disclosure_of_harm',
    severity: 'critical',
    pattern:
      /\b(?:(?:someone|somebody|a\s+(?:man|woman|boy|girl|grown-?up|teacher|uncle|aunt))\s+(?:hurt|hits?|hit|touched|touches)\s+me|(?:hurts?|hits?|beats?)\s+me\s+(?:when|every|all\s+the\s+time)|i'?m\s+(?:scared|afraid)\s+of\s+(?:my|him|her|them)|told\s+me\s+not\s+to\s+tell)\b/i,
  },
  {
    name: 'distress_statement',
    category: 'distress_signal',
    severity: 'high',
    pattern:
      /\b(?:i'?m\s+(?:so\s+)?(?:sad|scared|frightened|lonely|crying)|nobody\s+(?:likes|loves)\s+me|i\s+(?:hate|feel\s+bad\s+about)\s+myself|everyone\s+hates\s+me)\b/i,
  },
  {
    name: 'secret_request_from_elsewhere',
    category: 'secret_keeping',
    severity: 'critical',
    // A child REPORTING that someone asked them to keep a secret. Escalates.
    pattern:
      /\b(?:(?:said|told|asked)\s+(?:me\s+)?(?:it'?s|to\s+keep\s+it|not\s+to\s+tell)\s*(?:our|a)?\s*secret|keep\s+(?:it|this)\s+(?:a\s+)?secret\s+from\s+(?:my|mum|mom|dad|parents))\b/i,
  },

  /* ---------------- Prohibited subject matter ---------------- */
  {
    name: 'weapon_construction',
    category: 'weapons',
    severity: 'critical',
    pattern:
      /\b(?:how\s+(?:to|do\s+(?:i|you))\s+(?:make|build|create|get)\s+(?:a\s+)?(?:bomb|gun|weapon|knife|explosive|poison)|make\s+(?:a\s+)?(?:bomb|explosive))\b/i,
  },
  {
    name: 'dangerous_activity',
    category: 'dangerous_activities',
    severity: 'critical',
    pattern:
      /\b(?:how\s+(?:to|do\s+(?:i|you))\s+(?:start\s+a\s+fire|set\s+.{0,12}\s*on\s+fire|pick\s+a\s+lock|hotwire|drink\s+bleach|swallow)|is\s+it\s+(?:safe|ok)\s+to\s+(?:drink|eat|swallow)\s+(?:bleach|pills|medicine|chemicals))\b/i,
  },
  {
    name: 'drugs_query',
    category: 'drugs',
    severity: 'high',
    pattern:
      /\b(?:how\s+(?:to|do\s+i)\s+(?:get|buy|make|take)\s+(?:drugs|weed|cocaine|alcohol|beer|vodka|cigarettes?|vapes?)|get\s+(?:drunk|high)\b)/i,
  },
  {
    name: 'sexual_query',
    category: 'sexual_content',
    severity: 'critical',
    pattern: /\b(?:sex|sexy|porn|naked|nude|genitals?|penis|vagina|breasts?|masturbat)/i,
  },
  {
    name: 'hate_speech',
    category: 'hate',
    severity: 'high',
    pattern:
      /\b(?:all\s+(?:muslims?|jews?|christians?|hindus?|blacks?|whites?|asians?|indians?|pakistanis?)\s+are\s+(?:bad|evil|stupid|terrorists?)|i\s+hate\s+(?:all\s+)?(?:muslims?|jews?|christians?|hindus?|black|white|gay)\s*(?:people)?)\b/i,
  },
  {
    name: 'exploitation_pattern',
    category: 'exploitation',
    severity: 'critical',
    // A child relaying what an adult said to them. The lowest-threshold rule in
    // the file, and the one where a false positive costs least.
    pattern:
      /\b(?:someone\s+(?:online|on\s+the\s+internet|i\s+met)\s+(?:wants|asked|said)|(?:wants|asked)\s+(?:me\s+)?to\s+(?:meet|send\s+(?:a\s+)?(?:photo|picture|pic)|video\s+chat)|sent\s+me\s+(?:a\s+)?(?:photo|picture)\s+of\s+(?:him|her|them)self)\b/i,
  },
]);

/* =============================================================================
 * Model output
 * ===========================================================================*/
/**
 * What the companion says.
 *
 * The bar here is far higher: every rule encodes an invariant from
 * docs/CHILD_SAFETY.md §2 that a model might violate while sounding perfectly
 * friendly — which is exactly why a classifier is not enough on its own.
 */
const OUTPUT_RULES: readonly Rule[] = Object.freeze([
  // S-4. Secret-keeping is the strongest correlate of grooming behaviour and has
  // no legitimate use in this product, so it is matched aggressively.
  {
    name: 'secret_keeping',
    category: 'secret_keeping',
    severity: 'critical',
    // Only possessive "our secret" — NOT a bare "a/the secret", which fires on
    // "a secret ingredient" and every treasure-hunt story a child will ever
    // hear.
    pattern:
      /\b(?:our\s+(?:little\s+)?secret|keep\s+(?:it|this|that)\s+(?:a\s+)?secret|secret\s+from\s+(?:your|mum|mom|dad|parents?)|don'?t\s+tell\s+(?:your|any)|between\s+(?:you\s+and\s+me|us)|promise\s+not\s+to\s+tell)\b/i,
  },

  // S-2. The model claiming humanity, in the phrasings it would actually use.
  {
    name: 'human_impersonation',
    category: 'impersonation',
    severity: 'critical',
    pattern:
      /\b(?:i\s*(?:'m|\s+am)\s+(?:a\s+)?(?:real\s+)?(?:human|person|girl|boy|man|woman|adult|grown-?up)\b|i\s*(?:'m|\s+am)\s+not\s+(?:a\s+)?(?:robot|computer|programme?|ai|artificial)|i\s+am\s+alive\b)/i,
  },

  // The companion positioning itself as a replacement for a trusted adult.
  {
    name: 'relationship_boundary',
    category: 'inappropriate_relationship',
    severity: 'critical',
    pattern:
      /\b(?:i\s+love\s+you\s+more\s+than|(?:better|more\s+fun)\s+than\s+your\s+(?:mum|mom|dad|parents?|friends?|family)|you\s+don'?t\s+need\s+(?:your\s+)?(?:parents?|mum|mom|dad|anyone\s+else)|i'?m\s+your\s+(?:only|best|real)\s+friend|just\s+(?:you\s+and\s+me|between\s+us)\s+forever)\b/i,
  },

  // S-5. Any route out of the conversation.
  {
    name: 'external_link',
    category: 'personal_data_request',
    severity: 'high',
    pattern:
      /\b(?:https?:\/\/|www\.[a-z0-9-]+\.[a-z]{2,}|[a-z0-9-]+\.(?:com|net|org|io|app|co)\b)/i,
  },
  {
    name: 'contact_details',
    category: 'personal_data_request',
    severity: 'critical',
    pattern: /\b(?:[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}|(?:\+?\d[\d\s().-]{7,}\d))\b/i,
  },
  {
    name: 'meeting_solicitation',
    category: 'exploitation',
    severity: 'critical',
    pattern:
      /\b(?:meet\s+(?:me|up|in\s+person)|come\s+(?:and\s+)?(?:see|find)\s+me|where\s+do\s+you\s+live|what'?s\s+your\s+address|send\s+me\s+a\s+(?:photo|picture|pic))\b/i,
  },

  // S-3. The model asking for identifying information.
  {
    name: 'pii_solicitation',
    category: 'personal_data_request',
    severity: 'high',
    pattern:
      /\b(?:what(?:'s| is)\s+your\s+(?:full\s+name|last\s+name|surname|address|school|phone|postcode|zip)|which\s+school\s+do\s+you\s+go|where\s+is\s+your\s+(?:house|home|school))\b/i,
  },

  // S-6. Diagnosis, including of speech — the boundary this product could most
  // plausibly be nudged across, since it listens to children talk for a living.
  {
    name: 'diagnosis',
    category: 'unsafe_medical_advice',
    severity: 'critical',
    pattern:
      /\b(?:you\s+(?:might\s+|may\s+|probably\s+)?have\s+(?:a\s+)?(?:speech|language|learning|reading)?\s*(?:disorder|impediment|delay|difficulty|condition|disability|autism|adhd|dyslexia|stutter|lisp)|sounds?\s+like\s+(?:you\s+have|a\s+symptom)|you\s+should\s+(?:see|talk\s+to)\s+a\s+(?:doctor|therapist|specialist)\s+about\s+your)\b/i,
  },
  {
    name: 'medical_advice',
    category: 'unsafe_medical_advice',
    severity: 'high',
    pattern:
      /\b(?:you\s+should\s+take\s+(?:some\s+)?(?:medicine|medication|pills?|tablets?)|take\s+(?:some\s+)?(?:paracetamol|ibuprofen|aspirin)|the\s+(?:dose|dosage)\s+(?:is|should))\b/i,
  },
  {
    name: 'psychological_assessment',
    category: 'unsafe_psychological_advice',
    severity: 'critical',
    pattern:
      /\b(?:you\s+(?:are|might\s+be|sound|seem)\s+(?:clinically\s+)?(?:depressed|anxious|traumatised|traumatized|bipolar)|you\s+have\s+(?:anxiety|depression|trauma)|that'?s\s+(?:your\s+)?(?:anxiety|trauma)\s+(?:talking|speaking)|you\s+don'?t\s+need\s+(?:to\s+tell|help\s+from)\s+(?:anyone|a\s+grown-?up))\b/i,
  },

  // Prohibited content, §5. Narrow patterns: broad ones fire on ordinary story
  // language and train the team to ignore the findings.
  {
    name: 'violence',
    category: 'violence',
    severity: 'critical',
    // Past tense included: a model narrating "he shot him" is exactly the
    // failure this catches, and the present tense alone would miss it.
    pattern:
      /\b(?:shoot|shot|shooting|stab|stabbed|stabbing|kill|killed|killing|hurt|attacked|strangle[d]?)\s+(?:him|her|them|someone|you)\b/i,
  },
  {
    name: 'weapon_instructions',
    category: 'weapons',
    severity: 'critical',
    pattern:
      /\b(?:how\s+to\s+(?:make|build)\s+a\s+(?:gun|bomb|knife|weapon)|load\s+(?:a|the)\s+(?:gun|pistol|rifle)|sharpen\s+(?:a|the)\s+blade\s+(?:to|for))\b/i,
  },
  {
    name: 'self_harm_instruction',
    category: 'self_harm',
    severity: 'critical',
    pattern:
      /\b(?:hurt\s+yourself|harm\s+yourself|kill\s+yourself|end\s+your\s+life|cut\s+yourself)\b/i,
  },
  {
    name: 'dangerous_instruction',
    category: 'dangerous_activities',
    severity: 'critical',
    pattern:
      /\b(?:(?:you\s+(?:can|could|should)|try\s+to)\s+(?:light|start)\s+(?:a\s+)?fire|climb\s+out\s+(?:of|the)\s+window|(?:drink|swallow|eat)\s+(?:the\s+)?(?:bleach|chemicals|pills|medicine)|go\s+outside\s+(?:alone|by\s+yourself)\s+(?:at\s+night|without\s+telling))\b/i,
  },
  {
    name: 'substances',
    category: 'drugs',
    severity: 'high',
    pattern:
      /\b(?:beer|wine|vodka|whisk(?:e)?y|cigarettes?|vap(?:e|ing)|drunk|drugs?\s+to\s+take)\b/i,
  },
  {
    name: 'sexual_content',
    category: 'sexual_content',
    severity: 'critical',
    pattern: /\b(?:sex|sexy|porn|naked|nude|genitals?|penis|vagina|breasts?|masturbat)/i,
  },
  {
    name: 'abuse_depiction',
    category: 'abuse',
    severity: 'critical',
    pattern:
      /\b(?:(?:beat|hit|slap|punch|whip)(?:s|ed)?\s+(?:the\s+)?(?:child|kid|boy|girl|baby)|children\s+(?:deserve|should)\s+(?:to\s+be\s+)?(?:hit|beaten|punished\s+with))\b/i,
  },
  {
    name: 'harassment',
    category: 'harassment',
    severity: 'high',
    pattern:
      /\b(?:you'?re\s+(?:so\s+)?(?:stupid|dumb|useless|worthless|an?\s+idiot)|nobody\s+likes\s+you|you\s+(?:can'?t|will\s+never)\s+do\s+anything\s+right)\b/i,
  },

  // S-8. Monetisation never reaches child mode.
  {
    name: 'commercial_content',
    category: 'harassment',
    severity: 'medium',
    pattern:
      /\b(?:subscri(?:be|ption)|upgrade\s+to|buy\s+(?:now|the\s+full)|premium\s+version|ask\s+your\s+(?:mum|mom|dad|parents?)\s+to\s+(?:buy|pay))\b/i,
  },
]);

const COMPILED_INPUT = compile(INPUT_RULES);
const COMPILED_OUTPUT = compile(OUTPUT_RULES);

const scan = (text: string, rules: readonly CompiledRule[]): readonly Detection[] => {
  const variants = variantsOf(text);
  const found = new Map<string, Detection>();

  for (const variant of variants) {
    for (const rule of rules) {
      // Keep the first (least-derived) hit per rule: `raw` and `normalised` are
      // generated before the evasion variants, so a plainly-stated match is
      // never mislabelled as an evasion attempt.
      if (found.has(rule.name)) continue;

      const pattern = variant.kind === 'dense' ? rule.densePattern : rule.pattern;
      if (!pattern.test(variant.text)) continue;

      found.set(rule.name, {
        rule: rule.name,
        category: rule.category,
        severity: rule.severity,
        variant: variant.kind,
        evasion: variant.derived,
      });
    }
  }

  return [...found.values()];
};

export const detectInChildInput = (text: string): readonly Detection[] =>
  scan(text, COMPILED_INPUT);

export const detectInModelOutput = (text: string): readonly Detection[] =>
  scan(text, COMPILED_OUTPUT);

/**
 * Parent-configured blocked topics, checked as whole words.
 *
 * Separate from the rule set because these are per-child configuration, not
 * product policy — a parent blocking "spiders" is expressing a preference, not
 * identifying a harm, and it is recorded as its own detector so the two never
 * get conflated in the metrics.
 */
export const detectBlockedTopics = (
  text: string,
  blockedTopics: readonly string[],
): readonly Detection[] => {
  if (blockedTopics.length === 0) return [];
  const haystack = ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;

  return blockedTopics
    .map((topic) => topic.trim().toLowerCase())
    .filter((topic) => topic.length >= 2 && haystack.includes(` ${topic} `))
    .map((topic): Detection => ({
      rule: `parental_blocked_topic:${topic}`,
      category: 'harassment',
      severity: 'medium',
      variant: 'normalised',
      evasion: false,
    }));
};

/**
 * Enforces the age-group length ceiling on the actual reply.
 *
 * Asking a model for brevity is not the same as getting it, and a four-sentence
 * answer to a three-year-old is a worse experience than a truncated one — so the
 * ceiling is applied rather than requested, trimmed at a sentence boundary so
 * the result still reads as finished.
 */
export const enforceLength = (text: string, maxSentences: number): string => {
  const sentences = text.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g);
  if (!sentences || sentences.length <= maxSentences) return text.trim();
  return sentences.slice(0, maxSentences).join('').trim();
};
