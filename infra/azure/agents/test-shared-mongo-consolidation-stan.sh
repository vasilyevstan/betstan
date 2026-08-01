#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OPERATOR="$ROOT_DIR/infra/azure/agents/consolidate-production-mongo-stan.sh"
LOCK_SCRIPT="$ROOT_DIR/infra/azure/agents/shared-mongo-operation-lock-stan.sh"
ROLLBACK_READINESS="$ROOT_DIR/infra/azure/agents/rollback-readiness-stan.sh"
SIGNATURE_SCRIPT="$ROOT_DIR/infra/azure/agents/mongo-database-signature-stan.js"
MIGRATION_AGENT="$ROOT_DIR/.github/agents/betstan-mongo-migration.agent.md"
MONGO_TEST_IMAGE="${MONGO_TEST_IMAGE:-mongo:7}"
SKIP_DOCKER="${SKIP_DOCKER:-0}"

fail() {
  echo "shared_mongo_consolidation_tests=FAIL reason=$*" >&2
  exit 1
}

tmp_dir="$(mktemp -d)"
cleanup_tmp() {
  rm -rf -- "$tmp_dir"
}
trap cleanup_tmp EXIT

active_mongo_count="$(
  find "$ROOT_DIR/infra/k8s" -maxdepth 1 -type f -name '*-mongo-depl.yaml' |
    wc -l | tr -d ' '
)"
[[ "$active_mongo_count" == "1" ]] ||
  fail "expected one active Mongo manifest"
[[ -f "$ROOT_DIR/infra/k8s/auth-mongo-depl.yaml" ]] ||
  fail "auth Mongo manifest is missing"
grep -Fq 'name: gaming-shared-mongo-srv' "$ROOT_DIR/infra/k8s/auth-mongo-depl.yaml" ||
  fail "shared Mongo Service is missing"

legacy_mongo_count="$(
  find "$ROOT_DIR/infra/k8s/legacy-mongo" -maxdepth 1 -type f -name '*-mongo-depl.yaml' |
    wc -l | tr -d ' '
)"
[[ "$legacy_mongo_count" == "7" ]] ||
  fail "expected seven rollback-only Mongo manifests"

grep -Fq 'shared-mongo-topology-guard-stan.sh' \
  "$ROOT_DIR/.github/workflows/production-deploy.yml" ||
  fail "production deploy does not enforce the shared topology"
grep -Fq 'shared-mongo-operation-lock-stan.sh acquire' \
  "$ROOT_DIR/.github/workflows/production-deploy.yml" ||
  fail "production deploy does not acquire the database operation lock"
grep -Fq 'shared-mongo-operation-lock-stan.sh release' \
  "$ROOT_DIR/.github/workflows/production-deploy.yml" ||
  fail "production deploy does not release the database operation lock"
grep -Fq '"$lock_script" acquire' "$ROOT_DIR/infra/azure/agents/deploy-stan.sh" ||
  fail "direct deploy does not acquire the database operation lock"
[[ -x "$LOCK_SCRIPT" ]] ||
  fail "shared database operation lock helper is missing"
[[ -f "$MIGRATION_AGENT" ]] ||
  fail "shared database migration agent is missing"
for required_reference in \
  'disable-model-invocation: true' \
  'consolidate-production-mongo-stan.sh' \
  'shared-mongo-operation-lock-stan.sh' \
  'shared-mongo-topology-guard-stan.sh' \
  'rollback-readiness-stan.sh' \
  'READY_FOR_CLEANUP' \
  'MIGRATION_COMPLETE'; do
  grep -Fq "$required_reference" "$MIGRATION_AGENT" ||
    fail "migration agent is missing required reference: $required_reference"
done

retired_paths=(
  "$ROOT_DIR/.github/workflows/deploy-stage-shared-db.yml"
  "$ROOT_DIR/infra/azure/agents/deploy-stage-shared-db-stan.sh"
  "$ROOT_DIR/infra/azure/agents/revert-stage-legacy-mongo-stan.sh"
  "$ROOT_DIR/infra/azure/agents/stage-soak-validation-stan.sh"
  "$ROOT_DIR/infra/k8s-stage/shared-mongo.yaml"
)
for retired_path in "${retired_paths[@]}"; do
  [[ ! -e "$retired_path" ]] ||
    fail "retired shared-Mongo path still exists: $retired_path"
done

expected_mappings=(
  "auth:gaming_auth"
  "bet:gaming_bet"
  "backoffice:gaming_backoffice"
  "event:gaming_event"
  "gamemaster:gaming_gamemaster"
  "moderation:gaming_moderation"
  "resulting:gaming_resulting"
  "slip:gaming_slip"
)

for mapping in "${expected_mappings[@]}"; do
  IFS=':' read -r service database <<<"$mapping"
  expected_uri="mongodb://gaming-shared-mongo-srv:27017/${database}"
  grep -Fq "value: \"$expected_uri\"" "$ROOT_DIR/infra/k8s/${service}-depl.yaml" ||
    fail "active URI mapping is wrong for $service"
done

plan_output="$(bash "$OPERATOR" plan)"
[[ "$(grep -c '^migrate=' <<<"$plan_output")" == "7" ]] ||
  fail "operator plan must migrate seven databases"
[[ "$(grep -c '^retire_statefulset=' <<<"$plan_output")" == "7" ]] ||
  fail "operator plan must retire seven exact database resources"
grep -Fq 'target_statefulset=gaming-auth-mongo-depl' <<<"$plan_output" ||
  fail "operator target changed"
grep -Fq 'database_count=8' <<<"$plan_output" ||
  fail "operator database count changed"
[[ "$(grep -c 'dropDatabase()' "$OPERATOR")" -eq 2 ]] ||
  fail "forward and reverse restores must explicitly drop destination databases"
grep -Fq 'gaming-mongo-migration-lock' "$OPERATOR" ||
  fail "migration operation lock is missing"
[[ "$(grep -c '^    acquire_lock$' "$OPERATOR")" -eq 3 ]] ||
  fail "migrate, cleanup, and rollback must acquire the operation lock"

mkdir -p "$tmp_dir/bin" "$tmp_dir/backups"
chmod 700 "$tmp_dir/backups"
cat >"$tmp_dir/bin/kubectl" <<'EOF'
#!/usr/bin/env bash
if [[ "$*" == *"gaming-mongo-topology"* ]]; then
  printf '%s' "${FAKE_TOPOLOGY_STATE:?}"
elif [[ "$*" == *"gaming-mongo-migration-lock"* ]]; then
  printf '%s' "${FAKE_LOCK_STATE:?}"
else
  echo "unexpected kubectl call: $*" >&2
  exit 1
fi
EOF
chmod +x "$tmp_dir/bin/kubectl"
test_sha="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
transition_output="$(
  PATH="$tmp_dir/bin:$PATH" \
    FAKE_TOPOLOGY_STATE="transition|backing-up|test-migration|$test_sha" \
    FAKE_LOCK_STATE="released" \
    TARGET_SHA="$test_sha" \
    MIGRATION_ID="test-migration" \
    MIGRATION_BACKUP_DIR="$tmp_dir/backups" \
    "$ROLLBACK_READINESS"
)"
grep -Fq 'rollback_readiness=GO mode=migration-transition phase=backing-up' \
  <<<"$transition_output" ||
  fail "migration-transition rollback readiness was not accepted"
grep -Fq 'rollback_operator=infra/azure/agents/consolidate-production-mongo-stan.sh' \
  <<<"$transition_output" ||
  fail "migration-transition rollback did not select the consolidation operator"
if PATH="$tmp_dir/bin:$PATH" \
  FAKE_TOPOLOGY_STATE="transition|backing-up|test-migration|$test_sha" \
  FAKE_LOCK_STATE="active" \
  TARGET_SHA="$test_sha" \
  MIGRATION_ID="test-migration" \
  MIGRATION_BACKUP_DIR="$tmp_dir/backups" \
  "$ROLLBACK_READINESS" >/dev/null 2>&1; then
  fail "migration-transition rollback readiness accepted an active operation lock"
fi
if PATH="$tmp_dir/bin:$PATH" \
  FAKE_TOPOLOGY_STATE="transition|validating-applications|test-migration|$test_sha" \
  FAKE_LOCK_STATE="released" \
  TARGET_SHA="$test_sha" \
  MIGRATION_ID="test-migration" \
  MIGRATION_BACKUP_DIR="$tmp_dir/backups" \
  "$ROLLBACK_READINESS" >/dev/null 2>&1; then
  fail "late migration rollback readiness accepted missing recovery artifacts"
fi

if [[ "$SKIP_DOCKER" == "1" ]]; then
  echo "shared_mongo_consolidation_tests=PASS docker=skipped"
  exit 0
fi

command -v docker >/dev/null 2>&1 || fail "docker is required for synthetic migration"

suffix="$$"
source_container="betstan-mongo-source-$suffix"
target_container="betstan-mongo-target-$suffix"

cleanup() {
  docker rm -f "$source_container" "$target_container" >/dev/null 2>&1 || true
  rm -rf -- "$tmp_dir"
}
trap cleanup EXIT

docker run -d --rm --name "$source_container" "$MONGO_TEST_IMAGE" >/dev/null
docker run -d --rm --name "$target_container" "$MONGO_TEST_IMAGE" >/dev/null

wait_for_mongo() {
  local container="$1"
  local attempt
  for attempt in $(seq 1 60); do
    if docker exec "$container" mongosh --quiet \
      --eval 'quit(db.adminCommand({ping:1}).ok === 1 ? 0 : 1)' >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  fail "Mongo did not become ready: $container"
}

container_signature() {
  local container="$1"
  local database="$2"
  {
    printf 'const DB_NAME = "%s";\n' "$database"
    cat "$SIGNATURE_SCRIPT"
  } | docker exec -i "$container" mongosh --quiet | tail -n 1
}

wait_for_mongo "$source_container"
wait_for_mongo "$target_container"

docker exec "$target_container" mongosh --quiet --eval '
  const d = db.getSiblingDB("gaming_auth");
  d.users.insertOne({_id: 1, identifierNormalized: "user@example.test"});
  d.users.createIndex(
    {identifierNormalized: 1},
    {unique: true, partialFilterExpression: {identifierNormalized: {$type: "string"}}}
  );
' >/dev/null

auth_before="$tmp_dir/gaming_auth.before.json"
auth_after="$tmp_dir/gaming_auth.after.json"
container_signature "$target_container" gaming_auth >"$auth_before"

databases=(
  gaming_bet
  gaming_backoffice
  gaming_event
  gaming_gamemaster
  gaming_moderation
  gaming_resulting
  gaming_slip
)

for database in "${databases[@]}"; do
  docker exec "$source_container" mongosh --quiet --eval "
    const d = db.getSiblingDB(\"$database\");
    d.createCollection(\"records\", {
      validator: {value: {\$type: \"string\"}},
      validationLevel: \"strict\"
    });
    d.records.insertMany([
      {_id: 1, value: \"$database-a\", enabled: true},
      {_id: 2, value: \"$database-b\", enabled: false}
    ]);
    d.records.createIndex({value: 1}, {name: \"value_unique\", unique: true});
    d.createView(\"enabled_records\", \"records\", [{\$match: {enabled: true}}]);
  " >/dev/null

  source_signature="$tmp_dir/$database.source.json"
  target_signature="$tmp_dir/$database.target.json"
  archive="$tmp_dir/$database.archive.gz"

  container_signature "$source_container" "$database" >"$source_signature"
  docker exec "$source_container" mongodump --quiet --archive --gzip --db "$database" >"$archive"
  [[ -s "$archive" ]] || fail "synthetic archive is empty for $database"
  docker exec "$target_container" mongosh --quiet --eval "
    db.getSiblingDB(\"$database\").stale_records.insertOne({_id: \"stale\"});
    db.getSiblingDB(\"$database\").dropDatabase();
  " >/dev/null
  docker exec -i "$target_container" mongorestore --quiet --archive --gzip \
    --drop --nsInclude="${database}.*" <"$archive"
  container_signature "$target_container" "$database" >"$target_signature"
  cmp -s "$source_signature" "$target_signature" ||
    fail "synthetic parity mismatch for $database"
done

container_signature "$target_container" gaming_auth >"$auth_after"
cmp -s "$auth_before" "$auth_after" ||
  fail "gaming_auth changed while restoring non-auth databases"

docker exec "$target_container" mongosh --quiet --eval '
  const d = db.getSiblingDB("gaming_auth");
  try {
    d.users.insertOne({_id: 2, identifierNormalized: "user@example.test"});
    quit(1);
  } catch (error) {
    if (error.code !== 11000) {
      throw error;
    }
  }
' >/dev/null

echo "shared_mongo_consolidation_tests=PASS docker=executed databases=8"
