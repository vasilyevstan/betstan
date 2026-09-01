# Azure operation agents (`*-stan`)

- `pre-commit-infra-check-stan.sh` — scans infra changes for secrets patterns, validates ingress routing, warns on public IPs and staged artifacts. Run before every `git push` on infra/workflow changes.
- `provisioning-stan.sh` — runs full AKS provisioning flow.
- `deploy-stan.sh` — applies Kubernetes manifests only after the shared-Mongo topology guard passes.
- `troubleshoot-stan.sh` — prints cluster/workload/ingress diagnostics.
- `cost-ops-stan.sh` — stop/start/scale controls for cost management.
- `qa-e2e-stan.sh` — runs Playwright browser smoke tests.
- `dns-check-stan.sh` — compares public DNS answer with ingress external IP.
- `health-check-stan.sh` — reusable per-service AKS health checks with node/log/SSH diagnostics.
- `mismatch-diagnostic-stan.sh` — traces event-service vs gamemaster event-stream mismatches for a specific event.
- `branch-policy-guard-stan.sh` — enforces feature/hotfix-to-dev and only-dev-to-master PR pairs.
- `test-branch-policy-guard-stan.sh` — tests accepted and rejected branch pairs.
- `test-workflow-run-provenance-stan.sh` — rejects wrong-SHA artifacts and untrusted build/deploy workflow runs.
- `production-workflow-inventory-stan.sh` — derives and validates the exact governed Azure-plus-OCI production workflow set matched by a promotion diff.
- `pr-validation-stan.sh` — inspects trusted required checks for a PR's exact head SHA.
- `pr-merge-safety-stan.sh` — combines branch policy, exact-SHA validation, mergeability, and production approval gates.
- `copilot-cli-protected-operation-policy-stan.sh` — one policy for every protected workflow, operation, input set, title, environment, SHA role, and automatic lineage.
- `copilot_cli_authority_stan.py` — canonical transport-input hashing plus private dispatch intents, one-run authority state, approval receipts, reconciliation, and inert retirement.
- `copilot-cli-dispatch-stan.sh` — validates an operation request, persists a pre-dispatch intent and durable output capture, dispatches exactly once, binds the returned run ID, and issues its private authority record.
- `copilot-cli-run-approval-stan.sh` — fail-closed protected-environment approval for exact CLI-owned or promotion-derived runs.
- `production-run-exclusivity-stan.sh` — blocks actionable concurrent production runs while identifying inert disabled queue records.
- `post-merge-verification-stan.sh` — verifies merged commit workflow success plus production health across both public hosts.
- `rollback-readiness-stan.sh` — emits explicit rollback go/no-go based on current health, queue pressure, and rollout history.
- `node-logs-stan.sh` — node-level health/events + pod error-log extraction.
- `service-ops-stan.sh` — service/deployment/endpoints readiness + restart/error diagnostics.
- `smoke-liveness-stan.sh` — ingress + homepage + auth API + endpoint liveness checks.
- `deploy-validation-loop-stan.sh` — retries smoke+functional validation and captures diagnostics artifacts on failure.
- `validation-loop-stan.sh` — repeats health + HTTPS + E2E checks until pass/fail limit.
- `ingress-routing-guard-stan.sh` — static guard that fails when prod ingress host/path routing is unsafe.
- `shared-mongo-topology-guard-stan.sh` — blocks normal deployment unless the validated one-Mongo topology and eight shared URIs are live.
- `shared-mongo-operation-lock-stan.sh` — serializes migration, rollback, cleanup, and deployment through a resource-versioned ConfigMap lock with a bounded lease/expiry handoff.
- `consolidate-production-mongo-stan.sh` — exact-SHA preflight, migrate, cleanup, and rollback operator for the seven-database move into auth Mongo.
- `test-shared-mongo-consolidation-stan.sh` — validates manifests/mappings and runs a synthetic eight-database dump/restore parity test.
- `provision-stage-stan.sh` — creates isolated `betstan-rg-stage` AKS and configures autoscaler 1→3 with a larger baseline node size for 1-node stage operation.
- `park-stage-stan.sh` — stops stage AKS compute while keeping the stage resource group.
- `resume-stage-stan.sh` — starts stage AKS and runs quick readiness checks.
- `decommission-stage-rg-stan.sh` — deletes the entire stage resource group to remove stage costs.
- `reconcile-nodepool-profile-stan.sh` — creates or validates the `Standard_B4as_v2` + Managed 64 GiB OS disk profile and reconciles autoscaler `1..3`; it refuses workload cutover and legacy pool deletion.
- `retire-production-stan.sh` — exact-inventory, resumable deletion of the retired BetStan Azure resource groups after OCI cutover.
- `retire-migration-identities-stan.sh` — separate exact-metadata retirement of temporary migration/recovery identities and environment secrets while retaining Azure recreation configuration.
- `audit-oci-primary-retirement-stan.sh` — read-only terminal audit for OCI health/free-tier state, Azure and identity absence, workflows, journal fences, and delayed billing.
- `record-azure-retirement-billing-stan.sh` — locked append-only recorder for mature clean ActualCost and AmortizedCost observations.

Scripts assume the CLIs and authentication required by their operations are already available. The node-pool profile reconciler requires only `az` and does not change the user's Kubernetes context.

## Temporary migration identity retirement

Keep the 28-field metadata file and state directory outside the repository with
mode `0600` and `0700`, respectively. Review `plan` before the destructive
mode, then retain the terminal state for independent verification:

```bash
export IDENTITY_RETIREMENT_METADATA=/absolute/private/identity-metadata.env
export IDENTITY_RETIREMENT_STATE_DIR=/absolute/private/identity-state

./infra/azure/agents/retire-migration-identities-stan.sh plan
./infra/azure/agents/retire-migration-identities-stan.sh execute
./infra/azure/agents/retire-migration-identities-stan.sh verify
```

After reviewed metadata cleanup, `verify` can load the exact 23-field
`betstan.identity-retirement-terminal.v1` state without the metadata file.
The operator disables only `oci-migration-recovery.yml`; `oci-migrate.yml`
remains available for future reconfiguration but is fenced twice and loses
its temporary Azure environment secret before any identity deletion. Both
workflows must have no nonterminal runs at the post-secret fence.

Role-assignment IDs may use only subscription, resource-group, or the exact
AKS managed-cluster scope, and each ID parent must equal its declared metadata
scope. Deleted service principals are probed with a successful `--all`
listing and exact client-side object-ID count because Azure CLI's server-side
ID filter exits nonzero for an absent object.

## Terminal retirement audit and billing evidence

Keep all evidence paths private and absolute. The terminal audit is read-only
and recomputes the live OCI inventory, resource bindings, Azure absence,
temporary-identity state, workflow state, migration contract, and both cost
types:

```bash
field() { sed -n "s/^$1=//p" "$2"; }

export OCI_INFRASTRUCTURE_PROVENANCE_FILE=/absolute/private/provenance.env
export AZURE_RETIREMENT_STATE_FILE=/absolute/private/retirement-state.env
export IDENTITY_STATE_FILE=/absolute/private/identity-terminal.env
export IDENTITY_ATTESTATION_FILE=/absolute/private/identity-attestation.env
export OCI_DIAGNOSTIC_URL=https://92.5.96.113.nip.io
export OCI_COMPARTMENT_OCID="$(field compartment_ocid "$OCI_INFRASTRUCTURE_PROVENANCE_FILE")"
export EXPECTED_OCI_PROVENANCE_DIGEST=6aacf7029e8ea5a5b3e905a4c07e6318885f69786332b079d30f2b3790fed8b2
export EXPECTED_OCI_INVENTORY_DIGEST=56c3fac911b71a31214129b5a027c669a362c62fb6b9b6e4559d439c834d8377
export AZURE_SUBSCRIPTION_FINGERPRINT="$(field subscription_id_sha256 "$AZURE_RETIREMENT_STATE_FILE")"
export AZURE_EXPECTED_CLUSTER_RESOURCE_ID_SHA256="$(field cluster_resource_id_sha256 "$AZURE_RETIREMENT_STATE_FILE")"
export MIGRATION_RUN_ID="$(field github_run_id "$AZURE_RETIREMENT_STATE_FILE")"
export MIGRATION_RUN_ATTEMPT="$(field github_run_attempt "$AZURE_RETIREMENT_STATE_FILE")"
export MIGRATION_ID="$(field migration_id "$AZURE_RETIREMENT_STATE_FILE")"
export MIGRATION_SHA="$(field source_sha "$AZURE_RETIREMENT_STATE_FILE")"

./infra/azure/agents/audit-oci-primary-retirement-stan.sh
```

The expected pre-maturity result is
`resource_phase=RESOURCE_RETIREMENT_COMPLETE` with
`terminal_phase=BILLING_INGESTION_PENDING` and exit code `3`. Exit `0` is
reserved for `AZURE_RETIRED`; `1` means `NO_GO`, and `2` means
`AUDIT_INCOMPLETE`. Do not convert delayed billing ingestion into a
resource-retirement failure. The audit checks a live JSON API route and all
eight production-capable workflow records, not only the OCI deploy workflows.

Azure's daily `UsageDate` cannot attribute the partial retirement day. The
reviewed billing boundary is therefore `2026-08-20T00:00:00Z`, the first full
UTC day after the exact resource cutoff. Resource absence covers the intervening
hours. Only after that billing boundary plus 96 hours, record a window into a
mode-0700 private directory.

The recorder recomputes the case-preserving subscription fingerprint,
validates the active Azure account, queries both cost types with the exact
BetStan resource-group filter, repeats the original POST body for every
subscription-bound continuation, and validates item-level usage details so a
charge cannot net against a refund. It retries provider failures at most four
times with bounded backoff. Its hard-link lock records exact ownership,
recovers only a verified dead owner, and validates the complete prior chain
before an atomic append. A terminating signal exits before releasing the lock:

```bash
export OBSERVATION_FILE=/absolute/private/billing-observations.env
export AZURE_SUBSCRIPTION_ID="$(az account show --query id -o tsv)"
export AZURE_SUBSCRIPTION_FINGERPRINT="$(field subscription_id_sha256 "$AZURE_RETIREMENT_STATE_FILE")"

./infra/azure/agents/record-azure-retirement-billing-stan.sh
```

Pass that file to later audits with
`BILLING_OBSERVATION_FILE="$OBSERVATION_FILE"`. The
`betstan.billing-observation.v4` contract binds both Cost Management Query and
item-level Usage Details API versions, stores exact combined response-digest
pairs, and chains every append. Positive cost on or after the full-day billing
boundary is `NO_GO`;
negative adjustments, an incomplete 96-hour grace, fewer than three windows,
less than 24 hours between appends, or less than a 96-hour observation span
remain pending. Provider/schema/pagination, currency, chain, or binding errors
are `AUDIT_INCOMPLETE`. A known positive result remains `NO_GO` even if the
peer cost type is malformed, and `NO_ROWS` never resets an established
currency. The current subscription emits `legacy` Usage Details records;
another record kind fails closed as incomplete rather than being generalized
across billing-account types. Legacy records may reuse an ARM `id` for
different charge lines; the audit validates and classifies every item instead
of assuming that resource-shaped identifier is a unique charge key.

## Required validation sequence for production changes

```
pre-commit-infra-check-stan.sh   ← run before git push on any infra/workflow change
    ↓
feature/hotfix branch → dev      ← normal integration path
    ↓
branch-policy + quality gates    ← matching head and merge snapshots
    ↓
dev → master promotion PR       ← explicit exact-SHA production approval
    ↓
post-merge-verification-stan.sh  ← run immediately after every production merge
    ↓
master → dev synchronization     ← required after a squash promotion
    ↓
rollback-readiness-stan.sh       ← run before taking any rollback action
```

See `infra/azure/LESSONS_LEARNED.md` for the full set of operational rules.

## Pre-commit infra check

Run before pushing any branch that touches infra, k8s manifests, or CI workflows:

```bash
./infra/azure/agents/pre-commit-infra-check-stan.sh
```

The check:
- scans all agent scripts and workflows for hard-coded secrets patterns;
- validates the prod ingress routing guard passes;
- warns if `artifacts/` is staged for commit;
- warns about hard-coded public IPs in k8s manifests.

Suggested execution order for an already validated production topology:
1. `provisioning-stan.sh`
2. `deploy-stan.sh`
3. `dns-check-stan.sh`
4. `qa-e2e-stan.sh`
5. `smoke-liveness-stan.sh`
6. `deploy-validation-loop-stan.sh`
7. `validation-loop-stan.sh`

## Reusable service health checks

Use `health-check-stan.sh` when you need a single entrypoint that can check one service or the full backend set:

```bash
SERVICE=gamemaster ./infra/azure/agents/health-check-stan.sh
SERVICES=auth,bet,backoffice,event,gamemaster,moderation,resulting,slip ./infra/azure/agents/health-check-stan.sh
SERVICE=gamemaster SSH_ENABLED=1 SSH_USER=azureuser ./infra/azure/agents/health-check-stan.sh
```

The script:
- checks the AKS cluster and node state,
- validates the service deployment, Service, Endpoints, pods, and restarts,
- maps pods to nodes and prints node diagnostics,
- collects recent pod error logs,
- optionally SSHes into the node for deeper OS-level inspection when credentials are supplied.

## Diagnosing event/gamemaster stream mismatches

Use `mismatch-diagnostic-stan.sh` when an event exists in the event service but never appears in gamemaster:

```bash
EVENT_NAME='North Nikkoside - Hermanview' ./infra/azure/agents/mismatch-diagnostic-stan.sh
EVENT_ID=6172b204-e662-4d8e-b0a1-93df1782b844 ./infra/azure/agents/mismatch-diagnostic-stan.sh
```

The script:
- compares the event record in `gaming_event` and `gaming_gamemaster`,
- prints relevant event/gamemaster logs for the target event,
- shows gamemaster pending events and pod runtime state,
- summarizes the likely cause when the record exists only in `gaming_event`.

## PR validation and merge safety

Use the branch guard to validate an intended PR pair:

```bash
BASE_REF=dev HEAD_REF=feature/example ./infra/azure/agents/branch-policy-guard-stan.sh
BASE_REF=master HEAD_REF=dev ./infra/azure/agents/branch-policy-guard-stan.sh
```

Use the PR validation agent to inspect trusted required checks for the PR's exact head SHA:

```bash
./infra/azure/agents/pr-validation-stan.sh 41
```

Use the merge-safety agent when you want a conservative yes/no recommendation:

```bash
# Inspection only: note head_sha and, for master, production_workflows.
./infra/azure/agents/pr-merge-safety-stan.sh 41
# After explicitly reviewing and copying that exact evidence:
APPROVED_SHA=<sha> ./infra/azure/agents/pr-merge-safety-stan.sh 41
COPILOT_CLI_AUTO_APPROVE=true ./infra/azure/agents/pr-merge-safety-stan.sh 41
```

The validation agent:
- binds the current PR head SHA, base SHA, and unique test-merge SHA;
- accepts only base-scoped statuses published by GitHub Actions on both snapshots;
- verifies the exact trusted workflow IDs, events, and PR relations behind both required statuses.

The merge-safety agent:
- rejects unsupported branch pairs;
- requires matching trusted runs on the current head and merge snapshots;
- recommends a `dev` merge only when validation is green;
- requires `APPROVED_SHA` before every human-managed merge and additionally
  requires `APPROVED_WORKFLOWS` for a human-managed production promotion;
- allows automatic mode only for a `copilot-cli-managed` PR with resolved reviews and no competing production run.

Run dispatch and approval from a clean checkout at exact current `master`.
Create every request outside the repository with mode `0600`; include every
workflow input, including optional values, so the canonical bytes sent to
GitHub are the bytes whose SHA-256 is recorded. Boolean request values remain
typed JSON booleans in the private request and authority record; the dispatcher
converts them to lowercase `"true"`/`"false"` strings in the exact JSON payload
required by `gh workflow run --json`, and hashes that transmitted payload.

```bash
request=/private/path/oci-deploy-request.json
chmod 600 "$request"

./infra/azure/agents/copilot-cli-dispatch-stan.sh "$request"
./infra/azure/agents/copilot-cli-dispatch-stan.sh "$request" --dispatch

COPILOT_CLI_AUTO_APPROVE=true \
EXPECTED_OPERATION=oci-production-deploy \
./infra/azure/agents/copilot-cli-run-approval-stan.sh <run-id> --approve
```

The request schema is:

```json
{
  "schemaVersion": "betstan.copilot-cli-dispatch-request.v1",
  "repository": "vasilyevstan/betstan",
  "operation": "production-deploy",
  "controlSha": "<current-master-sha>",
  "subjectSha": "<current-master-sha>",
  "targetSha": null,
  "inputs": {
    "approved_sha": "<current-master-sha>",
    "build_run_id": "<first-attempt-build-run-id>"
  }
}
```

List exact operation names with
`copilot-cli-protected-operation-policy-stan.sh operations`. If GitHub returns
a run URL but exact run metadata has not materialized, never dispatch again;
rerun the dispatcher with the same request and `--resume-run <run-id>`. If the
dispatcher process dies after GitHub writes the URL but before the run is
bound, recover the durable capture instead:

```bash
./infra/azure/agents/copilot-cli-dispatch-stan.sh \
  "$request" \
  --resume-captured
```

The dispatcher creates its private `dispatching` intent and mode-`0600`
capture before the external mutation. A URL-less result remains ambiguous and
blocks replacement dispatch; do not infer identity from timestamps, titles,
or nearby runs. A captured terminal run is automatically marked `retired`
only after GitHub proves it has zero jobs and zero pending deployments, at
which point a replacement request may proceed.
Any unresolved intent or `claimed`/`inflight` record blocks every protected
dispatch for the same repository and control SHA, including requests with a
different operation or inputs. An `issued` or `consumed` record blocks the
same operation and exact transport input hash; a changed request is distinct
but still passes the full policy, lineage, recovery, and exclusivity checks.
After creating a pristine intent, the dispatcher revalidates current master,
workflow blob, and active state. Authority drift cancels only that untouched
intent and no GitHub dispatch occurs.

The shared policy declares the required workflow state at approval.
`oci-capacity-acquire.yml`, `oci-infrastructure.yml`,
`oci-live-betting-activate.yml`, `oci-live-data-rollout.yml`,
`oci-migration-recovery.yml`, and `oci-production-deploy.yml` must be
`disabled_manually`; every other protected workflow must be `active`. For a
normally disabled workflow, enable it before dispatch, keep it enabled until
the returned run has a real job and expected pending environment, then disable
it before approval.

Automatic `production-build` approval requires the exact labelled promotion
and creates a private automatic authority record before its first approval:

```bash
COPILOT_CLI_AUTO_APPROVE=true \
EXPECTED_OPERATION=production-build \
EXPECTED_CONTROL_SHA=<current-master-sha> \
./infra/azure/agents/copilot-cli-run-approval-stan.sh <run-id> --approve
```

`oci-production-build` also requires `EXPECTED_UPSTREAM_RUN_ID` and receives
its own automatic authority record after the exact successful upstream build
is proven. Automatic migration recovery requires the exact failed
`oci-migrate` run ID and its consumed CLI authority receipt. Scheduled
recovery and capacity runs have no record and cannot enter automatic approval.

The approver rechecks current master, promotion authority, workflow ID/path
and Git blob, first attempt, exact title/event/environment, pending job,
current-user approval capability, record input hash, historical ancestry, and
production exclusivity. One record can acknowledge multiple sequential gates
on the same exact run and explicitly allowed downstream recovery. Each exact
run/environment/waiting-job-set fingerprint is receipted once, so a later job
may reuse the same environment without replaying an earlier gate. An ambiguous
GitHub POST leaves an `inflight` claim and must not be replayed automatically.
Immediately after persisting the local `inflight` claim, the approver
revalidates current master, workflow blob/state, and promotion authority. If
authority changed, it releases the exact claim to its previous
`issued`/`consumed` state and makes no GitHub POST. Production exclusivity also
fails closed unless each active-run API response is a complete object with a
nonnegative integer `total_count`, a `workflow_runs` array, exact count/list
agreement, and no more than the requested 100 results.
Reconcile it by observing the exact run again:

```bash
COPILOT_CLI_AUTO_APPROVE=true \
EXPECTED_OPERATION=oci-production-deploy \
./infra/azure/agents/copilot-cli-run-approval-stan.sh \
  <run-id> \
  --reconcile
```

The inflight claim records the exact reviewer, approval comment, environment,
downstream run, operation, and matching GitHub review-history count observed
before the POST. Reconciliation first requires that exact run and operation,
then writes a consumed receipt only when the exact approved-review count
increased. If no review appeared and the same active pending gate still
exists, it restores the prior issued/consumed state and reports `RETRY_READY`;
submit a new approval only through a later normal `--approve` invocation. If
neither condition is proven, authority stays inflight and unresolved. A
missing pending response or terminal run is never treated as approval by
itself. Authority states are `dispatching` intent, then `claimed`, `issued`,
`inflight`, `consumed`, or terminal `retired`. Expired claimed and inflight
records remain inspectable for exact recovery, while issued and consumed
authority remains bounded by expiry.

If an approval process dies while holding a local lock, use the helper's
`clear-stale-lock` command only after it proves the recorded owner PID is gone;
never delete a live or unverified lock directly.

## Post-merge production verification

Use this after an approved `dev`-to-`master` promotion to avoid false confidence from merge success alone:

```bash
PR=50 ./infra/azure/agents/post-merge-verification-stan.sh
# or
ALLOW_SHA_ONLY=1 MERGE_SHA=<merge-commit-sha> ./infra/azure/agents/post-merge-verification-stan.sh
```

The script validates:
- successful `production-build` and `production-deploy` runs for the exact merged commit;
- deployment/statefulset readiness in AKS;
- API health for both `www.betstan.xyz` and `betstan.xyz`;
- RabbitMQ required queues have active consumers.

### RabbitMQ replacement recovery

RabbitMQ is an ephemeral Deployment. After its broker pod is replaced, restart every backend deployment sequentially so each service redeclares its queues and consumers:

```bash
for deployment in auth bet backoffice event gamemaster moderation resulting slip; do
  kubectl rollout restart "deployment/gaming-${deployment}-depl"
  kubectl rollout status "deployment/gaming-${deployment}-depl" --timeout=5m
done
```

Verify all 17 queues have consumers before considering recovery complete.

## Rollback readiness gate

Use this before taking rollback action in production:

```bash
TARGET_SHA=<candidate-sha> ./infra/azure/agents/rollback-readiness-stan.sh
```

During an interrupted shared-Mongo migration, bind readiness to the exact
journal and private backup directory:

```bash
TARGET_SHA=<full-migration-sha> \
MIGRATION_ID=<approved-id> \
MIGRATION_BACKUP_DIR=<private-absolute-path> \
./infra/azure/agents/rollback-readiness-stan.sh
```

Transition readiness also requires the database operation lock to be released.
Then run the consolidation operator's `rollback` operation.

The script outputs:
- `rollback_readiness=GO` when safety preconditions are met;
- `rollback_readiness=NO_GO` with concrete reasons when rollback would be risky.

## GoDaddy `A www` error fix (`Invalid data provided for record data`)

Use this sequence in GoDaddy DNS management:
1. Delete any existing `CNAME` record with host `www`.
2. Add a new `A` record:
   - **Type**: `A`
   - **Host**: `www`
   - **Points to**: the ingress external IPv4 from AKS (plain IP only, no URL)
3. Keep TTL default and save.

Validation:
- `DOMAIN=www.betstan.xyz ./infra/azure/agents/dns-check-stan.sh`
- `dig +short www.betstan.xyz A`

If `dns-check-stan.sh` prints `status=MATCH`, DNS is pointing to current ingress.

## CI/CD and data-safety posture

- `production-build` runs on `master` and tags each image with the exact approved SHA.
- `production-build` pull requests into `dev` or `master` run the full quality gates.
- `branch-policy` permits normal branches into `dev` and only `dev` into `master`.
- Promotion statuses are base-scoped and published on both the current head and unique merge snapshot; validation requires both copies to point to the same trusted runs.
- `production-deploy` runs only after successful `production-build` on `master` and deploys that exact SHA image set.
- Emergency manual dispatch is limited to the central workflows, requires a full master SHA, and pauses at the reviewer-protected `production-emergency` environment.
- OCI is primary production at `https://betstan.xyz`. `www.betstan.xyz`
  redirects to the apex and the `nip.io` endpoint is diagnostic only. Azure
  deployment remains a separately approved recreation path and must never
  redirect production away from OCI implicitly.
- The Azure-to-OCI workflow is an exact logical replacement with a persisted
  phase/heartbeat contract and stop-only recovery. Azure remains the source
  until OCI passes; post-migration retirement is separately gated.
- Retired central and per-service workflow identities remain disabled so historical runs cannot be rerun.
- Deploy workflow requires the validated shared-Mongo marker, one ready auth Mongo StatefulSet/PVC, no legacy Mongo StatefulSets/PVCs, and all eight exact shared URIs.
- Deploy workflow now runs `deploy-validation-loop-stan.sh` as required post-rollout gate and uploads diagnostics artifacts on failure.
- `production-build` includes `ingress-routing-guard-stan.sh` so PRs fail if prod ingress misses required host/api routes.

## Deploy validation loop settings

`deploy-validation-loop-stan.sh` supports:
- `DOMAIN` (default `betstan.xyz`)
- `CERT_NAME` (default `betstan-tls`)
- `E2E_BASE_URL` (default `https://<DOMAIN>`)
- `MAX_ATTEMPTS`, `SLEEP_SECONDS`
- `VALIDATION_MAX_LOOPS`, `VALIDATION_SLEEP_SECONDS`
- `OUTPUT_DIR` (defaults to `artifacts/deploy-validation`)

Operator guidance:
- `MAX_ATTEMPTS` controls outer retries of layered gates (`smoke-liveness` then `validation-loop`).
- `VALIDATION_MAX_LOOPS` controls inner `validation-loop-stan.sh` iterations per attempt.
- On failure, script exits non-zero and prints:
  - `deploy_validation_status=FAILED`
  - `diagnostics_dir=<OUTPUT_DIR>`
- Diagnostics are written to `<OUTPUT_DIR>/attempt-<N>/` with:
  - `context.txt` (reason + effective inputs)
  - `kubectl-nodes.txt`, `kubectl-events.txt`, `kubectl-default-workloads.txt`
  - `service-ops.txt`, `node-logs.txt`
- In GitHub Actions (`production-deploy`), these files are uploaded by `Upload deploy diagnostics` when the job fails.

## Shared Mongo migration flow

Repository merge does not migrate production. The final manifests intentionally
cannot be applied by the normal deployment workflow until the migration marker
is validated.

The rollback-only manifests are under `infra/k8s/legacy-mongo/` and are never
part of normal `kubectl apply -f infra/k8s`.

The operator requires a clean exact-SHA checkout and a private backup directory
outside the repository. Set `NAMESPACE` explicitly when it is not `default`.

| Operation | Required starting evidence | Exact confirmations | Successful result |
|---|---|---|---|
| `plan` | Repository mapping only | None | Sanitized eight-database/seven-resource map |
| `preflight` | Full approved SHA, clean checkout, live legacy topology, private backup directory | None | Read-only compatibility and capacity pass |
| `migrate` | No conflicting journal, or same safely resumable early transition | `CONFIRM_MAINTENANCE=writers-paused`, `CONFIRM_RECOVERY_COPIES=verified-eight-recovery-copies` | `transition/awaiting-cleanup` |
| `cleanup` | Exact `transition/awaiting-cleanup`, verified backups and applications | `CONFIRM_APPLICATION_VALIDATED=shared-mongo-application-validation-passed`, `CONFIRM_DELETE_LEGACY_MONGO=delete-seven-legacy-mongo-volumes` | `shared/complete` and final topology guard pass |
| `rollback` | Supported exact transition phase or `shared/complete`, plus rollback readiness | `CONFIRM_ROLLBACK=restore-seven-legacy-databases` | `legacy/rollback-complete` |
| `unlock` | Proven stale lock with matching migration ID and SHA | `CONFIRM_UNLOCK=remove-stale-migration-lock` | Matching lock released; topology unchanged |

Run preflight first:

```bash
APPROVED_SHA=<full-master-sha> \
MIGRATION_ID=<approved-id> \
BACKUP_DIR=<private-absolute-path> \
./infra/azure/agents/consolidate-production-mongo-stan.sh preflight

APPROVED_SHA=<full-master-sha> \
MIGRATION_ID=<approved-id> \
BACKUP_DIR=<private-absolute-path> \
CONFIRM_MAINTENANCE=writers-paused \
CONFIRM_RECOVERY_COPIES=verified-eight-recovery-copies \
./infra/azure/agents/consolidate-production-mongo-stan.sh migrate

APPROVED_SHA=<full-master-sha> \
MIGRATION_ID=<approved-id> \
BACKUP_DIR=<private-absolute-path> \
CONFIRM_APPLICATION_VALIDATED=shared-mongo-application-validation-passed \
CONFIRM_DELETE_LEGACY_MONGO=delete-seven-legacy-mongo-volumes \
./infra/azure/agents/consolidate-production-mongo-stan.sh cleanup
```

For migration rollback, first run the transition-aware readiness gate, then the
operator:

```bash
TARGET_SHA=<full-master-sha> \
MIGRATION_ID=<approved-id> \
MIGRATION_BACKUP_DIR=<private-absolute-path> \
./infra/azure/agents/rollback-readiness-stan.sh

APPROVED_SHA=<full-master-sha> \
MIGRATION_ID=<approved-id> \
BACKUP_DIR=<private-absolute-path> \
CONFIRM_ROLLBACK=restore-seven-legacy-databases \
./infra/azure/agents/consolidate-production-mongo-stan.sh rollback
```

### Journal phases and interrupted operations

| Phase | Rollback source of truth |
|---|---|
| `backing-up`, `preparing-target`, `restoring`, `switching` | Legacy data; do not reverse-copy partial shared data |
| `validating-applications`, `awaiting-cleanup` | Shared data may contain new writes; reverse-copy before switching |
| `rollback-copying` | Resume verified reverse copy with applications stopped |
| `rollback-data-restored` | Legacy restore is complete; do not reverse-copy again |
| `shared/complete` | Recreate legacy stores and reverse-copy current shared data |
| `legacy/rollback-complete` | Use a new migration ID and fresh backups before retrying migration |

Resume only with the same full SHA, migration ID, private backup directory, and
verified checksums. Never reuse backups from a completed rollback or another
migration.

Never put `BACKUP_DIR` inside the repository. Backup archives, signatures,
checksums, and cleanup PVC/PV journals are private recovery artifacts, not
source files.

`cleanup` is immediate after application validation; it is not a soak gate. It
still requires complete data, metadata, application, API, queue, and exact
resource validation. Retain verified external recovery artifacts for seven
days.

Issue #85 tracks two remaining fail-closed runtime reads. Until it is resolved,
independently require a successful topology journal read or explicit NotFound
immediately before `migrate`, and explicit NotFound for every journaled legacy
PV after `cleanup`. An authorization, timeout, transport, or other API error is
`NO_GO`, even when the operator process exits successfully.

### Lock recovery

Destructive operations and normal deployment acquire the persistent
`gaming-mongo-migration-lock` ConfigMap through resource-versioned
compare-and-swap. API errors are unknown state, not absence. A release failure
fails an otherwise successful operation.

If an operator process is killed and leaves the lock active, inspect the
journal, holder, workloads, and process first. Release only the matching stale
lock:

```bash
APPROVED_SHA=<full-master-sha> \
MIGRATION_ID=<approved-id> \
CONFIRM_UNLOCK=remove-stale-migration-lock \
./infra/azure/agents/consolidate-production-mongo-stan.sh unlock
```

### Script portability and offline validation

- Keep operational shell scripts compatible with macOS Bash 3.2; avoid
  `mapfile`, associative arrays, and other Bash 4-only features.
- Test GNU and BSD command variants. Probe a platform's successful form first;
  a failed command that emits partial stdout can corrupt fallback output.
- Use Ruby YAML parsing for offline manifest syntax. `kubectl apply
  --dry-run=client` may still contact the configured API server for discovery.

## Stage lifecycle and cost controls

Use these operations to park and restore stage safely:

```bash
# Stop stage compute but keep RG/resources
./infra/azure/agents/park-stage-stan.sh

# Resume stage compute
./infra/azure/agents/resume-stage-stan.sh

# Fully remove stage costs (delete RG)
./infra/azure/agents/decommission-stage-rg-stan.sh

# Recreate stage from scripts later
JWT_KEY='<stage-jwt-secret>' ./infra/azure/agents/provision-stage-stan.sh
```

Profile reconciliation helper (Azure profile only):

```bash
# Defaults to Standard_B4as_v2, Managed 64 GiB, autoscaler 1..3
./infra/azure/agents/reconcile-nodepool-profile-stan.sh
```

The reconciler creates a missing target pool, validates an existing pool's immutable profile, reconciles its autoscaler settings, and prints the Azure node-pool profile JSON. It does not obtain Kubernetes credentials or move workloads. Setting `EXECUTE_CUTOVER=true` or `DELETE_LEGACY_POOL=true` fails nonzero intentionally; workload migration and pool deletion require the manual gate below.

Exact production reconciliation (profile check/update only; no workload cutover):

```bash
RESOURCE_GROUP=betstan-rg \
CLUSTER_NAME=betstan-aks \
TARGET_POOL_NAME=nodepool4 \
TARGET_VM_SIZE=Standard_B4as_v2 \
TARGET_OS_DISK_TYPE=Managed \
TARGET_OS_DISK_SIZE_GB=64 \
TARGET_MIN_COUNT=1 \
TARGET_MAX_COUNT=3 \
./infra/azure/agents/reconcile-nodepool-profile-stan.sh
```

An existing target pool must already match the requested VM size, OS disk type, and OS disk size; immutable-profile mismatches fail instead of being reported as aligned.

### Manual node-pool migration gate

Before deleting a legacy node pool:

1. Take and verify consistent snapshots of every currently attached Mongo PVC.
2. Roll out stateless workloads sequentially, waiting for readiness before each next rollout.
3. Move Mongo StatefulSets one at a time so each RWO volume detaches, reattaches, and becomes healthy before the next move.
4. Explicitly reconnect backend services after any RabbitMQ replacement, using the sequential recovery procedure above, and verify queue consumers.
5. Repeat application health, RabbitMQ queue/consumer, and node filesystem/free-space checks (including `DiskPressure`) after every migration step.
6. Delete the legacy pool manually only after all repeated checks remain healthy.

Do not use `Standard_B4ms` with a 30 GiB Ephemeral OS disk for this workload. Concurrent image pulls exhausted that trial pool's OS filesystem, caused `DiskPressure`, and evicted two pods.
