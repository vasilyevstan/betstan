# Agents

## One accountable owner

BetStan's agents are optional capabilities, not a sequence or an approval
hierarchy. One accountable owner retains scope, implementation, verification,
coordination, eligible approvals, publication and final acceptance. The
optional `betstan-delivery-coordinator` can act as that owner; it is never a
supervisor above another owner. No default specialist invocation, model
quorum, status-only handoff or review-of-review is required.

[CONTRIBUTING.md](https://github.com/vasilyevstan/betstan/blob/master/CONTRIBUTING.md)
owns branch and origin-bound approval policy; the
[agent README](https://github.com/vasilyevstan/betstan/blob/master/.github/agents/README.md)
owns routing and evidence reuse. Existing executable controls remain
authoritative. Changing these files does not reload a running CLI session.

## Proportionate verification

Ordinary bounded work uses relevant existing tests, inspection or builds.
Changes to authorization, CI trust, release authority, physical writer
ownership, data integrity, migration or recovery require independent
verification of that boundary; the verifier must not be the author.
Required current-SHA CI, immutable deployed identity, production
serialization, locks/fences, compatibility and observed health always apply.
Neither a review token nor a document grants deployment permission.

## Active capabilities

The catalog has nine roles.

| Capability | Scope | Mode |
|---|---|---|
| `betstan-delivery-coordinator` | Optional single owner: discovers source and ownership, applies design and scope checks, delegates, observes waits, stops at a verified outcome or evidenced blocker | Owner; uses canonical helpers |
| `betstan-backend-developer` | Assigned TypeScript, shared-contract, messaging, data and backend tests | Repository editor |
| `betstan-frontend-developer` | Assigned React, SSE, accessibility, responsive UI and client tests | Repository editor |
| `betstan-test-engineer` | Focused executable verification, adversarial correctness/concurrency review, shared-contract and mixed-version compatibility | Read-only |
| `betstan-auth-security-reviewer` | Authentication, identity, sessions and authorization defects | Read-only |
| `betstan-ux-ui-expert` | Evidenced design, accessibility, geometry and interaction risk | Read-only |
| `betstan-public-wiki-editor` | Public-safe canonical pages and documentation-impact evidence | Documentation editor, not publisher |
| `betstan-deployment-safety` | CI quality, protected ancestry, provenance, release, rollback, shared-Mongo locks and historical migration recovery | Scoped review or authorized repository work |
| `betstan-oci-operator` | Exactly authorized OCI operations, canonical DNS/TLS/ingress routing, or read-only health assessment | Manual invocation only |

Consolidation moved capabilities without expanding permissions: architect and
simplifier checks became the coordinator's inline design and scope checks;
service-contract review joined the test engineer; domain ingress joined the
OCI operator. The retired-AKS shared-Mongo migration role is archived verbatim
under `archive/azure/github-agents/` as a recovery reference, and deployment
safety carries its active journal, lock, fence and forward-only recovery
obligations. A disabled workflow alone does not retire a recovery obligation.

Editors stay within assigned paths. Application developers do not commit,
push, approve, merge or deploy. Manual invocation of a runtime capability is
not authorization to mutate a cluster, data, settings or release state.

## Runtime and data boundaries

Repository-only work requires exact source/diff evidence, not cloud access. A
health-only OCI assignment remains read-only, uses checked-in diagnostics and
binds infrastructure, deployment, source, images, runtime and canonical
routes. A homepage response or Running broker is not complete health. AKS
topology requirements are not OCI release gates. Interrupted cross-cloud
replacement preserves its original journal, fencing and destructive boundary;
its unattended recovery identity remains stop-only, and committed cutover is
forward-only.

## Coordination and completion

Keep one concise task record: accepted criteria, exact source, required
commits, owned runs, evidence and next action. Use one active observer per
wait; inspect actual jobs and pending gates at startup, resume and bounded
checkpoints. Report a definitive job failure as soon as it is known.

The owner promptly handles eligible CLI-origin gates through the canonical
path; human-origin work keeps exact approval. Ownership and authority
receipts are always required, while provider environment reviewers or wait
timers apply only where they are actually configured. Do not adopt another
owner's operation.

After fifteen minutes without decisive progress, report the blocker and
smallest safe next action; this never authorizes cancellation, replacement
writers or extra work. Timeout, runner exit or lease expiry does not prove a
physical writer stopped. Once implementation is accepted, freeze feature
scope during release. A promoted change is not restored production.

## Evidence reuse and documentation

A crash, pause, new PR, promotion or ancestry reconciliation alone does not
invalidate accepted source review; current exact-SHA CI and runtime controls
still apply. Every change records documentation impact; the wiki editor is
optional expertise, not an automatic handoff. The authorized owner publishes
accepted merged bytes and verifies public equality.

User-facing work retains source-bound consistency evidence and the smallest
rendered check needed for an unresolved claim; see [[UI UX Consistency]] and
[[Engineering Learnings]]. Multi-model deliberation is optional; agreement is
not proof.

## Related pages

- [[Quality Gates]]
- [[Release Orchestration]]
- [[Security]]
- [[UI UX Consistency]]
- [[Engineering Learnings]]
