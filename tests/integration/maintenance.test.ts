import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApiHarness, type ApiHarness } from '../helpers/api.js';

/**
 * The scheduled sweeps the worker process runs.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THESE ARE TESTED THROUGH THE APP AND NOT DIRECTLY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `apps/api/src/worker.ts` obtains its dependencies by building the app and
 * reading `app.maintenance`, precisely so there is one wiring path rather than
 * two that can drift. That makes the decoration a contract: if it disappears or
 * changes shape, the worker breaks at runtime in a process nobody is watching.
 *
 * So these run the sweeps the way the worker does. They assert that each is
 * reachable, returns its documented shape, and is safe to run against a system
 * where there is nothing to do — which is the state a sweep is in almost every
 * time it fires, and the one where a crash would be most embarrassing.
 */
describe('maintenance sweeps', () => {
  let harness: ApiHarness;

  beforeAll(async () => {
    harness = await createApiHarness();
  }, 180_000);

  afterAll(async () => {
    await harness.close();
  });

  it('exposes every sweep the worker schedules', () => {
    /* A worker that starts, schedules nothing, and reports itself healthy is
     * the failure this catches: it looks identical to a working one. */
    expect(typeof harness.app.maintenance.sweepExpiredSubscriptions).toBe('function');
    expect(typeof harness.app.maintenance.reconcilePayments).toBe('function');
    expect(typeof harness.app.maintenance.synchroniseStorePurchases).toBe('function');
  });

  it('expires nothing when nothing has elapsed', async () => {
    expect(await harness.app.maintenance.sweepExpiredSubscriptions()).toBe(0);
  });

  it('reconciles payments without a rail enabled', async () => {
    // The default state of this product is zero payment rails. A sweep that
    // threw here would crash-loop the worker in every environment that has not
    // enabled payments yet — which is all of them.
    const result = await harness.app.maintenance.reconcilePayments();

    expect(result).toMatchObject({ checked: 0, resolved: 0, stillUnresolved: 0 });
  });

  it('synchronises store purchases with no store provider configured', async () => {
    const result = await harness.app.maintenance.synchroniseStorePurchases();

    expect(result).toMatchObject({ checked: 0, changed: 0 });
  });

  it('is repeatable — a sweep that already ran changes nothing the second time', async () => {
    // Sweeps fire on a timer forever. Any of them that were not idempotent
    // would corrupt state on the second pass rather than the first, which is
    // the hardest kind of bug to attribute.
    await harness.app.maintenance.sweepExpiredSubscriptions();
    await harness.app.maintenance.reconcilePayments();

    expect(await harness.app.maintenance.sweepExpiredSubscriptions()).toBe(0);
    expect(await harness.app.maintenance.reconcilePayments()).toMatchObject({ resolved: 0 });
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════
   * THE SWEEP THAT MUST NOT RUN IN THE WORKER.
   * ═══════════════════════════════════════════════════════════════════════
   *
   * Audio retention deletes a child's recording. The only storage
   * implementation is in-memory, so the bytes live in whichever process wrote
   * them. Sweeping from the worker would mark the ledger rows deleted while the
   * objects survived in the API's heap — a retention record asserting a
   * deletion that never happened.
   *
   * This flag is what stops the worker scheduling it, so it is pinned here
   * rather than left as a comment somebody later "tidies up".
   */
  it('declares that the audio sweep cannot be run from another process', () => {
    expect(harness.app.maintenance.audioSweepIsShared).toBe(false);
  });
});
