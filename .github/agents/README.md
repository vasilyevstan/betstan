# BetStan agent capabilities

Roles are optional capabilities, not a mandatory chain or approval hierarchy. [CONTRIBUTING.md](../../CONTRIBUTING.md) owns branch, approval and release policy; history lives in the [Agents wiki](../../docs/wiki/Agents.md). Current executable controls remain authoritative.

## Shared rules

- Every task has one accountable owner for scope, implementation, evidence and next action; `betstan-delivery-coordinator` may be that owner, never an extra layer.
- Changed trust/state boundaries (authorization, CI trust, release authority, writer ownership, data integrity, migration, recovery) need independent verification. The verifier must not be the author.
- Bind evidence to exact source and commands. Do not rerun unchanged tests under another role name; reuse never replaces current-SHA CI.
- Editors stay within assigned paths; developers never run Git, PR, workflow or deploy actions and return evidence directly to the accountable owner. Read-only roles never edit.
- No role expands its own tools or authority; no result token authorizes a merge, release or production mutation.
- UI changes need evidence of the affected behavior and consistency ([UI/UX](../../docs/wiki/UI-UX-Consistency.md)).
- Wait with bounded `wait-required-checks-stan.sh` and one observer per wait; after fifteen minutes without decisive progress, report the blocker and smallest next action. Respect explicit pauses; never edit live authority, receipts or locks ad hoc.
- Never expose credentials, private records or session paths.

## Routing

| Need | Role |
|---|---|
| Single owner for a delivery | `betstan-delivery-coordinator` |
| Backend and `common/**` | `betstan-backend-developer` |
| Client | `betstan-frontend-developer` |
| Tests, correctness, shared contracts, mixed versions | `betstan-test-engineer` |
| UI consistency and accessibility | `betstan-ux-ui-expert` |
| Public docs | `betstan-public-wiki-editor` |
| Auth, session, authorization | `betstan-auth-security-reviewer` |
| CI trust, release, rollback, migration recovery | `betstan-deployment-safety` |
| OCI runtime, routing, health (manual only) | `betstan-oci-operator` |

The retired shared-Mongo migration role is [archived](../../archive/azure/github-agents/betstan-mongo-migration.md); deployment safety owns its recovery obligations.
