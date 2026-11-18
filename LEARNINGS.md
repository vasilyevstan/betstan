# BetStan engineering lessons

Working guide, not policy: [CONTRIBUTING.md](CONTRIBUTING.md) owns rules, [agent roles](.github/agents/README.md) own routing, and history lives in [Engineering Learnings](docs/wiki/Engineering-Learnings.md).

## Delivery and CI

- Report source, deploy, activation and health separately; a merged fix or green build is not restored production.
- Wait with bounded `wait-required-checks-stan.sh`, never `gh pr checks --watch`: the `trusted-quality-transition/*` ledger stays pending by design.
- Re-read eventually consistent inventories (`total_count` vs rows) a bounded number of times before failing closed; never burn a one-use run on a transient read.
- Every PR-routed suite must be suite-gate classified, or all heavy master suites run. `cancel-in-progress: false` keeps one pending run; the policy publisher uses `queue: max`.

## Contracts, messaging and data

- `common/` source is ahead of consumer pins: validate packed bytes and lock-exact rolling combinations. Teach readers a value before activating its producer.
- Keep presentation metadata out of persisted objects that predecessor writers copy.
- Persist publication intent; duplicates, delays and reordering are normal. Broker readiness is not consumer readiness.
- A new listener needs its `oci_application_rabbitmq_queue_names` entry, or the deploy fails fenced.
- Scope mutations atomically by identity, owner, state, revision and fingerprint; handle versionless rows and empty terminal aggregates.

## Betting integrity

- Persist deterministic simulation transitions.
- One quote identity must map to one validity interval; a material change creates a new quote version even with unchanged prices.
- Compare submission time with expiry and the earliest authority-ending boundary, including equality. Use exact IDs, never position.

## UI, timelines and access

- Preserve selection identity and focus when order changes.
- Claim complete history only with valid cumulative producer evidence; partial inputs stay partial.
- Navigation is not access. Activation ends with a real-backend smoke; mocks cannot see a disabled flag.
- Revalidate persisted roles server-side; isolate synthetic fixtures. Do not add retries to disguise stale authority.

## Release and infrastructure

- Validate every prerequisite before one-use authority and preserve lineage; a post-claim revalidation must not treat its own claim as foreign.
- Each authority profile a validator can emit needs a chained end-to-end fixture.
- File seals bind inode, never `st_dev`.
- Disable `oci-live-data-rollout` once its run has a real job (its guard fails after 180 s); dispatch `oci-production-deploy` before the handoff lease expires.
- k3s keeps released images until a governed CRI reclaim; a withheld checkpoint (`candidate_preload`) needs reclaim, then a new SHA.
- Read failures mean unknown. Bind cloud credentials on every Actions step. Redirects exempt `/.well-known/acme-challenge/`; prove renewal.
