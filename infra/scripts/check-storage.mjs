#!/usr/bin/env node
/**
 * Proves object storage is safe to switch on, BEFORE it is switched on.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE FAILURE THIS EXISTS TO CATCH IS SILENT AND TOTAL
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The S3 adapter keeps an object's expiry in its own metadata
 * (`x-amz-meta-expires-at`) and the retention sweep reads it back with HEAD.
 * When the sweep cannot date an object it DELETES it — deliberately, because an
 * undatable recording of a child is not one to keep (see s3-storage.ts).
 *
 * That is the right default and it has a sharp edge. Point the adapter at a
 * store whose S3 layer does not round-trip user metadata and nothing errors:
 * every PUT succeeds, every object comes back undatable, and the first sweep
 * deletes the lot — including a recording from a conversation happening right
 * then. The damage is indistinguishable from the retention policy working.
 *
 * So this asserts the round trip end to end, against the REAL adapter and a
 * REAL bucket, and it asserts the thing that actually matters: that an
 * UNEXPIRED object survives a sweep. A store that passes cannot lose audio to
 * this failure. A store that fails says so here, with an empty test bucket,
 * rather than in production with a child's conversation in it.
 *
 *   node --env-file-if-exists=.env infra/scripts/check-storage.mjs
 */

import { createS3AudioStorage } from '@kids/voice';

const write = (line = '') => process.stdout.write(`${line}\n`);

const required = [
  'STORAGE_S3_ENDPOINT',
  'STORAGE_S3_ACCESS_KEY_ID',
  'STORAGE_S3_SECRET_ACCESS_KEY',
];
const missing = required.filter((name) => !process.env[name]);

if (missing.length > 0) {
  write('Object storage is not configured yet.\n');
  write(`  Missing: ${missing.join(', ')}\n`);
  write('  Supabase: Storage → S3 Access Keys → "New access key" generates the pair.');
  write('  The endpoint is https://<project-ref>.supabase.co/storage/v1/s3');
  process.exit(78); // EX_CONFIG
}

const bucket = process.env.STORAGE_BUCKET_AUDIO ?? 'child-audio';
const clock = { now: () => Date.now() };

const storage = createS3AudioStorage({
  clock,
  endpoint: process.env.STORAGE_S3_ENDPOINT,
  region: process.env.STORAGE_S3_REGION ?? 'us-east-1',
  bucket,
  credentials: {
    accessKeyId: process.env.STORAGE_S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.STORAGE_S3_SECRET_ACCESS_KEY,
    ...(process.env.STORAGE_S3_SESSION_TOKEN
      ? { sessionToken: process.env.STORAGE_S3_SESSION_TOKEN }
      : {}),
  },
  forcePathStyle: process.env.STORAGE_S3_FORCE_PATH_STYLE !== 'false',
  timeoutMs: Number(process.env.STORAGE_S3_TIMEOUT_MS ?? 10_000),
});

const failures = [];
const check = (ok, label, detail) => {
  write(`  ${ok ? '✓' : '✗'} ${label}`);
  if (!ok) failures.push(detail ?? label);
};

/** Recognisable, so anything this leaves behind is obviously ours. */
const bytes = Buffer.from('check-storage placeholder, not a child recording', 'utf8');
const written = [];

write(`Object storage: ${bucket} at ${process.env.STORAGE_S3_ENDPOINT}\n`);

try {
  /* 1. A round trip, with metadata. ---------------------------------------- */
  const future = new Date(Date.now() + 60 * 60 * 1000);
  const stored = await storage.put({
    kind: 'companion_reply',
    mimeType: 'audio/wav',
    bytes,
    durationMs: 1234,
    expiresAt: future,
  });
  written.push(stored.key);

  const read = await storage.get(stored.key);
  check(read !== undefined, 'an object survives a write and a read');

  if (read) {
    check(read.bytes.length === bytes.length, 'the bytes come back unchanged');
    check(read.meta.kind === 'companion_reply', 'the KIND survives the round trip');
    check(read.meta.mimeType === 'audio/wav', 'the MIME TYPE survives the round trip');
    check(read.meta.durationMs === 1234, 'the DURATION survives the round trip');
    check(
      Math.abs(read.meta.expiresAt.getTime() - future.getTime()) < 1000,
      'the EXPIRY survives the round trip',
      'the expiry did not survive — the sweep would treat every object as undatable and delete it',
    );
  }

  /* 2. The one that matters: a sweep must not eat live audio. --------------- */
  const deleted = await storage.sweep();
  const survived = await storage.get(stored.key);
  check(
    survived !== undefined,
    'an UNEXPIRED object survives a sweep',
    'a sweep deleted an unexpired recording — do NOT enable this store',
  );
  write(`    (that sweep removed ${String(deleted)} expired object(s))`);

  /* 3. And it must still collect what is genuinely expired. ----------------- */
  const past = await storage.put({
    kind: 'child_upload',
    mimeType: 'audio/wav',
    bytes,
    expiresAt: new Date(Date.now() - 60 * 1000),
  });
  written.push(past.key);

  await storage.sweep();
  const gone = await storage.get(past.key);
  check(gone === undefined, 'an EXPIRED object is collected by a sweep');
} catch (error) {
  check(
    false,
    `the store rejected the check: ${error instanceof Error ? error.message : String(error)}`,
  );
} finally {
  // Never leave placeholder objects in a bucket meant for children's audio.
  for (const key of written) {
    try {
      await storage.delete(key);
    } catch {
      write(`  ! could not clean up ${key} — remove it by hand`);
    }
  }
}

write('');
if (failures.length > 0) {
  write('Object storage is NOT safe to enable:');
  for (const failure of failures) write(`  - ${failure}`);
  process.exit(1);
}
write('Object storage round-trips metadata and sweeps correctly. Safe to enable.');
