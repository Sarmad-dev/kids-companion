/**
 * @kids/validation — Zod schemas, defined once, used three ways.
 *
 * A single schema per boundary does runtime validation at the edge, provides the
 * static types the handler is written against, and emits the JSON Schema Fastify
 * attaches to the route. There is no second definition to drift.
 *
 * The response half matters as much as the request half: Fastify serialises
 * *through* the response schema, so a field the schema does not declare cannot
 * be emitted. That is a privacy control, not a performance trick — see
 * docs/API_CONVENTIONS.md §3.2 and docs/adr/0002-http-framework-fastify.md.
 */

export * from './primitives.js';
