# Architecture Decision Records

An ADR captures a decision that would be expensive to reverse, at the moment it was made, with the information available then.

## Rules

1. **Never edit an accepted ADR.** Supersede it with a new one and mark the old `Superseded by ADR-NNNN`. The point is the history of what we believed and why — an edited record loses exactly the information that makes it valuable two years later.
2. **Record the rejected options and why.** The next person's first instinct will be one of them; without the record they will re-litigate it from scratch.
3. **Record consequences honestly, including bad ones.** An ADR listing only benefits is a sales pitch.
4. **Number sequentially.** Numbers are never reused.

## When to write one

A vendor choice, a data-model shape, an auth mechanism, a transport, a framework, a safety-policy change — anything where "why is it like this?" will be asked later and the answer is not obvious from the code.

Copy [TEMPLATE.md](TEMPLATE.md).

## Index

| #                                                      | Title                                                  | Status                                                                      |
| ------------------------------------------------------ | ------------------------------------------------------ | --------------------------------------------------------------------------- |
| [0001](0001-monorepo-tooling.md)                       | pnpm workspaces with Turborepo                         | Partly superseded by [0008](0008-build-orchestration-and-module-linking.md) |
| [0002](0002-http-framework-fastify.md)                 | Fastify over Express for the API                       | Accepted                                                                    |
| [0003](0003-supabase-postgres-rls.md)                  | Supabase Postgres with Row Level Security              | Accepted                                                                    |
| [0004](0004-provider-abstraction.md)                   | Ports and adapters for all external providers          | Accepted                                                                    |
| [0005](0005-auth-and-session-model.md)                 | Parent-only authentication with derived child sessions | Accepted                                                                    |
| [0006](0006-voice-pipeline-and-audio-retention.md)     | Transcribe-and-discard as the audio default            | Accepted                                                                    |
| [0007](0007-payments-and-app-store-billing.md)         | Multi-rail payments behind one port                    | Accepted (partial)                                                          |
| [0008](0008-build-orchestration-and-module-linking.md) | Drop Turborepo; hoist node_modules for React Native    | Accepted                                                                    |
| [0009](0009-auth-provider-abstraction.md)              | Authentication behind a provider port                  | Accepted                                                                    |
