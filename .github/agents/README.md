# BetStan reusable agent team

These repository agents provide a reusable, independent workflow for feature,
fix, migration, and release-preparation tasks. They complement the existing
specialist agents; they do not replace specialist authority or user approval.

## Core workflow

1. `betstan-conductor` registers active work, follows dependencies, monitors
   bounded progress, and escalates suspected stalls.
2. `betstan-architect` maps the solution and routes specialist decisions.
3. `betstan-simplifier` removes unnecessary scope without changing accepted
   behavior.
4. `betstan-ux-ui-expert` specifies responsive, accessible, measurable
   usability for user-facing slices.
5. `betstan-backend-developer` and `betstan-frontend-developer` implement
   disjoint, bounded slices.
6. `betstan-validation-critic` reviews each immutable slice diff.
7. `betstan-test-engineer` independently executes targeted and regression tests.
8. `betstan-final-validator` checks acceptance and evidence completeness.
9. `betstan-deployment-safety` owns branch, PR, exact-SHA deploy, and rollback
   decisions. Runtime changes remain with the AKS or OCI operator.

No agent status is permission to merge or deploy. Exact user approval is still
required for the target SHA and complete production-capable workflow set.

## Conductor loop

Start `betstan-conductor` before parallel agents, background validation, or a
long GitHub Actions operation. Register each unit with one owner, a bounded
objective, dependencies, an exact private runtime reference, a progress signal,
a checkpoint, a next-check trigger, and a stop condition. Keep those references
in private session handoffs, not repository files or public reports.

The conductor monitors completion events and bounded checkpoints rather than
tight-polling. A still-running `gh run watch` is notification transport, not
evidence of progress, and may not outlive the registered checkpoint without an
independent jobs and `pending_deployments` inspection. A user asking for status
or whether work is stuck triggers that checkpoint immediately.

Recent tool/log/job progress means active work; an environment approval wait is
external progress, not a hang, but it is an immediate actionable gate. A
terminal job followed by a downstream `waiting` job with no executing step must
be classified before waiting again. For every dispatched run and state
transition, the conductor checks jobs plus `pending_deployments`. It immediately
hands a documented, preauthorized approval to the orchestrator, or names the
human approval owner and blocks; it never leaves the gate until a later routine
checkpoint. One missed checkpoint is a suspected stall. Two missed checkpoints
require an explicit safe recovery action. Never replace a slow unit until the
original is terminal or cancelled and overlapping side effects are impossible.

A failed release run whose consumers require `run_attempt == 1` is terminal;
rerunning it cannot create valid provenance. The conductor inspects the failed
step once, preserves the run as evidence, and routes a fresh exact-master
candidate through the normal branch path. It never invents an empty commit or
bypasses a trusted publisher that prevents a workflow from approving its own
change.

A terminal release run can still leave an intentional maintenance fence,
operation lock, zero-replica workload, or unavailable ingress. The conductor
treats that state as an active production incident and routes the exact runtime
owner to restore service or complete the verified handoff before starting a
replacement candidate.

## Ownership

| Area | Editor |
|---|---|
| `common/**` and backend service source/tests/manifests | `betstan-backend-developer` |
| `client/src/**`, `client/public/**`, and client tests/config | `betstan-frontend-developer` |
| `infra/**`, workflows, Dockerfiles, runtime proxy config | Existing deployment/runtime specialists |
| `.github/agents/**`, skills, governance docs | Human/orchestrator; agents never edit their own definitions |

Developers are file editors, not git actors. They never stage, commit, switch,
merge, rebase, push, open a PR, or dispatch a workflow. Concurrent editors are
allowed only with disjoint ownership and a stable shared contract.

## Specialist routing

- Active-work coordination: `betstan-conductor`
- User-facing hierarchy, accessibility, and responsive density:
  `betstan-ux-ui-expert`
- Shared contracts and mixed versions: `betstan-service-contract-reviewer`
- CI, coverage, and false-green gates: `betstan-quality-gate-reviewer`
- Branch policy and ancestry: `betstan-branch-governance-reviewer`
- Auth/session vulnerabilities: `betstan-auth-security-reviewer`
- Mongo migration/recovery: `betstan-mongo-migration` and
  `betstan-migration-recovery`
- Ingress/TLS: `betstan-domain-ingress`
- Deployment/rollback: `betstan-deployment-safety`
- Live runtime: `betstan-aks-operator`, `betstan-oci-operator`, and
  `betstan-oci-health-reviewer`

General agents cite and defer to specialist decisions rather than issuing
competing approvals.

## Handoff

Use a named workflow artifact or private session artifact. Never put session
paths, credentials, private identifiers, or production records in a handoff.

```yaml
handoff_id: <slice>-<from-agent>-<utc>
slice_id: <stable-kebab-id>
from_agent: betstan-backend-developer
to_agent: betstan-validation-critic
status: IMPLEMENTED_LOCAL
blocked_reason: null

scope:
  todo: <bounded work>
  acceptance_criteria: []
  out_of_scope: []

baseline:
  branch: <branch>
  base_sha: <40-hex>
  head_sha: <40-hex-or-null>
  ancestry_verified: true

ownership:
  owned_paths: []
  paths_touched: []
  out_of_ownership_touched: []
  lockfiles_changed: []

effects:
  contract_changes: []
  database_changes: []
  message_changes: []
  feature_flags: []

validation:
  commands: []
  not_run: []

findings:
  open: []
  resolved: []

risks: []
approvals: []

orchestration:
  work_id: <stable-kebab-id>
  owner: <single-owner>
  dependencies: []
  progress_signal: <event-or-state>
  checkpoint_due_at: <utc>
  next_check_trigger: <event-or-time>
  stop_condition: <terminal-result>
```

Required invariants:

- Every parallel/background unit is registered with one owner, a checkpoint,
  and a stop condition.
- No replacement unit starts while the original can still produce side effects.
- `out_of_ownership_touched` is empty.
- A critic receives a non-null immutable `head_sha`.
- Every prior blocking finding is resolved with evidence before approval.
- `from_agent` never appears in `approvals`.
- Feature flags remain dark until the approved activation gate.
- Draft writes/deletes require owner, kind, status, and board-identity CAS;
  decline replay never rewinds a progressed replacement.
- Historical live approval requires immutable submission before both quote
  expiry and the persisted authority-ending transition.
- Privileged access is revalidated against persisted auth state; JWT role
  claims and client-side filtering are not authorization boundaries.
- Synthetic acceptance data is offline and server-scoped to exact IDs.
- A production activation remains leased until acceptance evidence and final
  provenance revalidation succeed; failure and disable clear both flag and
  lease.

## Status vocabulary

| Agent | Status |
|---|---|
| Conductor | `ORCHESTRATION_HEALTHY`, `ATTENTION_REQUIRED`, `BLOCKED`, `ORCHESTRATION_COMPLETE` |
| Architect | `ARCHITECTURE_READY`, `ARCHITECTURE_CHANGES_REQUIRED`, `DECISION_REQUIRED` |
| UX/UI expert | `UX_SPEC_READY`, `UX_CHANGES_REQUIRED`, `UX_CLARIFICATION_NEEDED` |
| Backend/frontend developer | `IMPLEMENTED_LOCAL`, `BLOCKED` |
| Simplifier | `SIMPLIFICATION_PROPOSED`, `NO_SIMPLIFICATION_FOUND` |
| Validation critic | `APPROVE_SLICE`, `CHANGES_REQUIRED` |
| Test engineer | `TESTS_GREEN`, `TESTS_FAILED`, `BLOCKED` |
| Final validator | `READY_FOR_RELEASE_REVIEW`, `NO_GO` |

Status lines should be namespaced with the agent name. Final validation is
evidence for deployment safety, not a release action. Conductor status is
coordination evidence, not specialist or release approval.
