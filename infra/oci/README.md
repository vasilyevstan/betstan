# BetStan OCI Always Free deployment

This directory is an additive Oracle Cloud Infrastructure path. It does not
replace the Azure deployment, alter canonical DNS, or reuse Azure credentials.
The target is one OKE Basic cluster with one `VM.Standard.A1.Flex` worker
(2 OCPUs, 12 GiB), one 50 GiB Mongo block volume, and one 10/10 Mbps flexible
load balancer.

## Safety contract

- Run only in the dedicated compartment identified by
  `OCI_COMPARTMENT_OCID`; resources are never discovered by name alone.
- The tenancy home region, availability domain, Kubernetes version, OKE node
  image OCID, and migration watchdog image are required inputs. Scripts stop
  rather than guessing region-specific or potentially billable values.
- `OCI_A1_OCPUS=2`, `OCI_A1_MEMORY_GB=12`,
  `OCI_MONGO_VOLUME_GB=50`, `OCI_LB_MIN_MBPS=10`,
  `OCI_LB_MAX_MBPS=10`, and `OCI_EXPECTED_MONTHLY_COST=0` are immutable
  Free Tier gates.
- OCIR repository layer storage must remain at or below
  `OCI_REGISTRY_MAX_BYTES=500000000`.
- Frankfurt OCIR does not currently support repository-level immutability.
  The repositories are precreated privately, and the CI user has only
  `REPOSITORY_INSPECT`, `REPOSITORY_READ`, and `REPOSITORY_UPDATE` in the
  dedicated compartment, with no repository create/delete/manage permission.
  The build fails unless every exact-SHA tag is proven absent before its
  single first-attempt push.
- OCI CLI execution is fail-closed on the reviewed `3.90.0` client version.
- There is no paid shape, enhanced-cluster, NAT gateway, extra node, extra
  Mongo, or alternate load-balancer fallback.
- Only the ingress controller is public. Mongo and RabbitMQ remain
  `ClusterIP`; the Kubernetes API temporarily admits one validated runner
  IPv4 `/32`.
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

- Environments: `oci-build`, `oci-infrastructure`, `oci-production`,
  `oci-migration`.
- OCI CLI mapping:
  `OCI_CLI_USER`, `OCI_CLI_TENANCY`, `OCI_CLI_FINGERPRINT`,
  `OCI_CLI_KEY_CONTENT`, and `OCI_CLI_REGION`.
- Registry authentication is direct `docker login` with
  `OCI_REGISTRY_USERNAME` and `OCI_REGISTRY_AUTH_TOKEN`. The build workflow
  never receives an OCI API signing key.

Additional account-derived variables are intentionally required:

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
Mongo/PVC/load balancer, reject mutable application images and legacy Mongo,
check credential separation, and exercise health failure fixtures.

## Operator sequence

1. `scripts/preflight.sh` validates constants, identity, home region, service
   limits, and existing inventory.
2. `scripts/build-images.sh` builds ARM64 OCI-only images; the production
   workflow records and verifies immutable digests with
   `scripts/verify-images.sh`.
3. `scripts/provision.sh cloud` creates/reconciles the VCN, public subnets,
   restrictive NSGs, Basic cluster, one A1 node pool, and one 50 GiB block
   volume. It writes exact private provenance and a sanitized inventory.
4. Temporarily authorize the runner with
   `scripts/authorize-github-runner.sh`, configure kubectl from the exact
   cluster OCID, then run `scripts/provision.sh addons` to install pinned
   ingress-nginx and cert-manager charts.
5. `scripts/deploy.sh` creates secrets without logging values, renders exact
   image digests, and deploys Mongo, RabbitMQ, backends, client, and ingress
   sequentially.
6. `agents/deploy-validation-loop-stan.sh` must pass before the deployment is
   healthy.
7. `scripts/migrate-from-azure.sh` is the only cross-cloud path. It uses
   isolated kubeconfigs, an Azure expiry watchdog, a bounded write freeze,
   age-encrypted streams, exact database signatures, and unconditional Azure
   replica restoration.
8. Revoke the exact runner rule with
   `scripts/revoke-github-runner.sh`. Cleanup failure is a deployment failure.

## Account-specific blockers

Offline implementation cannot supply or validate tenancy OCIDs, current A1
capacity, the home-region OKE image OCID, availability domain, GitHub
environment configuration, OCI IAM policy, OCIR repositories, or the live
load-balancer/PVC identifiers. The scripts fail with a named missing variable
or failed provider invariant instead of fabricating these values.
