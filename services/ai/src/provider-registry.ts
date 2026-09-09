import type { AiProviderName } from '@kids/types';

import type { AIProvider } from './ports.js';

/**
 * Which vendors this deployment can actually reach, and how a name becomes one.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY A REGISTRY RATHER THAN A SECOND `if` IN `app.ts`
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The provider used to be chosen once at boot by a single conditional. That
 * works while there is one vendor and one choice; it stops working the moment a
 * parent can pick, because the question changes from "which provider did the
 * operator configure" to "is the one this family asked for actually usable
 * here, and what happens when it is not".
 *
 * The second half is the whole reason this exists. A stored preference is a
 * name, and a name outlives the key it needs: an operator rotates a key out, or
 * restores a database into an environment configured differently, and every
 * family who chose that vendor now points at nothing. `resolve` answers that
 * case the same way every time — fall back to the deployment default — so a
 * missing key costs a family their preference and never costs a child their
 * turn.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * It does not construct providers, and it does not read configuration. It is
 * handed the adapters that could be built and told which is the default, which
 * keeps `@kids/ai` free of any dependency on `@kids/config` and keeps the whole
 * thing testable with three fakes and no environment.
 */

export interface ProviderRegistry {
  /** Used when a family expressed no preference, or an unusable one. */
  readonly fallback: AIProvider;
  /** What a parent may choose from, in a stable order for the settings list. */
  readonly available: readonly AiProviderName[];
  /**
   * A stored preference to the adapter that serves it.
   *
   * Never throws and never returns undefined: an unknown name, an unconfigured
   * one, and no preference at all all mean the deployment default.
   */
  resolve(name: string | null | undefined): AIProvider;
}

export interface ProviderRegistryOptions {
  /**
   * Every adapter that could be constructed — that is, every vendor whose
   * credentials this deployment actually holds.
   */
  readonly providers: readonly AIProvider[];
  /**
   * The operator's choice, from `AI_PROVIDER`.
   *
   * If it is not among `providers` the first entry is used instead, because a
   * registry with no reachable fallback is worse than one that quietly picks a
   * reachable vendor. `createProviderRegistry` throws if `providers` is empty,
   * which is a boot-time misconfiguration rather than a runtime condition.
   */
  readonly defaultName: string;
}

export const createProviderRegistry = (options: ProviderRegistryOptions): ProviderRegistry => {
  const byName = new Map<string, AIProvider>();
  for (const provider of options.providers) byName.set(provider.name, provider);

  const first = options.providers[0];
  if (!first) {
    // Unreachable in practice: the mock needs no credentials and is always
    // constructible, so the caller can always supply at least one. Checked
    // anyway, because the alternative is a registry whose `resolve` returns
    // undefined and a `TypeError` on a child's first turn.
    throw new Error('createProviderRegistry needs at least one provider');
  }

  const fallback = byName.get(options.defaultName) ?? first;

  return {
    fallback,
    available: [...byName.keys()] as readonly AiProviderName[],
    resolve: (name) => (name == null ? fallback : (byName.get(name) ?? fallback)),
  };
};
