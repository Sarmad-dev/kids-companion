# tests/

Cross-cutting suites that do not belong to a single package. Per-package unit tests live beside their source.

Standards: [TESTING_STANDARDS.md](../docs/TESTING_STANDARDS.md).

```
tests/
├── contract/   one suite per port; EVERY adapter must pass it, mocks included
├── e2e/        full-stack journeys against a running API
└── fixtures/   synthetic test data — never real child data
```

## contract/

The suite that makes the port abstraction real rather than decorative ([ADR-0004](../docs/adr/0004-provider-abstraction.md)). One suite per port, run against every adapter including the mock — which is what makes the mock a trustworthy stand-in and a vendor swap a configuration change.

Includes the unhappy paths vendors actually differ on: timeout, rate limit, malformed response, partial stream, and a network failure mid-request.

## e2e/

Full journeys: register → create a child profile → start a session → take a turn → view it in the dashboard → delete everything and verify it is gone.

Everything real except vendor calls, which are faked at the HTTP boundary. **A test never calls a live vendor** — not in CI, not locally, not once.

## fixtures/

**Synthetic only. Always.** Obviously fake: `"Test Child A"`, birth year `2019`. Never a real-looking name with a real-looking birthday, because plausible fake data eventually gets mistaken for real — or real data gets pasted in beside it and nobody notices.

## Two suites that are mandatory in this product

**Tenant isolation**, on every endpoint touching child data — asserted twice: at the API, and at the database with the application check bypassed. The second is what proves the RLS backstop is real.

**Fail-closed safety**, on every safety layer — an error, a timeout, and a malformed response must each block the turn.
