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

### Canonical ingress must cover every API path
The current OCI-primary contract serves all API paths on `betstan.xyz` and
redirects both `www` schemes to the apex. The diagnostic OCI host mirrors the
apex routes. Historical Azure manifests served both hosts directly; their
static guard remains relevant only until Azure retirement or future explicit
recreation.

If a serving host block is missing, `/api/*` can fall through to the client
catch-all and return HTML instead of JSON. This looks like missing data or a
silent service failure.

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
Production must expose trusted `https://betstan.xyz`; `www` redirects to it.
OCI retains only its provenance-derived `nip.io` diagnostic host. Do not
retain a hostless rule or treat the diagnostic endpoint as canonical.

### Always validate with Host headers — not raw IPs
A check against the raw ingress IP (`http://<IP>/api/...`) can hide broken
host-based routing and should return the ingress default 404 rather than the
application.
Use domain-based checks: validate the `www` redirect and request
`https://betstan.xyz/api/event` as JSON.

---

## Database Topology

### Topology is journal-dependent
The supported final topology is one `gaming-auth-mongo-depl` StatefulSet and
PVC, exposed through `gaming-shared-mongo-srv`, with all eight logical database
names unchanged. Do not assume that final topology before live evidence:

- no journal or `legacy/rollback-complete`: the legacy databases are the source
  of truth;
- `transition/*`: migration or rollback is incomplete and normal deployment is
  blocked;
- `shared/complete`: cleanup and the final topology guard have passed.

`shared-mongo-topology-guard-stan.sh` requires the validated marker, one ready
auth Mongo PVC of the required capacity, no seven legacy StatefulSets/PVCs, and
all eight exact shared URIs.

### Use one operator and one operation lock
Use `consolidate-production-mongo-stan.sh` for preflight, migration, cleanup,
rollback, and stale-lock recovery. Do not replace it with ad hoc dump, restore,
URI, manifest, or deletion commands.

Migration, cleanup, rollback, and deployment share the persistent
`gaming-mongo-migration-lock`. Acquisition and release use resource-versioned
compare-and-swap. A lock release error fails an otherwise successful operation,
and a stale lock may be released only when its operation ID and source SHA
match. Kubernetes/API read errors mean unknown state, never NotFound.

### A complete write freeze includes pod termination
RabbitMQ must have zero ready and unacknowledged messages before applications
stop. Scale-to-zero is complete only when every backend Deployment has zero
desired, available, and ready replicas and no matching pods remain. Starting a
backup while terminating pods can still write is not a consistent snapshot.

### Restore semantics must remove destination-only collections
`mongorestore --drop` drops collections present in the archive; it does not
remove destination-only collections. Before forward or reverse restore, drop
only the exact named destination database, then restore its exact namespace and
compare canonical data and metadata signatures.

Counts alone are insufficient. Signatures cover collection hashes, indexes,
validators, options, collations, views, capped/time-series metadata, and
collection presence. Cleanup rejects missing, empty, duplicate, unknown, or
structurally mismatched databases.

### Rollback behavior depends on the journal phase
- In `backing-up`, `preparing-target`, `restoring`, and `switching`, legacy data
  remains authoritative. Do not overwrite it from a partial shared target.
- In `validating-applications`, `awaiting-cleanup`, `rollback-copying`, or
  `shared/complete`, shared applications may have written. Preserve those
  writes by reverse-copying before switching to legacy.
- In `rollback-data-restored`, do not repeat the destructive reverse copy.
- After `legacy/rollback-complete`, use a fresh migration ID and fresh backups;
  never reuse stale artifacts.

Backup and cleanup journals must be exact, private, written atomically, and
bound to the migration ID and full source SHA.

### Bound PVC capacity and claim templates are different
The retained auth PVC is expanded online after StorageClass expansion is
verified. The StatefulSet claim template remains at its immutable original
request and is not evidence of the bound PVC's current capacity. Do not
recreate the StatefulSet merely to change that template, especially while its
Mongo image is unpinned.

### No soak still requires complete validation
Migration and cleanup are separate commands. There is no soak period, but
cleanup starts only after data/metadata parity, all application mappings,
representative application behavior, APIs, and queues pass. Cleanup deletes
only the seven exact allowlisted StatefulSets, Services, and PVCs and waits for
their journaled PVs to be reclaimed.

The live legacy volumes are deleted immediately after validation. Verified
logical and storage recovery artifacts remain private and retained for seven
days.

---

## Messaging Recovery

### Restart backends after RabbitMQ replacement
RabbitMQ runs as an ephemeral Deployment. Replacing its broker can leave queue declarations and consumers absent until clients reconnect. Restart all backend deployments sequentially after replacement so they redeclare all 17 queues and consumers, then verify consumer presence before declaring recovery complete.

---

## CI/CD and Branch Safety

### Dev integration is safe; only a dev promotion reaches production
- Never commit or push directly to `master`.
- Normal changes enter `dev` through focused pull requests; do not push directly
  to protected `dev`.
- Only an up-to-date pull request from `dev` may target `master`.
- A merge to `master` starts the protected `production-build` path. Production
  deployment is a separate exact-SHA `production-deploy` dispatch after a
  successful approved build; production never deploys automatically.
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
