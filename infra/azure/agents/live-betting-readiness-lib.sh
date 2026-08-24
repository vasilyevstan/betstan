#!/usr/bin/env bash
set -euo pipefail

LIVE_BETTING_LIB_ROOT="${LIVE_BETTING_LIB_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}"

live_betting_default_expected_flag() {
  case "$1" in
    dark|rollback-drain) printf 'false' ;;
    activate|monitor) printf 'true' ;;
    *) printf 'invalid' ;;
  esac
}

live_betting_default_max_active_matches() {
  case "$1" in
    dark|rollback-drain) printf '0' ;;
    activate) printf '4' ;;
    monitor) printf '24' ;;
    *) printf '0' ;;
  esac
}

live_betting_default_max_submitted_slips() {
  case "$1" in
    dark|rollback-drain) printf '0' ;;
    activate) printf '24' ;;
    monitor) printf '200' ;;
    *) printf '0' ;;
  esac
}

live_betting_default_max_draft_live_slips() {
  case "$1" in
    dark|rollback-drain) printf '0' ;;
    activate) printf '24' ;;
    monitor) printf '200' ;;
    *) printf '0' ;;
  esac
}

live_betting_default_max_queue_ready() {
  case "$1" in
    dark|rollback-drain) printf '0' ;;
    activate) printf '8' ;;
    monitor) printf '80' ;;
    *) printf '0' ;;
  esac
}

live_betting_default_max_queue_unack() {
  case "$1" in
    dark|rollback-drain) printf '0' ;;
    activate) printf '8' ;;
    monitor) printf '80' ;;
    *) printf '0' ;;
  esac
}

live_betting_default_max_workflow_pending_count() {
  case "$1" in
    dark) printf '2' ;;
    activate) printf '8' ;;
    monitor) printf '16' ;;
    rollback-drain) printf '4' ;;
    *) printf '2' ;;
  esac
}

live_betting_default_max_workflow_pending_age_seconds() {
  case "$1" in
    dark) printf '300' ;;
    activate) printf '900' ;;
    monitor) printf '1800' ;;
    rollback-drain) printf '600' ;;
    *) printf '300' ;;
  esac
}

live_betting_default_max_workflow_processing_count() {
  case "$1" in
    dark) printf '1' ;;
    activate) printf '3' ;;
    monitor) printf '6' ;;
    rollback-drain) printf '2' ;;
    *) printf '1' ;;
  esac
}

live_betting_default_max_workflow_processing_age_seconds() {
  case "$1" in
    dark) printf '180' ;;
    activate) printf '600' ;;
    monitor) printf '900' ;;
    rollback-drain) printf '300' ;;
    *) printf '180' ;;
  esac
}

live_betting_normalize_bool() {
  local value="${1:-}"
  value="$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')"
  case "$value" in
    1|true|yes|on) printf 'true' ;;
    0|false|no|off) printf 'false' ;;
    *) printf 'invalid' ;;
  esac
}

live_betting_require_uint() {
  [[ "$2" =~ ^[0-9]+$ ]] || live_betting_record_failure "$1" "$1 must be a non-negative integer"
}

live_betting_trim_trailing_slash() {
  printf '%s' "${1%/}"
}

live_betting_sha256_file() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  else
    shasum -a 256 "$file" | awk '{print $1}'
  fi
}

live_betting_prepare_private_dir() {
  local directory="$1"
  local resolved
  command -v python3 >/dev/null 2>&1 || {
    printf 'python3 is required to prepare private directories\n' >&2
    return 1
  }
  if ! resolved="$(python3 - "$LIVE_BETTING_LIB_ROOT" "$directory" <<'PY'
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
    printf '%s\n' "$resolved" >&2
    return 1
  fi
  rm -rf -- "$resolved"
  mkdir -p -- "$resolved"
  chmod 700 "$resolved"
}

live_betting_create_unique_private_dir() {
  local parent="$1"
  local prefix="$2"
  command -v python3 >/dev/null 2>&1 || {
    printf 'python3 is required to allocate private directories\n' >&2
    return 1
  }
  python3 - "$parent" "$prefix" <<'PY'
import sys
import uuid
from pathlib import Path

parent = Path(sys.argv[1])
prefix = sys.argv[2]
parent.mkdir(mode=0o700, parents=True, exist_ok=True)
for _ in range(64):
    candidate = parent / f"{prefix}-{uuid.uuid4().hex}"
    try:
        candidate.mkdir(mode=0o700)
    except FileExistsError:
        continue
    print(candidate)
    raise SystemExit(0)
raise SystemExit("unable to allocate unique private directory")
PY
}

live_betting_env_file_value() {
  local file="$1"
  local key="$2"
  [[ -f "$file" ]] || return 1
  python3 - "$file" "$key" <<'PY'
import sys
from pathlib import Path

file_path, key = sys.argv[1:]
for raw_line in Path(file_path).read_text(encoding="utf-8").splitlines():
    if "=" not in raw_line:
        continue
    candidate_key, candidate_value = raw_line.split("=", 1)
    if candidate_key == key:
        print(candidate_value)
        raise SystemExit(0)
raise SystemExit(1)
PY
}

live_betting_sse_seconds_to_milliseconds() {
  local value="$1"
  local rounding_mode="$2"
  python3 - "$value" "$rounding_mode" <<'PY'
import sys
from decimal import Decimal, InvalidOperation, ROUND_CEILING, ROUND_FLOOR

value, rounding_mode = sys.argv[1:3]
try:
    seconds = Decimal(value)
except InvalidOperation as exc:
    raise SystemExit(f"invalid decimal seconds: {value}") from exc
if not seconds.is_finite() or seconds < 0:
    raise SystemExit(f"invalid decimal seconds: {value}")
scaled = seconds * Decimal("1000")
if rounding_mode == "floor":
    rounded = scaled.to_integral_value(rounding=ROUND_FLOOR)
elif rounding_mode == "ceil":
    rounded = scaled.to_integral_value(rounding=ROUND_CEILING)
else:
    raise SystemExit(f"unsupported rounding mode: {rounding_mode}")
print(int(rounded))
PY
}

live_betting_trace_sse_probe_inputs() {
  local label="$1"
  local curl_status="$2"
  local status="$3"
  local duration_seconds="$4"
  local observation_window_seconds="$5"
  local trace_file="${LIVE_BETTING_SSE_PROBE_TRACE_FILE:-}"
  [[ -n "$trace_file" ]] || return 0
  printf '%s\t%s\t%s\t%s\t%s\n' \
    "$label" "$curl_status" "$status" "$duration_seconds" "$observation_window_seconds" \
    >>"$trace_file" 2>/dev/null || true
}

live_betting_trace_sse_validation() {
  local label="$1"
  local curl_status="$2"
  local status="$3"
  local duration_seconds="$4"
  local duration_ms="$5"
  local observation_window_seconds="$6"
  local observation_window_ms="$7"
  local precision_tolerance_ms="$8"
  local has_frames="$9"
  local open_long_enough="${10}"
  local trace_file="${LIVE_BETTING_SSE_VALIDATION_TRACE_FILE:-}"
  [[ -n "$trace_file" ]] || return 0
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$label" "$curl_status" "$status" "$duration_seconds" "$duration_ms" \
    "$observation_window_seconds" "$observation_window_ms" "$precision_tolerance_ms" \
    "$has_frames" "$open_long_enough" \
    >>"$trace_file" 2>/dev/null || true
}

live_betting_validate_sse_connectivity() {
  local headers_file="$1"
  local body_file="$2"
  local curl_status="$3"
  local status="$4"
  local duration_seconds="$5"
  local observation_window_seconds="$6"
  local label="$7"
  local content_type has_frames="0"
  local duration_ms observation_window_ms
  local precision_tolerance_ms=1
  local open_long_enough="false"
  if ! [[ "$curl_status" =~ ^[0-9]+$ ]]; then
    printf 'SSE curl status is invalid for %s: %s\n' "$label" "${curl_status:-missing}" >&2
    return 1
  fi
  if [[ "$status" != "200" ]]; then
    printf 'expected SSE HTTP 200 for %s, got %s\n' "$label" "${status:-missing}" >&2
    return 1
  fi
  if ! [[ "$duration_seconds" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
    printf 'SSE duration is invalid for %s: %s\n' "$label" "${duration_seconds:-missing}" >&2
    return 1
  fi
  if ! [[ "$observation_window_seconds" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
    printf 'SSE observation window is invalid for %s: %s\n' "$label" "${observation_window_seconds:-missing}" >&2
    return 1
  fi
  content_type="$(
    awk 'tolower($1)=="content-type:" {$1=""; sub(/^ /, ""); sub(/\r$/, ""); print}' "$headers_file" |
      tail -n 1
  )"
  if [[ "$content_type" != text/event-stream* ]]; then
    printf 'SSE endpoint is not text/event-stream for %s\n' "$label" >&2
    return 1
  fi
  if [[ -s "$body_file" ]]; then
    if ! grep -Eq '^(event:|data:|:)' "$body_file"; then
      printf 'SSE endpoint returned malformed event-stream frames for %s\n' "$label" >&2
      return 1
    fi
    has_frames="1"
  fi
  duration_ms="$(live_betting_sse_seconds_to_milliseconds "$duration_seconds" floor)" || {
    printf 'SSE duration could not be normalized for %s: %s\n' "$label" "$duration_seconds" >&2
    return 1
  }
  observation_window_ms="$(live_betting_sse_seconds_to_milliseconds "$observation_window_seconds" ceil)" || {
    printf 'SSE observation window could not be normalized for %s: %s\n' \
      "$label" "$observation_window_seconds" >&2
    return 1
  }
  # curl --write-out %{time_total} is emitted as text. Normalize observed durations
  # down and required windows up to integer milliseconds, then allow only 1 ms of
  # slack so 4.999999 vs 5 stays stable while 4.998 still fails closed.
  if (( duration_ms + precision_tolerance_ms >= observation_window_ms )); then
    open_long_enough="true"
  fi
  live_betting_trace_sse_validation \
    "$label" \
    "$curl_status" \
    "$status" \
    "$duration_seconds" \
    "$duration_ms" \
    "$observation_window_seconds" \
    "$observation_window_ms" \
    "$precision_tolerance_ms" \
    "$has_frames" \
    "$open_long_enough"
  case "$curl_status" in
    28)
      [[ "$open_long_enough" == "true" ]] || {
        printf 'SSE stream timed out before the observation window completed for %s\n' "$label" >&2
        return 1
      }
      ;;
    0)
      if [[ "$open_long_enough" != "true" ]]; then
        if [[ "$has_frames" == "1" ]]; then
          printf 'SSE stream closed too early after initial event-stream traffic for %s\n' "$label" >&2
        else
          printf 'SSE stream closed before the quiet observation window completed for %s\n' "$label" >&2
        fi
        return 1
      fi
      ;;
    *)
      printf 'SSE probe exited with curl status %s for %s\n' "$curl_status" "$label" >&2
      return 1
      ;;
  esac
  printf '%s' "$content_type"
}

live_betting_compare_queue_snapshots() {
  command -v python3 >/dev/null 2>&1 || {
    printf 'python3 is required to compare RabbitMQ queue snapshots\n' >&2
    return 1
  }
  python3 - "$@" <<'PY'
import sys
from pathlib import Path

(
    baseline_path,
    current_path,
    step,
    max_ready,
    max_unack,
    max_ready_growth,
    max_unack_growth,
    dynamic_prefix_csv,
    min_dynamic_consumers,
) = sys.argv[1:]

dynamic_prefixes = [prefix for prefix in dynamic_prefix_csv.split(",") if prefix]
max_ready = int(max_ready)
max_unack = int(max_unack)
max_ready_growth = int(max_ready_growth)
max_unack_growth = int(max_unack_growth)
min_dynamic_consumers = int(min_dynamic_consumers)


def load_rows(path: str):
    rows = {}
    for raw_line in Path(path).read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line:
            continue
        parts = line.split("\t")
        if len(parts) != 4:
            raise SystemExit(f"queue snapshot row must contain four tab-separated columns: {raw_line}")
        queue, ready, unack, consumers = parts
        if not (ready.isdigit() and unack.isdigit() and consumers.isdigit()):
            raise SystemExit(f"queue snapshot counts must be numeric: {raw_line}")
        rows[queue] = (int(ready), int(unack), int(consumers))
    return rows


def is_dynamic(queue_name: str) -> bool:
    return any(queue_name.startswith(prefix) for prefix in dynamic_prefixes)


def append_checks(queue_key, baseline_ready, ready, baseline_unack, unack, baseline_consumers, consumers, errors):
    ready_growth = ready - baseline_ready
    unack_growth = unack - baseline_unack
    if baseline_consumers > 0 and consumers < baseline_consumers:
        errors.append(f"{queue_key}: consumers {consumers} below baseline {baseline_consumers}")
    if ready > max_ready:
        errors.append(f"{queue_key}: ready {ready} exceeds bound {max_ready}")
    if unack > max_unack:
        errors.append(f"{queue_key}: unack {unack} exceeds bound {max_unack}")
    if ready_growth > max_ready_growth:
        errors.append(f"{queue_key}: ready growth {ready_growth} exceeds bound {max_ready_growth}")
    if unack_growth > max_unack_growth:
        errors.append(f"{queue_key}: unack growth {unack_growth} exceeds bound {max_unack_growth}")
    return ready_growth, unack_growth


baseline = load_rows(baseline_path)
current = load_rows(current_path)
errors = []
rows = []

missing_durable = sorted(
    queue for queue in baseline
    if not is_dynamic(queue) and queue not in current
)
if missing_durable:
    errors.append("missing queues: " + ",".join(missing_durable))

for queue in sorted(baseline):
    if is_dynamic(queue) or queue not in current:
        continue
    baseline_ready, baseline_unack, baseline_consumers = baseline[queue]
    ready, unack, consumers = current[queue]
    ready_growth, unack_growth = append_checks(
        queue,
        baseline_ready,
        ready,
        baseline_unack,
        unack,
        baseline_consumers,
        consumers,
        errors,
    )
    rows.append(
        (
            step,
            queue,
            baseline_ready,
            ready,
            ready_growth,
            baseline_unack,
            unack,
            unack_growth,
            baseline_consumers,
            consumers,
            1,
            1,
        )
    )

for prefix in dynamic_prefixes:
    baseline_group = [
        (queue, *baseline[queue])
        for queue in sorted(baseline)
        if queue.startswith(prefix)
    ]
    current_group = [
        (queue, *current[queue])
        for queue in sorted(current)
        if queue.startswith(prefix)
    ]
    if not baseline_group:
        errors.append(f"{prefix}: baseline missing dynamic topology")
        continue
    if not current_group:
        errors.append(f"{prefix}: missing dynamic topology")
        continue
    baseline_ready = sum(item[1] for item in baseline_group)
    baseline_unack = sum(item[2] for item in baseline_group)
    baseline_consumers = sum(item[3] for item in baseline_group)
    ready = sum(item[1] for item in current_group)
    unack = sum(item[2] for item in current_group)
    consumers = sum(item[3] for item in current_group)
    if len(current_group) < len(baseline_group):
        errors.append(
            f"{prefix}: dynamic queue count {len(current_group)} below baseline {len(baseline_group)}"
        )
    required_consumers = max(min_dynamic_consumers, baseline_consumers)
    if consumers < required_consumers:
        errors.append(f"{prefix}: consumers {consumers} below required {required_consumers}")
    ready_growth, unack_growth = append_checks(
        f"dynamic:{prefix}",
        baseline_ready,
        ready,
        baseline_unack,
        unack,
        baseline_consumers,
        consumers,
        errors,
    )
    rows.append(
        (
            step,
            f"dynamic:{prefix}",
            baseline_ready,
            ready,
            ready_growth,
            baseline_unack,
            unack,
            unack_growth,
            baseline_consumers,
            consumers,
            len(baseline_group),
            len(current_group),
        )
    )

for row in rows:
    print(*row, sep="\t")
if errors:
    raise SystemExit("; ".join(errors))
PY
}

live_betting_sanitize_stream() {
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
value = re.sub(r"mongodb(?:\+srv)?://[^\s]+", "mongodb://[REDACTED]", value)
value = re.sub(r"ocid1\.[A-Za-z0-9._:-]+", "[REDACTED_OCID]", value)
value = re.sub(
    r"(?i)\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*",
    r"\1 [REDACTED]",
    value,
)
for name in (
    "authorization",
    "token",
    "password",
    "secret",
    "jwt_key",
    "set-cookie",
    "cookie",
):
    value = re.sub(
        rf"(?im)({re.escape(name)}\s*[:=]\s*)[^\s\r\n]+",
        rf"\1[REDACTED]",
        value,
    )
value = re.sub(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", "[REDACTED_EMAIL]", value)
value = re.sub(r"(?:[0-9]{1,3}\.){3}[0-9]{1,3}", "[REDACTED_IP]", value)
sys.stdout.write(value)
    '
}

live_betting_write_sanitized_file() {
  local src="$1"
  local dest="$2"
  if [[ -f "$src" ]]; then
    live_betting_sanitize_stream <"$src" >"$dest"
  fi
}

live_betting_append_failed_check() {
  local check="$1"
  case ",$LIVE_BETTING_FAILED_CHECKS," in
    *",$check,"*) ;;
    *)
      if [[ -n "$LIVE_BETTING_FAILED_CHECKS" ]]; then
        LIVE_BETTING_FAILED_CHECKS="$LIVE_BETTING_FAILED_CHECKS,$check"
      else
        LIVE_BETTING_FAILED_CHECKS="$check"
      fi
      ;;
  esac
}

live_betting_record_failure() {
  local check="$1"
  shift || true
  local reason="$*"
  live_betting_append_failed_check "$check"
  printf '%s\t%s\n' "$check" "$reason" | live_betting_sanitize_stream >>"$LIVE_BETTING_FAILURES_FILE"
}

live_betting_capture_command() {
  local label="$1"
  shift
  local stdout_file="$LIVE_BETTING_WORK_DIR/${label}.stdout"
  local stderr_file="$LIVE_BETTING_WORK_DIR/${label}.stderr"
  if "$@" >"$stdout_file" 2>"$stderr_file"; then
    live_betting_write_sanitized_file "$stdout_file" "$LIVE_BETTING_OUTPUT_DIR/${label}.stdout"
    live_betting_write_sanitized_file "$stderr_file" "$LIVE_BETTING_OUTPUT_DIR/${label}.stderr"
    cat "$stdout_file"
    return 0
  fi
  live_betting_write_sanitized_file "$stdout_file" "$LIVE_BETTING_OUTPUT_DIR/${label}.stdout"
  live_betting_write_sanitized_file "$stderr_file" "$LIVE_BETTING_OUTPUT_DIR/${label}.stderr"
  return 1
}

live_betting_header_value() {
  python3 - "$1" "$2" <<'PY'
import sys

path, target = sys.argv[1:]
target = target.lower()
value = ""
with open(path, encoding="utf-8", errors="replace") as handle:
    for raw_line in handle:
        line = raw_line.rstrip("\r\n")
        if ":" not in line:
            continue
        key, remainder = line.split(":", 1)
        if key.strip().lower() == target:
            value = remainder.strip()
print(value)
PY
}

live_betting_write_http_summary() {
  local body="$1"
  local headers="$2"
  local dest="$3"
  local shape="$4"
  python3 - "$body" "$headers" "$dest" "$shape" <<'PY'
import json
import math
import re
import sys
from pathlib import Path

body_path, headers_path, dest_path, shape = sys.argv[1:]
status = None
content_type = ""
cache_control = ""
x_accel = ""
location = ""
for raw_line in Path(headers_path).read_text(encoding="utf-8", errors="replace").splitlines():
    line = raw_line.strip()
    if raw_line.startswith("HTTP/"):
        parts = raw_line.split()
        if len(parts) >= 2 and parts[1].isdigit():
            status = int(parts[1])
        continue
    if ":" not in raw_line:
        continue
    key, value = raw_line.split(":", 1)
    lowered = key.strip().lower()
    value = value.strip()
    if lowered == "content-type":
        content_type = value
    elif lowered == "cache-control":
        cache_control = value
    elif lowered == "x-accel-buffering":
        x_accel = value
    elif lowered == "location":
        location = value
summary = {
    "status": status,
    "content_type": content_type,
    "cache_control": cache_control,
    "x_accel_buffering": x_accel,
    "location": location,
}
body_text = Path(body_path).read_text(encoding="utf-8", errors="replace")
summary["body_sha256"] = __import__("hashlib").sha256(body_text.encode("utf-8")).hexdigest()
score_name_re = re.compile(r"^\d+\s*-\s*\d+$")

def normalize_label(value):
    return "".join(ch for ch in str(value).lower() if ch.isalnum())

def nonempty_string(value):
    return isinstance(value, str) and value.strip() != ""

def parse_positive_number(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        if math.isfinite(value) and float(value) > 0:
            return float(value)
        return None
    if isinstance(value, str):
        try:
            parsed = float(value)
        except ValueError:
            return None
        if math.isfinite(parsed) and parsed > 0:
            return parsed
    return None

def parse_isoish(value):
    if not nonempty_string(value):
        return None
    text = value.strip()
    try:
        __import__("datetime").datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    return text

def derive_teams(entry):
    home = entry.get("home")
    away = entry.get("away")
    if nonempty_string(home) and nonempty_string(away):
        return normalize_label(home), normalize_label(away)
    name = entry.get("name")
    if nonempty_string(name) and " - " in name:
        left, right = [part.strip() for part in name.split(" - ", 1)]
        if left and right:
            return normalize_label(left), normalize_label(right)
    return None, None

def normalized_prematch_phase(entry):
    for key in ("phase", "kind", "betKind"):
        value = entry.get(key)
        if nonempty_string(value):
            normalized = value.strip().upper().replace("-", "_").replace(" ", "_")
            if normalized in {"PREMATCH", "PRE_MATCH", "SCHEDULED"}:
                return "PRE_MATCH"
            return normalized
    return "PRE_MATCH"

def has_live_snapshot(entry):
    live = entry.get("live")
    return isinstance(live, dict) and any(
        field in live for field in ("sequence", "minute", "currentMarkets", "phase", "bettingStatus", "kickoffAt")
    )

def product_class(product):
    type_label = normalize_label(product.get("type", ""))
    name_label = normalize_label(product.get("name", ""))
    if type_label in {"1x2", "onecrosstwo"} or name_label == "1x2":
        return "1x2"
    if type_label in {"cs", "correctscore"} or name_label == "correctscore":
        return "correct-score"
    return None

def valid_odds(product, require_score_names=False):
    odds = []
    for odd in (product.get("odds") if isinstance(product.get("odds"), list) else [])[:40]:
        if not isinstance(odd, dict):
            continue
        odd_id = odd.get("id")
        odd_name = odd.get("name")
        odd_value = parse_positive_number(odd.get("value"))
        if not nonempty_string(odd_id) or not nonempty_string(odd_name) or odd_value is None:
            continue
        if require_score_names and not score_name_re.match(odd_name.strip()):
            continue
        odds.append({
            "id": odd_id.strip(),
            "name": odd_name.strip(),
            "value": odd_value,
        })
    return odds

if shape in {"event-array", "legacy-prematch-events"}:
    payload = json.loads(body_text)
    if not isinstance(payload, list):
      raise SystemExit("event payload must be an array")
    if not payload:
      raise SystemExit("event payload must not be empty")
    live_count = 0
    sample_keys = []
    legacy_candidates = []
    for entry in payload[:20]:
        if not isinstance(entry, dict):
            continue
        sample_keys = sorted(entry.keys())
        if has_live_snapshot(entry):
            live_count += 1
            continue
        if normalized_prematch_phase(entry) != "PRE_MATCH":
            continue
        if not nonempty_string(entry.get("eventId")):
            continue
        if not nonempty_string(entry.get("name")):
            continue
        if parse_isoish(entry.get("time")) is None:
            continue
        products = entry.get("products")
        if not isinstance(products, list):
            continue
        home_label, away_label = derive_teams(entry)
        one_x_two_odds = None
        correct_score_odds = None
        for product in products[:20]:
            if not isinstance(product, dict):
                continue
            classification = product_class(product)
            if classification == "1x2" and one_x_two_odds is None:
                odds = valid_odds(product)
                odd_labels = [normalize_label(item["name"]) for item in odds]
                draw_present = any(label in {"draw", "x"} for label in odd_labels)
                if draw_present:
                    if home_label and away_label:
                        if home_label in odd_labels and away_label in odd_labels and len(odds) >= 3:
                            one_x_two_odds = odds
                    else:
                        non_draw_labels = {label for label in odd_labels if label not in {"draw", "x"}}
                        if len(non_draw_labels) >= 2 and len(odds) >= 3:
                            one_x_two_odds = odds
            elif classification == "correct-score" and correct_score_odds is None:
                odds = valid_odds(product, require_score_names=True)
                if len(odds) >= 3:
                    correct_score_odds = odds
        if one_x_two_odds and correct_score_odds:
            legacy_candidates.append({
                "eventId": entry["eventId"].strip(),
                "one_x_two_odds": len(one_x_two_odds),
                "correct_score_odds": len(correct_score_odds),
            })
    summary["items"] = len(payload)
    summary["live_items"] = live_count
    summary["sample_keys"] = sample_keys
    if not legacy_candidates:
        raise SystemExit("legacy PRE_MATCH event evidence with 1X2 and Correct Score odds is required")
    summary["legacy_prematch_events"] = len(legacy_candidates)
    summary["legacy_prematch_event_id"] = legacy_candidates[0]["eventId"]
    summary["legacy_prematch_1x2_odds"] = legacy_candidates[0]["one_x_two_odds"]
    summary["legacy_prematch_correct_score_odds"] = legacy_candidates[0]["correct_score_odds"]
elif shape == "current-user":
    payload = json.loads(body_text)
    if not isinstance(payload, dict) or "currentUser" not in payload:
        raise SystemExit("current user payload must contain currentUser")
    current_user = payload.get("currentUser")
    summary["has_currentUser"] = True
    summary["currentUser_type"] = type(current_user).__name__
elif shape == "sse":
    heartbeat_count = body_text.count(": heartbeat")
    summary["heartbeat_count"] = heartbeat_count
    summary["line_count"] = len(body_text.splitlines())
Path(dest_path).write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY
}

live_betting_http_request() {
  local label="$1"
  local url="$2"
  local body="$LIVE_BETTING_WORK_DIR/${label}.body"
  local headers="$LIVE_BETTING_WORK_DIR/${label}.headers"
  local stderr_file="$LIVE_BETTING_WORK_DIR/${label}.stderr"
  local status=""
  if ! status="$(curl --silent --show-error --max-time "$LIVE_BETTING_REQUEST_TIMEOUT" --output "$body" --dump-header "$headers" --write-out '%{http_code}' "$url" 2>"$stderr_file")"; then
    local rc=$?
    live_betting_write_sanitized_file "$stderr_file" "$LIVE_BETTING_OUTPUT_DIR/${label}.stderr"
    printf '%s\t%s\n' "$rc" "$status"
    return "$rc"
  fi
  live_betting_write_sanitized_file "$stderr_file" "$LIVE_BETTING_OUTPUT_DIR/${label}.stderr"
  printf '%s\n' "$status"
}

live_betting_sse_request() {
  local label="$1"
  local url="$2"
  local body="$LIVE_BETTING_WORK_DIR/${label}.body"
  local headers="$LIVE_BETTING_WORK_DIR/${label}.headers"
  local stderr_file="$LIVE_BETTING_WORK_DIR/${label}.stderr"
  local status=""
  if ! status="$(curl --silent --show-error --max-time "$LIVE_BETTING_SSE_TIMEOUT" --output "$body" --dump-header "$headers" --write-out '%{http_code}' "$url" 2>"$stderr_file")"; then
    local rc=$?
    live_betting_write_sanitized_file "$stderr_file" "$LIVE_BETTING_OUTPUT_DIR/${label}.stderr"
    if [[ "$rc" -ne 28 ]]; then
      printf '%s\t%s\n' "$rc" "$status"
      return "$rc"
    fi
    printf '%s\t%s\n' "$rc" "$status"
    return 0
  fi
  live_betting_write_sanitized_file "$stderr_file" "$LIVE_BETTING_OUTPUT_DIR/${label}.stderr"
  printf '0\t%s\n' "$status"
}

live_betting_apply_metric() {
  local key="$1"
  local value="$2"
  case "$key" in
    image_provenance_rows) LIVE_BETTING_IMAGE_PROVENANCE_ROWS="$value" ;;
    app_deployments_verified) LIVE_BETTING_APP_DEPLOYMENTS_VERIFIED="$value" ;;
    aux_workloads_ready) LIVE_BETTING_AUX_WORKLOADS_READY="$value" ;;
    actual_live_kickoffs_enabled) LIVE_BETTING_ACTUAL_FLAG="$value" ;;
    rabbit_live_ready_messages) LIVE_BETTING_RABBIT_READY="$value" ;;
    rabbit_live_unacked_messages) LIVE_BETTING_RABBIT_UNACK="$value" ;;
    rabbit_live_consumers) LIVE_BETTING_RABBIT_CONSUMERS="$value" ;;
    rabbit_dynamic_queues) LIVE_BETTING_RABBIT_DYNAMIC_QUEUES="$value" ;;
    active_matches) LIVE_BETTING_ACTIVE_MATCHES="$value" ;;
    overdue_unstarted_events) LIVE_BETTING_OVERDUE_UNSTARTED_EVENTS="$value" ;;
    simulation_quarantines) LIVE_BETTING_SIMULATION_QUARANTINES="$value" ;;
    submitted_live_slips) LIVE_BETTING_SUBMITTED_LIVE_SLIPS="$value" ;;
    draft_live_slips) LIVE_BETTING_DRAFT_LIVE_SLIPS="$value" ;;
    mongo_ping_ok) LIVE_BETTING_MONGO_PING_OK="$value" ;;
    topology_mode) LIVE_BETTING_TOPOLOGY_MODE="$value" ;;
    topology_validated) LIVE_BETTING_TOPOLOGY_VALIDATED="$value" ;;
    lock_state) LIVE_BETTING_LOCK_STATE="$value" ;;
    mongo_pvc_name) LIVE_BETTING_MONGO_PVC_NAME="$value" ;;
    mongo_pvc_phase) LIVE_BETTING_MONGO_PVC_PHASE="$value" ;;
    public_event_status) LIVE_BETTING_PUBLIC_EVENT_STATUS="$value" ;;
    public_event_items) LIVE_BETTING_PUBLIC_EVENT_ITEMS="$value" ;;
    legacy_prematch_events) LIVE_BETTING_LEGACY_PREMATCH_EVENTS="$value" ;;
    legacy_prematch_event_id) LIVE_BETTING_LEGACY_PREMATCH_EVENT_ID="$value" ;;
    legacy_prematch_1x2_odds) LIVE_BETTING_LEGACY_PREMATCH_1X2_ODDS="$value" ;;
    legacy_prematch_correct_score_odds) LIVE_BETTING_LEGACY_PREMATCH_CORRECT_SCORE_ODDS="$value" ;;
    public_current_user_status) LIVE_BETTING_PUBLIC_CURRENTUSER_STATUS="$value" ;;
    public_current_user_type) LIVE_BETTING_PUBLIC_CURRENTUSER_TYPE="$value" ;;
    diagnostic_event_status) LIVE_BETTING_DIAGNOSTIC_EVENT_STATUS="$value" ;;
    diagnostic_current_user_status) LIVE_BETTING_DIAGNOSTIC_CURRENTUSER_STATUS="$value" ;;
    secondary_redirect_status) LIVE_BETTING_SECONDARY_REDIRECT_STATUS="$value" ;;
    sse_primary_status) LIVE_BETTING_SSE_PRIMARY_STATUS="$value" ;;
    sse_primary_heartbeat) LIVE_BETTING_SSE_PRIMARY_HEARTBEAT="$value" ;;
    sse_diagnostic_status) LIVE_BETTING_SSE_DIAGNOSTIC_STATUS="$value" ;;
    sse_diagnostic_heartbeat) LIVE_BETTING_SSE_DIAGNOSTIC_HEARTBEAT="$value" ;;
    provenance_source_sha) LIVE_BETTING_PROVENANCE_SOURCE_SHA="$value" ;;
    schema_evidence_verified) LIVE_BETTING_SCHEMA_EVIDENCE_VERIFIED="$value" ;;
    rollback_baseline_verified) LIVE_BETTING_ROLLBACK_BASELINE_VERIFIED="$value" ;;
    *)
      if [[ -n "${LIVE_BETTING_ADDITIONAL_SUMMARY_FILE:-}" ]]; then
        printf '%s=%s\n' "$key" "$value" >>"$LIVE_BETTING_ADDITIONAL_SUMMARY_FILE"
      fi
      ;;
  esac
}

live_betting_check_workloads() {
  local workloads_json="$1"
  local pods_json="$2"
  local result_stdout="$LIVE_BETTING_WORK_DIR/workloads.result"
  local result_stderr="$LIVE_BETTING_WORK_DIR/workloads.result.stderr"
  if ! python3 - "$workloads_json" "$pods_json" "$LIVE_BETTING_IMAGE_PROVENANCE_FILE" "$LIVE_BETTING_EXPECTED_FLAG" >"$result_stdout" 2>"$result_stderr" <<'PY'
import json
import re
import sys
from pathlib import Path

workloads_path, pods_path, images_path, expected_flag = sys.argv[1:]
digest_re = re.compile(r"@sha256:[0-9a-f]{64}$")

def read_images(path: str):
    rows = []
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        parts = line.split("\t")
        if len(parts) < 4:
            raise SystemExit("image provenance rows must contain at least four tab-separated columns")
        service, _repository, image_ref, digest = parts[:4]
        if not service or not image_ref or not digest_re.search(image_ref):
            raise SystemExit(f"invalid image provenance row for {service or 'missing-service'}")
        rows.append((service, image_ref))
    return rows

workloads = json.loads(Path(workloads_path).read_text(encoding="utf-8"))
pods = json.loads(Path(pods_path).read_text(encoding="utf-8"))
items = workloads.get("items") if isinstance(workloads, dict) else None
pod_items = pods.get("items") if isinstance(pods, dict) else None
if not isinstance(items, list):
    raise SystemExit("workloads JSON must contain items")
if not isinstance(pod_items, list):
    raise SystemExit("pods JSON must contain items")
workloads_by_name = {}
for item in items:
    metadata = item.get("metadata") or {}
    name = metadata.get("name")
    if isinstance(name, str):
        workloads_by_name[name] = item
pod_items_by_app = {}
for pod in pod_items:
    labels = ((pod.get("metadata") or {}).get("labels") or {})
    app = labels.get("app")
    if isinstance(app, str):
        pod_items_by_app.setdefault(app, []).append(pod)
image_rows = read_images(images_path)
if len(image_rows) != 9:
    raise SystemExit(f"expected nine image provenance rows, found {len(image_rows)}")
for service, image_ref in image_rows:
    deployment_name = f"gaming-{service}-depl"
    container_name = f"gaming-{service}"
    workload = workloads_by_name.get(deployment_name)
    if not isinstance(workload, dict):
        raise SystemExit(f"missing deployment {deployment_name}")
    spec = workload.get("spec") or {}
    status = workload.get("status") or {}
    replicas = int(spec.get("replicas") or 0)
    ready = int(status.get("readyReplicas") or status.get("availableReplicas") or 0)
    if replicas < 1 or ready != replicas:
        raise SystemExit(f"deployment {deployment_name} is not fully ready")
    containers = (((spec.get("template") or {}).get("spec") or {}).get("containers") or [])
    matches = [container for container in containers if container.get("name") == container_name]
    if len(matches) != 1:
        raise SystemExit(f"deployment {deployment_name} must contain exactly one {container_name} container")
    actual_image = matches[0].get("image") or ""
    if actual_image != image_ref:
        raise SystemExit(f"deployment {deployment_name} image does not match provenance")
    pods_for_app = pod_items_by_app.get(container_name, [])
    ready_digest_pods = 0
    for pod in pods_for_app:
        for status_entry in (pod.get("status") or {}).get("containerStatuses") or []:
            if status_entry.get("name") == container_name and status_entry.get("ready") is True and digest_re.search(status_entry.get("imageID") or ""):
                ready_digest_pods += 1
    if ready_digest_pods < 1:
        raise SystemExit(f"deployment {deployment_name} has no ready pod with a digest imageID")

gamemaster = workloads_by_name.get("gaming-gamemaster-depl")
if not isinstance(gamemaster, dict):
    raise SystemExit("missing gaming-gamemaster-depl")
containers = ((((gamemaster.get("spec") or {}).get("template") or {}).get("spec") or {}).get("containers") or [])
gamemaster_containers = [container for container in containers if container.get("name") == "gaming-gamemaster"]
if len(gamemaster_containers) != 1:
    raise SystemExit("gaming-gamemaster deployment must contain exactly one gaming-gamemaster container")
flag_value = None
for env in gamemaster_containers[0].get("env") or []:
    if env.get("name") == "LIVE_KICKOFFS_ENABLED" and isinstance(env.get("value"), str):
        flag_value = env.get("value")
        break
if flag_value is None:
    raise SystemExit("LIVE_KICKOFFS_ENABLED must be explicitly set on gaming-gamemaster")
actual_flag = flag_value.strip().lower()
if actual_flag not in {"true", "false", "1", "0", "yes", "no", "on", "off"}:
    raise SystemExit("LIVE_KICKOFFS_ENABLED must be an explicit boolean value")
normalized_flag = "true" if actual_flag in {"true", "1", "yes", "on"} else "false"
if normalized_flag != expected_flag:
    raise SystemExit(f"LIVE_KICKOFFS_ENABLED expected {expected_flag} but found {normalized_flag}")

rabbit = workloads_by_name.get("gaming-rabbitmq-depl")
auth_mongo = workloads_by_name.get("gaming-auth-mongo-depl")
if not isinstance(rabbit, dict):
    raise SystemExit("missing gaming-rabbitmq-depl")
if not isinstance(auth_mongo, dict):
    raise SystemExit("missing gaming-auth-mongo-depl")
for name, workload in (("gaming-rabbitmq-depl", rabbit), ("gaming-auth-mongo-depl", auth_mongo)):
    spec = workload.get("spec") or {}
    status = workload.get("status") or {}
    replicas = int(spec.get("replicas") or 0)
    ready = int(status.get("readyReplicas") or status.get("availableReplicas") or 0)
    if replicas < 1 or ready != replicas:
        raise SystemExit(f"{name} is not fully ready")

print(f"image_provenance_rows={len(image_rows)}")
print(f"app_deployments_verified={len(image_rows)}/{len(image_rows)}")
print("aux_workloads_ready=2/2")
print(f"actual_live_kickoffs_enabled={normalized_flag}")
PY
  then
    live_betting_write_sanitized_file "$result_stderr" "$LIVE_BETTING_OUTPUT_DIR/workloads-check.stderr"
    live_betting_record_failure workload_images "$(cat "$result_stderr")"
    return 1
  fi
  live_betting_write_sanitized_file "$result_stderr" "$LIVE_BETTING_OUTPUT_DIR/workloads-check.stderr"
  while IFS='=' read -r key value; do
    [[ -n "$key" ]] || continue
    live_betting_apply_metric "$key" "$value"
  done <"$result_stdout"
  return 0
}

live_betting_check_rabbitmq() {
  local queue_file="$1"
  local result_stdout="$LIVE_BETTING_WORK_DIR/rabbit.result"
  local result_stderr="$LIVE_BETTING_WORK_DIR/rabbit.result.stderr"
  if ! python3 - "$queue_file" "$LIVE_BETTING_REQUIRED_LIVE_QUEUES" "$LIVE_BETTING_REQUIRED_LIVE_QUEUE_PREFIXES" "$LIVE_BETTING_MAX_LIVE_QUEUE_READY" "$LIVE_BETTING_MAX_LIVE_QUEUE_UNACK" "$LIVE_BETTING_MIN_DURABLE_QUEUE_CONSUMERS" "$LIVE_BETTING_MIN_DYNAMIC_QUEUE_CONSUMERS" >"$result_stdout" 2>"$result_stderr" <<'PY'
import sys
from pathlib import Path

queue_path, required_csv, prefix_csv, max_ready, max_unack, min_durable, min_dynamic = sys.argv[1:]
required = [item for item in required_csv.split(",") if item]
prefixes = [item for item in prefix_csv.split(",") if item]
rows = []
header_seen = False
for raw_line in Path(queue_path).read_text(encoding="utf-8").splitlines():
    line = raw_line.strip()
    if not line:
        continue
    parts = line.split()
    if parts == ["name", "messages_ready", "messages_unacknowledged", "consumers"]:
        if header_seen:
            raise SystemExit("duplicate RabbitMQ queue header")
        header_seen = True
        continue
    if len(parts) != 4:
        raise SystemExit("malformed RabbitMQ queue output")
    name, ready, unack, consumers = parts
    if not (ready.isdigit() and unack.isdigit() and consumers.isdigit()):
        raise SystemExit("RabbitMQ queue counts must be numeric")
    rows.append((name, int(ready), int(unack), int(consumers)))
index = {name: (ready, unack, consumers) for name, ready, unack, consumers in rows}
for queue in required:
    if queue not in index:
        raise SystemExit(f"required live queue missing: {queue}")
    ready, unack, consumers = index[queue]
    if consumers < int(min_durable):
        raise SystemExit(f"required live queue has no consumers: {queue}")
    if ready > int(max_ready):
        raise SystemExit(f"required live queue backlog exceeds bound: {queue}")
    if unack > int(max_unack):
        raise SystemExit(f"required live queue unacked exceeds bound: {queue}")
dynamic_rows = [row for row in rows if any(row[0].startswith(prefix) for prefix in prefixes)]
if prefixes and not dynamic_rows:
    raise SystemExit("pod-scoped live SSE queue is missing")
if prefixes:
    live_dynamic_consumers = sum(consumers for _, _, _, consumers in dynamic_rows)
    if live_dynamic_consumers < int(min_dynamic):
        raise SystemExit("pod-scoped live SSE queue has no consumers")
else:
    live_dynamic_consumers = 0
tracked_rows = [row for row in rows if row[0] in index and (row[0] in required or any(row[0].startswith(prefix) for prefix in prefixes))]
total_ready = sum(ready for _, ready, _, _ in tracked_rows)
total_unack = sum(unack for _, _, unack, _ in tracked_rows)
total_consumers = sum(consumers for _, _, _, consumers in tracked_rows)
if total_ready > int(max_ready) * max(1, len(required)):
    raise SystemExit("aggregate live queue ready backlog exceeds bound")
if total_unack > int(max_unack) * max(1, len(required)):
    raise SystemExit("aggregate live queue unacked exceeds bound")
print(f"rabbit_live_ready_messages={total_ready}")
print(f"rabbit_live_unacked_messages={total_unack}")
print(f"rabbit_live_consumers={total_consumers}")
print(f"rabbit_dynamic_queues={len(dynamic_rows)}")
PY
  then
    live_betting_write_sanitized_file "$result_stderr" "$LIVE_BETTING_OUTPUT_DIR/rabbitmq-check.stderr"
    live_betting_record_failure rabbitmq_queues "$(cat "$result_stderr")"
    return 1
  fi
  live_betting_write_sanitized_file "$result_stderr" "$LIVE_BETTING_OUTPUT_DIR/rabbitmq-check.stderr"
  while IFS='=' read -r key value; do
    [[ -n "$key" ]] || continue
    live_betting_apply_metric "$key" "$value"
  done <"$result_stdout"
  return 0
}

live_betting_check_topology() {
  local topology_file="$1"
  local lock_file="$2"
  local pvc_file="$3"
  local result_stdout="$LIVE_BETTING_WORK_DIR/topology.result"
  local result_stderr="$LIVE_BETTING_WORK_DIR/topology.result.stderr"
  if ! python3 - \
    "$topology_file" \
    "$lock_file" \
    "$pvc_file" \
    "$LIVE_BETTING_REQUIRED_MONGO_TOPOLOGY_MODE" \
    "$LIVE_BETTING_EXPECTED_SHARED_MONGO_PVC" \
    "$LIVE_BETTING_EXPECTED_OPERATION_LOCK_HOLDER" \
    "$LIVE_BETTING_EXPECTED_OPERATION_LOCK_ID" \
    "$LIVE_BETTING_EXPECTED_OPERATION_LOCK_SOURCE_SHA" \
    >"$result_stdout" 2>"$result_stderr" <<'PY'
import json
import sys
from pathlib import Path

(
    topology_path,
    lock_path,
    pvc_path,
    required_mode,
    expected_shared_pvc,
    expected_holder,
    expected_operation,
    expected_sha,
) = sys.argv[1:]
topology = json.loads(Path(topology_path).read_text(encoding="utf-8"))
topology_data = topology.get("data") or {}
mode = str(topology_data.get("mode", "legacy") or "legacy")
validated = str(topology_data.get("validated", "false") or "false").lower()
if required_mode and mode != required_mode:
    raise SystemExit(f"Mongo topology mode must be {required_mode}")
expect_active_lock = bool(expected_holder or expected_operation or expected_sha)
if mode == "shared":
    if validated != "true":
        raise SystemExit("shared Mongo topology must be validated")
    if expected_shared_pvc:
        if not pvc_path or not Path(pvc_path).is_file():
            raise SystemExit("shared Mongo PVC inventory is missing")
        pvc_payload = json.loads(Path(pvc_path).read_text(encoding="utf-8"))
        pvc_items = pvc_payload.get("items")
        if not isinstance(pvc_items, list):
            raise SystemExit("shared Mongo PVC inventory is invalid")
        mongo_pvcs = []
        for item in pvc_items:
            if not isinstance(item, dict):
                raise SystemExit("shared Mongo PVC inventory contains an invalid item")
            metadata = item.get("metadata") or {}
            status = item.get("status") or {}
            name = metadata.get("name")
            if isinstance(name, str) and "mongo" in name.lower():
                mongo_pvcs.append((name, str(status.get("phase", ""))))
        mongo_pvcs.sort()
        if [name for name, _phase in mongo_pvcs] != [expected_shared_pvc]:
            raise SystemExit("shared Mongo PVC inventory differs from the exact retained claim")
        pvc_phase = mongo_pvcs[0][1]
        if pvc_phase != "Bound":
            raise SystemExit("retained shared Mongo PVC is not Bound")
        print(f"mongo_pvc_name={expected_shared_pvc}")
        print(f"mongo_pvc_phase={pvc_phase}")
    lock_state = "missing"
    if Path(lock_path).exists():
        lock = json.loads(Path(lock_path).read_text(encoding="utf-8"))
        lock_data = lock.get("data") or {}
        lock_state = str(lock_data.get("state", "missing"))
        if expect_active_lock:
            if (
                lock_state != "active"
                or str(lock_data.get("holder", "")) != expected_holder
                or str(lock_data.get("operation-id", "")) != expected_operation
                or str(lock_data.get("source-sha", "")) != expected_sha
            ):
                raise SystemExit("shared Mongo operation lock differs from the expected active handoff")
        elif lock_state not in {"released", "missing", ""}:
            raise SystemExit("shared Mongo operation lock must be released")
        if lock_state == "":
            lock_state = "missing"
    elif expect_active_lock:
        raise SystemExit("expected shared Mongo operation lock is missing")
    print("topology_validated=true")
    print(f"lock_state={lock_state}")
elif mode == "legacy":
    print("topology_validated=not_applicable")
    print("lock_state=not_applicable")
else:
    raise SystemExit(f"unsupported Mongo topology mode: {mode}")
print(f"topology_mode={mode}")
PY
  then
    live_betting_write_sanitized_file "$result_stderr" "$LIVE_BETTING_OUTPUT_DIR/topology-check.stderr"
    live_betting_record_failure topology_lock "$(cat "$result_stderr")"
    return 1
  fi
  live_betting_write_sanitized_file "$result_stderr" "$LIVE_BETTING_OUTPUT_DIR/topology-check.stderr"
  while IFS='=' read -r key value; do
    [[ -n "$key" ]] || continue
    live_betting_apply_metric "$key" "$value"
  done <"$result_stdout"
  return 0
}

live_betting_pod_name_for_app() {
  local app="$1"
  local fallback="$2"
  local pod_name=""
  if [[ -n "${LIVE_BETTING_PODS_JSON_FILE:-}" && -f "$LIVE_BETTING_PODS_JSON_FILE" ]]; then
    pod_name="$(python3 - "$LIVE_BETTING_PODS_JSON_FILE" "$app" <<'PY'
import json
import sys
from pathlib import Path

pods_path, app_name = sys.argv[1:]
payload = json.loads(Path(pods_path).read_text(encoding="utf-8"))
for item in payload.get("items", []):
    labels = ((item.get("metadata") or {}).get("labels") or {})
    if labels.get("app") == app_name:
        print((item.get("metadata") or {}).get("name", ""))
        break
PY
 2>/dev/null || true)"
  fi
  printf '%s' "${pod_name:-$fallback}"
}

live_betting_mongo_pod_for_db() {
  local db_name="$1"
  local topology_mode="${LIVE_BETTING_TOPOLOGY_MODE:-legacy}"
  if [[ "$db_name" == "gaming_auth" || "$topology_mode" == "shared" ]]; then
    live_betting_pod_name_for_app "gaming-auth-mongo" "gaming-auth-mongo-depl-0"
    return 0
  fi
  if [[ "$topology_mode" == "legacy" ]]; then
    local service="${db_name#gaming_}"
    service="${service//_/-}"
    live_betting_pod_name_for_app "gaming-${service}-mongo" "gaming-${service}-mongo-depl-0"
    return 0
  fi
  printf 'unsupported Mongo topology mode: %s\n' "$topology_mode" >&2
  return 1
}

live_betting_exec_mongo_query() {
  local label="$1"
  local db_name="$2"
  local script="$3"
  local output_file="$4"
  local stderr_file="$LIVE_BETTING_WORK_DIR/${label}.stderr"
  local pod_name
  if ! pod_name="$(live_betting_mongo_pod_for_db "$db_name" 2>"$stderr_file")"; then
    live_betting_write_sanitized_file "$stderr_file" "$LIVE_BETTING_OUTPUT_DIR/${label}.stderr"
    return 1
  fi
  if kubectl --request-timeout="$LIVE_BETTING_KUBECTL_TIMEOUT" exec -n "$LIVE_BETTING_NAMESPACE" "$pod_name" -- \
      mongosh --quiet --norc --eval "$script" >"$output_file" 2>"$stderr_file"; then
    live_betting_write_sanitized_file "$stderr_file" "$LIVE_BETTING_OUTPUT_DIR/${label}.stderr"
    live_betting_write_sanitized_file "$output_file" "$LIVE_BETTING_OUTPUT_DIR/${label}.json"
    return 0
  fi
  live_betting_write_sanitized_file "$stderr_file" "$LIVE_BETTING_OUTPUT_DIR/${label}.stderr"
  return 1
}

live_betting_check_mongo_observability() {
  local active_file="$1"
  local slips_file="$2"
  local bet_file="$3"
  local moderation_file="$4"
  local pending_result_file="$5"
  local retry_file="$6"
  local report_file="$7"
  local result_stdout="$LIVE_BETTING_WORK_DIR/mongo.result"
  local result_stderr="$LIVE_BETTING_WORK_DIR/mongo.result.stderr"
  if ! python3 - \
      "$active_file" \
      "$slips_file" \
      "$bet_file" \
      "$moderation_file" \
      "$pending_result_file" \
      "$retry_file" \
      "$report_file" \
      "$LIVE_BETTING_MAX_ACTIVE_MATCHES" \
      "$LIVE_BETTING_MAX_OVERDUE_UNSTARTED_EVENTS" \
      "$LIVE_BETTING_MAX_SIMULATION_QUARANTINES" \
      "$LIVE_BETTING_MAX_SUBMITTED_LIVE_SLIPS" \
      "$LIVE_BETTING_MAX_DRAFT_LIVE_SLIPS" \
      "$LIVE_BETTING_MAX_WORKFLOW_PENDING_COUNT" \
      "$LIVE_BETTING_MAX_WORKFLOW_PENDING_AGE_SECONDS" \
      "$LIVE_BETTING_MAX_WORKFLOW_PROCESSING_COUNT" \
      "$LIVE_BETTING_MAX_WORKFLOW_PROCESSING_AGE_SECONDS" \
      >"$result_stdout" 2>"$result_stderr" <<'PY'
import json
import sys
from pathlib import Path

(
    active_path,
    slips_path,
    bet_path,
    moderation_path,
    pending_result_path,
    retry_path,
    report_path,
    max_matches,
    max_overdue_unstarted,
    max_simulation_quarantines,
    max_slips,
    max_draft_slips,
    pending_limit,
    pending_age_limit,
    processing_limit,
    processing_age_limit,
) = sys.argv[1:]


def load_json(path: str, label: str):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        raise SystemExit(f"{label} output is invalid JSON") from exc


def normalize_collection_payload(payload: dict, include_dead_letter: bool = False) -> dict:
    if not isinstance(payload, dict):
        return payload
    payload_keys = set(payload.keys())
    if payload_keys <= {
        "mongoOk",
        "activeMatches",
        "overdueUnstartedEvents",
        "simulationQuarantines",
        "submittedLiveSlips",
        "draftLiveSlips",
    } and "mongoOk" in payload:
        normalized = {
            "mongoOk": payload.get("mongoOk"),
            "pending": {"count": 0, "oldestAgeSeconds": 0},
            "processing": {"count": 0, "oldestAgeSeconds": 0},
            "exhausted": {"count": 0, "oldestAgeSeconds": 0},
        }
        if include_dead_letter:
            normalized["deadLetter"] = {"count": 0, "oldestAgeSeconds": 0}
        return normalized
    if include_dead_letter and "deadLetter" in payload and "exhausted" not in payload:
        normalized = dict(payload)
        normalized["exhausted"] = payload["deadLetter"]
        return normalized
    return payload


def require_non_negative_int(value, label: str) -> int:
    if not isinstance(value, int) or value < 0:
        raise SystemExit(f"{label} must be a non-negative integer")
    return value


def require_status_block(payload: dict, collection_label: str, status_label: str) -> tuple[int, int]:
    block = payload.get(status_label)
    if not isinstance(block, dict):
        raise SystemExit(f"{collection_label} {status_label} block is missing")
    count = require_non_negative_int(block.get("count"), f"{collection_label} {status_label} count")
    age = require_non_negative_int(
        block.get("oldestAgeSeconds"),
        f"{collection_label} {status_label} oldestAgeSeconds",
    )
    if count == 0 and age != 0:
        raise SystemExit(f"{collection_label} {status_label} age must be zero when count is zero")
    return count, age


active_payload = load_json(active_path, "active-match query")
slips_payload = load_json(slips_path, "submitted-slip query")
bet_payload = normalize_collection_payload(load_json(bet_path, "PendingBetUpdate query"))
moderation_payload = normalize_collection_payload(load_json(moderation_path, "ParkedPlaceBet query"))
pending_result_payload = normalize_collection_payload(load_json(pending_result_path, "PendingModerationResult query"))
retry_payload = normalize_collection_payload(load_json(retry_path, "RetryRecord query"), include_dead_letter=True)

for label, payload in (
    ("active-match query", active_payload),
    ("submitted-slip query", slips_payload),
    ("PendingBetUpdate query", bet_payload),
    ("ParkedPlaceBet query", moderation_payload),
    ("PendingModerationResult query", pending_result_payload),
    ("RetryRecord query", retry_payload),
):
    if payload.get("mongoOk") is not True:
        raise SystemExit(f"{label} ping check failed")

active_matches = require_non_negative_int(active_payload.get("activeMatches"), "activeMatches")
overdue_unstarted_events = require_non_negative_int(
    active_payload.get("overdueUnstartedEvents"),
    "overdueUnstartedEvents",
)
simulation_quarantines = require_non_negative_int(
    active_payload.get("simulationQuarantines"),
    "simulationQuarantines",
)
submitted_live_slips = require_non_negative_int(
    slips_payload.get("submittedLiveSlips"),
    "submittedLiveSlips",
)
draft_live_slips = require_non_negative_int(
    slips_payload.get("draftLiveSlips"),
    "draftLiveSlips",
)
if active_matches > int(max_matches):
    raise SystemExit("active live match count exceeds bound")
if overdue_unstarted_events > int(max_overdue_unstarted):
    raise SystemExit("overdue unstarted event count exceeds bound")
if simulation_quarantines > int(max_simulation_quarantines):
    raise SystemExit("simulation quarantine count exceeds bound")
if submitted_live_slips > int(max_slips):
    raise SystemExit("submitted live slip count exceeds bound")
if draft_live_slips > int(max_draft_slips):
    raise SystemExit("draft live slip count exceeds bound")

parking_metrics = {
    "bet_pending_bet_update": {
        "pending": require_status_block(bet_payload, "PendingBetUpdate", "pending"),
        "processing": require_status_block(bet_payload, "PendingBetUpdate", "processing"),
        "exhausted": require_status_block(bet_payload, "PendingBetUpdate", "exhausted"),
    },
    "moderation_parked_place_bet": {
        "pending": require_status_block(moderation_payload, "ParkedPlaceBet", "pending"),
        "processing": require_status_block(moderation_payload, "ParkedPlaceBet", "processing"),
        "exhausted": require_status_block(moderation_payload, "ParkedPlaceBet", "exhausted"),
    },
    "resulting_pending_moderation_result": {
        "pending": require_status_block(
            pending_result_payload,
            "PendingModerationResult",
            "pending",
        ),
        "processing": require_status_block(
            pending_result_payload,
            "PendingModerationResult",
            "processing",
        ),
        "exhausted": require_status_block(
            pending_result_payload,
            "PendingModerationResult",
            "exhausted",
        ),
    },
    "resulting_retry_record": {
        "pending": require_status_block(retry_payload, "RetryRecord", "pending"),
        "processing": require_status_block(retry_payload, "RetryRecord", "processing"),
        "exhausted": require_status_block(retry_payload, "RetryRecord", "exhausted"),
    },
}

retry_dead_letter = require_status_block(retry_payload, "RetryRecord", "deadLetter")
if retry_dead_letter != parking_metrics["resulting_retry_record"]["exhausted"]:
    raise SystemExit("RetryRecord deadLetter summary must match exhausted summary")

for collection_label, status_blocks in parking_metrics.items():
    pending_count, pending_age = status_blocks["pending"]
    processing_count, processing_age = status_blocks["processing"]
    exhausted_count, _exhausted_age = status_blocks["exhausted"]
    if pending_count > int(pending_limit):
        raise SystemExit(f"{collection_label} pending count exceeds bound")
    if pending_age > int(pending_age_limit):
        raise SystemExit(f"{collection_label} pending age exceeds bound")
    if processing_count > int(processing_limit):
        raise SystemExit(f"{collection_label} processing count exceeds bound")
    if processing_age > int(processing_age_limit):
        raise SystemExit(f"{collection_label} processing age exceeds bound")
    if exhausted_count > 0:
        raise SystemExit(f"{collection_label} exhausted count exceeds bound")

report = {
    "active_matches": active_matches,
    "overdue_unstarted_events": overdue_unstarted_events,
    "simulation_quarantines": simulation_quarantines,
    "submitted_live_slips": submitted_live_slips,
    "draft_live_slips": draft_live_slips,
    "limits": {
        "workflow_pending_count_limit": int(pending_limit),
        "workflow_pending_age_limit_seconds": int(pending_age_limit),
        "workflow_processing_count_limit": int(processing_limit),
        "workflow_processing_age_limit_seconds": int(processing_age_limit),
        "workflow_exhausted_count_limit": 0,
    },
    "collections": {
        **{
            label: {
                status: {"count": count, "oldestAgeSeconds": age}
                for status, (count, age) in statuses.items()
            }
            for label, statuses in parking_metrics.items()
        },
        "resulting_retry_record_dead_letter": {
            "count": retry_dead_letter[0],
            "oldestAgeSeconds": retry_dead_letter[1],
        },
    },
}
Path(report_path).write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")

print("mongo_ping_ok=true")
print(f"active_matches={active_matches}")
print(f"overdue_unstarted_events={overdue_unstarted_events}")
print(f"simulation_quarantines={simulation_quarantines}")
print(f"submitted_live_slips={submitted_live_slips}")
print(f"draft_live_slips={draft_live_slips}")
print(f"workflow_pending_count_limit={int(pending_limit)}")
print(f"workflow_pending_age_limit_seconds={int(pending_age_limit)}")
print(f"workflow_processing_count_limit={int(processing_limit)}")
print(f"workflow_processing_age_limit_seconds={int(processing_age_limit)}")
print("workflow_exhausted_count_limit=0")
for collection_label, statuses in parking_metrics.items():
    for status_label, (count, age) in statuses.items():
        print(f"{collection_label}_{status_label}_count={count}")
        print(f"{collection_label}_{status_label}_oldest_age_seconds={age}")
print(f"resulting_retry_record_dead_letter_count={retry_dead_letter[0]}")
print(f"resulting_retry_record_dead_letter_oldest_age_seconds={retry_dead_letter[1]}")
PY
  then
    live_betting_write_sanitized_file "$result_stderr" "$LIVE_BETTING_OUTPUT_DIR/mongo-check.stderr"
    case "$(cat "$result_stderr")" in
      active\ live\ match\ count*|overdue\ unstarted\ event\ count*|simulation\ quarantine\ count*|submitted\ live\ slip\ count*|draft\ live\ slip\ count*|activeMatches*|overdueUnstartedEvents*|simulationQuarantines*|submittedLiveSlips*|draftLiveSlips*|active-match\ query*|submitted-slip\ query*)
        live_betting_record_failure mongo_counts "$(cat "$result_stderr")"
        ;;
      *)
        live_betting_record_failure mongo_workflow_parking "$(cat "$result_stderr")"
        ;;
    esac
    return 1
  fi
  live_betting_write_sanitized_file "$result_stderr" "$LIVE_BETTING_OUTPUT_DIR/mongo-check.stderr"
  live_betting_write_sanitized_file "$report_file" "$LIVE_BETTING_OUTPUT_DIR/workflow-parking.json"
  while IFS='=' read -r key value; do
    [[ -n "$key" ]] || continue
    live_betting_apply_metric "$key" "$value"
  done <"$result_stdout"
  return 0
}

live_betting_first_env_value() {
  local file="$1"
  shift
  python3 - "$file" "$@" <<'PY'
import sys
from pathlib import Path

path = Path(sys.argv[1])
keys = sys.argv[2:]
values = {}
for raw_line in path.read_text(encoding="utf-8").splitlines():
    if "=" not in raw_line:
        continue
    key, value = raw_line.split("=", 1)
    values.setdefault(key, value)
for key in keys:
    value = values.get(key)
    if value is not None and value != "":
        print(value)
        break
PY
}

live_betting_check_exact_master_provenance() {
  if [[ "$LIVE_BETTING_MODE" != "activate" ]]; then
    return 0
  fi
  if [[ -z "$LIVE_BETTING_EXACT_MASTER_PROVENANCE_FILE" || ! -f "$LIVE_BETTING_EXACT_MASTER_PROVENANCE_FILE" ]]; then
    live_betting_record_failure exact_master_provenance "EXACT_MASTER_PROVENANCE_FILE is required in activate mode"
    return 1
  fi
  local source_sha source_ref run_attempt
  source_sha="$(live_betting_first_env_value "$LIVE_BETTING_EXACT_MASTER_PROVENANCE_FILE" runtime_deploy_source_sha image_sha source_sha)"
  source_ref="$(live_betting_first_env_value "$LIVE_BETTING_EXACT_MASTER_PROVENANCE_FILE" source_ref ref head_branch branch)"
  run_attempt="$(live_betting_first_env_value "$LIVE_BETTING_EXACT_MASTER_PROVENANCE_FILE" build_run_attempt upstream_run_attempt run_attempt)"
  if ! [[ "$source_sha" =~ ^[0-9a-f]{40}$ ]]; then
    live_betting_record_failure exact_master_provenance "exact-master provenance must contain a full lowercase source SHA"
    return 1
  fi
  case "$source_ref" in
    master|refs/heads/master|origin/master) ;;
    *)
      live_betting_record_failure exact_master_provenance "exact-master provenance must bind to master"
      return 1
      ;;
  esac
  [[ "$run_attempt" == "1" ]] || {
    live_betting_record_failure exact_master_provenance "exact-master provenance must come from attempt 1"
    return 1
  }
  LIVE_BETTING_PROVENANCE_SOURCE_SHA="$source_sha"
  return 0
}

live_betting_check_schema_evidence() {
  if [[ "$LIVE_BETTING_MODE" != "activate" ]]; then
    return 0
  fi
  if [[ -z "$LIVE_BETTING_SCHEMA_EVIDENCE_FILE" || ! -f "$LIVE_BETTING_SCHEMA_EVIDENCE_FILE" ]]; then
    live_betting_record_failure schema_backfill_index "LIVE_SCHEMA_EVIDENCE_FILE is required in activate mode"
    return 1
  fi
  local schema_version backfill_complete index_ready
  schema_version="$(live_betting_first_env_value "$LIVE_BETTING_SCHEMA_EVIDENCE_FILE" schema_version)"
  backfill_complete="$(live_betting_first_env_value "$LIVE_BETTING_SCHEMA_EVIDENCE_FILE" backfill_complete)"
  index_ready="$(live_betting_first_env_value "$LIVE_BETTING_SCHEMA_EVIDENCE_FILE" index_ready)"
  [[ -n "$schema_version" ]] || {
    live_betting_record_failure schema_backfill_index "schema evidence must contain schema_version"
    return 1
  }
  [[ "$(live_betting_normalize_bool "$backfill_complete")" == "true" ]] || {
    live_betting_record_failure schema_backfill_index "schema evidence must confirm completed backfill"
    return 1
  }
  [[ "$(live_betting_normalize_bool "$index_ready")" == "true" ]] || {
    live_betting_record_failure schema_backfill_index "schema evidence must confirm ready indexes"
    return 1
  }
  LIVE_BETTING_SCHEMA_EVIDENCE_VERIFIED="true"
  return 0
}

live_betting_check_rollback_baseline() {
  if [[ "$LIVE_BETTING_MODE" != "activate" ]]; then
    return 0
  fi
  if [[ -z "$LIVE_BETTING_ROLLBACK_BASELINE_FILE" || ! -f "$LIVE_BETTING_ROLLBACK_BASELINE_FILE" ]]; then
    live_betting_record_failure rollback_baseline "ROLLBACK_BASELINE_FILE is required in activate mode"
    return 1
  fi
  local readiness mode flag active_matches submitted_live_slips
  readiness="$(live_betting_first_env_value "$LIVE_BETTING_ROLLBACK_BASELINE_FILE" live_betting_readiness)"
  mode="$(live_betting_first_env_value "$LIVE_BETTING_ROLLBACK_BASELINE_FILE" mode)"
  flag="$(live_betting_first_env_value "$LIVE_BETTING_ROLLBACK_BASELINE_FILE" actual_live_kickoffs_enabled)"
  active_matches="$(live_betting_first_env_value "$LIVE_BETTING_ROLLBACK_BASELINE_FILE" active_matches)"
  submitted_live_slips="$(live_betting_first_env_value "$LIVE_BETTING_ROLLBACK_BASELINE_FILE" submitted_live_slips)"
  [[ "$readiness" == "GO" ]] || {
    live_betting_record_failure rollback_baseline "rollback baseline must come from a GO dark readiness summary"
    return 1
  }
  [[ "$mode" == "dark" ]] || {
    live_betting_record_failure rollback_baseline "rollback baseline must come from dark mode"
    return 1
  }
  [[ "$flag" == "false" ]] || {
    live_betting_record_failure rollback_baseline "rollback baseline must confirm LIVE_KICKOFFS_ENABLED=false"
    return 1
  }
  [[ "$active_matches" == "0" ]] || {
    live_betting_record_failure rollback_baseline "rollback baseline must confirm zero active matches"
    return 1
  }
  [[ "$submitted_live_slips" == "0" ]] || {
    live_betting_record_failure rollback_baseline "rollback baseline must confirm zero submitted live slips"
    return 1
  }
  LIVE_BETTING_ROLLBACK_BASELINE_VERIFIED="true"
  return 0
}

live_betting_check_event_endpoint() {
  local label="$1"
  local url="$2"
  local prefix="$3"
  local status body headers summary content_type
  if ! status="$(live_betting_http_request "$label" "${url}${LIVE_BETTING_EVENT_API_PATH}")"; then
    live_betting_record_failure legacy_prematch_api "event REST request failed for $prefix"
    return 1
  fi
  body="$LIVE_BETTING_WORK_DIR/${label}.body"
  headers="$LIVE_BETTING_WORK_DIR/${label}.headers"
  content_type="$(live_betting_header_value "$headers" Content-Type)"
  if [[ "$status" != "200" ]]; then
    live_betting_record_failure legacy_prematch_api "event REST returned HTTP $status for $prefix"
    return 1
  fi
  [[ "$content_type" == application/json* ]] || {
    live_betting_record_failure legacy_prematch_api "event REST returned non-JSON content for $prefix"
    return 1
  }
  summary="$LIVE_BETTING_OUTPUT_DIR/${label}.summary.json"
  if ! live_betting_write_http_summary "$body" "$headers" "$summary" legacy-prematch-events 2>"$LIVE_BETTING_WORK_DIR/${label}.summary.stderr"; then
    live_betting_write_sanitized_file "$LIVE_BETTING_WORK_DIR/${label}.summary.stderr" "$LIVE_BETTING_OUTPUT_DIR/${label}.summary.stderr"
    live_betting_record_failure legacy_prematch_api "event REST legacy PRE_MATCH contract is incompatible for $prefix"
    return 1
  fi
  local items legacy_events legacy_1x2 legacy_correct_score legacy_event_id
  read -r items legacy_events legacy_1x2 legacy_correct_score legacy_event_id < <(python3 - "$summary" <<'PY'
import json,sys
payload=json.load(open(sys.argv[1], encoding='utf-8'))
print(
    payload.get('items', 'unknown'),
    payload.get('legacy_prematch_events', '0'),
    payload.get('legacy_prematch_1x2_odds', '0'),
    payload.get('legacy_prematch_correct_score_odds', '0'),
    payload.get('legacy_prematch_event_id', 'unknown'),
)
PY
)
  if [[ "$prefix" == public ]]; then
    LIVE_BETTING_PUBLIC_EVENT_STATUS="$status"
    LIVE_BETTING_PUBLIC_EVENT_ITEMS="$items"
    LIVE_BETTING_LEGACY_PREMATCH_EVENTS="$legacy_events"
    LIVE_BETTING_LEGACY_PREMATCH_1X2_ODDS="$legacy_1x2"
    LIVE_BETTING_LEGACY_PREMATCH_CORRECT_SCORE_ODDS="$legacy_correct_score"
    LIVE_BETTING_LEGACY_PREMATCH_EVENT_ID="$legacy_event_id"
  else
    LIVE_BETTING_DIAGNOSTIC_EVENT_STATUS="$status"
  fi
  return 0
}

live_betting_check_current_user_endpoint() {
  local label="$1"
  local url="$2"
  local prefix="$3"
  local status body headers summary content_type current_user_type
  if ! status="$(live_betting_http_request "$label" "${url}${LIVE_BETTING_CURRENT_USER_PATH}")"; then
    live_betting_record_failure current_user_api "current-user request failed for $prefix"
    return 1
  fi
  body="$LIVE_BETTING_WORK_DIR/${label}.body"
  headers="$LIVE_BETTING_WORK_DIR/${label}.headers"
  content_type="$(live_betting_header_value "$headers" Content-Type)"
  if [[ "$status" != "200" ]]; then
    live_betting_record_failure current_user_api "current-user returned HTTP $status for $prefix"
    return 1
  fi
  [[ "$content_type" == application/json* ]] || {
    live_betting_record_failure current_user_api "current-user returned non-JSON content for $prefix"
    return 1
  }
  summary="$LIVE_BETTING_OUTPUT_DIR/${label}.summary.json"
  if ! live_betting_write_http_summary "$body" "$headers" "$summary" current-user 2>"$LIVE_BETTING_WORK_DIR/${label}.summary.stderr"; then
    live_betting_write_sanitized_file "$LIVE_BETTING_WORK_DIR/${label}.summary.stderr" "$LIVE_BETTING_OUTPUT_DIR/${label}.summary.stderr"
    live_betting_record_failure current_user_api "current-user JSON shape is incompatible for $prefix"
    return 1
  fi
  current_user_type="$(python3 - "$summary" <<'PY'
import json,sys
payload=json.load(open(sys.argv[1], encoding='utf-8'))
print(payload.get('currentUser_type', 'unknown'))
PY
)"
  if [[ "$prefix" == public ]]; then
    LIVE_BETTING_PUBLIC_CURRENTUSER_STATUS="$status"
    LIVE_BETTING_PUBLIC_CURRENTUSER_TYPE="$current_user_type"
  else
    LIVE_BETTING_DIAGNOSTIC_CURRENTUSER_STATUS="$status"
  fi
  return 0
}

live_betting_check_secondary_redirect() {
  [[ -n "$LIVE_BETTING_SECONDARY_PUBLIC_URL" ]] || return 0
  local probe_path="${LIVE_BETTING_CURRENT_USER_PATH}?live-betting-redirect=1"
  local label="secondary-redirect"
  local body="$LIVE_BETTING_WORK_DIR/${label}.body"
  local headers="$LIVE_BETTING_WORK_DIR/${label}.headers"
  local stderr_file="$LIVE_BETTING_WORK_DIR/${label}.stderr"
  local status=""
  if ! status="$(curl --silent --show-error --max-time "$LIVE_BETTING_REQUEST_TIMEOUT" --output "$body" --dump-header "$headers" --write-out '%{http_code}' "${LIVE_BETTING_SECONDARY_PUBLIC_URL}${probe_path}" 2>"$stderr_file")"; then
    live_betting_write_sanitized_file "$stderr_file" "$LIVE_BETTING_OUTPUT_DIR/${label}.stderr"
    live_betting_record_failure public_hosts "secondary public host request failed"
    return 1
  fi
  live_betting_write_sanitized_file "$stderr_file" "$LIVE_BETTING_OUTPUT_DIR/${label}.stderr"
  local location expected_location
  location="$(live_betting_header_value "$headers" Location)"
  expected_location="${LIVE_BETTING_BASE_URL}${probe_path}"
  case "$status" in
    301|302|307|308) ;;
    *)
      live_betting_record_failure public_hosts "secondary public host must redirect to the primary host"
      return 1
      ;;
  esac
  [[ "$location" == "$expected_location" ]] || {
    live_betting_record_failure public_hosts "secondary public host redirect target is incompatible"
    return 1
  }
  LIVE_BETTING_SECONDARY_REDIRECT_STATUS="$status"
  live_betting_write_http_summary "$body" "$headers" "$LIVE_BETTING_OUTPUT_DIR/${label}.summary.json" current-user 2>/dev/null || true
  return 0
}

live_betting_check_sse_endpoint() {
  local label="$1"
  local url="$2"
  local prefix="$3"
  local result rc status body headers content_type cache_control no_buffer summary heartbeat_count
  result="$(live_betting_sse_request "$label" "${url}${LIVE_BETTING_SSE_PATH}")" || {
    live_betting_record_failure sse_contract "SSE request failed for $prefix"
    return 1
  }
  rc="${result%%$'\t'*}"
  status="${result#*$'\t'}"
  body="$LIVE_BETTING_WORK_DIR/${label}.body"
  headers="$LIVE_BETTING_WORK_DIR/${label}.headers"
  if [[ "$LIVE_BETTING_MODE" == "rollback-drain" && "$LIVE_BETTING_SSE_REQUIRED" == "false" &&
      "$rc" == "0" && ( "$status" == "404" || "$status" == "502" ) ]]; then
    if [[ "$prefix" == public ]]; then
      LIVE_BETTING_SSE_PRIMARY_STATUS="legacy-absent:$status"
      LIVE_BETTING_SSE_PRIMARY_HEARTBEAT="not_required"
    else
      LIVE_BETTING_SSE_DIAGNOSTIC_STATUS="legacy-absent:$status"
      LIVE_BETTING_SSE_DIAGNOSTIC_HEARTBEAT="not_required"
    fi
    return 0
  fi
  content_type="$(live_betting_header_value "$headers" Content-Type)"
  cache_control="$(live_betting_header_value "$headers" Cache-Control)"
  no_buffer="$(live_betting_header_value "$headers" X-Accel-Buffering)"
  summary="$LIVE_BETTING_OUTPUT_DIR/${label}.summary.json"
  if ! live_betting_write_http_summary "$body" "$headers" "$summary" sse 2>"$LIVE_BETTING_WORK_DIR/${label}.summary.stderr"; then
    live_betting_write_sanitized_file "$LIVE_BETTING_WORK_DIR/${label}.summary.stderr" "$LIVE_BETTING_OUTPUT_DIR/${label}.summary.stderr"
    live_betting_record_failure sse_contract "SSE body could not be summarized for $prefix"
    return 1
  fi
  heartbeat_count="$(python3 - "$summary" <<'PY'
import json,sys
payload=json.load(open(sys.argv[1], encoding='utf-8'))
print(payload.get('heartbeat_count', 0))
PY
)"
  [[ "$status" == "200" ]] || {
    live_betting_record_failure sse_contract "SSE returned HTTP $status for $prefix"
    return 1
  }
  [[ "$content_type" == text/event-stream* ]] || {
    live_betting_record_failure sse_contract "SSE content type is incompatible for $prefix"
    return 1
  }
  [[ "$cache_control" == *no-cache* ]] || {
    live_betting_record_failure sse_contract "SSE cache-control must include no-cache for $prefix"
    return 1
  }
  [[ "$no_buffer" == "no" ]] || {
    live_betting_record_failure sse_contract "SSE must disable buffering for $prefix"
    return 1
  }
  [[ "$heartbeat_count" =~ ^[1-9][0-9]*$ ]] || {
    live_betting_record_failure sse_contract "SSE heartbeat was not observed for $prefix"
    return 1
  }
  if [[ "$prefix" == public ]]; then
    LIVE_BETTING_SSE_PRIMARY_STATUS="$status"
    LIVE_BETTING_SSE_PRIMARY_HEARTBEAT="$heartbeat_count"
  else
    LIVE_BETTING_SSE_DIAGNOSTIC_STATUS="$status"
    LIVE_BETTING_SSE_DIAGNOSTIC_HEARTBEAT="$heartbeat_count"
  fi
  return 0
}

live_betting_write_summary() {
  local readiness="$1"
  cat >"$LIVE_BETTING_SUMMARY_FILE" <<EOF_SUMMARY
summary_version=live-betting-readiness.v1
live_betting_readiness=$readiness
stack=$LIVE_BETTING_STACK
mode=$LIVE_BETTING_MODE
diagnostics_dir=$LIVE_BETTING_OUTPUT_DIR
failed_checks=${LIVE_BETTING_FAILED_CHECKS:-none}
expected_live_kickoffs_enabled=$LIVE_BETTING_EXPECTED_FLAG
actual_live_kickoffs_enabled=$LIVE_BETTING_ACTUAL_FLAG
image_provenance_rows=$LIVE_BETTING_IMAGE_PROVENANCE_ROWS
app_deployments_verified=$LIVE_BETTING_APP_DEPLOYMENTS_VERIFIED
aux_workloads_ready=$LIVE_BETTING_AUX_WORKLOADS_READY
topology_mode=$LIVE_BETTING_TOPOLOGY_MODE
topology_validated=$LIVE_BETTING_TOPOLOGY_VALIDATED
lock_state=$LIVE_BETTING_LOCK_STATE
mongo_pvc_name=$LIVE_BETTING_MONGO_PVC_NAME
mongo_pvc_phase=$LIVE_BETTING_MONGO_PVC_PHASE
rabbit_live_ready_messages=$LIVE_BETTING_RABBIT_READY
rabbit_live_unacked_messages=$LIVE_BETTING_RABBIT_UNACK
rabbit_live_consumers=$LIVE_BETTING_RABBIT_CONSUMERS
rabbit_dynamic_queues=$LIVE_BETTING_RABBIT_DYNAMIC_QUEUES
mongo_ping_ok=$LIVE_BETTING_MONGO_PING_OK
active_matches=$LIVE_BETTING_ACTIVE_MATCHES
overdue_unstarted_events=$LIVE_BETTING_OVERDUE_UNSTARTED_EVENTS
simulation_quarantines=$LIVE_BETTING_SIMULATION_QUARANTINES
unstarted_event_grace_seconds=$LIVE_BETTING_UNSTARTED_EVENT_GRACE_SECONDS
submitted_live_slips=$LIVE_BETTING_SUBMITTED_LIVE_SLIPS
draft_live_slips=$LIVE_BETTING_DRAFT_LIVE_SLIPS
public_event_status=$LIVE_BETTING_PUBLIC_EVENT_STATUS
public_event_items=$LIVE_BETTING_PUBLIC_EVENT_ITEMS
event_rest_json_status=$LIVE_BETTING_PUBLIC_EVENT_STATUS
legacy_prematch_api_status=$LIVE_BETTING_PUBLIC_EVENT_STATUS
legacy_prematch_events=$LIVE_BETTING_LEGACY_PREMATCH_EVENTS
legacy_prematch_event_id=$LIVE_BETTING_LEGACY_PREMATCH_EVENT_ID
legacy_prematch_1x2_odds=$LIVE_BETTING_LEGACY_PREMATCH_1X2_ODDS
legacy_prematch_correct_score_odds=$LIVE_BETTING_LEGACY_PREMATCH_CORRECT_SCORE_ODDS
public_current_user_status=$LIVE_BETTING_PUBLIC_CURRENTUSER_STATUS
public_current_user_type=$LIVE_BETTING_PUBLIC_CURRENTUSER_TYPE
diagnostic_event_status=$LIVE_BETTING_DIAGNOSTIC_EVENT_STATUS
diagnostic_current_user_status=$LIVE_BETTING_DIAGNOSTIC_CURRENTUSER_STATUS
secondary_redirect_status=$LIVE_BETTING_SECONDARY_REDIRECT_STATUS
sse_primary_status=$LIVE_BETTING_SSE_PRIMARY_STATUS
sse_primary_heartbeat=$LIVE_BETTING_SSE_PRIMARY_HEARTBEAT
sse_diagnostic_status=$LIVE_BETTING_SSE_DIAGNOSTIC_STATUS
sse_diagnostic_heartbeat=$LIVE_BETTING_SSE_DIAGNOSTIC_HEARTBEAT
sse_required=$LIVE_BETTING_SSE_REQUIRED
provenance_source_sha=$LIVE_BETTING_PROVENANCE_SOURCE_SHA
schema_evidence_verified=$LIVE_BETTING_SCHEMA_EVIDENCE_VERIFIED
rollback_baseline_verified=$LIVE_BETTING_ROLLBACK_BASELINE_VERIFIED
EOF_SUMMARY
  if [[ -s "${LIVE_BETTING_ADDITIONAL_SUMMARY_FILE:-}" ]]; then
    cat "$LIVE_BETTING_ADDITIONAL_SUMMARY_FILE" >>"$LIVE_BETTING_SUMMARY_FILE"
  fi
  cat "$LIVE_BETTING_SUMMARY_FILE"
}

live_betting_readiness_main() {
  umask 077
  LIVE_BETTING_ROOT_DIR="${ROOT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}"
  LIVE_BETTING_STACK="${LIVE_BETTING_STACK:-unknown}"
  LIVE_BETTING_MODE="${MODE:-dark}"
  LIVE_BETTING_BASE_URL="$(live_betting_trim_trailing_slash "${BASE_URL:-}")"
  LIVE_BETTING_SECONDARY_PUBLIC_URL="$(live_betting_trim_trailing_slash "${SECONDARY_PUBLIC_URL:-}")"
  LIVE_BETTING_DIAGNOSTIC_URL="$(live_betting_trim_trailing_slash "${DIAGNOSTIC_URL:-}")"
  LIVE_BETTING_REQUEST_TIMEOUT="${REQUEST_TIMEOUT:-15}"
  LIVE_BETTING_SSE_TIMEOUT="${SSE_TIMEOUT:-20}"
  LIVE_BETTING_KUBECTL_TIMEOUT="${KUBECTL_TIMEOUT:-15s}"
  LIVE_BETTING_NAMESPACE="${NAMESPACE:-default}"
  LIVE_BETTING_IMAGE_PROVENANCE_FILE="${IMAGE_PROVENANCE_FILE:-}"
  LIVE_BETTING_EXACT_MASTER_PROVENANCE_FILE="${EXACT_MASTER_PROVENANCE_FILE:-}"
  LIVE_BETTING_SCHEMA_EVIDENCE_FILE="${LIVE_SCHEMA_EVIDENCE_FILE:-}"
  LIVE_BETTING_ROLLBACK_BASELINE_FILE="${ROLLBACK_BASELINE_FILE:-}"
  LIVE_BETTING_EXPECTED_OPERATION_LOCK_HOLDER="${EXPECTED_OPERATION_LOCK_HOLDER:-}"
  LIVE_BETTING_EXPECTED_OPERATION_LOCK_ID="${EXPECTED_OPERATION_LOCK_ID:-}"
  LIVE_BETTING_EXPECTED_OPERATION_LOCK_SOURCE_SHA="${EXPECTED_OPERATION_LOCK_SOURCE_SHA:-}"
  LIVE_BETTING_REQUIRED_MONGO_TOPOLOGY_MODE="${REQUIRED_MONGO_TOPOLOGY_MODE:-}"
  LIVE_BETTING_EXPECTED_SHARED_MONGO_PVC="${EXPECTED_SHARED_MONGO_PVC:-}"
  LIVE_BETTING_PUBLIC_HOSTS_REQUIRED="${PUBLIC_HOSTS_REQUIRED:-0}"
  LIVE_BETTING_DIAGNOSTIC_URL_REQUIRED="${DIAGNOSTIC_URL_REQUIRED:-0}"
  LIVE_BETTING_REQUIRE_HTTPS_PRIMARY="${REQUIRE_HTTPS_PRIMARY:-0}"
  LIVE_BETTING_REQUIRE_HTTPS_SECONDARY="${REQUIRE_HTTPS_SECONDARY:-0}"
  LIVE_BETTING_REQUIRE_HTTPS_DIAGNOSTIC="${REQUIRE_HTTPS_DIAGNOSTIC:-0}"
  LIVE_BETTING_EXPECTED_FLAG="${EXPECTED_LIVE_KICKOFFS_ENABLED:-$(live_betting_default_expected_flag "$LIVE_BETTING_MODE")}"
  LIVE_BETTING_MAX_ACTIVE_MATCHES="${MAX_ACTIVE_MATCHES:-$(live_betting_default_max_active_matches "$LIVE_BETTING_MODE")}"
  LIVE_BETTING_MAX_OVERDUE_UNSTARTED_EVENTS="${MAX_OVERDUE_UNSTARTED_EVENTS:-0}"
  LIVE_BETTING_MAX_SIMULATION_QUARANTINES="${MAX_SIMULATION_QUARANTINES:-0}"
  LIVE_BETTING_UNSTARTED_EVENT_GRACE_SECONDS="${UNSTARTED_EVENT_GRACE_SECONDS:-120}"
  LIVE_BETTING_MAX_SUBMITTED_LIVE_SLIPS="${MAX_SUBMITTED_LIVE_SLIPS:-$(live_betting_default_max_submitted_slips "$LIVE_BETTING_MODE")}"
  LIVE_BETTING_MAX_DRAFT_LIVE_SLIPS="${MAX_DRAFT_LIVE_SLIPS:-$(live_betting_default_max_draft_live_slips "$LIVE_BETTING_MODE")}"
  LIVE_BETTING_MAX_LIVE_QUEUE_READY="${MAX_LIVE_QUEUE_READY:-$(live_betting_default_max_queue_ready "$LIVE_BETTING_MODE")}"
  LIVE_BETTING_MAX_LIVE_QUEUE_UNACK="${MAX_LIVE_QUEUE_UNACK:-$(live_betting_default_max_queue_unack "$LIVE_BETTING_MODE")}"
  LIVE_BETTING_MAX_WORKFLOW_PENDING_COUNT="${MAX_WORKFLOW_PENDING_COUNT:-$(live_betting_default_max_workflow_pending_count "$LIVE_BETTING_MODE")}"
  LIVE_BETTING_MAX_WORKFLOW_PENDING_AGE_SECONDS="${MAX_WORKFLOW_PENDING_AGE_SECONDS:-$(live_betting_default_max_workflow_pending_age_seconds "$LIVE_BETTING_MODE")}"
  LIVE_BETTING_MAX_WORKFLOW_PROCESSING_COUNT="${MAX_WORKFLOW_PROCESSING_COUNT:-$(live_betting_default_max_workflow_processing_count "$LIVE_BETTING_MODE")}"
  LIVE_BETTING_MAX_WORKFLOW_PROCESSING_AGE_SECONDS="${MAX_WORKFLOW_PROCESSING_AGE_SECONDS:-$(live_betting_default_max_workflow_processing_age_seconds "$LIVE_BETTING_MODE")}"
  LIVE_BETTING_MIN_DURABLE_QUEUE_CONSUMERS="${MIN_DURABLE_LIVE_QUEUE_CONSUMERS:-1}"
  LIVE_BETTING_MIN_DYNAMIC_QUEUE_CONSUMERS="${MIN_DYNAMIC_LIVE_QUEUE_CONSUMERS:-1}"
  LIVE_BETTING_REQUIRED_LIVE_QUEUES="${REQUIRED_LIVE_QUEUES:-event_live_projection,moderation_live_event_update,resulting_live_event_update}"
  LIVE_BETTING_REQUIRED_LIVE_QUEUE_PREFIXES="${REQUIRED_LIVE_QUEUE_PREFIXES:-event_live_update.}"
  LIVE_BETTING_RABBIT_SELECTOR="${RABBIT_SELECTOR:-app=gaming-rabbitmq}"
  LIVE_BETTING_MONGO_SELECTOR="${MONGO_POD_SELECTOR:-app=gaming-auth-mongo}"
  LIVE_BETTING_EVENT_API_PATH="${EVENT_API_PATH:-/api/event}"
  LIVE_BETTING_CURRENT_USER_PATH="${CURRENT_USER_PATH:-/api/auth/currentuser}"
  LIVE_BETTING_SSE_PATH="${SSE_PATH:-/api/event/stream}"
  LIVE_BETTING_SSE_REQUIRED="$(live_betting_normalize_bool "${SSE_REQUIRED:-true}")"
  LIVE_BETTING_OUTPUT_DIR="${OUTPUT_DIR:-$LIVE_BETTING_ROOT_DIR/artifacts/${LIVE_BETTING_STACK}-live-betting-readiness/${LIVE_BETTING_MODE}}"
  LIVE_BETTING_WORK_DIR="$LIVE_BETTING_OUTPUT_DIR/.work-$$"
  LIVE_BETTING_SUMMARY_FILE="$LIVE_BETTING_OUTPUT_DIR/summary.env"
  LIVE_BETTING_FAILURES_FILE="$LIVE_BETTING_OUTPUT_DIR/failures.txt"
  LIVE_BETTING_ADDITIONAL_SUMMARY_FILE="$LIVE_BETTING_WORK_DIR/additional-summary.env"
  LIVE_BETTING_PODS_JSON_FILE="$LIVE_BETTING_WORK_DIR/pods.json"
  LIVE_BETTING_FAILED_CHECKS=""

  LIVE_BETTING_ACTUAL_FLAG="unknown"
  LIVE_BETTING_IMAGE_PROVENANCE_ROWS="unknown"
  LIVE_BETTING_APP_DEPLOYMENTS_VERIFIED="unknown"
  LIVE_BETTING_AUX_WORKLOADS_READY="unknown"
  LIVE_BETTING_RABBIT_READY="unknown"
  LIVE_BETTING_RABBIT_UNACK="unknown"
  LIVE_BETTING_RABBIT_CONSUMERS="unknown"
  LIVE_BETTING_RABBIT_DYNAMIC_QUEUES="unknown"
  LIVE_BETTING_ACTIVE_MATCHES="unknown"
  LIVE_BETTING_OVERDUE_UNSTARTED_EVENTS="unknown"
  LIVE_BETTING_SIMULATION_QUARANTINES="unknown"
  LIVE_BETTING_SUBMITTED_LIVE_SLIPS="unknown"
  LIVE_BETTING_DRAFT_LIVE_SLIPS="unknown"
  LIVE_BETTING_MONGO_PING_OK="unknown"
  LIVE_BETTING_TOPOLOGY_MODE="unknown"
  LIVE_BETTING_TOPOLOGY_VALIDATED="unknown"
  LIVE_BETTING_LOCK_STATE="unknown"
  LIVE_BETTING_MONGO_PVC_NAME="unknown"
  LIVE_BETTING_MONGO_PVC_PHASE="unknown"
  LIVE_BETTING_PUBLIC_EVENT_STATUS="unknown"
  LIVE_BETTING_PUBLIC_EVENT_ITEMS="unknown"
  LIVE_BETTING_LEGACY_PREMATCH_EVENTS="unknown"
  LIVE_BETTING_LEGACY_PREMATCH_EVENT_ID="unknown"
  LIVE_BETTING_LEGACY_PREMATCH_1X2_ODDS="unknown"
  LIVE_BETTING_LEGACY_PREMATCH_CORRECT_SCORE_ODDS="unknown"
  LIVE_BETTING_PUBLIC_CURRENTUSER_STATUS="unknown"
  LIVE_BETTING_PUBLIC_CURRENTUSER_TYPE="unknown"
  LIVE_BETTING_DIAGNOSTIC_EVENT_STATUS="not_checked"
  LIVE_BETTING_DIAGNOSTIC_CURRENTUSER_STATUS="not_checked"
  LIVE_BETTING_SECONDARY_REDIRECT_STATUS="not_checked"
  LIVE_BETTING_SSE_PRIMARY_STATUS="unknown"
  LIVE_BETTING_SSE_PRIMARY_HEARTBEAT="unknown"
  LIVE_BETTING_SSE_DIAGNOSTIC_STATUS="not_checked"
  LIVE_BETTING_SSE_DIAGNOSTIC_HEARTBEAT="not_checked"
  LIVE_BETTING_PROVENANCE_SOURCE_SHA="not_checked"
  LIVE_BETTING_SCHEMA_EVIDENCE_VERIFIED="not_checked"
  LIVE_BETTING_ROLLBACK_BASELINE_VERIFIED="not_checked"

  mkdir -p "$LIVE_BETTING_OUTPUT_DIR" "$LIVE_BETTING_WORK_DIR"
  : >"$LIVE_BETTING_FAILURES_FILE"
  : >"$LIVE_BETTING_ADDITIONAL_SUMMARY_FILE"
  trap 'rm -rf "$LIVE_BETTING_WORK_DIR"' EXIT

  case "$LIVE_BETTING_MODE" in
    dark|activate|monitor|rollback-drain) ;;
    *) live_betting_record_failure preflight "MODE must be one of dark, activate, monitor, rollback-drain" ;;
  esac
  for command_name in kubectl curl python3; do
    command -v "$command_name" >/dev/null 2>&1 ||
      live_betting_record_failure preflight "required command is unavailable: $command_name"
  done
  [[ -n "$LIVE_BETTING_BASE_URL" ]] || live_betting_record_failure preflight "BASE_URL is required"
  [[ -f "$LIVE_BETTING_IMAGE_PROVENANCE_FILE" ]] ||
    live_betting_record_failure preflight "IMAGE_PROVENANCE_FILE is required"
  [[ "$(live_betting_normalize_bool "$LIVE_BETTING_EXPECTED_FLAG")" != invalid ]] ||
    live_betting_record_failure preflight "EXPECTED_LIVE_KICKOFFS_ENABLED must be explicit true or false"
  [[ "$LIVE_BETTING_SSE_REQUIRED" != invalid ]] ||
    live_betting_record_failure preflight "SSE_REQUIRED must be explicit true or false"
  if [[ -n "$LIVE_BETTING_EXPECTED_OPERATION_LOCK_HOLDER" ||
        -n "$LIVE_BETTING_EXPECTED_OPERATION_LOCK_ID" ||
        -n "$LIVE_BETTING_EXPECTED_OPERATION_LOCK_SOURCE_SHA" ]]; then
    [[ "$LIVE_BETTING_EXPECTED_OPERATION_LOCK_HOLDER" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] ||
      live_betting_record_failure preflight "EXPECTED_OPERATION_LOCK_HOLDER is invalid"
    [[ "$LIVE_BETTING_EXPECTED_OPERATION_LOCK_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] ||
      live_betting_record_failure preflight "EXPECTED_OPERATION_LOCK_ID is invalid"
    [[ "$LIVE_BETTING_EXPECTED_OPERATION_LOCK_SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] ||
      live_betting_record_failure preflight "EXPECTED_OPERATION_LOCK_SOURCE_SHA is invalid"
  fi
  case "$LIVE_BETTING_REQUIRED_MONGO_TOPOLOGY_MODE" in
    ""|legacy|shared) ;;
    *) live_betting_record_failure preflight "REQUIRED_MONGO_TOPOLOGY_MODE must be legacy or shared" ;;
  esac
  if [[ -n "$LIVE_BETTING_EXPECTED_SHARED_MONGO_PVC" ]]; then
    [[ "$LIVE_BETTING_EXPECTED_SHARED_MONGO_PVC" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]] ||
      live_betting_record_failure preflight "EXPECTED_SHARED_MONGO_PVC is invalid"
  fi
  if [[ "$LIVE_BETTING_REQUIRED_MONGO_TOPOLOGY_MODE" == "shared" &&
        -z "$LIVE_BETTING_EXPECTED_SHARED_MONGO_PVC" ]]; then
    live_betting_record_failure preflight "EXPECTED_SHARED_MONGO_PVC is required for shared topology"
  fi
  live_betting_require_uint REQUEST_TIMEOUT "$LIVE_BETTING_REQUEST_TIMEOUT"
  live_betting_require_uint SSE_TIMEOUT "$LIVE_BETTING_SSE_TIMEOUT"
  live_betting_require_uint MAX_ACTIVE_MATCHES "$LIVE_BETTING_MAX_ACTIVE_MATCHES"
  live_betting_require_uint MAX_OVERDUE_UNSTARTED_EVENTS "$LIVE_BETTING_MAX_OVERDUE_UNSTARTED_EVENTS"
  live_betting_require_uint MAX_SIMULATION_QUARANTINES "$LIVE_BETTING_MAX_SIMULATION_QUARANTINES"
  live_betting_require_uint UNSTARTED_EVENT_GRACE_SECONDS "$LIVE_BETTING_UNSTARTED_EVENT_GRACE_SECONDS"
  live_betting_require_uint MAX_SUBMITTED_LIVE_SLIPS "$LIVE_BETTING_MAX_SUBMITTED_LIVE_SLIPS"
  live_betting_require_uint MAX_DRAFT_LIVE_SLIPS "$LIVE_BETTING_MAX_DRAFT_LIVE_SLIPS"
  live_betting_require_uint MAX_LIVE_QUEUE_READY "$LIVE_BETTING_MAX_LIVE_QUEUE_READY"
  live_betting_require_uint MAX_LIVE_QUEUE_UNACK "$LIVE_BETTING_MAX_LIVE_QUEUE_UNACK"
  live_betting_require_uint MAX_WORKFLOW_PENDING_COUNT "$LIVE_BETTING_MAX_WORKFLOW_PENDING_COUNT"
  live_betting_require_uint MAX_WORKFLOW_PENDING_AGE_SECONDS "$LIVE_BETTING_MAX_WORKFLOW_PENDING_AGE_SECONDS"
  live_betting_require_uint MAX_WORKFLOW_PROCESSING_COUNT "$LIVE_BETTING_MAX_WORKFLOW_PROCESSING_COUNT"
  live_betting_require_uint MAX_WORKFLOW_PROCESSING_AGE_SECONDS "$LIVE_BETTING_MAX_WORKFLOW_PROCESSING_AGE_SECONDS"
  if [[ "$LIVE_BETTING_PUBLIC_HOSTS_REQUIRED" == "1" ]]; then
    [[ -n "$LIVE_BETTING_SECONDARY_PUBLIC_URL" ]] ||
      live_betting_record_failure preflight "SECONDARY_PUBLIC_URL is required when public host checks are enabled"
  fi
  if [[ "$LIVE_BETTING_DIAGNOSTIC_URL_REQUIRED" == "1" ]]; then
    [[ -n "$LIVE_BETTING_DIAGNOSTIC_URL" ]] ||
      live_betting_record_failure preflight "DIAGNOSTIC_URL is required"
  fi
  if [[ "$LIVE_BETTING_REQUIRE_HTTPS_PRIMARY" == "1" && "$LIVE_BETTING_BASE_URL" != https://* ]]; then
    live_betting_record_failure preflight "BASE_URL must be HTTPS"
  fi
  if [[ "$LIVE_BETTING_REQUIRE_HTTPS_SECONDARY" == "1" && -n "$LIVE_BETTING_SECONDARY_PUBLIC_URL" && "$LIVE_BETTING_SECONDARY_PUBLIC_URL" != https://* ]]; then
    live_betting_record_failure preflight "SECONDARY_PUBLIC_URL must be HTTPS"
  fi
  if [[ "$LIVE_BETTING_REQUIRE_HTTPS_DIAGNOSTIC" == "1" && -n "$LIVE_BETTING_DIAGNOSTIC_URL" && "$LIVE_BETTING_DIAGNOSTIC_URL" != https://* ]]; then
    live_betting_record_failure preflight "DIAGNOSTIC_URL must be HTTPS"
  fi

  live_betting_check_exact_master_provenance || true
  live_betting_check_schema_evidence || true
  live_betting_check_rollback_baseline || true

  local workloads_json pods_json pvcs_json topology_stderr lock_stderr rabbit_stderr
  if workloads_json="$(live_betting_capture_command workloads kubectl --request-timeout="$LIVE_BETTING_KUBECTL_TIMEOUT" get deploy,sts -n "$LIVE_BETTING_NAMESPACE" -o json)"; then
    printf '%s\n' "$workloads_json" >"$LIVE_BETTING_WORK_DIR/workloads.json"
  else
    live_betting_record_failure workload_images "unable to inspect deployment readiness"
  fi
  if pods_json="$(live_betting_capture_command pods kubectl --request-timeout="$LIVE_BETTING_KUBECTL_TIMEOUT" get pods -n "$LIVE_BETTING_NAMESPACE" -o json)"; then
    printf '%s\n' "$pods_json" >"$LIVE_BETTING_PODS_JSON_FILE"
  else
    live_betting_record_failure workload_images "unable to inspect pod readiness"
  fi
  if [[ -f "$LIVE_BETTING_WORK_DIR/workloads.json" && -f "$LIVE_BETTING_PODS_JSON_FILE" && -f "$LIVE_BETTING_IMAGE_PROVENANCE_FILE" ]]; then
    live_betting_check_workloads "$LIVE_BETTING_WORK_DIR/workloads.json" "$LIVE_BETTING_PODS_JSON_FILE" || true
  fi
  if [[ -n "$LIVE_BETTING_EXPECTED_SHARED_MONGO_PVC" ]]; then
    if pvcs_json="$(live_betting_capture_command pvcs kubectl --request-timeout="$LIVE_BETTING_KUBECTL_TIMEOUT" get persistentvolumeclaims -n "$LIVE_BETTING_NAMESPACE" -o json)"; then
      printf '%s\n' "$pvcs_json" >"$LIVE_BETTING_WORK_DIR/pvcs.json"
    else
      live_betting_record_failure topology_lock "unable to inspect Mongo PVC inventory"
    fi
  fi

  topology_stderr="$LIVE_BETTING_WORK_DIR/topology.stderr"
  if kubectl --request-timeout="$LIVE_BETTING_KUBECTL_TIMEOUT" get configmap gaming-mongo-topology -n "$LIVE_BETTING_NAMESPACE" -o json >"$LIVE_BETTING_WORK_DIR/topology.json" 2>"$topology_stderr"; then
    live_betting_write_sanitized_file "$topology_stderr" "$LIVE_BETTING_OUTPUT_DIR/topology.stderr"
  elif grep -Eqi 'not[ -]?found' "$topology_stderr" &&
      [[ "$LIVE_BETTING_REQUIRED_MONGO_TOPOLOGY_MODE" != "shared" ]]; then
    live_betting_write_sanitized_file "$topology_stderr" "$LIVE_BETTING_OUTPUT_DIR/topology.stderr"
    printf '{"data":{"mode":"legacy","validated":"true"}}\n' >"$LIVE_BETTING_WORK_DIR/topology.json"
  else
    live_betting_write_sanitized_file "$topology_stderr" "$LIVE_BETTING_OUTPUT_DIR/topology.stderr"
    live_betting_record_failure topology_lock "unable to inspect Mongo topology"
  fi
  lock_stderr="$LIVE_BETTING_WORK_DIR/lock.stderr"
  if kubectl --request-timeout="$LIVE_BETTING_KUBECTL_TIMEOUT" get configmap gaming-mongo-migration-lock -n "$LIVE_BETTING_NAMESPACE" -o json >"$LIVE_BETTING_WORK_DIR/lock.json" 2>"$lock_stderr"; then
    live_betting_write_sanitized_file "$lock_stderr" "$LIVE_BETTING_OUTPUT_DIR/lock.stderr"
  elif grep -Eqi 'not[ -]?found' "$lock_stderr"; then
    live_betting_write_sanitized_file "$lock_stderr" "$LIVE_BETTING_OUTPUT_DIR/lock.stderr"
    : >"$LIVE_BETTING_WORK_DIR/lock.json"
  else
    live_betting_write_sanitized_file "$lock_stderr" "$LIVE_BETTING_OUTPUT_DIR/lock.stderr"
    live_betting_record_failure topology_lock "unable to inspect Mongo operation lock"
  fi
  if [[ -f "$LIVE_BETTING_WORK_DIR/topology.json" ]]; then
    live_betting_check_topology \
      "$LIVE_BETTING_WORK_DIR/topology.json" \
      "$LIVE_BETTING_WORK_DIR/lock.json" \
      "$LIVE_BETTING_WORK_DIR/pvcs.json" || true
  fi

  local rabbit_pod
  rabbit_pod="$(python3 - "$LIVE_BETTING_PODS_JSON_FILE" <<'PY'
import json,sys
payload=json.load(open(sys.argv[1], encoding='utf-8'))
for item in payload.get('items', []):
    labels=((item.get('metadata') or {}).get('labels') or {})
    if labels.get('app') == 'gaming-rabbitmq':
        print((item.get('metadata') or {}).get('name', ''))
        break
PY
 2>/dev/null || true)"

  if [[ -n "$rabbit_pod" ]]; then
    rabbit_stderr="$LIVE_BETTING_WORK_DIR/rabbitmq.stderr"
    if kubectl --request-timeout="$LIVE_BETTING_KUBECTL_TIMEOUT" exec -n "$LIVE_BETTING_NAMESPACE" "$rabbit_pod" -- rabbitmqctl list_queues --quiet name messages_ready messages_unacknowledged consumers >"$LIVE_BETTING_WORK_DIR/rabbitmq.queues" 2>"$rabbit_stderr"; then
      live_betting_write_sanitized_file "$rabbit_stderr" "$LIVE_BETTING_OUTPUT_DIR/rabbitmq.stderr"
      live_betting_write_sanitized_file "$LIVE_BETTING_WORK_DIR/rabbitmq.queues" "$LIVE_BETTING_OUTPUT_DIR/rabbitmq.queues"
      live_betting_check_rabbitmq "$LIVE_BETTING_WORK_DIR/rabbitmq.queues" || true
    else
      live_betting_write_sanitized_file "$rabbit_stderr" "$LIVE_BETTING_OUTPUT_DIR/rabbitmq.stderr"
      live_betting_record_failure rabbitmq_queues "unable to inspect RabbitMQ queues"
    fi
  else
    live_betting_record_failure rabbitmq_queues "RabbitMQ pod is missing"
  fi

  local active_query slips_query bet_query moderation_query pending_result_query retry_query
  active_query="$(cat <<'EOF_QUERY'
const gm = db.getSiblingDB("gaming_gamemaster");
const overdueBefore = new Date(Date.now() - (__UNSTARTED_EVENT_GRACE_SECONDS__ * 1000));
print(JSON.stringify({
  mongoOk: db.adminCommand({ping: 1}).ok === 1,
  activeMatches: gm.events.countDocuments({phase: {$nin: ["PRE_MATCH", "FULL_TIME"]}}),
  overdueUnstartedEvents: gm.events.countDocuments({
    status: "NO_RESULT",
    time: {$lt: overdueBefore},
    "liveTransitions.0": {$exists: false},
    $or: [
      {phase: "PRE_MATCH"},
      {phase: null},
      {phase: {$exists: false}}
    ]
  }),
  simulationQuarantines: gm.events.countDocuments({
    "simulationFailure.quarantinedAt": {$exists: true, $ne: null}
  })
}));
EOF_QUERY
)"
  active_query="${active_query//__UNSTARTED_EVENT_GRACE_SECONDS__/$LIVE_BETTING_UNSTARTED_EVENT_GRACE_SECONDS}"
  slips_query="$(cat <<'EOF_QUERY'
const slips = db.getSiblingDB("gaming_slip");
print(JSON.stringify({
  mongoOk: db.adminCommand({ping: 1}).ok === 1,
  submittedLiveSlips: slips.slips.countDocuments({betKind: "LIVE", status: "SUBMITTED"}),
  draftLiveSlips: slips.slips.countDocuments({betKind: "LIVE", status: "DRAFT"})
}));
EOF_QUERY
)"
  bet_query="$(cat <<'EOF_QUERY'
const now = Date.now();
function parseDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
function findAnchor(doc, primaryField, fallbackField) {
  return parseDate(doc[primaryField]) || (fallbackField ? parseDate(doc[fallbackField]) : null);
}
function bucketFilter(config) {
  const statusMatch = config.statuses.length === 1 ? config.statuses[0] : {$in: config.statuses};
  const clauses = [{status: statusMatch}];
  if (config.includeLegacyMissingStatus) {
    clauses.push({status: {$exists: false}}, {status: null}, {status: ""});
  }
  return clauses.length === 1 ? clauses[0] : {$or: clauses};
}
function summarizeBucket(collection, collectionName, bucketName, config) {
  const projection = {_id: 0, createdAt: 1};
  projection[config.primaryField] = 1;
  if (config.fallbackField) projection[config.fallbackField] = 1;
  let count = 0;
  let oldestAgeSeconds = 0;
  collection.find(bucketFilter(config), projection).forEach((doc) => {
    count += 1;
    const anchor = findAnchor(doc, config.primaryField, config.fallbackField);
    if (!anchor) {
      throw new Error(`${collectionName} ${bucketName} anchor is missing or invalid`);
    }
    const ageSeconds = Math.max(0, Math.floor((now - anchor.getTime()) / 1000));
    if (ageSeconds > oldestAgeSeconds) {
      oldestAgeSeconds = ageSeconds;
    }
  });
  return {count, oldestAgeSeconds};
}
const collection = db.getSiblingDB("gaming_bet").getCollection("pendingbetupdates");
const queryContract = {
  collectionName: "pendingbetupdates",
  pending: { statuses: ["PENDING"], includeLegacyMissingStatus: true, primaryField: "nextAttemptAt", fallbackField: "createdAt" },
  processing: { statuses: ["PROCESSING"], includeLegacyMissingStatus: false, primaryField: "leaseUntil", fallbackField: "" },
  exhausted: { statuses: ["EXHAUSTED"], includeLegacyMissingStatus: false, primaryField: "exhaustedAt", fallbackField: "" }
};
print(JSON.stringify({
  mongoOk: db.adminCommand({ping: 1}).ok === 1,
  pending: summarizeBucket(collection, queryContract.collectionName, "pending", queryContract.pending),
  processing: summarizeBucket(collection, queryContract.collectionName, "processing", queryContract.processing),
  exhausted: summarizeBucket(collection, queryContract.collectionName, "exhausted", queryContract.exhausted)
}));
EOF_QUERY
)"
  moderation_query="$(cat <<'EOF_QUERY'
const now = Date.now();
function parseDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
function findAnchor(doc, primaryField, fallbackField) {
  return parseDate(doc[primaryField]) || (fallbackField ? parseDate(doc[fallbackField]) : null);
}
function bucketFilter(config) {
  const statusMatch = config.statuses.length === 1 ? config.statuses[0] : {$in: config.statuses};
  const clauses = [{status: statusMatch}];
  if (config.includeLegacyMissingStatus) {
    clauses.push({status: {$exists: false}}, {status: null}, {status: ""});
  }
  return clauses.length === 1 ? clauses[0] : {$or: clauses};
}
function summarizeBucket(collection, collectionName, bucketName, config) {
  const projection = {_id: 0, createdAt: 1};
  projection[config.primaryField] = 1;
  if (config.fallbackField) projection[config.fallbackField] = 1;
  let count = 0;
  let oldestAgeSeconds = 0;
  collection.find(bucketFilter(config), projection).forEach((doc) => {
    count += 1;
    const anchor = findAnchor(doc, config.primaryField, config.fallbackField);
    if (!anchor) {
      throw new Error(`${collectionName} ${bucketName} anchor is missing or invalid`);
    }
    const ageSeconds = Math.max(0, Math.floor((now - anchor.getTime()) / 1000));
    if (ageSeconds > oldestAgeSeconds) {
      oldestAgeSeconds = ageSeconds;
    }
  });
  return {count, oldestAgeSeconds};
}
const collection = db.getSiblingDB("gaming_moderation").getCollection("parkedplacebets");
const queryContract = {
  collectionName: "parkedplacebets",
  pending: { statuses: ["PENDING"], includeLegacyMissingStatus: true, primaryField: "nextAttemptAt", fallbackField: "createdAt" },
  processing: { statuses: ["PROCESSING"], includeLegacyMissingStatus: false, primaryField: "leaseUntil", fallbackField: "" },
  exhausted: { statuses: ["EXHAUSTED"], includeLegacyMissingStatus: false, primaryField: "exhaustedAt", fallbackField: "" }
};
print(JSON.stringify({
  mongoOk: db.adminCommand({ping: 1}).ok === 1,
  pending: summarizeBucket(collection, queryContract.collectionName, "pending", queryContract.pending),
  processing: summarizeBucket(collection, queryContract.collectionName, "processing", queryContract.processing),
  exhausted: summarizeBucket(collection, queryContract.collectionName, "exhausted", queryContract.exhausted)
}));
EOF_QUERY
)"
  pending_result_query="$(cat <<'EOF_QUERY'
const now = Date.now();
function parseDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
function findAnchor(doc, primaryField, fallbackField) {
  return parseDate(doc[primaryField]) || (fallbackField ? parseDate(doc[fallbackField]) : null);
}
function bucketFilter(config) {
  const statusMatch = config.statuses.length === 1 ? config.statuses[0] : {$in: config.statuses};
  const clauses = [{status: statusMatch}];
  if (config.includeLegacyMissingStatus) {
    clauses.push({status: {$exists: false}}, {status: null}, {status: ""});
  }
  return clauses.length === 1 ? clauses[0] : {$or: clauses};
}
function summarizeBucket(collection, collectionName, bucketName, config) {
  const projection = {_id: 0, createdAt: 1};
  projection[config.primaryField] = 1;
  if (config.fallbackField) projection[config.fallbackField] = 1;
  let count = 0;
  let oldestAgeSeconds = 0;
  collection.find(bucketFilter(config), projection).forEach((doc) => {
    count += 1;
    const anchor = findAnchor(doc, config.primaryField, config.fallbackField);
    if (!anchor) {
      throw new Error(`${collectionName} ${bucketName} anchor is missing or invalid`);
    }
    const ageSeconds = Math.max(0, Math.floor((now - anchor.getTime()) / 1000));
    if (ageSeconds > oldestAgeSeconds) {
      oldestAgeSeconds = ageSeconds;
    }
  });
  return {count, oldestAgeSeconds};
}
const collection = db.getSiblingDB("gaming_resulting").getCollection("pendingmoderationresults");
const queryContract = {
  collectionName: "pendingmoderationresults",
  pending: { statuses: ["PENDING"], includeLegacyMissingStatus: true, primaryField: "nextAttemptAt", fallbackField: "createdAt" },
  processing: { statuses: ["PROCESSING"], includeLegacyMissingStatus: false, primaryField: "leasedUntil", fallbackField: "" },
  exhausted: { statuses: ["EXHAUSTED"], includeLegacyMissingStatus: false, primaryField: "exhaustedAt", fallbackField: "" }
};
print(JSON.stringify({
  mongoOk: db.adminCommand({ping: 1}).ok === 1,
  pending: summarizeBucket(collection, queryContract.collectionName, "pending", queryContract.pending),
  processing: summarizeBucket(collection, queryContract.collectionName, "processing", queryContract.processing),
  exhausted: summarizeBucket(collection, queryContract.collectionName, "exhausted", queryContract.exhausted)
}));
EOF_QUERY
)"
  retry_query="$(cat <<'EOF_QUERY'
const now = Date.now();
function parseDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
function findAnchor(doc, primaryField, fallbackField) {
  return parseDate(doc[primaryField]) || (fallbackField ? parseDate(doc[fallbackField]) : null);
}
function bucketFilter(config) {
  const statusMatch = config.statuses.length === 1 ? config.statuses[0] : {$in: config.statuses};
  const clauses = [{status: statusMatch}];
  if (config.includeLegacyMissingStatus) {
    clauses.push({status: {$exists: false}}, {status: null}, {status: ""});
  }
  return clauses.length === 1 ? clauses[0] : {$or: clauses};
}
function summarizeBucket(collection, collectionName, bucketName, config) {
  const projection = {_id: 0, createdAt: 1};
  projection[config.primaryField] = 1;
  if (config.fallbackField) projection[config.fallbackField] = 1;
  let count = 0;
  let oldestAgeSeconds = 0;
  collection.find(bucketFilter(config), projection).forEach((doc) => {
    count += 1;
    const anchor = findAnchor(doc, config.primaryField, config.fallbackField);
    if (!anchor) {
      throw new Error(`${collectionName} ${bucketName} anchor is missing or invalid`);
    }
    const ageSeconds = Math.max(0, Math.floor((now - anchor.getTime()) / 1000));
    if (ageSeconds > oldestAgeSeconds) {
      oldestAgeSeconds = ageSeconds;
    }
  });
  return {count, oldestAgeSeconds};
}
const collection = db.getSiblingDB("gaming_resulting").getCollection("retryrecords");
const queryContract = {
  collectionName: "retryrecords",
  pending: { statuses: ["PENDING"], includeLegacyMissingStatus: true, primaryField: "nextAttemptAt", fallbackField: "createdAt" },
  processing: { statuses: ["PROCESSING"], includeLegacyMissingStatus: false, primaryField: "leasedUntil", fallbackField: "" },
  deadLetter: { statuses: ["DEAD_LETTER"], includeLegacyMissingStatus: false, primaryField: "deadLetteredAt", fallbackField: "" }
};
const deadLetter = summarizeBucket(collection, queryContract.collectionName, "deadLetter", queryContract.deadLetter);
print(JSON.stringify({
  mongoOk: db.adminCommand({ping: 1}).ok === 1,
  pending: summarizeBucket(collection, queryContract.collectionName, "pending", queryContract.pending),
  processing: summarizeBucket(collection, queryContract.collectionName, "processing", queryContract.processing),
  exhausted: deadLetter,
  deadLetter
}));
EOF_QUERY
)"

  local active_file slips_file bet_file moderation_file pending_result_file retry_file
  active_file="$LIVE_BETTING_WORK_DIR/mongo-active.json"
  slips_file="$LIVE_BETTING_WORK_DIR/mongo-submitted.json"
  bet_file="$LIVE_BETTING_WORK_DIR/mongo-bet-pending-bet-update.json"
  moderation_file="$LIVE_BETTING_WORK_DIR/mongo-moderation-parked-place-bet.json"
  pending_result_file="$LIVE_BETTING_WORK_DIR/mongo-resulting-pending-moderation-result.json"
  retry_file="$LIVE_BETTING_WORK_DIR/mongo-resulting-retry-record.json"

  local mongo_counts_ready=true
  local mongo_parking_ready=true
  if ! live_betting_exec_mongo_query mongo-active gaming_gamemaster "$active_query" "$active_file"; then
    live_betting_record_failure mongo_counts "unable to inspect active live match count"
    mongo_counts_ready=false
  fi
  if ! live_betting_exec_mongo_query mongo-submitted-slips gaming_slip "$slips_query" "$slips_file"; then
    live_betting_record_failure mongo_counts "unable to inspect submitted live slip count"
    mongo_counts_ready=false
  fi
  if ! live_betting_exec_mongo_query mongo-bet-pending-bet-update gaming_bet "$bet_query" "$bet_file"; then
    live_betting_record_failure mongo_workflow_parking "unable to inspect bet PendingBetUpdate backlog"
    mongo_parking_ready=false
  fi
  if ! live_betting_exec_mongo_query mongo-moderation-parked-place-bet gaming_moderation "$moderation_query" "$moderation_file"; then
    live_betting_record_failure mongo_workflow_parking "unable to inspect moderation ParkedPlaceBet backlog"
    mongo_parking_ready=false
  fi
  if ! live_betting_exec_mongo_query mongo-resulting-pending-moderation-result gaming_resulting "$pending_result_query" "$pending_result_file"; then
    live_betting_record_failure mongo_workflow_parking "unable to inspect resulting PendingModerationResult backlog"
    mongo_parking_ready=false
  fi
  if ! live_betting_exec_mongo_query mongo-resulting-retry-record gaming_resulting "$retry_query" "$retry_file"; then
    live_betting_record_failure mongo_workflow_parking "unable to inspect resulting RetryRecord backlog"
    mongo_parking_ready=false
  fi

  if [[ "$mongo_counts_ready" == true && "$mongo_parking_ready" == true ]]; then
    live_betting_check_mongo_observability \
      "$active_file" \
      "$slips_file" \
      "$bet_file" \
      "$moderation_file" \
      "$pending_result_file" \
      "$retry_file" \
      "$LIVE_BETTING_WORK_DIR/workflow-parking.json" || true
  fi

  live_betting_check_event_endpoint public-event "$LIVE_BETTING_BASE_URL" public || true
  live_betting_check_current_user_endpoint public-current-user "$LIVE_BETTING_BASE_URL" public || true
  live_betting_check_sse_endpoint public-sse "$LIVE_BETTING_BASE_URL" public || true
  if [[ -n "$LIVE_BETTING_SECONDARY_PUBLIC_URL" ]]; then
    live_betting_check_secondary_redirect || true
  fi
  if [[ -n "$LIVE_BETTING_DIAGNOSTIC_URL" ]]; then
    live_betting_check_event_endpoint diagnostic-event "$LIVE_BETTING_DIAGNOSTIC_URL" diagnostic || true
    live_betting_check_current_user_endpoint diagnostic-current-user "$LIVE_BETTING_DIAGNOSTIC_URL" diagnostic || true
    live_betting_check_sse_endpoint diagnostic-sse "$LIVE_BETTING_DIAGNOSTIC_URL" diagnostic || true
  fi

  local readiness="GO"
  if [[ -n "$LIVE_BETTING_FAILED_CHECKS" ]]; then
    readiness="NO_GO"
  fi
  live_betting_write_summary "$readiness"
  if [[ "$readiness" != "GO" ]]; then
    return 1
  fi
  return 0
}
