#!/usr/bin/env bash
set -euo pipefail

# Purpose: diagnose event-service vs gamemaster stream mismatches for a specific event.
# Usage examples:
#   EVENT_NAME='North Nikkoside - Hermanview' ./infra/azure/agents/mismatch-diagnostic-stan.sh
#   EVENT_ID=6172b204-e662-4d8e-b0a1-93df1782b844 ./infra/azure/agents/mismatch-diagnostic-stan.sh
#   EVENT_NAME='North Nikkoside - Hermanview' SINCE=8h ./infra/azure/agents/mismatch-diagnostic-stan.sh

NAMESPACE="${NAMESPACE:-default}"
MONGO_POD="${MONGO_POD:-}"
TOPOLOGY_CONFIGMAP="${TOPOLOGY_CONFIGMAP:-gaming-mongo-topology}"
SINCE="${SINCE:-8h}"
EVENT_NAME="${EVENT_NAME:-}"
EVENT_ID="${EVENT_ID:-}"
EVENT_DB="${EVENT_DB:-gaming_event}"
GAMEMASTER_DB="${GAMEMASTER_DB:-gaming_gamemaster}"

log() {
  printf '%s\n' "$*"
}

section() {
  printf '\n=== %s ===\n' "$1"
}

require_binary() {
  if ! command -v "$1" >/dev/null 2>&1; then
    log "missing_binary=$1"
    exit 1
  fi
}

event_filter_js() {
  if [[ -n "$EVENT_ID" ]]; then
    printf '{eventId:"%s"}' "$EVENT_ID"
  else
    printf '{name:"%s"}' "$EVENT_NAME"
  fi
}

event_projection_js() {
  printf '{eventId:1,name:1,time:1,status:1,visibility:1,_id:0}'
}

mongo_pod_for_db() {
  local db_name="$1"
  if [[ -n "$MONGO_POD" ]]; then
    echo "$MONGO_POD"
    return
  fi

  local topology_mode
  topology_mode="$(
    kubectl get configmap "$TOPOLOGY_CONFIGMAP" -n "$NAMESPACE" \
      -o jsonpath='{.data.mode}' 2>/dev/null || true
  )"
  if [[ "$topology_mode" == "shared" || "$db_name" == "gaming_auth" ]]; then
    echo "gaming-auth-mongo-depl-0"
    return
  fi
  if [[ -z "$topology_mode" || "$topology_mode" == "legacy" ]]; then
    local service="${db_name#gaming_}"
    service="${service//_/-}"
    echo "gaming-${service}-mongo-depl-0"
    return
  fi

  echo "ERROR: unsupported Mongo topology mode: $topology_mode" >&2
  return 1
}

mongosh_find_one() {
  local db_name="$1"
  local collection="$2"
  local filter="$3"
  local projection="$4"
  local pod_name
  pod_name="$(mongo_pod_for_db "$db_name")"
  kubectl exec -n "$NAMESPACE" "$pod_name" -- \
    mongosh --quiet --eval "db.getSiblingDB(\"$db_name\").$collection.findOne($filter, $projection)"
}

mongosh_find_many() {
  local db_name="$1"
  local collection="$2"
  local filter="$3"
  local projection="$4"
  local pod_name
  pod_name="$(mongo_pod_for_db "$db_name")"
  kubectl exec -n "$NAMESPACE" "$pod_name" -- \
    mongosh --quiet --eval "db.getSiblingDB(\"$db_name\").$collection.find($filter, $projection).sort({time:1}).toArray()"
}

print_service_logs() {
  local app="$1"
  local pattern="$2"
  section "logs app=$app"
  kubectl logs -n "$NAMESPACE" -l "app=gaming-$app" --since="$SINCE" 2>/dev/null \
    | grep -F "$pattern" || true
}

print_pod_state() {
  local app="$1"
  section "pod state app=$app"
  kubectl get pod -n "$NAMESPACE" -l "app=gaming-$app" -o wide
  kubectl get pod -n "$NAMESPACE" -l "app=gaming-$app" -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.startTime}{"\t"}{range .status.containerStatuses[*]}{.restartCount}{" "}{end}{"\n"}{end}' \
    | sed '/^$/d'
}

section "inputs"
log "namespace=$NAMESPACE"
log "since=$SINCE"
log "event_db=$EVENT_DB"
log "gamemaster_db=$GAMEMASTER_DB"
if [[ -n "$EVENT_ID" ]]; then
  log "event_id=$EVENT_ID"
fi
if [[ -n "$EVENT_NAME" ]]; then
  log "event_name=$EVENT_NAME"
fi

if [[ -z "$EVENT_ID" && -z "$EVENT_NAME" ]]; then
  log "error=provide EVENT_ID or EVENT_NAME"
  exit 1
fi

require_binary kubectl

section "source code map"
log "event service event intake: event/src/route/EventOddsClicked.ts -> publishes event:odds:selected"
log "event service event creation: backoffice/src/route/NewEvent.ts -> publishes event:new"
log "gamemaster intake: gamemaster/src/event/listener/NewEventListener.ts -> consumes event:new into gaming_gamemaster DB"
log "gamemaster result loop: gamemaster/src/worker/GamemasterWorker.ts -> polls gaming_gamemaster.events where status=NO_RESULT and time < now()"

section "event service db lookup"
EVENT_FILTER="$(event_filter_js)"
EVENT_PROJECTION="$(event_projection_js)"
EVENT_RECORD="$(mongosh_find_one "$EVENT_DB" events "$EVENT_FILTER" "$EVENT_PROJECTION")"
log "$EVENT_RECORD"

section "gamemaster db lookup"
GAMEMASTER_RECORD="$(mongosh_find_one "$GAMEMASTER_DB" events "$EVENT_FILTER" "$EVENT_PROJECTION")"
log "$GAMEMASTER_RECORD"

section "gamemaster pending events"
mongosh_find_many "$GAMEMASTER_DB" events '{status:"NO_RESULT"}' "$EVENT_PROJECTION"

section "service logs"
print_service_logs event "North Nikkoside - Hermanview"
print_service_logs gamemaster "North Nikkoside - Hermanview"
print_service_logs event "event:new"
print_service_logs gamemaster "event:new"

section "runtime state"
print_pod_state event
print_pod_state gamemaster

section "diagnosis"
if [[ "$EVENT_RECORD" == "null" || -z "$EVENT_RECORD" ]]; then
  log "event_service_record=missing"
else
  log "event_service_record=present"
fi

if [[ "$GAMEMASTER_RECORD" == "null" || -z "$GAMEMASTER_RECORD" ]]; then
  log "gamemaster_record=missing"
else
  log "gamemaster_record=present"
fi

log "interpretation=if event exists only in gaming_event and not in gaming_gamemaster, gamemaster never ingested it (likely downtime during event creation)"
