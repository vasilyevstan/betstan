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
  mongo-storage)
    required_commands=(k3s timeout)
    [[ "$SELECTED_IMAGE_IDS" == "[]" && "$#" == "1" ]] ||
      fail "Mongo storage inspection does not accept arguments"
    ;;
  baseline-proof)
    required_commands=(k3s findmnt readlink lsblk)
    [[ "$SELECTED_IMAGE_IDS" == "[]" && "$#" == "1" ]] ||
      fail "baseline inspection does not accept arguments"
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
if [[ "$ACTION" == "snapshot" || "$ACTION" == "probe-public-read" ||
      "$ACTION" == "baseline-proof" ]]; then
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

mongo_storage() {
  local pod
  pod="$(
    k3s kubectl --request-timeout=5s get pods -n betstan-oci \
      -l app=gaming-auth-mongo -o json |
      jq -er '
        [.items[] | select(
          .metadata.deletionTimestamp == null and
          .status.phase == "Running" and
          any(.status.conditions[]?; .type == "Ready" and .status == "True")
        )] |
        if length == 1 then .[0].metadata.name else error("Mongo pod unavailable") end
      '
  )" || fail "ready Mongo pod is missing or ambiguous"
  timeout --signal=KILL 35s \
    k3s kubectl --request-timeout=35s exec -i -n betstan-oci "$pod" -- \
      mongosh --norc --quiet \
      'mongodb://127.0.0.1:27017/admin?serverSelectionTimeoutMS=2000&connectTimeoutMS=2000&socketTimeoutMS=2000' \
      --file /dev/stdin <<'MONGO_STORAGE_JS'
(async function () {
  const limits = { databases: 32, collections: 256, commandMilliseconds: 2000,
    collectionMilliseconds: 30000, transportSeconds: 35, outputBytes: 262144 };
  const started = Date.now();
  const result = {
    schemaVersion: "mongo-collection-storage-raw.v1",
    expectedServerVersion: "8.2.12", observedServerVersion: null,
    startedAt: new Date(started).toISOString(), finishedAt: null,
    limits, status: "UNAVAILABLE", discoveryComplete: false, truncated: false,
    errors: [], databases: [], collections: []
  };
  const safeErrors = new Set(["DATABASE_LIMIT", "COLLECTION_LIMIT", "TIME_LIMIT",
    "OUTPUT_LIMIT", "UNAUTHORIZED", "NAMESPACE_MISSING", "COMMAND_FAILED",
    "INVALID_METADATA", "INVALID_STATISTICS", "VERSION_MISMATCH",
    "TIMESERIES_LOGICAL_UNAVAILABLE", "CURSOR_CLEANUP_FAILED"]);
  function problem(code) {
    const error = new Error(code);
    error.safeCode = code;
    return error;
  }
  function errorCode(error) {
    if (safeErrors.has(error.safeCode)) return error.safeCode;
    if (error.code === 13) return "UNAUTHORIZED";
    if (error.code === 26) return "NAMESPACE_MISSING";
    if (error.code === 50 || error.code === 262) return "TIME_LIMIT";
    return "COMMAND_FAILED";
  }
  function recordError(code) {
    if (!result.errors.includes(code)) result.errors.push(code);
    if (["DATABASE_LIMIT", "COLLECTION_LIMIT", "TIME_LIMIT", "OUTPUT_LIMIT"].includes(code))
      result.truncated = true;
  }
  async function command(database, value, cleanup = false) {
    const remaining = limits.collectionMilliseconds - (Date.now() - started);
    if (!cleanup && remaining <= 0) throw problem("TIME_LIMIT");
    const timeout = cleanup ? limits.commandMilliseconds :
      Math.min(limits.commandMilliseconds, remaining);
    // Non-awaitData getMore rejects maxTimeMS; the fixed connection also bounds socket waits.
    const response = await database.runCommand(value.getMore === undefined ?
      { ...value, maxTimeMS: timeout } : value);
    if (response.ok !== 1) throw response;
    if (!cleanup && Date.now() - started >= limits.collectionMilliseconds)
      throw problem("TIME_LIMIT");
    return response;
  }
  function metric(value) {
    const number = Number(value);
    if (value === null || value === undefined || typeof value === "boolean" ||
        typeof value === "string" || !Number.isSafeInteger(number) || number < 0)
      throw problem("INVALID_STATISTICS");
    return number;
  }
  async function measure(database, databaseName, entry) {
    if (!entry || typeof entry.name !== "string" || !entry.name ||
        !["collection", "view", "timeseries"].includes(entry.type))
      throw problem("INVALID_METADATA");
    const bucket = entry.name.startsWith("system.buckets.");
    const row = {
      database: databaseName, collection: entry.name,
      kind: bucket ? "timeseries-buckets" : entry.type,
      status: "UNAVAILABLE", observedAt: null,
      documentCount: null, countUnit: null, logicalBytes: null,
      allocatedDataBytes: null, allocatedIndexBytes: null, errorCode: null
    };
    result.collections.push(row);
    if (entry.type === "view") {
      row.status = "NON_STORAGE";
      return;
    }
    if (entry.type === "timeseries") {
      row.errorCode = "TIMESERIES_LOGICAL_UNAVAILABLE";
      recordError(row.errorCode);
      return;
    }
    try {
      const stats = await command(database, { collStats: entry.name, scale: 1 });
      const exists = await command(database, {
        listCollections: 1, filter: { name: entry.name }, nameOnly: true,
        cursor: { batchSize: 1 }
      });
      if (stats.ns !== databaseName + "." + entry.name ||
          exists.cursor.firstBatch.length !== 1 ||
          exists.cursor.firstBatch[0].type !== entry.type)
        throw problem("NAMESPACE_MISSING");
      const values = [bucket ? stats.timeseries?.bucketCount : stats.count,
        stats.size, stats.storageSize, stats.totalIndexSize].map(metric);
      [row.documentCount, row.logicalBytes, row.allocatedDataBytes, row.allocatedIndexBytes] = values;
      row.countUnit = bucket ? "buckets" : "documents";
      row.observedAt = new Date().toISOString();
      row.status = "MEASURED";
    } catch (error) {
      row.errorCode = errorCode(error);
      recordError(row.errorCode);
      if (row.errorCode === "TIME_LIMIT") throw problem("TIME_LIMIT");
    }
  }
  try {
    const admin = db.getSiblingDB("admin");
    const info = await command(admin, { buildInfo: 1 });
    if (typeof info.version === "string" && /^\d+\.\d+\.\d+$/.test(info.version))
      result.observedServerVersion = info.version;
    if (result.observedServerVersion !== result.expectedServerVersion)
      throw problem("VERSION_MISMATCH");
    const inventory = await command(admin, {
      listDatabases: 1, nameOnly: true, authorizedDatabases: false
    });
    if (!Array.isArray(inventory.databases) ||
        inventory.databases.some(item => typeof item.name !== "string" || !item.name))
      throw problem("INVALID_METADATA");
    const names = inventory.databases.map(item => item.name).sort();
    if (new Set(names).size !== names.length) throw problem("INVALID_METADATA");
    if (names.length > limits.databases) recordError("DATABASE_LIMIT");
    for (const name of names.slice(0, limits.databases)) {
      const database = db.getSiblingDB(name);
      const databaseRow = { name, complete: false };
      result.databases.push(databaseRow);
      let cursorId = null;
      try {
        let response = await command(database, {
          listCollections: 1, nameOnly: true, authorizedCollections: false,
          cursor: { batchSize: 32 }
        });
        let batchKey = "firstBatch";
        while (true) {
          if (!response.cursor || !Array.isArray(response.cursor[batchKey]))
            throw problem("INVALID_METADATA");
          cursorId = response.cursor.id;
          for (const entry of response.cursor[batchKey]) {
            if (result.collections.length >= limits.collections)
              throw problem("COLLECTION_LIMIT");
            await measure(database, name, entry);
          }
          if (String(cursorId) === "0") {
            databaseRow.complete = true;
            break;
          }
          response = await command(database, {
            getMore: cursorId, collection: "$cmd.listCollections", batchSize: 32
          });
          batchKey = "nextBatch";
        }
      } catch (error) {
        const code = errorCode(error);
        recordError(code);
        if (code === "TIME_LIMIT" || code === "COLLECTION_LIMIT") break;
      } finally {
        if (cursorId !== null && String(cursorId) !== "0") {
          try {
            await command(database, {
              killCursors: "$cmd.listCollections", cursors: [cursorId]
            }, true);
          } catch (error) {
            recordError("CURSOR_CLEANUP_FAILED");
          }
        }
      }
    }
    result.discoveryComplete = !result.truncated &&
      result.databases.length === names.length && result.databases.every(item => item.complete);
  } catch (error) {
    recordError(errorCode(error));
  }
  result.finishedAt = new Date().toISOString();
  result.status = result.discoveryComplete && result.errors.length === 0 ? "COMPLETE" :
    result.databases.length > 0 ? "PARTIAL" : "UNAVAILABLE";
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > limits.outputBytes) {
    result.databases = [];
    result.collections = [];
    result.discoveryComplete = false;
    result.status = "UNAVAILABLE";
    recordError("OUTPUT_LIMIT");
  }
  print(JSON.stringify(result));
})();
MONGO_STORAGE_JS
}

baseline_proof() {
  local requested resolved mounted mongo block root_number nodes deployments pods pvc pv
  requested="$(
    decode_required "${K3S_DISK_MONGO_DEVICE_B64:-}" "bound Mongo device"
  )"
  [[ "$requested" =~ ^/dev/([A-Za-z0-9_-]+/)?[A-Za-z0-9_-]+$ ]] ||
    fail "bound Mongo device is invalid"
  resolved="$(readlink -e -- "$requested")" ||
    fail "bound Mongo device cannot be resolved"
  mongo="$(mount_json "$MONGO_PATH")" || fail "Mongo mount is unavailable"
  mounted="$(readlink -e -- "$(jq -er '.source' <<<"$mongo")")" ||
    fail "Mongo mounted device cannot be resolved"
  [[ "$resolved" == "$mounted" ]] ||
    fail "Mongo mount differs from the bound volume attachment"
  block="$(
    lsblk --json --bytes --output PATH,TYPE,SIZE,MAJ:MIN "$resolved" |
      jq -ce --arg path "$resolved" '
        .blockdevices |
        if length == 1 and .[0].path == $path and .[0].type == "disk" and
           ((.[0].children // []) | length) == 0
        then .[0] | {path,type,size,deviceNumber:."maj:min"}
        else error("bound Mongo block device is ambiguous") end
      '
  )" || fail "bound Mongo block device is unavailable or partitioned"
  root_number="$(findmnt --noheadings --output MAJ:MIN --target / | tr -d '[:space:]')" ||
    fail "root filesystem device is unavailable"
  nodes="$(
    k3s kubectl --request-timeout=10s get nodes -o json |
      jq -ce '[.items[] | {
        name:.metadata.name,uid:.metadata.uid,
        ready:any(.status.conditions[]?; .type == "Ready" and .status == "True")
      }]'
  )" || fail "baseline node identity is unavailable"
  deployments="$(
    k3s kubectl --request-timeout=10s get deployments -n betstan-oci -o json |
      jq -ce '[.items[] | {
        name:.metadata.name,uid:.metadata.uid,
        deleting:(.metadata.deletionTimestamp != null),
        generation:.metadata.generation,observedGeneration:.status.observedGeneration,
        replicas:.spec.replicas,readyReplicas:(.status.readyReplicas // 0),
        availableReplicas:(.status.availableReplicas // 0),
        updatedReplicas:(.status.updatedReplicas // 0),
        containers:[.spec.template.spec.containers[] | {name,image}]
      }]'
  )" || fail "baseline application deployments are unavailable"
  pods="$(
    k3s kubectl --request-timeout=10s get pods -n betstan-oci -o json |
      jq -ce '[.items[] | {
        uid:.metadata.uid,app:.metadata.labels.app,nodeName:.spec.nodeName,
        deleting:(.metadata.deletionTimestamp != null),phase:.status.phase,
        ready:any(.status.conditions[]?; .type == "Ready" and .status == "True"),
        containers:[.spec.containers[] | {
          name,image,
          defaultCommand:(((.command // []) | length) == 0 and
                          ((.args // []) | length) == 0),
          mounts:[.volumeMounts[]? | {
            name,mountPath,readOnly:(.readOnly // false),
            subPath:(.subPath // ""),subPathExpr:(.subPathExpr // "")
          }]
        }],
        volumes:[.spec.volumes[]? | {
          name,claimName:.persistentVolumeClaim.claimName
        }],
        statuses:[.status.containerStatuses[]? | {name,imageID,ready}]
      }]'
  )" || fail "baseline application pods are unavailable"
  pvc="$(
    k3s kubectl --request-timeout=10s get pvc gaming-auth-mongo-data -n betstan-oci -o json |
      jq -ce '{name:.metadata.name,uid:.metadata.uid,phase:.status.phase,
               volumeName:.spec.volumeName}'
  )" || fail "baseline Mongo claim is unavailable"
  pv="$(
    k3s kubectl --request-timeout=10s get pv gaming-auth-mongo-data -o json |
      jq -ce '{name:.metadata.name,phase:.status.phase,localPath:.spec.local.path,
               claim:.spec.claimRef}'
  )" || fail "baseline Mongo volume is unavailable"
  builtin printf '%s\n' "$mongo" "$block" "$nodes" "$deployments" "$pods" "$pvc" "$pv" |
    jq -cs --arg requested "$requested" --arg resolved "$resolved" \
      --arg mounted "$mounted" --arg root_number "$root_number" \
      --arg expected_node "$EXPECTED_NODE_NAME" '
        if length != 7 then error("baseline proof requires seven JSON values") else . end |
        {
          schemaVersion:"k3s-baseline-node.v1",requestedDevice:$requested,
          resolvedDevice:$resolved,mountedDevice:$mounted,rootDeviceNumber:$root_number,
          expectedNode:$expected_node,mongoMount:.[0],blockDevice:.[1],
          nodes:.[2],deployments:.[3],pods:.[4],claim:.[5],volume:.[6]
        }
      '
}

snapshot() {
  local root_mount mongo_mount root_df images containers pods workloads queue
  local rabbit_pod queue_output queue_count queue_backlog consumers_healthy
  local k3s_version container_runtime node_name public_read consumers telemetry_absent

  declare -F oci_rabbitmq_queue_rows >/dev/null ||
    fail "shared RabbitMQ queue parser is unavailable"

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
  jq -e '
    .items | type == "array" and all(.[];
      (.kind | IN("Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job", "CronJob")) and
      (.metadata.namespace | type == "string" and length > 0) and
      (.metadata.name | type == "string" and length > 0)
    )
  ' <<<"$workloads" >/dev/null ||
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
  queue_output="$(oci_rabbitmq_queue_rows <<<"$queue_output")" ||
    fail "RabbitMQ queue baseline is malformed"
  [[ -n "$queue_output" ]] || fail "RabbitMQ queue baseline is empty"
  queue_count="$(awk 'NF {count++} END {print count+0}' <<<"$queue_output")"
  queue_backlog="$(awk 'NF == 4 {sum += $2 + $3} END {print sum+0}' <<<"$queue_output")"
  telemetry_absent="$(
    jq -r 'any(.items[];
      .kind == "Deployment" and
      .metadata.namespace == "betstan-oci" and
      .metadata.name == "gaming-telemetry-depl"
    ) | not' <<<"$workloads"
  )"
  consumers_healthy=true
  # Rollback can retain ready queue messages without a Telemetry Deployment.
  awk -v telemetry_absent="$telemetry_absent" '
    $1 == "telemetry:events:v1" && $4 > 0 { telemetry_healthy=1 }
    $1 == "telemetry:events:v1" && telemetry_absent == "true" &&
      $3 == 0 && $4 == 0 { next }
    { active++; if ($4 < 1) bad=1 }
    END { exit bad || active < 1 || (telemetry_absent != "true" && !telemetry_healthy) }
  ' <<<"$queue_output" ||
    consumers_healthy=false

  if [[ "$consumers_healthy" == "false" ]]; then
    {
      jq -r '"queue_root capacity_bytes=\(.capacityBytes) used_bytes=\(.usedBytes) available_bytes=\(.availableBytes) used_percent=\(.usedPercent)"' \
        <<<"$root_df"
      awk -v telemetry_absent="$telemetry_absent" \
        -v queue_count="$queue_count" -v backlog="$queue_backlog" '
        BEGIN {
          # Only static source-declared labels are public; pod-scoped names are not.
          known["backoffice_new_event"]=1
          known["backoffice_result_set"]=1
          known["bet_moderation_result"]=1
          known["bet_place_bet"]=1
          known["bet_settle_slip"]=1
          known["bet_settle_slip_row"]=1
          known["event_event_visibility"]=1
          known["event_live_projection"]=1
          known["event_live_update"]=1
          known["event_new_event"]=1
          known["event_result"]=1
          known["gamemaster_new_event"]=1
          known["gamemaster_result_set"]=1
          known["moderation_event_result"]=1
          known["moderation_live_event_update"]=1
          known["moderation_place_bet"]=1
          known["resulting_live_event_update"]=1
          known["resulting_moderation_result"]=1
          known["resulting_place_bet"]=1
          known["resulting_result"]=1
          known["slip_moderation_result"]=1
          known["slip_odds_clicked"]=1
          known["telemetry:events:v1"]=1
          printf "queue_baseline=UNHEALTHY telemetry_deployment=%s queue_count=%s backlog=%s\n",
            (telemetry_absent == "true" ? "absent" : "present"), queue_count, backlog
        }
        $1 == "telemetry:events:v1" { telemetry_seen=1 }
        $4 > 0 { positive++ }
        $4 == 0 {
          if (($1 in known) && shown < 24) {
            printf "queue_zero_consumers name=%s messages_ready=%.0f messages_unacknowledged=%.0f consumers=0\n",
              $1, $2, $3
            shown++
          } else {
            other++
            other_ready += $2
            other_unacknowledged += $3
          }
        }
        END {
          if (telemetry_absent != "true" && !telemetry_seen)
            print "queue_telemetry row=missing"
          printf "queue_consumers positive_queues=%.0f other_zero_consumer_queues=%.0f messages_ready=%.0f messages_unacknowledged=%.0f consumers=0\n",
            positive, other, other_ready, other_unacknowledged
        }
      ' <<<"$queue_output"
    } >&2
  fi

  k3s_version="$(k3s --version | awk 'NR == 1 { print }')"
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

  # Native inventories can exceed Linux's per-argument limit; keep JSON on stdin.
  builtin printf '%s\n' \
    "$root_mount" "$mongo_mount" "$root_df" "$consumers" \
    "$images" "$containers" "$pods" "$workloads" \
    "$queue_count" "$queue_backlog" "$consumers_healthy" "$public_read" |
  jq -cs \
    --arg schema "k3s-node-disk-runtime.v1" \
    --arg repository "$APPLICATION_REPOSITORY" \
    --arg k3s_version "$k3s_version" \
    --arg container_runtime "$container_runtime" \
    --arg node_name "$node_name" '
      if length != 12 then error("snapshot requires exactly 12 JSON values") else . end |
      . as [
        $root_mount, $mongo_mount, $root_df, $consumers,
        $images, $containers, $pods, $workloads,
        $queue_count, $queue_backlog, $consumers_healthy, $public_read
      ] |
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
  baseline-proof)
    baseline_proof
    ;;
  mongo-storage)
    mongo_storage
    ;;
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
