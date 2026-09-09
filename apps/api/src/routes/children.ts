import type { Queryable } from '@kids/db';
import { notFound, validationFailed } from '@kids/shared';
import { AGE_GROUPS, CHILD_STATUSES } from '@kids/types';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { auditOrFail, type AuditLogger } from '../audit.js';
import { requireChildOwnership } from '../plugins/auth.js';

/**
 * Child profiles.
 *
 * Two things run through every route here.
 *
 * MINIMISATION. The profile carries a first name or nickname, a birth month and
 * year, a language set, a character, and bounded preferences. That is all. There
 * is no surname, no day-precision birth date, no photograph, no school, no free
 * text — and the free-text `interests` field that used to exist was removed
 * rather than bounded, because "loves visiting grandma in Lahore" is a family
 * member, a city, and a routine that the product never needed.
 *
 * OWNERSHIP. Every route resolves the child through the authenticated parent,
 * and a child belonging to someone else returns 404 rather than 403 — the
 * resources here are children, and confirming one exists is itself a disclosure.
 */

export interface ChildRoutesOptions {
  readonly audit: AuditLogger;
}

const ageGroupSchema = z.enum(AGE_GROUPS);

const childSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  birthYear: z.number().int(),
  birthMonth: z.number().int(),
  ageGroup: ageGroupSchema,
  /** Surfaced, not hidden: a child can age out of the supported range. */
  ageInSupportedRange: z.boolean(),
  status: z.enum(CHILD_STATUSES),
  avatarKey: z.string().nullable(),
  preferredCharacterId: z.string().nullable(),
  languages: z.array(
    z.object({
      languageCode: z.string(),
      isPrimary: z.boolean(),
      proficiency: z.enum(['learning', 'conversational', 'fluent', 'native']),
    }),
  ),
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const preferencesSchema = z.object({
  sessionLength: z.enum(['short', 'medium', 'long']),
  storytellingEnabled: z.boolean(),
  roleplayEnabled: z.boolean(),
  pronunciationPractice: z.boolean(),
  correctionStyle: z.enum(['none', 'gentle', 'active']),
  topicKeys: z.array(z.string()),
});

interface ChildRow {
  id: string;
  display_name: string;
  birth_year: number;
  birth_month: number;
  age_group: 'AGE_3_5' | 'AGE_6_8' | 'AGE_9_10';
  age_in_range: boolean;
  status: 'active' | 'paused' | 'archived';
  avatar_key: string | null;
  preferred_character_id: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_CHILD = `
  select id, display_name, birth_year, birth_month,
         app.age_group(birth_year, birth_month)    as age_group,
         app.age_in_range(birth_year, birth_month) as age_in_range,
         status, avatar_key, preferred_character_id, archived_at, created_at, updated_at
    from children`;

/**
 * Languages for MANY children, in one statement.
 *
 * The per-child version below reads better and is right for a single profile.
 * Used in a loop it is an N+1 — see the list handler, where this exists
 * because that is exactly what happened.
 */
const loadLanguagesFor = async (
  tx: Queryable,
  childIds: readonly string[],
): Promise<Map<string, { languageCode: string; isPrimary: boolean; proficiency: string }[]>> => {
  const grouped = new Map<
    string,
    { languageCode: string; isPrimary: boolean; proficiency: string }[]
  >();
  if (childIds.length === 0) return grouped;

  const { rows } = await tx.query<{
    child_id: string;
    language_code: string;
    is_primary: boolean;
    proficiency: 'learning' | 'conversational' | 'fluent' | 'native';
  }>(
    `select child_id, language_code, is_primary, proficiency
       from child_languages where child_id = any($1::uuid[])
      order by child_id, is_primary desc, language_code`,
    [[...childIds]],
  );

  for (const row of rows) {
    const existing = grouped.get(row.child_id) ?? [];
    existing.push({
      languageCode: row.language_code,
      isPrimary: row.is_primary,
      proficiency: row.proficiency,
    });
    grouped.set(row.child_id, existing);
  }

  return grouped;
};

const loadLanguages = async (tx: Queryable, childId: string) => {
  const { rows } = await tx.query<{
    language_code: string;
    is_primary: boolean;
    proficiency: 'learning' | 'conversational' | 'fluent' | 'native';
  }>(
    `select language_code, is_primary, proficiency
       from child_languages where child_id = $1
      order by is_primary desc, language_code`,
    [childId],
  );
  return rows.map((r) => ({
    languageCode: r.language_code,
    isPrimary: r.is_primary,
    proficiency: r.proficiency,
  }));
};

const present = (
  row: ChildRow,
  languages: { languageCode: string; isPrimary: boolean; proficiency: string }[],
) => ({
  id: row.id,
  displayName: row.display_name,
  birthYear: row.birth_year,
  birthMonth: row.birth_month,
  ageGroup: row.age_group,
  ageInSupportedRange: row.age_in_range,
  status: row.status,
  avatarKey: row.avatar_key,
  preferredCharacterId: row.preferred_character_id,
  languages: languages as {
    languageCode: string;
    isPrimary: boolean;
    proficiency: 'learning' | 'conversational' | 'fluent' | 'native';
  }[],
  archivedAt: row.archived_at === null ? null : new Date(row.archived_at).toISOString(),
  createdAt: new Date(row.created_at).toISOString(),
  updatedAt: new Date(row.updated_at).toISOString(),
});

/**
 * A character must suit the child's age group and speak one of their languages.
 *
 * Checked in the application rather than by a constraint because it depends on
 * three tables and on the child's age, which changes. Getting it wrong is not a
 * data-integrity problem — it is a four-year-old being handed a character
 * written for a nine-year-old.
 */
const assertCharacterSuitable = async (
  tx: Queryable,
  characterId: string,
  ageGroup: string,
  languageCodes: readonly string[],
): Promise<void> => {
  const { rows } = await tx.query<{ allowed: boolean; speaks: boolean }>(
    `select $2 = any(c.allowed_age_groups) as allowed,
            exists (
              select 1 from character_languages cl
              where cl.character_id = c.id and cl.language_code = any($3::text[])
            ) as speaks
       from ai_characters c
      where c.id = $1 and c.status in ('active', 'beta')`,
    [characterId, ageGroup, [...languageCodes]],
  );

  const character = rows[0];
  if (!character) {
    throw validationFailed([
      { field: 'preferredCharacterId', issue: 'is not an available character' },
    ]);
  }
  if (!character.allowed) {
    throw validationFailed([
      { field: 'preferredCharacterId', issue: `is not offered for age group ${ageGroup}` },
    ]);
  }
  if (!character.speaks) {
    throw validationFailed([
      { field: 'preferredCharacterId', issue: "does not speak any of the child's languages" },
    ]);
  }
};

export const childRoutes =
  (options: ChildRoutesOptions): FastifyPluginAsyncZod =>
  async (app) => {
    const { audit } = options;

    /* ---------------------------------------------------------------------- */
    /* List and create                                                        */
    /* ---------------------------------------------------------------------- */

    app.get(
      '/v1/children',
      {
        onRequest: [app.authenticate],
        preHandler: [app.authorize('children:manage_own')],
        schema: {
          description: "The authenticated parent's children.",
          querystring: z.object({
            includeArchived: z.stringbool().default(false),
          }),
          response: { 200: z.object({ items: z.array(childSchema) }) },
        },
      },
      async (request, reply) => {
        const items = await app.withParent(request, async (tx) => {
          const { rows } = await tx.query<ChildRow>(
            `${SELECT_CHILD}
              where ($1 or status <> 'archived')
              order by created_at`,
            [request.query.includeArchived],
          );

          // ONE query for every child's languages, not one per child.
          const languages = await loadLanguagesFor(
            tx,
            rows.map((row) => row.id),
          );

          return rows.map((row) => present(row, (languages.get(row.id) ?? []) as never));
        });

        return await reply.status(200).send({ items });
      },
    );

    app.post(
      '/v1/children',
      {
        onRequest: [app.authenticate],
        preHandler: [app.authorize('children:manage_own')],
        schema: {
          description: 'Create a child profile.',
          body: z.object({
            // First name or nickname. Bounded, and never a surname.
            displayName: z.string().min(1).max(40),
            birthYear: z.number().int().min(2000).max(2100),
            birthMonth: z.number().int().min(1).max(12),
            avatarKey: z.string().max(64).optional(),
            preferredCharacterId: z.uuid().optional(),
            languages: z
              .array(
                z.object({
                  languageCode: z.string().min(2).max(5),
                  isPrimary: z.boolean().default(false),
                  proficiency: z
                    .enum(['learning', 'conversational', 'fluent', 'native'])
                    .default('learning'),
                }),
              )
              .min(1)
              .max(4),
          }),
          response: { 201: childSchema },
        },
      },
      async (request, reply) => {
        const principal = request.principal;
        if (!principal) throw notFound();

        const body = request.body;

        // Exactly one primary language. The database enforces "at most one" with
        // a partial unique index; "at least one" belongs here, because the
        // alternative is a child whose generation language is undefined.
        const primaries = body.languages.filter((l) => l.isPrimary);
        if (primaries.length !== 1) {
          throw validationFailed([
            { field: 'languages', issue: 'must contain exactly one primary language' },
          ]);
        }

        const created = await app.withParent(request, async (tx) => {
          // parent_id comes from the authenticated principal, never the body.
          const { rows } = await tx.query<ChildRow>(
            `with inserted as (
               insert into children (parent_id, display_name, birth_year, birth_month, avatar_key)
               values ($1, $2, $3, $4, $5)
               returning *
             )
             select id, display_name, birth_year, birth_month,
                    app.age_group(birth_year, birth_month)    as age_group,
                    app.age_in_range(birth_year, birth_month) as age_in_range,
                    status, avatar_key, preferred_character_id, archived_at, created_at, updated_at
               from inserted`,
            [
              principal.parentId,
              body.displayName,
              body.birthYear,
              body.birthMonth,
              body.avatarKey ?? null,
            ],
          );

          const child = rows[0];
          if (!child) throw new Error('failed to create child profile');

          for (const language of body.languages) {
            await tx.query(
              `insert into child_languages (child_id, language_code, is_primary, proficiency)
               values ($1, $2, $3, $4)`,
              [child.id, language.languageCode, language.isPrimary, language.proficiency],
            );
          }

          if (body.preferredCharacterId !== undefined) {
            await assertCharacterSuitable(
              tx,
              body.preferredCharacterId,
              child.age_group,
              body.languages.map((l) => l.languageCode),
            );
            await tx.query(`update children set preferred_character_id = $2 where id = $1`, [
              child.id,
              body.preferredCharacterId,
            ]);
            child.preferred_character_id = body.preferredCharacterId;
          }

          return present(child, await loadLanguages(tx, child.id));
        });

        await auditOrFail(
          audit,
          {
            actorId: principal.parentId,
            actorType: 'parent',
            action: 'child.profile.created',
            resourceType: 'child',
            resourceId: created.id,
            subjectChildId: created.id,
            outcome: 'success',
            // The age group, not the birth date. Enough to investigate an
            // incident, not enough to identify a child from the audit log.
            metadata: { ageGroup: created.ageGroup, languageCount: created.languages.length },
          },
          request,
        );

        return await reply.status(201).send(created);
      },
    );

    /* ---------------------------------------------------------------------- */
    /* View, edit, archive                                                    */
    /* ---------------------------------------------------------------------- */

    app.get(
      '/v1/children/:childId',
      {
        onRequest: [app.authenticate],
        preHandler: [app.authorize('children:manage_own')],
        schema: {
          description: 'One child. 404 for a child the caller does not own.',
          params: z.object({ childId: z.uuid() }),
          response: { 200: childSchema },
        },
      },
      async (request, reply) => {
        const child = await app.withParent(request, async (tx) => {
          await requireChildOwnership(tx, request.params.childId);

          const { rows } = await tx.query<ChildRow>(`${SELECT_CHILD} where id = $1`, [
            request.params.childId,
          ]);
          const row = rows[0];
          if (!row) throw notFound();

          return present(row, await loadLanguages(tx, row.id));
        });

        return await reply.status(200).send(child);
      },
    );

    app.patch(
      '/v1/children/:childId',
      {
        onRequest: [app.authenticate],
        preHandler: [app.authorize('children:manage_own')],
        schema: {
          description: 'Edit a child profile. Absent fields are unchanged.',
          params: z.object({ childId: z.uuid() }),
          body: z.object({
            displayName: z.string().min(1).max(40).optional(),
            birthYear: z.number().int().min(2000).max(2100).optional(),
            birthMonth: z.number().int().min(1).max(12).optional(),
            avatarKey: z.string().max(64).nullable().optional(),
            preferredCharacterId: z.uuid().nullable().optional(),
            status: z.enum(['active', 'paused']).optional(),
          }),
          response: { 200: childSchema },
        },
      },
      async (request, reply) => {
        const body = request.body;

        const updated = await app.withParent(request, async (tx) => {
          await requireChildOwnership(tx, request.params.childId);

          const { rows } = await tx.query<ChildRow>(
            `with updated as (
               update children
                  set display_name = coalesce($2, display_name),
                      birth_year   = coalesce($3, birth_year),
                      birth_month  = coalesce($4, birth_month),
                      avatar_key   = case when $5 then $6 else avatar_key end,
                      status       = coalesce($7, status)
                where id = $1
                returning *
             )
             select id, display_name, birth_year, birth_month,
                    app.age_group(birth_year, birth_month)    as age_group,
                    app.age_in_range(birth_year, birth_month) as age_in_range,
                    status, avatar_key, preferred_character_id, archived_at, created_at, updated_at
               from updated`,
            [
              request.params.childId,
              body.displayName ?? null,
              body.birthYear ?? null,
              body.birthMonth ?? null,
              Object.hasOwn(body, 'avatarKey'),
              body.avatarKey ?? null,
              body.status ?? null,
            ],
          );

          const child = rows[0];
          if (!child) throw notFound();

          // Character re-validation on edit, not only on create: correcting a
          // birth year can move a child into an age group the currently selected
          // character is not offered for.
          if (Object.hasOwn(body, 'preferredCharacterId')) {
            if (body.preferredCharacterId == null) {
              await tx.query(`update children set preferred_character_id = null where id = $1`, [
                child.id,
              ]);
              child.preferred_character_id = null;
            } else {
              const languages = await loadLanguages(tx, child.id);
              await assertCharacterSuitable(
                tx,
                body.preferredCharacterId,
                child.age_group,
                languages.map((l) => l.languageCode),
              );
              await tx.query(`update children set preferred_character_id = $2 where id = $1`, [
                child.id,
                body.preferredCharacterId,
              ]);
              child.preferred_character_id = body.preferredCharacterId;
            }
          }

          return present(child, await loadLanguages(tx, child.id));
        });

        await auditOrFail(
          audit,
          {
            actorId: request.principal?.parentId,
            actorType: 'parent',
            action: 'child.profile.updated',
            resourceType: 'child',
            resourceId: updated.id,
            subjectChildId: updated.id,
            outcome: 'success',
            // Field names, never values.
            metadata: { fields: Object.keys(body) },
          },
          request,
        );

        return await reply.status(200).send(updated);
      },
    );

    app.post(
      '/v1/children/:childId/archive',
      {
        onRequest: [app.authenticate],
        preHandler: [app.authorize('children:manage_own')],
        schema: {
          description: 'Archive a child profile. Reversible; retains data.',
          params: z.object({ childId: z.uuid() }),
          response: { 200: childSchema },
        },
      },
      async (request, reply) => {
        const archived = await app.withParent(request, async (tx) => {
          await requireChildOwnership(tx, request.params.childId);

          const { rows } = await tx.query<ChildRow>(
            `with updated as (
               update children set status = 'archived', archived_at = now()
                where id = $1 returning *
             )
             select id, display_name, birth_year, birth_month,
                    app.age_group(birth_year, birth_month)    as age_group,
                    app.age_in_range(birth_year, birth_month) as age_in_range,
                    status, avatar_key, preferred_character_id, archived_at, created_at, updated_at
               from updated`,
            [request.params.childId],
          );

          const child = rows[0];
          if (!child) throw notFound();
          return present(child, await loadLanguages(tx, child.id));
        });

        await auditOrFail(
          audit,
          {
            actorId: request.principal?.parentId,
            actorType: 'parent',
            action: 'child.profile.archived',
            resourceType: 'child',
            resourceId: archived.id,
            subjectChildId: archived.id,
            outcome: 'success',
          },
          request,
        );

        // ARCHIVE IS NOT DELETION, and the response says so. Archiving stops
        // conversation and hides the profile; the data is retained and the
        // action is reversible. Erasure is a separate, irreversible operation
        // with its own endpoint (PRIVACY.md §6) — conflating them would let a
        // parent believe they had deleted their child's data when they had not.
        return await reply.status(200).send(archived);
      },
    );

    app.post(
      '/v1/children/:childId/restore',
      {
        onRequest: [app.authenticate],
        preHandler: [app.authorize('children:manage_own')],
        schema: {
          description: 'Restore an archived child profile.',
          params: z.object({ childId: z.uuid() }),
          response: { 200: childSchema },
        },
      },
      async (request, reply) => {
        const restored = await app.withParent(request, async (tx) => {
          await requireChildOwnership(tx, request.params.childId);

          const { rows } = await tx.query<ChildRow>(
            `with updated as (
               update children set status = 'active', archived_at = null
                where id = $1 returning *
             )
             select id, display_name, birth_year, birth_month,
                    app.age_group(birth_year, birth_month)    as age_group,
                    app.age_in_range(birth_year, birth_month) as age_in_range,
                    status, avatar_key, preferred_character_id, archived_at, created_at, updated_at
               from updated`,
            [request.params.childId],
          );

          const child = rows[0];
          if (!child) throw notFound();
          return present(child, await loadLanguages(tx, child.id));
        });

        return await reply.status(200).send(restored);
      },
    );

    app.delete(
      '/v1/children/:childId',
      {
        onRequest: [app.authenticate],
        preHandler: [app.authorize('children:manage_own')],
        schema: {
          description: 'Permanently delete a child profile and all of its data.',
          params: z.object({ childId: z.uuid() }),
          response: { 204: z.null() },
        },
      },
      async (request, reply) => {
        const childId = request.params.childId;

        await app.withParent(request, async (tx) => {
          await requireChildOwnership(tx, childId);
          // A real DELETE. Foreign keys cascade to conversations, messages,
          // flags, practice, progress, languages, preferences, and controls —
          // which is what makes "delete my child's data" complete rather than a
          // flag that hides a row (docs/DATA_MODEL.md §6).
          await tx.query('delete from children where id = $1', [childId]);
        });

        await auditOrFail(
          audit,
          {
            actorId: request.principal?.parentId,
            actorType: 'parent',
            action: 'child.profile.deleted',
            resourceType: 'child',
            resourceId: childId,
            subjectChildId: childId,
            outcome: 'success',
            metadata: { irreversible: true },
          },
          request,
        );

        return await reply.status(204).send(null);
      },
    );

    /* ---------------------------------------------------------------------- */
    /* Languages                                                              */
    /* ---------------------------------------------------------------------- */

    app.put(
      '/v1/children/:childId/languages',
      {
        onRequest: [app.authenticate],
        preHandler: [app.authorize('children:manage_own')],
        schema: {
          description: "Replace a child's language set.",
          params: z.object({ childId: z.uuid() }),
          body: z.object({
            languages: z
              .array(
                z.object({
                  languageCode: z.string().min(2).max(5),
                  isPrimary: z.boolean().default(false),
                  proficiency: z
                    .enum(['learning', 'conversational', 'fluent', 'native'])
                    .default('learning'),
                }),
              )
              .min(1)
              .max(4),
          }),
          response: { 200: childSchema },
        },
      },
      async (request, reply) => {
        const languages = request.body.languages;

        if (languages.filter((l) => l.isPrimary).length !== 1) {
          throw validationFailed([
            { field: 'languages', issue: 'must contain exactly one primary language' },
          ]);
        }

        const updated = await app.withParent(request, async (tx) => {
          await requireChildOwnership(tx, request.params.childId);

          // Replace wholesale inside the transaction. A partial update could
          // leave a child with two primaries or none, and "none" means the
          // generation language is undefined at the next turn.
          await tx.query('delete from child_languages where child_id = $1', [
            request.params.childId,
          ]);
          for (const language of languages) {
            await tx.query(
              `insert into child_languages (child_id, language_code, is_primary, proficiency)
               values ($1, $2, $3, $4)`,
              [
                request.params.childId,
                language.languageCode,
                language.isPrimary,
                language.proficiency,
              ],
            );
          }

          const { rows } = await tx.query<ChildRow>(`${SELECT_CHILD} where id = $1`, [
            request.params.childId,
          ]);
          const child = rows[0];
          if (!child) throw notFound();

          // A character that no longer speaks any of the child's languages is
          // cleared rather than left dangling — silently keeping it would mean
          // the next session starts in a language the child does not have.
          if (child.preferred_character_id !== null) {
            const { rows: speaks } = await tx.query(
              `select 1 from character_languages
                where character_id = $1 and language_code = any($2::text[])`,
              [child.preferred_character_id, languages.map((l) => l.languageCode)],
            );
            if (speaks.length === 0) {
              await tx.query('update children set preferred_character_id = null where id = $1', [
                child.id,
              ]);
              child.preferred_character_id = null;
            }
          }

          return present(child, await loadLanguages(tx, child.id));
        });

        return await reply.status(200).send(updated);
      },
    );

    /* ---------------------------------------------------------------------- */
    /* Learning preferences                                                   */
    /* ---------------------------------------------------------------------- */

    app.get(
      '/v1/children/:childId/preferences',
      {
        onRequest: [app.authenticate],
        preHandler: [app.authorize('children:manage_own')],
        schema: {
          params: z.object({ childId: z.uuid() }),
          response: { 200: preferencesSchema },
        },
      },
      async (request, reply) => {
        const preferences = await app.withParent(request, async (tx) => {
          await requireChildOwnership(tx, request.params.childId);
          return await loadPreferences(tx, request.params.childId);
        });

        return await reply.status(200).send(preferences);
      },
    );

    app.put(
      '/v1/children/:childId/preferences',
      {
        onRequest: [app.authenticate],
        preHandler: [app.authorize('children:manage_own')],
        schema: {
          description: 'Replace learning preferences. Topics are curated keys, never free text.',
          params: z.object({ childId: z.uuid() }),
          body: z.object({
            sessionLength: z.enum(['short', 'medium', 'long']).optional(),
            storytellingEnabled: z.boolean().optional(),
            roleplayEnabled: z.boolean().optional(),
            pronunciationPractice: z.boolean().optional(),
            correctionStyle: z.enum(['none', 'gentle', 'active']).optional(),
            topicKeys: z.array(z.string().max(40)).max(12).optional(),
          }),
          response: { 200: preferencesSchema },
        },
      },
      async (request, reply) => {
        const body = request.body;

        const preferences = await app.withParent(request, async (tx) => {
          await requireChildOwnership(tx, request.params.childId);

          await tx.query(
            `update child_learning_preferences
                set session_length         = coalesce($2, session_length),
                    storytelling_enabled   = coalesce($3, storytelling_enabled),
                    roleplay_enabled       = coalesce($4, roleplay_enabled),
                    pronunciation_practice = coalesce($5, pronunciation_practice),
                    correction_style       = coalesce($6, correction_style)
              where child_id = $1`,
            [
              request.params.childId,
              body.sessionLength ?? null,
              body.storytellingEnabled ?? null,
              body.roleplayEnabled ?? null,
              body.pronunciationPractice ?? null,
              body.correctionStyle ?? null,
            ],
          );

          if (body.topicKeys !== undefined) {
            const { rows: valid } = await tx.query<{ key: string }>(
              `select key from learning_topics
                where key = any($1::text[]) and is_active
                  and $2 = any(age_groups)`,
              [
                body.topicKeys,
                (
                  await tx.query<{ g: string }>(
                    `select app.age_group(birth_year, birth_month) as g from children where id = $1`,
                    [request.params.childId],
                  )
                ).rows[0]?.g ?? 'AGE_3_5',
              ],
            );

            const validKeys = new Set(valid.map((v) => v.key));
            const rejected = body.topicKeys.filter((k) => !validKeys.has(k));
            if (rejected.length > 0) {
              // Rejected rather than silently dropped: a topic that is not in
              // the catalogue, or not offered for this age group, is a client
              // bug or an attempt to smuggle free text past the curation.
              throw validationFailed(
                rejected.map((key) => ({
                  field: 'topicKeys',
                  issue: `${key} is not an available topic for this age group`,
                })),
              );
            }

            await tx.query('delete from child_learning_topics where child_id = $1', [
              request.params.childId,
            ]);
            for (const key of body.topicKeys) {
              await tx.query(
                'insert into child_learning_topics (child_id, topic_key) values ($1, $2)',
                [request.params.childId, key],
              );
            }
          }

          return await loadPreferences(tx, request.params.childId);
        });

        return await reply.status(200).send(preferences);
      },
    );
  };

const loadPreferences = async (tx: Queryable, childId: string) => {
  const { rows } = await tx.query<{
    session_length: 'short' | 'medium' | 'long';
    storytelling_enabled: boolean;
    roleplay_enabled: boolean;
    pronunciation_practice: boolean;
    correction_style: 'none' | 'gentle' | 'active';
  }>(`select * from child_learning_preferences where child_id = $1`, [childId]);

  const row = rows[0];
  if (!row) throw notFound();

  const { rows: topics } = await tx.query<{ topic_key: string }>(
    'select topic_key from child_learning_topics where child_id = $1 order by topic_key',
    [childId],
  );

  return {
    sessionLength: row.session_length,
    storytellingEnabled: row.storytelling_enabled,
    roleplayEnabled: row.roleplay_enabled,
    pronunciationPractice: row.pronunciation_practice,
    correctionStyle: row.correction_style,
    topicKeys: topics.map((t) => t.topic_key),
  };
};
