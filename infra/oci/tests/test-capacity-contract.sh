#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OCI_DIR="$ROOT_DIR/infra/oci"
TEST_DIR="$(mktemp -d "$ROOT_DIR/.oci-capacity-test.XXXXXX")"
FAKE_BIN="$TEST_DIR/bin"
FAKE_STATE="$TEST_DIR/instance-created"
FAKE_TAG_STATE="$TEST_DIR/instance-tags-updated"
FAKE_LOG="$TEST_DIR/oci.log"

cleanup() {
  rm -rf -- "$TEST_DIR"
}
trap cleanup EXIT
mkdir -p "$FAKE_BIN"
ssh-keygen -q -t ed25519 -N "" -C fixture-target -f "$TEST_DIR/target-key"
ssh-keygen -q -t ed25519 -N "" -C fixture-mismatch -f "$TEST_DIR/mismatch-key"
fixture_target_public_key="$(cat "$TEST_DIR/target-key.pub")"
fixture_mismatch_public_key="$(cat "$TEST_DIR/mismatch-key.pub")"

fail() {
  printf 'capacity contract failure: %s\n' "$*" >&2
  exit 1
}

cat > "$FAKE_BIN/oci" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail

printf '%q ' "$@" >> "$OCI_FAKE_LOG"
printf '\n' >> "$OCI_FAKE_LOG"

if [[ "${1:-}" == "--version" ]]; then
  echo "3.90.0"
  exit 0
fi

arg_value() {
  local expected="$1"
  shift
  while [[ "$#" -gt 0 ]]; do
    if [[ "$1" == "$expected" ]]; then
      printf '%s' "$2"
      return
    fi
    shift
  done
  return 1
}

case "${1:-}/${2:-}/${3:-}" in
  iam/region-subscription/list)
    echo "eu-frankfurt-1"
    ;;
  iam/availability-domain/list)
    cat <<'JSON'
{"data":[{"name":"fixture:EU-FRANKFURT-1-AD-1"},{"name":"fixture:EU-FRANKFURT-1-AD-2"}]}
JSON
    ;;
  limits/quota/list)
    cat <<'JSON'
{"data":[{"id":"ocid1.quota.oc1..fixture","name":"betstan-free-tier-hard-limit","lifecycle-state":"ACTIVE"}]}
JSON
    ;;
  limits/quota/get)
    if [[ "$OCI_FAKE_SCENARIO" == "quota-missing-ad" ]]; then
      cat <<'JSON'
{"data":{"name":"betstan-free-tier-hard-limit","lifecycle-state":"ACTIVE","statements":[
"zero compute quotas in compartment betstan-oci",
"zero compute-core quotas in compartment betstan-oci",
"zero compute-memory quotas in compartment betstan-oci",
"zero block-storage quotas in compartment betstan-oci",
"set compute-core quota standard-a1-core-regional-count to 2 in compartment betstan-oci where request.region = eu-frankfurt-1",
"set compute-memory quota standard-a1-memory-regional-count to 12 in compartment betstan-oci where request.region = eu-frankfurt-1",
"set block-storage quota volume-count to 2 in compartment betstan-oci where request.region = eu-frankfurt-1",
"set block-storage quota total-storage-gb to 100 in compartment betstan-oci where request.region = eu-frankfurt-1"
]}}
JSON
    else
      cat <<'JSON'
{"data":{"name":"betstan-free-tier-hard-limit","lifecycle-state":"ACTIVE","statements":[
"zero compute quotas in compartment betstan-oci",
"zero compute-core quotas in compartment betstan-oci",
"zero compute-memory quotas in compartment betstan-oci",
"zero block-storage quotas in compartment betstan-oci",
"set compute-core quota standard-a1-core-count to 2 in compartment betstan-oci where request.region = eu-frankfurt-1",
"set compute-memory quota standard-a1-memory-count to 12 in compartment betstan-oci where request.region = eu-frankfurt-1",
"set compute-core quota standard-a1-core-regional-count to 2 in compartment betstan-oci where request.region = eu-frankfurt-1",
"set compute-memory quota standard-a1-memory-regional-count to 12 in compartment betstan-oci where request.region = eu-frankfurt-1",
"set block-storage quota volume-count to 2 in compartment betstan-oci where request.region = eu-frankfurt-1",
"set block-storage quota total-storage-gb to 100 in compartment betstan-oci where request.region = eu-frankfurt-1"
]}}
JSON
    fi
    ;;
  limits/resource-availability/get)
    limit="$(arg_value --limit-name "$@")"
    if [[ "$OCI_FAKE_SCENARIO" == "quota-zero-ad" && "$limit" != *-regional-* ]]; then
      echo '{"data":{"available":0,"used":0}}'
    elif [[ "$limit" == *-core-* ]]; then
      echo '{"data":{"available":2,"used":0}}'
    else
      echo '{"data":{"available":12,"used":0}}'
    fi
    ;;
  compute/instance/list)
    if [[ "$OCI_FAKE_SCENARIO" == "duplicate" ]]; then
      cat <<'JSON'
{"data":[
{"id":"ocid1.instance.oc1..fixture1","display-name":"betstan-k3s-node","availability-domain":"fixture:EU-FRANKFURT-1-AD-1","image-id":"ocid1.image.oc1..fixture","shape":"VM.Standard.A1.Flex","shape-config":{"ocpus":2,"memory-in-gbs":12.0},"lifecycle-state":"RUNNING","freeform-tags":{"betstan-managed":"true","provider":"oci","betstan-managed-by":"oci-capacity-acquire","betstan-runtime":"k3s","betstan-contract":"1","expected-monthly-cost":"0","source-sha":"0000000000000000000000000000000000000000","acquisition-run-id":"stale"}},
{"id":"ocid1.instance.oc1..fixture2","display-name":"betstan-k3s-node","availability-domain":"fixture:EU-FRANKFURT-1-AD-2","image-id":"ocid1.image.oc1..fixture","shape":"VM.Standard.A1.Flex","shape-config":{"ocpus":2,"memory-in-gbs":12.0},"lifecycle-state":"RUNNING","freeform-tags":{"betstan-managed":"true","provider":"oci","betstan-managed-by":"oci-capacity-acquire","betstan-runtime":"k3s","betstan-contract":"1","expected-monthly-cost":"0","source-sha":"0000000000000000000000000000000000000000","acquisition-run-id":"stale"}}
]}
JSON
    elif [[ -f "$OCI_FAKE_STATE" ]]; then
      cat <<'JSON'
{"data":[{"id":"ocid1.instance.oc1..fixture","display-name":"betstan-k3s-node","availability-domain":"fixture:EU-FRANKFURT-1-AD-1","image-id":"ocid1.image.oc1..fixture","shape":"VM.Standard.A1.Flex","shape-config":{"ocpus":2,"memory-in-gbs":12.0},"lifecycle-state":"RUNNING","freeform-tags":{"betstan-managed":"true","provider":"oci","betstan-managed-by":"oci-capacity-acquire","betstan-runtime":"k3s","betstan-contract":"1","expected-monthly-cost":"0","source-sha":"0000000000000000000000000000000000000000","acquisition-run-id":"stale"}}]}
JSON
    else
      echo '{"data":[]}'
    fi
    ;;
  network/vcn/list)
    echo '{"data":[{"id":"ocid1.vcn.oc1..fixture","display-name":"betstan-oci-vcn","lifecycle-state":"AVAILABLE","freeform-tags":{"betstan-managed":"true","provider":"oci","expected-monthly-cost":"0"}}]}'
    ;;
  network/subnet/list)
    echo '{"data":[{"id":"ocid1.subnet.oc1..fixture","display-name":"betstan-oci-vcn-worker-public","lifecycle-state":"AVAILABLE","freeform-tags":{"betstan-managed":"true","provider":"oci","expected-monthly-cost":"0"}}]}'
    ;;
  network/subnet/get)
    echo '{"data":{"id":"ocid1.subnet.oc1..fixture","availability-domain":null,"prohibit-public-ip-on-vnic":false,"lifecycle-state":"AVAILABLE"}}'
    ;;
  network/nsg/list)
    echo '{"data":[{"id":"ocid1.networksecuritygroup.oc1..fixture","display-name":"betstan-oci-vcn-worker-nsg","lifecycle-state":"AVAILABLE","freeform-tags":{"betstan-managed":"true","provider":"oci","expected-monthly-cost":"0"}}]}'
    ;;
  compute/compute-capacity-report/create)
    ad="$(arg_value --availability-domain "$@")"
    shapes="$(arg_value --shape-availabilities "$@")"
    if [[ "$OCI_FAKE_SCENARIO" == "available" ]]; then
      status=AVAILABLE
    else
      status=OUT_OF_HOST_CAPACITY
    fi
    jq -cn --arg ad "$ad" --arg status "$status" --argjson shapes "$shapes" '{
      data: {
        "availability-domain": $ad,
        "shape-availabilities": [
          $shapes[] | {
            "availability-status": $status,
            "instance-shape": .instanceShape,
            "instance-shape-config": {
              "memory-in-gbs": .instanceShapeConfig.memoryInGBs,
              ocpus: .instanceShapeConfig.ocpus
            }
          }
        ]
      }
    }'
    ;;
  compute/instance/launch)
    if [[ "$OCI_FAKE_SCENARIO" == "stdout-fatal" ]]; then
      echo "No such option: --fixture"
      exit 2
    fi
    if [[ "$OCI_FAKE_SCENARIO" == "fatal" ]]; then
      echo "NotAuthorizedOrNotFound" >&2
      exit 1
    fi
    if [[ "$OCI_FAKE_SCENARIO" != "available" && "$OCI_FAKE_SCENARIO" != "terminated" ]]; then
      echo "OutOfHostCapacity: out of host capacity" >&2
      exit 1
    fi
    source_details="$(arg_value --source-details "$@")"
    jq -e '
      .bootVolumeSizeInGBs == 50 and
      .bootVolumeVpusPerGB == 10
    ' <<<"$source_details" >/dev/null
    touch "$OCI_FAKE_STATE"
    echo "ocid1.instance.oc1..fixture"
    ;;
  compute/instance/get)
    query="$(arg_value --query "$@")"
    if [[ "$query" == 'data."freeform-tags"' ]]; then
      [[ -f "$OCI_FAKE_TAG_STATE" ]] || exit 1
      jq -cn \
        --arg sha "$SOURCE_SHA" \
        --arg run "$OCI_CAPACITY_RUN_ID" '
          {
            "betstan-managed": "true",
            provider: "oci",
            "betstan-managed-by": "oci-capacity-acquire",
            "betstan-runtime": "k3s",
            "betstan-contract": "1",
            "expected-monthly-cost": "0",
            "source-sha": $sha,
            "acquisition-run-id": $run
          }
        '
    elif [[ "$query" == "data" ]]; then
      jq -cn --arg target_key "$OCI_FAKE_LAUNCH_SSH_PUBLIC_KEY" '{
        id: "ocid1.instance.oc1..fixture",
        "display-name": "betstan-k3s-node",
        "availability-domain": "fixture:EU-FRANKFURT-1-AD-1",
        "image-id": "ocid1.image.oc1..fixture",
        shape: "VM.Standard.A1.Flex",
        "shape-config": {ocpus: 2, "memory-in-gbs": 12.0},
        "lifecycle-state": "RUNNING",
        metadata: {ssh_authorized_keys: $target_key},
        "freeform-tags": {
          "betstan-managed": "true",
          provider: "oci",
          "betstan-managed-by": "oci-capacity-acquire",
          "betstan-runtime": "k3s",
          "betstan-contract": "1",
          "expected-monthly-cost": "0",
          "source-sha": "0000000000000000000000000000000000000000",
          "acquisition-run-id": "stale"
        }
      }'
    elif [[ "$OCI_FAKE_SCENARIO" == "terminated" ]]; then
      echo "TERMINATED"
    else
      echo "RUNNING"
    fi
    ;;
  compute/instance/update)
    tags="$(arg_value --freeform-tags "$@")"
    jq -e \
      --arg sha "$SOURCE_SHA" \
      --arg run "$OCI_CAPACITY_RUN_ID" '
        ."source-sha" == $sha and
        ."acquisition-run-id" == $run and
        ."expected-monthly-cost" == "0"
      ' <<<"$tags" >/dev/null
    touch "$OCI_FAKE_TAG_STATE"
    echo '{"data":{"lifecycle-state":"RUNNING"}}'
    ;;
  compute/boot-volume-attachment/list)
    arg_value --availability-domain "$@" >/dev/null
    if [[ -f "$OCI_FAKE_STATE" ]]; then
      echo '{"data":[{"boot-volume-id":"ocid1.bootvolume.oc1..fixture","lifecycle-state":"ATTACHED"}]}'
    else
      echo '{"data":[]}'
    fi
    ;;
  bv/boot-volume/list)
    echo '{"data":[]}'
    ;;
  bv/boot-volume/get)
    echo '{"data":{"id":"ocid1.bootvolume.oc1..fixture","size-in-gbs":50,"vpus-per-gb":10,"lifecycle-state":"AVAILABLE"}}'
    ;;
  bv/boot-volume/update)
    echo '{"data":{"id":"ocid1.bootvolume.oc1..fixture"}}'
    ;;
  compute/vnic-attachment/list)
    echo '{"data":[{"vnic-id":"ocid1.vnic.oc1..fixture","lifecycle-state":"ATTACHED"}]}'
    ;;
  network/vnic/get)
    echo '{"data":{"id":"ocid1.vnic.oc1..fixture","subnet-id":"ocid1.subnet.oc1..fixture","nsg-ids":["ocid1.networksecuritygroup.oc1..fixture"],"is-primary":true,"public-ip":"8.8.8.8","private-ip":"10.42.16.2"}}'
    ;;
  *)
    printf 'unsupported fake OCI call: %s\n' "$*" >&2
    exit 64
    ;;
esac
FAKE
chmod +x "$FAKE_BIN/oci"

export PATH="$FAKE_BIN:$PATH"
export OCI_FAKE_LOG="$FAKE_LOG"
export OCI_FAKE_STATE="$FAKE_STATE"
export OCI_FAKE_TAG_STATE="$FAKE_TAG_STATE"
export OCI_RUNTIME_MODE=k3s
export OCI_REGION=eu-frankfurt-1
export OCI_CLI_VERSION=3.90.0
export OCI_TENANCY_OCID=ocid1.tenancy.oc1..fixture
export OCI_COMPARTMENT_OCID=ocid1.compartment.oc1..fixture
export OCI_COMPARTMENT_NAME=betstan-oci
export OCI_CAPACITY_QUOTA_NAME=betstan-free-tier-hard-limit
export OCI_VCN_NAME=betstan-oci-vcn
export OCI_K3S_INSTANCE_NAME=betstan-k3s-node
export OCI_K3S_IMAGE_OCID=ocid1.image.oc1..fixture
export OCI_K3S_VERSION=v1.34.9+k3s1
export OCI_K3S_BINARY_SHA256=c782d6bb71eb2eb30f034aaddabb480294f9fdae5a7bca49ac5e3e0f66b96ea5
export OCI_K3S_SSH_PUBLIC_KEY="$fixture_target_public_key"
export OCI_FAKE_LAUNCH_SSH_PUBLIC_KEY="$fixture_target_public_key"
export OCI_NODE_SHAPE=VM.Standard.A1.Flex
export OCI_A1_OCPUS=2
export OCI_A1_MEMORY_GB=12
export OCI_A1_MEMORY_PROFILES=12
export OCI_BOOT_VOLUME_GB=50
export OCI_EXPECTED_MONTHLY_COST=0
export SOURCE_SHA=1111111111111111111111111111111111111111
export OCI_CAPACITY_RUN_ID=fixture-run
export OCI_CAPACITY_RUN_NUMBER=1

# shellcheck source=../scripts/capacity-common.sh
source "$OCI_DIR/scripts/capacity-common.sh"
target_ssh_public_key_sha256="$(
  oci_ssh_ed25519_public_key_sha256 "$OCI_K3S_SSH_PUBLIC_KEY"
)"
if (
  OCI_K3S_SSH_PUBLIC_KEY="ssh-rsa AAAAB3NzaFixtureOnlyKey fixture"
  oci_capacity_require_contract
) >/dev/null 2>&1; then
  fail "capacity acquisition accepted an RSA target SSH key"
fi
[[ "$(OCI_A1_MEMORY_PROFILES=12 oci_capacity_profiles_json)" == "[12]" ]] ||
  fail "validated memory profile changed"
if OCI_A1_MEMORY_PROFILES=12,10 oci_capacity_profiles_json >/dev/null 2>&1; then
  fail "unvalidated memory profile was accepted"
fi
jq -e '
  ."betstan-managed" == "true" and
  .provider == "oci" and
  ."betstan-managed-by" == "oci-capacity-acquire" and
  ."betstan-runtime" == "k3s" and
  ."expected-monthly-cost" == "0"
' <<<"$(oci_capacity_tags)" >/dev/null ||
  fail "capacity resources do not carry the finalization ownership tags"
if (OCI_FAKE_SCENARIO=quota-missing-ad oci_capacity_require_quota) >/dev/null 2>&1; then
  fail "quota policy without A1 availability-domain grants was accepted"
fi
if (OCI_FAKE_SCENARIO=quota-zero-ad oci_capacity_require_quota) >/dev/null 2>&1; then
  fail "zero effective A1 availability-domain quota was accepted"
fi

cloud_init="$TEST_DIR/cloud-init.yaml"
OCI_K3S_VERSION="$OCI_K3S_VERSION" \
OCI_K3S_BINARY_SHA256="$OCI_K3S_BINARY_SHA256" \
  "$OCI_DIR/scripts/bootstrap-k3s.sh" render-cloud-init > "$cloud_init"
[[ "$(wc -c < "$cloud_init")" -lt 16384 ]] ||
  fail "k3s cloud-init exceeds the OCI user-data limit"
grep -Fq '#cloud-config' "$cloud_init" ||
  fail "k3s bootstrap did not render cloud-init"
grep -Fq 'downloaded k3s binary checksum mismatch' "$OCI_DIR/scripts/bootstrap-k3s.sh" ||
  fail "k3s bootstrap does not verify the pinned binary checksum"
grep -Fq '  - servicelb' "$OCI_DIR/scripts/bootstrap-k3s.sh" ||
  fail "k3s bundled ServiceLB is not disabled"
grep -Fq '  - traefik' "$OCI_DIR/scripts/bootstrap-k3s.sh" ||
  fail "k3s bundled Traefik is not disabled"
if grep -Eq 'curl[^|]*\|[[:space:]]*(sh|bash)' "$OCI_DIR/scripts/bootstrap-k3s.sh"; then
  fail "k3s bootstrap uses an unverified curl-to-shell pipeline"
fi

OCI_FAKE_SCENARIO=no-capacity \
  OUTPUT_FILE="$TEST_DIR/report.json" \
  "$OCI_DIR/scripts/capacity-report.sh" >/dev/null
jq -e '
  (.candidates | length) == 2 and
  all(.candidates[]; .status == "OUT_OF_HOST_CAPACITY") and
  [.candidates[].availability_domain] == [
    "fixture:EU-FRANKFURT-1-AD-1",
    "fixture:EU-FRANKFURT-1-AD-2"
  ]
' "$TEST_DIR/report.json" >/dev/null ||
  fail "capacity report did not cover every fixture AD"

rm -f "$FAKE_STATE" "$FAKE_TAG_STATE" "$FAKE_LOG"
output_file="$TEST_DIR/no-capacity-output"
OCI_FAKE_SCENARIO=no-capacity \
GITHUB_OUTPUT="$output_file" \
WORK_DIR="$TEST_DIR/no-capacity-work" \
PROVENANCE_DIR="$TEST_DIR/no-capacity-provenance" \
  "$OCI_DIR/scripts/acquire-a1.sh" >/dev/null
grep -Fq 'acquisition_status=CAPACITY_UNAVAILABLE' "$output_file" ||
  fail "out-of-host-capacity was not classified as retryable"
[[ "$(grep -c 'compute instance launch' "$FAKE_LOG")" == "1" ]] ||
  fail "a no-capacity cycle must make exactly one real launch attempt"
grep -qv -- '--fault-domain' "$FAKE_LOG" ||
  fail "capacity acquisition pinned a fault domain"
grep -Fq -- '--subnet-id ocid1.subnet.oc1..fixture' "$FAKE_LOG" ||
  fail "capacity acquisition omitted the prepared worker subnet"
grep -Fq -- '--assign-public-ip true' "$FAKE_LOG" ||
  fail "capacity acquisition omitted the reviewed ephemeral public IP"
grep -Fq -- '--assign-private-dns-record true' "$FAKE_LOG" ||
  fail "capacity acquisition omitted the primary VNIC DNS record"
grep -Fq -- '--nsg-ids' "$FAKE_LOG" ||
  fail "capacity acquisition omitted the prepared worker NSG"
grep -Fq -- '--vnic-display-name betstan-k3s-primary' "$FAKE_LOG" ||
  fail "capacity acquisition omitted the reviewed primary VNIC name"
grep -Fq 'bootVolumeVpusPerGB' "$FAKE_LOG" ||
  fail "capacity acquisition omitted the Always Free Balanced boot profile"
! grep -Fq -- '--create-vnic-details' "$FAKE_LOG" ||
  fail "capacity acquisition uses the unsupported --create-vnic-details option"

rm -f "$FAKE_STATE" "$FAKE_TAG_STATE" "$FAKE_LOG"
output_file="$TEST_DIR/acquired-output"
OCI_FAKE_SCENARIO=available \
GITHUB_OUTPUT="$output_file" \
WORK_DIR="$TEST_DIR/acquired-work" \
PROVENANCE_DIR="$TEST_DIR/acquired-provenance" \
  "$OCI_DIR/scripts/acquire-a1.sh" >/dev/null
grep -Fq 'acquisition_status=ACQUIRED' "$output_file" ||
  fail "successful launch did not publish ACQUIRED"
grep -Fq 'compute instance update' "$FAKE_LOG" ||
  fail "successful acquisition did not bind the instance to current provenance"
grep -Fq -- '--wait-for-state RUNNING --wait-for-state TERMINATED' "$FAKE_LOG" ||
  fail "capacity acquisition does not stop waiting when OCI terminates a launch"
[[ -s "$TEST_DIR/acquired-provenance/provenance.env" ]] ||
  fail "successful launch omitted exact provenance"
bash -u -c '
  source "$1"
  [[ "$runtime_mode" == "k3s" ]]
  [[ "$region" == "eu-frankfurt-1" ]]
  [[ "$compartment_ocid" == ocid1.compartment.* ]]
  [[ "$instance_ocid" == ocid1.instance.* ]]
  [[ "$vnic_ocid" == ocid1.vnic.* ]]
  [[ "$subnet_ocid" == ocid1.subnet.* ]]
  [[ "$image_ocid" == ocid1.image.* ]]
  [[ "$shape" == "VM.Standard.A1.Flex" ]]
  [[ "$ocpus" == "2" && "$memory_gb" == "12" ]]
  [[ "$boot_volume_vpus_per_gb" == "10" ]]
  [[ "$target_ssh_public_key_sha256" == "$2" ]]
  [[ -n "$private_ip" && -n "$public_ip" ]]
' _ \
  "$TEST_DIR/acquired-provenance/provenance.env" \
  "$target_ssh_public_key_sha256" ||
  fail "successful launch provenance lacks the canonical k3s finalization fields"
jq -e '
  .instance_count == 1 and
  .boot_volume_vpus_per_gb == 10 and
  .expected_monthly_cost == 0
' \
  "$TEST_DIR/acquired-provenance/inventory.json" >/dev/null ||
  fail "successful launch inventory violates zero-cost singleton contract"
launch_count="$(grep -c 'compute instance launch' "$FAKE_LOG")"
tag_update_count="$(grep -c 'compute instance update' "$FAKE_LOG")"

second_output="$TEST_DIR/already-output"
OCI_FAKE_SCENARIO=available \
GITHUB_OUTPUT="$second_output" \
WORK_DIR="$TEST_DIR/already-work" \
PROVENANCE_DIR="$TEST_DIR/already-provenance" \
  "$OCI_DIR/scripts/acquire-a1.sh" >/dev/null
grep -Fq 'acquisition_status=ALREADY_ACQUIRED' "$second_output" ||
  fail "existing managed instance did not stop later acquisition"
grep -Fq 'instance_acquired=true' "$second_output" ||
  fail "existing managed instance did not republish trusted provenance"
[[ "$(grep -c 'compute instance launch' "$FAKE_LOG")" == "$launch_count" ]] ||
  fail "existing managed instance allowed another launch request"
[[ "$(grep -c 'compute instance update' "$FAKE_LOG")" == "$((tag_update_count + 1))" ]] ||
  fail "existing managed instance was not rebound to current provenance"
if OCI_FAKE_SCENARIO=available \
    OCI_K3S_SSH_PUBLIC_KEY="$fixture_mismatch_public_key" \
    PROVENANCE_DIR="$TEST_DIR/mismatched-key-provenance" \
      "$OCI_DIR/scripts/reconcile-capacity.sh" record >/dev/null 2>&1; then
  fail "existing managed instance was rebound to a different target SSH key"
fi
bash -u -c '
  source "$1"
  [[ "$source_sha" == "$2" && "$acquisition_run_id" == "$3" ]]
' _ \
  "$TEST_DIR/already-provenance/provenance.env" \
  "$SOURCE_SHA" \
  "$OCI_CAPACITY_RUN_ID" ||
  fail "existing managed instance provenance is not bound to the current run"

rm -f "$FAKE_STATE" "$FAKE_TAG_STATE" "$FAKE_LOG"
if OCI_FAKE_SCENARIO=terminated \
  WORK_DIR="$TEST_DIR/terminated-work" \
  PROVENANCE_DIR="$TEST_DIR/terminated-provenance" \
  "$OCI_DIR/scripts/acquire-a1.sh" >/dev/null 2>&1; then
  fail "internally terminated A1 launch was accepted"
fi

rm -f "$FAKE_STATE" "$FAKE_TAG_STATE" "$FAKE_LOG"
if OCI_FAKE_SCENARIO=duplicate \
  WORK_DIR="$TEST_DIR/duplicate-work" \
  PROVENANCE_DIR="$TEST_DIR/duplicate-provenance" \
  "$OCI_DIR/scripts/acquire-a1.sh" >/dev/null 2>&1; then
  fail "duplicate managed instances were accepted"
fi
if [[ -f "$FAKE_LOG" ]] && grep -Fq 'compute instance launch' "$FAKE_LOG"; then
  fail "duplicate managed instances reached the launch API"
fi

rm -f "$FAKE_STATE" "$FAKE_TAG_STATE" "$FAKE_LOG"
if OCI_FAKE_SCENARIO=fatal \
  WORK_DIR="$TEST_DIR/fatal-work" \
  PROVENANCE_DIR="$TEST_DIR/fatal-provenance" \
  "$OCI_DIR/scripts/acquire-a1.sh" >/dev/null 2>&1; then
  fail "non-capacity OCI failure was treated as retryable"
fi

rm -f "$FAKE_STATE" "$FAKE_TAG_STATE" "$FAKE_LOG"
stdout_fatal_log="$TEST_DIR/stdout-fatal.log"
if OCI_FAKE_SCENARIO=stdout-fatal \
  WORK_DIR="$TEST_DIR/stdout-fatal-work" \
  PROVENANCE_DIR="$TEST_DIR/stdout-fatal-provenance" \
  "$OCI_DIR/scripts/acquire-a1.sh" >"$stdout_fatal_log" 2>&1; then
  fail "OCI CLI parser failure was treated as retryable"
fi
grep -Fq 'No such option: --fixture' "$stdout_fatal_log" ||
  fail "OCI CLI stdout failure diagnostics were discarded"

echo "oci_capacity_contract=PASS"
