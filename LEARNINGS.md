# BetStan engineering lessons

This is a concise working guide, not a second delivery policy.
[CONTRIBUTING.md](CONTRIBUTING.md) owns branch and approval rules;
[agent routing](.github/agents/README.md) owns capabilities and evidence reuse.
Historical details are retained in
[Engineering Learnings](docs/wiki/Engineering-Learnings.md).

## Ownership and delivery

- Keep one accountable owner through implementation, required verification,
  eligible approvals, publication and the actual requested outcome.
- Add work only for an unmet criterion, explicit safeguard or evidenced
  blocker. Reuse accepted evidence; a new PR or interrupted session is not a
  reason to repeat unchanged reviews or launch another coordinator.
- Inspect exact jobs and pending gates. Eligible CLI-owned work uses canonical
  automatic approval; human-origin work requires exact approval.
- After fifteen minutes of investigation without decisive progress, report
  the concrete blocker and smallest safe action. Continue bounded observation;
  do not invent unrelated work while waiting.
- A merged fix, green build or finished watcher is not restored production.
  Report source acceptance, deployment, activation and observed health separately.

## Shared contracts and packages

- Common source is a normal tracked directory, not a submodule. Its candidate
  version and consumers' installed immutable package versions are distinct.
- Validate packed bytes, exports, lock-exact consumers and old/new rolling
  combinations. Never substitute a local tarball install that rewrites locks
  for evidence about deployed dependencies.
- Teach readers a new durable value before activating its producer, and keep
  a compatible validated rollback baseline. Remove temporary bridges only
  after their supported consumers have migrated.

## Messaging and persistence

- Persist enough publication state to recover a committed write after broker
  failure or restart. Same-process coalescing is not global exactly-once delivery.
- Treat duplicate, delayed and reordered events as ordinary inputs. Preserve
  immutable domain time and identity across transport retries.
- Broker readiness is not consumer readiness. Exercise real consume callbacks,
  acknowledgement limits, prefetch setup failure and shutdown behavior.
- Keep SSE buffering bounded and pair intentional disconnects with unsubscribe,
  REST/reconnect recovery and monotonic sequence reconciliation.

## Atomic data lifecycle

- Scope draft mutations by identity, owner, kind, state, revision and
  fingerprint in the atomic predicate. Reusable Mongo predicates need explicit
  logical composition; duplicate object keys can silently erase a guard.
- Handle versionless historical rows, empty terminal aggregates and recovery
  between durable publication and archival.
- Redelivered declines must not reset a newer submitted or archived draft.
  Compatibility evidence is session/user/aggregate-bound, never global.
- Fixed repairs bind the exact preimage and intended target, reject unknown
  partial states and preserve rollback evidence before mutation.

## Betting and simulation integrity

- Persist deterministic simulation transitions and use independent random
  streams. Restart must not choose a different authoritative outcome.
- One quote identity must map to one validity interval. A material authority
  change creates a new quote version even when displayed prices are unchanged.
- Compare immutable submission time with expiry and the earliest suspension,
  replacement or terminal boundary; cover equality and out-of-order history.
- Use exact selection and incident relation IDs, never side/position or
  team/time heuristics. Visible market limits do not delete settlement history.

## UI, timelines and access

- Preserve selection identity and pointer/keyboard stability when presentation
  order changes. Follow product-wide tokens and composition, not isolated cards.
- Claim complete history only with valid cumulative producer evidence; legacy,
  malformed or partial inputs remain explicitly partial.
- Verify unresolved geometry on the rendered parent layout and relevant
  breakpoints. Source inspection is not a clipping or alignment measurement.
- Navigation visibility is not feature access. Verify real data and intended
  actions for the requested anonymous, ordinary and privileged states.

## Authorization and fixtures

- Revalidate persisted roles, ownership and server-side fixture scope.
  Uninitialized or unauthorized placeholders stay dark; clients evict hidden
  state after authorization loss.
- Keep synthetic acceptance fixtures bounded and isolated from ordinary
  REST/SSE and financial records. A failed probe must not leave untracked data.
- Distinguish mock-browser behavior from served immutable assets and a real
  end-to-end financial journey. Do not add retries to disguise stale authority.
- Never expose credentials, private records, local/session paths or raw
  infrastructure evidence in commits, logs, screenshots or wiki pages.

## Tests and CI trust

- Use existing focused checks first and reproduce the actual failing boundary.
  Test fixtures must match production command schemas, clocks, source identity
  and first-attempt metadata rather than bypassing the behavior under test.
- Preserve API context prototypes in Actions mocks; object spread can lose
  inherited getters. Check all native runs, including jobless definition failures.
- Keep tested source, native event identity and trusted signer/control identity
  separate. A candidate's self-declared signer is not trust.
- Publisher and reader protocols must migrate together. Preserve legacy
  readers, tombstones and spent authority; unknown evidence fails closed.
- V4 quality binds exact source and a successful run, not mutable PR metadata.
  V3 still requires its label ledger and timestamp freshness.
- `cancel-in-progress: false` alone retains only one pending Actions run.
  The policy publisher uses supported `queue: max` to retain a bounded queue;
  event chronology still comes from authenticated transition evidence.
- Every PR-routed focused suite must also be suite-gate classified. Unclassified
  infra paths force every heavy master suite and can cost minutes per build.

## Release and recovery

- Prove required commits are ancestors of exact current protected source.
  Additional protected features are allowed; production mutations stay serialized.
- Validate the whole prerequisite chain before issuing one-use authority.
  Captured dispatch proves acceptance, not materialization or safe execution.
- Preserve control, subject, historical target and checkpoint-source identities.
  Equal artifact bytes do not replace the bound original run lineage.
- Ambiguous dispatch/approval remains fenced until canonical reconciliation.
  Never replay a consumed request, reset receipts or edit authority ad hoc.
- Timeout, runner exit or lease expiry does not prove a physical writer stopped.
  Keep locks/fences and use the exact compatible held-recovery path.
- Data handoff is not completion. Validate the same run's handoff before cleanup,
  deploy exact images, and release the database lock before the public fence.
- Persisted local file seals bind the inode, never `st_dev`: macOS renumbers
  APFS devices on reboot. Fix recurring authority defects; do not bypass them.
- Recovery lineage must compose: a failure after a resume, of any profile,
  inherits the original capture root. Test repeated failures, not only one.
- A post-claim revalidation must not treat its own claim as a foreign
  generation. Test pre- and post-claim passes with a real intent present.
- Removing environment reviewers changes run timing: runs start or finish
  before materialization, and pre-runtime failures can occur at admission.
  Test ungated in-progress, terminal and chained-receiver paths explicitly.

## Infrastructure and evidence

- Check positive maintenance state and rollout order before assuming provider
  failure. Read failures mean unknown, not missing or unlocked resources.
- Preserve exact image/platform provenance, retained volume identity and
  runtime-specific contracts. Do not mix AKS, OKE and k3s prerequisites.
- Keep shared-Mongo backup recovery distinct from no-backup cross-cloud
  replacement. After committed cutover, recover forward, not from stale data.
- Bound external reads and retries, retain complete authenticated evidence and
  reject contradictory or partial output. Poll terminal workload conditions,
  not a transient counter; cleanup must not erase the failure evidence.
- Verify API response shape, restart history, consumers and canonical routes.
  Billing closure and resource deletion also need their own terminal evidence.
