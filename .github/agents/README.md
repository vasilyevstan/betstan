# BetStan reusable agent team

These repository agents provide a reusable, independent workflow for feature,
fix, migration, and release-preparation tasks. They complement the existing
specialist agents; they do not replace specialist authority or the approval
mode defined in `CONTRIBUTING.md`.

## Universal quality chain

The fixed quality gates are:

1. `betstan-architect`
2. `betstan-simplifier`
3. **Developer gate**: `betstan-backend-developer` and/or
   `betstan-frontend-developer` for application code, or the authorized
   infrastructure/governance implementation owner for its owned paths
4. `betstan-public-wiki-editor`
5. `betstan-validation-critic`
6. `betstan-test-engineer`
7. `betstan-final-validator`

The conductor spans the workflow but is not a quality gate.
`betstan-ux-ui-expert` is mandatory for every user-facing visual or interaction
change and remains a conditional specialist rather than a universal quality
gate. Register one two-phase specialist work unit: establish the named
product-wide consistency baseline before implementation, then audit the
immutable exact-head result in the same agent context. Other specialists are
registered when their trigger applies. `betstan-deployment-safety` owns branch,
PR, exact-SHA deploy, and rollback decisions; runtime changes remain with the
AKS or OCI operator.

No agent status is permission to merge or deploy. Follow the exact-SHA approval
mode in `CONTRIBUTING.md`: CLI-managed PRs may use the bounded automatic path,
while every other PR requires approval bound to its current head SHA.
Pull request titles use short plain-language outcomes; ambiguous prefixes such
as `chore`, `misc`, or `wip` are not accepted.

## Work-unit taxonomy

- A **quality gate** is one stage in the universal chain and produces one
  accepted downstream handoff.
- The **developer gate** means the registered implementation owner with edit
  authority for the slice. It is not an exemption for non-application work:
  backend/frontend agents own application paths, deployment/runtime
  specialists own their infrastructure paths, the public-wiki editor owns
  canonical public documentation, and the human/orchestrator owns governance
  definitions.
- **Intra-gate work** stays under the same logical gate and `work_id`. The three
  simplifier passes, simplifier synthesis, and same-developer correction rounds
  are not additional quality-chain handoffs.
- A **conditional specialist** supplies evidence to the owning quality gate;
  it does not insert itself into the universal chain or issue a competing
  approval.
- A **registered supporting unit** is an agent, local process, GitHub run,
  protected approval, external wait, or post-merge publication task monitored
  by the conductor.
- The **public-wiki gate** assesses every change. It updates the canonical
  public documentation whenever behavior, architecture, operations, UI,
  quality, release, or agent responsibilities change; a no-change result
  requires exact-diff evidence.

Only a completed logical quality gate hands work to the exact next gate.
Corrections return to the same agent conversation unless that owner has failed
or become unavailable.

## Canonical policy sources

| Concern | Source |
|---|---|
| Repository entry point and irreversible rules | `.github/copilot-instructions.md` |
| Quality chain, handoffs, and statuses | This README |
| Watchdog and recovery behavior | `betstan-conductor.agent.md` |
| Simplifier pass and synthesis decisions | `betstan-simplifier.agent.md` |
| PR evidence structure | `.github/pull_request_template.md` |
| Branch, approval, and contribution policy | `CONTRIBUTING.md` |
| UI/UX consistency method | `docs/wiki/UI-UX-Consistency.md` |
| Human-readable release flow | `docs/wiki/Release-Orchestration.md` |

Secondary agents and skills cite these sources instead of redefining complete
policy blocks.

## Conductor loop

Start `betstan-conductor` before every unit whose result can block, approve,
satisfy a gate, authorize mutation, or become dependency evidence, including
short synchronous work. Register each unit with one owner, a bounded objective,
dependencies, an exact private runtime reference, repository provenance when
applicable, a progress signal, a checkpoint, a next-check trigger, and a stop
condition. Keep those references in private session handoffs, not repository
files or public reports.

The conductor monitors completion events and bounded checkpoints rather than
tight-polling. A still-running `gh run watch` is notification transport, not
evidence of progress, and may not outlive the registered checkpoint without an
independent jobs and `pending_deployments` inspection. A user asking for status
or whether work is stuck triggers that checkpoint immediately.

Before classifying an executing GitHub job as stalled, compare its current step
and elapsed time with recent successful runs of the same workflow and job on a
comparable runner. A local runtime is not a CI duration baseline. Historical
duration can prevent a false stall classification, but it cannot excuse a
missed progress signal, pending approval, failed step, or unaccepted handoff.

For agents, tool-call growth is activity rather than deliverable progress.
Every agent has a separate first-response deadline. Zero completed turns at
that deadline triggers one bounded instruction to stop further investigation
and return the verdict already supported by collected evidence. A second miss
closes advisory read-only work as unavailable and routes its gate to an
existing authoritative owner; mandatory evidence blocks only its dependants
while all dependency-safe work continues.

An explicit user request to prioritize production establishes a critical-path
scope freeze. Continue required safety work, but defer unrelated documentation,
PR metadata, and advisory expansion until the production gate is terminal.
Pull-request metadata edits are workflow-producing when validation subscribes
to `pull_request.edited`; register those runs and never create them inside a
data-to-deploy handoff or production-exclusivity window.

For manually disabled workflows, a workflow dispatch URL is acceptance, not
materialization. Capture the exact run ID from the URL, keep the workflow
enabled until the run has a real job and expected `pending_deployments` gate,
then disable it before approval. If a command fails after printing a URL,
inspect that run before dispatching again. A jobless queued record with no jobs
or approvals is inert evidence, not release authority.

Revalidate a late specialist result against its recorded SHA, current workflow
tree, and runtime topology before accepting it. A result that arrives after
those authorities changed cannot block the critical path with stale
assumptions.

The conductor remains proactive from before a registered job starts through
its terminal evidence and accepted downstream handoff. Every event trigger is
paired with a maximum wall-clock checkpoint. On notification, restart, status
request, or checkpoint it reconciles the complete active registry, reconstructs
lost observation from exact underlying references, and assigns the next
bounded check. A completed unit with no confirmed next-owner handoff is itself
a stall; a still-running watcher never closes conductor ownership.

A GitHub `waiting` run or job is an immediate action trigger. The conductor
checks its exact jobs and `pending_deployments` in the same checkpoint and
routes an eligible CLI-owned gate through the checked-in automatic approval
path before retaining any watcher; human-originated gates remain personal.

At the first missed checkpoint the conductor restores read-side monitoring,
classifies the underlying job, and routes any mutation to one exact owner with
a deadline. At the second missed checkpoint it escalates the same unit instead
of resetting the timer, waiting longer, or launching a duplicate. A healthy
status is forbidden while a checkpoint, acknowledgement, actionable gate, or
handoff is overdue; orchestration completes only when every registered unit
has terminal evidence and an accepted handoff.

A gate that finishes without immediately naming and obtaining acknowledgement
from its exact next owner is stalled. Correction rounds remain inside the same
logical gate and agent context. Every gate records a bounded correction budget;
exhausting it produces one precise blocker instead of another replacement
agent, summary relay, or silent deadline extension.

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

Every change includes the public-wiki gate before immutable review. After
merge, a registered publication handoff publishes the canonical
`docs/wiki/*.md` files byte-identically and verifies the public pages.
Orchestration is incomplete until relevant Markdown, reusable agents,
PR/release evidence, wiki publication, and todos are updated and validated.

## Three-model simplifier gate

The parent/orchestrator launches three sealed, independent
`betstan-simplifier` passes from distinct model families. Each pass receives the
same requirements, architecture, scope, and code evidence, requests high
reasoning, and cannot see the other pass reports.

The conductor registers those attempts and the synthesis under one logical
simplifier `work_id`; they are intra-gate work, not three reviewer handoffs.
For each pass, record:

```yaml
pass_id: <stable-id>
model_id: <exact-model>
model_family: <distinct-family>
requested_reasoning: high
actual_reasoning: <reported-level-or-not-exposed>
status: SIMPLIFICATION_PROPOSED|NO_SIMPLIFICATION_FOUND|BLOCKED
artifact: <private-reference>
```

If a provider fails, the parent may make a bounded substitution using another
distinct family. A `BLOCKED` pass is attempt evidence, not a completed family;
only `SIMPLIFICATION_PROPOSED` and `NO_SIMPLIFICATION_FOUND` are eligible for
synthesis. Fewer than three eligible completed families returns
`SIMPLIFICATION_INCOMPLETE`; there is no degraded 2-of-3 handoff.

One model-neutral simplifier invocation synthesizes the three sealed reports.
It requests xhigh reasoning when supported and records the highest actual
supported level. `betstan-simplifier.agent.md` is the sole source for
adjudication, protected criteria, and disputed-result rules.

The synthesis artifact records `synthesis_model_id`,
`synthesis_model_family`, `requested_reasoning: xhigh`,
`actual_reasoning`, all three `pass_id` values, the terminal status, and the
accepted/rejected recommendations.

Only `SIMPLIFICATION_READY` produces the single artifact handed to the
developer. The three pass reports remain auditable evidence for final
validation.

## Ownership

| Area | Editor |
|---|---|
| `common/**` and backend service source/tests/manifests | `betstan-backend-developer` |
| `client/src/**`, `client/public/**`, and client tests/config | `betstan-frontend-developer` |
| `infra/**`, workflows, Dockerfiles, runtime proxy config | Existing deployment/runtime specialists |
| `README.md`, `docs/wiki/**`, and public-documentation contract tests | `betstan-public-wiki-editor` |
| `.github/agents/**`, skills, governance docs | Human/orchestrator acting as the developer-gate implementation owner; agents never edit their own definitions |

Developers are file editors, not git actors. They never stage, commit, switch,
merge, rebase, push, open a PR, or dispatch a workflow. Concurrent editors are
allowed only with disjoint ownership and a stable shared contract.

## Specialist routing

- Active-work coordination: `betstan-conductor`
- Public documentation assessment, canonical wiki updates, and publication
  safety: `betstan-public-wiki-editor`
- Every user-facing visual or interaction change, including hierarchy,
  cross-page consistency, accessibility, responsive density, state
  presentation, and interaction behavior: `betstan-ux-ui-expert`
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
to_agent: betstan-public-wiki-editor
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
  required_commit_shas: []
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
  root_task_authority_id: <stable-root-authority-id>
  work_id: <stable-kebab-id>
  logical_gate: <architect|simplifier|developer|public-wiki|critic|test|final-validator>
  unit_class: <quality-gate|intra-gate|specialist|supporting>
  parent_work_id: <stable-kebab-id-or-null>
  owner: <single-owner>
  dependencies: []
  attempt: <positive-integer>
  max_attempts: <positive-integer>
  progress_signal: <delivered-turn-status-artifact-or-objective-state>
  activity_signal: <tool-count-log-heartbeat-or-null>
  first_response_due_at: <utc-or-not-applicable>
  checkpoint_due_at: <utc>
  next_check_trigger: <event-or-time>
  stop_condition: <terminal-result>
  handoff_ack_due_at: <utc-or-not-applicable>
```

Required invariants:

- Every authority-bearing unit is registered regardless of synchronous or
  background execution, with one owner, a checkpoint, a maximum checkpoint
  interval, a recovery action, a stop condition, and required terminal
  evidence.
- Every handoff preserves the original `root_task_authority_id`; it may narrow
  scope but cannot redefine repository, workspace, or required feature
  commits. A release head may advance only to protected current `master` after
  ancestry and complete-candidate revalidation.
- Every quality gate has one logical `work_id`, one exact next owner, and a
  bounded correction count.
- Three simplifier pass records use distinct model families and one synthesized
  `SIMPLIFICATION_READY` artifact before development starts.
- No replacement unit starts while the original can still produce side effects.
- `out_of_ownership_touched` is empty.
- A critic receives a non-null immutable `head_sha`.
- Every prior blocking finding is resolved with evidence before approval.
- Every user-facing change has one exact-head `UX_REVIEW_PASSED` result whose
  consistency matrix names its stable references, required fixes, and accepted
  intentional exceptions.
- Every change has `WIKI_UPDATE_READY` or a justified
  `WIKI_NO_PUBLIC_CHANGE`; relevant canonical pages are included before the
  critic reviews the immutable candidate.
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
| UX/UI expert | `UX_SPEC_READY`, `UX_REVIEW_PASSED`, `UX_CHANGES_REQUIRED`, `UX_CLARIFICATION_NEEDED` |
| Developer gate | `IMPLEMENTED_LOCAL`, `BLOCKED` |
| Public wiki editor | `WIKI_UPDATE_READY`, `WIKI_NO_PUBLIC_CHANGE`, `WIKI_BLOCKED` |
| Simplifier pass | `SIMPLIFICATION_PROPOSED`, `NO_SIMPLIFICATION_FOUND`, `BLOCKED` |
| Simplifier synthesis | `SIMPLIFICATION_READY`, `SIMPLIFICATION_DISPUTED`, `SIMPLIFICATION_INCOMPLETE` |
| Validation critic | `APPROVE_SLICE`, `CHANGES_REQUIRED` |
| Test engineer | `TESTS_GREEN`, `TESTS_FAILED`, `BLOCKED` |
| Final validator | `READY_FOR_RELEASE_REVIEW`, `NO_GO` |

Status lines should be namespaced with the agent name. Final validation is
evidence for deployment safety, not a release action. Conductor status is
coordination evidence, not specialist or release approval.

The developer-gate handoff uses `IMPLEMENTED_LOCAL` or `BLOCKED` regardless of
which authorized implementation owner edited the slice. Specialist decision
tokens remain separate evidence.
