import { describe, expect, it } from 'vitest';

import { createMockProvider } from './mock-provider.js';
import type { AIProvider } from './ports.js';
import { createProviderRegistry } from './provider-registry.js';

/** A provider that is only ever asked its name. */
const named = (name: string): AIProvider => ({ ...createMockProvider(), name });

const anthropic = named('anthropic');
const google = named('google');
const mock = named('mock');

describe('the provider registry', () => {
  describe('resolving a stored preference', () => {
    it('returns the provider a family named', () => {
      const registry = createProviderRegistry({
        providers: [anthropic, google, mock],
        defaultName: 'anthropic',
      });

      expect(registry.resolve('google').name).toBe('google');
    });

    it('falls back to the deployment default when no preference was expressed', () => {
      const registry = createProviderRegistry({
        providers: [anthropic, google, mock],
        defaultName: 'anthropic',
      });

      expect(registry.resolve(null).name).toBe('anthropic');
      expect(registry.resolve(undefined).name).toBe('anthropic');
    });

    /**
     * The case this whole type exists for: a name outlives the key it needs.
     * An operator rotates a credential out, or a database is restored into a
     * differently-configured environment, and a stored preference now points at
     * a vendor this process cannot reach. It must cost the family their
     * preference, never cost a child their turn.
     */
    it('falls back rather than failing when the named provider is not configured here', () => {
      const registry = createProviderRegistry({
        providers: [anthropic, mock],
        defaultName: 'anthropic',
      });

      expect(registry.resolve('google').name).toBe('anthropic');
    });

    it('falls back on a name that is not a provider at all', () => {
      const registry = createProviderRegistry({
        providers: [anthropic, mock],
        defaultName: 'anthropic',
      });

      expect(registry.resolve('not-a-vendor').name).toBe('anthropic');
    });
  });

  describe('the deployment default', () => {
    it('uses the first provider when the configured default was not built', () => {
      // AI_PROVIDER names a vendor whose key is absent. Booting with an
      // unreachable fallback would defer the failure to a child's first turn.
      const registry = createProviderRegistry({
        providers: [mock],
        defaultName: 'openai',
      });

      expect(registry.fallback.name).toBe('mock');
    });

    it('refuses to build with no providers at all', () => {
      expect(() => createProviderRegistry({ providers: [], defaultName: 'mock' })).toThrow(
        /at least one provider/,
      );
    });
  });

  describe('what a parent may choose from', () => {
    it('lists only what this deployment can reach', () => {
      const registry = createProviderRegistry({
        providers: [anthropic, mock],
        defaultName: 'anthropic',
      });

      expect(registry.available).toEqual(['anthropic', 'mock']);
    });
  });
});
