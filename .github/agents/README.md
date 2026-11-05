# BetStan reusable agent capabilities

Use these roles for bounded work when their expertise is needed. They are
capabilities, not a mandatory sequence or separate approval hierarchy.
[CONTRIBUTING.md](../../CONTRIBUTING.md) owns branch and approval policy.
Current executable controls remain authoritative until a proven cutover;
this routing change does not activate a new controller or snapshot verifier.

## Responsibilities and proportionate verification

Every task has one accountable owner who retains scope, acceptance criteria,
implementation responsibility, verification evidence, and the next action.
Implementation, independent verification, and privileged execution are
responsibilities, not a requirement to launch distinct agents for each.

- Ordinary bounded, reversible changes use the smallest relevant existing
  tests, inspection, or build checks. Documentation-only work normally needs
  link/contract checks only where such checks exist.
- Changes to trust or state boundaries require independent verification of
  the changed boundary: authorization, CI trust, release authority, physical
  writer ownership, data integrity, migration, or recovery. The verifier must
  not be the author of that change. Scope the verification to the evidenced
  risk and reuse accepted results.
- Required exact-SHA CI and applicable runtime checks still apply. Local
  results are useful development evidence, not a substitute for those gates.
- Select additional expertise for a concrete acceptance gap or failure path,
  not because a role exists. There is no compulsory architect, simplifier,
  critic, test-engineer, or final-validator conveyor, model quorum,
  review-of-review, or status-only handoff.
- Multi-model deliberation is optional unless explicitly requested. Reuse
  completed design decisions; model agreement does not prove implementation.
  Disagreements are resolved by the accountable owner against requirements
  and evidence, not unanimity or repeated rounds.
- A claimed blocker names the failing criterion and evidence. Missing
  required evidence blocks its dependent action, not unrelated authorized
  work. No agent status alone authorizes a merge or production mutation.

## Ownership and capability routing

Choose only the capabilities needed for the actual task; the table is not an
invocation checklist. Preserve each role's declared tools and manual-invocation
restrictions. A request for repository-only implementation does not authorize
cloud access or a live baseline.

| Need | Available role |
|---|---|
| Service boundaries, dependencies, unresolved design | `betstan-architect` |
| Unnecessary abstractions or scope | `betstan-simplifier` |
| Backend and `common/**` implementation | `betstan-backend-developer` |
| Client implementation | `betstan-frontend-developer` |
| Concrete correctness, concurrency and focused executable verification | `betstan-test-engineer` |
| UI consistency, accessibility, responsive or interaction risk | `betstan-ux-ui-expert` |
| Public documentation and publication evidence | `betstan-public-wiki-editor` |
| Shared contracts and mixed versions | `betstan-service-contract-reviewer` |
| Auth, session, identity and authorization | `betstan-auth-security-reviewer` |
| CI trust, coverage, protected ancestry, release and rollback | `betstan-deployment-safety` |
| OCI runtime operations and read-only health | `betstan-oci-operator` |
| Ingress and TLS | `betstan-domain-ingress` |
| Shared-Mongo and cross-cloud migration/recovery | `betstan-mongo-migration` |

The retained catalog has thirteen roles, including the optional model-neutral
simplifier. There are no default specialist invocations. The main owner also
owns coordination, process simplification and final acceptance reconciliation;
those responsibilities do not require separate conductor or validator agents.
OCI operator, domain/ingress and Mongo migration remain manual-only.

Application developers edit only their assigned source/test/config paths and
do not perform Git or deployment actions. Infrastructure and public-wiki
editors retain their defined scopes. Governance definitions are edited by an
authorized repository owner, never by an agent expanding its own authority.
Concurrent editors need disjoint ownership and a stable shared contract.
Privileged execution stays with the explicitly authorized operation owner,
subject to executable controls; requesting a specialist opinion grants no
additional permissions.

Every change records documentation impact with exact inspected paths. Update
relevant canonical `docs/wiki/` pages for changed public behavior or guidance,
and assign byte-identical publication after merge. Invoke the wiki editor
only when its expertise is needed; an owner can perform a clear assessment.
Public output must exclude credentials, private records and session paths.
UI changes need evidence of the affected behavior and consistency; use the UX
expert for evidenced design or interaction risk, not a mandatory two-phase
handoff for every visual edit. Precise geometry or dynamic-interaction claims
need the smallest appropriate rendered evidence.

## Evidence and reuse

Identify repository, worktree, exact source/diff, criteria, commands/results,
findings and limitations in the existing task record. Do not consume evidence
from an ambient sibling checkout or silently relabel old results as current.
Bind immutable review/release evidence to its actual source and scope.
Uncommitted development checks may support implementation, but cannot assert
that the eventual committed candidate or deployed runtime has passed.

A pause, lost conversation, new PR, promotion, or ancestry-only reconciliation
does not invalidate accepted source evidence by itself. Verify that the
reviewed paths, relevant dependencies, accepted criteria and policy are still
applicable; a changed aggregate may invalidate a scoped result. Recover the
original report rather than invent a missing verdict. Reopen only affected
evidence and keep corrections with the original owner where available.
Do not rerun unchanged tests merely under a different agent name.

Reuse never substitutes for required current-SHA CI, tested merge-snapshot
provenance, current approval/lock checks, immutable deployed identity,
compatible rollback/recovery, or observed health. Current executable
validators, not this document, determine which CI evidence can be reused.

## Coordination without a conveyor

A task stays with its accountable owner, including observation of parallel,
asynchronous, external or mutating work. Use one active observer per wait.
Use one concise current-state record, not a second ledger. Record the exact
run/process reference, owner, bounded objective, dependencies, last real
milestone, next checkpoint, stop condition and recovery action for active work.
Preserve the original request, workspace, refs and required feature commits.

At startup, resume, notifications and bounded checkpoints, inspect exact jobs
and pending environment gates. Promptly route eligible CLI-owned automatic
approvals through the canonical helpers; human-origin work retains exact
approval. A protected wait timer is an observed wait, not missing consent.
Do not infer progress or completion from a watcher, top-level status, elapsed
time, or tool-call count. After fifteen minutes without decisive progress,
report the concrete blocker, collected evidence and smallest safe next action;
continue authorized monitoring without unrelated make-work.
If no required CI check has succeeded for thirty minutes, inspect the exact
remaining jobs and report the execution/provider/gate blocker. That checkpoint
does not authorize cancellation, a replacement writer or a new agent.

Never replace an operation until its side effects are known and overlapping
writers are excluded. Timeout, runner exit or lease expiry is not proof that
a writer stopped. Never edit live authority, consumed receipts or operational
locks ad hoc. Retained locks/fences require the exact compatible
recovery path. Current source acceptance is not runtime health evidence.
Respect an explicit pause and retain containment and observation.

When an actual transfer is needed, send the existing result directly to the
next owner with scope, source identity, evidence, unresolved findings and the
next action. Corrections stay in the same task; neither an acknowledgement
agent nor a recursive approval round is required. A process simplification
recommendation may be applied directly by the owner without a separate
continuation or acknowledgement review.

## Canonical policy sources

| Concern | Source |
|---|---|
| Contributor, protected branch and origin/approval contract | [CONTRIBUTING.md](../../CONTRIBUTING.md) |
| Conditional role routing and evidence reuse | This README |
| Role-specific scope and capability limits | Individual `*.agent.md` files |
| PR rationale and evidence | [PR template](../pull_request_template.md) |
| Branch procedure | [Branch skill](../skills/betstan-branch-governance/SKILL.md) |
| Publication and credential boundaries | [Security guardrails](../../docs/copilot-security-guardrails.md) |
| Historical lessons, not additional gates | [LEARNINGS.md](../../LEARNINGS.md) |
| Public explanation | [Release orchestration](../../docs/wiki/Release-Orchestration.md), [UI/UX consistency](../../docs/wiki/UI-UX-Consistency.md) |

## Result vocabulary

Keep role-specific result tokens for callers already using them. They describe
the bounded result, not a prescribed next agent or release permission:

| Role | Results |
|---|---|
| Architect | `ARCHITECTURE_READY`, `ARCHITECTURE_CHANGES_REQUIRED`, `DECISION_REQUIRED` |
| UX expert | `UX_SPEC_READY`, `UX_REVIEW_PASSED`, `UX_CHANGES_REQUIRED`, `UX_CLARIFICATION_NEEDED` |
| Implementation | `IMPLEMENTED_LOCAL`, `BLOCKED` |
| Wiki editor | `WIKI_UPDATE_READY`, `WIKI_NO_PUBLIC_CHANGE`, `WIKI_BLOCKED` |
| Simplifier | `SIMPLIFICATION_PROPOSED`, `NO_SIMPLIFICATION_FOUND`, `BLOCKED` |
| Optional synthesis | `SIMPLIFICATION_READY`, `SIMPLIFICATION_DISPUTED`, `SIMPLIFICATION_INCOMPLETE` |
| Test engineer | `SUPPORTING_EVIDENCE_READY`, `TESTS_GREEN`, `TESTS_FAILED`, `APPROVE_SLICE`, `CHANGES_REQUIRED`, `BLOCKED` |
| Deployment safety | `SAFE_TO_REVIEW`, `SAFE_TO_MERGE_DEV`, `SAFE_TO_PROMOTE`, `DEPLOYED_HEALTHY`, `NO_GO` |

Never turn absence of an optional role's token into a blocking gate. Preserve
actual unresolved correctness, authorization, data, provenance and runtime
failures regardless of how a result is presented.
