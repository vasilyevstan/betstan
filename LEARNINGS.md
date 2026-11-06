# BetStan engineering lessons

Working guide, not policy. [CONTRIBUTING.md](CONTRIBUTING.md) owns delivery rules; [agent routing](.github/agents/README.md) owns roles. History lives in [Engineering Learnings](docs/wiki/Engineering-Learnings.md).

## Delivery

- One owner through the real outcome. A merged fix, green build or finished watcher is not restored production; report source, deploy, activation and health separately.

## Shared contracts

- `common/` is a tracked directory, not a submodule; its candidate version differs from consumers' installed pins. Validate packed bytes and lock-exact rolling combinations.
- Teach readers a new value before activating its producer; remove bridges only after consumers migrate.

## Messaging and persistence

- Persist publication state to recover committed writes after broker failure; in-process coalescing is not exactly-once.
- Duplicates, delays and reordering are normal; keep immutable domain time and identity.
- Broker readiness is not consumer readiness; test real consume callbacks, ack limits and shutdown. Bound SSE buffers; reconnect via monotonic sequence.

## Atomic data

- Scope draft mutations by identity, owner, kind, state, revision and fingerprint atomically; combine reusable Mongo predicates explicitly (duplicate keys erase guards).
- Handle versionless rows, empty terminal aggregates and recovery between publication and archival. Redelivered declines never reset newer drafts.
- Repairs bind exact preimage and target and keep rollback evidence.

## Betting integrity

- Persist deterministic simulation transitions; restarts never pick a different outcome.
- One quote identity must map to one validity interval; a material change creates a new quote version even with unchanged prices.
- Compare submission time with expiry and the earliest authority-ending boundary, including equality.
- Use exact selection/incident IDs, never side or position heuristics.

## UI, timelines and access

- Preserve selection identity and focus when order changes; follow product-wide tokens.
- Claim complete history only with valid cumulative producer evidence; partial inputs stay partial.
- Measure unresolved geometry on the rendered layout. Navigation visibility is not feature access.

## Authorization and fixtures

- Revalidate persisted roles server-side; unauthorized placeholders stay dark; clients evict on revocation.
- Keep synthetic fixtures isolated and tracked. Do not add retries to disguise stale authority.

## Tests and CI trust

- Reproduce the failing boundary with the smallest existing check; fixtures match production schemas, clocks and first-attempt metadata.
- Actions mocks must keep API prototypes; check jobless definition failures.
- A candidate's self-declared signer is not trust. Publisher and reader protocols migrate together; unknown evidence fails closed.
- Every PR-routed suite must be suite-gate classified, or all heavy master suites run.
- `cancel-in-progress: false` keeps only one pending run; the policy publisher uses `queue: max`. Event order comes from authenticated transitions.

## Release and recovery

- Validate the whole prerequisite chain before issuing one-use authority; captured dispatch is not materialization.
- Preserve control, subject, target and checkpoint lineage; equal bytes do not replace it. Recovery lineage must compose across repeated failures.
- Ambiguous dispatch/approval stays fenced until reconciliation; never replay, reset receipts or edit authority.
- A post-claim revalidation must not treat its own claim as foreign; test pre- and post-claim passes.
- Data handoff is not completion: validate the same run's handoff, deploy exact images, release the DB lock before the public fence.
- File seals bind inode, never `st_dev` (macOS renumbers APFS devices).
- Removing environment reviewers changes timing; test ungated, terminal and chained paths.
- Every authority profile a validator can emit needs an end-to-end chained fixture; an unhandled arm fails the restore late.

## Infrastructure

- Read failures mean unknown, not absent. Keep AKS, OKE and k3s prerequisites separate.
- Bind cloud-read credentials on every calling Actions step; earlier step-scoped credentials do not persist.
- Shared-Mongo backup recovery differs from no-backup cross-cloud replacement; after cutover, recover forward.
- Bound external reads; poll terminal conditions; cleanup must not erase failure evidence.
- Verify API shapes, restart history and canonical routes; billing closure and deletion need terminal evidence.
- Host-wide redirects must exempt `/.well-known/acme-challenge/`; prove certificate renewal, not just first issuance.
