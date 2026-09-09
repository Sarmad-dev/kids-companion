import { ProviderUnavailableError } from '@kids/shared';

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
 * Google, through the Gemini API (`generativelanguage.googleapis.com`).
 *
 * Added for the same reason the mock exists: so the whole loop can be exercised
 * end to end without a bill. The Gemini API has a genuine free tier, and the
 * default models here — see `GOOGLE_FREE_TIER_MODELS` — are the ones on it, so
 * a developer with nothing but a free AI Studio key can run real inference
 * against a real vendor rather than against a canned string.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE KEY GOES IN A HEADER, NOT THE QUERY STRING
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every Gemini example puts the API key in `?key=…`. That URL then lands in
 * proxy logs, in error messages that quote the request, and in anything that
 * records an outbound URL. `x-goog-api-key` is accepted for the same call and
 * keeps the credential out of all of them (SECURITY.md §4.1).
 *
 * ⚠️ NOT YET EXERCISED AGAINST THE LIVE API — the same caveat the other
 * adapters carry. Run the contract suite with a real key before deploying.
 */

/**
 * Models available on the Gemini API free tier at time of writing.
 *
 * Kept as data rather than baked into the adapter because a free tier is a
 * commercial decision that changes without a code release: both are overridable
 * through `AI_MODEL_CONVERSATION` and `AI_MODEL_SAFETY_CLASSIFIER`, so a
 * renamed or retired model is a config change, not a deploy.
 */
export const GOOGLE_FREE_TIER_MODELS = {
  conversation: 'gemini-2.5-flash',
  classifier: 'gemini-2.5-flash-lite',
} as const;

export interface GoogleProviderOptions {
  readonly apiKey: string;
  readonly conversationModel: string;
  readonly classifierModel: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  /** USD per million tokens, for the cost estimate recorded per turn. */
  readonly inputCostPerMTok?: number;
  readonly outputCostPerMTok?: number;
}

interface GoogleResponse {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    finishReason?: string;
  }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  modelVersion?: string;
  promptFeedback?: { blockReason?: string };
}

interface GoogleContent {
  role: 'user' | 'model';
  parts: { text: string }[];
}

export const createGoogleProvider = (options: GoogleProviderOptions): AIProvider => {
  const baseUrl = (options.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta').replace(
    /\/$/,
    '',
  );

  /**
   * Deliberately NON-ZERO even though the default models are free-tier.
   *
   * `AI_DAILY_COST_CEILING_USD` is enforced against the per-turn estimate. An
   * adapter that reported zero would make that ceiling inert, so the day
   * someone points this provider at a paid-tier key there would be nothing
   * standing between a loop and the bill. These are order-of-magnitude list
   * rates for the flash tier; set the cost env vars for accuracy.
   */
  const rates: CostRates = {
    inputPerMTok: options.inputCostPerMTok ?? 0.3,
    outputPerMTok: options.outputCostPerMTok ?? 2.5,
  };

  const call = async (
    operation: string,
    model: string,
    body: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<GoogleResponse> =>
    await postJson<GoogleResponse>(operation, {
      url: `${baseUrl}/models/${model}:generateContent`,
      headers: { 'x-goog-api-key': options.apiKey },
      body,
      timeoutMs,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });

  const textOf = (response: GoogleResponse): string =>
    (response.candidates?.[0]?.content?.parts ?? [])
      .map((part) => part.text ?? '')
      .join('')
      .trim();

  const usageFrom = (response: GoogleResponse): TokenUsage =>
    usageOf(
      response.usageMetadata?.promptTokenCount ?? 0,
      response.usageMetadata?.candidatesTokenCount ?? 0,
      rates,
    );

  /**
   * Our roles mapped to the vendor's, with two Gemini-specific rules applied.
   *
   * The assistant is `model`, not `assistant`. And `contents` must OPEN with a
   * user turn: a window that happens to begin with the companion speaking — a
   * story seeded by the app, most obviously — is rejected outright rather than
   * merely answered oddly. Leading companion turns are therefore dropped, which
   * costs one line of context and is the difference between a working turn and
   * a 400.
   */
  const toContents = (
    history: readonly { role: 'child' | 'companion'; text: string }[],
    utterance?: string,
  ): GoogleContent[] => {
    const firstChild = history.findIndex((m) => m.role === 'child');
    const usable = firstChild === -1 ? [] : history.slice(firstChild);

    const contents: GoogleContent[] = usable.map((m) => ({
      role: m.role === 'child' ? ('user' as const) : ('model' as const),
      parts: [{ text: m.text }],
    }));
    if (utterance !== undefined) contents.push({ role: 'user', parts: [{ text: utterance }] });
    return contents;
  };

  const systemInstruction = (text: string) => ({ parts: [{ text }] });

  return {
    name: 'google',
    conversationModel: options.conversationModel,
    classifierModel: options.classifierModel,

    generateResponse: async (request: GenerateRequest): Promise<GenerateResult> => {
      const response = await call(
        'generateResponse',
        options.conversationModel,
        {
          systemInstruction: systemInstruction(request.context.systemPrompt),
          contents: toContents(request.context.history, request.utterance),
          generationConfig: {
            maxOutputTokens: request.maxOutputTokens,
            temperature: request.temperature,
          },
        },
        request.timeoutMs,
      );

      const text = textOf(response);

      /**
       * ═══════════════════════════════════════════════════════════════════
       * AN EMPTY CANDIDATE IS TREATED AS AN OUTAGE, NOT AS A REPLY
       * ═══════════════════════════════════════════════════════════════════
       *
       * Gemini runs its own safety filters, and when they fire it answers 200
       * with no candidate — or a candidate carrying no parts — rather than an
       * error. Returning that verbatim would hand the engine an empty string,
       * which becomes a character that says nothing to a child who just spoke.
       *
       * Raising instead puts it down the path already built for a vendor
       * problem: the engine degrades and the character says something warm.
       * That is the right outcome either way, because our own L1 and L3 checks
       * have already run — anything Gemini stops on top of them is a turn we
       * cannot complete, not a turn we should complete silently.
       */
      if (text === '') {
        throw new ProviderUnavailableError(
          'generateResponse',
          new Error(
            `gemini returned no usable candidate (finishReason=${
              response.candidates?.[0]?.finishReason ?? 'none'
            }, blockReason=${response.promptFeedback?.blockReason ?? 'none'})`,
          ),
        );
      }

      return {
        text,
        usage: usageFrom(response),
        model: response.modelVersion ?? options.conversationModel,
        truncated: response.candidates?.[0]?.finishReason === 'MAX_TOKENS',
      };
    },

    generateStructuredResponse: async (request: StructuredRequest): Promise<StructuredResult> => {
      /**
       * `responseMimeType` without `responseSchema`, on purpose.
       *
       * Gemini's `responseSchema` accepts an OpenAPI subset, not JSON Schema —
       * `additionalProperties` in particular is rejected, and our own
       * classifier schema sets it. Handing it an arbitrary caller's schema
       * would turn a validation problem into a 400. Asking for JSON and putting
       * the schema in the instruction gets syntactically valid JSON every time,
       * and the port already requires the CALLER to validate the shape.
       */
      const response = await call(
        'generateStructuredResponse',
        options.classifierModel,
        {
          systemInstruction: systemInstruction(
            `${request.context.systemPrompt}\n\n${schemaInstruction(request.jsonSchema)}`,
          ),
          contents: [{ role: 'user' as const, parts: [{ text: request.instruction }] }],
          generationConfig: {
            maxOutputTokens: request.maxOutputTokens,
            temperature: 0, // determinism matters more than variety for structured output
            responseMimeType: 'application/json',
          },
        },
        request.timeoutMs,
      );

      return {
        value: extractJson(textOf(response)),
        usage: usageFrom(response),
        model: response.modelVersion ?? options.classifierModel,
      };
    },

    moderateContent: async (request: ModerationRequest): Promise<ModerationResult> => {
      const response = await call(
        'moderateContent',
        options.classifierModel,
        {
          systemInstruction: systemInstruction(moderationSystemPrompt(request)),
          contents: [{ role: 'user' as const, parts: [{ text: request.text }] }],
          generationConfig: {
            maxOutputTokens: 256,
            temperature: 0,
            responseMimeType: 'application/json',
          },
        },
        request.timeoutMs,
      );

      // No empty-candidate guard here, and that is the point: Gemini blocking
      // the text it was asked to classify yields no JSON, `extractJson` yields
      // null, and `interpretModeration` fails CLOSED to flagged. Exactly the
      // verdict we want for text a vendor found too unsafe to look at.
      return interpretModeration(extractJson(textOf(response)));
    },

    detectLanguage: async (request: DetectLanguageRequest): Promise<DetectLanguageResult> => {
      const response = await call(
        'detectLanguage',
        options.classifierModel,
        {
          systemInstruction: systemInstruction(detectLanguageSystemPrompt(request)),
          contents: [{ role: 'user' as const, parts: [{ text: request.text }] }],
          generationConfig: {
            maxOutputTokens: 64,
            temperature: 0,
            responseMimeType: 'application/json',
          },
        },
        request.timeoutMs,
      );

      return interpretDetectLanguage(extractJson(textOf(response)), request.candidates);
    },
  };
};
