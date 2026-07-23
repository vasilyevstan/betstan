# Azure operation agents (`*-stan`)

- `provisioning-stan.sh` — runs full AKS provisioning flow.
- `deploy-stan.sh` — applies Kubernetes manifests to AKS.
- `troubleshoot-stan.sh` — prints cluster/workload/ingress diagnostics.
- `cost-ops-stan.sh` — stop/start/scale controls for cost management.
- `qa-e2e-stan.sh` — runs Playwright browser smoke tests.
- `dns-check-stan.sh` — compares public DNS answer with ingress external IP.
- `validation-loop-stan.sh` — repeats health + HTTPS + E2E checks until pass/fail limit.

All scripts assume `az`, `kubectl`, and required auth/context are already set.

Suggested execution order:
1. `provisioning-stan.sh`
2. `deploy-stan.sh`
3. `dns-check-stan.sh`
4. `qa-e2e-stan.sh`
5. `validation-loop-stan.sh`
