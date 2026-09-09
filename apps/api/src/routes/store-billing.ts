import {
  isMobileStore,
  StoreNotificationError,
  type StoreBillingProvider,
  type MobileStore,
} from '@kids/payments';
import { notFound } from '@kids/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { auditOrFail, type AuditLogger } from '../audit.js';
import type { StoreBilling } from '../store-billing.js';

/**
 * Mobile store billing.
 *
 *   GET  /api/store/status                 what the store says this family has
 *   POST /api/store/verify                 a device presenting a purchase token
 *   POST /api/store/restore                the same, for several at once
 *   POST /api/store/notifications/:store   a store telling us something changed
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LOOK AT THE REQUEST SCHEMAS. THERE IS NOWHERE TO PUT A STATUS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `verify` accepts a store name and an opaque token. It does not accept
 * `isActive`, `expiresAt`, `productId`, `price`, or anything else a device
 * might believe about its own subscription — and because the schemas are
 * `.strict()`, sending one is a validation error rather than a silently ignored
 * field that some future refactor starts reading.
 *
 * That is the whole defence, and it lives in the type rather than in a habit.
 */

export interface StoreBillingRoutesOptions {
  readonly billing: StoreBilling;
  readonly providers: ReadonlyMap<MobileStore, StoreBillingProvider>;
  readonly audit: AuditLogger;
}

const receiptSchema = z
  .object({
    store: z.enum(['apple_iap', 'google_play']),
    /**
     * The opaque token from the store SDK.
     *
     * Bounded generously — Apple's and Google's tokens differ in length and
     * both have grown over time — but bounded, because an unbounded string
     * from an unauthenticated-ish source is a memory question.
     */
    token: z.string().min(8).max(8_192),
    /** A hint for diagnostics when verification fails. Never trusted. */
    productIdHint: z.string().max(120).optional(),
  })
  .strict();

const statusSchema = z.object({
  entitled: z.boolean(),
  state: z.string(),
  planCode: z.string().nullable(),
  expiresAt: z.string().nullable(),
  store: z.string().nullable(),
  autoRenewing: z.boolean(),
  /** What this means for the family, in a sentence they can act on. */
  explanation: z.string(),
});

/**
 * What a store state means to a parent.
 *
 * Written on the server so the iOS app, the Android app, and a support agent
 * reading the API all say the same thing. Neither store's own vocabulary
 * reaches a person: "on hold" and "billing retry" mean nothing to anybody who
 * has not read the documentation.
 */
const explain = (state: string, entitled: boolean): string => {
  switch (state) {
    case 'active':
      return 'Your subscription is active. It renews through the app store you bought it from.';
    case 'trial':
      return 'Your free trial is running. You have not been charged yet.';
    case 'grace_period':
      return 'The app store could not take your last payment and is trying again. Nothing has been switched off — your family keeps full access meanwhile.';
    case 'on_hold':
      return 'The app store could not take payment. Update your payment details in the store and everything comes straight back.';
    case 'paused':
      return 'You paused this subscription in the app store. Resume it there whenever you like.';
    case 'cancelled':
      return 'Your subscription will not renew. You keep everything until the end of the period you have already paid for.';
    case 'expired':
      return 'Your subscription has ended. Your family is on the free plan, and nothing has been deleted.';
    case 'refunded':
      return 'This purchase was refunded. Your family is on the free plan, and nothing has been deleted.';
    case 'none':
      return 'No app store subscription is linked to this account.';
    default:
      return entitled ? 'Your subscription is active.' : 'No active app store subscription.';
  }
};

const REJECTION_MESSAGE: Record<string, string> = {
  invalid_token: 'The app store did not recognise that purchase.',
  wrong_application: 'That purchase belongs to a different app.',
  wrong_environment: 'That purchase came from a test environment and cannot be used here.',
  // Deliberately vague to the caller. Telling somebody the purchase belongs to
  // another account confirms that the token they are holding is a real, live
  // subscription — which is useful only to whoever should not have it.
  owned_by_another_account: 'That purchase is already linked to another account.',
  store_unavailable: 'We could not reach the app store. Nothing has changed — please try again.',
  not_configured: 'App store purchases are not available at the moment.',
};

export const storeBillingRoutes =
  (options: StoreBillingRoutesOptions): FastifyPluginAsyncZod =>
  async (app) => {
    const { billing, providers, audit } = options;

    /* ---------------------------------------------------------------------- */
    /* GET /api/store/status                                                  */
    /* ---------------------------------------------------------------------- */

    app.get(
      '/store/status',
      {
        onRequest: [app.authenticate],
        preHandler: [app.authorize('account:read_own')],
        schema: {
          description: 'The store subscription this account has, as the store reports it.',
          response: { 200: statusSchema },
        },
      },
      async (request, reply) => {
        const parentId = request.principal?.parentId;
        if (parentId === undefined) throw notFound();

        const current = await billing.entitlement(parentId);
        return await reply.status(200).send({
          ...current,
          explanation: explain(current.state, current.entitled),
        });
      },
    );

    /* ---------------------------------------------------------------------- */
    /* POST /api/store/verify                                                 */
    /* ---------------------------------------------------------------------- */

    app.post(
      '/store/verify',
      {
        onRequest: [app.authenticate],
        preHandler: [app.authorize('billing:manage_own')],
        schema: {
          description:
            'Presents a store purchase token. The server asks the store; the store decides.',
          body: receiptSchema,
          response: {
            200: z.object({
              entitled: z.boolean(),
              state: z.string(),
              planCode: z.string().nullable(),
              expiresAt: z.string().nullable(),
              explanation: z.string(),
            }),
            402: z.object({ entitled: z.literal(false), reason: z.string(), message: z.string() }),
          },
        },
        config: {
          // Bounded. Verification costs a call to a store we do not control,
          // and a loop of retries from a broken client should not become a
          // denial of service against our own store quota.
          rateLimit: { max: 30, timeWindow: '15 minutes' },
        },
      },
      async (request, reply) => {
        const parentId = request.principal?.parentId;
        if (parentId === undefined) throw notFound();

        const outcome = await billing.verify(parentId, {
          store: request.body.store,
          token: request.body.token,
          ...(request.body.productIdHint === undefined
            ? {}
            : { productIdHint: request.body.productIdHint }),
        });

        if (outcome.kind === 'rejected') {
          // 402, not 400: the request was well formed and the answer is about
          // payment. A 400 would make clients retry it as a bug.
          return await reply.status(402).send({
            entitled: false as const,
            reason: outcome.reason,
            message: REJECTION_MESSAGE[outcome.reason] ?? REJECTION_MESSAGE.store_unavailable!,
          });
        }

        if (outcome.kind === 'not_entitled') {
          return await reply.status(200).send({
            entitled: false,
            state: outcome.state,
            planCode: null,
            expiresAt: null,
            explanation: explain(outcome.state, false),
          });
        }

        return await reply.status(200).send({
          entitled: true,
          state: outcome.state,
          planCode: outcome.planCode,
          expiresAt: outcome.expiresAt,
          explanation: explain(outcome.state, true),
        });
      },
    );

    /* ---------------------------------------------------------------------- */
    /* POST /api/store/restore                                                */
    /* ---------------------------------------------------------------------- */
    /* A reinstall, a new device, a parent who signed in again. The store hands
     * the app whatever that store account owns, and every one of them goes
     * through the SAME verification — restore is not a lenient path, because a
     * lenient restore is an unverified purchase endpoint by another name. */

    app.post(
      '/store/restore',
      {
        onRequest: [app.authenticate],
        preHandler: [app.authorize('billing:manage_own')],
        schema: {
          description: 'Re-presents purchases the device already holds. Verified like any other.',
          body: z.object({ receipts: z.array(receiptSchema).min(1).max(20) }).strict(),
          response: {
            200: z.object({
              restored: z.number().int(),
              entitled: z.boolean(),
              state: z.string(),
              planCode: z.string().nullable(),
              explanation: z.string(),
            }),
          },
        },
        config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
      },
      async (request, reply) => {
        const parentId = request.principal?.parentId;
        if (parentId === undefined) throw notFound();

        const result = await billing.restore(
          parentId,
          request.body.receipts.map((receipt) => ({
            store: receipt.store,
            token: receipt.token,
            ...(receipt.productIdHint === undefined
              ? {}
              : { productIdHint: receipt.productIdHint }),
          })),
        );

        const current = await billing.entitlement(parentId);

        return await reply.status(200).send({
          restored: result.restored,
          entitled: current.entitled,
          state: current.state,
          planCode: current.planCode,
          explanation:
            result.restored === 0 && !current.entitled
              ? 'We could not find an active subscription for this app store account.'
              : explain(current.state, current.entitled),
        });
      },
    );

    /* ---------------------------------------------------------------------- */
    /* POST /api/store/notifications/:store                                   */
    /* ---------------------------------------------------------------------- */

    await app.register(async (scope) => {
      // Raw bytes, scoped to this route. A body that has been parsed and
      // re-serialised no longer matches what the store signed.
      scope.removeContentTypeParser(['application/json']);
      scope.addContentTypeParser(
        ['application/json', 'application/json; charset=utf-8', '*'],
        { parseAs: 'buffer' },
        (_request, body, done) => {
          done(null, body);
        },
      );

      scope.post(
        '/store/notifications/:store',
        {
          // No session. A store has none — the signature is the authentication.
          schema: {
            description:
              'Server-to-server notification. Authenticated by signature; the payload is never acted on directly.',
            params: z.object({ store: z.string().min(2).max(20) }),
            response: {
              200: z.object({ received: z.literal(true), outcome: z.string() }),
              400: z.object({ received: z.literal(false), reason: z.string() }),
            },
          },
          config: { rateLimit: { max: 600, timeWindow: '1 minute' } },
        },
        async (request, reply) => {
          const storeName = (request.params as { store: string }).store;

          if (!isMobileStore(storeName)) {
            return await reply.status(400).send({ received: false, reason: 'unknown_store' });
          }

          const provider = providers.get(storeName);
          if (!provider) {
            return await reply.status(400).send({ received: false, reason: 'store_unavailable' });
          }

          const raw = Buffer.isBuffer(request.body)
            ? new Uint8Array(request.body)
            : new Uint8Array(0);

          let notification;
          try {
            notification = await provider.verifyNotification(
              raw,
              request.headers as Record<string, string | undefined>,
            );
          } catch (error) {
            const reason = error instanceof StoreNotificationError ? error.reason : 'unverifiable';

            /* Not written to `store_notifications`. The table is keyed on
             * (store, notification_id), so a forgery posted under a real id
             * would make the genuine delivery look like a duplicate. A forged
             * notification must not be able to suppress a real one. */
            await auditOrFail(
              audit,
              {
                actorType: 'system',
                action: 'webhook.rejected',
                resourceType: 'store_notification',
                outcome: 'denied',
                metadata: { store: storeName, reason },
              },
              request,
            );

            request.log.warn({ store: storeName, reason }, 'store notification rejected');
            return await reply.status(400).send({ received: false, reason });
          }

          try {
            const outcome = await billing.handleNotification(
              notification.store,
              notification.notificationId,
              notification.kind,
              notification.originalTransactionId,
              notification.occurredAt,
              notification.environment,
              notification.payload,
            );

            // 200 for every processed outcome. Both stores retry, and both
            // eventually escalate an endpoint that keeps failing — taking the
            // notifications that DO matter with it.
            return await reply.status(200).send({ received: true, outcome });
          } catch (error) {
            request.log.error({ err: error, store: storeName }, 'store notification failed');
            throw error;
          }
        },
      );
    });
  };
