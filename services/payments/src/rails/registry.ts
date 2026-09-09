import type { PaymentRail } from '../ports.js';

import { createCardRail, type CardConfig } from './card.js';
import { createCarrierBillingRail, type CarrierBillingConfig } from './carrier-billing.js';
import { createEasypaisaRail, type EasypaisaConfig } from './easypaisa.js';
import { createJazzCashRail, type JazzCashConfig } from './jazzcash.js';
import { isFullyVerified, outstandingChecks, type PaymentRailAdapter } from './types.js';

/**
 * The rail registry.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE APPLICATION RUNS WITH ZERO RAILS ENABLED, AND THAT IS A SUPPORTED STATE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Not a degraded mode to be tolerated — the normal one for most of this
 * product's life so far. Payments are off in local development, off in CI, and
 * off in any deployment where the rail question (Q-02) has not been answered.
 *
 * With no rails, every family is on the free tier, every child can still talk,
 * and the only thing that changes is that `POST /subscriptions/create` says so
 * plainly instead of erroring. Nothing in the conversation path, the safety
 * pipeline, or the parent dashboard touches this registry.
 *
 * The failure this design prevents is the common one: a payment vendor outage,
 * a missing credential, or an unfinished integration taking down a children's
 * app that does not need payments to function.
 */

export interface RailRegistryConfig {
  /** Which rails are switched on. Empty is valid and means payments are off. */
  readonly enabled: readonly PaymentRail[];
  readonly jazzcash?: JazzCashConfig | undefined;
  readonly easypaisa?: EasypaisaConfig | undefined;
  readonly carrierBilling?: CarrierBillingConfig | undefined;
  readonly card?: CardConfig | undefined;
  /** Extra adapters, for the mock rail and for tests. */
  readonly extra?: readonly PaymentRailAdapter[] | undefined;
}

export interface RailRegistry {
  /** Every rail that is switched on and constructible. */
  available(): readonly PaymentRailAdapter[];
  /** Undefined rather than throwing — "not available" is an answer, not a fault. */
  get(rail: string): PaymentRailAdapter | undefined;
  /** Whether any rail can take a payment at all. */
  anyAvailable(): boolean;
  /** Rails switched on whose wire format is unverified. */
  unverified(): readonly PaymentRailAdapter[];
}

/**
 * Why a rail that was asked for is not there.
 *
 * Distinguished from "no rails at all" because the remedies differ: a missing
 * credential is an operator's problem, and an unbuilt integration is an
 * engineer's.
 */
export type RailUnavailableReason = 'not_enabled' | 'not_configured' | 'unknown_rail';

export const createRailRegistry = (config: RailRegistryConfig): RailRegistry => {
  const adapters = new Map<string, PaymentRailAdapter>();

  const add = (rail: PaymentRail, build: () => PaymentRailAdapter): void => {
    if (!config.enabled.includes(rail)) return;
    // A rail switched on without its configuration is skipped rather than
    // constructed half-built. It reappears in `available()` the moment the
    // credentials arrive, with no code change.
    adapters.set(rail, build());
  };

  if (config.jazzcash) add('jazzcash', () => createJazzCashRail(config.jazzcash!));
  if (config.easypaisa) add('easypaisa', () => createEasypaisaRail(config.easypaisa!));
  if (config.carrierBilling) {
    add('carrier_billing', () => createCarrierBillingRail(config.carrierBilling!));
  }
  if (config.card) add('card', () => createCardRail(config.card!));

  for (const adapter of config.extra ?? []) {
    if (config.enabled.includes(adapter.rail)) adapters.set(adapter.rail, adapter);
  }

  return {
    available: () => [...adapters.values()],
    get: (rail) => adapters.get(rail),
    anyAvailable: () => adapters.size > 0,
    unverified: () => [...adapters.values()].filter((a) => !isFullyVerified(a.verification)),
  };
};

/**
 * A boot-time report of what is switched on and what it can do.
 *
 * Logged once at startup. "Which rails are live, and are any of them running on
 * an unverified integration?" is the question nobody asks until an incident,
 * and by then the answer is buried in configuration nobody can see.
 */
export const describeRegistry = (
  registry: RailRegistry,
): readonly {
  rail: string;
  mode: string;
  verified: boolean;
  outstanding: readonly string[];
  refunds: string;
  recurring: string;
}[] =>
  registry.available().map((adapter) => ({
    rail: adapter.rail,
    mode: adapter.mode,
    verified: isFullyVerified(adapter.verification),
    outstanding: outstandingChecks(adapter.verification),
    refunds: adapter.capabilities.refunds,
    recurring: adapter.capabilities.recurring,
  }));
