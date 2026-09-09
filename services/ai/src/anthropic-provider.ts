import type {
  AIProvider,
  DetectLanguageRequest,
  DetectLanguageResult,
  GenerateRequest,
  GenerateResult,
  ModerationRequest,
  ModerationResult,
  StructuredRequest,
  StructuredResult,
  TokenUsage,
} from './ports.js';
import {
  detectLanguageSystemPrompt,
  extractJson,
  interpretDetectLanguage,
  interpretModeration,
  moderationSystemPrompt,
  postJson,
  schemaInstruction,
  usageOf,
  type CostRates,
} from './provider-support.js';

/**
 * The first real provider: Anthropic's Messages API.
 *
 * Every vendor detail is contained here. No Anthropic type appears in the port,
 * the engine, or the API — which is what makes swapping providers a
 * configuration change plus one file (docs/adr/0004).
 *
 * Two models, deliberately: a capable one for conversation, a small fast one for
 * classification. Classification runs twice per turn, on input and output, so
 * using the conversation model for it would roughly triple the cost of every
 * exchange — and cost per conversation is an existential constraint for the
 * launch market (ARCHITECTURE.md C3).
 *
 * ⚠️ NOT YET EXERCISED AGAINST THE LIVE API. The request shapes follow the
 * documented Messages API, but no key has been used, so this is unverified.
 * The contract suite runs against the mock; run it against a real key before
 * deploying.
 */

export interface AnthropicProviderOptions {
  readonly apiKey: string;
  readonly conversationModel: string;
  readonly classifierModel: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  /** USD per million tokens, for the cost estimate recorded per turn. */
  readonly inputCostPerMTok?: number;
  readonly outputCostPerMTok?: number;
}

interface AnthropicResponse {
  content?: { type: string; text?: string }[];
  usage?: { input_tokens?: number; output_tokens?: number };
  model?: string;
  stop_reason?: string;
}

export const createAnthropicProvider = (options: AnthropicProviderOptions): AIProvider => {
  const baseUrl = (options.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '');
  const rates: CostRates = {
    inputPerMTok: options.inputCostPerMTok ?? 3,
    outputPerMTok: options.outputCostPerMTok ?? 15,
  };

  const usageFrom = (response: AnthropicResponse): TokenUsage =>
    usageOf(response.usage?.input_tokens ?? 0, response.usage?.output_tokens ?? 0, rates);

  const textOf = (response: AnthropicResponse): string =>
    (response.content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('')
      .trim();

  const call = async (
    operation: string,
    body: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<AnthropicResponse> =>
    await postJson<AnthropicResponse>(operation, {
      url: `${baseUrl}/v1/messages`,
      headers: { 'x-api-key': options.apiKey, 'anthropic-version': '2023-06-01' },
      body,
      timeoutMs,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });

  /** Our roles mapped to the vendor's. `companion` is the assistant. */
  const toMessages = (
    history: readonly { role: 'child' | 'companion'; text: string }[],
    utterance?: string,
  ): { role: 'user' | 'assistant'; content: string }[] => {
    const messages = history.map((m) => ({
      role: m.role === 'child' ? ('user' as const) : ('assistant' as const),
      content: m.text,
    }));
    if (utterance !== undefined) messages.push({ role: 'user', content: utterance });
    return messages;
  };

  return {
    name: 'anthropic',
    conversationModel: options.conversationModel,
    classifierModel: options.classifierModel,

    generateResponse: async (request: GenerateRequest): Promise<GenerateResult> => {
      const response = await call(
        'generateResponse',
        {
          model: options.conversationModel,
          max_tokens: request.maxOutputTokens,
          temperature: request.temperature,
          system: request.context.systemPrompt,
          messages: toMessages(request.context.history, request.utterance),
        },
        request.timeoutMs,
      );

      return {
        text: textOf(response),
        usage: usageFrom(response),
        model: response.model ?? options.conversationModel,
        truncated: response.stop_reason === 'max_tokens',
      };
    },

    generateStructuredResponse: async (request: StructuredRequest): Promise<StructuredResult> => {
      const response = await call(
        'generateStructuredResponse',
        {
          model: options.classifierModel,
          max_tokens: request.maxOutputTokens,
          temperature: 0, // determinism matters more than variety for structured output
          system: `${request.context.systemPrompt}\n\n${schemaInstruction(request.jsonSchema)}`,
          messages: [{ role: 'user' as const, content: request.instruction }],
        },
        request.timeoutMs,
      );

      // `extractJson` returns null rather than throwing: the CALLER validates,
      // and a caller that treats a parse failure as "unsafe" is the fail-closed
      // behaviour we want. Throwing would look like a provider outage instead.
      return {
        value: extractJson(textOf(response)),
        usage: usageFrom(response),
        model: response.model ?? options.classifierModel,
      };
    },

    moderateContent: async (request: ModerationRequest): Promise<ModerationResult> => {
      const response = await call(
        'moderateContent',
        {
          model: options.classifierModel,
          max_tokens: 256,
          temperature: 0,
          system: moderationSystemPrompt(request),
          messages: [{ role: 'user' as const, content: request.text }],
        },
        request.timeoutMs,
      );

      // FAIL CLOSED, in `interpretModeration`. An unparseable classifier
      // response is treated as flagged, never as safe, and that decision is
      // shared by every adapter rather than reimplemented per vendor
      // (docs/CHILD_SAFETY.md rule S-1).
      return interpretModeration(extractJson(textOf(response)));
    },

    detectLanguage: async (request: DetectLanguageRequest): Promise<DetectLanguageResult> => {
      const response = await call(
        'detectLanguage',
        {
          model: options.classifierModel,
          max_tokens: 64,
          temperature: 0,
          system: detectLanguageSystemPrompt(request),
          messages: [{ role: 'user' as const, content: request.text }],
        },
        request.timeoutMs,
      );

      // Unlike moderation, this fails OPEN — to the child's declared language.
      return interpretDetectLanguage(extractJson(textOf(response)), request.candidates);
    },
  };
};
