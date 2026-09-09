#!/usr/bin/env node
/**
 * Generates TypeScript types from the migrations.
 *
 *   pnpm db:types          write packages/types/src/database.generated.ts
 *   pnpm db:types --check  fail if the committed file is stale (used in CI)
 *
 * Equivalent in spirit to `supabase gen types typescript`, but driven by the
 * migration files rather than a live project — so it runs in CI with no network,
 * no Supabase credentials, and no Docker, and it cannot drift from the SQL that
 * is actually committed.
 */

import { writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { applyMigrations, loadMigrations } from '@kids/db';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));
const OUTPUT = fileURLToPath(
  new URL('../../packages/types/src/database.generated.ts', import.meta.url),
);
const checkOnly = process.argv.includes('--check');

/** Postgres type -> TypeScript type. Unmapped types surface as `unknown`. */
const TYPE_MAP = {
  uuid: 'string',
  text: 'string',
  bpchar: 'string',
  varchar: 'string',
  int2: 'number',
  int4: 'number',
  int8: 'string', // bigint exceeds Number.MAX_SAFE_INTEGER; pg returns a string
  float4: 'number',
  float8: 'number',
  numeric: 'string', // returned as a string to preserve exactness for money
  bool: 'boolean',
  timestamptz: 'string',
  timestamp: 'string',
  date: 'string',
  time: 'string',
  jsonb: 'Json',
  json: 'Json',
  bytea: 'Uint8Array',
  inet: 'string',
};

const toPascal = (snake) =>
  snake
    .split('_')
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('');

const db = await PGlite.create();
const executor = {
  exec: async (sql) => await db.exec(sql),
  query: async (sql, params) => await db.query(sql, params ? [...params] : undefined),
};

await applyMigrations(executor, await loadMigrations(MIGRATIONS_DIR));

const { rows: columns } = await db.query(`
  select
    c.relname                                   as table_name,
    c.relkind                                   as rel_kind,
    a.attname                                   as column_name,
    a.attnum                                    as position,
    t.typname                                   as type_name,
    a.attnotnull                                as not_null,
    (a.attndims > 0 or t.typcategory = 'A')     as is_array,
    pg_get_expr(d.adbin, d.adrelid) is not null as has_default,
    coalesce(et.typname, '')                    as element_type
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  join pg_type t on t.oid = a.atttypid
  left join pg_type et on et.oid = t.typelem
  left join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
  where n.nspname = 'public'
    and c.relkind in ('r', 'v')
    and a.attnum > 0
    and not a.attisdropped
    and c.relname <> 'schema_migrations'
  order by c.relname, a.attnum
`);

/** CHECK constraints of the form `col in ('a','b')` become string-literal unions. */
const { rows: checks } = await db.query(`
  select c.relname as table_name, pg_get_constraintdef(con.oid) as definition
  from pg_constraint con
  join pg_class c on c.oid = con.conrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and con.contype = 'c'
`);

const enumsByTableColumn = new Map();
for (const { table_name, definition } of checks) {
  // Postgres normalises `col in ('a','b')` to one of:
  //   CHECK ((col = ANY (ARRAY['a'::text, 'b'::text])))
  //   CHECK (((col)::text = ANY ((ARRAY['a'::character varying, ...])::text[])))
  // so the column cast and the extra parens are both optional.
  const match = /\(?([a-z_][a-z0-9_]*)\)?(?:::\w[\w ]*)?\s*=\s*ANY\s*\(\(?ARRAY\[(.+?)\]/is.exec(
    definition,
  );
  if (!match) continue;
  const [, column, body] = match;
  const values = [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  if (values.length > 0) enumsByTableColumn.set(`${table_name}.${column}`, values);
}

const tables = new Map();
for (const col of columns) {
  if (!tables.has(col.table_name)) {
    tables.set(col.table_name, { isView: col.rel_kind === 'v', columns: [] });
  }
  tables.get(col.table_name).columns.push(col);
}

const tsTypeFor = (col) => {
  const enumValues = enumsByTableColumn.get(`${col.table_name}.${col.column_name}`);
  if (enumValues) {
    const union = enumValues.map((v) => `'${v}'`).join(' | ');
    return col.is_array ? `(${union})[]` : union;
  }

  const base = col.is_array
    ? (TYPE_MAP[col.element_type.replace(/^_/, '')] ?? 'unknown')
    : (TYPE_MAP[col.type_name] ?? 'unknown');

  return col.is_array ? `${base}[]` : base;
};

const lines = [
  '/**',
  ' * GENERATED FILE — DO NOT EDIT.',
  ' *',
  ' * Produced from infra/migrations/ by infra/scripts/generate-db-types.mjs.',
  ' * Regenerate with `pnpm db:types`; CI fails if this file is stale.',
  ' *',
  ' * `Row` is what a SELECT returns. `Insert` marks nullable and defaulted columns',
  ' * optional. `Update` makes everything optional, matching a PATCH.',
  ' */',
  '',
  'export type Json = string | number | boolean | null | { [key: string]: Json } | Json[];',
  '',
];

for (const [tableName, { isView, columns: cols }] of [...tables.entries()].sort()) {
  const pascal = toPascal(tableName);

  lines.push(`/** \`public.${tableName}\`${isView ? ' (view)' : ''} */`);
  lines.push(`export interface ${pascal}Row {`);
  for (const col of cols) {
    const optional = col.not_null ? '' : ' | null';
    lines.push(`  ${col.column_name}: ${tsTypeFor(col)}${optional};`);
  }
  lines.push('}');
  lines.push('');

  if (!isView) {
    lines.push(`export interface ${pascal}Insert {`);
    for (const col of cols) {
      // Optional when the database can supply a value: a default, or NULL.
      const optional = !col.not_null || col.has_default ? '?' : '';
      const nullable = col.not_null ? '' : ' | null';
      lines.push(`  ${col.column_name}${optional}: ${tsTypeFor(col)}${nullable};`);
    }
    lines.push('}');
    lines.push('');
    lines.push(`export type ${pascal}Update = Partial<${pascal}Insert>;`);
    lines.push('');
  }
}

/* The Supabase-shaped Database type, so `createClient<Database>()` is typed. */
lines.push('/** Supabase-shaped schema map: `createClient<Database>(...)`. */');
lines.push('export interface Database {');
lines.push('  public: {');
lines.push('    Tables: {');
for (const [tableName, { isView }] of [...tables.entries()].sort()) {
  if (isView) continue;
  const pascal = toPascal(tableName);
  lines.push(
    `      ${tableName}: { Row: ${pascal}Row; Insert: ${pascal}Insert; Update: ${pascal}Update };`,
  );
}
lines.push('    };');
lines.push('    Views: {');
for (const [tableName, { isView }] of [...tables.entries()].sort()) {
  if (!isView) continue;
  lines.push(`      ${tableName}: { Row: ${toPascal(tableName)}Row };`);
}
lines.push('    };');
lines.push('  };');
lines.push('}');
lines.push('');

const generated = lines.join('\n');
await db.close();

if (checkOnly) {
  let current = '';
  try {
    current = await readFile(OUTPUT, 'utf8');
  } catch {
    console.error('packages/types/src/database.generated.ts is missing. Run `pnpm db:types`.');
    process.exit(1);
  }
  if (current.replace(/\r\n/g, '\n') !== generated) {
    console.error(
      'Generated database types are stale — the schema changed without regenerating.\n' +
        'Run `pnpm db:types` and commit the result.',
    );
    process.exit(1);
  }
  console.log(`Database types are up to date (${tables.size} tables and views).`);
} else {
  await writeFile(OUTPUT, generated, 'utf8');
  console.log(`Wrote ${tables.size} tables and views to packages/types/src/database.generated.ts`);
}
