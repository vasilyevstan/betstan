# Azure operation agents (`*-stan`)

- `provisioning-stan.sh` — runs full AKS provisioning flow.
- `deploy-stan.sh` — applies Kubernetes manifests to AKS.
- `troubleshoot-stan.sh` — prints cluster/workload/ingress diagnostics.
- `cost-ops-stan.sh` — stop/start/scale controls for cost management.
- `qa-e2e-stan.sh` — runs Playwright browser smoke tests.
- `dns-check-stan.sh` — compares public DNS answer with ingress external IP.
- `health-check-stan.sh` — reusable per-service AKS health checks with node/log/SSH diagnostics.
- `mismatch-diagnostic-stan.sh` — traces event-service vs gamemaster event-stream mismatches for a specific event.
- `pr-validation-stan.sh` — inspects the latest build-push validation run for a PR and classifies failing jobs.
- `pr-merge-safety-stan.sh` — wraps PR validation and gives a conservative merge-safe/split recommendation.
- `node-logs-stan.sh` — node-level health/events + pod error-log extraction.
- `service-ops-stan.sh` — service/deployment/endpoints readiness + restart/error diagnostics.
- `smoke-liveness-stan.sh` — ingress + homepage + auth API + endpoint liveness checks.
- `deploy-validation-loop-stan.sh` — retries smoke+functional validation and captures diagnostics artifacts on failure.
- `validation-loop-stan.sh` — repeats health + HTTPS + E2E checks until pass/fail limit.
- `ingress-routing-guard-stan.sh` — static guard that fails when prod ingress host/path routing is unsafe.
- `provision-stage-stan.sh` — creates isolated `betstan-rg-stage` AKS and configures autoscaler 1→3 with a larger baseline node size for 1-node stage operation.
- `park-stage-stan.sh` — stops stage AKS compute while keeping the stage resource group.
- `resume-stage-stan.sh` — starts stage AKS and runs quick readiness checks.
- `decommission-stage-rg-stan.sh` — deletes the entire stage resource group to remove stage costs.
- `reconcile-nodepool-profile-stan.sh` — enforces `Standard_B4ms` + autoscaler `1..3` profile (safe-by-default, optional cutover).
- `deploy-stage-shared-db-stan.sh` — stage-only deploy with shared Mongo cutover (connection-string-only service changes).
- `revert-stage-legacy-mongo-stan.sh` — rollback stage from shared Mongo back to per-service Mongo services.
- `stage-soak-validation-stan.sh` — 24h-style looped stage validation (smoke + service ops + node checks).

All scripts assume `az`, `kubectl`, and required auth/context are already set.

Suggested execution order:
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

Use the PR validation agent when you need to inspect the latest build-push run for a branch:

```bash
./infra/azure/agents/pr-validation-stan.sh 41
```

Use the merge-safety agent when you want a conservative yes/no recommendation:

```bash
./infra/azure/agents/pr-merge-safety-stan.sh 41
```

The validation agent:
- prints PR metadata and the latest workflow run,
- lists all jobs and flags failed ones,
- classifies common failure patterns such as test timeouts, open handles, listener mock errors, and mongodb cache issues.

The merge-safety agent:
- runs validation,
- recommends merge only when the latest validation is green,
- otherwise recommends splitting deploy-recovery work from coverage/test-harness fixes.

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

- `build-push` runs on `master` and tags each image with `${GITHUB_SHA}`.
- `build-push` pull requests now run `ingress-routing-guard-stan.sh` and block unsafe ingress host/path edits before merge.
- `deploy-manifests` runs only after successful `build-push` on `master` and deploys that exact SHA image set.
- Deploy workflow blocks when mongo PVC count is unexpectedly low, avoiding deployment against unsafe DB storage state.
- Deploy workflow now runs `deploy-validation-loop-stan.sh` as required post-rollout gate and uploads diagnostics artifacts on failure.

## Deploy validation loop settings

`deploy-validation-loop-stan.sh` supports:
- `DOMAIN` (default `48.206.235.122.nip.io`)
- `CERT_NAME` (default `betstan-nip-tls`)
- `E2E_BASE_URL` (auto-derived from ingress IP when empty)
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
- In GitHub Actions (`deploy-manifests`), these files are uploaded by `Upload deploy diagnostics` when the job fails.

## Stage-only shared DB test flow (no production touch)

Current status: this path is **parked/deferred**. Active topology remains per-service Mongo instances.

1. Provision stage:
   - `JWT_KEY='<stage-jwt-secret>' ./infra/azure/agents/provision-stage-stan.sh`
2. Deploy and migrate to shared DB in stage:
   - `./infra/azure/agents/deploy-stage-shared-db-stan.sh`
3. Run soak loop for 24h:
   - `SOAK_HOURS=24 INTERVAL_SECONDS=600 ./infra/azure/agents/stage-soak-validation-stan.sh`
4. If instability/saturation appears, rollback stage:
   - `./infra/azure/agents/revert-stage-legacy-mongo-stan.sh`

Branch workflow:
- Use `.github/workflows/deploy-stage-shared-db.yml` from a non-`master` branch.
- Production promotion remains manual and requires explicit user go-ahead.

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

Profile reconciliation helper:

```bash
# Safe mode (prints/aligns profile, no workload move)
./infra/azure/agents/reconcile-nodepool-profile-stan.sh

# Execute cutover + remove legacy pool
EXECUTE_CUTOVER=true DELETE_LEGACY_POOL=true ./infra/azure/agents/reconcile-nodepool-profile-stan.sh
```
