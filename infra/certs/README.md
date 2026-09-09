# Root certificates

Public root certificates for managed services whose chain the system trust store
does not already contain. Nothing secret lives here — a root certificate is a
public key and is meant to be distributed.

## `supabase-prod-ca-2021.crt`

Supabase's pooler (`*.pooler.supabase.com`) presents a chain rooted at
`Supabase Root 2021 CA`, which is in no operating system's trust store. Without
this file, `DATABASE_SSL_MODE=require` fails with `SELF_SIGNED_CERT_IN_CHAIN`.

Point `DATABASE_SSL_ROOT_CERT` at this file to keep full verification. The
alternative — `rejectUnauthorized: false` — encrypts the connection and
authenticates nothing, which is not a trade worth making for a database holding
children's conversations. See `packages/db/src/tls.ts`.

    Subject      CN=Supabase Root 2021 CA, O=Supabase Inc, C=US
    SHA-256      80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:
                 82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA
    Expires      2031-04-26

Downloaded from Supabase's published URL over a publicly-trusted TLS connection,
then checked against the root the pooler actually presents. Re-verify with:

```bash
openssl x509 -in infra/certs/supabase-prod-ca-2021.crt -noout -fingerprint -sha256 -subject -enddate
```
