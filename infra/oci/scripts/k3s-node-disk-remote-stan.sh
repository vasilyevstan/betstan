#!/usr/bin/env bash
set -euo pipefail

ACTION="${1:-snapshot}"
SELECTED_IMAGE_IDS="${2:-[]}"
if [[ -n "${K3S_DISK_SELECTED_IMAGE_IDS_B64:-}" ]]; then
  SELECTED_IMAGE_IDS="$(
    printf '%s' "$K3S_DISK_SELECTED_IMAGE_IDS_B64" | base64 --decode
  )" || {
    echo "k3s_disk_remote=${ACTION:-missing} status=FAIL reason=invalid selected image encoding" >&2
    exit 1
  }
fi
APPLICATION_REPOSITORY="ghcr.io/vasilyevstan/betstan-images"
MONGO_PATH="/var/lib/betstan/mongo"
K3S_RUNTIME_ENDPOINT="unix:///run/k3s/containerd/containerd.sock"

fail() {
  echo "k3s_disk_remote=${ACTION:-missing} status=FAIL reason=$*" >&2
  exit 1
}

for command_name in jq base64; do
  command -v "$command_name" >/dev/null 2>&1 ||
    fail "required command is unavailable: $command_name"
done
case "$ACTION" in
  snapshot)
    required_commands=(findmnt df du k3s sha256sum curl systemctl)
    ;;
  probe-public-read)
    required_commands=(curl)
    ;;
  reclaim-apt-package-cache)
    required_commands=(apt-get)
    ;;
  reclaim-cri-owned-unused-images)
    required_commands=(k3s)
    ;;
  *)
    fail "unsupported action"
    ;;
esac
for command_name in "${required_commands[@]}"; do
  command -v "$command_name" >/dev/null 2>&1 ||
    fail "required command is unavailable: $command_name"
done

decode_required() {
  local encoded="$1"
  local label="$2"
  local value
  [[ -n "$encoded" ]] || fail "$label is unavailable"
  value="$(printf '%s' "$encoded" | base64 --decode)" ||
    fail "$label encoding is invalid"
  [[ -n "$value" ]] || fail "$label is empty"
  printf '%s' "$value"
}

CANONICAL_HOST=""
EXPECTED_NODE_NAME=""
if [[ "$ACTION" == "snapshot" || "$ACTION" == "probe-public-read" ]]; then
  CANONICAL_HOST="$(
    decode_required "${K3S_DISK_CANONICAL_HOST_B64:-}" "canonical host"
  )"
  EXPECTED_NODE_NAME="$(
    decode_required "${K3S_DISK_NODE_NAME_B64:-}" "k3s node name"
  )"
  [[ "$CANONICAL_HOST" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ &&
     "$CANONICAL_HOST" == *.* ]] ||
    fail "canonical host is invalid"
  [[ "$EXPECTED_NODE_NAME" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]] ||
    fail "k3s node name is invalid"
fi

cri() {
  k3s crictl \
    --runtime-endpoint "$K3S_RUNTIME_ENDPOINT" \
    --image-endpoint "$K3S_RUNTIME_ENDPOINT" \
    "$@"
}

public_read_checks() {
  local public_read name path response code body
  public_read="$(
    for entry in home:/ api-event:/api/event api-backoffice:/api/backoffice; do
      name="${entry%%:*}"
      path="${entry#*:}"
      response="$(
        curl --silent --show-error --location --max-time 15 \
          --write-out $'\n%{http_code}' \
          "https://${CANONICAL_HOST}${path}"
      )" || fail "public read check failed for $name"
      code="${response##*$'\n'}"
      body="${response%$'\n'*}"
      [[ "$code" == "200" ]] ||
        fail "public read check was not HTTP 200 for $name"
      if [[ "$name" != "home" ]]; then
        jq -e 'type == "array"' <<<"$body" >/dev/null ||
          fail "public API response is not an array for $name"
      fi
      jq -cn --arg name "$name" --argjson status "$code" \
        '{name:$name,status:$status}'
    done | jq -cs 'sort_by(.name)'
  )"
  printf '%s\n' "$public_read"
}

mount_json() {
  local target="$1"
  findmnt --json --bytes --output TARGET,SOURCE,FSTYPE,SIZE,USED,AVAIL \
    --target "$target" |
    jq -ce --arg target "$target" '
      .filesystems as $items |
      if ($items | length) == 1 and $items[0].target == $target then
        $items[0] | {
          target:.target,
          source:.source,
          fstype:.fstype,
          size:(.size | tonumber),
          used:(.used | tonumber),
          avail:(.avail | tonumber)
        }
      else
        error("mount identity is missing or ambiguous")
      end
    '
}

fixed_path_bytes() {
  local category="$1"
  local path="$2"
  local bytes=0
  if [[ -e "$path" ]]; then
    bytes="$(du --bytes --summarize --one-file-system "$path" | awk '{print $1}')"
  fi
  [[ "$bytes" =~ ^[0-9]+$ ]] || fail "invalid aggregate size for $category"
  jq -cn --arg category "$category" --arg path "$path" --argjson bytes "$bytes" \
    '{category:$category,path:$path,bytes:$bytes}'
}

snapshot() {
  local root_mount mongo_mount root_df images containers pods workloads queue
  local rabbit_pod queue_output queue_count queue_backlog consumers_healthy
  local k3s_version container_runtime node_name public_read consumers

  root_mount="$(mount_json /)" || fail "root mount is invalid"
  mongo_mount="$(mount_json "$MONGO_PATH")" || fail "Mongo mount is invalid"
  [[ "$(jq -r '.source' <<<"$root_mount")" != \
     "$(jq -r '.source' <<<"$mongo_mount")" ]] ||
    fail "Mongo data is not on a separate mounted filesystem"

  root_df="$(
    df --block-size=1 --output=size,used,avail,pcent,target / |
      awk 'NR == 2 {
        gsub(/%/, "", $4)
        printf "{\"capacityBytes\":%s,\"usedBytes\":%s,\"availableBytes\":%s,\"usedPercent\":%s}\n",
          $1, $2, $3, $4
      }'
  )"
  jq -e '
    .capacityBytes > 0 and .usedBytes >= 0 and .availableBytes >= 0 and
    .usedBytes <= .capacityBytes and
    .usedPercent >= 0 and .usedPercent <= 100
  ' <<<"$root_df" >/dev/null || fail "root df output is invalid"

  images="$(cri images -o json)" || fail "unable to read CRI images"
  containers="$(cri ps -a -o json)" || fail "unable to read CRI containers"
  jq -e '.images | type == "array"' <<<"$images" >/dev/null ||
    fail "CRI image inventory is malformed"
  jq -e '.containers | type == "array"' <<<"$containers" >/dev/null ||
    fail "CRI container inventory is malformed"

  pods="$(k3s kubectl get pods -A -o json)" ||
    fail "unable to read pod state"
  workloads="$(
    k3s kubectl get deployments,statefulsets,daemonsets,replicasets,jobs,cronjobs \
      -A -o json
  )" || fail "unable to read workload image references"
  jq -e '.items | type == "array"' <<<"$pods" >/dev/null ||
    fail "pod inventory is malformed"
  jq -e '.items | type == "array"' <<<"$workloads" >/dev/null ||
    fail "workload inventory is malformed"

  rabbit_pod="$(
    jq -r '
      [.items[]? | select(
        .metadata.namespace == "betstan-oci" and
        .metadata.labels.app == "gaming-rabbitmq" and
        .status.phase == "Running"
      )] |
      if length == 1 then .[0].metadata.name else empty end
    ' <<<"$pods"
  )"
  [[ -n "$rabbit_pod" ]] || fail "RabbitMQ pod baseline is unavailable"
  queue_output="$(
    k3s kubectl exec -n betstan-oci "$rabbit_pod" -- \
      rabbitmqctl list_queues --quiet \
        name messages_ready messages_unacknowledged consumers
  )" || fail "unable to read RabbitMQ aggregate baseline"
  queue_count="$(
    awk 'NF == 4 && $2 ~ /^[0-9]+$/ && $3 ~ /^[0-9]+$/ && $4 ~ /^[0-9]+$/ {
      count++
    } END {print count+0}' <<<"$queue_output"
  )"
  [[ "$queue_count" == "$(awk 'NF {count++} END {print count+0}' <<<"$queue_output")" ]] ||
    fail "RabbitMQ queue baseline is malformed"
  queue_backlog="$(awk 'NF == 4 {sum += $2 + $3} END {print sum+0}' <<<"$queue_output")"
  consumers_healthy=true
  awk 'NF == 4 && $4 < 1 {bad=1} END {exit bad}' <<<"$queue_output" ||
    consumers_healthy=false

  k3s_version="$(k3s --version | head -n1)"
  [[ "$k3s_version" =~ ^k3s\ version\ v[0-9] ]] ||
    fail "k3s runtime version is malformed"
  container_runtime="$(
    jq -er '
      .items | if length == 1
      then .[0].status.nodeInfo.containerRuntimeVersion
      else error("unexpected node count")
      end
    ' <<<"$(k3s kubectl get nodes -o json)"
  )" || fail "container runtime identity is unavailable"
  node_name="$(
    jq -er '
      .items | if length == 1
      then .[0].metadata.name
      else error("unexpected node count")
      end
    ' <<<"$(k3s kubectl get nodes -o json)"
  )" || fail "node identity is unavailable"
  [[ "$node_name" == "$EXPECTED_NODE_NAME" ]] ||
    fail "unexpected k3s node identity"
  systemctl is-active --quiet k3s || fail "k3s service is not active"

  public_read="$(public_read_checks)"

  consumers="$(
    for spec in \
      k3s-containerd:/var/lib/rancher/k3s/agent/containerd \
      k3s-server:/var/lib/rancher/k3s/server \
      kubelet:/var/lib/kubelet \
      apt-package-cache:/var/cache/apt \
      system-logs:/var/log \
      mongo-data:/var/lib/betstan/mongo; do
      fixed_path_bytes "${spec%%:*}" "${spec#*:}"
    done | jq -cs 'sort_by(.category)'
  )"

  jq -cn \
    --arg schema "k3s-node-disk-runtime.v1" \
    --arg repository "$APPLICATION_REPOSITORY" \
    --arg k3s_version "$k3s_version" \
    --arg container_runtime "$container_runtime" \
    --arg node_name "$node_name" \
    --argjson root_mount "$root_mount" \
    --argjson mongo_mount "$mongo_mount" \
    --argjson root_df "$root_df" \
    --argjson consumers "$consumers" \
    --argjson images "$images" \
    --argjson containers "$containers" \
    --argjson pods "$pods" \
    --argjson workloads "$workloads" \
    --argjson queue_count "$queue_count" \
    --argjson queue_backlog "$queue_backlog" \
    --argjson consumers_healthy "$consumers_healthy" \
    --argjson public_read "$public_read" '
      {
        schemaVersion:$schema,
        applicationRepository:$repository,
        root:{mount:$root_mount,df:$root_df},
        mongo:{mount:$mongo_mount,separateFromRoot:true},
        consumers:$consumers,
        images:[
          $images.images[] | {
            id:(.id // ""),
            repoTags:(.repoTags // []),
            repoDigests:(.repoDigests // []),
            sizeBytes:((.size // 0) | tonumber),
            pinned:(.pinned // false)
          }
        ],
        containerImageReferences:[
          $containers.containers[]? |
          {
            imageRef:(.imageRef // ""),
            requestedImage:(.image.image // ""),
            state:(.state // "")
          }
        ],
        kubernetesImageReferences:(
          [
            $pods.items[]? |
            (.spec.initContainers[]?.image,
             .spec.containers[]?.image,
             .spec.ephemeralContainers[]?.image,
             .status.initContainerStatuses[]?.imageID,
             .status.containerStatuses[]?.imageID,
             .status.ephemeralContainerStatuses[]?.imageID)
          ] +
          [
            $workloads.items[]? |
            (
              .spec.template.spec.initContainers[]?.image,
              .spec.template.spec.containers[]?.image,
              .spec.jobTemplate.spec.template.spec.initContainers[]?.image,
              .spec.jobTemplate.spec.template.spec.containers[]?.image
            )
          ] | map(select(type == "string" and length > 0)) | unique | sort
        ),
        workload:{
          podCount:($pods.items | length),
          unhealthyPodCount:([
            $pods.items[]? | select(
              .metadata.deletionTimestamp != null or
              (
                .status.phase != "Succeeded" and
                (
                  .status.phase != "Running" or
                  (any(.status.conditions[]?;
                    .type == "Ready" and .status == "True") | not)
                )
              )
            )
          ] | length),
          restartCount:([
            $pods.items[]? |
            (
              .status.initContainerStatuses[]?.restartCount,
              .status.containerStatuses[]?.restartCount,
              .status.ephemeralContainerStatuses[]?.restartCount
            )
          ] | add // 0)
        },
        queue:{
          queueCount:$queue_count,
          backlog:$queue_backlog,
          consumersHealthy:$consumers_healthy
        },
        publicRead:$public_read,
        runtime:{
          nodeName:$node_name,
          k3sVersion:$k3s_version,
          containerRuntimeVersion:$container_runtime,
          k3sActive:true
        }
      }
    '
}

case "$ACTION" in
  snapshot)
    snapshot
    ;;
  probe-public-read)
    public_read_checks
    ;;
  reclaim-apt-package-cache)
    [[ "$SELECTED_IMAGE_IDS" == "[]" ]] ||
      fail "image IDs are not valid for apt package-cache reclaim"
    apt-get clean
    ;;
  reclaim-cri-owned-unused-images)
    jq -e '
      type == "array" and length > 0 and
      all(.[]; type == "string" and test("^sha256:[0-9a-f]{64}$")) and
      (unique | length) == length
    ' <<<"$SELECTED_IMAGE_IDS" >/dev/null ||
      fail "selected CRI image IDs are invalid"
    while IFS= read -r image_id; do
      cri rmi "$image_id"
    done < <(jq -r '.[]' <<<"$SELECTED_IMAGE_IDS")
    ;;
  *)
    fail "unsupported action"
    ;;
esac
