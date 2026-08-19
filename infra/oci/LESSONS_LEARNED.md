# OCI production lessons

These rules summarize proven BetStan OCI failure modes. Re-read live provider,
GitHub, DNS, and Kubernetes state before applying them; old run IDs and
conversation summaries are not authority.

## Identity and approvals

- Bind every mutation to one full current source SHA and one internally
  consistent build, capacity, infrastructure, deploy, or migration chain.
- A protected-environment approval wait is an active workflow state, not a
  hang. Never rerun or cancel it to bypass review.
- Recovery uses the interrupted migration journal SHA and fencing generation.
  Do not replace it with a newer `master` SHA.
- Only one mutation-producing release or migration workflow may run at once.

## OCI provider behavior

- OCI deletion and registry layer reclamation are asynchronous. Wait for
  terminal provider state and accounting instead of assuming a successful
  delete response completed the operation.
- Normalize documented case-insensitive provider enums before comparing them.
  OCI has returned values such as `paravirtualized` in lowercase.
- A healthy load-balancer control plane does not prove a healthy data plane.
  Use repeated HTTP and HTTPS probes plus backend evidence.
- Do not invent unsupported load-balancer refresh operations. Reconcile
  listeners, backend sets, and health first. A full one-at-a-time replacement
  requires exact ownership evidence and separate approval.
- Direct Bastion forwarding to k3s port 6443 is blocked by the OCI Ubuntu host
  firewall. Use one Bastion session to target SSH and a target-loopback tunnel
  to `127.0.0.1:6443`.
- An OCI Bastion session can report `ACTIVE` before its SSH endpoint accepts a
  durable tunnel. Retry the tunnel against that same exact session with a
  bounded backoff, clearing and persisting each failed PID; do not create
  duplicate sessions or weaken cleanup.

## Canonical production routing

- `https://betstan.xyz` is canonical. Both schemes on `www.betstan.xyz`
  permanently redirect to the apex while preserving path and query.
- The IP-derived `nip.io` host is diagnostic only and cannot substitute for
  canonical DNS, routing, or trusted TLS health.
- Verify A records against exact load-balancer provenance, reject unexpected
  AAAA records, require trusted certificate SANs, and test API JSON shapes.
  HTTP 200 with client HTML on an API path is a routing failure.

## Azure-to-OCI replacement

- OCI is primary. Azure is a frozen source only during the approved
  maintenance migration.
- The approved migration is an exact logical replacement with no retained
  backup. Once OCI target mutation begins, previous OCI data is unrecoverable.
- No retained backup or old-OCI rollback exists.
- The legacy Azure Mongo manifests use the mutable `mongo` image reference.
  Read and record every live source image digest, server version, and FCV
  before target mutation; repository history does not prove source runtime.
  Bind the capture to each pod UID, container ID, restart count, digest,
  version, and FCV. Persist that complete manifest in both journals and recheck
  it around every dump so a restart cannot silently pull a different image.
- Never skip Mongo's supported upgrade sequence to align the disposable OCI
  target. Freeze ingress and writers, move 7.0 to the exact pinned 8.0 binary,
  advance FCV to 8.0, then move to the exact pinned 8.2 binary and FCV 8.2.
  A failed or interrupted deployment remains closed and resumes only from one
  of those reviewed image/version/FCV states.
- Keep Azure disks until OCI database signatures and full application health
  pass. After destructive failure, keep OCI closed and retry the complete
  replacement from Azure; never expose mixed data.
- Mongo `fsyncLock` is process-local and disappears if the Mongo container
  restarts. Before reopening ingress for pre-commit checks, add the reviewed
  ingress-nginx ConfigMap fence that rejects mutating HTTP methods, verify it
  in the running NGINX configuration, and mirror its state in both journals.
  Keep it across every pre-commit failure and remove it only after
  `cutover-committed` and both internal write locks are released.
- In MongoDB 8.2, mongosh `db.currentOp()` can omit the top-level `fsyncLock`
  field even while the raw `currentOp` database command reports it as true.
  The raw command omits the field while unlocked, so treat absence as false
  but reject command errors or malformed present values. Normalize BSON `Long`
  lock counts to JavaScript numbers before serializing them for shell
  validation.
- Pre-commit public checks must be read-only and prove the HTTP mutation fence.
  Run the mutating browser journey only after commit and fence removal; never
  let a validation write invalidate the certified source/target signatures.
- A stale heartbeat does not authorize blind lock deletion. Verify the owner
  run is conclusively inactive, both cluster locks and fingerprints agree, and
  the fencing generation is advanced atomically.
- Preserve the journal's original source SHA as immutable lineage. A
  descendant hotfix can replace only the active source SHA. For an unlocked
  `failed-before-destructive-boundary` phase, require unchanged OCI replicas,
  fully frozen Azure applications/ingress, no Azure queue backlog, and no live
  Mongo, RabbitMQ, or HTTP write fence. For `recovery-required`, require the
  destructive and recovery flags, active journal lock, frozen Azure, closed
  OCI ingress/applications/RabbitMQ, retained HTTP fence, and the original
  active replica baseline before atomically advancing the owner and fencing
  generation.
- Recovery bindings belong to the `azure-migration-recovery` GitHub
  environment. Repository variables with the same names do not override stale
  environment values.
- Checkout removes untracked directories created by earlier workflow steps.
  Recreate sanitized recovery artifact directories after checkout before
  writing evidence.
- A recovery watchdog may freeze applications and stop/deallocate Azure. It
  must never start Azure, reopen OCI, delete data, or tear down resources.

## Azure cost and retirement

- AKS control-plane power fields can disagree with VMSS instance power. Use
  instance view and Cost Management to determine running compute.
- A stopped legacy AKS control plane can report `Failed`/`Deallocated` instead
  of `Succeeded`/`Stopped`. Accept that combination only as the exact
  pre-start or already-deallocated state, then require `Succeeded`/`Running`
  after start and independently prove VMSS deallocation after stop.
- `azure/aks-set-context` writes a runner-generated kubeconfig and exports
  `KUBE_CONFIG_PATH`; it does not honor a preselected output path. Materialize
  that file into each reviewed isolated path before dual-cluster operations.
- A stopped AKS VMSS may retain deallocated instances or contain zero
  instances. Both prove that no node compute is running when the exact VMSS
  resource identity has already been verified.
- A stopped AKS cluster still incurs disk, load-balancer, public-IP, snapshot,
  and monitoring charges.
- Azure retirement is complete only after the AKS and managed resource groups,
  VMs/VMSS, disks, snapshots, load balancers, public IPs, alerts, and temporary
  identities are absent. CLI acceptance is not resource absence.
- Delayed historical charges are not current resources. Continue bounded
  Cost Management checks until no new BetStan usage appears.

## Decision quality

- Never return a blind `NO_GO`. Collect bounded sanitized diagnostics,
  classify the failure as transient, partial, stale identity, approval wait,
  automation defect, or safety invariant, and name the exact safe next action.
- When a new failure class is proven, add a regression fixture and update the
  owning agent before retrying production.
