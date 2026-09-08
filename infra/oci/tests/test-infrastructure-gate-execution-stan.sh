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

run_case() {
  local name="$1" expected="$2"
  shift 2
  local status=0 output=""
  : >"$WORKDIR/validator-calls.txt"
  output="$(
    env "$@" \
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
INPUTS='{"approved_sha":"'"$SHA"'","runtime_mode":"k3s","phase":"finalize"}'

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
