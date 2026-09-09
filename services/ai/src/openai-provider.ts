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
 * OpenAI, through the Chat Completions API.
 *
 * `AI_PROVIDER=openai` has been a legal value in the environment schema since
 * before this file existed, and selecting it silently fell through to the mock
 * — a deployment could be configured for OpenAI, boot clean, and answer every
 * child from a canned string. This is the adapter that value always implied.
 *
 * Every vendor detail is contained here; nothing OpenAI-shaped appears in the
 * port, the engine, or the API (docs/adr/0004).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY `max_completion_tokens` RATHER THAN `max_tokens`
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `max_tokens` is deprecated on Chat Completions and rejected outright by the
 * reasoning models. `max_completion_tokens` is accepted by everything current,
 * so it is the one that will still be accepted after the next model swap.
 *
 * ⚠️ NOT YET EXERCISED AGAINST THE LIVE API — the same caveat the Anthropic
 * adapter carries. The request shapes follow the documented API, but no key has
 * been used against them. Run the contract suite with a real key before
 * deploying this provider.
 */

export interface OpenAIProviderOptions {
  readonly apiKey: string;
  readonly conversationModel: string;
  readonly classifierModel: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  /** USD per million tokens, for the cost estimate recorded per turn. */
  readonly inputCostPerMTok?: number;
  readonly outputCostPerMTok?: number;
  /** Sent as `organization`/`project` headers when the account requires them. */
  readonly organization?: string;
  readonly project?: string;
}

interface OpenAIResponse {
  choices?: {
    message?: { content?: string | null };
    finish_reason?: string;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  model?: string;
}

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export const createOpenAIProvider = (options: OpenAIProviderOptions): AIProvider => {
  const baseUrl = (options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  const rates: CostRates = {
    inputPerMTok: options.inputCostPerMTok ?? 0.15,
    outputPerMTok: options.outputCostPerMTok ?? 0.6,
  };

  const headers: Record<string, string> = {
    authorization: `Bearer ${options.apiKey}`,
    ...(options.organization === undefined ? {} : { 'openai-organization': options.organization }),
    ...(options.project === undefined ? {} : { 'openai-project': options.project }),
  };

  const call = async (
    operation: string,
    body: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<OpenAIResponse> =>
    await postJson<OpenAIResponse>(operation, {
      url: `${baseUrl}/chat/completions`,
      headers,
      body,
      timeoutMs,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });

  const textOf = (response: OpenAIResponse): string =>
    (response.choices?.[0]?.message?.content ?? '').trim();

  const usageFrom = (response: OpenAIResponse): TokenUsage =>
    usageOf(response.usage?.prompt_tokens ?? 0, response.usage?.completion_tokens ?? 0, rates);

  /**
   * Our roles mapped to the vendor's, with the system prompt as message zero.
   *
   * OpenAI has no separate `system` field the way Anthropic does — the system
   * prompt is the first message, which is also why it is assembled here rather
   * than shared.
   */
  const toMessages = (
    systemPrompt: string,
    history: readonly { role: 'child' | 'companion'; text: string }[],
    utterance?: string,
  ): OpenAIMessage[] => {
    const messages: OpenAIMessage[] = [{ role: 'system', content: systemPrompt }];
    for (const m of history) {
      messages.push({
        role: m.role === 'child' ? 'user' : 'assistant',
        content: m.text,
      });
    }
    if (utterance !== undefined) messages.push({ role: 'user', content: utterance });
    return messages;
  };

  return {
    name: 'openai',
    conversationModel: options.conversationModel,
    classifierModel: options.classifierModel,

    generateResponse: async (request: GenerateRequest): Promise<GenerateResult> => {
      const response = await call(
        'generateResponse',
        {
          model: options.conversationModel,
          max_completion_tokens: request.maxOutputTokens,
          temperature: request.temperature,
          messages: toMessages(
            request.context.systemPrompt,
            request.context.history,
            request.utterance,
          ),
        },
        request.timeoutMs,
      );

      return {
        text: textOf(response),
        usage: usageFrom(response),
        model: response.model ?? options.conversationModel,
        truncated: response.choices?.[0]?.finish_reason === 'length',
      };
    },

    generateStructuredResponse: async (request: StructuredRequest): Promise<StructuredResult> => {
      /**
       * The caller's schema is handed to OpenAI's own structured-output
       * feature, which is exactly what the port's `jsonSchema` field exists
       * for. `strict` is deliberately LEFT OFF: strict mode additionally
       * requires `additionalProperties: false` and every property listed in
       * `required`, and a caller whose schema does not satisfy that would get a
       * 400 rather than a slightly loose answer. The port already says the
       * CALLER validates, so best-effort conformance plus caller validation is
       * the correct trade — a rejected request would be a worse outcome than a
       * response that fails validation.
       */
      const response = await call(
        'generateStructuredResponse',
        {
          model: options.classifierModel,
          max_completion_tokens: request.maxOutputTokens,
          temperature: 0, // determinism matters more than variety for structured output
          response_format: {
            type: 'json_schema',
            json_schema: { name: request.schemaName, schema: request.jsonSchema },
          },
          messages: [
            {
              role: 'system',
              content: `${request.context.systemPrompt}\n\n${schemaInstruction(request.jsonSchema)}`,
            },
            { role: 'user', content: request.instruction },
          ],
        },
        request.timeoutMs,
      );

      return {
        value: extractJson(textOf(response)),
        usage: usageFrom(response),
        model: response.model ?? options.classifierModel,
      };
    },

    moderateContent: async (request: ModerationRequest): Promise<ModerationResult> => {
      /**
       * Deliberately the chat model rather than `/v1/moderations`.
       *
       * The dedicated endpoint classifies against OpenAI's taxonomy, not ours,
       * and ours carries categories it has no equivalent for — `distress_signal`
       * and `disclosure_of_harm` are the two that matter most, because they are
       * the ones that route to a human rather than merely blocking a reply.
       * Mapping one taxonomy onto the other would lose exactly the signals the
       * escalation protocol exists for.
       */
      const response = await call(
        'moderateContent',
        {
          model: options.classifierModel,
          max_completion_tokens: 256,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: moderationSystemPrompt(request) },
            { role: 'user', content: request.text },
          ],
        },
        request.timeoutMs,
      );

      return interpretModeration(extractJson(textOf(response)));
    },

    detectLanguage: async (request: DetectLanguageRequest): Promise<DetectLanguageResult> => {
      const response = await call(
        'detectLanguage',
        {
          model: options.classifierModel,
          max_completion_tokens: 64,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: detectLanguageSystemPrompt(request) },
            { role: 'user', content: request.text },
          ],
        },
        request.timeoutMs,
      );

      return interpretDetectLanguage(extractJson(textOf(response)), request.candidates);
    },
  };
};
