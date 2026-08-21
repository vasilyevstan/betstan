# BetStan reusable agent team

These repository agents provide a reusable, independent workflow for feature,
fix, migration, and release-preparation tasks. They complement the existing
specialist agents; they do not replace specialist authority or user approval.

## Core workflow

1. `betstan-architect` maps the solution and routes specialist decisions.
2. `betstan-simplifier` removes unnecessary scope without changing accepted
   behavior.
3. `betstan-backend-developer` and `betstan-frontend-developer` implement
   disjoint, bounded slices.
4. `betstan-validation-critic` reviews each immutable slice diff.
5. `betstan-test-engineer` independently executes targeted and regression tests.
6. `betstan-final-validator` checks acceptance and evidence completeness.
7. `betstan-deployment-safety` owns branch, PR, exact-SHA deploy, and rollback
   decisions. Runtime changes remain with the AKS or OCI operator.

No agent status is permission to merge or deploy. Exact user approval is still
required for the target SHA and complete production-capable workflow set.

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
```

Required invariants:

- `out_of_ownership_touched` is empty.
- A critic receives a non-null immutable `head_sha`.
- Every prior blocking finding is resolved with evidence before approval.
- `from_agent` never appears in `approvals`.
- Feature flags remain dark until the approved activation gate.

## Status vocabulary

| Agent | Status |
|---|---|
| Architect | `ARCHITECTURE_READY`, `ARCHITECTURE_CHANGES_REQUIRED`, `DECISION_REQUIRED` |
| Backend/frontend developer | `IMPLEMENTED_LOCAL`, `BLOCKED` |
| Simplifier | `SIMPLIFICATION_PROPOSED`, `NO_SIMPLIFICATION_FOUND` |
| Validation critic | `APPROVE_SLICE`, `CHANGES_REQUIRED` |
| Test engineer | `TESTS_GREEN`, `TESTS_FAILED`, `BLOCKED` |
| Final validator | `READY_FOR_RELEASE_REVIEW`, `NO_GO` |

Status lines should be namespaced with the agent name. Final validation is
evidence for deployment safety, not a release action.
