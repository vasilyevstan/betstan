# Operations Lessons Learned

Operational rules and patterns derived from running and hardening the betstan AKS production cluster.  
Apply these before making infrastructure, deployment, or routing changes.

---

## AKS Node and Cluster Operations

### AKS VM size changes require a replacement nodepool
In-place node VM size changes are **not supported** in AKS.  
The required pattern is:
1. Add a new nodepool with the target VM size.
2. Cordon all nodes in the old pool.
3. Drain / reschedule workloads onto the new pool.
4. Delete the old pool.

Script: `infra/azure/agents/reconcile-nodepool-profile-stan.sh`

### Stable production baseline
- Exactly one System pool: `nodepool4`.
- VM size: `Standard_B4as_v2`.
- OS disk: Managed, 64 GiB.
- Current node count: 1.
- Autoscaler bounds: `min=1, max=3`.
- `Standard_B2s` is too small for the full service set on a single node.

### Data-disk attachment limits constrain VM selection
`Standard_E2ads_v5` supports only four data-disk attachments. The stable topology has eight per-service Mongo PVC disks, so that VM size cannot host the workload on one node.

### Do not use a 30 GiB Ephemeral OS disk for this workload
A trial `Standard_B4ms` pool with a 30 GiB Ephemeral OS disk failed when concurrent image pulls exhausted the node OS filesystem. The node entered `DiskPressure` and evicted two pods, so the trial pool was deleted. Keep the Managed 64 GiB baseline and roll application services out sequentially.

---

## Ingress and Routing

### Ingress must cover both the apex domain and www
Both `betstan.xyz` and `www.betstan.xyz` must have host-specific rule blocks with **all** API paths.  
If the apex host block is missing, requests to `betstan.xyz/api/*` fall through to the client catch-all and return HTML instead of JSON — this looks like "no events" or silent service failures.

**Required paths in each host block:**
- `/api/auth/?(.*)`
- `/api/event/?(.*)`
- `/api/slip/?(.*)`
- `/api/bet/?(.*)`
- `/api/backoffice/?(.*)`

Guard script: `infra/azure/agents/ingress-routing-guard-stan.sh`  
This guard runs in CI on every PR targeting `master` (`build-push.yml`).

### Always validate with Host headers — not raw IPs
A check against the raw ingress IP (`http://<IP>/api/...`) can return 200 even when the host-based routing is broken.  
Use domain-based checks: `curl https://www.betstan.xyz/api/event` **and** `curl https://betstan.xyz/api/event`.

---

## Database Topology

### Per-service Mongo is the stable topology
Each microservice has its own dedicated Mongo StatefulSet and ClusterIP service.  
Consolidation to a shared Mongo instance was tested in stage, produced complications, and is **deferred**.  
Do not promote the shared-DB path to production without a complete stage soak cycle first.

Stage test scripts when revisiting: `infra/azure/agents/deploy-stage-shared-db-stan.sh` and `infra/azure/agents/stage-soak-validation-stan.sh`.

---

## Messaging Recovery

### Restart backends after RabbitMQ replacement
RabbitMQ runs as an ephemeral Deployment. Replacing its broker can leave queue declarations and consumers absent until clients reconnect. Restart all backend deployments sequentially after replacement so they redeclare all 17 queues and consumers, then verify consumer presence before declaring recovery complete.

---

## CI/CD and Branch Safety

### Branch commits are safe; master merge triggers production
- Commits to any branch do **not** trigger a production deploy.
- Merge to `master` triggers `build-push` → `deploy-manifests` automatically.
- Review all infra changes with `pre-commit-infra-check-stan.sh` before pushing a branch.

### Required validation sequence for production changes
```
pre-commit-infra-check-stan.sh   ← before pushing branch
    ↓
ingress-routing-guard-stan.sh    ← in CI on PR (auto-runs)
    ↓
MERGE to master
    ↓
post-merge-verification-stan.sh  ← required after every production merge
    ↓
rollback-readiness-stan.sh       ← required before any rollback action
```

### Do not merge infra/k8s/deploy changes on an active hotfix branch
Merging with outstanding conflicts on an infra branch can push stale manifest versions to production.  
Always rebase or merge master into the branch, resolve conflicts, and verify CI passes before merging.

---

## Stage Lifecycle

### Stage resource group can be deleted to cut costs
`infra/azure/agents/decommission-stage-rg-stan.sh` fully removes the stage AKS cluster and RG.  
Stage can be rebuilt from scratch using `infra/azure/agents/provision-stage-stan.sh`.

### Stage is isolated — never share secrets with production
Stage uses a separate `STAGE_AZURE_CREDENTIALS` and `STAGE_RESOURCE_GROUP` secret.  
The stage workflow (`deploy-stage-shared-db.yml`) is blocked from running on `master` (`if: github.ref_name != 'master'`).

---

## Security and Secrets Hygiene

### Never hard-code secrets in agent scripts or k8s manifests
- Agent scripts must use env-var defaults: `SOME_SECRET="${SOME_SECRET:-}"`.
- Workflows must use `${{ secrets.MY_SECRET }}`.
- Kubernetes secrets must be applied with `kubectl create secret` from CI, never stored in YAML files.

### Scanning before committing
Run `infra/azure/agents/pre-commit-infra-check-stan.sh` on any changed infra file before committing.  
It checks for common secrets patterns and validates the ingress guard passes.

### Exclude runtime artifacts from the repository
The `artifacts/` directory is generated by `deploy-validation-loop-stan.sh` and must never be committed.  
It is listed in `.gitignore`.

---

## Monitoring and Health Checks

### Use `service-ops-stan.sh` for routine service health
Checks deployments, statefulsets, pod status, endpoints, restart counts, and recent error logs.

### Use `post-merge-verification-stan.sh` after every production merge
Confirms workflow runs succeeded for the exact merge SHA, validates API on both hosts, checks workload readiness, and confirms RabbitMQ consumer presence.

### Use `rollback-readiness-stan.sh` before taking rollback action
Emits `rollback_readiness=GO` or `NO_GO` with explicit reasons. Checks production baseline health, queue pressure, rollout history depth, and optionally validates target-SHA workflow provenance.
