import { z } from 'zod';

/**
 * Boundary primitives, shared by every request and response schema.
 *
 * Two rules apply everywhere (docs/API_CONVENTIONS.md §3.1):
 *
 *   1. Reject, never coerce. `"age": "5"` is a client bug and gets a 400.
 *      Silent coercion hides bugs and, across parsers, creates real
 *      vulnerabilities.
 *   2. Model and vendor output is validated with the same schemas. An LLM
 *      response is input, not truth.
 */

/** A prefixed identifier — the shape produced by `createId` in @kids/shared. */
export const idSchema = (prefix: string) =>
  z
    .string()
    .regex(
      new RegExp(`^${prefix}_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`),
      `must be a valid ${prefix}_ identifier`,
    );

export const parentIdSchema = idSchema('par');
export const childIdSchema = idSchema('chp');
export const conversationIdSchema = idSchema('cnv');
export const messageIdSchema = idSchema('msg');

/** RFC 3339 UTC with milliseconds. */
export const isoTimestampSchema = z.iso.datetime({ offset: false });

/**
 * Cursor pagination, not offset.
 *
 * Offset pagination skips and duplicates rows when the underlying data changes
 * between pages — which it constantly does for a live conversation list.
 */
export const paginationQuerySchema = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.number().int().min(1).max(100).default(20),
});

export const paginatedSchema = <T extends z.ZodType>(item: T) =>
  z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
  });

/** Minor units plus a currency code. Never a float. */
export const moneySchema = z.object({
  amountMinor: z.number().int(),
  currency: z.string().length(3).toUpperCase(),
});

/** The standard error body. See docs/ERROR_HANDLING.md §3. */
export const errorBodySchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string(),
    details: z.array(z.object({ field: z.string(), issue: z.string() })).optional(),
  }),
});

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.string(),
  version: z.string(),
});

export const readyResponseSchema = z.object({
  status: z.enum(['ready', 'degraded']),
  checks: z.record(z.string(), z.enum(['ok', 'unavailable', 'skipped'])),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;
export type Money = z.infer<typeof moneySchema>;
export type ErrorBody = z.infer<typeof errorBodySchema>;
