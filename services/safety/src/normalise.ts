/**
 * Text normalisation for detection.
 *
 * A pattern-based detector is only as good as its ability to see through
 * obfuscation. `k i l l`, `k1ll`, `llik` reversed, and a base64 blob all carry
 * the same payload, and a rule written against `kill` catches none of them.
 *
 * This module produces a small set of VARIANTS of a message. Detectors run
 * against all of them. Two rules govern the design:
 *
 * 1. VARIANTS ARE NEVER PERSISTED AND NEVER SENT ANYWHERE. They exist inside one
 *    function call and are discarded. A decoded base64 blob is still the child's
 *    message (PRIVACY.md §4).
 *
 * 2. AGGRESSIVE NORMALISATION IS GATED. Stripping every separator turns
 *    "task illustration" into a string containing "kill". So the dense variant
 *    is produced only when the text actually looks obfuscated — a child typing
 *    normally never triggers it.
 */

export type VariantKind =
  'raw' | 'normalised' | 'dense' | 'leet' | 'reversed' | 'rot13' | 'decoded';

export interface TextVariant {
  readonly kind: VariantKind;
  readonly text: string;
  /**
   * Whether this variant came from an obfuscation-reversing transform.
   *
   * Findings on a derived variant mean something different from findings on the
   * raw text: a child who typed `h-o-w t-o m-a-k-e a b-o-m-b` was working to get
   * past something, and that is worth recording separately.
   */
  readonly derived: boolean;
}

/**
 * Confusable characters that render like Latin letters.
 *
 * Not exhaustive — Unicode confusables are a long tail, and the full table is a
 * dependency this package does not want. The common Cyrillic and Greek
 * lookalikes plus the dotless Turkish i cover what a determined nine-year-old
 * copying from a web page will actually paste. See docs/SAFETY_SUBSYSTEM.md §9
 * for why this is a known limitation rather than a solved problem.
 */
const CONFUSABLES: Readonly<Record<string, string>> = Object.freeze({
  а: 'a', // Cyrillic а
  е: 'e', // е
  о: 'o', // о
  р: 'p', // р
  с: 'c', // с
  х: 'x', // х
  у: 'y', // у
  і: 'i', // і
  ѕ: 's', // ѕ
  α: 'a', // Greek α
  β: 'b', // β
  ε: 'e', // ε
  ι: 'i', // ι
  κ: 'k', // κ
  ο: 'o', // ο
  ρ: 'p', // ρ
  τ: 't', // τ
  υ: 'u', // υ
  ı: 'i', // dotless ı
  ł: 'l', // ł
  ø: 'o', // ø
});

/**
 * Leetspeak substitutions.
 *
 * Applied only inside tokens that already contain a letter, so "I have 3 cats"
 * does not become "I have e cats" and start matching things it should not.
 */
const LEET: Readonly<Record<string, string>> = Object.freeze({
  '4': 'a',
  '@': 'a',
  '3': 'e',
  '1': 'i',
  '!': 'i',
  '0': 'o',
  '5': 's',
  $: 's',
  '7': 't',
  '+': 't',
  '9': 'g',
});

/** NFKD then drop the combining marks, so `ḳíḷḷ` collapses to `kill`. */
const stripDiacritics = (text: string): string =>
  text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');

/** Only non-ASCII characters can be confusables, so ASCII is left untouched. */
const mapConfusables = (text: string): string =>
  text.replace(/[\u0080-\uffff]/g, (char) => CONFUSABLES[char.toLowerCase()] ?? char);

const LEET_CHARS = /[4@31!05$7+9]/g;

const unLeet = (text: string): string =>
  text.replace(/\S+/g, (token) => {
    if (!/[a-z]/i.test(token)) return token;
    return token.replace(LEET_CHARS, (char) => LEET[char] ?? char);
  });

/** Every leet character substituted, including standalone ones. See `variantsOf`. */
const unLeetEverywhere = (text: string): string =>
  text.replace(LEET_CHARS, (char) => LEET[char] ?? char);

/**
 * Collapses runs of three or more identical letters to two.
 *
 * "kiiiiill" becomes "kiill" rather than "kill" — deliberately conservative.
 * Collapsing to a single letter would mangle ordinary words like "bookkeeper",
 * so the rules that care use `i+`-style patterns instead.
 */
const collapseRuns = (text: string): string => text.replace(/([a-z])\1{2,}/gi, '$1$1');

export const normalise = (text: string): string =>
  collapseRuns(unLeet(mapConfusables(stripDiacritics(text)))).toLowerCase();

/**
 * Does this text look like someone is working around a filter?
 *
 * Two cheap signals: runs of single characters separated by punctuation or
 * spaces (`k i l l`, `k.i.l.l`), and an unusually high ratio of separators to
 * letters. Ordinary child speech triggers neither, which is what lets the dense
 * variant exist at all.
 */
export const looksObfuscated = (text: string): boolean => {
  if (/(?:\b[a-z0-9]\W+){3,}[a-z0-9]\b/i.test(text)) return true;

  const letters = (text.match(/[a-z]/gi) ?? []).length;
  if (letters < 8) return false;
  const separators = (text.match(/[^a-z0-9\s]/gi) ?? []).length;
  return separators > letters * 0.4;
};

const rot13 = (text: string): string =>
  text.replace(/[a-z]/gi, (char) => {
    const base = char <= 'Z' ? 65 : 97;
    return String.fromCharCode(((char.charCodeAt(0) - base + 13) % 26) + base);
  });

/**
 * Decodes base64-looking tokens.
 *
 * Only tokens of 16+ characters that decode to mostly-printable text containing
 * two adjacent words are kept. Shorter tokens produce noise, and a decode that
 * yields binary was not base64 prose in the first place — this is a guess about
 * intent, not a validation.
 */
const decodeBase64Tokens = (text: string): string[] => {
  const decoded: string[] = [];
  const candidates = text.match(/[A-Za-z0-9+/]{16,}={0,2}/g) ?? [];

  for (const candidate of candidates.slice(0, 8)) {
    try {
      const bytes = Buffer.from(candidate, 'base64');
      if (bytes.length < 8) continue;
      const asText = bytes.toString('utf8');
      const printable = (asText.match(/[ -~]/g) ?? []).length;
      if (printable / asText.length > 0.9 && /[a-z]{3,}\s+[a-z]{2,}/i.test(asText)) {
        decoded.push(asText);
      }
    } catch {
      // Not base64. Nothing to record.
    }
  }

  return decoded;
};

/** Ceiling on variant generation, so a pathological input cannot burn CPU. */
const MAX_VARIANT_INPUT = 8_000;

/**
 * The variants a detector should scan.
 *
 * `raw` and `normalised` are always present. `dense` appears only when the text
 * looks obfuscated. `reversed` and `rot13` are unconditional but effectively
 * free of false positives: scanning reversed text for `kill` is the same as
 * scanning the original for `llik`, which does not occur by accident.
 */
export const variantsOf = (input: string): readonly TextVariant[] => {
  const text = input.slice(0, MAX_VARIANT_INPUT);
  const normalised = normalise(text);

  const variants: TextVariant[] = [
    { kind: 'raw', text, derived: false },
    { kind: 'normalised', text: normalised, derived: false },
  ];

  if (looksObfuscated(text)) {
    variants.push({ kind: 'dense', text: normalised.replace(/[^a-z0-9]/g, ''), derived: true });
  }

  // In-word leet is a declaration of intent. Once a message contains `h0w` or
  // `m4k3`, the bare `4` in the same message is an `a` too — but only in that
  // message, which is why this is gated rather than folded into `normalise`.
  const strippedLeet = stripDiacritics(mapConfusables(text));
  if (unLeet(strippedLeet) !== strippedLeet) {
    variants.push({
      kind: 'leet',
      text: collapseRuns(unLeetEverywhere(strippedLeet)).toLowerCase(),
      derived: true,
    });
  }

  variants.push({ kind: 'reversed', text: [...normalised].reverse().join(''), derived: true });
  variants.push({ kind: 'rot13', text: rot13(normalised), derived: true });

  for (const decoded of decodeBase64Tokens(text)) {
    variants.push({ kind: 'decoded', text: normalise(decoded), derived: true });
  }

  return variants;
};
