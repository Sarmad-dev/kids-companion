/**
 * Formatting.
 *
 * Small, boring, and centralised because the alternative is four different
 * renderings of "12.5 minutes" across four pages, and a parent noticing.
 */

export const minutes = (value: number): string => {
  if (!Number.isFinite(value) || value <= 0) return 'none yet';
  if (value < 1) return 'under a minute';
  const rounded = Math.round(value);
  return `${String(rounded)} ${rounded === 1 ? 'minute' : 'minutes'}`;
};

export const count = (value: number, singular: string, plural?: string): string => {
  const n = Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
  return `${String(n)} ${n === 1 ? singular : (plural ?? `${singular}s`)}`;
};

/**
 * A score, as a word.
 *
 * DELIBERATELY NOT A PERCENTAGE. "68%" invites a parent to ask what a good
 * percentage is, and this product cannot answer that — it has no normative
 * sample and speech recognition is materially less accurate with children than
 * with adults. A band says what we actually know.
 */
export const scoreBand = (value: number | null): string => {
  if (value === null || !Number.isFinite(value)) return 'not enough tries yet';
  if (value >= 0.85) return 'usually clear';
  if (value >= 0.65) return 'often clear';
  if (value >= 0.4) return 'still practising';
  return 'just getting started';
};

export const levelLabel = (level: string): string =>
  ({
    getting_started: 'Getting started',
    growing: 'Growing',
    confident: 'Confident',
  })[level] ?? 'Getting started';

export const shortDate = (iso: string): string => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
};

export const longDate = (iso: string): string => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
};
