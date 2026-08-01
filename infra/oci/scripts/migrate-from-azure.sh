#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

SOURCE_SHA="${SOURCE_SHA:-${1:-}}"
AZURE_KUBECONFIG="${AZURE_KUBECONFIG:-}"
OCI_KUBECONFIG="${OCI_KUBECONFIG:-}"
OCI_RABBITMQ_BASELINE_FILE="${OCI_RABBITMQ_BASELINE_FILE:-}"
AZURE_NAMESPACE="${AZURE_NAMESPACE:-default}"
OCI_K8S_NAMESPACE="${OCI_K8S_NAMESPACE:-betstan-oci}"
WORK_DIR="${WORK_DIR:-$OCI_ROOT_DIR/artifacts/oci-migration/work}"
JOURNAL_FILE="${JOURNAL_FILE:-$OCI_ROOT_DIR/artifacts/oci-migration/journal.tsv}"
WATCHDOG_MINUTES="${WATCHDOG_MINUTES:-20}"
QUEUE_DRAIN_ATTEMPTS="${QUEUE_DRAIN_ATTEMPTS:-30}"
QUEUE_DRAIN_SLEEP_SECONDS="${QUEUE_DRAIN_SLEEP_SECONDS:-10}"
MIGRATION_ID="${MIGRATION_ID:-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}}"

[[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] || oci_die "SOURCE_SHA must be a full lowercase commit SHA"
[[ -f "$AZURE_KUBECONFIG" && -f "$OCI_KUBECONFIG" ]] ||
  oci_die "isolated Azure and OCI kubeconfig files are required"
[[ -f "$OCI_RABBITMQ_BASELINE_FILE" ]] ||
  oci_die "verified OCI RabbitMQ baseline file is required"
[[ "$AZURE_KUBECONFIG" != "$OCI_KUBECONFIG" ]] ||
  oci_die "Azure and OCI kubeconfigs must not be merged"
oci_is_positive_int "$WATCHDOG_MINUTES" || oci_die "WATCHDOG_MINUTES must be positive"
(( WATCHDOG_MINUTES <= 30 )) || oci_die "Azure watchdog deadline may not exceed 30 minutes"
oci_is_positive_int "$QUEUE_DRAIN_ATTEMPTS" || oci_die "QUEUE_DRAIN_ATTEMPTS must be positive"
oci_is_positive_int "$QUEUE_DRAIN_SLEEP_SECONDS" || oci_die "QUEUE_DRAIN_SLEEP_SECONDS must be positive"
oci_require_command kubectl
oci_require_command jq
oci_require_command age
oci_require_cli_version
oci_require_vars \
  OCI_MIGRATION_AGE_RECIPIENT OCI_MIGRATION_AGE_IDENTITY \
  AZURE_EXPECTED_CLUSTER_RESOURCE_ID_SHA256 AZURE_EXPECTED_CLUSTER_SERVER_SHA256 \
  AZURE_ACTUAL_CLUSTER_RESOURCE_ID_SHA256 OCI_EXPECTED_CLUSTER_OCID \
  OCI_EXPECTED_CLUSTER_FINGERPRINT AZURE_WATCHDOG_KUBECTL_IMAGE
[[ "$AZURE_WATCHDOG_KUBECTL_IMAGE" =~ @sha256:[0-9a-f]{64}$ ]] ||
  oci_die "AZURE_WATCHDOG_KUBECTL_IMAGE must be immutable"
[[ "$AZURE_ACTUAL_CLUSTER_RESOURCE_ID_SHA256" == "$AZURE_EXPECTED_CLUSTER_RESOURCE_ID_SHA256" ]] ||
  oci_die "Azure cluster resource ID fingerprint mismatch"
[[ "$(oci_fingerprint "$OCI_EXPECTED_CLUSTER_OCID")" == "$OCI_EXPECTED_CLUSTER_FINGERPRINT" ]] ||
  oci_die "OCI cluster fingerprint mismatch"

azure_kubectl=(kubectl --kubeconfig "$AZURE_KUBECONFIG")
oci_kubectl=(kubectl --kubeconfig "$OCI_KUBECONFIG")
app_services=(auth bet backoffice event gamemaster moderation resulting slip client)
databases=(gaming_auth gaming_bet gaming_backoffice gaming_event gaming_gamemaster gaming_moderation gaming_resulting gaming_slip)
legacy_services=(auth bet backoffice event gamemaster moderation resulting slip)

validate_kubeconfig() {
  local provider="$1"
  local kubeconfig="$2"
  local expected_server_hash="$3"
  local cluster_ocid="${4:-}"
  local config server server_hash
  config="$(kubectl --kubeconfig "$kubeconfig" config view --raw --minify -o json)"
  server="$(jq -r '.clusters[0].cluster.server // empty' <<<"$config")"
  [[ "$server" == https://* ]] || oci_die "$provider kubeconfig has no HTTPS server"
  server_hash="$(oci_fingerprint "$server")"
  if [[ -n "$expected_server_hash" ]]; then
    [[ "$server_hash" == "$expected_server_hash" ]] ||
      oci_die "$provider Kubernetes API server fingerprint mismatch"
  fi
  if [[ -n "$cluster_ocid" ]]; then
    jq -e --arg cluster "$cluster_ocid" '
      [.users[].user.exec.args[]? | select(. == $cluster)] | length == 1
    ' <<<"$config" >/dev/null || oci_die "OCI kubeconfig does not contain the exact cluster OCID"
  fi
}

validate_kubeconfig azure "$AZURE_KUBECONFIG" "$AZURE_EXPECTED_CLUSTER_SERVER_SHA256"
validate_kubeconfig oci "$OCI_KUBECONFIG" "" "$OCI_EXPECTED_CLUSTER_OCID"
"${azure_kubectl[@]}" get namespace "$AZURE_NAMESPACE" >/dev/null
"${oci_kubectl[@]}" get namespace "$OCI_K8S_NAMESPACE" >/dev/null

oci_prepare_private_dir "$WORK_DIR"
oci_prepare_private_dir "$(dirname "$JOURNAL_FILE")"
chmod 700 "$(dirname "$JOURNAL_FILE")"
replicas_file="$WORK_DIR/azure-replicas.tsv"
target_replicas_file="$WORK_DIR/oci-replicas.tsv"
cipher_dir="$WORK_DIR/ciphertext"
signatures_dir="$WORK_DIR/signatures"
mkdir -p "$cipher_dir" "$signatures_dir"
chmod 700 "$cipher_dir" "$signatures_dir"

azure_lock="betstan-oci-migration-lock"
oci_lock="betstan-oci-migration-lock"
watchdog_name="betstan-azure-expiry-watchdog"
source_restored=0
target_restored=0
watchdog_armed=0

if "${azure_kubectl[@]}" get job "$watchdog_name" -n "$AZURE_NAMESPACE" >/dev/null 2>&1 ||
   "${azure_kubectl[@]}" get configmap "$watchdog_name" -n "$AZURE_NAMESPACE" >/dev/null 2>&1 ||
   "${azure_kubectl[@]}" get clusterrole "$watchdog_name" >/dev/null 2>&1; then
  oci_die "stale Azure migration watchdog exists; inspect restoration before cleanup"
fi

record_replicas() {
  local -n command_ref=$1
  local namespace="$2"
  local output="$3"
  : > "$output"
  local service replicas
  for service in "${app_services[@]}"; do
    replicas="$("${command_ref[@]}" get deployment "gaming-${service}-depl" -n "$namespace" \
      -o jsonpath='{.spec.replicas}')"
    [[ "$replicas" =~ ^[0-9]+$ ]] || oci_die "invalid replica count for $service"
    printf '%s\t%s\n' "$service" "$replicas" >> "$output"
  done
}

restore_replicas() {
  local -n command_ref=$1
  local namespace="$2"
  local input="$3"
  local service replicas
  while IFS=$'\t' read -r service replicas; do
    [[ -n "$service" && "$replicas" =~ ^[0-9]+$ ]] || oci_die "invalid recorded replica state"
    "${command_ref[@]}" scale deployment "gaming-${service}-depl" -n "$namespace" \
      --replicas "$replicas" >/dev/null
    if (( replicas > 0 )); then
      "${command_ref[@]}" rollout status deployment/"gaming-${service}-depl" \
        -n "$namespace" --timeout=8m
    fi
  done < "$input"
}

wait_for_no_pods() {
  local -n command_ref=$1
  local namespace="$2"
  local selector="$3"
  local count
  for _ in $(seq 1 60); do
    count="$("${command_ref[@]}" get pods -n "$namespace" -l "$selector" -o json |
      jq '.items | length')"
    [[ "$count" == "0" ]] && return 0
    sleep 5
  done
  return 1
}

delete_watchdog() {
  "${azure_kubectl[@]}" delete job "$watchdog_name" -n "$AZURE_NAMESPACE" --ignore-not-found >/dev/null || true
  "${azure_kubectl[@]}" delete configmap "$watchdog_name" -n "$AZURE_NAMESPACE" --ignore-not-found >/dev/null || true
  "${azure_kubectl[@]}" delete serviceaccount "$watchdog_name" -n "$AZURE_NAMESPACE" --ignore-not-found >/dev/null || true
  "${azure_kubectl[@]}" delete clusterrolebinding "$watchdog_name" --ignore-not-found >/dev/null || true
  "${azure_kubectl[@]}" delete clusterrole "$watchdog_name" --ignore-not-found >/dev/null || true
  watchdog_armed=0
}

release_lock() {
  local -n command_ref=$1
  local namespace="$2"
  local name="$3"
  local lock_json
  lock_json="$("${command_ref[@]}" get configmap "$name" -n "$namespace" -o json 2>/dev/null)" ||
    return 0
  jq -e --arg migration "$MIGRATION_ID" --arg sha "$SOURCE_SHA" '
    .data["migration-id"] == $migration and .data["source-sha"] == $sha
  ' <<<"$lock_json" >/dev/null || return 1
  "${command_ref[@]}" delete configmap "$name" -n "$namespace" >/dev/null
}

restore_azure() {
  local failed=0
  if [[ -f "$replicas_file" && -f "$WORK_DIR/azure-ingress-replicas" ]]; then
    restore_replicas azure_kubectl "$AZURE_NAMESPACE" "$replicas_file" || failed=1
    ingress_replicas="$(cat "$WORK_DIR/azure-ingress-replicas")"
    "${azure_kubectl[@]}" scale deployment ingress-nginx-controller -n ingress-nginx \
      --replicas "$ingress_replicas" >/dev/null || failed=1
    if (( ingress_replicas > 0 )); then
      "${azure_kubectl[@]}" rollout status deployment/ingress-nginx-controller \
        -n ingress-nginx --timeout=8m || failed=1
    fi
    if [[ "$failed" == "0" ]]; then
      source_restored=1
      return 0
    fi
  fi
  return 1
}

restore_oci() {
  local failed=0
  if [[ -f "$target_replicas_file" && -f "$WORK_DIR/oci-ingress-replicas" ]]; then
    restore_replicas oci_kubectl "$OCI_K8S_NAMESPACE" "$target_replicas_file" || failed=1
    oci_ingress_replicas="$(cat "$WORK_DIR/oci-ingress-replicas")"
    "${oci_kubectl[@]}" scale deployment ingress-nginx-controller -n ingress-nginx \
      --replicas "$oci_ingress_replicas" >/dev/null || failed=1
    if (( oci_ingress_replicas > 0 )); then
      "${oci_kubectl[@]}" rollout status deployment/ingress-nginx-controller \
        -n ingress-nginx --timeout=8m || failed=1
    fi
    if [[ "$failed" == "0" ]]; then
      target_restored=1
      return 0
    fi
  fi
  return 1
}

cleanup() {
  local status="$1"
  trap - EXIT INT TERM
  set +e
  if [[ "$source_restored" != "1" ]]; then
    restore_azure
  fi
  if [[ "$target_restored" != "1" && -f "$target_replicas_file" ]]; then
    restore_oci
  fi
  if [[ "$watchdog_armed" == "1" && "$source_restored" == "1" ]]; then
    delete_watchdog
  fi
  release_lock azure_kubectl "$AZURE_NAMESPACE" "$azure_lock" >/dev/null 2>&1 || true
  release_lock oci_kubectl "$OCI_K8S_NAMESPACE" "$oci_lock" >/dev/null 2>&1 || true
  rm -rf "$WORK_DIR"
  exit "$status"
}
trap 'cleanup $?' EXIT
trap 'cleanup 130' INT
trap 'cleanup 143' TERM

"${azure_kubectl[@]}" create configmap "$azure_lock" -n "$AZURE_NAMESPACE" \
  --from-literal="migration-id=$MIGRATION_ID" \
  --from-literal="source-sha=$SOURCE_SHA" >/dev/null
"${oci_kubectl[@]}" create configmap "$oci_lock" -n "$OCI_K8S_NAMESPACE" \
  --from-literal="migration-id=$MIGRATION_ID" \
  --from-literal="source-sha=$SOURCE_SHA" >/dev/null

record_replicas azure_kubectl "$AZURE_NAMESPACE" "$replicas_file"
record_replicas oci_kubectl "$OCI_K8S_NAMESPACE" "$target_replicas_file"
ingress_replicas="$(
  "${azure_kubectl[@]}" get deployment ingress-nginx-controller -n ingress-nginx \
    -o jsonpath='{.spec.replicas}'
)"
[[ "$ingress_replicas" =~ ^[0-9]+$ ]] || oci_die "invalid Azure ingress replica count"
printf '%s' "$ingress_replicas" > "$WORK_DIR/azure-ingress-replicas"
oci_ingress_replicas="$(
  "${oci_kubectl[@]}" get deployment ingress-nginx-controller -n ingress-nginx \
    -o jsonpath='{.spec.replicas}'
)"
[[ "$oci_ingress_replicas" =~ ^[0-9]+$ ]] || oci_die "invalid OCI ingress replica count"
printf '%s' "$oci_ingress_replicas" > "$WORK_DIR/oci-ingress-replicas"

azure_statefulsets="$("${azure_kubectl[@]}" get statefulsets -n "$AZURE_NAMESPACE" -o json)"
legacy_count="$(
  jq '[.items[] | select(.metadata.name | test("^gaming-(auth|bet|backoffice|event|gamemaster|moderation|resulting|slip)-mongo-depl$"))] | length' \
    <<<"$azure_statefulsets"
)"
all_mongo_count="$(jq '[.items[] | select(.metadata.name | test("mongo"))] | length' <<<"$azure_statefulsets")"
[[ "$legacy_count" == "$all_mongo_count" ]] ||
  oci_die "Azure contains an unknown Mongo StatefulSet"
if [[ "$legacy_count" == "8" ]]; then
  source_topology=legacy
elif [[ "$legacy_count" == "1" ]] &&
  "${azure_kubectl[@]}" get statefulset gaming-auth-mongo-depl -n "$AZURE_NAMESPACE" >/dev/null 2>&1; then
  source_topology=shared
else
  oci_die "Azure Mongo topology is mixed or unknown"
fi

target_mongo_count="$(
  "${oci_kubectl[@]}" get statefulsets -n "$OCI_K8S_NAMESPACE" -o json |
    jq '[.items[] | select(.metadata.name | test("mongo"))] | length'
)"
[[ "$target_mongo_count" == "1" ]] || oci_die "OCI target must contain exactly one Mongo StatefulSet"
"${oci_kubectl[@]}" get statefulset gaming-auth-mongo-depl -n "$OCI_K8S_NAMESPACE" >/dev/null ||
  oci_die "OCI target does not contain the active auth Mongo StatefulSet"
{
  printf '# migration_id=%s\n' "$MIGRATION_ID"
  printf '# source_sha=%s\n' "$SOURCE_SHA"
  printf '# source_topology=%s\n' "$source_topology"
  printf '# azure_replica_state_sha256=%s\n' "$(oci_sha256 < "$replicas_file")"
  printf '# oci_replica_state_sha256=%s\n' "$(oci_sha256 < "$target_replicas_file")"
} > "$JOURNAL_FILE"

source_pod_for_database() {
  local database="$1"
  local service="${database#gaming_}"
  if [[ "$source_topology" == "shared" ]]; then
    printf 'gaming-auth-mongo-depl-0'
  else
    printf 'gaming-%s-mongo-depl-0' "$service"
  fi
}

mongo_compatibility() {
  local kubeconfig="$1"
  local namespace="$2"
  local pod="$3"
  kubectl --kubeconfig "$kubeconfig" exec -n "$namespace" "$pod" -- \
    mongosh --quiet --eval '
      const fcv=db.adminCommand({getParameter:1,featureCompatibilityVersion:1})
        .featureCompatibilityVersion.version;
      const version=db.version();
      print(JSON.stringify({version:version,majorMinor:version.split(".").slice(0,2).join("."),fcv:fcv}));
    '
}

target_preflight_pod="$(
  "${oci_kubectl[@]}" get pods -n "$OCI_K8S_NAMESPACE" -l app=gaming-auth-mongo \
    -o jsonpath='{.items[0].metadata.name}'
)"
[[ -n "$target_preflight_pod" ]] || oci_die "OCI Mongo pod is missing during migration preflight"
target_compatibility="$(mongo_compatibility "$OCI_KUBECONFIG" "$OCI_K8S_NAMESPACE" "$target_preflight_pod")"
jq -e '.majorMinor != null and .fcv != null' <<<"$target_compatibility" >/dev/null ||
  oci_die "unable to read OCI Mongo version/FCV"
target_version_fcv="$(jq -c '{majorMinor,fcv}' <<<"$target_compatibility")"
source_compatibility_reference=""

largest_database_bytes=0
for database in "${databases[@]}"; do
  source_pod="$(source_pod_for_database "$database")"
  database_exists="$(
    "${azure_kubectl[@]}" exec -n "$AZURE_NAMESPACE" "$source_pod" -- \
      mongosh --quiet --eval "
        print(db.adminCommand({listDatabases:1}).databases.some(d=>d.name==='${database}'));
      "
  )"
  [[ "$database_exists" == "true" ]] || oci_die "Azure source database is missing: $database"
  source_compatibility="$(mongo_compatibility "$AZURE_KUBECONFIG" "$AZURE_NAMESPACE" "$source_pod")"
  jq -e '.majorMinor != null and .fcv != null' <<<"$source_compatibility" >/dev/null ||
    oci_die "unable to read Azure Mongo version/FCV"
  source_version_fcv="$(jq -c '{majorMinor,fcv}' <<<"$source_compatibility")"
  if [[ -z "$source_compatibility_reference" ]]; then
    source_compatibility_reference="$source_version_fcv"
  else
    [[ "$source_version_fcv" == "$source_compatibility_reference" ]] ||
      oci_die "Azure Mongo sources do not share a compatible version/FCV"
  fi
  [[ "$source_version_fcv" == "$target_version_fcv" ]] ||
    oci_die "Azure and OCI Mongo major version/FCV are incompatible"
  bytes="$(
    "${azure_kubectl[@]}" exec -n "$AZURE_NAMESPACE" "$source_pod" -- \
      mongosh --quiet --eval "print(db.getSiblingDB('${database}').stats().dataSize || 0)"
  )"
  [[ "$bytes" =~ ^[0-9]+$ ]] || oci_die "unable to determine source size for $database"
  (( bytes > largest_database_bytes )) && largest_database_bytes="$bytes"
done
available_bytes="$(df -Pk "$WORK_DIR" | awk 'NR==2 {print $4 * 1024}')"
(( available_bytes > largest_database_bytes * 2 )) ||
  oci_die "runner has insufficient free disk for encrypted one-database staging"
{
  printf '# azure_mongo_compatibility_sha256=%s\n' \
    "$(printf '%s' "$source_compatibility_reference" | oci_sha256)"
  printf '# oci_mongo_compatibility_sha256=%s\n' \
    "$(printf '%s' "$target_compatibility" | oci_sha256)"
} >> "$JOURNAL_FILE"

watchdog_script="$WORK_DIR/restore-azure.sh"
{
  printf '#!/bin/sh\nset -eu\nsleep %s\n' "$((WATCHDOG_MINUTES * 60))"
  while IFS=$'\t' read -r service replicas; do
    printf 'kubectl scale deployment %q -n %q --replicas %q\n' \
      "gaming-${service}-depl" "$AZURE_NAMESPACE" "$replicas"
  done < "$replicas_file"
  printf 'kubectl scale deployment ingress-nginx-controller -n ingress-nginx --replicas %q\n' "$ingress_replicas"
} > "$watchdog_script"
chmod 700 "$watchdog_script"

watchdog_manifest="$WORK_DIR/watchdog.yaml"
cat > "$watchdog_manifest" <<YAML
apiVersion: v1
kind: ServiceAccount
metadata:
  name: ${watchdog_name}
  namespace: ${AZURE_NAMESPACE}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: ${watchdog_name}
rules:
  - apiGroups: ["apps"]
    resources: ["deployments", "deployments/scale"]
    verbs: ["get", "patch", "update"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: ${watchdog_name}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: ${watchdog_name}
subjects:
  - kind: ServiceAccount
    name: ${watchdog_name}
    namespace: ${AZURE_NAMESPACE}
YAML
"${azure_kubectl[@]}" apply -f "$watchdog_manifest" >/dev/null
"${azure_kubectl[@]}" create configmap "$watchdog_name" -n "$AZURE_NAMESPACE" \
  --from-file=restore.sh="$watchdog_script" --dry-run=client -o yaml |
  "${azure_kubectl[@]}" apply -f - >/dev/null
cat > "$WORK_DIR/watchdog-job.yaml" <<YAML
apiVersion: batch/v1
kind: Job
metadata:
  name: ${watchdog_name}
  namespace: ${AZURE_NAMESPACE}
spec:
  backoffLimit: 2
  template:
    spec:
      restartPolicy: OnFailure
      serviceAccountName: ${watchdog_name}
      containers:
        - name: watchdog
          image: ${AZURE_WATCHDOG_KUBECTL_IMAGE}
          command: ["/bin/sh", "/watchdog/restore.sh"]
          volumeMounts:
            - name: script
              mountPath: /watchdog
              readOnly: true
      volumes:
        - name: script
          configMap:
            name: ${watchdog_name}
            defaultMode: 0500
YAML
"${azure_kubectl[@]}" apply -f "$WORK_DIR/watchdog-job.yaml" >/dev/null
watchdog_armed=1

"${azure_kubectl[@]}" scale deployment ingress-nginx-controller -n ingress-nginx --replicas 0 >/dev/null
wait_for_no_pods azure_kubectl ingress-nginx app.kubernetes.io/component=controller ||
  oci_die "Azure ingress pods did not stop before the freeze"

rabbit_pod="$(
  "${azure_kubectl[@]}" get pods -n "$AZURE_NAMESPACE" -l app=gaming-rabbitmq \
    -o jsonpath='{.items[0].metadata.name}'
)"
[[ -n "$rabbit_pod" ]] || oci_die "Azure RabbitMQ pod is missing"
drained=0
queue_state_recorded=0
for _ in $(seq 1 "$QUEUE_DRAIN_ATTEMPTS"); do
  queue_state="$(
    "${azure_kubectl[@]}" exec -n "$AZURE_NAMESPACE" "$rabbit_pod" -- \
      rabbitmqctl list_queues --quiet name messages_ready messages_unacknowledged consumers
  )"
  queue_count="$(awk 'NF >= 4 {count++} END {print count+0}' <<<"$queue_state")"
  [[ "$queue_count" == "17" ]] || oci_die "Azure RabbitMQ queue set is incomplete"
  azure_queue_names="$(awk 'NF >= 4 {print $1}' <<<"$queue_state" | sort)"
  expected_queue_names="$(sort "$OCI_RABBITMQ_BASELINE_FILE")"
  [[ "$azure_queue_names" == "$expected_queue_names" ]] ||
    oci_die "Azure RabbitMQ queue set differs from exact OCI application baseline"
  if [[ "$queue_state_recorded" == "0" ]]; then
    initial_backlog="$(awk 'NF >= 4 {sum += $2 + $3} END {print sum+0}' <<<"$queue_state")"
    initial_consumers="$(awk 'NF >= 4 {sum += $4} END {print sum+0}' <<<"$queue_state")"
    {
      printf '# azure_queue_count=%s\n' "$queue_count"
      printf '# azure_queue_backlog=%s\n' "$initial_backlog"
      printf '# azure_queue_consumers=%s\n' "$initial_consumers"
    } >> "$JOURNAL_FILE"
    queue_state_recorded=1
  fi
  if ! awk 'NF >= 4 && ($2 != 0 || $3 != 0) && $4 < 1 {bad=1} END {exit bad}' <<<"$queue_state"; then
    oci_die "Azure RabbitMQ has queued messages without a consumer"
  fi
  if awk 'NF >= 4 && ($2 != 0 || $3 != 0) {bad=1} END {exit bad}' <<<"$queue_state"; then
    drained=1
    break
  fi
  sleep "$QUEUE_DRAIN_SLEEP_SECONDS"
done
[[ "$drained" == "1" ]] || oci_die "Azure RabbitMQ queues did not drain before the bounded deadline"

for service in "${app_services[@]}"; do
  "${azure_kubectl[@]}" scale deployment "gaming-${service}-depl" -n "$AZURE_NAMESPACE" --replicas 0 >/dev/null
done
for service in "${app_services[@]}"; do
  wait_for_no_pods azure_kubectl "$AZURE_NAMESPACE" "app=gaming-${service}" ||
    oci_die "Azure application pods did not stop: $service"
done

mongo_signature() {
  local kubeconfig="$1"
  local namespace="$2"
  local pod="$3"
  local database="$4"
  kubectl --kubeconfig "$kubeconfig" exec -n "$namespace" "$pod" -- \
    mongosh --quiet --eval "
      const d=db.getSiblingDB('${database}');
      const infos=d.getCollectionInfos().sort((a,b)=>a.name.localeCompare(b.name));
      const collections=infos.map(i=>({
        info:i,
        indexes:d.getCollection(i.name).getIndexes().sort((a,b)=>a.name.localeCompare(b.name))
      }));
      print(JSON.stringify({dbHash:d.runCommand({dbHash:1}),collections:collections}));
    "
}

printf 'database\tciphertext_sha256\tsource_signature_sha256\ttarget_signature_sha256\n' >> "$JOURNAL_FILE"
for database in "${databases[@]}"; do
  source_pod="$(source_pod_for_database "$database")"
  source_signature="$signatures_dir/${database}.source.json"
  ciphertext="$cipher_dir/${database}.age"
  mongo_signature "$AZURE_KUBECONFIG" "$AZURE_NAMESPACE" "$source_pod" "$database" > "$source_signature"
  "${azure_kubectl[@]}" exec -n "$AZURE_NAMESPACE" "$source_pod" -- \
    mongodump --quiet --db "$database" --archive |
    age --encrypt --recipient "$OCI_MIGRATION_AGE_RECIPIENT" --output "$ciphertext"
  [[ -s "$ciphertext" ]] || oci_die "encrypted archive is empty for $database"
done

restore_azure
delete_watchdog

"${oci_kubectl[@]}" scale deployment ingress-nginx-controller -n ingress-nginx --replicas 0 >/dev/null
wait_for_no_pods oci_kubectl ingress-nginx app.kubernetes.io/component=controller ||
  oci_die "OCI ingress pods did not stop before target restore"
for service in "${app_services[@]}"; do
  "${oci_kubectl[@]}" scale deployment "gaming-${service}-depl" -n "$OCI_K8S_NAMESPACE" --replicas 0 >/dev/null
done
for service in "${app_services[@]}"; do
  wait_for_no_pods oci_kubectl "$OCI_K8S_NAMESPACE" "app=gaming-${service}" ||
    oci_die "OCI application pods did not stop before restore: $service"
done

target_pod="$(
  "${oci_kubectl[@]}" get pods -n "$OCI_K8S_NAMESPACE" -l app=gaming-auth-mongo \
    -o jsonpath='{.items[0].metadata.name}'
)"
[[ -n "$target_pod" ]] || oci_die "OCI Mongo pod is missing"

for database in "${databases[@]}"; do
  ciphertext="$cipher_dir/${database}.age"
  source_signature="$signatures_dir/${database}.source.json"
  target_signature="$signatures_dir/${database}.target.json"
  "${oci_kubectl[@]}" exec -n "$OCI_K8S_NAMESPACE" "$target_pod" -- \
    mongosh --quiet --eval "db.getSiblingDB('${database}').dropDatabase()" >/dev/null
  age --decrypt --identity <(printf '%s\n' "$OCI_MIGRATION_AGE_IDENTITY") "$ciphertext" |
    "${oci_kubectl[@]}" exec -i -n "$OCI_K8S_NAMESPACE" "$target_pod" -- \
      mongorestore --quiet --archive
  mongo_signature "$OCI_KUBECONFIG" "$OCI_K8S_NAMESPACE" "$target_pod" "$database" > "$target_signature"
  source_hash="$(oci_sha256 < "$source_signature")"
  target_hash="$(oci_sha256 < "$target_signature")"
  [[ "$source_hash" == "$target_hash" ]] || oci_die "database signature mismatch after restore: $database"
  cipher_hash="$(oci_sha256 < "$ciphertext")"
  printf '%s\t%s\t%s\t%s\n' "$database" "$cipher_hash" "$source_hash" "$target_hash" >> "$JOURNAL_FILE"
  rm -f "$ciphertext" "$source_signature" "$target_signature"
done

restore_oci || oci_die "OCI application or ingress replicas failed to restore"

target_databases="$(
  "${oci_kubectl[@]}" exec -n "$OCI_K8S_NAMESPACE" "$target_pod" -- \
    mongosh --quiet --eval 'print(JSON.stringify(db.adminCommand({listDatabases:1}).databases.map(d=>d.name).sort()))'
)"
for database in "${databases[@]}"; do
  jq -e --arg database "$database" 'index($database) != null' <<<"$target_databases" >/dev/null ||
    oci_die "restored OCI database is missing: $database"
done

rabbit_pod="$(
  "${oci_kubectl[@]}" get pods -n "$OCI_K8S_NAMESPACE" -l app=gaming-rabbitmq \
    -o jsonpath='{.items[0].metadata.name}'
)"
queue_state="$(
  "${oci_kubectl[@]}" exec -n "$OCI_K8S_NAMESPACE" "$rabbit_pod" -- \
    rabbitmqctl list_queues --quiet name messages_ready messages_unacknowledged consumers
)"
observed_queue_names="$(awk 'NF >= 4 {print $1}' <<<"$queue_state" | sort)"
expected_queue_names="$(sort "$OCI_RABBITMQ_BASELINE_FILE")"
[[ "$observed_queue_names" == "$expected_queue_names" ]] ||
  oci_die "OCI RabbitMQ queue names differ from deployment baseline"
awk 'NF >= 4 && ($2 != 0 || $3 != 0 || $4 < 1) {bad=1} END {exit bad}' <<<"$queue_state" ||
  oci_die "OCI RabbitMQ consumers/backlog are unhealthy after migration"

rm -rf "$WORK_DIR"
trap - EXIT INT TERM
release_lock azure_kubectl "$AZURE_NAMESPACE" "$azure_lock" ||
  oci_die "Azure migration lock identity changed before release"
release_lock oci_kubectl "$OCI_K8S_NAMESPACE" "$oci_lock" ||
  oci_die "OCI migration lock identity changed before release"
oci_log "oci_migration=PASS databases=8 azure_restored=1 plaintext_archives=0"
