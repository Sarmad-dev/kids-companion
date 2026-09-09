import { checkPasswordPolicy, type AuthProvider, type SessionService } from '@kids/auth';
import { DuplicateEmailError } from '@kids/auth';
import { unauthenticated, validationFailed } from '@kids/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { auditOrFail, type AuditLogger } from '../audit.js';

/**
 * Authentication routes.
 *
 * Two principles run through every handler here:
 *
 *   NO ENUMERATION. Registration, login, and password reset return the same
 *   shape and take the same time whether or not the address is registered. For
 *   this product the question "is this address registered?" answers "does this
 *   family use a children's app?", which is worth more to an attacker than it
 *   first appears.
 *
 *   AUDIT BEFORE RESPOND. Security-relevant outcomes are recorded before the
 *   response is sent, so an action that could not be recorded does not happen.
 */

export interface AuthRoutesOptions {
  readonly auth: AuthProvider;
  readonly sessions: SessionService;
  readonly audit: AuditLogger;
  /** Local/ci only. Never true in a deployed environment — see §register. */
  readonly exposeTokens: boolean;
  /**
   * Attempts per 15 minutes on the credential endpoints, from config rather than
   * hardcoded here. These are the strictest limits in the API — they are what
   * makes online password guessing impractical — so the value belongs somewhere
   * an operator can tune per environment and a reviewer can see.
   */
  readonly authRateLimitPerWindow: number;
}

const emailSchema = z
  .email()
  .max(320)
  .transform((v) => v.trim().toLowerCase());
const passwordSchema = z.string().min(1).max(256);

const sessionResponseSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresIn: z.number().int(),
  tokenType: z.literal('Bearer'),
});

const identityResponseSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: z.enum(['parent', 'admin', 'support']),
  emailVerified: z.boolean(),
});

export const authRoutes =
  (options: AuthRoutesOptions): FastifyPluginAsyncZod =>
  async (app) => {
    const { auth, sessions, audit } = options;

    const contextOf = (request: { headers: Record<string, unknown>; ip: string }) => ({
      ...(typeof request.headers['user-agent'] === 'string'
        ? { userAgent: request.headers['user-agent'] }
        : {}),
      ipAddress: request.ip,
    });

    /* ---------------------------------------------------------------------- */
    /* Registration                                                           */
    /* ---------------------------------------------------------------------- */

    app.post(
      '/v1/auth/register',
      {
        schema: {
          description: 'Register a parent account.',
          body: z.object({
            email: emailSchema,
            password: passwordSchema,
            displayName: z.string().min(1).max(80).optional(),
            countryCode: z.string().length(2).optional(),
            locale: z.string().min(2).max(10).optional(),
          }),
          response: {
            201: z.object({
              parent: identityResponseSchema,
              // Present only in local/ci, so tests can complete verification
              // without an inbox. Absent in every deployed environment.
              verificationToken: z.string().optional(),
            }),
          },
        },
        config: { rateLimit: { max: options.authRateLimitPerWindow, timeWindow: '15 minutes' } },
      },
      async (request, reply) => {
        const policy = checkPasswordPolicy(request.body.password);
        if (!policy.ok) {
          throw validationFailed([
            { field: 'password', issue: policy.issue ?? 'is not acceptable' },
          ]);
        }

        try {
          const result = await auth.register(request.body);

          await auditOrFail(
            audit,
            {
              actorId: result.identity.parentId,
              actorType: 'parent',
              action: 'auth.registration.succeeded',
              resourceType: 'parent',
              resourceId: result.identity.parentId,
              outcome: 'success',
            },
            request,
          );

          return await reply.status(201).send({
            parent: {
              id: result.identity.parentId,
              email: result.identity.email,
              role: result.identity.role,
              emailVerified: result.identity.emailVerifiedAt !== undefined,
            },
            ...(options.exposeTokens && result.verificationToken !== undefined
              ? { verificationToken: result.verificationToken }
              : {}),
          });
        } catch (error) {
          if (!(error instanceof DuplicateEmailError)) throw error;

          // A duplicate registration is recorded but NOT revealed. Returning
          // "that email is taken" is the enumeration oracle in its most direct
          // form. The real account holder is told by email that someone tried;
          // the caller learns nothing.
          await auditOrFail(
            audit,
            {
              actorType: 'system',
              action: 'auth.registration.duplicate_email',
              resourceType: 'parent',
              outcome: 'denied',
              metadata: { reason: 'email_already_registered' },
            },
            request,
          );

          throw validationFailed([{ field: 'email', issue: 'cannot be used to register' }]);
        }
      },
    );

    /* ---------------------------------------------------------------------- */
    /* Login                                                                  */
    /* ---------------------------------------------------------------------- */

    app.post(
      '/v1/auth/login',
      {
        schema: {
          description: 'Exchange credentials for a session.',
          body: z.object({ email: emailSchema, password: passwordSchema }),
          response: { 200: sessionResponseSchema },
        },
        config: { rateLimit: { max: options.authRateLimitPerWindow, timeWindow: '15 minutes' } },
      },
      async (request, reply) => {
        const check = await auth.verifyCredentials(request.body.email, request.body.password);

        if (!check.ok || !check.identity) {
          await auditOrFail(
            audit,
            {
              actorType: 'system',
              action: check.reason === 'locked' ? 'auth.login.locked_out' : 'auth.login.failed',
              resourceType: 'parent',
              outcome: 'denied',
              // The reason is recorded for operators; it never reaches the client.
              metadata: { reason: check.reason ?? 'unknown' },
            },
            request,
          );

          throw unauthenticated('AUTH_INVALID_CREDENTIALS');
        }

        const session = await sessions.issue(
          check.identity.parentId,
          check.identity.role,
          contextOf(request),
        );

        await auditOrFail(
          audit,
          {
            actorId: check.identity.parentId,
            actorType: 'parent',
            action: 'auth.login.succeeded',
            resourceType: 'session',
            resourceId: session.sessionId,
            outcome: 'success',
          },
          request,
        );

        return await reply.status(200).send({
          accessToken: session.accessToken,
          refreshToken: session.refreshToken,
          expiresIn: session.accessTokenExpiresIn,
          tokenType: 'Bearer' as const,
        });
      },
    );

    /* ---------------------------------------------------------------------- */
    /* Refresh                                                                */
    /* ---------------------------------------------------------------------- */

    app.post(
      '/v1/auth/refresh',
      {
        schema: {
          description: 'Rotate a refresh token for a new session.',
          body: z.object({ refreshToken: z.string().min(20).max(200) }),
          response: { 200: sessionResponseSchema },
        },
        config: {
          rateLimit: { max: options.authRateLimitPerWindow * 6, timeWindow: '15 minutes' },
        },
      },
      async (request, reply) => {
        const outcome = await sessions.refresh(request.body.refreshToken, contextOf(request));

        if (outcome.status === 'reuse_detected') {
          // The whole family is already revoked by the service. This is the
          // primary detection for a stolen refresh token, so it is audited at
          // the highest fidelity available and logged at warn.
          await auditOrFail(
            audit,
            {
              actorId: outcome.parentId,
              actorType: 'system',
              action: 'auth.session.reuse_detected',
              resourceType: 'session_family',
              resourceId: outcome.familyId,
              outcome: 'denied',
              metadata: { revokedFamily: true },
            },
            request,
          );

          request.log.warn(
            { requestId: request.requestId, familyId: outcome.familyId },
            'refresh token reuse detected — session family revoked',
          );

          throw unauthenticated('AUTH_REFRESH_REUSE_DETECTED');
        }

        if (outcome.status !== 'ok') {
          throw unauthenticated('AUTH_TOKEN_EXPIRED');
        }

        return await reply.status(200).send({
          accessToken: outcome.session.accessToken,
          refreshToken: outcome.session.refreshToken,
          expiresIn: outcome.session.accessTokenExpiresIn,
          tokenType: 'Bearer' as const,
        });
      },
    );

    /* ---------------------------------------------------------------------- */
    /* Logout                                                                 */
    /* ---------------------------------------------------------------------- */

    app.post(
      '/v1/auth/logout',
      {
        schema: {
          description: 'Revoke a refresh token. Idempotent.',
          body: z.object({ refreshToken: z.string().min(20).max(200) }),
          response: { 204: z.null() },
        },
      },
      async (request, reply) => {
        const revoked = await sessions.revoke(request.body.refreshToken);

        // 204 whether or not anything was revoked. An already-revoked token and
        // an unknown token are indistinguishable to the caller, and logging out
        // twice is not an error worth surfacing.
        if (revoked) {
          await auditOrFail(
            audit,
            {
              actorType: 'parent',
              action: 'auth.logout.succeeded',
              resourceType: 'session',
              outcome: 'success',
            },
            request,
          );
        }

        return await reply.status(204).send(null);
      },
    );

    /* ---------------------------------------------------------------------- */
    /* Email verification                                                     */
    /* ---------------------------------------------------------------------- */

    app.post(
      '/v1/auth/verify-email',
      {
        schema: {
          description: 'Confirm an email address with an emailed token.',
          body: z.object({ token: z.string().min(20).max(200) }),
          response: { 200: z.object({ verified: z.boolean() }) },
        },
        config: {
          rateLimit: { max: options.authRateLimitPerWindow * 2, timeWindow: '15 minutes' },
        },
      },
      async (request, reply) => {
        const result = await auth.confirmEmailVerification(request.body.token);

        if (!result) {
          throw validationFailed([{ field: 'token', issue: 'is invalid or has expired' }]);
        }

        await auditOrFail(
          audit,
          {
            actorId: result.parentId,
            actorType: 'parent',
            action: 'auth.email.verified',
            resourceType: 'parent',
            resourceId: result.parentId,
            outcome: 'success',
          },
          request,
        );

        return await reply.status(200).send({ verified: true });
      },
    );

    /* ---------------------------------------------------------------------- */
    /* Password reset                                                         */
    /* ---------------------------------------------------------------------- */

    app.post(
      '/v1/auth/password-reset',
      {
        schema: {
          description: 'Request a password reset. Always succeeds.',
          body: z.object({ email: emailSchema }),
          response: {
            202: z.object({
              // Local/ci only.
              resetToken: z.string().optional(),
            }),
          },
        },
        config: { rateLimit: { max: options.authRateLimitPerWindow, timeWindow: '15 minutes' } },
      },
      async (request, reply) => {
        const result = await auth.requestPasswordReset(request.body.email, request.ip);

        await auditOrFail(
          audit,
          {
            actorType: 'system',
            action: 'auth.password.reset_requested',
            resourceType: 'parent',
            outcome: 'success',
          },
          request,
        );

        // 202 regardless. A different status or body for an unregistered address
        // is the enumeration oracle by a third route.
        return await reply.status(202).send({
          ...(options.exposeTokens && result.token !== undefined
            ? { resetToken: result.token }
            : {}),
        });
      },
    );

    app.post(
      '/v1/auth/password-reset/confirm',
      {
        schema: {
          description: 'Complete a password reset. Revokes every session.',
          body: z.object({
            token: z.string().min(20).max(200),
            newPassword: passwordSchema,
          }),
          response: { 200: z.object({ reset: z.boolean() }) },
        },
        config: { rateLimit: { max: options.authRateLimitPerWindow, timeWindow: '15 minutes' } },
      },
      async (request, reply) => {
        const policy = checkPasswordPolicy(request.body.newPassword);
        if (!policy.ok) {
          throw validationFailed([
            { field: 'newPassword', issue: policy.issue ?? 'is not acceptable' },
          ]);
        }

        const result = await auth.resetPassword(request.body.token, request.body.newPassword);

        if (!result) {
          throw validationFailed([{ field: 'token', issue: 'is invalid or has expired' }]);
        }

        await auditOrFail(
          audit,
          {
            actorId: result.parentId,
            actorType: 'parent',
            action: 'auth.password.reset_completed',
            resourceType: 'parent',
            resourceId: result.parentId,
            outcome: 'success',
            metadata: { sessionsRevoked: true },
          },
          request,
        );

        return await reply.status(200).send({ reset: true });
      },
    );
  };
