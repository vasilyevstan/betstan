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
- `production-workflow-inventory-stan.sh` — derives the exact production workflow set matched by a promotion diff.
- `pr-validation-stan.sh` — inspects trusted required checks for a PR's exact head SHA.
- `pr-merge-safety-stan.sh` — combines branch policy, exact-SHA validation, mergeability, and production approval gates.
- `post-merge-verification-stan.sh` — verifies merged commit workflow success plus production health across both public hosts.
- `rollback-readiness-stan.sh` — emits explicit rollback go/no-go based on current health, queue pressure, and rollout history.
- `node-logs-stan.sh` — node-level health/events + pod error-log extraction.
- `service-ops-stan.sh` — service/deployment/endpoints readiness + restart/error diagnostics.
- `smoke-liveness-stan.sh` — ingress + homepage + auth API + endpoint liveness checks.
- `deploy-validation-loop-stan.sh` — retries smoke+functional validation and captures diagnostics artifacts on failure.
- `validation-loop-stan.sh` — repeats health + HTTPS + E2E checks until pass/fail limit.
- `ingress-routing-guard-stan.sh` — static guard that fails when prod ingress host/path routing is unsafe.
- `shared-mongo-topology-guard-stan.sh` — blocks normal deployment unless the validated one-Mongo topology and eight shared URIs are live.
- `shared-mongo-operation-lock-stan.sh` — serializes migration, rollback, cleanup, and deployment through a resource-versioned ConfigMap lock.
- `consolidate-production-mongo-stan.sh` — exact-SHA preflight, migrate, cleanup, and rollback operator for the seven-database move into auth Mongo.
- `test-shared-mongo-consolidation-stan.sh` — validates manifests/mappings and runs a synthetic eight-database dump/restore parity test.
- `provision-stage-stan.sh` — creates isolated `betstan-rg-stage` AKS and configures autoscaler 1→3 with a larger baseline node size for 1-node stage operation.
- `park-stage-stan.sh` — stops stage AKS compute while keeping the stage resource group.
- `resume-stage-stan.sh` — starts stage AKS and runs quick readiness checks.
- `decommission-stage-rg-stan.sh` — deletes the entire stage resource group to remove stage costs.
- `reconcile-nodepool-profile-stan.sh` — creates or validates the `Standard_B4as_v2` + Managed 64 GiB OS disk profile and reconciles autoscaler `1..3`; it refuses workload cutover and legacy pool deletion.

Scripts assume the CLIs and authentication required by their operations are already available. The node-pool profile reconciler requires only `az` and does not change the user's Kubernetes context.

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
./infra/azure/agents/pr-merge-safety-stan.sh 41
```

The validation agent:
- binds the current PR head SHA, base SHA, and unique test-merge SHA;
- accepts only base-scoped statuses published by GitHub Actions on both snapshots;
- verifies the exact trusted workflow IDs, events, and PR relations behind both required statuses.

The merge-safety agent:
- rejects unsupported branch pairs;
- requires matching trusted runs on the current head and merge snapshots;
- recommends a `dev` merge only when validation is green;
- requires `APPROVED_SHA` and `APPROVED_WORKFLOWS` before recommending a production promotion.

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

1. Run `consolidate-production-mongo-stan.sh preflight` from the exact approved
   SHA.
2. Pause writers, drain RabbitMQ, create eight verified recovery copies, and run
   `migrate`.
3. Validate data, metadata, all eight application mappings, APIs, and queues.
4. Run `cleanup` with the explicit seven-volume deletion confirmation.
5. Retain the external recovery artifacts for seven days.

The rollback-only manifests are under `infra/k8s/legacy-mongo/` and are never
part of normal `kubectl apply -f infra/k8s`.

The operator requires a clean exact-SHA checkout and a private backup directory
outside the repository:

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

Never put `BACKUP_DIR` inside the repository. `cleanup` is immediate after
application validation; it is not a soak gate. Destructive operations acquire the persistent `gaming-mongo-migration-lock`
ConfigMap through a resource-versioned compare-and-swap. If an operator process
is killed and leaves it active, inspect the journal and workloads first, then
release only the matching stale lock with:

```bash
APPROVED_SHA=<full-master-sha> \
MIGRATION_ID=<approved-id> \
CONFIRM_UNLOCK=remove-stale-migration-lock \
./infra/azure/agents/consolidate-production-mongo-stan.sh unlock
```

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
