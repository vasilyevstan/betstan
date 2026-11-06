# BetStan agent capabilities

Roles are optional capabilities, not a mandatory sequence or approval hierarchy. [CONTRIBUTING.md](../../CONTRIBUTING.md) owns branch, approval and release policy. Current executable controls remain authoritative until a proven cutover.

## Ownership and verification

- Every task has one accountable owner for scope, implementation, evidence and the next action. The main owner also owns coordination, simplification and final acceptance; no conductor or validator agent is needed.
- Ordinary reversible changes use the smallest relevant existing checks during correction, then one full validation of the final SHA.
- Changes to trust or state boundaries require independent verification (authorization, CI trust, release authority, writer ownership, data integrity, migration, recovery). The verifier must not be the author.
- Required exact-SHA CI and runtime checks always apply; local results do not replace them.
- No compulsory agent chain, model quorum, review-of-review or status-only handoff. Add expertise only for a concrete gap. A blocker names the failing criterion and evidence. No agent status authorizes a merge or production mutation.

## Routing

| Need | Role |
|---|---|
| Service boundaries, unresolved design | `betstan-architect` |
| Unnecessary scope or abstractions | `betstan-simplifier` |
| Backend and `common/**` | `betstan-backend-developer` |
| Client | `betstan-frontend-developer` |
| Correctness, concurrency, focused tests | `betstan-test-engineer` |
| UI consistency, accessibility, interaction | `betstan-ux-ui-expert` |
| Public docs and publication evidence | `betstan-public-wiki-editor` |
| Shared contracts, mixed versions | `betstan-service-contract-reviewer` |
| Auth, session, authorization | `betstan-auth-security-reviewer` |
| CI trust, ancestry, release, rollback | `betstan-deployment-safety` |
| OCI runtime and read-only health (manual) | `betstan-oci-operator` |
| Ingress and TLS (manual) | `betstan-domain-ingress` |
| Shared-Mongo and cross-cloud migration (manual) | `betstan-mongo-migration` |

Preserve each role's tools and manual-invocation flag. Developers edit only their assigned paths and never perform Git or deploy actions; requesting an opinion grants no permissions. Agents never expand their own authority.

## Documentation and UI

Record documentation impact per [CONTRIBUTING.md](../../CONTRIBUTING.md#public-documentation-impact). UI changes need evidence of the affected behavior and consistency; use the UX expert only for evidenced design risk. Precise geometry claims need the smallest rendered evidence.

## Evidence reuse

- Bind evidence to exact repository, source, scope and commands; never relabel old results as current or use a sibling checkout.
- A pause, new PR, promotion or ancestry-only merge does not invalidate unchanged source evidence. Do not rerun unchanged tests merely under a different agent name.
- Reuse never replaces current-SHA CI, approval/lock checks, immutable deployed identity, compatible recovery or observed health.

## Waits and operations

- Use one active observer per wait and one concise state record. Inspect exact jobs and pending gates at startup, resume and checkpoints; route eligible CLI-owned approvals through canonical helpers. An approved wait timer is not missing consent.
- After fifteen minutes without decisive progress, report blocker, evidence and smallest next action. If no required check has succeeded for thirty minutes, inspect remaining jobs and report the blocker; neither authorizes cancellation or a new agent.
- Timeout, runner exit or lease expiry is not proof that a writer stopped. Never edit live authority, consumed receipts or locks ad hoc; use the exact recovery path. Respect explicit pauses.

## Result tokens

Architect `ARCHITECTURE_READY`/`ARCHITECTURE_CHANGES_REQUIRED`/`DECISION_REQUIRED`; UX `UX_SPEC_READY`/`UX_REVIEW_PASSED`/`UX_CHANGES_REQUIRED`/`UX_CLARIFICATION_NEEDED`; developers `IMPLEMENTED_LOCAL`/`BLOCKED`; wiki `WIKI_UPDATE_READY`/`WIKI_NO_PUBLIC_CHANGE`/`WIKI_BLOCKED`; simplifier `SIMPLIFICATION_*`/`NO_SIMPLIFICATION_FOUND`; test `SUPPORTING_EVIDENCE_READY`/`TESTS_GREEN`/`TESTS_FAILED`/`APPROVE_SLICE`/`CHANGES_REQUIRED`; deployment `SAFE_TO_REVIEW`/`SAFE_TO_MERGE_DEV`/`SAFE_TO_PROMOTE`/`DEPLOYED_HEALTHY`/`NO_GO`. Absence of an optional token never blocks; real failures always do.
