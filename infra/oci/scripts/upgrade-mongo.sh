#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

MODE="${1:-}"
OCI_K8S_NAMESPACE="${OCI_K8S_NAMESPACE:-betstan-oci}"
MONGO_TARGET_IMAGE="${MONGO_TARGET_IMAGE:-}"
MONGO_UPGRADE_STATE_FILE="${MONGO_UPGRADE_STATE_FILE:-}"
MONGO_UPGRADE_WAIT_ATTEMPTS="${MONGO_UPGRADE_WAIT_ATTEMPTS:-60}"
MONGO_UPGRADE_SLEEP_SECONDS="${MONGO_UPGRADE_SLEEP_SECONDS:-5}"

MONGO_STATEFULSET=gaming-auth-mongo-depl
MONGO_CONTAINER=gaming-auth-mongo
MONGO_SOURCE_VERSION=7.0.21
MONGO_SOURCE_IMAGE="docker.io/library/mongo@sha256:3d715950d83061ff2fbc910d12d3703212538cacf6b3003e3736fa5c7f51a2e1"
MONGO_TRANSITION_VERSION=8.0.29
MONGO_TRANSITION_IMAGE="docker.io/library/mongo@sha256:de267922bc1153d923f5c9dc429f21c11faf18299080c1ce04d6d6007097fb06"
MONGO_TARGET_VERSION=8.2.12
MONGO_REVIEWED_TARGET_IMAGE="docker.io/library/mongo@sha256:e0ce8c35124d4a9f9785532d1f268f39e9728ffa1cb38f46fa482436424c4bd3"
MONGO_TARGET_ARM64_MANIFEST=sha256:21ca0269db1ebbd1c59f5cbc04928d7e3f6ab6186d7ceafc8fa489c0486525b4
MONGO_INSPECTOR_POD=betstan-mongo-storage-inspector

APP_SERVICES=(
  auth bet backoffice event gamemaster moderation resulting slip client
)
inspector_pod=""

oci_require_command kubectl
oci_require_command jq
[[ "$MODE" == "prepare" || "$MODE" == "finalize" || "$MODE" == "resume" ]] ||
  oci_die "Mongo upgrade mode must be prepare, finalize, or resume"
[[ "$MONGO_TARGET_IMAGE" == "$MONGO_REVIEWED_TARGET_IMAGE" ]] ||
  oci_die "Mongo target image differs from the reviewed 8.2.12 image"
[[ -n "$MONGO_UPGRADE_STATE_FILE" ]] ||
  oci_die "MONGO_UPGRADE_STATE_FILE is required"
[[ "$MONGO_UPGRADE_WAIT_ATTEMPTS" =~ ^[1-9][0-9]*$ ]] ||
  oci_die "MONGO_UPGRADE_WAIT_ATTEMPTS must be a positive integer"
[[ "$MONGO_UPGRADE_SLEEP_SECONDS" =~ ^[0-9]+$ ]] ||
  oci_die "MONGO_UPGRADE_SLEEP_SECONDS must be a non-negative integer"

cleanup() {
  local rc="$1"
  trap - EXIT INT TERM
  if [[ -n "$inspector_pod" ]]; then
    kubectl delete pod "$inspector_pod" -n "$OCI_K8S_NAMESPACE" \
      --ignore-not-found --wait=true >/dev/null 2>&1 || true
  fi
  exit "$rc"
}
trap 'cleanup "$?"' EXIT
trap 'cleanup 130' INT
trap 'cleanup 143' TERM

write_upgrade_state() {
  local maintenance="$1"
  mkdir -p "$(dirname "$MONGO_UPGRADE_STATE_FILE")"
  umask 077
  printf 'maintenance=%q\n' "$maintenance" > "$MONGO_UPGRADE_STATE_FILE"
}

read_upgrade_state() {
  local maintenance=""
  [[ -f "$MONGO_UPGRADE_STATE_FILE" ]] ||
    oci_die "Mongo upgrade state file is missing"
  # shellcheck disable=SC1090
  source "$MONGO_UPGRADE_STATE_FILE"
  [[ "$maintenance" == "true" || "$maintenance" == "false" ]] ||
    oci_die "Mongo upgrade state is invalid"
  printf '%s' "$maintenance"
}

mongo_pod() {
  local pod
  pod="$(
    kubectl get pods -n "$OCI_K8S_NAMESPACE" -l app=gaming-auth-mongo \
      -o jsonpath='{.items[0].metadata.name}'
  )"
  [[ -n "$pod" ]] || oci_die "Mongo pod is missing during version alignment"
  printf '%s' "$pod"
}

mongo_runtime() {
  local pod runtime
  pod="$(mongo_pod)"
  runtime="$(
    kubectl exec -n "$OCI_K8S_NAMESPACE" "$pod" -- \
      mongosh --quiet --eval '
        const result=db.adminCommand({getParameter:1,featureCompatibilityVersion:1});
        if (result.ok !== 1) throw new Error("FCV read failed");
        print(JSON.stringify({
          version:db.version(),
          majorMinor:db.version().split(".").slice(0,2).join("."),
          fcv:result.featureCompatibilityVersion.version
        }));
      '
  )"
  jq -e '
    type == "object" and
    (.version | type == "string") and
    (.majorMinor | type == "string") and
    (.fcv | type == "string")
  ' <<<"$runtime" >/dev/null ||
    oci_die "Mongo runtime version or FCV is unreadable"
  printf '%s' "$runtime"
}

runtime_signature() {
  jq -r '.majorMinor + "|" + .fcv' <<<"$1"
}

wait_for_mongo() {
  local pod
  kubectl rollout status "statefulset/$MONGO_STATEFULSET" \
    -n "$OCI_K8S_NAMESPACE" --timeout=10m >/dev/null
  pod="$(mongo_pod)"
  for _ in $(seq 1 "$MONGO_UPGRADE_WAIT_ATTEMPTS"); do
    if kubectl exec -n "$OCI_K8S_NAMESPACE" "$pod" -- \
        mongosh --quiet --eval 'db.adminCommand({ping:1}).ok' 2>/dev/null |
        grep -qx 1; then
      return 0
    fi
    sleep "$MONGO_UPGRADE_SLEEP_SECONDS"
  done
  oci_die "Mongo did not become ready during staged version alignment"
}

deployment_replicas() {
  local namespace="$1"
  local deployment="$2"
  kubectl get deployment "$deployment" -n "$namespace" -o json |
    jq -r '[.spec.replicas // 0, .status.readyReplicas // 0] | @tsv'
}

pod_count() {
  local namespace="$1"
  local selector="$2"
  kubectl get pods -n "$namespace" -l "$selector" -o json |
    jq -r '.items | length'
}

workloads_are_active() {
  local service replicas
  replicas="$(deployment_replicas ingress-nginx ingress-nginx-controller)" ||
    return 1
  [[ "$replicas" == $'1\t1' ]] || return 1
  for service in "${APP_SERVICES[@]}"; do
    replicas="$(deployment_replicas "$OCI_K8S_NAMESPACE" "gaming-${service}-depl")" ||
      return 1
    [[ "$replicas" == $'1\t1' ]] || return 1
  done
}

freeze_writers() {
  local service identity replicas count all_zero
  kubectl scale deployment ingress-nginx-controller -n ingress-nginx \
    --replicas=0 >/dev/null
  for service in "${APP_SERVICES[@]}"; do
    identity="$(
      kubectl get deployment "gaming-${service}-depl" \
        -n "$OCI_K8S_NAMESPACE" --ignore-not-found -o name
    )" || oci_die "unable to inspect OCI writer deployment: $service"
    if [[ -n "$identity" ]]; then
      kubectl scale deployment "gaming-${service}-depl" \
        -n "$OCI_K8S_NAMESPACE" --replicas=0 >/dev/null
    fi
  done

  for _ in $(seq 1 "$MONGO_UPGRADE_WAIT_ATTEMPTS"); do
    all_zero=true
    replicas="$(deployment_replicas ingress-nginx ingress-nginx-controller)" ||
      oci_die "unable to verify frozen OCI ingress deployment"
    [[ "$replicas" == $'0\t0' ]] || all_zero=false
    count="$(pod_count ingress-nginx 'app.kubernetes.io/component=controller')" ||
      oci_die "unable to verify frozen OCI ingress pods"
    [[ "$count" == "0" ]] || all_zero=false
    for service in "${APP_SERVICES[@]}"; do
      identity="$(
        kubectl get deployment "gaming-${service}-depl" \
          -n "$OCI_K8S_NAMESPACE" --ignore-not-found -o name
      )" || oci_die "unable to verify frozen OCI writer deployment: $service"
      if [[ -n "$identity" ]]; then
        replicas="$(
          deployment_replicas "$OCI_K8S_NAMESPACE" "gaming-${service}-depl"
        )" || oci_die "unable to read frozen OCI writer replicas: $service"
        [[ "$replicas" == $'0\t0' ]] || all_zero=false
      fi
      count="$(pod_count "$OCI_K8S_NAMESPACE" "app=gaming-${service}")" ||
        oci_die "unable to verify frozen OCI writer pods: $service"
      [[ "$count" == "0" ]] || all_zero=false
    done
    [[ "$all_zero" == "true" ]] && return 0
    sleep "$MONGO_UPGRADE_SLEEP_SECONDS"
  done
  oci_die "OCI writers did not stop before Mongo version alignment"
}

verify_fresh_storage_is_empty() {
  local pvc_identity pvc_phase empty=false
  pvc_identity="$(
    kubectl get pvc gaming-auth-mongo-data -n "$OCI_K8S_NAMESPACE" \
      --ignore-not-found -o name
  )" || oci_die "unable to inspect Mongo PVC before fresh installation"
  [[ "$pvc_identity" == "persistentvolumeclaim/gaming-auth-mongo-data" ]] ||
    oci_die "Mongo StatefulSet is absent and its exact PVC is unavailable"
  pvc_phase="$(
    kubectl get pvc gaming-auth-mongo-data -n "$OCI_K8S_NAMESPACE" \
      -o jsonpath='{.status.phase}'
  )" || oci_die "unable to read Mongo PVC phase before fresh installation"
  [[ "$pvc_phase" == "Bound" ]] ||
    oci_die "Mongo StatefulSet is absent and its PVC is not Bound"

  kubectl delete pod "$MONGO_INSPECTOR_POD" -n "$OCI_K8S_NAMESPACE" \
    --ignore-not-found --wait=true >/dev/null
  inspector_pod="$MONGO_INSPECTOR_POD"
  kubectl apply -f - >/dev/null <<YAML
apiVersion: v1
kind: Pod
metadata:
  name: ${MONGO_INSPECTOR_POD}
  namespace: ${OCI_K8S_NAMESPACE}
spec:
  automountServiceAccountToken: false
  restartPolicy: Never
  containers:
    - name: storage-inspector
      image: ${MONGO_SOURCE_IMAGE}
      command: ["/bin/sh", "-c", "sleep 600"]
      resources:
        requests:
          cpu: 25m
          memory: 64Mi
        limits:
          cpu: 100m
          memory: 128Mi
      volumeMounts:
        - name: mongo-data
          mountPath: /data/db
          readOnly: true
  volumes:
    - name: mongo-data
      persistentVolumeClaim:
        claimName: gaming-auth-mongo-data
        readOnly: true
YAML
  kubectl wait pod "$MONGO_INSPECTOR_POD" -n "$OCI_K8S_NAMESPACE" \
    --for=condition=Ready --timeout=2m >/dev/null
  if kubectl exec -n "$OCI_K8S_NAMESPACE" "$MONGO_INSPECTOR_POD" -- \
      /bin/sh -c \
      'entries="$(find /data/db -mindepth 1 -maxdepth 1 ! -name lost+found -print -quit)" ||
        exit 41
       test -z "$entries"'; then
    empty=true
  fi
  kubectl delete pod "$MONGO_INSPECTOR_POD" -n "$OCI_K8S_NAMESPACE" \
    --wait=true >/dev/null
  inspector_pod=""
  [[ "$empty" == "true" ]] ||
    oci_die "Mongo StatefulSet is absent but retained storage is not empty"
}

set_fcv() {
  local requested="$1"
  local pod result
  [[ "$requested" == "8.0" || "$requested" == "8.2" ]] ||
    oci_die "unsupported Mongo FCV transition"
  pod="$(mongo_pod)"
  result="$(
    kubectl exec -n "$OCI_K8S_NAMESPACE" "$pod" -- \
      mongosh --quiet --eval "
        const result=db.adminCommand({
          setFeatureCompatibilityVersion:'${requested}',
          confirm:true
        });
        print(JSON.stringify(result));
      "
  )"
  jq -e '.ok == 1' <<<"$result" >/dev/null ||
    oci_die "Mongo rejected FCV ${requested}"
}

validate_runtime_for_image() {
  local image="$1"
  local runtime="$2"
  local version signature
  version="$(jq -r '.version' <<<"$runtime")"
  signature="$(runtime_signature "$runtime")"
  case "$image" in
    "$MONGO_SOURCE_IMAGE")
      [[ "$version" == "$MONGO_SOURCE_VERSION" && "$signature" == "7.0|7.0" ]] ||
        oci_die "reviewed Mongo 7.0 source image has an unexpected runtime or FCV"
      ;;
    "$MONGO_TRANSITION_IMAGE")
      [[ "$version" == "$MONGO_TRANSITION_VERSION" &&
        ( "$signature" == "8.0|7.0" || "$signature" == "8.0|8.0" ) ]] ||
        oci_die "reviewed Mongo 8.0 transition image has an unexpected runtime or FCV"
      ;;
    "$MONGO_REVIEWED_TARGET_IMAGE")
      [[ "$version" == "$MONGO_TARGET_VERSION" &&
        ( "$signature" == "8.2|8.0" || "$signature" == "8.2|8.2" ) ]] ||
        oci_die "reviewed Mongo 8.2 target image has an unexpected runtime or FCV"
      ;;
    *)
      oci_die "live Mongo image is outside the reviewed staged upgrade path"
      ;;
  esac
}

prepare_upgrade() {
  local statefulset_identity current_image runtime signature
  statefulset_identity="$(
    kubectl get statefulset "$MONGO_STATEFULSET" -n "$OCI_K8S_NAMESPACE" \
      --ignore-not-found -o name
  )" || oci_die "unable to inspect the live Mongo StatefulSet"
  if [[ -z "$statefulset_identity" ]]; then
    verify_fresh_storage_is_empty
    write_upgrade_state true
    freeze_writers
    oci_log "oci_mongo_upgrade_prepare=PASS state=fresh-install-frozen"
    return
  fi
  [[ "$statefulset_identity" == "statefulset.apps/$MONGO_STATEFULSET" ]] ||
    oci_die "live Mongo StatefulSet identity is unexpected"

  current_image="$(
    kubectl get statefulset "$MONGO_STATEFULSET" -n "$OCI_K8S_NAMESPACE" \
      -o jsonpath='{.spec.template.spec.containers[0].image}'
  )"
  case "$current_image" in
    "$MONGO_SOURCE_IMAGE"|"$MONGO_TRANSITION_IMAGE"|"$MONGO_REVIEWED_TARGET_IMAGE") ;;
    *) oci_die "live Mongo image is outside the reviewed staged upgrade path" ;;
  esac
  wait_for_mongo
  runtime="$(mongo_runtime)"
  validate_runtime_for_image "$current_image" "$runtime"
  signature="$(runtime_signature "$runtime")"

  if [[ "$current_image" == "$MONGO_REVIEWED_TARGET_IMAGE" &&
        "$signature" == "8.2|8.2" ]] && workloads_are_active; then
    write_upgrade_state false
    oci_log "oci_mongo_upgrade_prepare=PASS state=already-aligned"
    return
  fi

  write_upgrade_state true
  freeze_writers

  if [[ "$current_image" == "$MONGO_SOURCE_IMAGE" ]]; then
    kubectl set image "statefulset/$MONGO_STATEFULSET" \
      "$MONGO_CONTAINER=$MONGO_TRANSITION_IMAGE" \
      -n "$OCI_K8S_NAMESPACE" >/dev/null
    wait_for_mongo
    runtime="$(mongo_runtime)"
    [[ "$(jq -r '.version' <<<"$runtime")" == "$MONGO_TRANSITION_VERSION" &&
      "$(runtime_signature "$runtime")" == "8.0|7.0" ]] ||
      oci_die "Mongo did not enter the reviewed 8.0 binary transition state"
    set_fcv 8.0
    runtime="$(mongo_runtime)"
    [[ "$(runtime_signature "$runtime")" == "8.0|8.0" ]] ||
      oci_die "Mongo FCV did not reach 8.0 before the 8.2 rollout"
  elif [[ "$current_image" == "$MONGO_TRANSITION_IMAGE" &&
          "$signature" == "8.0|7.0" ]]; then
    set_fcv 8.0
    runtime="$(mongo_runtime)"
    [[ "$(runtime_signature "$runtime")" == "8.0|8.0" ]] ||
      oci_die "Mongo FCV did not reach 8.0 before the 8.2 rollout"
  fi

  oci_log "oci_mongo_upgrade_prepare=PASS state=ready-for-8.2"
}

finalize_upgrade() {
  local current_image runtime signature image_id target_digest
  current_image="$(
    kubectl get statefulset "$MONGO_STATEFULSET" -n "$OCI_K8S_NAMESPACE" \
      -o jsonpath='{.spec.template.spec.containers[0].image}'
  )"
  [[ "$current_image" == "$MONGO_REVIEWED_TARGET_IMAGE" ]] ||
    oci_die "Mongo StatefulSet did not apply the reviewed 8.2.12 image"
  wait_for_mongo
  runtime="$(mongo_runtime)"
  validate_runtime_for_image "$current_image" "$runtime"
  signature="$(runtime_signature "$runtime")"
  if [[ "$signature" == "8.2|8.0" ]]; then
    set_fcv 8.2
    runtime="$(mongo_runtime)"
  fi
  [[ "$(jq -r '.version' <<<"$runtime")" == "$MONGO_TARGET_VERSION" &&
    "$(runtime_signature "$runtime")" == "8.2|8.2" ]] ||
    oci_die "Mongo runtime did not converge to exact version 8.2.12 and FCV 8.2"

  image_id="$(
    kubectl get pod "$(mongo_pod)" -n "$OCI_K8S_NAMESPACE" \
      -o jsonpath='{.status.containerStatuses[0].imageID}'
  )"
  target_digest="${MONGO_REVIEWED_TARGET_IMAGE##*@}"
  [[ "$image_id" == *"@$target_digest" ||
    "$image_id" == *"@$MONGO_TARGET_ARM64_MANIFEST" ]] ||
    oci_die "running Mongo image digest differs from the reviewed 8.2.12 index"
  oci_log "oci_mongo_upgrade_finalize=PASS version=8.2.12 fcv=8.2"
}

resume_ingress() {
  local maintenance
  maintenance="$(read_upgrade_state)"
  if [[ "$maintenance" == "true" ]]; then
    kubectl scale deployment ingress-nginx-controller -n ingress-nginx \
      --replicas=1 >/dev/null
    kubectl rollout status deployment/ingress-nginx-controller \
      -n ingress-nginx --timeout=10m >/dev/null
  fi
  oci_log "oci_mongo_upgrade_resume=PASS"
}

case "$MODE" in
  prepare) prepare_upgrade ;;
  finalize) finalize_upgrade ;;
  resume) resume_ingress ;;
esac
