#!/usr/bin/env bash

OCI_ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OCI_DIR="$OCI_ROOT_DIR/infra/oci"
OCI_BOOT_VOLUME_VPUS_PER_GB=10

oci_die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

oci_log() {
  printf '%s\n' "$*"
}

oci_require_command() {
  command -v "$1" >/dev/null 2>&1 || oci_die "required command is unavailable: $1"
}

oci_require_cli_version() {
  oci_require_command oci
  oci_require_vars OCI_CLI_VERSION
  local actual
  actual="$(oci --version)"
  [[ "$actual" == "$OCI_CLI_VERSION" ]] ||
    oci_die "OCI CLI version '$actual' differs from reviewed version '$OCI_CLI_VERSION'"
}

oci_require_vars() {
  local name
  for name in "$@"; do
    [[ -n "${!name:-}" && "${!name}" != "REQUIRED" && "${!name}" != REQUIRED_* ]] ||
      oci_die "required environment variable is missing: $name"
  done
}

oci_require_value() {
  local name="$1"
  local expected="$2"
  [[ "${!name:-}" == "$expected" ]] ||
    oci_die "$name must be exactly '$expected' for the approved Free Tier design"
}

oci_require_ocid() {
  local name="$1"
  [[ "${!name:-}" =~ ^ocid1\.[a-z0-9-]+\.oc[0-9]*\..+ ]] ||
    oci_die "$name must contain a complete OCI OCID"
}

oci_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
  else
    shasum -a 256 | awk '{print $1}'
  fi
}

oci_fingerprint() {
  printf '%s' "$1" | oci_sha256
}

oci_ssh_ed25519_public_key_sha256() {
  local public_key="$1" key_material
  [[ "$public_key" != *$'\n'* &&
     "$public_key" =~ ^ssh-ed25519[[:space:]]+([A-Za-z0-9+/=]+)([[:space:]].*)?$ ]] ||
    oci_die "SSH public key must be a single-line ED25519 public key"
  key_material="${BASH_REMATCH[1]}"
  printf '%s\n' "$public_key" |
    ssh-keygen -l -E sha256 -f - >/dev/null 2>&1 ||
    oci_die "SSH public key is not a valid ED25519 key"
  printf 'ssh-ed25519 %s' "$key_material" | oci_sha256
}

oci_is_positive_int() {
  [[ "$1" =~ ^[1-9][0-9]*$ ]]
}

oci_require_retained_telemetry_restore_profile() {
  local baseline_dir="$1"
  # Callers may use an OR-list, which suppresses errexit inside this function.
  BASELINE_DIR="$baseline_dir" REQUIRE_CURRENT_DEPLOY_PROVENANCE=true \
    "$OCI_ROOT_DIR/infra/oci/scripts/validate-rollback-baseline-stan.sh" ||
    return "$?"
  python3 - "$baseline_dir" <<'PY' || return "$?"
import sys
from pathlib import Path

root = Path(sys.argv[1])
telemetry = {}
for raw in (root / "telemetry-pre-run.env").read_text(encoding="utf-8").splitlines():
    fields = raw.split("=", 1)
    if len(fields) != 2 or fields[0] in telemetry:
        raise SystemExit("pre-run Telemetry restore profile is malformed")
    telemetry[fields[0]] = fields[1]

mode = telemetry.get("mode")
if mode == "absent":
    raise SystemExit(0)
if mode != "retained":
    raise SystemExit("pre-run Telemetry restore mode is invalid")

rows = [
    raw.split("\t")
    for raw in (root / "deployments.tsv").read_text(encoding="utf-8").splitlines()
]
if any(len(row) != 6 for row in rows):
    raise SystemExit("baseline deployment restore profile is malformed")
retained = [row for row in rows if row[0] == "telemetry"]
if len(retained) != 1:
    raise SystemExit("baseline must bind exactly one retained Telemetry deployment")
replicas = retained[0][3]
if replicas != "1":
    raise SystemExit(
        f"retained Telemetry desired replicas {replicas} cannot use the existing "
        "single-replica restore path (requires 1)"
    )
PY
}

oci_runtime_mode() {
  local mode="${OCI_RUNTIME_MODE:-}"
  [[ "$mode" == "oke" || "$mode" == "k3s" ]] ||
    oci_die "OCI_RUNTIME_MODE must be exactly 'oke' or 'k3s'"
  printf '%s' "$mode"
}

oci_prepare_private_dir() {
  local directory="$1"
  mkdir -p "$directory"
  chmod 700 "$directory"
}

oci_prepare_safe_private_dir() {
  local directory="$1"
  local resolved
  command -v python3 >/dev/null 2>&1 || oci_die "python3 is required to prepare private directories"
  if ! resolved="$(python3 - "$OCI_ROOT_DIR" "$directory" <<'PY'
import sys
from pathlib import Path

repo_root = Path(sys.argv[1]).resolve()
raw_path = sys.argv[2]
if not raw_path:
    raise SystemExit("private directory path must not be empty")
if raw_path in {".", "/"}:
    raise SystemExit(f"refusing unsafe private directory: {raw_path}")
input_path = Path(raw_path)
if any(part == ".." for part in input_path.parts):
    raise SystemExit("private directory parent traversal is not allowed")
candidate = input_path if input_path.is_absolute() else repo_root / input_path
resolved = candidate.resolve(strict=False)
allowed_roots = [
    (repo_root / "artifacts").resolve(strict=False),
    (repo_root / ".test-workdirs").resolve(strict=False),
    (repo_root / "infra/oci/tests/.rollback-contract-workdirs").resolve(strict=False),
]
for root in allowed_roots:
    if resolved == root:
        raise SystemExit(f"private directory must be nested under {root}")
    try:
        resolved.relative_to(root)
    except ValueError:
        continue
    print(resolved)
    raise SystemExit(0)
raise SystemExit("private directory must stay within reviewed artifact roots")
PY
 2>&1)"; then
    oci_die "$resolved"
  fi
  rm -rf -- "$resolved"
  oci_prepare_private_dir "$resolved"
}

oci_redact() {
  python3 -c '
import re
import sys

value = sys.stdin.read()
value = re.sub(
    r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?-----END [A-Z0-9 ]*PRIVATE KEY-----",
    "[REDACTED_PRIVATE_KEY]",
    value,
    flags=re.DOTALL,
)
value = re.sub(r"ocid1\.[A-Za-z0-9._:-]+", "[REDACTED_OCID]", value)
value = re.sub(r"(?:[0-9]{1,3}\.){3}[0-9]{1,3}", "[REDACTED_IP]", value)
value = re.sub(
    r"\b[A-Za-z0-9._-]+\.(?:oraclevcn\.com|internal)\b",
    "[REDACTED_PRIVATE_HOST]",
    value,
    flags=re.IGNORECASE,
)
value = re.sub(
    r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}",
    "[REDACTED_EMAIL]",
    value,
)
value = re.sub(
    r"mongodb(?:\+srv)?://[^\s\"\x27<>]+",
    lambda match: "mongodb://[REDACTED]" + (
        match.group(0)[len(match.group(0).rstrip(",;)}")):]
    ),
    value,
)
value = re.sub(r"(?i)\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*", r"\1 [REDACTED]", value)
names = [
    "Author" + "ization",
    "to" + "ken",
    "pass" + "word",
    "sec" + "ret",
    "JWT" + "_" + "KEY",
    "set" + "-cookie",
    "cookie",
]
for name in names:
    escaped = re.escape(name)
    json_pattern = (
        r"(?im)(\"" + escaped + r"\"\s*:\s*)"
        r"(?:\"(?:[^\"\\\r\n]|\\.)*\"(?=\s*(?:[,}\]]|$))|\"[^\r\n]*$)"
    )
    value = re.sub(
        json_pattern,
        lambda match: match.group(1) + "\"[REDACTED]\"",
        value,
    )
    double_quoted_pattern = (
        r"(?im)(" + escaped + r"\s*[:=]\s*)"
        r"(?:\"(?:[^\"\\\r\n]|\\.)*\"(?=\s*(?:[,;]|$))|\"[^\r\n]*$)"
    )
    value = re.sub(
        double_quoted_pattern,
        lambda match: match.group(1) + "\"[REDACTED]\"",
        value,
    )
    single_quoted_pattern = (
        r"(?im)(" + escaped + r"\s*[:=]\s*)"
        r"(?:\x27(?:[^\x27\\\r\n]|\\.)*\x27(?=\s*(?:[,;]|$))|\x27[^\r\n]*$)"
    )
    value = re.sub(
        single_quoted_pattern,
        lambda match: match.group(1) + chr(39) + "[REDACTED]" + chr(39),
        value,
    )
    value = re.sub(
        rf"(?im)({escaped}\s*[:=]\s*)[^\s\r\n\"\x27]+",
        lambda match: match.group(1) + "[REDACTED]",
        value,
    )
sys.stdout.write(value)
'
}

oci_validate_public_ipv4() {
  python3 - "$1" <<'PY'
import ipaddress
import sys

try:
    address = ipaddress.ip_address(sys.argv[1])
except ValueError:
    raise SystemExit(1)
if address.version != 4 or not address.is_global:
    raise SystemExit(1)
PY
}

oci_json_array() {
  jq -cn '$ARGS.positional' --args "$@"
}

oci_normalize_list_json() {
  local response="${1:-}"
  local layout="${2:-array}"
  if [[ -z "$response" ]]; then
    if [[ "$layout" == "items" ]]; then
      printf '{"data":{"items":[]}}\n'
    else
      printf '{"data":[]}\n'
    fi
    return
  fi
  jq -e . <<<"$response" >/dev/null ||
    oci_die "OCI list response is not valid JSON"
  printf '%s\n' "$response"
}

oci_rabbitmq_queue_rows() {
  awk '
    /^[[:space:]]*$/ { next }
    NF == 4 &&
      $1 == "name" &&
      $2 == "messages_ready" &&
      $3 == "messages_unacknowledged" &&
      $4 == "consumers" {
        if (header_seen) {
          exit 2
        }
        header_seen = 1
        next
      }
    NF != 4 ||
      $2 !~ /^[0-9]+$/ ||
      $3 !~ /^[0-9]+$/ ||
      $4 !~ /^[0-9]+$/ {
        exit 2
      }
    {
        if (queue_seen[$1]++) {
          exit 2
        }
        print $1 "\t" $2 "\t" $3 "\t" $4
      }
  '
}

oci_application_rabbitmq_queue_names() {
  cat <<'QUEUES'
backoffice_cash_back_source
backoffice_new_event
backoffice_result_set
bet_cash_back_outcome
bet_moderation_result
bet_place_bet
bet_settle_slip
bet_settle_slip_row
event_event_visibility
event_live_projection
event_live_update.*
event_new_event
event_result
gamemaster_cash_back_source
gamemaster_new_event
gamemaster_result_set
moderation_event_result
moderation_live_event_update
moderation_place_bet
resulting_cash_back_request
resulting_cash_back_source_reply
resulting_live_event_update
resulting_moderation_result
resulting_place_bet
resulting_result
slip_moderation_result
slip_odds_clicked
telemetry:events:v1
QUEUES
}

oci_application_rabbitmq_queue_count() {
  oci_application_rabbitmq_queue_names | awk 'END {print NR}'
}

oci_rabbitmq_queue_inventory_matches() {
  local observed_names expected_names normalized expected_rows
  normalized="$(oci_rabbitmq_queue_rows <<<"$1")" || return 1
  observed_names="$(cut -f1 <<<"$normalized" | LC_ALL=C sort)"
  if grep -Fxq 'event_live_update.*' <<<"$observed_names"; then
    return 1
  fi
  # Only the current catalog uses a pod-scoped marker; captured baselines stay exact.
  if grep -Fxq 'event_live_update.*' <<<"$2"; then
    observed_names="$(
      awk '/^event_live_update\.[A-Za-z0-9_.:-]+$/ {$0="event_live_update.*"} {print}' \
        <<<"$observed_names" | LC_ALL=C sort
    )"
  fi
  expected_rows="$(awk 'NF {print $0 "\t0\t0\t1"}' <<<"$2")"
  normalized="$(oci_rabbitmq_queue_rows <<<"$expected_rows")" || return 1
  expected_names="$(cut -f1 <<<"$normalized" | LC_ALL=C sort)"
  [[ -n "$expected_names" && "$observed_names" == "$expected_names" ]]
}

oci_cash_back_source_flag() {
  local source_sha="$1" service="$2" manifest
  [[ "$source_sha" =~ ^[0-9a-f]{40}$ && "$service" =~ ^(bet|resulting)$ ]] ||
    oci_die "cash-back configuration requires an exact source and known service"
  oci_require_command ruby
  manifest="$(git show "${source_sha}:infra/k8s/${service}-depl.yaml")" ||
    oci_die "cash-back source manifest is unavailable"
  printf '%s\n' "$manifest" | ruby -ryaml -e '
    service = ARGV.fetch(0)
    documents = YAML.load_stream(STDIN.read)
    deployments = documents.select { |doc| doc.is_a?(Hash) && doc["kind"] == "Deployment" && doc.dig("metadata", "name") == "gaming-#{service}-depl" }
    abort "cash-back source deployment is ambiguous" unless deployments.length == 1
    containers = deployments.first.fetch("spec").fetch("template").fetch("spec").fetch("containers").select { |item| item["name"] == "gaming-#{service}" }
    abort "cash-back source container is ambiguous" unless containers.length == 1
    values = containers.first.fetch("env", []).select { |item| item["name"] == "CASH_BACK_ENABLED" }
    abort "cash-back source flag is duplicated" if values.length > 1
    if values.empty?
      puts "absent"
    else
      entry = values.first
      abort "cash-back source flag must be a literal boolean" if entry.key?("valueFrom") || !["true", "false"].include?(entry["value"])
      puts entry["value"]
    end
  ' "$service"
}

oci_verify_cash_back_source_flags() {
  local source_sha="$1" namespace="$2" phase="$3" service expected deployment_json pods_json
  [[ "$phase" == deployment || "$phase" == running ]] ||
    oci_die "cash-back configuration verification phase is invalid"
  for service in bet resulting; do
    expected="$(oci_cash_back_source_flag "$source_sha" "$service")" || return 1
    deployment_json="$(
      kubectl get deployment "gaming-${service}-depl" -n "$namespace" -o json
    )" || return 1
    pods_json=""
    if [[ "$phase" == running ]]; then
      pods_json="$(kubectl get pods -n "$namespace" -l "app=gaming-${service}" -o json)" ||
        return 1
    fi
    printf '%s\n%s\n' "$deployment_json" "$pods_json" | python3 -c '
import json
import sys
service, expected, phase = sys.argv[1:]
decoder = json.JSONDecoder()
text = sys.stdin.read()
deployment, end = decoder.raw_decode(text.lstrip())
containers = [item for item in deployment["spec"]["template"]["spec"]["containers"]
              if item["name"] == "gaming-" + service]
def verify(containers):
    if len(containers) != 1:
        raise SystemExit("cash-back workload container is ambiguous")
    entries = [item for item in containers[0].get("env", []) if item["name"] == "CASH_BACK_ENABLED"]
    if expected == "absent":
        if entries:
            raise SystemExit("historical cash-back flag absence was not restored")
    elif len(entries) != 1 or entries[0].get("value") != expected or "valueFrom" in entries[0]:
        raise SystemExit("cash-back workload flag differs from authenticated source")
verify(containers)
remainder = text.lstrip()[end:].strip()
if phase == "running":
    pods = json.loads(remainder)["items"]
    if not pods:
        raise SystemExit("cash-back serving pod configuration is unavailable")
    for pod in pods:
        verify([item for item in pod["spec"]["containers"] if item["name"] == "gaming-" + service])
elif remainder:
    raise SystemExit("unexpected cash-back configuration evidence")
' "$service" "$expected" "$phase" || return 1
  done
}

oci_restore_cash_back_source_flags() {
  local source_sha="$1" namespace="$2" service expected
  for service in bet resulting; do
    expected="$(oci_cash_back_source_flag "$source_sha" "$service")" || return 1
    if [[ "$expected" == absent ]]; then
      kubectl set env "deployment/gaming-${service}-depl" -n "$namespace" \
        -c "gaming-${service}" CASH_BACK_ENABLED- >/dev/null || return 1
    else
      kubectl set env "deployment/gaming-${service}-depl" -n "$namespace" \
        -c "gaming-${service}" "CASH_BACK_ENABLED=$expected" >/dev/null || return 1
    fi
  done
  oci_verify_cash_back_source_flags "$source_sha" "$namespace" deployment
}

oci_assert_repository_root() {
  [[ -f "$OCI_ROOT_DIR/CONTRIBUTING.md" && -d "$OCI_ROOT_DIR/infra/k8s" ]] ||
    oci_die "unable to identify the BetStan repository root"
}

oci_target_supports_backoffice_publication_replay() {
  local target_sha="$1"
  local service_source index_source marker

  [[ "$target_sha" =~ ^[0-9a-f]{40}$ ]] || return 1
  service_source="$(
    git show "${target_sha}:backoffice/src/service/BackofficePublicationService.ts" \
      2>/dev/null
  )" || return 1
  index_source="$(
    git show "${target_sha}:backoffice/src/index.ts" 2>/dev/null
  )" || return 1

  grep -Fq 'async replayPending()' <<<"$service_source" || return 1
  grep -Fq 'this.scheduleReplay()' <<<"$service_source" || return 1
  for marker in \
    newEventPublicationPending \
    resultPublicationPending \
    visibilityPublicationPending; do
    grep -Fq "$marker" <<<"$service_source" || return 1
  done
  grep -Fq 'await publicationService.start()' <<<"$index_source"
}

oci_target_supports_backoffice_pre_september_cleanup_guard() {
  local target_sha="$1"
  local listener_source boundary_source guard_line update_line guard_block

  [[ "$target_sha" =~ ^[0-9a-f]{40}$ ]] || return 1
  listener_source="$(
    git show "${target_sha}:backoffice/src/event/listener/NewEventListener.ts" \
      2>/dev/null
  )" || return 1
  boundary_source="$(
    git show "${target_sha}:backoffice/src/event/preSeptemberCleanupBoundary.ts" \
      2>/dev/null
  )" || return 1

  grep -Fq \
    'import { isBeforePreSeptemberCleanupCutoff } from "../preSeptemberCleanupBoundary";' \
    <<<"$listener_source" || return 1
  guard_line="$(
    grep -nF 'if (isBeforePreSeptemberCleanupCutoff(data.time)) {' \
      <<<"$listener_source" |
      awk -F: '
        { count += 1; line = $1 }
        END {
          if (count != 1) exit 1
          print line
        }
      '
  )" || return 1
  update_line="$(
    grep -nF 'await Event.updateOne(' <<<"$listener_source" |
      awk -F: '
        { count += 1; line = $1 }
        END {
          if (count != 1) exit 1
          print line
        }
      '
  )" || return 1
  [[ "$guard_line" =~ ^[1-9][0-9]*$ &&
    "$update_line" =~ ^[1-9][0-9]*$ &&
    "$guard_line" -lt "$update_line" ]] || return 1
  guard_block="$(
    sed -n "${guard_line},$((guard_line + 3))p" <<<"$listener_source" |
      sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//'
  )"
  [[ "$guard_block" == \
    $'if (isBeforePreSeptemberCleanupCutoff(data.time)) {\nthis.channel.ack(msg);\nreturn;\n}' ]] ||
    return 1

  grep -Fq \
    'export const PRE_SEPTEMBER_CLEANUP_CUTOFF =' \
    <<<"$boundary_source" || return 1
  grep -Fq '"2026-09-01T00:00:00Z" as const;' \
    <<<"$boundary_source" || return 1
  grep -Fq \
    'Date.UTC(2026, 8, 1, 0, 0, 0, 0);' \
    <<<"$boundary_source" || return 1
  grep -Fq \
    'export const isBeforePreSeptemberCleanupCutoff = (' \
    <<<"$boundary_source" || return 1
  grep -Fq 'const parsed = parseExplicitZoneTimestamp(value);' \
    <<<"$boundary_source" || return 1
  grep -Fq \
    'return parsed !== null && parsed < PRE_SEPTEMBER_CLEANUP_CUTOFF_MS;' \
    <<<"$boundary_source"
}
