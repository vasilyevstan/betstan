#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OCI_DIR="$ROOT_DIR/infra/oci"
# shellcheck source=../scripts/lib.sh
source "$OCI_DIR/scripts/lib.sh"

NAMESPACE="${OCI_K8S_NAMESPACE:-betstan-oci}"
INFRA_PROVENANCE_FILE="${INFRA_PROVENANCE_FILE:-}"
SINCE="${SINCE:-30m}"
oci_require_vars INFRA_PROVENANCE_FILE
[[ -f "$INFRA_PROVENANCE_FILE" ]] || oci_die "infrastructure provenance file is missing"
unset runtime_mode cluster_ocid cluster_fingerprint
unset instance_ocid instance_fingerprint namespace
# shellcheck disable=SC1090
source "$INFRA_PROVENANCE_FILE"
[[ "$namespace" == "$NAMESPACE" ]] || oci_die "diagnostic namespace differs from provenance"
kubeconfig_json="$(kubectl config view --raw --minify -o json)"
if [[ "$runtime_mode" == "oke" ]]; then
  [[ "$(oci_fingerprint "$cluster_ocid")" == "$cluster_fingerprint" ]] ||
    oci_die "diagnostic cluster fingerprint mismatch"
  jq -e --arg cluster "$cluster_ocid" \
    '[.users[].user.exec.args[]? | select(. == $cluster)] | length == 1' \
    <<<"$kubeconfig_json" >/dev/null ||
    oci_die "diagnostics refuse the current OKE context"
else
  [[ "$runtime_mode" == "k3s" ]] || oci_die "diagnostic runtime is invalid"
  [[ "$(oci_fingerprint "$instance_ocid")" == "$instance_fingerprint" ]] ||
    oci_die "diagnostic instance fingerprint mismatch"
  jq -e '
    (.clusters[0].cluster.server // "") |
    test("^https://127\\.0\\.0\\.1:[0-9]+$")
  ' <<<"$kubeconfig_json" >/dev/null ||
    oci_die "diagnostics refuse a non-Bastion k3s context"
fi

pods_json="$(kubectl get pods -n "$NAMESPACE" -o json)"

{
  echo "=== workload readiness ==="
  kubectl get deployments,statefulsets -n "$NAMESPACE" -o json |
    jq -r '.items[] | [
      .kind, .metadata.name, (.spec.replicas // 0),
      (.status.availableReplicas // .status.readyReplicas // 0)
    ] | @tsv'

  echo "=== per-container status ==="
  printf '%s\n' \
    $'pod\tcontainer\tphase\tready\trestarts\tcurrent_state\tcurrent_reason\tcurrent_exit_code\tcurrent_started_at\tcurrent_finished_at\tlast_state\tlast_reason\tlast_exit_code\tlast_started_at\tlast_finished_at'
  jq -r '
    def state_fields:
      if .running then
        ["running", "", "", (.running.startedAt // ""), ""]
      elif .waiting then
        ["waiting", (.waiting.reason // ""), "", "", ""]
      elif .terminated then
        [
          "terminated",
          (.terminated.reason // ""),
          ((.terminated.exitCode // "") | tostring),
          (.terminated.startedAt // ""),
          (.terminated.finishedAt // "")
        ]
      else
        ["none", "", "", "", ""]
      end;
    .items[] as $pod |
    $pod.status.containerStatuses[]? as $container |
    ($container.state | state_fields) as $current |
    ($container.lastState | state_fields) as $last |
    [
      $pod.metadata.name,
      $container.name,
      $pod.status.phase,
      ($container.ready // false),
      ($container.restartCount // 0)
    ] + $current + $last | @tsv
  ' <<<"$pods_json"

  echo "=== service endpoint readiness ==="
  kubectl get endpointslices.discovery.k8s.io -n "$NAMESPACE" -o json |
    jq -r '.items[] | [
      .metadata.labels["kubernetes.io/service-name"],
      ([.endpoints[]? | select(
        (.addresses | length) > 0 and .conditions.ready != false
      )] | length)
    ] | @tsv'

  echo "=== warning events ==="
  kubectl get events -n "$NAMESPACE" --field-selector type=Warning \
    --sort-by=.lastTimestamp -o json |
    jq -r '.items[-50:][]? | [.reason, .regarding.kind, .regarding.name, .message] | @tsv'

  echo "=== redacted recent error logs ==="
  while IFS= read -r pod; do
    [[ -n "$pod" ]] || continue
    errors="$(
      kubectl logs -n "$NAMESPACE" "$pod" --all-containers --since="$SINCE" \
        --tail=200 2>/dev/null |
        grep -Ei 'error|exception|failed|panic|fatal|oom' |
        tail -n 40 || true
    )"
    if [[ -n "$errors" ]]; then
      printf '%s\n' "pod=$pod"
      printf '%s\n' "$errors" |
        sed -E 's/(error|exception|failed|panic|fatal|oom).*/\1 [REDACTED_DETAIL]/Ig'
    fi
  done < <(jq -r '.items[].metadata.name' <<<"$pods_json")

  echo "=== redacted previous-container error logs ==="
  while IFS=$'\t' read -r pod container restart_count; do
    [[ "$restart_count" =~ ^[0-9]+$ ]] && ((restart_count > 0)) || continue
    printf 'previous\t%s\t%s\t%s\n' \
      "$pod" "$container" "$restart_count"
    if previous_logs="$(
      kubectl logs -n "$NAMESPACE" "$pod" -c "$container" --previous \
        --tail=200 --timestamps=true 2>/dev/null
    )"; then
      errors="$(
        printf '%s\n' "$previous_logs" |
          grep -Ei 'error|exception|failed|panic|fatal|oom' |
          tail -n 40 || true
      )"
      if [[ -n "$errors" ]]; then
        printf '%s\n' "$errors" |
          sed -E 's/(error|exception|failed|panic|fatal|oom).*/\1 [REDACTED_DETAIL]/Ig'
      else
        echo "previous_logs=no_matching_error_lines"
      fi
    else
      echo "previous_logs=unavailable"
    fi
  done < <(
    jq -r '
      .items[] as $pod |
      $pod.status.containerStatuses[]? |
      [$pod.metadata.name, .name, (.restartCount // 0)] | @tsv
    ' <<<"$pods_json"
  )
} | oci_redact
