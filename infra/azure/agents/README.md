# Azure operation agents (`*-stan`)

- `provisioning-stan.sh` — runs full AKS provisioning flow.
- `deploy-stan.sh` — applies Kubernetes manifests to AKS.
- `troubleshoot-stan.sh` — prints cluster/workload/ingress diagnostics.
- `cost-ops-stan.sh` — stop/start/scale controls for cost management.

All scripts assume `az`, `kubectl`, and required auth/context are already set.
