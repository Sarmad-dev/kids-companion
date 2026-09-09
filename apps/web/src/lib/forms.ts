/**
 * Reading a submitted form.
 *
 * `FormData.get` returns `string | File | null`, and `String(...)` on that is a
 * quiet bug rather than a loud one: a file posted under a text field's name
 * becomes the literal text `[object File]`, which is a perfectly valid string
 * and would be saved as a child's display name or a blocked topic.
 *
 * These helpers narrow instead of stringifying, so anything that is not text is
 * treated as absent. Server Actions accept whatever is posted to them — a form
 * on the page is a convention, not a constraint — so this is the boundary where
 * a submission stops being trusted input and becomes typed data.
 */

export const text = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
};

/** A trimmed field, or `null` when it was blank or absent. */
export const optionalText = (form: FormData, name: string): string | null => {
  const value = text(form, name).trim();
  return value === '' ? null : value;
};

/** A whole number within bounds, falling back rather than throwing. */
export const wholeNumber = (
  form: FormData,
  name: string,
  options: { fallback: number; min?: number; max?: number },
): number => {
  const raw = text(form, name).trim();
  const parsed = Number(raw);
  if (raw === '' || !Number.isFinite(parsed)) return options.fallback;

  const rounded = Math.round(parsed);
  const min = options.min ?? 0;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;
  return Math.min(Math.max(rounded, min), max);
};

/** Every text value posted under one name. Files are dropped, not stringified. */
export const textList = (form: FormData, name: string): string[] =>
  form.getAll(name).filter((value): value is string => typeof value === 'string');

/** An unticked checkbox posts nothing at all; a ticked one posts `on`. */
export const checked = (form: FormData, name: string): boolean => text(form, name) === 'on';
