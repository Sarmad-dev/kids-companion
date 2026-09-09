import { asSystem, type Database } from '@kids/db';
import {
  DEFAULT_POLICY,
  policyFromRows,
  type AttemptCounter,
  type SafetyPolicy,
} from '@kids/safety';

/**
 * The database-backed half of the safety subsystem.
 *
 * `@kids/safety` deliberately owns no storage — it takes a policy and a counter
 * and decides. This file supplies both from Postgres, which is what makes the
 * policy table worth having: a threshold tightened with an UPDATE takes effect
 * in a running process, without a deploy.
 *
 * Both readers run under the SYSTEM context. `safety_policies` is
 * parent-readable, but the counter reads across `content_flags` in a way no
 * single parent's RLS context should be shaped around, and the policy must load
 * during boot when there is no request principal at all.
 */

export interface PolicyStoreOptions {
  readonly db: Database;
  /**
   * How long a loaded policy is served before the next read is refreshed.
   *
   * Sixty seconds is a compromise: short enough that tightening a rule is felt
   * almost immediately, long enough that the hot path is not doing a query per
   * turn. The refresh happens in the background — a check never waits on it.
   */
  readonly ttlMs?: number;
  readonly onError?: (error: unknown) => void;
}

interface PolicyRow {
  category: string;
  age_group: string;
  applies_to: string;
  action: string;
  min_confidence: number;
  escalates: boolean;
  policy_version: string;
}

/**
 * A synchronous policy getter over an asynchronously refreshed cache.
 *
 * The pipeline's policy getter must be synchronous and must never throw: a
 * policy lookup is not allowed to be the thing that fails a safety check. So
 * this serves the last good value, refreshes out of band, and falls back to the
 * compiled-in policy — which is at least as strict as anything the table holds —
 * until a real one has loaded.
 */
export const createPolicyStore = (options: PolicyStoreOptions) => {
  const ttlMs = options.ttlMs ?? 60_000;
  let cached: SafetyPolicy = DEFAULT_POLICY;
  let loadedAt = 0;
  let inFlight: Promise<void> | null = null;

  const load = async (): Promise<void> => {
    try {
      const rows = await asSystem(options.db, async (tx) => {
        const result = await tx.query<PolicyRow>(
          `select category, age_group, applies_to, action, min_confidence, escalates, policy_version
             from safety_policies
            where is_active
            order by category, age_group, applies_to`,
        );
        return result.rows;
      });
      cached = policyFromRows(rows);
      loadedAt = Date.now();
    } catch (error) {
      // A policy that will not load is not a reason to stop serving children —
      // the compiled-in fallback is stricter, not looser. It IS a reason to make
      // noise, because running on the fallback indefinitely is a silent
      // degradation of a safety control.
      options.onError?.(error);
      loadedAt = Date.now();
    } finally {
      inFlight = null;
    }
  };

  const refreshIfStale = (): void => {
    if (inFlight !== null) return;
    if (Date.now() - loadedAt < ttlMs) return;
    inFlight = load();
  };

  return {
    /** Blocks until the first read completes. Called once, during boot. */
    prime: load,
    /** Synchronous, never throws. Safe to pass straight to the pipeline. */
    current: (): SafetyPolicy => {
      refreshIfStale();
      return cached;
    },
    /** True while the compiled-in fallback is in use rather than the table. */
    isFallback: (): boolean => cached === DEFAULT_POLICY,
  };
};

export type PolicyStore = ReturnType<typeof createPolicyStore>;

/**
 * Counts a child's recent stopped turns, for the repeated-attempt rule.
 *
 * A COUNT and nothing else. The rule needs to know that a child has tried five
 * times; it does not need, and must not have, the five utterances — which is why
 * `app.recent_safety_blocks()` returns an integer and cannot be asked for more.
 */
export const createAttemptCounter = (db: Database): AttemptCounter => ({
  recentBlocks: async (childRef: string, withinMinutes: number): Promise<number> =>
    await asSystem(db, async (tx) => {
      const { rows } = await tx.query<{ count: number }>(
        `select app.recent_safety_blocks($1::uuid, $2::int) as count`,
        [childRef, withinMinutes],
      );
      return rows[0]?.count ?? 0;
    }),
});
