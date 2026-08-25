#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

OCI_K8S_NAMESPACE="${OCI_K8S_NAMESPACE:-betstan-oci}"

oci_require_command kubectl
oci_require_command jq
[[ "$OCI_K8S_NAMESPACE" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]] ||
  oci_die "OCI_K8S_NAMESPACE is invalid"

legacy_secret="$(
  kubectl get secret ocir-pull -n "$OCI_K8S_NAMESPACE" \
    --ignore-not-found -o name
)" || oci_die "could not determine whether the legacy OCIR pull secret exists"
[[ -z "$legacy_secret" ]] ||
  oci_die "legacy OCIR application pull secret exists; public GHCR workloads must not use it"

service_account_json="$(
  kubectl get serviceaccount default -n "$OCI_K8S_NAMESPACE" -o json
)" || oci_die "could not inspect the default service account image pull credentials"
jq -e '(.imagePullSecrets // []) | length == 0' \
  <<<"$service_account_json" >/dev/null ||
  oci_die "public GHCR workloads must not require an application imagePullSecret"
