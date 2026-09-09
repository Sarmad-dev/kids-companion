/**
 * Small helpers for ARIA attributes that are easy to get subtly wrong.
 *
 * Kept as plain functions rather than inline JSX expressions so they can be
 * tested in Node. There is no DOM test environment in this workspace, so logic
 * that only exists inside a component is logic nothing verifies.
 */

/**
 * Combines `aria-describedby` values.
 *
 * The attribute takes a SPACE-SEPARATED LIST of ids, not one id — which is why
 * overwriting it is a real bug rather than a stylistic one: a control can
 * legitimately be described by both a hint and a validation message, and
 * replacing the first with the second silently drops half of what a screen
 * reader would have said.
 *
 * Duplicates are removed because a repeated id makes some screen readers
 * announce the same text twice.
 */
export const mergeDescribedBy = (
  existing: string | undefined,
  ...add: readonly (string | undefined)[]
): string | undefined => {
  const ids = [
    ...(existing ?? '').split(/\s+/),
    ...add.flatMap((value) => (value ?? '').split(/\s+/)),
  ].filter((id) => id !== '');

  const unique = [...new Set(ids)];
  return unique.length === 0 ? undefined : unique.join(' ');
};
