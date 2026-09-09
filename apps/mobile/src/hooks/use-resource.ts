import { useCallback, useEffect, useState } from 'react';

import type { ApiResult } from '../api/client';
import { failureFor, type FriendlyFailure } from '../api/errors';

/**
 * Load something from the API, once, with a way to try again.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY EVERY SCREEN GETS THE SAME THREE STATES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * loading / failed / loaded, and nothing else. Every child screen turns those
 * into the same three things — the character thinking, one warm sentence, the
 * content — and every parent screen into a spinner, a banner and a form. When
 * each screen hand-rolled its own `useState` pair, they drifted: some cleared
 * the previous data on reload and some did not, some showed a retry button for
 * a failure that could not be retried, and one showed an empty list while a
 * request was still in flight.
 *
 * `reload` deliberately CLEARS the previous data. A list that shows stale rows
 * while refetching is defensible in an inbox; here it means a parent can change
 * a limit, see the old value, and reasonably conclude the change did not save.
 */

export interface Resource<T> {
  readonly data: T | undefined;
  readonly failure: FriendlyFailure | undefined;
  readonly loading: boolean;
  readonly reload: () => void;
  /** Replaces the loaded value in place, for a screen that just saved one. */
  readonly set: (next: T) => void;
}

export const useResource = <T>(
  load: () => Promise<ApiResult<T>>,
  deps: readonly unknown[],
): Resource<T> => {
  const [data, setData] = useState<T | undefined>(undefined);
  const [failure, setFailure] = useState<FriendlyFailure | undefined>(undefined);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setData(undefined);
    setFailure(undefined);

    void load().then((result) => {
      // A screen that has been left must not call setState. Without this, every
      // fast back-tap out of a loading screen logged a warning and, on the
      // conversation screen, resurrected a talk state the child had abandoned.
      if (cancelled) return;
      if (result.ok && result.data !== undefined) setData(result.data);
      else setFailure(result.failure ?? failureFor('unknown'));
    });

    return () => {
      cancelled = true;
    };
    // `load` is a fresh closure every render; the caller's own deps are the
    // honest dependency list, which is why it is passed in explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => {
    setNonce((n) => n + 1);
  }, []);

  return {
    data,
    failure,
    loading: data === undefined && failure === undefined,
    reload,
    set: setData,
  };
};
