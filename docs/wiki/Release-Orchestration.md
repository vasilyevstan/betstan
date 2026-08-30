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

## Conductor rules

- Register every agent, local process, workflow, approval, and handoff with one
  owner, an objective, progress signal, checkpoint, recovery action, and stop
  condition.
- Tool calls, logs, and a running watcher are activity, not deliverable
  progress. Agents have a separate first-response deadline.
- A status request is an immediate checkpoint. Inspect exact jobs and
  `pending_deployments`, not only top-level run status.
- One missed checkpoint triggers bounded recovery. Two misses require an
  explicit safe action; do not duplicate mutation-capable work.
- Revalidate late specialist findings against the current SHA, workflow tree,
  and runtime topology.
- When production is the explicit priority, freeze unrelated metadata and
  documentation until the terminal gate.
- If durable learning was requested, activation is followed by a required
  documentation/wiki/agent handoff before task completion.

## GitHub-specific failure prevention

- PR title/body edits trigger protected CI through `pull_request.edited`.
  Never perform them during production exclusivity or the data-to-deploy
  handoff.
- A workflow dispatch URL means the event was accepted; it does not mean a job
  exists. Keep a manually enabled workflow active until the exact run has a job
  and expected protected gate, then disable before approval.
- Capture the run ID from the returned URL. If a local assertion fails after
  dispatch, inspect that exact run before retrying.
- A queued record with zero jobs and zero approvals is not release authority.
- Query upstream artifact names instead of guessing them in a mutation
  preflight.

## Pull request record

Every implementation, promotion, ancestry synchronization, and intentionally
closed PR documents its rationale, exact SHAs, scope and exclusions,
validation outcomes, release impact, rollback evidence, and exceptions.
