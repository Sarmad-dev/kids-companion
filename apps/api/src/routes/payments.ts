import { describeRegistry, WebhookVerificationError, type RailRegistry } from '@kids/payments';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { auditOrFail, type AuditLogger } from '../audit.js';
import type { PaymentStore } from '../payment-store.js';

/**
 * Payment rail callbacks.
 *
 *   GET  /api/payments/rails              which rails can take a payment
 *   POST /api/payments/webhook/:rail      a rail telling us what happened
 *
 * Deliberately a separate file from `subscriptions.ts`. These endpoints are
 * about money moving; those are about entitlement. A callback handled here may
 * or may not change a subscription, and the decision is made afterwards, by
 * different code, from the payment record.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ROUTES EXIST WHETHER OR NOT ANY RAIL IS ENABLED.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * With no rails configured, `/rails` returns an empty list and the webhook
 * returns 400 for every rail. Neither errors, and nothing else in the
 * application notices — which is the point. A children's app must not fall over
 * because a payment integration is unfinished.
 */

export interface PaymentRoutesOptions {
  /** The webhook burst ceiling. See RATE_LIMIT_WEBHOOK_PER_MINUTE. */
  readonly webhookRateLimitPerMinute: number;
  readonly registry: RailRegistry;
  readonly payments: PaymentStore;
  readonly audit: AuditLogger;
}

export const paymentRoutes =
  (options: PaymentRoutesOptions): FastifyPluginAsyncZod =>
  async (app) => {
    const { registry, payments, audit } = options;

    /* ---------------------------------------------------------------------- */
    /* GET /api/payments/rails                                                */
    /* ---------------------------------------------------------------------- */
    /* What a client needs to render a payment method chooser, and what an
     * operator needs to answer "which rails are live, and is any of them
     * running on an unverified integration?" without reading configuration.
     *
     * `verified` is reported honestly. A rail in sandbox mode, or one whose
     * wire format has not been checked, says so. */

    app.get(
      '/payments/rails',
      {
        onRequest: [app.authenticate],
        preHandler: [app.authorize('account:read_own')],
        schema: {
          description: 'Payment rails that can currently take a payment.',
          response: {
            200: z.object({
              available: z.boolean(),
              items: z.array(
                z.object({
                  rail: z.string(),
                  mode: z.string(),
                  verified: z.boolean(),
                  supportsRefunds: z.boolean(),
                  supportsRecurring: z.boolean(),
                  currencies: z.array(z.string()),
                }),
              ),
              note: z.string(),
            }),
          },
        },
      },
      async (_request, reply) =>
        await reply.status(200).send({
          available: registry.anyAvailable(),
          items: registry.available().map((adapter) => ({
            rail: adapter.rail,
            mode: adapter.mode,
            verified: describeRegistry(registry).some(
              (entry) => entry.rail === adapter.rail && entry.verified,
            ),
            supportsRefunds: adapter.capabilities.refunds !== 'none',
            supportsRecurring: adapter.capabilities.recurring !== 'none',
            currencies: [...adapter.capabilities.currencies],
          })),
          note: registry.anyAvailable()
            ? 'Refund availability differs by rail. Some rails cannot return money at all.'
            : 'No payment method is available at the moment. Everything else in the app works as usual, on the free plan.',
        }),
    );

    /* ---------------------------------------------------------------------- */
    /* POST /api/payments/webhook/:rail                                       */
    /* ---------------------------------------------------------------------- */

    await app.register(async (scope) => {
      // Raw bytes, scoped to this route. A body that has been parsed and
      // re-serialised no longer matches the signature the rail computed.
      scope.removeContentTypeParser(['application/json']);
      scope.addContentTypeParser(
        ['application/json', 'application/json; charset=utf-8', '*'],
        { parseAs: 'buffer' },
        (_request, body, done) => {
          done(null, body);
        },
      );

      scope.post(
        '/payments/webhook/:rail',
        {
          // No session. A rail has none — the signature is the authentication.
          schema: {
            description: 'Payment rail callback. Authenticated by signature, not by session.',
            params: z.object({ rail: z.string().min(2).max(24) }),
            response: {
              200: z.object({ received: z.literal(true), outcome: z.string() }),
              400: z.object({ received: z.literal(false), reason: z.string() }),
            },
          },
          config: {
            // Generous, because a rail catching up after an outage delivers in
            // bursts and failing a legitimate backlog is worse than the load.
            rateLimit: { max: options.webhookRateLimitPerMinute, timeWindow: '1 minute' },
          },
        },
        async (request, reply) => {
          const railName = (request.params as { rail: string }).rail;
          const adapter = registry.get(railName);

          if (!adapter) {
            // Covers both "no rails at all" and "not this one". The caller
            // learns nothing about which, and neither is an error worth a 5xx.
            request.log.warn({ rail: railName }, 'callback for an unavailable rail');
            return await reply.status(400).send({ received: false, reason: 'rail_unavailable' });
          }

          const raw = Buffer.isBuffer(request.body)
            ? new Uint8Array(request.body)
            : new Uint8Array(0);

          let callback;
          try {
            callback = await adapter.verifyCallback(
              raw,
              request.headers as Record<string, string | undefined>,
            );
          } catch (error) {
            const reason =
              error instanceof WebhookVerificationError ? error.reason : 'unverifiable';

            /* Not written to `payment_events`. That table is keyed on
             * (rail, external_event_id), so a forgery posted under a real event
             * id would make the genuine delivery look like a duplicate. A
             * forged callback must not be able to suppress a real one. */
            await auditOrFail(
              audit,
              {
                actorType: 'system',
                action: 'webhook.rejected',
                resourceType: 'payment_event',
                outcome: 'denied',
                metadata: { rail: railName, reason },
              },
              request,
            );

            request.log.warn({ rail: railName, reason }, 'payment callback rejected');
            return await reply.status(400).send({ received: false, reason });
          }

          try {
            const outcome = await payments.applyCallback(
              callback.rail,
              callback.externalEventId,
              callback.reference,
              callback.result,
              callback.payload,
            );

            // 200 for every processed outcome, including one about a payment we
            // do not have. A 4xx makes the rail retry something that will never
            // apply, and most rails eventually disable an endpoint that keeps
            // failing — taking the callbacks that DO matter with it.
            return await reply.status(200).send({ received: true, outcome });
          } catch (error) {
            request.log.error({ err: error, rail: railName }, 'payment callback failed');
            throw error;
          }
        },
      );
    });
  };
