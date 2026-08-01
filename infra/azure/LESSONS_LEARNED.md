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
Before shared-Mongo cutover, all eight data-disk attachments are occupied. Do
not try to attach a ninth migration disk. The supported migration expands and
reuses the auth Mongo PVC, then removes the seven non-auth PVCs after validation.

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
- `/?(.*)` for the client SPA

Guard script: `infra/azure/agents/ingress-routing-guard-stan.sh`  
This guard runs in CI on pull requests targeting `dev` or `master` (`production-build.yml`).

### Expose production only through canonical HTTPS hosts
Production ingress must contain only the `betstan.xyz` and `www.betstan.xyz`
host rules and must redirect HTTP to HTTPS. Do not retain a hostless rule or a
temporary `nip.io` ingress: either route allows users and API clients to bypass
the canonical TLS entry point.

### Always validate with Host headers — not raw IPs
A check against the raw ingress IP (`http://<IP>/api/...`) can hide broken
host-based routing and should return the ingress default 404 rather than the
application.
Use domain-based checks: `curl https://www.betstan.xyz/api/event` **and** `curl https://betstan.xyz/api/event`.

---

## Database Topology

### One retained auth Mongo hosts all logical databases
The target topology is one `gaming-auth-mongo-depl` StatefulSet and PVC, exposed
to applications through `gaming-shared-mongo-srv`. The eight logical database
names remain unchanged.

Normal deployment is blocked until
`shared-mongo-topology-guard-stan.sh` confirms that the exact migration is
validated, the seven legacy StatefulSets/PVCs are gone, all eight Deployments
use the shared endpoint, and only the auth Mongo PVC remains.

Use `consolidate-production-mongo-stan.sh` for preflight, migration, cleanup, or
rollback. Cutover requires stopped writers, drained queues, verified logical and
storage recovery copies, full database parity, and exact deletion allowlists.
The migration and cleanup operations are separate commands so application
validation can complete before immediate legacy-volume deletion; there is no
soak period.

---

## Messaging Recovery

### Restart backends after RabbitMQ replacement
RabbitMQ runs as an ephemeral Deployment. Replacing its broker can leave queue declarations and consumers absent until clients reconnect. Restart all backend deployments sequentially after replacement so they redeclare all 17 queues and consumers, then verify consumer presence before declaring recovery complete.

---

## CI/CD and Branch Safety

### Dev integration is safe; only a dev promotion reaches production
- Never commit or push directly to `master`.
- Normal changes enter `dev`; direct pushes to `dev` are allowed, though focused PRs are preferred.
- Only an up-to-date pull request from `dev` may target `master`.
- A merge to `master` triggers `production-build` → `production-deploy` automatically.
- Review all infra changes with `pre-commit-infra-check-stan.sh` before pushing.
- After a squash promotion, immediately merge the new `master` commit back into `dev`.
- Manual emergency deployment uses only the central workflows, a full approved master SHA, and the reviewer-protected `production-emergency` environment.

### Required validation sequence for production changes
```
pre-commit-infra-check-stan.sh   ← before pushing branch
    ↓
feature/hotfix branch → dev      ← normal integration
    ↓
branch-policy + quality gates    ← matching head and merge snapshots
    ↓
dev → master promotion PR       ← exact-SHA production approval required
    ↓
post-merge-verification-stan.sh  ← required after every production merge
    ↓
master → dev synchronization     ← required after squash promotion
    ↓
rollback-readiness-stan.sh       ← required before any rollback action
```

### Do not promote stale infra/k8s/deploy changes
A stale `dev` promotion can push old manifest versions to production. Merge `master` into `dev`, resolve conflicts, and require exact-SHA CI before promotion.

---

## Stage Lifecycle

### Stage resource group can be deleted to cut costs
`infra/azure/agents/decommission-stage-rg-stan.sh` fully removes the stage AKS cluster and RG.  
Stage can be rebuilt from scratch using `infra/azure/agents/provision-stage-stan.sh`.

### Stage is isolated — never share secrets with production
Stage uses a separate `STAGE_AZURE_CREDENTIALS` and `STAGE_RESOURCE_GROUP` secret.  
The retired shared-database stage workflow must not be restored or used as a
production migration fallback.

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
Emits `rollback_readiness=GO` or `NO_GO` with explicit reasons. Checks production baseline health, queue pressure, rollout history depth, target-SHA workflow provenance, and whether normalized auth accounts are compatible with the requested rollback target.
