#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
HELPER="$ROOT_DIR/infra/oci/scripts/k3s_disk_recovery_stan.py"
ORCHESTRATOR="$ROOT_DIR/infra/oci/scripts/k3s-node-disk-recovery-stan.sh"
REMOTE="$ROOT_DIR/infra/oci/scripts/k3s-node-disk-remote-stan.sh"
WORK_PARENT="$ROOT_DIR/infra/oci/tests/.k3s-disk-recovery-workdirs"
mkdir -p "$WORK_PARENT"
work_dir="$(mktemp -d "$WORK_PARENT/test.XXXXXX")"
cleanup() {
  while read -r pid; do
    [[ -n "$pid" ]] || continue
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done < <(jobs -p)
  rm -rf "$work_dir"
  rmdir "$WORK_PARENT" 2>/dev/null || true
}
trap cleanup EXIT

fail() {
  echo "k3s disk recovery contract test failed: $*" >&2
  exit 1
}

sha() {
  printf 'sha256:%064d' "$1"
}

SOURCE_SHA=1111111111111111111111111111111111111111
RECLAIM_SOURCE_SHA=3333333333333333333333333333333333333333
ROLLBACK_SOURCE_SHA=7777777777777777777777777777777777777777
CURRENT_ID="$(sha 1)"
CANDIDATE_ID="$(sha 2)"
RECLAIM_ID="$(sha 3)"
FOREIGN_ID="$(sha 4)"
UNTAGGED_ID="$(sha 5)"
PINNED_ID="$(sha 6)"
ROLLBACK_ID="$(sha 7)"
STOPPED_ID="$(sha 8)"

candidate_images="$work_dir/candidate-images.tsv"
: >"$candidate_images"
for service_number in 1 2 3 4 5 6 7 8 9; do
  service="service-${service_number}"
  manifest="$(sha "$((100 + service_number))")"
  platform="$(sha "$((200 + service_number))")"
  if [[ "$service_number" == "1" ]]; then
    platform="$CANDIDATE_ID"
  fi
  printf '%s\t%s\t%s@%s\t%s\t%s\n' \
    "$service" \
    "ghcr.io/vasilyevstan/betstan-images" \
    "ghcr.io/vasilyevstan/betstan-images" \
    "$manifest" "$manifest" "$platform" >>"$candidate_images"
done

runtime="$work_dir/runtime.json"
python3 - "$runtime" \
  "$CURRENT_ID" "$CANDIDATE_ID" "$RECLAIM_ID" "$FOREIGN_ID" \
  "$UNTAGGED_ID" "$PINNED_ID" "$ROLLBACK_ID" "$STOPPED_ID" \
  "$SOURCE_SHA" "$RECLAIM_SOURCE_SHA" "$ROLLBACK_SOURCE_SHA" <<'PY'
import json
import sys

(
    output,
    current_id,
    candidate_id,
    reclaim_id,
    foreign_id,
    untagged_id,
    pinned_id,
    rollback_id,
    stopped_id,
    source_sha,
    reclaim_source_sha,
    rollback_source_sha,
) = sys.argv[1:]
repo = "ghcr.io/vasilyevstan/betstan-images"

def image(image_id, tags, digests, *, pinned=False, size=1000):
    return {
        "id": image_id,
        "repoTags": tags,
        "repoDigests": digests,
        "sizeBytes": size,
        "pinned": pinned,
    }

payload = {
    "schemaVersion": "k3s-node-disk-runtime.v1",
    "applicationRepository": repo,
    "root": {
        "mount": {
            "target": "/",
            "source": "/dev/root",
            "fstype": "ext4",
            "size": 50_000_000_000,
            "used": 37_000_000_000,
            "avail": 13_000_000_000,
        },
        "df": {
            "capacityBytes": 50_000_000_000,
            "usedBytes": 37_000_000_000,
            "availableBytes": 13_000_000_000,
            "usedPercent": 74,
        },
    },
    "mongo": {
        "mount": {
            "target": "/var/lib/betstan/mongo",
            "source": "/dev/oracleoci/oraclevdb",
            "fstype": "ext4",
            "size": 50_000_000_000,
            "used": 5_000_000_000,
            "avail": 45_000_000_000,
        },
        "separateFromRoot": True,
    },
    "consumers": [
        {"category": "apt-package-cache", "path": "/var/cache/apt", "bytes": 2_000_000_000},
        {"category": "k3s-containerd", "path": "/var/lib/rancher/k3s/agent/containerd", "bytes": 20_000_000_000},
        {"category": "k3s-server", "path": "/var/lib/rancher/k3s/server", "bytes": 1_000_000_000},
        {"category": "kubelet", "path": "/var/lib/kubelet", "bytes": 500_000_000},
        {"category": "mongo-data", "path": "/var/lib/betstan/mongo", "bytes": 5_000_000_000},
        {"category": "system-logs", "path": "/var/log", "bytes": 400_000_000},
    ],
    "images": [
        image(current_id, [f"{repo}:auth-{source_sha}"], [f"{repo}@{current_id}"]),
        image(candidate_id, [f"{repo}:bet-{source_sha}"], [f"{repo}@{candidate_id}"]),
        image(reclaim_id, [f"{repo}:event-{reclaim_source_sha}"], [f"{repo}@{reclaim_id}"], size=3_000_000_000),
        image(foreign_id, ["docker.io/library/busybox:latest"], [f"docker.io/library/busybox@{foreign_id}"]),
        image(untagged_id, [], []),
        image(pinned_id, [f"{repo}:client-{reclaim_source_sha}"], [f"{repo}@{pinned_id}"], pinned=True),
        image(rollback_id, [f"{repo}:slip-{rollback_source_sha}"], [f"{repo}@{rollback_id}"]),
        image(stopped_id, [f"{repo}:auth-{reclaim_source_sha}"], [f"{repo}@{stopped_id}"]),
    ],
    "containerImageReferences": [
        {"imageRef": current_id, "requestedImage": f"{repo}@{current_id}", "state": "CONTAINER_RUNNING"},
        {"imageRef": stopped_id, "requestedImage": f"{repo}@{stopped_id}", "state": "CONTAINER_EXITED"},
    ],
    "kubernetesImageReferences": [
        f"{repo}@{current_id}",
        f"{repo}@{rollback_id}",
    ],
    "workload": {"podCount": 12, "unhealthyPodCount": 0, "restartCount": 4},
    "queue": {"queueCount": 11, "backlog": 7, "consumersHealthy": True},
    "publicRead": [
        {"name": "api-backoffice", "status": 200},
        {"name": "api-event", "status": 200},
        {"name": "home", "status": 200},
    ],
    "runtime": {
        "nodeName": "fixture-k3s",
        "k3sVersion": "k3s version v1.34.9+k3s1",
        "containerRuntimeVersion": "containerd://2.1.4-k3s1",
        "k3sActive": True,
    },
}
with open(output, "w", encoding="utf-8") as handle:
    json.dump(payload, handle, sort_keys=True)
PY

capacity="$work_dir/capacity.json"
cat >"$capacity" <<'JSON'
{"schemaVersion":"k3s-node-filesystem-capacity.v1","nodeName":"fixture-k3s","capacityBytes":50000000000,"usedBytes":37000000000,"availableBytes":13000000000,"usedPercent":74.0,"thresholdPercent":70,"withinLimit":false}
JSON

protected_generations="$work_dir/validation-summary.json"
jq -n \
  --arg current "$SOURCE_SHA" \
  --arg rollback "$ROLLBACK_SOURCE_SHA" '
  {
    schema:"betstan.ghcr-package-management.v1",
    terminal_status:"VALIDATED",
    mode:"validate",
    registry_provider:"ghcr",
    registry_host:"ghcr.io",
    repository:"ghcr.io/vasilyevstan/betstan-images",
    package_visibility:"public",
    repository_linked:true,
    candidate_build_run_id:"300",
    protected_sources:[$current,$rollback]
  }
' >"$protected_generations"

diagnosis="$work_dir/diagnosis.json"
invalid="$work_dir/invalid.json"
"$HELPER" diagnose \
  --runtime "$runtime" \
  --capacity "$capacity" \
  --candidate-images "$candidate_images" \
  --source-sha "$SOURCE_SHA" \
  --infrastructure-run-id 400 \
  --ghcr-build-run-id 300 \
  --workflow-run-id 500 \
  --output "$diagnosis"
jq -e \
  --arg reclaim "$RECLAIM_ID" \
  --arg foreign "$FOREIGN_ID" \
  --arg untagged "$UNTAGGED_ID" \
  --arg pinned "$PINNED_ID" \
  --arg rollback "$ROLLBACK_ID" \
  --arg stopped "$STOPPED_ID" '
    .schemaVersion == "k3s-node-disk-diagnosis.v1" and
    .terminalStatus == "DIAGNOSED" and
    .thresholdPercent == 70 and
    [.protection.criOwnedUnusedImages[].id] == [$reclaim] and
    (.protection.preservedUnknownForeignOrPinnedImageIds | index($foreign)) != null and
    (.protection.preservedUnknownForeignOrPinnedImageIds | index($untagged)) != null and
    (.protection.preservedUnknownForeignOrPinnedImageIds | index($pinned)) != null and
    (.protection.protectedImageIds | index($rollback)) != null and
    (.protection.protectedImageIds | index($stopped)) != null and
    .protection.imageSizeEstimatesAreNonAdditive == true and
    .protection.rollbackProtectionProven == false and
    .protection.criReclaimRequiresBoundProtectedGenerations == true and
    .protection.futureCandidateHeadroomProven == false
  ' "$diagnosis" >/dev/null ||
  fail "diagnosis did not classify exact image ownership and protection"
"$HELPER" validate-diagnosis \
  --diagnosis "$diagnosis" \
  --source-sha "$SOURCE_SHA" \
  --infrastructure-run-id 400 \
  --ghcr-build-run-id 300 \
  --workflow-run-id 500
for mismatch in \
  "--source-sha 2222222222222222222222222222222222222222" \
  "--infrastructure-run-id 401" \
  "--ghcr-build-run-id 301" \
  "--workflow-run-id 501"; do
  if "$HELPER" validate-diagnosis --diagnosis "$diagnosis" $mismatch \
      >/dev/null 2>&1; then
    fail "diagnosis accepted stale or wrong bound identity: $mismatch"
  fi
done
jq '.unexpected = true' "$diagnosis" >"$invalid"
if "$HELPER" validate-diagnosis --diagnosis "$invalid" >/dev/null 2>&1; then
  fail "diagnosis accepted an unexpected schema field"
fi
jq '.terminalStatus = "DIAGNOSED-TAMPERED"' "$diagnosis" >"$invalid"
if "$HELPER" validate-diagnosis --diagnosis "$invalid" >/dev/null 2>&1; then
  fail "diagnosis accepted a checksum mismatch"
fi

jq '.mongo.mount.source = .root.mount.source' "$runtime" >"$invalid"
if "$HELPER" diagnose --runtime "$invalid" --capacity "$capacity" \
    --candidate-images "$candidate_images" --source-sha "$SOURCE_SHA" \
    --infrastructure-run-id 400 --ghcr-build-run-id 300 \
    --workflow-run-id 500 --output "$work_dir/invalid-diagnosis.json" \
    >/dev/null 2>&1; then
  fail "diagnosis accepted Mongo on the root filesystem"
fi
jq 'del(.consumers[0])' "$runtime" >"$invalid"
if "$HELPER" diagnose --runtime "$invalid" --capacity "$capacity" \
    --candidate-images "$candidate_images" --source-sha "$SOURCE_SHA" \
    --infrastructure-run-id 400 --ghcr-build-run-id 300 \
    --workflow-run-id 500 --output "$work_dir/invalid-diagnosis.json" \
    >/dev/null 2>&1; then
  fail "diagnosis accepted missing fixed-path consumer evidence"
fi
jq '.images[0].repoDigests = [42]' "$runtime" >"$invalid"
if "$HELPER" diagnose --runtime "$invalid" --capacity "$capacity" \
    --candidate-images "$candidate_images" --source-sha "$SOURCE_SHA" \
    --infrastructure-run-id 400 --ghcr-build-run-id 300 \
    --workflow-run-id 500 --output "$work_dir/invalid-diagnosis.json" \
    >/dev/null 2>&1; then
  fail "diagnosis accepted malformed CRI references"
fi

selected="$(jq -cn --arg id "$RECLAIM_ID" '[$id]')"
"$HELPER" plan-reclaim \
  --diagnosis "$diagnosis" \
  --runtime "$runtime" \
  --capacity "$capacity" \
  --category cri-owned-unused-images \
  --image-ids "$selected" \
  --protected-generations "$protected_generations" \
  --output "$work_dir/cri-plan.json"
if "$HELPER" plan-reclaim --diagnosis "$diagnosis" --runtime "$runtime" \
    --capacity "$capacity" --category cri-owned-unused-images \
    --image-ids "$selected" --output "$work_dir/no-rollback-proof.json" \
    >/dev/null 2>&1; then
  fail "CRI reclaim did not fail closed without durable rollback evidence"
fi
runtime_without_history="$work_dir/runtime-without-history.json"
jq --arg rollback "$ROLLBACK_ID" '
  .kubernetesImageReferences |= map(select(contains($rollback) | not))
' "$runtime" >"$runtime_without_history"
diagnosis_without_history="$work_dir/diagnosis-without-history.json"
"$HELPER" diagnose \
  --runtime "$runtime_without_history" \
  --capacity "$capacity" \
  --candidate-images "$candidate_images" \
  --source-sha "$SOURCE_SHA" \
  --infrastructure-run-id 400 \
  --ghcr-build-run-id 300 \
  --workflow-run-id 502 \
  --output "$diagnosis_without_history"
rollback_selected="$(jq -cn --arg id "$ROLLBACK_ID" '[$id]')"
if "$HELPER" plan-reclaim --diagnosis "$diagnosis_without_history" \
    --runtime "$runtime_without_history" --capacity "$capacity" \
    --category cri-owned-unused-images --image-ids "$rollback_selected" \
    --protected-generations "$protected_generations" \
    --output "$work_dir/rollback-plan.json" >/dev/null 2>&1; then
  fail "durably protected rollback generation was reclaimable after history GC"
fi
if "$HELPER" plan-reclaim --diagnosis "$diagnosis" --runtime "$runtime" \
    --capacity "$capacity" --category cri-owned-unused-images \
    --image-ids "$(jq -cn --arg id "$FOREIGN_ID" '[$id]')" \
    --protected-generations "$protected_generations" \
    --output "$work_dir/bad-plan.json" >/dev/null 2>&1; then
  fail "foreign CRI image was accepted for reclaim"
fi
if "$HELPER" plan-reclaim --diagnosis "$diagnosis" --runtime "$runtime" \
    --capacity "$capacity" --category injected-command --image-ids '[]' \
    --output "$work_dir/bad-plan.json" >/dev/null 2>&1; then
  fail "injected reclaim category was accepted"
fi
jq '.kubernetesImageReferences += ["ghcr.io/example/changed@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]' \
  "$runtime" >"$invalid"
if "$HELPER" plan-reclaim --diagnosis "$diagnosis" --runtime "$invalid" \
    --capacity "$capacity" --category cri-owned-unused-images \
    --image-ids "$selected" --protected-generations "$protected_generations" \
    --output "$work_dir/bad-plan.json" >/dev/null 2>&1; then
  fail "security-relevant image-reference drift was accepted"
fi

post_cri="$work_dir/post-cri.json"
jq --arg id "$RECLAIM_ID" '
  .images |= map(select(.id != $id)) |
  .root.mount.used = 34500000000 |
  .root.mount.avail = 15500000000 |
  .root.df.usedBytes = 34500000000 |
  .root.df.availableBytes = 15500000000 |
  .root.df.usedPercent = 69 |
  .queue.backlog = 9
' "$runtime" >"$post_cri"
post_capacity="$work_dir/post-capacity.json"
cat >"$post_capacity" <<'JSON'
{"schemaVersion":"k3s-node-filesystem-capacity.v1","nodeName":"fixture-k3s","capacityBytes":50000000000,"usedBytes":34500000000,"availableBytes":15500000000,"usedPercent":69.0,"thresholdPercent":70,"withinLimit":true}
JSON
"$HELPER" finalize-reclaim \
  --diagnosis "$diagnosis" \
  --post-runtime "$post_cri" \
  --post-capacity "$post_capacity" \
  --category cri-owned-unused-images \
  --image-ids "$selected" \
  --mutation-succeeded true \
  --output "$work_dir/cri-result.json"
jq -e '
  .terminalStatus == "RECLAIMED" and
  .thresholdPercent == 70 and
  .actualMeasuredRootBytesFreed == 2500000000 and
  .imageSizeEstimatesWereNonAdditive == true and
  .futureCandidateHeadroomProven == false
' "$work_dir/cri-result.json" >/dev/null ||
  fail "successful exact CRI reclaim result is invalid"

if "$HELPER" finalize-reclaim --diagnosis "$diagnosis" \
    --post-runtime "$post_cri" --post-capacity "$post_capacity" \
    --category cri-owned-unused-images --image-ids "$selected" \
    --mutation-succeeded false --output "$work_dir/partial-result.json" \
    >/dev/null 2>&1; then
  fail "partial CRI mutation masqueraded as success"
fi
jq -e '.terminalStatus == "INCOMPLETE"' "$work_dir/partial-result.json" >/dev/null ||
  fail "partial CRI mutation did not record an incomplete result"

"$HELPER" plan-reclaim \
  --diagnosis "$diagnosis" \
  --runtime "$runtime" \
  --capacity "$capacity" \
  --category apt-package-cache \
  --image-ids '[]' \
  --output "$work_dir/apt-plan.json"
post_apt="$work_dir/post-apt.json"
jq '
  (.consumers[] | select(.category == "apt-package-cache").bytes) = 100000000 |
  .root.mount.used = 34500000000 |
  .root.mount.avail = 15500000000 |
  .root.df.usedBytes = 34500000000 |
  .root.df.availableBytes = 15500000000 |
  .root.df.usedPercent = 69
' "$runtime" >"$post_apt"
"$HELPER" finalize-reclaim \
  --diagnosis "$diagnosis" \
  --post-runtime "$post_apt" \
  --post-capacity "$post_capacity" \
  --category apt-package-cache \
  --image-ids '[]' \
  --mutation-succeeded true \
  --output "$work_dir/apt-result.json"

over_capacity="$work_dir/over-capacity.json"
cat >"$over_capacity" <<'JSON'
{"schemaVersion":"k3s-node-filesystem-capacity.v1","nodeName":"fixture-k3s","capacityBytes":50000000000,"usedBytes":35500000000,"availableBytes":14500000000,"usedPercent":71.0,"thresholdPercent":70,"withinLimit":false}
JSON
if "$HELPER" finalize-reclaim --diagnosis "$diagnosis" \
    --post-runtime "$post_apt" --post-capacity "$over_capacity" \
    --category apt-package-cache --image-ids '[]' \
    --mutation-succeeded true --output "$work_dir/over-result.json" \
    >/dev/null 2>&1; then
  fail "reclaim above the unchanged 70 percent limit was accepted"
fi

grep -Fxq '    apt-get clean' "$REMOTE" ||
  fail "remote reclaim does not use native apt-get clean"
grep -Fq '      cri rmi "$image_id"' "$REMOTE" ||
  fail "remote reclaim does not remove exact CRI image IDs"
if grep -Eq 'crictl[[:space:]]+rmi[[:space:]]+--prune|docker[[:space:]].*prune|rm[[:space:]]+-rf' "$REMOTE"; then
  fail "remote reclaim contains a forbidden global or direct-filesystem prune"
fi

stub_bin="$work_dir/bin"
mkdir -p "$stub_bin"
cat >"$stub_bin/kubectl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "get nodes -o json" ]]; then
  printf '{"items":[{"metadata":{"name":"fixture-k3s"}}]}\n'
elif [[ "$*" == "get --raw /api/v1/nodes/fixture-k3s/proxy/stats/summary" ]]; then
  cat "${STUB_CAPACITY_SUMMARY:?}"
else
  echo "unexpected kubectl invocation: $*" >&2
  exit 1
fi
SH
chmod +x "$stub_bin/kubectl"
cat >"$work_dir/summary-before.json" <<'JSON'
{"node":{"fs":{"capacityBytes":50000000000,"usedBytes":37000000000,"availableBytes":13000000000}}}
JSON
cat >"$work_dir/summary-after.json" <<'JSON'
{"node":{"fs":{"capacityBytes":50000000000,"usedBytes":34500000000,"availableBytes":15500000000}}}
JSON
cp "$runtime" "$work_dir/current-runtime.json"
cp "$work_dir/summary-before.json" "$work_dir/current-summary.json"
cat >"$work_dir/remote-runner" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
action="$1"
selected="$2"
printf '%s\t%s\n' "$action" "$selected" >>"${STUB_REMOTE_LOG:?}"
case "$action" in
  snapshot)
    cat "${STUB_CURRENT_RUNTIME:?}"
    ;;
  reclaim-cri-owned-unused-images)
    cp "${STUB_POST_RUNTIME:?}" "${STUB_CURRENT_RUNTIME:?}"
    cp "${STUB_POST_SUMMARY:?}" "${STUB_CURRENT_SUMMARY:?}"
    ;;
  reclaim-apt-package-cache)
    cp "${STUB_POST_RUNTIME:?}" "${STUB_CURRENT_RUNTIME:?}"
    cp "${STUB_POST_SUMMARY:?}" "${STUB_CURRENT_SUMMARY:?}"
    ;;
  *)
    exit 1
    ;;
esac
SH
chmod +x "$work_dir/remote-runner"
touch "$work_dir/key" "$work_dir/known-hosts"
sleep 300 &
tunnel_pid=$!
cat >"$work_dir/session.env" <<EOF
target_private_key=$work_dir/key
target_known_hosts=$work_dir/known-hosts
instance_ocid=ocid1.instance.oc1..test
instance_private_ip=10.0.0.2
os_user=ubuntu
local_ssh_port=12222
ssh_tunnel_pid=$tunnel_pid
EOF
cat >"$work_dir/infrastructure.env" <<'EOF'
canonical_host=fixture.example
k3s_node_name=fixture-k3s
EOF

common_env=(
  PATH="$stub_bin:$PATH"
  STUB_CAPACITY_SUMMARY="$work_dir/current-summary.json"
  STUB_CURRENT_RUNTIME="$work_dir/current-runtime.json"
  STUB_CURRENT_SUMMARY="$work_dir/current-summary.json"
  STUB_POST_RUNTIME="$post_cri"
  STUB_POST_SUMMARY="$work_dir/summary-after.json"
  STUB_REMOTE_LOG="$work_dir/remote.log"
  K3S_DISK_REMOTE_RUNNER="$work_dir/remote-runner"
  SOURCE_SHA="$SOURCE_SHA"
  INFRASTRUCTURE_RUN_ID=400
  GHCR_BUILD_RUN_ID=300
  GHCR_PACKAGE_VALIDATION_FILE="$protected_generations"
  INFRA_PROVENANCE_FILE="$work_dir/infrastructure.env"
  OCI_K3S_NODE_NAME=fixture-k3s
  SESSION_STATE_FILE="$work_dir/session.env"
  CANDIDATE_IMAGES_FILE="$candidate_images"
  WORK_DIR="$work_dir/orchestrator-work"
  GITHUB_RUN_ATTEMPT=1
)
env "${common_env[@]}" \
  GITHUB_RUN_ID=500 \
  RECLAIM_CATEGORY=none \
  RECLAIM_IMAGE_IDS='[]' \
  OUTPUT_FILE="$work_dir/orchestrated-diagnosis.json" \
  "$ORCHESTRATOR" diagnose >/dev/null

cp "$runtime" "$work_dir/current-runtime.json"
cp "$work_dir/summary-before.json" "$work_dir/current-summary.json"
env "${common_env[@]}" \
  GITHUB_RUN_ID=501 \
  DIAGNOSIS_RUN_ID=500 \
  DIAGNOSIS_FILE="$work_dir/orchestrated-diagnosis.json" \
  RECLAIM_CATEGORY=cri-owned-unused-images \
  RECLAIM_IMAGE_IDS="$selected" \
  OUTPUT_FILE="$work_dir/orchestrated-reclaim.json" \
  "$ORCHESTRATOR" reclaim >/dev/null
[[ "$(awk '$1 == "reclaim-cri-owned-unused-images" {count++} END {print count+0}' "$work_dir/remote.log")" == "1" ]] ||
  fail "orchestrator did not issue exactly one native CRI reclaim category"
jq -e '.terminalStatus == "RECLAIMED"' "$work_dir/orchestrated-reclaim.json" >/dev/null ||
  fail "orchestrated reclaim did not produce checksummed success evidence"

cri_only_bin="$work_dir/cri-only-bin"
mkdir -p "$cri_only_bin"
ln -s "$(command -v bash)" "$cri_only_bin/bash"
ln -s "$(command -v base64)" "$cri_only_bin/base64"
ln -s "$(command -v jq)" "$cri_only_bin/jq"
cat >"$cri_only_bin/k3s" <<'SH'
#!/bin/bash
set -euo pipefail
printf '%s\n' "$*" >>"${STUB_K3S_LOG:?}"
[[ "$1" == "crictl" ]]
[[ "$2" == "--runtime-endpoint" ]]
[[ "$3" == "unix:///run/k3s/containerd/containerd.sock" ]]
[[ "$4" == "--image-endpoint" ]]
[[ "$5" == "unix:///run/k3s/containerd/containerd.sock" ]]
[[ "$6" == "rmi" ]]
[[ "$7" =~ ^sha256:[0-9a-f]{64}$ ]]
SH
chmod +x "$cri_only_bin/k3s"
PATH="$cri_only_bin" STUB_K3S_LOG="$work_dir/k3s-crictl.log" \
  "$REMOTE" reclaim-cri-owned-unused-images "$selected"
[[ ! -e "$cri_only_bin/crictl" ]] ||
  fail "CRI fixture unexpectedly provided standalone crictl"
grep -Fq \
  "crictl --runtime-endpoint unix:///run/k3s/containerd/containerd.sock --image-endpoint unix:///run/k3s/containerd/containerd.sock rmi $RECLAIM_ID" \
  "$work_dir/k3s-crictl.log" ||
  fail "remote CRI reclaim did not use bundled k3s crictl with exact endpoint and ID"

public_bin="$work_dir/public-bin"
mkdir -p "$public_bin"
ln -s "$(command -v bash)" "$public_bin/bash"
ln -s "$(command -v base64)" "$public_bin/base64"
ln -s "$(command -v jq)" "$public_bin/jq"
cat >"$public_bin/curl" <<'SH'
#!/bin/bash
set -euo pipefail
url=""
for argument in "$@"; do
  url="$argument"
done
printf '%s\n' "$url" >>"${STUB_CURL_LOG:?}"
case "$url" in
  https://fixture.example/)
    printf '<html>ok</html>\n200'
    ;;
  https://fixture.example/api/event)
    if [[ "${STUB_API_FAILURE:-0}" == "1" ]]; then
      printf '<html>spa fallback</html>\n503'
    elif [[ "${STUB_NON_ARRAY:-0}" == "1" ]]; then
      printf '{"status":"ok"}\n200'
    else
      printf '[]\n200'
    fi
    ;;
  https://fixture.example/api/backoffice)
    printf '[]\n200'
    ;;
  https://fixture.example/Event | https://fixture.example/Backoffice)
    printf '<html>spa shell</html>\n200'
    ;;
  *)
    exit 1
    ;;
esac
SH
chmod +x "$public_bin/curl"
encoded_host="$(printf fixture.example | base64 | tr -d '\n')"
encoded_node="$(printf fixture-k3s | base64 | tr -d '\n')"
if PATH="$public_bin" STUB_CURL_LOG="$work_dir/curl-failed.log" \
    STUB_API_FAILURE=1 K3S_DISK_CANONICAL_HOST_B64="$encoded_host" \
    K3S_DISK_NODE_NAME_B64="$encoded_node" \
    "$REMOTE" probe-public-read >/dev/null 2>&1; then
  fail "SPA success masked a failing backend API"
fi
if grep -Eq '/Event$|/Backoffice$' "$work_dir/curl-failed.log"; then
  fail "public read evidence probed SPA routes instead of backend APIs"
fi
if PATH="$public_bin" STUB_CURL_LOG="$work_dir/curl-non-array.log" \
    STUB_NON_ARRAY=1 K3S_DISK_CANONICAL_HOST_B64="$encoded_host" \
    K3S_DISK_NODE_NAME_B64="$encoded_node" \
    "$REMOTE" probe-public-read >/dev/null 2>&1; then
  fail "HTTP 200 non-array backend response was accepted"
fi
PATH="$public_bin" STUB_CURL_LOG="$work_dir/curl-success.log" \
  K3S_DISK_CANONICAL_HOST_B64="$encoded_host" \
  K3S_DISK_NODE_NAME_B64="$encoded_node" \
  "$REMOTE" probe-public-read |
  jq -e '
    map(.name) == ["api-backoffice","api-event","home"] and
    all(.[]; .status == 200)
  ' >/dev/null ||
  fail "canonical-host backend API array probes did not pass"

# Exercise the real SSH stdin bundle and snapshot, not the prebuilt-JSON runner.
snapshot_bin="$work_dir/snapshot-bin"
mkdir -p "$snapshot_bin"
ln -s "$public_bin/curl" "$snapshot_bin/curl"
cat >"$snapshot_bin/ssh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
remote_command=""
for argument in "$@"; do remote_command="$argument"; done
[[ "$remote_command" == "sudo K3S_DISK_SELECTED_IMAGE_IDS_B64=W10= K3S_DISK_CANONICAL_HOST_B64=$K3S_DISK_CANONICAL_HOST_B64 K3S_DISK_NODE_NAME_B64=$K3S_DISK_NODE_NAME_B64 bash -s -- snapshot" ]]
exec bash -s -- snapshot
SH
cat >"$snapshot_bin/snapshot-fixture" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
case "${0##*/}:$*" in
  "findmnt:--json --bytes --output TARGET,SOURCE,FSTYPE,SIZE,USED,AVAIL --target /")
    jq '{filesystems:[.root.mount]}' "$STUB_CURRENT_RUNTIME"
    ;;
  "findmnt:--json --bytes --output TARGET,SOURCE,FSTYPE,SIZE,USED,AVAIL --target /var/lib/betstan/mongo")
    jq '{filesystems:[.mongo.mount]}' "$STUB_CURRENT_RUNTIME"
    ;;
  "df:--block-size=1 --output=size,used,avail,pcent,target /")
    printf 'Size Used Avail Use%% Mounted\n50000000000 37000000000 13000000000 74%% /\n'
    ;;
  "du:--bytes --summarize --one-file-system "*)
    printf '0\n'
    ;;
  "k3s:crictl --runtime-endpoint unix:///run/k3s/containerd/containerd.sock --image-endpoint unix:///run/k3s/containerd/containerd.sock images -o json")
    jq '{images:[.images[] | .size=(.sizeBytes|tostring) | del(.sizeBytes)]}' "$STUB_CURRENT_RUNTIME"
    ;;
  "k3s:crictl --runtime-endpoint unix:///run/k3s/containerd/containerd.sock --image-endpoint unix:///run/k3s/containerd/containerd.sock ps -a -o json")
    jq '{containers:[.containerImageReferences[] | {imageRef,state,image:{image:.requestedImage}}]}' "$STUB_CURRENT_RUNTIME"
    ;;
  "k3s:kubectl get pods -A -o json")
    printf '%s\n' '{"items":[{"metadata":{"namespace":"betstan-oci","name":"fixture-rabbitmq","labels":{"app":"gaming-rabbitmq"}},"spec":{"containers":[{"image":"rabbitmq:3-management"}]},"status":{"phase":"Running","conditions":[{"type":"Ready","status":"True"}],"containerStatuses":[{"restartCount":0}]}}]}'
    ;;
  "k3s:kubectl get deployments,statefulsets,daemonsets,replicasets,jobs,cronjobs -A -o json")
    cat "$STUB_WORKLOADS"
    ;;
  "k3s:kubectl exec -n betstan-oci fixture-rabbitmq -- rabbitmqctl list_queues --quiet name messages_ready messages_unacknowledged consumers")
    [[ "${STUB_QUEUE_FAILURE:-0}" != "1" ]] || exit 42
    cat "$STUB_QUEUES"
    ;;
  "k3s:--version")
    printf 'k3s version v1.34.5+k3s1 (fixture)\n'
    ;;
  "k3s:kubectl get nodes -o json")
    printf '%s\n' '{"items":[{"metadata":{"name":"fixture-k3s"},"status":{"nodeInfo":{"containerRuntimeVersion":"containerd://2.1.5-k3s1"}}}]}'
    ;;
  "systemctl:is-active --quiet k3s")
    ;;
  *)
    printf 'Unexpected snapshot fixture command: %s\n' "${0##*/}:$*" >&2
    exit 1
    ;;
esac
SH
chmod +x "$snapshot_bin/ssh" "$snapshot_bin/snapshot-fixture"
for snapshot_command in findmnt df du k3s systemctl; do
  ln -s "$snapshot_bin/snapshot-fixture" "$snapshot_bin/$snapshot_command"
done
jq -n --arg image "ghcr.io/vasilyevstan/betstan-images@$CURRENT_ID" '
  {items:[{
    kind:"Deployment",
    metadata:{namespace:"betstan-oci",name:"gaming-event-depl"},
    spec:{template:{spec:{containers:[{image:$image}]}}}
  }]}
' >"$work_dir/snapshot-workloads-base.json"
cp "$work_dir/snapshot-workloads-base.json" "$work_dir/snapshot-workloads.json"
queue_header=$'name\tmessages_ready\tmessages_unacknowledged\tconsumers'
active_queues=$'event_new_event\t2\t1\t1\ngamemaster_new_event\t0\t0\t1\nbet_place_bet\t0\t0\t1'
idle_telemetry=$'telemetry:events:v1\t0\t0\t0'
snapshot_env=(
  "${common_env[@]}"
  PATH="$snapshot_bin:$stub_bin:$PATH"
  K3S_DISK_REMOTE_RUNNER=
  STUB_CURRENT_RUNTIME="$runtime"
  STUB_CAPACITY_SUMMARY="$work_dir/summary-before.json"
  STUB_WORKLOADS="$work_dir/snapshot-workloads.json"
  STUB_QUEUES="$work_dir/snapshot-queues.tsv"
  STUB_CURL_LOG="$work_dir/snapshot-curl.log"
  K3S_DISK_CANONICAL_HOST_B64="$encoded_host"
  K3S_DISK_NODE_NAME_B64="$encoded_node"
  GITHUB_RUN_ID=600
  RECLAIM_CATEGORY=none
  RECLAIM_IMAGE_IDS='[]'
)
snapshot_case() {
  local name="$1" expected="$2" evidence="$3"
  shift 3
  local output="$work_dir/snapshot-$name.json"
  local log="$work_dir/snapshot-$name.log"
  if env "${snapshot_env[@]}" "$@" \
      WORK_DIR="$work_dir/snapshot-$name-work" OUTPUT_FILE="$output" \
      "$ORCHESTRATOR" diagnose >"$log" 2>&1; then
    [[ "$expected" == "pass" ]] || fail "snapshot accepted $name"
    jq -e "$evidence" "$work_dir/snapshot-$name-work/runtime-before.json" >/dev/null ||
      fail "snapshot aggregate differs for $name"
    "$HELPER" validate-diagnosis --diagnosis "$output" \
      --source-sha "$SOURCE_SHA" --infrastructure-run-id 400 \
      --ghcr-build-run-id 300 --workflow-run-id 600 >/dev/null
  else
    if [[ "$expected" != "fail" ]]; then
      tail -n 12 "$log" >&2
      fail "snapshot rejected $name"
    fi
    grep -Fq "$evidence" "$log" || fail "snapshot failed for the wrong reason: $name"
    [[ ! -e "$output" ]] || fail "failed snapshot produced diagnosis authority: $name"
  fi
}

printf '\n%s\n%s\n\n%s\n' "$queue_header" "$active_queues" "$idle_telemetry" >"$work_dir/snapshot-queues.tsv"
snapshot_case header-and-absent-telemetry pass \
  '.queue == {queueCount:4,backlog:3,consumersHealthy:true}'
printf '%s\n' "$active_queues" >"$work_dir/snapshot-queues.tsv"
snapshot_case headerless pass '.queue == {queueCount:3,backlog:3,consumersHealthy:true}'
snapshot_case rabbitmq-command-failure fail "unable to read RabbitMQ aggregate baseline" STUB_QUEUE_FAILURE=1

snapshot_malformed_count=0
for malformed in \
  "$queue_header"$'\n'"$queue_header" \
  'name messages_ready messages_unacknowledged consumers extra' \
  'event_new_event invalid 0 1' \
  'event_new_event -1 0 1' \
  'Listing queues for vhost / ...'; do
  printf '%s\n%s\n' "$active_queues" "$malformed" >"$work_dir/snapshot-queues.tsv"
  snapshot_malformed_count=$((snapshot_malformed_count + 1))
  snapshot_case "malformed-$snapshot_malformed_count" \
    fail "RabbitMQ queue baseline is malformed"
done
printf '%s\n' "$queue_header" >"$work_dir/snapshot-queues.tsv"
snapshot_case header-only fail "RabbitMQ queue baseline is empty"
printf '\n' >"$work_dir/snapshot-queues.tsv"
snapshot_case empty fail "RabbitMQ queue baseline is empty"
printf '%s\nevent_result\t0\t0\t0\n' "$active_queues" >"$work_dir/snapshot-queues.tsv"
snapshot_case application-consumer-missing fail "queue baseline is unhealthy or malformed"
printf '%s\ntelemetry:events:v1\t1\t0\t0\n' "$active_queues" >"$work_dir/snapshot-queues.tsv"
snapshot_case absent-telemetry-backlog fail "queue baseline is unhealthy or malformed"
printf '%s\ntelemetry:events:v1\t0\t1\t0\n' "$active_queues" >"$work_dir/snapshot-queues.tsv"
snapshot_case absent-telemetry-unacknowledged fail "queue baseline is unhealthy or malformed"
printf '%s\n' "$idle_telemetry" >"$work_dir/snapshot-queues.tsv"
snapshot_case only-idle-telemetry fail "queue baseline is unhealthy or malformed"

jq '.items += [{kind:"Deployment",metadata:{namespace:"betstan-oci",name:"gaming-telemetry-depl"}}]' \
  "$work_dir/snapshot-workloads-base.json" >"$work_dir/snapshot-workloads.json"
printf '%s\n' "$active_queues" >"$work_dir/snapshot-queues.tsv"
snapshot_case deployed-telemetry-queue-missing fail "queue baseline is unhealthy or malformed"
printf '%s\n%s\n%s\n' "$queue_header" "$active_queues" "$idle_telemetry" >"$work_dir/snapshot-queues.tsv"
snapshot_case deployed-telemetry-consumer-missing fail "queue baseline is unhealthy or malformed"
printf '%s\ntelemetry:events:v1\t0\t0\t1\n' "$active_queues" >"$work_dir/snapshot-queues.tsv"
snapshot_case deployed-telemetry-healthy pass \
  '.queue == {queueCount:4,backlog:3,consumersHealthy:true}'
jq '.items += [{kind:"Deployment",metadata:{namespace:"other",name:"gaming-telemetry-depl"}}]' \
  "$work_dir/snapshot-workloads-base.json" >"$work_dir/snapshot-workloads.json"
printf '%s\n%s\n' "$active_queues" "$idle_telemetry" >"$work_dir/snapshot-queues.tsv"
snapshot_case other-namespace-telemetry pass '.queue.consumersHealthy == true'
for field in kind metadata.namespace metadata.name; do
  jq "del(.items[0].$field)" "$work_dir/snapshot-workloads-base.json" >"$work_dir/snapshot-workloads.json"
  snapshot_case "incomplete-workload-$field" fail "workload inventory is malformed"
done

python3 - "$ROOT_DIR/.github/workflows/oci-infrastructure.yml" <<'PY'
import sys

text = open(sys.argv[1], encoding="utf-8").read()
required = (
    "group: oci-control-plane",
    "name: oci-infrastructure",
    "- diagnose-disk",
    "- reclaim-disk",
    "github.run_attempt == 1",
    'OCI_K3S_RETAIN_TARGET_SSH: "true"',
    "bind-infrastructure-prerequisites-stan.sh",
    "oci-k3s-disk-diagnosis-${{ github.run_id }}-${{ github.run_attempt }}",
    "configure-k3s-access.sh cleanup",
    '[ -z "$DISK_INFRASTRUCTURE_RUN_ID" ]',
    '[ "$DISK_RECLAIM_CATEGORY" = "none" ]',
    '[ "$DISK_RECLAIM_IMAGE_IDS" = "[]" ]',
)
for literal in required:
    if literal not in text:
        raise SystemExit(f"disk workflow contract is missing: {literal}")
if text.count("name: oci-infrastructure") < 2:
    raise SystemExit("disk recovery does not reuse the protected infrastructure environment")
validation = text.split(
    "      - name: Validate bounded k3s disk request", 1
)[1].split("\n      - name:", 1)[0]
if "${{ inputs." in validation:
    raise SystemExit("bounded disk validation interpolates workflow input into shell")
if "crictl rmi --prune" in text or "prune-registry-generation.sh" in text[
    text.index("\n  k3s-disk-recovery:"):
]:
    raise SystemExit("disk recovery job invokes a global or remote-registry prune")
PY
grep -Fq -- '-o StrictHostKeyChecking=yes' "$ORCHESTRATOR" ||
  fail "disk recovery SSH does not require the attested host key"
grep -Fq -- '-o UserKnownHostsFile="$target_known_hosts"' "$ORCHESTRATOR" ||
  fail "disk recovery SSH does not use the retained attested host-key file"

echo "k3s_disk_recovery_tests=PASS"
