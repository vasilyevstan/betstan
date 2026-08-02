# BetStan OCI Always Free deployment

This directory is an additive Oracle Cloud Infrastructure path. It does not
replace the Azure deployment, alter canonical DNS, or reuse Azure credentials.
The preferred target is one directly launched `VM.Standard.A1.Flex` VM
(2 OCPUs, 12 GiB) running pinned single-node k3s, one 50 GiB Mongo block
volume, and one 10/10 Mbps flexible load balancer. The existing OKE Basic path
remains an explicit fallback selected with `OCI_RUNTIME_MODE=oke`.

## Safety contract

- Run only in the dedicated compartment identified by
  `OCI_COMPARTMENT_OCID`; resources are never discovered by name alone.
- Runtime selection is explicit. Scripts never fall from k3s to OKE or from
  OKE to k3s.
- The tenancy home region, pinned runtime image, pinned Kubernetes
  distribution, and migration watchdog image are required inputs. Scripts
  stop rather than guessing region-specific or potentially billable values.
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
  through short-lived OCI Bastion sessions. Mongo and RabbitMQ remain
  `ClusterIP`.
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
  `oci-infrastructure`, `oci-production`, `oci-migration`.
- OCI CLI mapping:
  `OCI_CLI_USER`, `OCI_CLI_TENANCY`, `OCI_CLI_FINGERPRINT`,
  `OCI_CLI_KEY_CONTENT`, and `OCI_CLI_REGION`.
- Registry authentication is direct `docker login` with
  `OCI_REGISTRY_USERNAME` and `OCI_REGISTRY_AUTH_TOKEN`. The build workflow
  never receives an OCI API signing key.

Additional account-derived variables are intentionally required:

- `OCI_RUNTIME_MODE`
- `OCI_K3S_IMAGE_OCID`, `OCI_K3S_VERSION`, and
  `OCI_K3S_BINARY_SHA256` for direct k3s
- `OCI_AVAILABILITY_DOMAIN`
- `OCI_KUBERNETES_VERSION`
- `OCI_NODE_IMAGE_OCID`
- `OCI_CERT_EMAIL`
- `AZURE_EXPECTED_CLUSTER_RESOURCE_ID_SHA256`,
  `AZURE_EXPECTED_CLUSTER_SERVER_SHA256`, and
  `AZURE_WATCHDOG_KUBECTL_IMAGE` for migration only

## Offline validation

```bash
./infra/oci/tests/test-contract.sh
./infra/oci/agents/test-health-contract-stan.sh
```

The tests parse every OCI YAML file, check every shell script with `bash -n`,
render the explicit overlay with sanitized fixture provenance, verify one
Mongo/PVC/load balancer, verify the k3s local-PV and Bastion cleanup
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
5. Dispatch `oci-infrastructure` with phase `finalize` after acquisition.
   `scripts/configure-k3s-access.sh` opens ephemeral Bastion access and
   `scripts/finalize-k3s.sh` mounts the Mongo volume, installs ingress-nginx
   and cert-manager, and reconciles the fixed 10/10 Mbps OCI load balancer.
6. `scripts/deploy.sh` creates secrets without logging values, renders exact
   image digests, and deploys Mongo, RabbitMQ, backends, client, and ingress
   sequentially.
7. `agents/deploy-validation-loop-stan.sh` must pass before the deployment is
   healthy.
8. `scripts/migrate-from-azure.sh` is the only cross-cloud path. It uses
   isolated kubeconfigs, an Azure expiry watchdog, a bounded write freeze,
   age-encrypted streams, exact database signatures, and unconditional Azure
   replica restoration.
9. Delete the exact Bastion sessions, restore the non-routable client CIDR,
   stop the exact tunnel PID, and remove ephemeral keys. Cleanup failure is a
   deployment failure.

For OKE fallback, set `OCI_RUNTIME_MODE=oke`; the existing Basic-cluster,
runner-NSG, and managed-node-pool flow remains available.

## Account-specific blockers

Oracle must physically accept an A1 launch in Frankfurt before k3s
finalization can run. Until then there is no OCI public application IP. The
scripts fail with a named missing variable or provider invariant instead of
fabricating capacity or a public endpoint.
