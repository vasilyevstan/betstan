# BetStan OCI Always Free production

OCI is BetStan's primary production path. The canonical URL is
`https://betstan.xyz`; `www.betstan.xyz` redirects permanently to the apex,
and the load-balancer-derived `nip.io` host remains diagnostic. Azure
deployment automation remains available for an explicitly approved future
recreation, but no Azure workload may replace or alter OCI implicitly.

This directory is the Oracle Cloud Infrastructure production path. Migration
does not alter canonical DNS or reuse Azure credentials outside its protected
source-only workflow. Azure remains the frozen recovery source until the OCI
replacement passes; Azure deletion is a later operation outside this path.
The preferred target is one directly launched `VM.Standard.A1.Flex` VM
(2 OCPUs, 12 GiB) running pinned single-node k3s, one 50 GiB Mongo block
volume, and one 10/10 Mbps flexible load balancer. The existing OKE Basic path
remains an explicit fallback selected with `OCI_RUNTIME_MODE=oke`.

## Safety contract

- Run only in the dedicated compartment identified by
  `OCI_COMPARTMENT_OCID`; resources are never discovered by name alone.
- Runtime selection is explicit. Scripts never fall from k3s to OKE or from
  OKE to k3s.
- The tenancy home region, pinned runtime image, and pinned Kubernetes
  distribution are required inputs. Scripts stop rather than guessing
  region-specific or potentially billable values.
- `OCI_A1_OCPUS=2`, `OCI_A1_MEMORY_GB=12`,
  `OCI_MONGO_VOLUME_GB=50`, `OCI_LB_MIN_MBPS=10`,
  `OCI_LB_MAX_MBPS=10`, and `OCI_EXPECTED_MONTHLY_COST=0` are immutable
  Free Tier gates.
- Application images are public GHCR images in exactly
  `ghcr.io/vasilyevstan/betstan-images`; OCI remains the runtime provider, not
  the application registry. Each service uses the immutable
  `arm64-<service>-<full-source-sha>` tag only as publication evidence and is
  deployed by `@sha256` digest only. The public package must first be made
  public once in GitHub Package settings after the protected sentinel
  bootstrap; workflow validation proves metadata, repository linkage, and an
  unauthenticated pull before a build or infrastructure finalization succeeds.
  k3s uses no GHCR imagePullSecret or long-lived registry token.
- `ghcr-package-management` validates before pruning. It protects the
  bootstrap sentinel, current candidate, deployed generation, and one
  compatible last-known-good generation. Each protected generation is rebound
  to its exact unexpired build plus successful deployment, or to its exact
  completed cache-recovery artifact, and is anonymously reverified; a
  recovered baseline is never represented as a normal GHCR build. Package
  metadata uses the account-scoped GitHub Packages API. Untagged child/staging
  manifests are recorded but do not invalidate otherwise complete immutable
  generations. Mixed, partial, ambiguous, or all-version deletion plans fail
  closed.
  Legacy OCIR inventory/prune evidence remains retirement-only and has no
  forward deployment authority. In GHCR mode OCI finalization requires the
  former `${OCI_IMAGE_PREFIX}_images` repository to be absent with zero
  application images.
- [GitHub Packages billing documentation](https://docs.github.com/billing/concepts/product-billing/github-packages)
  currently describes public Container Registry package storage and bandwidth
  as free. This is not a perpetual-cost guarantee: retain GitHub's documented
  one-month notice policy for pricing-policy changes in operational review,
  and do not add a paid registry as fallback.
- OCI CLI execution is fail-closed on the reviewed `3.90.0` client version.
- There is no paid shape, enhanced-cluster, NAT gateway, extra node, extra
  Mongo, or alternate load-balancer fallback.
- Only the OCI load balancer exposes ports 80/443. In k3s mode, ingress-nginx
  uses fixed NodePorts 30080/30443 and the Kubernetes API is reachable only
  through a short-lived OCI Bastion SSH session and a target-loopback tunnel.
  The runner pins the target host key through OCI Instance Agent Run Command
  before SSH. The same authenticated command independently observes the
  regional Bastion ED25519 key; authenticated session metadata takes
  precedence when OCI supplies it, while the command-attested key is the
  fail-closed fallback because ACTIVE port-forwarding sessions can return null
  `bastion-public-host-key-info`. The command returns both keys with
  node-generated SHA-256 values because Oracle Cloud Agent 1.61 can omit the
  response `text-sha256`; any OCI checksum that is present is verified as an
  additional integrity boundary. A healthy command may remain `ACCEPTED` for
  more than three minutes, so access setup uses a bounded five-minute poll
  window. Imported k3s kubeconfigs are reduced to one loopback cluster and
  inline certificates; executable providers, tokens, proxies, and external
  credential files are rejected before any API request.
  Mongo and RabbitMQ remain `ClusterIP`.
- The apex and `www` A records must equal exact load-balancer provenance and
  must not have a conflicting AAAA record. Canonical and diagnostic
  certificates must be trusted and Ready before migration or deployment is
  healthy.
- The Kustomize overlay explicitly lists nine application manifests,
  RabbitMQ, and `auth-mongo-depl.yaml`. It never traverses
  `infra/k8s/legacy-mongo`.
- Application images use immutable public GHCR digests. The upstream Node, nginx,
  Mongo, and RabbitMQ images are also pinned by verified multi-architecture
  index digest.

## Configuration

Copy `config/free-tier.env.example` outside version control, fill every
`REQUIRED` value, and source it. Never put credentials, real OCIDs, or
kubeconfigs in the repository.

The GitHub environments use the variables and secrets approved in the plan:

- Environments: `oci-build`, `oci-capacity-acquire`,
  `oci-infrastructure`, `oci-production`, `oci-migration`, and the stop-only
  `azure-migration-recovery`.
- OCI CLI mapping:
  `OCI_CLI_USER`, `OCI_CLI_TENANCY`, `OCI_CLI_FINGERPRINT`,
  `OCI_CLI_KEY_CONTENT`, and `OCI_CLI_REGION`.
- GHCR publication uses only the repository-scoped `GITHUB_TOKEN` with
  `packages: write`, authenticated as the workflow actor. Package metadata
  and retention REST calls use that token by default; if GitHub has not
  granted this repository package-admin access, the optional protected
  `GHCR_PACKAGE_ADMIN_TOKEN` secret may contain a classic PAT scoped only to
  `read:packages` and `delete:packages`. That fallback is never used to push
  images or by the runtime. No OCI registry credential or runtime registry
  credential is accepted. The build workflow never receives an OCI API
  signing key.
- Direct k3s uses one unencrypted ED25519 host key pair. Store only
  `OCI_K3S_SSH_PUBLIC_KEY` in `oci-capacity-acquire`; store
  `OCI_K3S_SSH_PRIVATE_KEY` as a protected secret in `oci-infrastructure`,
  `oci-production`, and `oci-migration`. The private key is exposed only to
  each workflow's k3s access-opening step, is checked against acquisition
  provenance, and is deleted after the API tunnel is established unless
  infrastructure finalization still requires target SSH.

Additional account-derived variables are intentionally required:

- `OCI_RUNTIME_MODE`
- `OCI_K3S_IMAGE_OCID`, `OCI_K3S_VERSION`, and
  `OCI_K3S_BINARY_SHA256` for direct k3s
- `OCI_AVAILABILITY_DOMAIN`
- `OCI_KUBERNETES_VERSION`
- `OCI_NODE_IMAGE_OCID`
- `OCI_CERT_EMAIL`
- `OCI_CANONICAL_HOST=betstan.xyz`
- `OCI_REDIRECT_HOST=www.betstan.xyz`
- `AZURE_EXPECTED_CLUSTER_RESOURCE_ID_SHA256`,
  `AZURE_EXPECTED_CLUSTER_SERVER_SHA256` for migration only
- `AZURE_MIGRATION_RECOVERY_RESOURCE_GROUP`,
  `AZURE_MIGRATION_RECOVERY_CLUSTER_NAME`,
  `AZURE_MIGRATION_RECOVERY_CLUSTER_RESOURCE_ID_SHA256`, and
  `AZURE_MIGRATION_RECOVERY_CLUSTER_SERVER_SHA256` for stop-only recovery
- `OCI_MIGRATION_RECOVERY_SOURCE_SHA`, `OCI_MIGRATION_RECOVERY_RUN_ID`,
  `OCI_MIGRATION_RECOVERY_RUN_ATTEMPT`,
  `OCI_MIGRATION_RECOVERY_MIGRATION_ID`, and
  `OCI_MIGRATION_RECOVERY_FENCING_GENERATION` for the exact interrupted
  migration journal

`azure-migration-recovery` uses only
`AZURE_MIGRATION_RECOVERY_CREDENTIALS`. That identity may read the exact
cluster and migration ConfigMaps, scale the known Azure ingress/application
deployments to zero, stop `betstan-aks`, and cancel only a conclusively stale
exact migration run. It cannot start, create, resize, delete, or access OCI.
The schedule remains inert unless
`OCI_MIGRATION_RECOVERY_ENABLED=true`; manual dispatch remains reviewer-gated.
An armed schedule also requires
`OCI_MIGRATION_RECOVERY_ARM_UNTIL_EPOCH` to be in the future and no more than
24 hours away.
`OCI_MIGRATION_STALE_HEARTBEAT_SECONDS` defaults to the bounded 3600-second
window so protected and public validation are not mistaken for a hung run.
The expected SHA, run, attempt, migration ID, and fencing generation must be
set immediately after dispatch and before approving `oci-migration`; recovery
checks those values against both the workflow run and Azure journal. Set and
clear these variables in the `azure-migration-recovery` environment; an
environment value overrides a repository value with the same name.

The capacity-acquirer identity needs only `VOLUME_INSPECT`, `VOLUME_UPDATE`,
and `VOLUME_DELETE` in the deployment compartment for boot-volume
reconciliation. OCI authorizes boot-volume operations with `VOLUME_*`
permissions; `boot-volumes` is not an individual IAM resource type.

## Offline validation

```bash
./infra/oci/tests/run-contracts.sh
```

The tests parse every OCI YAML file, check every shell script with `bash -n`,
render the explicit overlay with sanitized fixture provenance, verify the exact
`Bound` `gaming-auth-mongo-data` shared claim with no additional Mongo PVC,
verify the single Mongo/load balancer and canonical/redirect/diagnostic ingress
and certificate contracts, verify the k3s local-PV and Bastion cleanup
contracts, reject mixed OKE/k3s inventory, mutable application images, and
legacy Mongo, check credential separation, and exercise health failure
fixtures. The entrypoint also validates shared migration-success provenance,
temporary Azure identity retirement, the read-only terminal audit, and
concurrent retirement fixture isolation without masking failed suites.

## Operator sequence

1. Set `OCI_RUNTIME_MODE=k3s`. `scripts/preflight.sh` validates constants,
   identity, home region, pinned image, and existing inventory.
2. After the migration commit reaches `master`, run the protected
   `ghcr-package-management` bootstrap once, then change the package
   visibility to **Public** in GitHub Package settings. Do not dispatch its
   validate phase yet: validation requires both a complete candidate
   generation and a recovered or deployed generation. The first automatic
   `oci-production-build` may have failed before the package existed; in that
   case dispatch the bounded `repair-build` phase against that exact failed
   first attempt and its successful `production-build` upstream.
   `scripts/build-images.sh` then builds ARM64 images into public GHCR; the
   production workflow records immutable
   provider/host/repository/tag/manifest/platform/build lineage and proves
   every digest can be pulled anonymously after logout. The workflow cannot
   reuse OCIR provenance; reuse is limited to a trusted first-attempt GHCR
   generation with unchanged image inputs. Publication stages each image by
   digest before assigning its exact tag. If a first-attempt build terminates
   after publishing only part of a generation, do not rerun it: dispatch the
   human-gated `repair-build` package phase with that failed run and its exact
   successful `production-build` upstream. The resulting new first-attempt
   build rebuilds every existing tag, adopts it only when the rebuilt ARM64
   platform digest is identical, preserves the verified existing manifest
   identity, and publishes the missing tags. Full and repair builds derive
   `SOURCE_DATE_EPOCH` from the source commit and pin BuildKit timestamp,
   compatibility, media-type, and compression behavior so this equality test
   is a reproducible-build check rather than an assumption.

   Before any restart or deployment after OCIR deletion, prioritize the
   reviewer-gated
   `oci-ghcr-cache-recovery` workflow if the live k3s baseline is still OCIR.
   Select the successful infrastructure **finalize** run for the same
   historical baseline SHA; recovery binds its runtime fingerprint and public
   endpoints to the historical deployment while executing the current master
   safety code, so no new infrastructure finalization is required first. It
   compares an independently captured nine-service live deployment/image-ID
   inventory to historical trusted provenance, exports those exact containerd
   cache images to unique temporary node files, validates each tar remotely,
   streams it over the protected Bastion tunnel, and requires matching bounded
   remote/local size and SHA-256 before deleting the node copy. It uploads the
   exact ARM64 manifest/config/layer blobs from each validated OCI archive
   without a Docker load/repack cycle. It pushes only from the runner, never
   sends a GHCR token to the node, and never silently rebuilds a historical
   baseline. GHCR upload sessions must remain on its exact registry/repository
   and use a UUID-bound singular `upload` or plural `uploads` path. Target SSH
   uses the retained dedicated known-hosts file and the exact instance OCID as
   `HostKeyAlias`. Only after anonymous
   remote verification of all nine recovered GHCR digests does it capture and
   upload a hash-bound transition plan plus the original RabbitMQ queue
   baseline. That upload completes before the first Deployment mutation. The
   workflow then rebinds the nine application Deployments sequentially and
   verifies each rollout's serving ARM64 platform digest; Mongo and RabbitMQ
   are not changed.
   Rollback-readiness and public Playwright checks then run while `ocir-pull`
   remains intact. Only after both pass does the final job remove the
   service-account reference and secret and delete the exact empty
   `${OCI_IMAGE_PREFIX}_images` repository. Its final artifact records
   historical build lineage separately from recovery/transition lineage and
   a hash-bound transition plan. An interrupted run is safely redispatched by
   explicitly selecting its failed or cancelled first-attempt run ID. The new
   run validates that run and its source/image/infrastructure hashes,
   downloads the immutable plan artifact, preserves the original transition
   plan and RabbitMQ baseline byte-for-byte, and changes only the plan carrier
   lineage before upload. Existing exact tags are adopted only after their
   ARM64 digest matches the trusted cached platform, already rebound
   Deployments are reverified, and credentials remain intact while any OCIR
   Deployment is pending. A
   cache/provenance mismatch, non-empty repository at retirement, or
   unrecognized mixed runtime/credential state remains a `NO_GO`.

   Once candidate publication and baseline recovery are both complete,
   dispatch `ghcr-package-management` phase `validate`. Bind the candidate to
   its build artifact, a normally deployed generation to both build and
   deployment artifacts, and a recovered generation to its terminal recovery
   artifact. Every explicitly obsolete generation is also bound to its exact
   successful build artifact during validation. The immutable validation
   artifact records normalized package/tag state, the derived
   generation-to-version map, and a deletion plan; its summary hash-binds all
   three files before apply or archival.
   Reused images may place tags from several source SHAs on one GHCR version;
   any version referenced by a protected generation is retained rather than
   deleting all aliases. A prune retry accepts only the planned version IDs
   already missing, deletes the remaining IDs, then re-reads GHCR and proves
   the terminal state equals the validated state minus the plan. Then run
   current-master infrastructure finalization with that
   package-validation evidence. A later data baseline may use the recovery
   only by passing its exact successful first-attempt recovery run ID;
   ordinary releases use `0`.

   The legacy `validate-registry` and `prune-registry` OCIR controls are no
   longer dispatchable and their job is hard-disabled. Historical code remains
   temporarily for audit continuity only. Forward package validation and
   retention use `ghcr-package-management`; recovery deletes only the exact
   empty legacy OCIR repository after public validation. This implements
   [issue #284](https://github.com/vasilyevstan/betstan/issues/284) without
   preserving a second application-image control plane.
3. Dispatch `oci-infrastructure` with phase `prepare`.
   `scripts/provision.sh cloud` creates/reconciles only the VCN, Internet
   Gateway, public/restricted subnets, NSGs, and OCI Bastion.
4. Set the repository-scoped variable `OCI_CAPACITY_CATCHER_ENABLED=true`
   only after the quota, IAM, network, registry, and zero-cost gates pass.
   The `oci-capacity-acquire` workflow checks every Frankfurt AD every five
   minutes, makes at most one real launch attempt per run, and permanently
   stops launching after one valid managed VM exists.
   Keep the variable `false` for an isolated manual attempt; a manual dispatch
   requires the exact current master SHA and does not enable scheduled runs.
5. Dispatch `oci-infrastructure` with phase `finalize` after acquisition.
   `scripts/configure-k3s-access.sh` opens one ephemeral Bastion
   port-forwarding session to target SSH, then tunnels the k3s API through
   the target loopback interface. This avoids both Managed SSH, which OCI
   Bastion does not support for Ubuntu on Ampere A1, and the OCI Ubuntu host
   firewall that rejects direct non-SSH input. Because session `ACTIVE` can
   precede endpoint readiness, the operator retries only the tunnel against
   that same session with bounded backoff and exact PID cleanup.
   `scripts/finalize-k3s.sh` then mounts the Mongo volume, installs
   ingress-nginx and cert-manager, and reconciles the fixed 10/10 Mbps OCI
   load balancer.
6. Before a schema-dependent application deploy, dispatch
   `oci-live-data-rollout` against the same exact current master SHA,
   first-attempt OCI build, and finalized infrastructure run. Run the
   reviewer-gated phases in order: `dry-run`, `apply-backfills`, then
   `apply-slip-index`, passing each successful run ID to the next phase.
   The workflow runs only compiled CLIs from the approved immutable image
   digests. Before acquiring the shared Mongo operation lock, it captures and
   validates a rollback baseline whose nine live references and provenance
   are the same immutable public GHCR generation. An OCIR or mixed live
   generation requires the exact successful cache-recovery authority and
   cannot be labeled as a normal GHCR baseline. It then binds that baseline by
   digest, holds the lock, and uploads sanitized hash-bound evidence. Mutating
   phases first install the ingress write fence and scale the event,
   gamemaster, moderation, resulting, bet, and slip writers to zero, preventing
   legacy documents from racing the backfill or index. The backfill-only phase
   restores the captured replica counts before it completes.
   The final phase reapplies all six idempotent backfills under that fence,
   creates or verifies the exact Slip index, and deliberately hands the
   quiesced runtime plus active database lock to deployment. Public writes and
   the six writer services remain unavailable between that successful phase
   and deployment; dispatch the bound deployment immediately.
   `oci-production-deploy` rejects the release unless the final evidence proves
   all six backfills complete, the exact Slip draft index ready, the baseline
   digest unchanged, the expected database lock active, and all legacy writers
   still quiesced. It starts the new exact-digest services under the write
   fence, keeps the transferred lock through protected validation, then
   releases the lock and fence in order. Any incomplete apply or validation
   after a successfully validated handoff scales the writers back to zero,
   restores the fence, and retains or reacquires the same lock for a bounded
   retry with the same data run. A request that never validates that exact
   handoff must not enter maintenance, acquire the database lock, or alter
   writer replicas.
7. `scripts/deploy.sh` creates secrets without logging values, renders exact
   image digests, and deploys Mongo, RabbitMQ, backends, client, and ingress
   sequentially.
8. `agents/deploy-validation-loop-stan.sh` must pass canonical apex, permanent
   `www` redirect, diagnostic TLS, API, browser, cluster, zero-cost, validated
   shared-Mongo marker/lock, and exact `Bound` shared-PVC checks before the
   deployment is healthy.
9. Dispatch `oci-migrate` only with the exact current master SHA, successful
   first-attempt build/infrastructure/deploy run IDs,
   `replace_oci_data=true`, and the destructive confirmation. The workflow
   synchronously starts only the existing `betstan-aks`, freezes Azure
   ingress/applications while preserving all eight Mongo StatefulSets, and
   mirrors a monotonic heartbeat/fencing journal to Azure and OCI.
   `scripts/migrate-from-azure.sh` keeps all eight compressed, age-encrypted
   transfer archives only on ephemeral runner storage, validates them in an
   isolated disposable Mongo, then drops and exactly replaces the eight
   allowlisted OCI databases. It verifies canonical data and metadata
   signatures, starts only auth while ingress, RabbitMQ, and every other
   application remain stopped so its required index initialization can finish,
   then immediately locks Mongo and recertifies exact parity under that lock.
   It recreates the 17-queue RabbitMQ topology, starts passive consumers first
   and the autonomous gamemaster last, then requires the exact empty topology
   to converge within 45 seconds. It fences messaging before gamemaster's first
   60-second polling tick by removing the exact 17 application exchange
   bindings in one bounded in-pod batch while retaining queues, consumers, and
   writable declaration permissions. An ACL write denial is not used because
   it closes application channels and destabilizes consumers. Application
   readiness alone does not certify asynchronous broker registration.
   Finalization rechecks parity under all fences, records `cutover-committed`,
   quiesces the autonomous gamemaster, unlocks Mongo, restores the exact
   bindings by restarting passive consumers before gamemaster, and only then
   enables external writes.
   A pre-destructive failure restores OCI workload baselines. Any later
   pre-commit failure keeps OCI closed and marks `recovery-required`; a later
   full retry clears partial application databases and starts again from
   frozen Azure. A descendant deployment-only hotfix may reuse the exact
   image-equivalent deployed ancestor provenance only for that closed retry;
   the journal must independently prove the old owner is inactive, Azure is
   frozen, and OCI ingress, applications, and RabbitMQ remain at zero. A
   post-commit interruption is retried only forward through
   idempotent write unlock and completion; retry from Azure is permanently
   forbidden because OCI may already have accepted writes. No path reopens
   Azure writers, retains a data artifact, or rolls back to the previous OCI
   data.
9. Delete the exact Bastion session, restore the non-routable client CIDR,
   stop both exact tunnel PIDs, and remove ephemeral keys. Cleanup failure is
   a deployment failure.

The protected `oci-build` environment can define `OCI_REUSE_SOURCE_SHA` and
`OCI_REUSE_BUILD_RUN_ID` for a prior successful first-attempt OCI build.
`oci-production-build` reuses those verified immutable ARM64 digests only when
the prior commit is an ancestor and `.dockerignore`, all nine service trees,
`infra/oci/build`, and `scripts/build-images.sh` are unchanged. Any changed
image input uses the normal build path only after the reuse variables are
cleared and a fresh environment approval is obtained. Reuse creates new
exact-SHA tags without uploading duplicate layers and records both build runs
in provenance. The comparison also fingerprints the exact `lib.sh` functions
called by `build-images.sh`; unrelated infrastructure helpers do not force a
rebuild, while any transitive image-recipe change fails closed.
The privileged QEMU helper used by normal builds and cache recovery is pinned
by image digest as well as the setup action SHA; a mutable `binfmt` tag is not
release authority.

For OKE fallback, set `OCI_RUNTIME_MODE=oke`; the existing Basic-cluster,
runner-NSG, and managed-node-pool flow remains available.

## Recovery and retirement

Read `LESSONS_LEARNED.md` before operating. A waiting environment approval is
not a hang. Recovery uses the journal SHA and fencing generation, not a newer
default branch. Provider deletion is asynchronous, and successful CLI output
does not prove terminal state.

Azure is started only as a frozen data source for the protected migration.
After exact data parity and repeated OCI canonical health pass, the separately
approved Azure-retirement operation removes AKS and all associated billable
resources. Repository and GitHub configuration remain the only future Azure
recreation source.

Run `infra/azure/agents/retire-production-stan.sh plan` only with the exact
successful migration run, attempt, ID, SHA, diagnostic URL, cluster-resource
fingerprint, and a private absolute state directory. Review its 28-resource
inventory digest, then pass that digest and exact confirmation to `execute`.
The operator deletes AKS first, resumes asynchronous deletion by fenced phase,
removes only the two exact resource groups, and verifies subscription-wide
absence twice. It reports resource retirement separately from delayed Cost
Management completion. AKS resource fingerprints and ETags are
case-preserving; do not normalize or wildcard either value.

After resource absence, run the separate
`infra/azure/agents/retire-migration-identities-stan.sh` state machine with the
exact private migration identity metadata, then run
`infra/azure/agents/audit-oci-primary-retirement-stan.sh`. The identity
operator must retain general Azure recreation configuration. The terminal
audit reports resource completion separately from delayed billing ingestion
and never mutates GitHub merely to clear an inert historical run record.
