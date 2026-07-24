# Azure operation agents (`*-stan`)

- `provisioning-stan.sh` — runs full AKS provisioning flow.
- `deploy-stan.sh` — applies Kubernetes manifests to AKS.
- `troubleshoot-stan.sh` — prints cluster/workload/ingress diagnostics.
- `cost-ops-stan.sh` — stop/start/scale controls for cost management.
- `qa-e2e-stan.sh` — runs Playwright browser smoke tests.
- `dns-check-stan.sh` — compares public DNS answer with ingress external IP.
- `node-logs-stan.sh` — node-level health/events + pod error-log extraction.
- `service-ops-stan.sh` — service/deployment/endpoints readiness + restart/error diagnostics.
- `smoke-liveness-stan.sh` — ingress + homepage + auth API + endpoint liveness checks.
- `deploy-validation-loop-stan.sh` — retries smoke+functional validation and captures diagnostics artifacts on failure.
- `validation-loop-stan.sh` — repeats health + HTTPS + E2E checks until pass/fail limit.

All scripts assume `az`, `kubectl`, and required auth/context are already set.

Suggested execution order:
1. `provisioning-stan.sh`
2. `deploy-stan.sh`
3. `dns-check-stan.sh`
4. `qa-e2e-stan.sh`
5. `smoke-liveness-stan.sh`
6. `deploy-validation-loop-stan.sh`
7. `validation-loop-stan.sh`

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
