/**
 * `Result` makes expected failure visible in the type, so a caller cannot forget
 * it exists.
 *
 * Expected failures — a quota exhausted, a safety block, a not-found — are part
 * of the domain and are returned. Unexpected failures — a broken invariant, a
 * vanished database — throw and travel to the error boundary.
 *
 * See docs/ERROR_HANDLING.md#2.
 */
export type Result<T, E> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });

export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export const isOk = <T, E>(r: Result<T, E>): r is { readonly ok: true; readonly value: T } => r.ok;

export const isErr = <T, E>(r: Result<T, E>): r is { readonly ok: false; readonly error: E } =>
  !r.ok;
