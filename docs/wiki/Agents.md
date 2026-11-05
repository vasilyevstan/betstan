# Agents

## One accountable owner

BetStan's agents are optional capabilities, not a sequence or an approval
hierarchy. The main owner retains scope, implementation, verification,
coordination, eligible approvals, publication and final acceptance.
No default specialist invocation, model quorum, status-only handoff or
review-of-review is required.

[CONTRIBUTING.md](https://github.com/vasilyevstan/betstan/blob/master/CONTRIBUTING.md)
owns branch and origin-bound approval policy; the
[agent README](https://github.com/vasilyevstan/betstan/blob/master/.github/agents/README.md)
owns routing and evidence reuse. Existing executable controls remain
authoritative. Changing these files does not reload a running CLI session.

## Proportionate verification

Ordinary bounded work uses relevant existing tests, inspection or builds.
Documentation changes use applicable link and contract checks. Changes to
authorization, CI trust, release authority, physical writer ownership, data
integrity, migration or recovery require independent verification of that
boundary. The verifier must not be the author.

Independence is a property of the evidence and contributor, not a second role
name. Preserve required current-SHA CI, immutable deployed identity,
production serialization, locks/fences, compatibility and observed health.
Neither a review token nor a document grants deployment permission.

## Retained capabilities

The catalog has thirteen roles, including the optional simplifier.

| Capability | Scope | Mode |
|---|---|---|
| `betstan-architect` | Evidenced cross-service design, dependencies and compatibility decisions | Read-only |
| `betstan-simplifier` | Remove unnecessary scope or process while preserving accepted behavior | Read-only |
| `betstan-backend-developer` | Assigned TypeScript, shared-contract, messaging, data and backend tests | Repository editor |
| `betstan-frontend-developer` | Assigned React, SSE, accessibility, responsive UI and client tests | Repository editor |
| `betstan-test-engineer` | Focused executable verification and adversarial correctness/concurrency review | Read-only |
| `betstan-deployment-safety` | CI quality, protected ancestry, provenance, release and rollback boundaries | Scoped review or authorized repository work |
| `betstan-auth-security-reviewer` | Authentication, identity, sessions and authorization defects | Read-only |
| `betstan-service-contract-reviewer` | Producer/consumer and historical or rolling-version compatibility | Read-only |
| `betstan-ux-ui-expert` | Evidenced design, accessibility, geometry and interaction risk | Read-only |
| `betstan-public-wiki-editor` | Public-safe canonical pages and documentation-impact evidence | Documentation editor, not publisher |
| `betstan-oci-operator` | Exactly authorized OCI operations or read-only health assessment | Manual invocation only |
| `betstan-mongo-migration` | Shared-Mongo and cross-cloud migration/recovery, using their distinct contracts | Manual invocation only |
| `betstan-domain-ingress` | Canonical DNS, TLS, redirects, ingress and load balancing | Manual invocation only |

The former conductor, final validator and process-friction roles are folded
into the owner. CI-quality and branch-governance review belong to deployment
safety; adversarial review belongs to the test engineer. OCI health belongs to
the OCI operator's read-only contract, and cross-cloud recovery belongs to
Mongo migration. Role consolidation does not expand production permissions.

Editors stay within assigned paths. Application developers do not commit,
push, approve, merge or deploy. Governance changes remain with their
authorized repository owner. Manual invocation of a runtime capability is
not authorization to mutate a cluster, data, settings or release state.

## Runtime and data boundaries

Repository-only work requires exact source/diff evidence, not unrelated cloud
access. A health-only OCI assignment remains read-only, uses checked-in
diagnostics and binds infrastructure, deployment, source, images, runtime and
canonical routes. A homepage response or Running broker is not complete health.

Runtime work retains every selected procedure's prerequisites. AKS topology
requirements are not OCI release gates; k3s identity does not require OKE
configuration. In-AKS consolidation retains its backup/reverse-copy model;
cross-cloud no-backup replacement does not inherit it. Interrupted replacement
preserves its original journal, fencing and destructive boundary. Its
unattended recovery identity remains stop-only, and committed cutover is
forward-only.

## Coordination and completion

Keep one concise existing task record: accepted criteria, exact source/diff,
required commits, owned runs, evidence, unresolved effects and next action.
Use one active observer per wait. Inspect actual jobs and pending gates at
startup, resume, notifications and bounded checkpoints; a watcher or growing
tool count is not progress.

The authorized owner promptly handles eligible CLI-origin gates through the
canonical path. Human-origin work keeps exact approval. An approved wait
timer is not missing consent. Do not adopt another owner's operation or
create a second coordinator to pass an approval back.

After fifteen minutes of investigation without decisive progress, report the
concrete blocker and smallest safe next action. If no required CI check has
succeeded for thirty minutes, inspect and report the remaining jobs. These
checkpoints do not authorize cancellation, replacement writers or extra work.
Timeout, runner exit or lease expiry does not prove a physical writer stopped.
Keep ambiguous authority, locks and fences until the supported recovery proves
they can be released.

Once implementation is accepted, freeze feature scope during release. Reopen
only evidence invalidated by a demonstrated failure. Final acceptance belongs
to the owner: every requested outcome, required check and applicable public
publication must be complete. A promoted change is not restored production.

## Evidence reuse and documentation

A crash, pause, new PR, promotion or ancestry reconciliation alone does not
invalidate accepted source review. Recover its actual scope, source, result
and limitations; do not invent evidence or repeat unchanged reviews.
Current exact-SHA CI and runtime/approval controls still apply.

Every change records documentation impact. Use the wiki editor for needed
expertise, not an automatic handoff. Update affected canonical pages with
implementation; the authorized owner publishes accepted merged bytes and
verifies public equality. Keep credentials, private records and session
artifacts out of public output.

User-facing work retains source-bound consistency evidence and the smallest
rendered check needed for an unresolved visual or interaction claim. A
compulsory screenshot matrix or two-phase UX invocation is not required.
Use [[UI UX Consistency]] and [[Engineering Learnings]] for relevant guidance.

Multi-model deliberation is optional unless requested. The owner resolves
disagreements against requirements and evidence; agreement is not proof.

## Related pages

- [[Quality Gates]]
- [[Release Orchestration]]
- [[Security]]
- [[UI UX Consistency]]
- [[Engineering Learnings]]
