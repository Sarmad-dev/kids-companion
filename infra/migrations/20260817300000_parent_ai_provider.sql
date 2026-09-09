-- =============================================================================
-- parents.ai_provider — which vendor answers this family's children
-- =============================================================================
-- A per-family preference, set from the parent account screen and read on the
-- turn path. It selects the CONVERSATION model only. Safety classification runs
-- on the deployment's configured provider whatever this says, because the
-- quality of a moderation check is not something an account setting may lower
-- (see RespondInput.provider in services/ai/src/engine.ts).
--
-- NULL is the normal state and means "whatever the operator configured". It is
-- not the same as storing 'mock' or storing the current default:
--
--   * A family who never expressed a preference must follow the deployment as
--     it changes. Materialising today's default into every row would freeze
--     each account against the value it happened to have at signup, and a later
--     AI_PROVIDER change would then reach nobody.
--   * It keeps the column honest about what a parent actually chose, which is
--     what the settings screen has to draw.
--
-- The check constraint deliberately does NOT guarantee the named provider is
-- reachable — an operator can rotate a key out from under a stored preference,
-- and a database restored into a differently-configured environment will do it
-- wholesale. That case is resolved at read time by the provider registry, which
-- falls back to the deployment default. A constraint could not express it
-- anyway: reachability is a property of the environment, not of the row.

alter table parents
  add column ai_provider text;

alter table parents
  add constraint ck_parents_ai_provider
    check (ai_provider is null or ai_provider in ('anthropic', 'openai', 'google', 'mock'));

comment on column parents.ai_provider is
  'S3 — chosen conversation vendor. NULL = follow AI_PROVIDER. Never selects the safety classifier.';

-- No index. The column is read only as part of the per-turn context load, which
-- already reaches this row by primary key through the child's parent_id; an
-- index on a low-cardinality column reached by PK would be write cost for no
-- read benefit.

-- No new RLS policy. `parents` already carries a self-select and self-update
-- policy scoped to app.current_parent_id(), and a column added to the table
-- inherits them — which is exactly the intent here: a parent may read and set
-- their own, and no policy grants anyone a view of another family's.
