# OCI production lessons

These rules summarize proven BetStan OCI failure modes. Re-read live provider,
GitHub, DNS, and Kubernetes state before applying them; old run IDs and
conversation summaries are not authority.

## Identity and approvals

- Bind every mutation to one full current source SHA and one internally
  consistent build, capacity, infrastructure, deploy, or migration chain.
- Resolve the remote default branch SHA through GitHub or `git ls-remote`,
  fetch and verify that immutable commit, and read workflow, agent, manifest,
  and test evidence from that same tree. Revalidate the remote SHA immediately
  before mutation; local and remote-tracking refs are not authority.
- Absence from the current tree does not retire historical workflow runs.
  Require authoritative workflow-state and complete nonterminal-run queries,
  and fail closed when either query fails or cannot be fully paginated.
- A protected-environment approval wait is an active workflow state, not a
  hang. Never rerun or cancel it to bypass review.
- Recovery uses the interrupted migration journal SHA and fencing generation.
  Do not replace it with a newer `master` SHA.
- Only one mutation-producing release or migration workflow may run at once.

## Live feature activation

- A successful dark deployment is not permission to enable new live kickoffs.
  Bind activation to the exact first-attempt build, infrastructure, and deploy
  runs, the infrastructure artifact digest, and the selected runtime
  fingerprint; revalidate current `master` immediately before each mutation.
- Activate with a bounded `LIVE_KICKOFFS_LEASE_UNTIL_EPOCH`, not an
  unbounded boolean. Gamemaster must stop only new kickoffs when that lease is
  malformed or expired and continue persisted active simulations.
- Remove the lease only through a same-run, same-SHA commit after the complete
  browser journey, queue/log/restart checks, protected evidence upload, and a
  final provenance revalidation. A hard-killed runner before commit therefore
  expires independently.
- Disable and ambiguous-write recovery set `LIVE_KICKOFFS_ENABLED=false` and
  remove the lease in one deployment update. Normal signal traps are useful,
  but they are not a substitute for an expiry mechanism that survives
  `SIGKILL`.
- Production acceptance fixtures must start `OFFLINE`. Ordinary REST and SSE
  remain server-filtered, while exact fixture IDs require current persisted
  administrator verification; the odds path repeats that verification before
  allowing a synthetic selection.
- Acceptance must also prove that an anonymous backoffice catalog read returns
  `401` without fixture names. Live-update-first projections stay `OFFLINE`
  until event metadata establishes visibility; metadata repair must not undo a
  newer visibility message. Revoked scoped clients purge cached fixtures
  immediately, while healthy SSE clients still reconcile REST periodically so
  newly hidden events disappear.

## OCI provider behavior

- OCI deletion and registry layer reclamation are asynchronous. Wait for
  terminal provider state and accounting instead of assuming a successful
  delete response completed the operation.
- Manifest convergence and billable-layer convergence are independent.
  A registry can contain only the exact candidate, deployed rollback, and
  fallback manifests while `layers-size-in-bytes` still includes deleted,
  unreferenced layers. Never delete a protected rollback generation or bypass
  the 500 MB gate to make accounting appear green; retain the proven lineage
  and wait for provider garbage collection or reduce image weight in a
  separately reviewed build.
- OCIR exposes image/repository deletion and retention controls, but no
  user-triggered garbage-collection operation. Oracle documents that
  repository deletion and storage release can take up to 48 hours. Re-run the
  read-only registry validation while waiting; if accounting remains stale
  beyond that window, contact Oracle Support rather than deleting a protected
  generation or weakening the storage gate.
- A build that fails after publishing can leave a complete source-tagged image
  generation without a provenance artifact. Before pruning accumulated
  generations, protect the exact candidate, deployed, and fallback digest
  sets; bind every target to a terminal first-attempt build; and prove that
  protected plus target identities exhaust the registry before deleting the
  explicit batch. Permit partial target subsets only so an interrupted prune
  can safely converge.
- OCIR lists one row per tag, not necessarily one row per stored image.
  `imagetools create` reuse adds exact-SHA aliases that share an image OCID and
  digest. Repository `image-count` counts unique manifests, so reconcile it
  with unique digests/OCIDs while separately validating the complete alias
  inventory. Destructive checks must validate every alias while counting and
  deleting unique image IDs: require one service and digest per ID, one
  service and ID per digest, complete trusted alias generations, canonical
  protected tags, and equality of the exact protected OCID set before and
  after deletion rather than relying on counts alone. Candidate, deployed,
  and fallback source tags may legitimately share one complete nine-image set
  after reuse; permit exact whole-generation aliases but reject partial
  protected overlap.
- A destructive run should not be the first consumer of live provider
  evidence. Capture a read-only registry validation artifact first, then make
  apply require byte-for-byte equality of the live before-summary (all aliases,
  OCIDs, digests, lineage, and accounting) with that artifact before issuing
  any delete. The read-only phase may attest storage above the configured
  ceiling; enforce that ceiling after the approved obsolete identities have
  been deleted and provider accounting converges.
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
  `cutover-committed` and both internal write locks are released. During a
  full retry, a raw unlocked probe may safely reconcile a stale journal lock
  field left behind by a Mongo process restart; never infer that state from
  pod readiness alone.
- In MongoDB 8.2, mongosh `db.currentOp()` can omit the top-level `fsyncLock`
  field even while the raw `currentOp` database command reports it as true.
  The raw command omits the field while unlocked, so treat absence as false
  but reject command errors or malformed present values. Normalize BSON `Long`
  lock counts to JavaScript numbers before serializing them for shell
  validation.
- An application that awaits index reconciliation before opening its health
  port cannot start under Mongo `fsyncLock`, even when the identical index
  already exists. Keep ingress, RabbitMQ, and every other application at zero,
  start only that exact application while Mongo is unlocked, immediately lock
  Mongo after readiness, and recertify all canonical signatures under the lock
  before starting the remaining workloads. Do not move the RabbitMQ messaging
  fence ahead of consumer topology initialization: queue binding requires write
  permission even though external publishing is still blocked by zero ingress.
- A successful application rollout does not prove that asynchronous RabbitMQ
  queue declaration, binding, and consumer registration have converged.
  Gamemaster also publishes one result fanout every 60 seconds; under Mongo
  `fsyncLock`, its three deliveries remain unacknowledged and can never satisfy
  a zero-backlog gate. Start passive consumers first and gamemaster last, then
  require exact convergence within 45 seconds. Do not deny RabbitMQ write
  permission: the resulting channel error crashes gamemaster and removes
  consumers. Instead remove the exact 17 non-default exchange-to-queue
  bindings, verify queues and consumers stay stable with zero backlog, and
  execute the exact deletions as one bounded in-pod batch. A separate
  Bastion/kubectl round trip for each binding can exhaust the pre-timer deadline
  even after fast topology convergence. After commit, quiesce gamemaster before
  unlocking Mongo, then restore bindings by restarting passive consumers before
  gamemaster.
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
  that file into each reviewed isolated path before dual-cluster operations,
  including the stop-only recovery workflow when Azure is already running.
- A stopped AKS VMSS may retain deallocated instances or contain zero
  instances. Both prove that no node compute is running when the exact VMSS
  resource identity has already been verified.
- A stopped AKS cluster still incurs disk, load-balancer, public-IP, snapshot,
  and monitoring charges.
- Azure retirement is complete only after the AKS and managed resource groups,
  VMs/VMSS, disks, snapshots, load balancers, public IPs, alerts, and temporary
  identities are absent. CLI acceptance is not resource absence.
- Keep retirement's strict migration-success field allowlist synchronized with
  the producer. Recovery retries add runtime deployment lineage fields; accept
  them only with their exact names and validate the retry flag against the
  runtime and active source SHAs.
- Azure resource-ID fingerprints are case-preserving. Do not lowercase the
  live AKS ID before comparing it with migration and recovery evidence.
- Azure data APIs may return the same subscription GUID with different casing.
  Compare that GUID case-insensitively while keeping the active-account
  fingerprint case-preserving.
- Legacy Usage Details may reuse one ARM `id` for distinct charge lines. Do not
  treat it as a line-item key; validate every row and preserve the raw page
  digest so repeated identifiers cannot hide a positive charge.
- Current AKS output exposes `eTag`, not only `etag`. Some `aks-preview`
  versions quote a supplied UUID before sending `If-Match`, although the AKS
  delete endpoint requires the exact emitted value. Preserve the reviewed
  ETag literally through an ARM delete request; never fall back to `*`.
- macOS LibreSSL can finish a verified `s_client` handshake and then exit with
  `poll error` when stdin is `/dev/null`. Send its graceful `Q` command so the
  trust-verifying pipeline remains fail-closed without rejecting a valid
  certificate.
- Keep resource and temporary-identity retirement separate. Resource-group
  deletion can remove scoped assignments but not app registrations, service
  principals, custom roles, or protected GitHub secrets. Delete those through
  exact private metadata and explicitly retain the zero-cost Azure recreation
  identity and repository credential.
- A GitHub run can remain `queued` with zero jobs, zero pending deployments,
  and unchanged timestamps even when its workflow is disabled. Treat that as
  a reported provider artifact only after exact provenance checks; never
  re-enable or approve production work just to clear the record.
- Fixed repository fixture directories are not safe when contract suites run
  concurrently. Use unique temporary directories and ensure output filtering
  cannot mask a non-zero test exit.
- Delayed historical charges are not current resources. Continue bounded
  Cost Management checks until no new BetStan usage appears.
- Daily usage cannot attribute the partial UTC retirement day. Keep the exact
  resource cutoff, define the next UTC midnight as the billing boundary, and
  start the 96-hour ingestion grace there. Require at least three individually
  hashed clean observations, at least 24 hours between adjacent observations,
  at least 96 hours from first to last, and a final observation no more than
  48 hours old. Both ActualCost and AmortizedCost must be clean in every
  window.
- Normalize every Cost Management page into one canonical column order before
  combining rows. Validate exact column names and types, bounded non-cyclic
  `nextLink` values, dates, currencies, and row shapes on every page. Repeat
  the original POST body for each exact-subscription continuation and scope
  the provider query to the two reviewed BetStan resource groups. Bound
  transient request retries, but never retry malformed successful data into a
  different classification; a parse failure is never equivalent to the last
  page.
- Record each cost type from one response stream so its result, currency, and
  digest cannot come from different queries. Bind item-level usage details
  into the digest so a positive charge cannot net against a refund. Serialize
  writers with an owner-verifiable atomic lock, recover only dead owners,
  preserve the complete prior prefix, and chain each observation before an
  atomic same-directory replacement. Signal handlers must terminate before
  cleanup releases the lock, and trailing `NO_ROWS` windows must not reset an
  established currency.
- Cost rows before the full-day billing boundary are historical. A positive
  BetStan row on or after that date is `NO_GO`; malformed data is
  `AUDIT_INCOMPLETE`; missing or immature evidence remains
  `BILLING_INGESTION_PENDING`. A negative post-cutoff adjustment is not proof
  of running infrastructure, but it remains pending until classified.
- Azure CLI can return an error for a deleted service principal queried with
  a server-side object-ID filter. Prove absence through a successful
  `az ad sp list --all` response and an exact client-side count; never parse
  localized 404 text as absence.
- Validate each role-assignment resource ID against its declared parent scope
  before any provider call. Syntax and subscription binding alone do not
  prevent a valid-shaped ID under a substituted resource group or AKS scope.
- Historical cleanup evidence must use the same 23-field terminal identity
  schema as the current operator. If exact state was reconstructed from
  retained events, bind it to a strict private legacy attestation rather than
  weakening live checks to broad display-name searches.

## Decision quality

- Never return a blind `NO_GO`. Collect bounded sanitized diagnostics,
  classify the failure as transient, partial, stale identity, approval wait,
  automation defect, or safety invariant, and name the exact safe next action.
- When a new failure class is proven, add a regression fixture and update the
  owning agent before retrying production.
