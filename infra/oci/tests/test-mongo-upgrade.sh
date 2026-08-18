#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
UPGRADE="$ROOT_DIR/infra/oci/scripts/upgrade-mongo.sh"
WORK_DIR="$ROOT_DIR/infra/oci/tests/.mongo-upgrade-work"
STATE="$WORK_DIR/state.json"
LOG="$WORK_DIR/kubectl.log"
UPGRADE_STATE="$WORK_DIR/upgrade.env"
SOURCE_IMAGE="docker.io/library/mongo@sha256:3d715950d83061ff2fbc910d12d3703212538cacf6b3003e3736fa5c7f51a2e1"
TRANSITION_IMAGE="docker.io/library/mongo@sha256:de267922bc1153d923f5c9dc429f21c11faf18299080c1ce04d6d6007097fb06"
TARGET_IMAGE="docker.io/library/mongo@sha256:e0ce8c35124d4a9f9785532d1f268f39e9728ffa1cb38f46fa482436424c4bd3"

fail() {
  echo "Mongo upgrade contract failure: $*" >&2
  exit 1
}

rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR/bin"
trap 'rm -rf "$WORK_DIR"' EXIT

cat > "$WORK_DIR/bin/kubectl" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail

state="${KUBECTL_STATE:?}"
log="${KUBECTL_LOG:?}"
printf '%q ' "$@" >> "$log"
printf '\n' >> "$log"

update_state() {
  local filter="$1"
  local tmp="${state}.$$"
  jq "$filter" "$state" > "$tmp"
  mv "$tmp" "$state"
}

namespace=""
for ((index=1; index <= $#; index++)); do
  if [[ "${!index}" == "-n" ]]; then
    next=$((index + 1))
    namespace="${!next}"
  fi
done

case "${1:-}" in
  get)
    case "${2:-}" in
      statefulset)
        if [[ "$(jq -r .exists "$state")" != "true" ]]; then
          [[ "$*" == *--ignore-not-found* ]] && exit 0
          exit 1
        fi
        if [[ "$*" == *'-o name'* ]]; then
          printf 'statefulset.apps/gaming-auth-mongo-depl\n'
        elif [[ "$*" == *jsonpath* ]]; then
          jq -r .image "$state"
        else
          printf '{}\n'
        fi
        ;;
      pods)
        if [[ "$*" == *'-o json'* ]]; then
          if [[ "$namespace" == "ingress-nginx" ]]; then
            replicas="$(jq -r .ingress "$state")"
          else
            replicas="$(jq -r .apps "$state")"
          fi
          jq -cn --argjson count "$replicas" \
            '{items:[range(0;$count) | {}]}'
        else
          printf 'gaming-auth-mongo-depl-0'
        fi
        ;;
      pod)
        digest="$(
          jq -r '.image_id_digest // (.image | split("@")[1])' "$state"
        )"
        printf 'docker.io/library/mongo@%s' "$digest"
        ;;
      pvc)
        if [[ "$*" == *'-o name'* ]]; then
          printf 'persistentvolumeclaim/gaming-auth-mongo-data\n'
        elif [[ "$*" == *jsonpath* ]]; then
          printf 'Bound'
        else
          printf '{}\n'
        fi
        ;;
      deployment)
        name="${3:-}"
        if [[ "$name" == "ingress-nginx-controller" ]]; then
          replicas="$(jq -r .ingress "$state")"
        else
          [[ "$(jq -r .apps_exist "$state")" == "true" ]] || exit 1
          replicas="$(jq -r .apps "$state")"
        fi
        if [[ "$*" == *'-o name'* ]]; then
          printf 'deployment.apps/%s\n' "$name"
        elif [[ "$*" == *'-o json'* ]]; then
          jq -cn --argjson replicas "$replicas" \
            '{spec:{replicas:$replicas},status:{readyReplicas:$replicas}}'
        else
          printf '{}\n'
        fi
        ;;
      *)
        exit 1
        ;;
    esac
    ;;
  rollout)
    [[ "${KUBECTL_FAIL_ROLLOUT:-0}" != "1" ]]
    ;;
  apply)
    cat >/dev/null
    ;;
  delete|wait)
    ;;
  scale)
    replicas=""
    for argument in "$@"; do
      case "$argument" in
        --replicas=*) replicas="${argument#*=}" ;;
      esac
    done
    [[ "$replicas" =~ ^[01]$ ]] || exit 1
    if [[ "$namespace" == "ingress-nginx" ]]; then
      update_state ".ingress=$replicas"
    else
      update_state ".apps=$replicas"
    fi
    ;;
  set)
    assignment="${4:-}"
    image="${assignment#*=}"
    case "$image" in
      *de267922bc1153d923f5c9dc429f21c11faf18299080c1ce04d6d6007097fb06)
        update_state \
          ".image=\"$image\" | .version=\"8.0.29\" | .major=\"8.0\""
        ;;
      *e0ce8c35124d4a9f9785532d1f268f39e9728ffa1cb38f46fa482436424c4bd3)
        update_state \
          ".image=\"$image\" | .version=\"8.2.12\" | .major=\"8.2\""
        ;;
      *)
        exit 1
        ;;
    esac
    ;;
  exec)
    if [[ "$*" == *betstan-mongo-storage-inspector* ]]; then
      [[ "$(jq -r .storage_empty "$state")" == "true" ]]
    elif [[ "$*" == *setFeatureCompatibilityVersion* ]]; then
      if [[ "$*" == *"'8.0'"* ]]; then
        update_state '.fcv="8.0"'
      elif [[ "$*" == *"'8.2'"* ]]; then
        update_state '.fcv="8.2"'
      else
        exit 1
      fi
      printf '{"ok":1}\n'
    elif [[ "$*" == *'ping:1'* ]]; then
      printf '1\n'
    else
      jq -c '{version,majorMinor:.major,fcv}' "$state"
    fi
    ;;
  *)
    exit 1
    ;;
esac
STUB
chmod +x "$WORK_DIR/bin/kubectl"

write_state() {
  local image="$1"
  local version="$2"
  local major="$3"
  local fcv="$4"
  local ingress="${5:-1}"
  local apps="${6:-1}"
  jq -cn \
    --arg image "$image" \
    --arg version "$version" \
    --arg major "$major" \
    --arg fcv "$fcv" \
    --argjson ingress "$ingress" \
    --argjson apps "$apps" \
    '{
      exists:true,
      apps_exist:true,
      image:$image,
      version:$version,
      major:$major,
      fcv:$fcv,
      ingress:$ingress,
      apps:$apps
      ,storage_empty:true
    }' > "$STATE"
  : > "$LOG"
  rm -f "$UPGRADE_STATE"
}

run_upgrade() {
  env \
    PATH="$WORK_DIR/bin:$PATH" \
    KUBECTL_STATE="$STATE" \
    KUBECTL_LOG="$LOG" \
    OCI_K8S_NAMESPACE=betstan-oci \
    MONGO_TARGET_IMAGE="$TARGET_IMAGE" \
    MONGO_UPGRADE_STATE_FILE="$UPGRADE_STATE" \
    MONGO_UPGRADE_WAIT_ATTEMPTS=2 \
    MONGO_UPGRADE_SLEEP_SECONDS=0 \
    "$UPGRADE" "$1"
}

write_state "$SOURCE_IMAGE" 7.0.21 7.0 7.0
run_upgrade prepare >/dev/null
jq -e \
  --arg image "$TRANSITION_IMAGE" '
    .image == $image and .version == "8.0.29" and
    .major == "8.0" and .fcv == "8.0" and
    .ingress == 0 and .apps == 0
  ' "$STATE" >/dev/null ||
  fail "7.0 prepare did not stage 8.0/FCV 8.0 with writers frozen"
grep -Fq 'maintenance=true' "$UPGRADE_STATE" ||
  fail "7.0 prepare did not persist maintenance state"
python3 - "$LOG" <<'PY'
import sys

lines = open(sys.argv[1], encoding="utf-8").read().splitlines()
image = next(i for i, line in enumerate(lines) if "set image" in line)
fcv = next(i for i, line in enumerate(lines) if "setFeatureCompatibilityVersion" in line)
if image >= fcv:
    raise SystemExit("Mongo 8.0 FCV changed before the 8.0 binary rollout")
PY

jq \
  --arg image "$TARGET_IMAGE" '
    .image=$image | .version="8.2.12" | .major="8.2"
  ' "$STATE" > "$STATE.tmp"
mv "$STATE.tmp" "$STATE"
run_upgrade finalize >/dev/null
jq -e '.version == "8.2.12" and .major == "8.2" and .fcv == "8.2"' \
  "$STATE" >/dev/null ||
  fail "8.2 finalize did not set exact target runtime and FCV"
run_upgrade resume >/dev/null
[[ "$(jq -r .ingress "$STATE")" == "1" ]] ||
  fail "maintenance ingress was not resumed"

write_state "$TRANSITION_IMAGE" 8.0.29 8.0 7.0 0 0
run_upgrade prepare >/dev/null
jq -e '.fcv == "8.0" and .ingress == 0 and .apps == 0' "$STATE" >/dev/null ||
  fail "interrupted 8.0 transition did not resume safely"

write_state "$TARGET_IMAGE" 8.2.12 8.2 8.0 0 0
run_upgrade prepare >/dev/null
run_upgrade finalize >/dev/null
[[ "$(jq -r .fcv "$STATE")" == "8.2" ]] ||
  fail "interrupted 8.2 FCV transition did not resume safely"

write_state "$TARGET_IMAGE" 8.2.12 8.2 8.2
run_upgrade prepare >/dev/null
grep -Fq 'maintenance=false' "$UPGRADE_STATE" ||
  fail "aligned Mongo unexpectedly entered maintenance"
if grep -Eq '^scale |^set image ' "$LOG"; then
  fail "aligned Mongo was mutated during prepare"
fi
jq '.image_id_digest="sha256:21ca0269db1ebbd1c59f5cbc04928d7e3f6ab6186d7ceafc8fa489c0486525b4"' \
  "$STATE" > "$STATE.tmp"
mv "$STATE.tmp" "$STATE"
run_upgrade finalize >/dev/null
run_upgrade resume >/dev/null

write_state "$TARGET_IMAGE" 8.2.12 8.2 8.2
jq '.exists=false | .storage_empty=true' "$STATE" > "$STATE.tmp"
mv "$STATE.tmp" "$STATE"
run_upgrade prepare >/dev/null
grep -Fq 'maintenance=true' "$UPGRADE_STATE" ||
  fail "fresh Mongo installation did not preserve maintenance fencing"
jq -e '.ingress == 0 and .apps == 0' "$STATE" >/dev/null ||
  fail "fresh Mongo installation did not freeze existing writers"

write_state "$TARGET_IMAGE" 8.2.12 8.2 8.2
jq '.exists=false | .storage_empty=false' "$STATE" > "$STATE.tmp"
mv "$STATE.tmp" "$STATE"
if run_upgrade prepare >"$WORK_DIR/nonempty-storage.out" 2>&1; then
  fail "non-empty retained storage bypassed the staged upgrade"
fi

rm -f "$UPGRADE_STATE"
if run_upgrade resume >"$WORK_DIR/missing-state.out" 2>&1; then
  fail "Mongo ingress resume accepted a missing upgrade state"
fi

write_state "$SOURCE_IMAGE" 7.0.20 7.0 7.0
if run_upgrade prepare >"$WORK_DIR/invalid-runtime.out" 2>&1; then
  fail "unexpected Mongo source version was accepted"
fi
if grep -Eq '^scale |^set image ' "$LOG"; then
  fail "unexpected Mongo source version mutated live workloads"
fi

write_state "$SOURCE_IMAGE" 7.0.21 7.0 7.0
if env \
    PATH="$WORK_DIR/bin:$PATH" \
    KUBECTL_STATE="$STATE" \
    KUBECTL_LOG="$LOG" \
    OCI_K8S_NAMESPACE=betstan-oci \
    MONGO_TARGET_IMAGE="${TARGET_IMAGE%?}0" \
    MONGO_UPGRADE_STATE_FILE="$UPGRADE_STATE" \
    "$UPGRADE" prepare >"$WORK_DIR/wrong-target.out" 2>&1; then
  fail "unreviewed Mongo target image was accepted"
fi

echo "oci_mongo_upgrade_contract=PASS"
