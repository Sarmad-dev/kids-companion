import { ProviderTimeoutError, ProviderUnavailableError } from '@kids/shared';

import type {
  AIProvider,
  DetectLanguageRequest,
  DetectLanguageResult,
  GenerateRequest,
  GenerateResult,
  ModerationCategory,
  ModerationRequest,
  ModerationResult,
  StructuredRequest,
  StructuredResult,
} from './ports.js';

/**
 * The mock provider.
 *
 * Not a testing afterthought — it is the DEFAULT in `local` and `ci`, so a fresh
 * clone runs the whole conversation loop with no API key and no spend
 * (docs/adr/0004). It is also the only way to test the engine's failure
 * handling, because a real provider cannot be asked to time out on demand.
 *
 * Deterministic: the same input yields the same output, so a test asserting on a
 * reply is not asserting on a coin flip.
 */

export interface MockBehaviour {
  /** Force a specific failure. */
  readonly failWith?: 'timeout' | 'unavailable' | 'rate_limited' | 'malformed_json';
  /** Fail this many times, then succeed — for exercising retry. */
  readonly failTimes?: number;
  /** Override the reply. */
  readonly replyWith?: string;
  /** Force moderation to flag these categories. */
  readonly flagCategories?: readonly ModerationCategory[];
  readonly latencyMs?: number;
}

export interface MockProviderOptions {
  readonly behaviour?: MockBehaviour;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Words that make the mock flag content, so safety paths can be exercised
 * end to end without a model. Chosen to be unmistakable in a test, and never
 * to appear in ordinary child speech by accident.
 */
const TRIGGER_WORDS: Readonly<Record<string, ModerationCategory>> = {
  __unsafe__: 'violence',
  __selfharm__: 'self_harm',
  __disclosure__: 'disclosure_of_harm',
  __distress__: 'distress_signal',
  __injection__: 'prompt_injection',
  __pii__: 'personal_data_request',
};

export const createMockProvider = (options: MockProviderOptions = {}): AIProvider => {
  const behaviour = options.behaviour ?? {};
  const sleep =
    options.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));

  let remainingFailures = behaviour.failTimes ?? 0;

  const maybeFail = (operation: string): void => {
    const shouldFail =
      behaviour.failWith !== undefined &&
      (behaviour.failTimes === undefined || remainingFailures > 0);

    if (!shouldFail) return;
    if (behaviour.failTimes !== undefined) remainingFailures -= 1;

    switch (behaviour.failWith) {
      case 'timeout':
        throw new ProviderTimeoutError(operation, 1);
      case 'rate_limited':
        throw Object.assign(new Error('rate limited'), { status: 429 });
      case 'malformed_json':
        // Not a transport failure — the call succeeds and returns a shape the
        // caller must survive. Handled where the response is built.
        return;
      case 'unavailable':
      default:
        throw new ProviderUnavailableError(operation);
    }
  };

  const triggersIn = (text: string): ModerationCategory[] =>
    Object.entries(TRIGGER_WORDS)
      .filter(([word]) => text.toLowerCase().includes(word))
      .map(([, category]) => category);

  return {
    name: 'mock',
    conversationModel: 'mock-conversation-v1',
    classifierModel: 'mock-classifier-v1',

    generateResponse: async (request: GenerateRequest): Promise<GenerateResult> => {
      if (behaviour.latencyMs !== undefined) await sleep(behaviour.latencyMs);
      maybeFail('generateResponse');

      // Echoes a marker the engine's own tests assert on, and deliberately
      // includes the name placeholder so substitution is exercised on the
      // default path rather than only in a dedicated test.
      const text =
        behaviour.replyWith ??
        `That sounds lovely, {{name}}! Tell me more about ${request.utterance.slice(0, 40)}.`;

      const inputTokens = Math.ceil(
        (request.context.systemPrompt.length +
          request.context.history.reduce((n, m) => n + m.text.length, 0) +
          request.utterance.length) /
          3.5,
      );

      return {
        text,
        usage: {
          inputTokens,
          outputTokens: Math.ceil(text.length / 3.5),
          estimatedCostUsd: 0,
        },
        model: 'mock-conversation-v1',
        truncated: false,
      };
    },

    generateStructuredResponse: async (request: StructuredRequest): Promise<StructuredResult> => {
      if (behaviour.latencyMs !== undefined) await sleep(behaviour.latencyMs);
      maybeFail('generateStructuredResponse');

      if (behaviour.failWith === 'malformed_json') {
        // The caller must survive a provider that claims schema conformance and
        // does not deliver it. Model output is input, never truth.
        return {
          value: { unexpected: 'shape' },
          usage: { inputTokens: 10, outputTokens: 5, estimatedCostUsd: 0 },
          model: 'mock-classifier-v1',
        };
      }

      return {
        value: { schema: request.schemaName, ok: true },
        usage: { inputTokens: 10, outputTokens: 5, estimatedCostUsd: 0 },
        model: 'mock-classifier-v1',
      };
    },

    moderateContent: async (request: ModerationRequest): Promise<ModerationResult> => {
      if (behaviour.latencyMs !== undefined) await sleep(behaviour.latencyMs);
      maybeFail('moderateContent');

      const categories = behaviour.flagCategories ?? triggersIn(request.text);
      const escalating: readonly ModerationCategory[] = [
        'disclosure_of_harm',
        'distress_signal',
        'self_harm',
      ];

      return {
        flagged: categories.length > 0,
        categories,
        confidence: categories.length > 0 ? 0.95 : 0.02,
        requiresEscalation: categories.some((c) => escalating.includes(c)),
      };
    },

    detectLanguage: async (request: DetectLanguageRequest): Promise<DetectLanguageResult> => {
      maybeFail('detectLanguage');

      // Crude but deterministic: Arabic-script ranges cover Urdu, Arabic,
      // Sindhi, and Pashto, which is enough to exercise the code-switching path.
      const hasArabicScript = /[؀-ۿ]/.test(request.text);
      const hasLatin = /[a-z]/i.test(request.text);
      const preferred = request.candidates[0] ?? 'en';

      const detected = hasArabicScript
        ? (request.candidates.find((c) => c !== 'en') ?? preferred)
        : preferred;

      return {
        language: detected,
        confidence: hasArabicScript && hasLatin ? 0.6 : 0.9,
        mixed: hasArabicScript && hasLatin,
      };
    },
  };
};
