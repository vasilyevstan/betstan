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
- OCIR repository layer storage must remain at or below
  `OCI_REGISTRY_MAX_BYTES=500000000`.
- Frankfurt OCIR does not currently support repository-level immutability.
  One private `${OCI_IMAGE_PREFIX}_images` repository is precreated so the
  eight backend images share their identical Node layers instead of charging
  the Free Tier allowance for those layers eight times. Service-specific,
  exact-SHA tags remain independently digest-pinned. The CI policy grants
  `manage repos` only in the dedicated compartment and only when
  `target.repo.name=/betstan_*/`; it does not cover other repositories or
  root-compartment repository creation. The protected build has no deletion
  path and fails unless every exact-SHA tag is proven absent before its single
  first-attempt push.
- OCI CLI execution is fail-closed on the reviewed `3.90.0` client version.
- There is no paid shape, enhanced-cluster, NAT gateway, extra node, extra
  Mongo, or alternate load-balancer fallback.
- Only the OCI load balancer exposes ports 80/443. In k3s mode, ingress-nginx
  uses fixed NodePorts 30080/30443 and the Kubernetes API is reachable only
  through a short-lived OCI Bastion SSH session and a target-loopback tunnel.
  Mongo and RabbitMQ remain `ClusterIP`.
- The apex and `www` A records must equal exact load-balancer provenance and
  must not have a conflicting AAAA record. Canonical and diagnostic
  certificates must be trusted and Ready before migration or deployment is
  healthy.
- The Kustomize overlay explicitly lists nine application manifests,
  RabbitMQ, and `auth-mongo-depl.yaml`. It never traverses
  `infra/k8s/legacy-mongo`.
- Application images use immutable OCIR digests. The upstream Node, nginx,
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
- Registry authentication is direct `docker login` with
  `OCI_REGISTRY_USERNAME` and `OCI_REGISTRY_AUTH_TOKEN`. The build workflow
  never receives an OCI API signing key.
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
./infra/oci/tests/test-contract.sh
./infra/oci/agents/test-health-contract-stan.sh
```

The tests parse every OCI YAML file, check every shell script with `bash -n`,
render the explicit overlay with sanitized fixture provenance, verify one
Mongo/PVC/load balancer, canonical/redirect/diagnostic ingress and certificate
contracts, verify the k3s local-PV and Bastion cleanup
contracts, reject mixed OKE/k3s inventory, mutable application images, and
legacy Mongo, check credential separation, and exercise health failure
fixtures.

## Operator sequence

1. Set `OCI_RUNTIME_MODE=k3s`. `scripts/preflight.sh` validates constants,
   identity, home region, pinned image, and existing inventory.
2. `scripts/build-images.sh` builds ARM64 OCI-only images; the production
   workflow records and verifies immutable digests with
   `scripts/verify-images.sh`.
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
6. `scripts/deploy.sh` creates secrets without logging values, renders exact
   image digests, and deploys Mongo, RabbitMQ, backends, client, and ingress
   sequentially.
7. `agents/deploy-validation-loop-stan.sh` must pass canonical apex, permanent
   `www` redirect, diagnostic TLS, API, browser, cluster, and zero-cost checks
   before the deployment is healthy.
8. Dispatch `oci-migrate` only with the exact current master SHA, successful
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
   bindings while retaining queues, consumers, and writable declaration
   permissions. An ACL write denial is not used because it closes application
   channels and destabilizes consumers. Application readiness alone does not
   certify asynchronous broker registration. Finalization rechecks parity
   under all fences, records `cutover-committed`, quiesces the autonomous
   gamemaster, unlocks Mongo, restores the exact bindings by restarting passive
   consumers before gamemaster, and only then enables external writes.
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
Management completion.
