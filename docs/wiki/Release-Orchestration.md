# Release Orchestration

## Normal path

1. Focused branch to `dev`.
2. Up-to-date `dev` promotion to `master`.
3. Synchronize the resulting master merge back into `dev`.
4. Build immutable exact-SHA images.
5. Validate GHCR, capacity, and infrastructure evidence.
6. Produce a new exact-SHA final data handoff for every deployment.
   Application or schema changes run dry-run, backfill, and final index in
   order. Only the workflow's validated GitHub/infra/docs-only resume may
   reuse an already applied chain.
7. Deploy immediately from the final handoff.
8. Activate through a bounded lease and commit permanent enablement only after
   complete acceptance.

Never rerun a failed run when downstream evidence requires
`run_attempt == 1`. Preserve it and create a fresh exact candidate or dispatch
as allowed by the owning workflow.

## Quality chain

The universal quality gates are architect, three-model simplifier synthesis,
developer, critic, test engineer, and final validator. The conductor spans that
chain but is not a quality gate. Model passes and same-agent corrections are
intra-gate work. UX and other specialists are conditional evidence providers,
but `betstan-ux-ui-expert` is mandatory for every user-facing visual or
interaction change. Register one two-phase UX work unit: establish the named
consistency baseline before implementation, then review the immutable exact
head in the same agent context. GitHub runs, approvals, external waits, and
durable documentation are monitored supporting units.

Three independent simplifier passes use distinct model families and high
reasoning. One xhigh synthesis produces the only developer-gate handoff. Fewer
than three eligible completed passes blocks the gate, and unresolved material
disagreement is reported rather than averaged away.

## Conductor rules

- Register every agent, local process, workflow, approval, and handoff with one
  owner, an objective, progress signal, checkpoint, recovery action, and stop
  condition.
- Tool calls, logs, and a running watcher are activity, not deliverable
  progress. Agents have a separate first-response deadline.
- A status request is an immediate checkpoint. Inspect exact jobs and
  `pending_deployments`, not only top-level run status.
- Before declaring an executing GitHub job stalled, compare its current step
  and elapsed time with recent successful runs of the same workflow and job on
  a comparable runner. A much faster local run is not a CI baseline.
- One missed checkpoint triggers bounded recovery. Two misses require an
  explicit safe action; do not duplicate mutation-capable work.
- Keep corrections in the same agent context with a bounded attempt count.
  A completed gate without acknowledgement from its exact next owner is a
  stall.
- Revalidate late specialist findings against the current SHA, workflow tree,
  and runtime topology.
- When production is the explicit priority, freeze unrelated metadata and
  documentation until the terminal gate.
- If durable learning was requested, activation is followed by a required
  documentation/wiki/agent handoff before task completion.

## GitHub-specific failure prevention

- PR title/body edits trigger protected CI through `pull_request.edited`.
  Never perform them during production exclusivity or the data-to-deploy
  handoff. Derive the exact head SHA programmatically and prefer one complete
  metadata edit over repeated corrections that start duplicate runs.
- A workflow dispatch URL means the event was accepted; it does not mean a job
  exists. Keep a manually enabled workflow active until the exact run has a job
  and expected protected gate, then disable before approval.
- Capture the run ID through the durable dispatcher intent. If a local process
  fails after the URL is captured, recover that exact run instead of retrying.
- A terminal record with zero jobs and zero pending deployments is not release
  authority; only exact persisted retirement permits replacement.
- Query upstream artifact names instead of guessing them in a mutation
  preflight.

## CLI protected-operation authority

- Classify protected approval by origin, not operation type. Every direct
  Copilot CLI dispatch uses `copilot-cli-dispatch-stan.sh`; a direct human
  `gh workflow run` or scheduled run has no authority record and stays
  personally gated.
- Requests are operation-specific JSON files outside the worktree with mode
  `0600`. They contain every typed workflow input. Boolean request values stay
  typed in the private request and authority record, then normalize to
  lowercase string values for the exact canonical `gh workflow run --json`
  transport bytes whose SHA-256 is bound to the returned run ID.
- Authority state lives outside Git in an owner-only `0700` directory. Before
  invoking GitHub, the dispatcher creates a `dispatching` intent and
  mode-`0600` output capture. The bound record identifies repository,
  operation, workflow ID/path/blob, event, run ID and attempt, current control
  SHA, subject and historical target SHAs, exact title, environment, and input
  hash.
- A captured URL proves event acceptance, not materialization. Bind that exact
  URL to a `claimed` record, issue it only when the exact run appears, use
  `--resume-captured` after a pre-bind crash, and use `--resume-run` after
  delayed materialization. Never redispatch either case. A URL-less capture is
  unresolved external mutation and remains fail-closed; do not infer a run
  from title or time.
- Any unresolved intent or `claimed`/`inflight` record blocks all protected
  dispatches for the same repository and control SHA, even when inputs or the
  operation change. An `issued` or `consumed` record blocks the same operation
  and exact transport input hash. A changed request is distinct but still
  requires complete policy, lineage, recovery, and exclusivity validation;
  only `retired` is an inert replacement exception.
- After creating a pristine intent, revalidate current master, workflow blob,
  and active state. Cancel that untouched intent rather than dispatching if
  authority drifted.
- The policy's approval workflow state is exact. Capacity, infrastructure,
  activation, live-data, migration-recovery, and production-deploy workflows
  must be `disabled_manually` before approval; all other protected workflows
  must be `active`.
- Approval uses an `inflight` claim before mutation and records a consumed
  receipt only after GitHub accepts the POST. An ambiguous response must use
  explicit `--reconcile`. The claim records the exact reviewer, comment,
  environment, downstream run, operation, and matching review-history count
  before mutation. Reconciliation must target that same run and operation.
  Consume only when GitHub reports a new exact approved review; restore retry
  authority only when no review appeared and the same gate remains active.
  Otherwise preserve the inflight ambiguity. Gate disappearance, a terminal
  conclusion, or missing pending evidence does not prove approval.
- Revalidate master, workflow blob/state, and promotion authority after the
  local `inflight` claim. Drift releases the exact claim to its prior state and
  prohibits the approval POST.
- A consumed record cannot replay the same
  run/environment/waiting-job-set fingerprint. It may authorize a different
  sequential job on the same environment and exact run, or a policy-declared
  automatic downstream run such as GHCR build repair or migration recovery.
- `production-build` derives authority from the unique CLI-managed
  `dev -> master` promotion. Normal `oci-production-build` derives from that
  exact first-attempt build. Both receive durable automatic records and the
  same `issued -> inflight -> consumed` receipt lifecycle. GHCR repair and
  failed-migration recovery trace to the exact consumed dispatch record of
  their upstream run.
- A terminal captured run can be `retired` only after exact evidence proves
  zero jobs and zero pending deployments; only persisted retirement permits a
  replacement request. Expired `claimed` and `inflight` records remain
  inspectable for bounded recovery, while other authority remains
  expiry-bound.
- Current control code always equals current `master`. A subject may be the
  deployed release, while rollback or recovery may name an older ancestor as
  target. Historical target authority never permits stale control code.
- Production exclusivity accepts only complete active-run responses: an
  object with nonnegative integer `total_count`, an array of `workflow_runs`,
  exact count/list agreement, and at most the requested 100 results.
- The shared GitHub account is not a separate cryptographic CLI identity. The
  private record is an operational ownership mechanism; never create or
  retrofit one for a human-originated run.

## Pull request record

Every implementation, promotion, ancestry synchronization, and intentionally
closed PR documents its rationale, exact SHAs, scope and exclusions,
validation outcomes, release impact, rollback evidence, and exceptions.
Core evidence is mandatory; conditional operational fields remain present and
say `not applicable` when they do not apply.

Only a CLI-created and CLI-owned PR uses `copilot-cli-managed` and the bounded
no-personal-prompt path. Every other PR requires approval bound to its exact
current head SHA. Neither path waives technical or production gates; see
`CONTRIBUTING.md` for the classifier limitation and exact approval procedure.
