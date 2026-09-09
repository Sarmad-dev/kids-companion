import { readFileSync } from 'node:fs';

/**
 * TLS for a Postgres connection.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY A ROOT CERTIFICATE IS CONFIGURABLE AT ALL
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `ssl: { rejectUnauthorized: true }` on its own verifies against the system
 * trust store, which is right for a database behind a publicly-trusted
 * certificate and wrong for several managed providers. Supabase's pooler
 * presents a chain rooted at "Supabase Root 2021 CA", a private root that is in
 * no system store, so verification fails with SELF_SIGNED_CERT_IN_CHAIN.
 *
 * The two ways out of that are not equivalent. Turning verification off
 * (`rejectUnauthorized: false`) encrypts the connection and authenticates
 * nothing, which for a database holding children's conversations is the wrong
 * trade to make for convenience. Supplying the provider's root keeps full
 * verification and costs one config value.
 *
 * ACCEPTS EITHER A PATH OR THE PEM ITSELF, because the two deployment shapes
 * want different things: a developer has a file on disk, and a container has an
 * environment variable and no filesystem to put one on.
 */
export interface PostgresTlsOptions {
  /** `require` turns TLS on. Anything else, including undefined, leaves it off. */
  readonly mode?: string | undefined;
  /** A path to a PEM file, or the PEM text. Optional: absent means system roots. */
  readonly rootCert?: string | undefined;
}

/** What `pg` wants for its `ssl` option. */
export type PostgresTlsConfig = false | { rejectUnauthorized: true; ca?: string };

const PEM_PREFIX = '-----BEGIN';

export const postgresTls = (options: PostgresTlsOptions): PostgresTlsConfig => {
  if (options.mode !== 'require') return false;

  const rootCert = options.rootCert;
  if (rootCert === undefined || rootCert === '') return { rejectUnauthorized: true };

  // `rejectUnauthorized` stays true in both branches. The root is ADDED to what
  // is trusted for this connection, never a reason to stop checking.
  const ca = rootCert.trimStart().startsWith(PEM_PREFIX)
    ? rootCert
    : readFileSync(rootCert, 'utf8');

  return { rejectUnauthorized: true, ca };
};
