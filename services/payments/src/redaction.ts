/**
 * Card-data redaction for stored webhook payloads.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NO TABLE IN THIS SYSTEM MAY HOLD A CARD NUMBER, AND `payment_events.payload`
 * IS THE ONLY PLACE ONE COULD ARRIVE UNINVITED.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Everywhere else the schema decides: there is no column that could hold a PAN.
 * The payload column is `jsonb`, which is exactly the shape that accepts
 * whatever a vendor decides to send next — including, on some rails, a field
 * nobody asked for.
 *
 * So two independent filters run, because either one alone is wishful thinking:
 *
 *   * **By key.** An explicit deny-list of the names card data actually travels
 *     under. Cheap, and catches the ordinary case.
 *   * **By shape.** Any string of 13–19 digits that passes the Luhn check is
 *     redacted whatever it is called. This is the one that matters — it catches
 *     a PAN a vendor put in `metadata.reference`, which no key list would ever
 *     have predicted.
 *
 * Luhn has false positives. A 16-digit order reference will occasionally pass
 * it and get redacted, and that is the right trade: an over-redacted reference
 * costs a support query, an under-redacted PAN costs a compliance incident.
 */

export const REDACTED = '[redacted]';

/**
 * Field names card data travels under.
 *
 * Matched case-insensitively as substrings, because vendors spell things
 * `card_number`, `cardNumber`, `CardNum`, and `pan`.
 */
const DENIED_KEY_PATTERNS: readonly RegExp[] = [
  /card[_-]?(number|num|no)/i,
  /\bpan\b/i,
  /cvv|cvc|csc|security[_-]?code/i,
  /exp(iry|iration)?[_-]?(date|month|year)?$/i,
  /\biban\b|\bbic\b|swift/i,
  /account[_-]?(number|no)/i,
  /routing[_-]?number|sort[_-]?code/i,
  /cardholder|card[_-]?holder/i,
];

/** The digits-only form of a candidate, or undefined if it is not card-shaped. */
const cardDigits = (value: string): string | undefined => {
  const digits = value.replace(/[\s-]/g, '');
  if (!/^\d{13,19}$/.test(digits)) return undefined;
  return digits;
};

/** Luhn. Every real card number passes it; most reference numbers do not. */
export const looksLikeCardNumber = (value: string): boolean => {
  const digits = cardDigits(value);
  if (digits === undefined) return false;

  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let digit = digits.charCodeAt(i) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
};

const isDeniedKey = (key: string): boolean =>
  DENIED_KEY_PATTERNS.some((pattern) => pattern.test(key));

/**
 * A payload safe to persist.
 *
 * Depth- and size-bounded: a vendor payload is untrusted input, and a deeply
 * nested one would otherwise be a stack overflow in the webhook handler — which
 * is a denial of service on the endpoint that keeps subscriptions correct.
 */
export const redactPayload = (
  value: unknown,
  options: { maxDepth?: number; maxKeys?: number } = {},
): unknown => {
  const maxDepth = options.maxDepth ?? 8;
  const maxKeys = options.maxKeys ?? 200;
  let keysSeen = 0;

  const walk = (node: unknown, depth: number): unknown => {
    if (depth > maxDepth) return REDACTED;

    if (typeof node === 'string') {
      return looksLikeCardNumber(node) ? REDACTED : node;
    }
    if (typeof node === 'number') {
      // A PAN sent as a JSON number loses nothing to this check.
      return looksLikeCardNumber(String(node)) ? REDACTED : node;
    }
    if (node === null || typeof node !== 'object') return node;

    if (Array.isArray(node)) {
      return node.slice(0, 50).map((item) => walk(item, depth + 1));
    }

    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(node)) {
      keysSeen += 1;
      if (keysSeen > maxKeys) break;
      output[key] = isDeniedKey(key) ? REDACTED : walk(item, depth + 1);
    }
    return output;
  };

  const result = walk(value, 0);
  return typeof result === 'object' && result !== null ? result : {};
};

/** Last four digits, or undefined. The only part of a card this system keeps. */
export const lastFour = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const digits = value.replace(/\D/g, '');
  return /^\d{4}$/.test(digits) ? digits : undefined;
};
