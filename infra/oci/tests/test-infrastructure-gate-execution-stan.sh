#!/usr/bin/env bash
set -euo pipefail

# Execute the real oci-infrastructure prerequisite gate body under `set -u`
# with stubbed gh/validator/environment. A previous revision passed every static
# check while referencing an undefined `$dispatch_inputs`, so the gate must be
# run, not merely grepped.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
GATE="$ROOT_DIR/infra/oci/scripts/bind-infrastructure-prerequisites-stan.sh"
WORKFLOW="$ROOT_DIR/.github/workflows/oci-infrastructure.yml"
WORKDIR="$ROOT_DIR/infra/oci/tests/.test-workdirs/gate-execution"
PASS=0
FAIL=0

rm -rf "$WORKDIR"
mkdir -p "$WORKDIR/bin"
trap 'rm -rf "$WORKDIR"' EXIT

# The workflow must call the extracted gate rather than inlining a copy that
# could drift away from the executable, tested body.
grep -Fq 'run: ./infra/oci/scripts/bind-infrastructure-prerequisites-stan.sh' \
  "$WORKFLOW" || {
  echo "FAIL: workflow does not invoke the extracted prerequisite gate"
  exit 1
}
# The gate reads the real input map, which only exists if the job exports it.
grep -Fq 'DISPATCH_INPUTS: ${{ toJSON(inputs) }}' "$WORKFLOW" || {
  echo "FAIL: workflow does not export the dispatch input map"
  exit 1
}

cat >"$WORKDIR/bin/validator" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$VALIDATOR_CALLS"
[ "${VALIDATOR_RESULT:-0}" = "0" ] || exit "$VALIDATOR_RESULT"
STUB
chmod 755 "$WORKDIR/bin/validator"

cat >"$WORKDIR/bin/git" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1" != "-C" ]] || shift 2
case "$1 $2" in
  "fetch --quiet") exit 0 ;;
  "rev-parse HEAD") printf '%s\n' "$FIXTURE_HEAD_SHA" ;;
  "rev-parse origin/master") printf '%s\n' "$FIXTURE_MASTER_SHA" ;;
  "merge-base --is-ancestor")
    [[ "$4" == "$FIXTURE_CONTROL_SHA" && "$FIXTURE_ANCESTOR" == "true" ]]
    ;;
  *) echo "unexpected fixture Git call" >&2; exit 1 ;;
esac
STUB
chmod 755 "$WORKDIR/bin/git"

run_case() {
  local name="$1" expected="$2"
  shift 2
  local status=0 output=""
  : >"$WORKDIR/validator-calls.txt"
  output="$(
    env PATH="$WORKDIR/bin:$PATH" \
      CONTROL_SHA="$SHA" GITHUB_SHA="$SHA" \
      GITHUB_REF_NAME=master GITHUB_RUN_ATTEMPT=1 \
      FIXTURE_CONTROL_SHA="$SHA" FIXTURE_HEAD_SHA="$SHA" \
      FIXTURE_MASTER_SHA="$SHA" FIXTURE_ANCESTOR=true \
      "$@" \
      VALIDATOR_CALLS="$WORKDIR/validator-calls.txt" \
      BINDING_VALIDATOR="$WORKDIR/bin/validator" \
      BINDING_MANIFEST="$ROOT_DIR/infra/oci/policy/upstream-run-bindings.json" \
      bash -u "$GATE" 2>&1
  )" || status=$?
  if [ "$expected" = "accept" ] && [ "$status" -eq 0 ]; then
    PASS=$((PASS + 1))
    echo "PASS $name"
  elif [ "$expected" = "reject" ] && [ "$status" -ne 0 ]; then
    PASS=$((PASS + 1))
    echo "PASS $name (rejected)"
  else
    FAIL=$((FAIL + 1))
    echo "FAIL $name (status=$status expected=$expected) $output"
  fi
}

SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
INPUTS='{"approved_sha":"'"$SHA"'","runtime_mode":"k3s","phase":"finalize","infrastructure_run_id":"","diagnosis_run_id":"","reclaim_category":"none","reclaim_image_ids":"[]"}'

# Accept: a complete, consistent k3s finalize binding.
run_case "k3s finalize accepts a complete binding" accept \
  BOUND_RUNTIME_MODE=k3s OCI_RUNTIME_MODE=k3s PHASE=finalize \
  SOURCE_SHA="$SHA" REPOSITORY=vasilyevstan/betstan \
  DISPATCH_INPUTS="$INPUTS" CAPACITY_ACQUISITION_RUN_ID=34122018082

# The historical defect: an undefined variable under `set -u`.
if ! grep -q -- '--dispatch-inputs' "$WORKDIR/validator-calls.txt"; then
  FAIL=$((FAIL + 1))
  echo "FAIL gate did not forward the dispatch input map to the validator"
else
  PASS=$((PASS + 1))
  echo "PASS gate forwards the real dispatch input map"
fi

run_case "k3s finalize rejects missing capacity" reject \
  BOUND_RUNTIME_MODE=k3s OCI_RUNTIME_MODE=k3s PHASE=finalize \
  SOURCE_SHA="$SHA" REPOSITORY=vasilyevstan/betstan \
  DISPATCH_INPUTS="$INPUTS" CAPACITY_ACQUISITION_RUN_ID=

run_case "OKE finalize accepts no capacity" accept \
  BOUND_RUNTIME_MODE=oke OCI_RUNTIME_MODE=oke PHASE=finalize \
  SOURCE_SHA="$SHA" REPOSITORY=vasilyevstan/betstan \
  DISPATCH_INPUTS="$INPUTS" CAPACITY_ACQUISITION_RUN_ID=

run_case "OKE finalize rejects a supplied capacity run" reject \
  BOUND_RUNTIME_MODE=oke OCI_RUNTIME_MODE=oke PHASE=finalize \
  SOURCE_SHA="$SHA" REPOSITORY=vasilyevstan/betstan \
  DISPATCH_INPUTS="$INPUTS" CAPACITY_ACQUISITION_RUN_ID=34122018082

run_case "rejects authoritative runtime mode mismatch" reject \
  BOUND_RUNTIME_MODE=k3s OCI_RUNTIME_MODE=oke PHASE=finalize \
  SOURCE_SHA="$SHA" REPOSITORY=vasilyevstan/betstan \
  DISPATCH_INPUTS="$INPUTS" CAPACITY_ACQUISITION_RUN_ID=34122018082

run_case "rejects an unsupported runtime mode" reject \
  BOUND_RUNTIME_MODE=swarm OCI_RUNTIME_MODE=swarm PHASE=finalize \
  SOURCE_SHA="$SHA" REPOSITORY=vasilyevstan/betstan \
  DISPATCH_INPUTS="$INPUTS" CAPACITY_ACQUISITION_RUN_ID=

run_case "rejects an unsupported phase" reject \
  BOUND_RUNTIME_MODE=k3s OCI_RUNTIME_MODE=k3s PHASE=teardown \
  SOURCE_SHA="$SHA" REPOSITORY=vasilyevstan/betstan \
  DISPATCH_INPUTS="$INPUTS" CAPACITY_ACQUISITION_RUN_ID=

# Prepare needs no capacity in either mode, and must reject a supplied one.
run_case "prepare-k3s accepts without capacity" accept \
  BOUND_RUNTIME_MODE=k3s OCI_RUNTIME_MODE=k3s PHASE=prepare \
  SOURCE_SHA="$SHA" REPOSITORY=vasilyevstan/betstan \
  DISPATCH_INPUTS="$INPUTS" CAPACITY_ACQUISITION_RUN_ID=

run_case "prepare-oke accepts without capacity" accept \
  BOUND_RUNTIME_MODE=oke OCI_RUNTIME_MODE=oke PHASE=prepare \
  SOURCE_SHA="$SHA" REPOSITORY=vasilyevstan/betstan \
  DISPATCH_INPUTS="$INPUTS" CAPACITY_ACQUISITION_RUN_ID=

run_case "prepare rejects a supplied capacity run" reject \
  BOUND_RUNTIME_MODE=k3s OCI_RUNTIME_MODE=k3s PHASE=prepare \
  SOURCE_SHA="$SHA" REPOSITORY=vasilyevstan/betstan \
  DISPATCH_INPUTS="$INPUTS" CAPACITY_ACQUISITION_RUN_ID=34122018082

NONINERT_INPUTS="${INPUTS/\"infrastructure_run_id\":\"\"/\"infrastructure_run_id\":\"400\"}"
run_case "legacy prepare rejects a non-inert disk infrastructure run" reject \
  BOUND_RUNTIME_MODE=k3s OCI_RUNTIME_MODE=k3s PHASE=prepare \
  SOURCE_SHA="$SHA" REPOSITORY=vasilyevstan/betstan \
  DISPATCH_INPUTS="$NONINERT_INPUTS" CAPACITY_ACQUISITION_RUN_ID=
NONINERT_INPUTS="${INPUTS/\"reclaim_category\":\"none\"/\"reclaim_category\":\"apt-package-cache\"}"
run_case "legacy finalize rejects a non-inert disk category" reject \
  BOUND_RUNTIME_MODE=k3s OCI_RUNTIME_MODE=k3s PHASE=finalize \
  SOURCE_SHA="$SHA" REPOSITORY=vasilyevstan/betstan \
  DISPATCH_INPUTS="$NONINERT_INPUTS" CAPACITY_ACQUISITION_RUN_ID=34122018082

DISK_INPUTS='{"approved_sha":"'"$SHA"'","runtime_mode":"k3s","phase":"diagnose-disk","candidate_build_run_id":"","obsolete_sha":"","obsolete_build_run_id":"","obsolete_generations":"","deployed_sha":"","deployed_run_id":"","fallback_sha":"","fallback_build_run_id":"","validation_run_id":"","ghcr_package_validation_run_id":"","capacity_acquisition_run_id":"","reclaim_category":"none"}'
run_case "k3s disk diagnosis accepts current-SHA prerequisite binding" accept \
  BOUND_RUNTIME_MODE=k3s OCI_RUNTIME_MODE=k3s PHASE=diagnose-disk \
  SOURCE_SHA="$SHA" REPOSITORY=vasilyevstan/betstan \
  DISPATCH_INPUTS="$DISK_INPUTS" CAPACITY_ACQUISITION_RUN_ID=
grep -Fq -- '--operation oci-k3s-disk-diagnose' "$WORKDIR/validator-calls.txt" || {
  FAIL=$((FAIL + 1))
  echo "FAIL disk diagnosis did not select its exact protected operation"
}

DISK_INPUTS='{"approved_sha":"'"$SHA"'","runtime_mode":"k3s","phase":"reclaim-disk","candidate_build_run_id":"","obsolete_sha":"","obsolete_build_run_id":"","obsolete_generations":"","deployed_sha":"","deployed_run_id":"","fallback_sha":"","fallback_build_run_id":"","validation_run_id":"","ghcr_package_validation_run_id":"","capacity_acquisition_run_id":"","reclaim_category":"apt-package-cache"}'
run_case "k3s apt reclaim accepts one explicit category" accept \
  BOUND_RUNTIME_MODE=k3s OCI_RUNTIME_MODE=k3s PHASE=reclaim-disk \
  SOURCE_SHA="$SHA" REPOSITORY=vasilyevstan/betstan \
  DISPATCH_INPUTS="$DISK_INPUTS" CAPACITY_ACQUISITION_RUN_ID=
grep -Fq -- '--operation oci-k3s-disk-reclaim-apt' "$WORKDIR/validator-calls.txt" || {
  FAIL=$((FAIL + 1))
  echo "FAIL apt reclaim did not select its exact protected operation"
}

DISK_INPUTS='{"approved_sha":"'"$SHA"'","runtime_mode":"k3s","phase":"reclaim-disk","candidate_build_run_id":"","obsolete_sha":"","obsolete_build_run_id":"","obsolete_generations":"","deployed_sha":"","deployed_run_id":"","fallback_sha":"","fallback_build_run_id":"","validation_run_id":"","ghcr_package_validation_run_id":"777","capacity_acquisition_run_id":"","reclaim_category":"cri-owned-unused-images"}'
run_case "k3s CRI reclaim accepts one explicit category" accept \
  BOUND_RUNTIME_MODE=k3s OCI_RUNTIME_MODE=k3s PHASE=reclaim-disk \
  SOURCE_SHA="$SHA" REPOSITORY=vasilyevstan/betstan \
  DISPATCH_INPUTS="$DISK_INPUTS" CAPACITY_ACQUISITION_RUN_ID=
grep -Fq -- '--operation oci-k3s-disk-reclaim-cri' "$WORKDIR/validator-calls.txt" || {
  FAIL=$((FAIL + 1))
  echo "FAIL CRI reclaim did not select its exact protected operation"
}

DISK_INPUTS='{"approved_sha":"'"$SHA"'","runtime_mode":"k3s","phase":"reclaim-disk","candidate_build_run_id":"","obsolete_sha":"","obsolete_build_run_id":"","obsolete_generations":"","deployed_sha":"","deployed_run_id":"","fallback_sha":"","fallback_build_run_id":"","validation_run_id":"","ghcr_package_validation_run_id":"","capacity_acquisition_run_id":"","reclaim_category":"shell"}'
run_case "k3s disk reclaim rejects an injected category" reject \
  BOUND_RUNTIME_MODE=k3s OCI_RUNTIME_MODE=k3s PHASE=reclaim-disk \
  SOURCE_SHA="$SHA" REPOSITORY=vasilyevstan/betstan \
  DISPATCH_INPUTS="$DISK_INPUTS" CAPACITY_ACQUISITION_RUN_ID=

run_case "OKE disk diagnosis is rejected" reject \
  BOUND_RUNTIME_MODE=oke OCI_RUNTIME_MODE=oke PHASE=diagnose-disk \
  SOURCE_SHA="$SHA" REPOSITORY=vasilyevstan/betstan \
  DISPATCH_INPUTS="$DISK_INPUTS" CAPACITY_ACQUISITION_RUN_ID=

NONINERT_DISK_INPUTS="${DISK_INPUTS/\"reclaim_category\":\"shell\"/\"reclaim_category\":\"apt-package-cache\"}"
NONINERT_DISK_INPUTS="${NONINERT_DISK_INPUTS/\"obsolete_sha\":\"\"/\"obsolete_sha\":\"$SHA\"}"
run_case "disk recovery rejects a non-inert legacy slot" reject \
  BOUND_RUNTIME_MODE=k3s OCI_RUNTIME_MODE=k3s PHASE=reclaim-disk \
  SOURCE_SHA="$SHA" REPOSITORY=vasilyevstan/betstan \
  DISPATCH_INPUTS="$NONINERT_DISK_INPUTS" CAPACITY_ACQUISITION_RUN_ID=

validator_calls_before="$(wc -l <"$WORKDIR/validator-calls.txt")"
injection_marker="$WORKDIR/inert-slot-command-ran"
INJECTION_INPUTS="$(
  jq -cn --arg sha "$SHA" --arg payload "\$(touch $injection_marker)" '{
    approved_sha:$sha,
    runtime_mode:"k3s",
    phase:"diagnose-disk",
    candidate_build_run_id:"",
    obsolete_sha:$payload,
    obsolete_build_run_id:"",
    obsolete_generations:"",
    deployed_sha:"",
    deployed_run_id:"",
    fallback_sha:"",
    fallback_build_run_id:"",
    validation_run_id:"",
    ghcr_package_validation_run_id:"",
    capacity_acquisition_run_id:"",
    reclaim_category:"none"
  }'
)"
run_case "disk gate rejects injection-shaped inert input before validation" reject \
  BOUND_RUNTIME_MODE=k3s OCI_RUNTIME_MODE=k3s PHASE=diagnose-disk \
  SOURCE_SHA="$SHA" REPOSITORY=vasilyevstan/betstan \
  DISPATCH_INPUTS="$INJECTION_INPUTS" CAPACITY_ACQUISITION_RUN_ID=
[[ ! -e "$injection_marker" ]] || {
  FAIL=$((FAIL + 1))
  echo "FAIL injection-shaped inert input executed"
}
[[ "$(wc -l <"$WORKDIR/validator-calls.txt")" == "$validator_calls_before" ]] || {
  FAIL=$((FAIL + 1))
  echo "FAIL injection-shaped inert input reached the upstream validator"
}

# Exercise GitHub's actual input shape, not only the complete local request.
for mode in k3s oke; do
  for phase in prepare finalize; do
    capacity=""
    [[ "$mode/$phase" != k3s/finalize ]] || capacity=34122018082
    COMPACT_INPUTS="$(jq -c --arg mode "$mode" --arg phase "$phase" '
      .runtime_mode = $mode | .phase = $phase |
      with_entries(select(.value != ""))
    ' <<<"$INPUTS")"
    run_case "$mode $phase accepts omitted empty optional inputs" accept \
      BOUND_RUNTIME_MODE="$mode" OCI_RUNTIME_MODE="$mode" PHASE="$phase" \
      SOURCE_SHA="$SHA" REPOSITORY=vasilyevstan/betstan \
      DISPATCH_INPUTS="$COMPACT_INPUTS" CAPACITY_ACQUISITION_RUN_ID="$capacity"
  done
done

for category in none apt-package-cache cri-owned-unused-images; do
  phase=reclaim-disk
  [[ "$category" != none ]] || phase=diagnose-disk
  COMPACT_DISK_INPUTS="$(jq -cn --arg sha "$SHA" --arg phase "$phase" \
    --arg category "$category" '{
      approved_sha:$sha, runtime_mode:"k3s", phase:$phase,
      reclaim_category:$category
    } + (if $category == "cri-owned-unused-images" then
      {ghcr_package_validation_run_id:"777"} else {} end)')"
  run_case "$category accepts omitted empty legacy inputs" accept \
    BOUND_RUNTIME_MODE=k3s OCI_RUNTIME_MODE=k3s PHASE="$phase" \
    SOURCE_SHA="$SHA" REPOSITORY=vasilyevstan/betstan \
    DISPATCH_INPUTS="$COMPACT_DISK_INPUTS" CAPACITY_ACQUISITION_RUN_ID=
done

for value in null false '{}' '[]'; do
  MALFORMED_INPUTS="$(jq -c --argjson value "$value" \
    '.infrastructure_run_id = $value' <<<"$INPUTS")"
  run_case "legacy input rejects explicit $value instead of absence" reject \
    BOUND_RUNTIME_MODE=k3s OCI_RUNTIME_MODE=k3s PHASE=finalize \
    SOURCE_SHA="$SHA" REPOSITORY=vasilyevstan/betstan \
    DISPATCH_INPUTS="$MALFORMED_INPUTS" CAPACITY_ACQUISITION_RUN_ID=34122018082
  [[ ! -s "$WORKDIR/validator-calls.txt" ]] || {
    FAIL=$((FAIL + 1))
    echo "FAIL malformed legacy input reached the upstream validator"
  }
  MALFORMED_INPUTS="$(jq -c --argjson value "$value" \
    '.obsolete_sha = $value' <<<"$COMPACT_DISK_INPUTS")"
  run_case "disk input rejects explicit $value instead of absence" reject \
    BOUND_RUNTIME_MODE=k3s OCI_RUNTIME_MODE=k3s PHASE=reclaim-disk \
    SOURCE_SHA="$SHA" REPOSITORY=vasilyevstan/betstan \
    DISPATCH_INPUTS="$MALFORMED_INPUTS" CAPACITY_ACQUISITION_RUN_ID=
  [[ ! -s "$WORKDIR/validator-calls.txt" ]] || {
    FAIL=$((FAIL + 1))
    echo "FAIL malformed disk input reached the upstream validator"
  }
done

HISTORICAL_SHA=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
HISTORICAL_INPUTS="$(jq -cn --arg sha "$HISTORICAL_SHA" '{
  approved_sha:$sha, runtime_mode:"k3s", phase:"diagnose-disk",
  reclaim_category:"none", reclaim_image_ids:"[]"
}')"
run_case "historical diagnosis keeps current control and original subject" accept \
  BOUND_RUNTIME_MODE=k3s OCI_RUNTIME_MODE=k3s PHASE=diagnose-disk \
  SOURCE_SHA="$HISTORICAL_SHA" REPOSITORY=vasilyevstan/betstan \
  DISPATCH_INPUTS="$HISTORICAL_INPUTS" CAPACITY_ACQUISITION_RUN_ID=
grep -Fq -- "--subject-sha $HISTORICAL_SHA" "$WORKDIR/validator-calls.txt" || {
  FAIL=$((FAIL + 1))
  echo "FAIL historical prerequisites were relabeled as current control"
}
for invalid_context in \
  "FIXTURE_HEAD_SHA=$HISTORICAL_SHA" \
  "FIXTURE_MASTER_SHA=cccccccccccccccccccccccccccccccccccccccc" \
  "GITHUB_SHA=$HISTORICAL_SHA" \
  "GITHUB_REF_NAME=dev" \
  "GITHUB_RUN_ATTEMPT=2" \
  "FIXTURE_ANCESTOR=false" \
  "CONTROL_SHA="; do
  run_case "historical diagnosis rejects $invalid_context" reject \
    BOUND_RUNTIME_MODE=k3s OCI_RUNTIME_MODE=k3s PHASE=diagnose-disk \
    SOURCE_SHA="$HISTORICAL_SHA" REPOSITORY=vasilyevstan/betstan \
    DISPATCH_INPUTS="$HISTORICAL_INPUTS" CAPACITY_ACQUISITION_RUN_ID= \
    "$invalid_context"
  [[ ! -s "$WORKDIR/validator-calls.txt" ]] || {
    FAIL=$((FAIL + 1))
    echo "FAIL invalid control context reached upstream validation"
  }
done
HISTORICAL_RECLAIM_INPUTS="$(jq -c '
  .phase = "reclaim-disk" | .reclaim_category = "apt-package-cache"
' <<<"$HISTORICAL_INPUTS")"
run_case "historical subject never authorizes reclaim" reject \
  BOUND_RUNTIME_MODE=k3s OCI_RUNTIME_MODE=k3s PHASE=reclaim-disk \
  SOURCE_SHA="$HISTORICAL_SHA" REPOSITORY=vasilyevstan/betstan \
  DISPATCH_INPUTS="$HISTORICAL_RECLAIM_INPUTS" CAPACITY_ACQUISITION_RUN_ID=

mkdir -p "$WORKDIR/workflow/infra/oci/scripts"
ruby -ryaml -e '
  workflow = YAML.load_file(ARGV[0])
  step = workflow.fetch("jobs").fetch("k3s-disk-recovery").fetch("steps").find do |item|
    item["name"] == "Revalidate authority and perform bounded k3s disk operation"
  end
  File.write(ARGV[1], step.fetch("run"))
' "$WORKFLOW" "$WORKDIR/workflow/operation.sh"
cat >"$WORKDIR/workflow/infra/oci/scripts/bind-infrastructure-prerequisites-stan.sh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf 'bind\n' >>"$WORKFLOW_CALLS"
count="$(grep -c '^bind$' "$WORKFLOW_CALLS")"
[[ "$count" != "${FAIL_BINDING_AT:-0}" ]]
STUB
cat >"$WORKDIR/workflow/infra/oci/scripts/configure-k3s-access.sh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == "open" || "$1" == "cleanup" ]]
printf 'access %s\n' "$1" >>"$WORKFLOW_CALLS"
[[ "$1" != "cleanup" || "${FAIL_CLEANUP:-false}" != true ]]
STUB
cat >"$WORKDIR/workflow/infra/oci/scripts/k3s-node-disk-recovery-stan.sh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == "diagnose" ]]
[[ -z "${OCI_K3S_SSH_PRIVATE_KEY:-}" ]]
printf 'operation %s\n' "$1" >>"$WORKFLOW_CALLS"
[[ "${FAIL_OBSERVATION:-false}" != true ]]
STUB
cat >"$WORKDIR/bin/curl" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
[[ "$*" == "--fail --silent --show-error --max-time 15 https://api.ipify.org" ]]
printf '192.0.2.10\n'
STUB
chmod +x "$WORKDIR/workflow/infra/oci/scripts/"*.sh "$WORKDIR/bin/curl"
for workflow_case in success before-access before-observation after-observation observation cleanup; do
  workflow_args=(FAIL_BINDING_AT=0 FAIL_OBSERVATION=false FAIL_CLEANUP=false)
  case "$workflow_case" in
    before-access) workflow_args+=(FAIL_BINDING_AT=1) ;;
    before-observation) workflow_args+=(FAIL_BINDING_AT=2) ;;
    after-observation) workflow_args+=(FAIL_BINDING_AT=3) ;;
    observation) workflow_args+=(FAIL_OBSERVATION=true) ;;
    cleanup) workflow_args+=(FAIL_CLEANUP=true) ;;
  esac
  : >"$WORKDIR/workflow-calls.txt"
  workflow_status=0
  (
    cd "$WORKDIR/workflow"
    env PATH="$WORKDIR/bin:$PATH" WORKFLOW_CALLS="$WORKDIR/workflow-calls.txt" \
      PHASE=diagnose-disk ACCESS_WORK_DIR="$WORKDIR/access" \
      RECOVERY_WORK_DIR="$WORKDIR/recovery" OCI_K3S_SSH_PRIVATE_KEY=fixture-only \
      "${workflow_args[@]}" bash operation.sh
  ) >"$WORKDIR/workflow-output.txt" 2>&1 || workflow_status=$?
  if [[ "$workflow_case" == success && "$workflow_status" == 0 ]] ||
     [[ "$workflow_case" != success && "$workflow_status" != 0 ]]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL actual diagnostic workflow $workflow_case status=$workflow_status"
  fi
  expected_calls=$'bind\naccess open\nbind\noperation diagnose\nbind\naccess cleanup'
  case "$workflow_case" in
    before-access) expected_calls=$'bind\naccess cleanup' ;;
    before-observation) expected_calls=$'bind\naccess open\nbind\naccess cleanup' ;;
    observation) expected_calls=$'bind\naccess open\nbind\noperation diagnose\naccess cleanup' ;;
  esac
  if [[ "$(cat "$WORKDIR/workflow-calls.txt")" == "$expected_calls" ]]; then
    PASS=$((PASS + 1))
    echo "PASS actual diagnostic workflow $workflow_case preserves ordered reads and owned cleanup"
  else
    FAIL=$((FAIL + 1))
    echo "FAIL actual diagnostic workflow $workflow_case access/observation ordering"
  fi
done

# A validator rejection must fail the gate, never be swallowed.
run_case "propagates a validator rejection" reject \
  BOUND_RUNTIME_MODE=k3s OCI_RUNTIME_MODE=k3s PHASE=finalize \
  SOURCE_SHA="$SHA" REPOSITORY=vasilyevstan/betstan \
  DISPATCH_INPUTS="$INPUTS" CAPACITY_ACQUISITION_RUN_ID=34122018082 \
  VALIDATOR_RESULT=1

# Every required variable must be mandatory rather than defaulted.
for missing in BOUND_RUNTIME_MODE OCI_RUNTIME_MODE PHASE SOURCE_SHA \
  REPOSITORY DISPATCH_INPUTS; do
  args=(
    BOUND_RUNTIME_MODE=k3s OCI_RUNTIME_MODE=k3s PHASE=finalize
    SOURCE_SHA="$SHA" REPOSITORY=vasilyevstan/betstan
    DISPATCH_INPUTS="$INPUTS" CAPACITY_ACQUISITION_RUN_ID=34122018082
  )
  filtered=()
  for arg in "${args[@]}"; do
    [ "${arg%%=*}" = "$missing" ] || filtered+=("$arg")
  done
  run_case "rejects missing $missing" reject "${filtered[@]}"
done

echo "gate execution: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
