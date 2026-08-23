#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SCRIPT="$ROOT_DIR/infra/oci/scripts/live-betting-control-stan.sh"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

mkdir -p "$WORK_DIR/bin"
cat >"$WORK_DIR/bin/kubectl" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$*" >>"${STUB_LOG:?}"
if [[ "$1" == "get" ]]; then
  flag="$(cat "${STUB_STATE:?}")"
  lease_json=""
  if [[ -s "${STUB_STATE}.lease" ]]; then
    lease_json=',{"name":"LIVE_KICKOFFS_LEASE_UNTIL_EPOCH","value":"'"$(cat "${STUB_STATE}.lease")"'"}'
  fi
  printf '{"metadata":{"annotations":{"betstan.dev/live-control-action":"%s","betstan.dev/live-control-run-id":"%s","betstan.dev/live-control-source-sha":"%s"}},"spec":{"template":{"spec":{"containers":[{"name":"gaming-gamemaster","env":[{"name":"LIVE_KICKOFFS_ENABLED","value":"%s"}%s]}]}}}}\n' \
    "$(cat "${STUB_STATE}.action" 2>/dev/null || printf none)" \
    "$(cat "${STUB_STATE}.run" 2>/dev/null || printf none)" \
    "$(cat "${STUB_STATE}.sha" 2>/dev/null || printf none)" \
    "$flag" \
    "$lease_json"
elif [[ "$1" == "set" && "$2" == "env" ]]; then
  requested_false=0
  requested_true=0
  for value in "$@"; do
    [[ "$value" == "LIVE_KICKOFFS_ENABLED=false" ]] && requested_false=1
    [[ "$value" == "LIVE_KICKOFFS_ENABLED=true" ]] && requested_true=1
  done
  if [[ "${STUB_FAIL_FALSE_SET_ONCE:-0}" == "1" \
      && "$requested_false" == "1" \
      && ! -f "${STUB_FAIL_ONCE_STATE:-${STUB_STATE}.fail-once}" ]]; then
    : >"${STUB_FAIL_ONCE_STATE:-${STUB_STATE}.fail-once}"
    exit 1
  fi
  removed_lease=0
  for value in "$@"; do
    case "$value" in
      LIVE_KICKOFFS_ENABLED=*)
        printf '%s\n' "${value#LIVE_KICKOFFS_ENABLED=}" >"$STUB_STATE"
        ;;
      LIVE_KICKOFFS_LEASE_UNTIL_EPOCH=*)
        printf '%s\n' \
          "${value#LIVE_KICKOFFS_LEASE_UNTIL_EPOCH=}" \
          >"${STUB_STATE}.lease"
        ;;
      LIVE_KICKOFFS_LEASE_UNTIL_EPOCH-)
        rm -f "${STUB_STATE}.lease"
        removed_lease=1
        ;;
    esac
  done
  if [[ "${STUB_FAIL_TRUE_SET_AFTER_MUTATION:-0}" == "1" \
      && "$requested_true" == "1" ]]; then
    exit 1
  fi
  if [[ "${STUB_FAIL_COMMIT_AFTER_MUTATION:-0}" == "1" \
      && "$removed_lease" == "1" \
      && "$(cat "$STUB_STATE")" == "true" ]]; then
    exit 1
  fi
elif [[ "$1" == "rollout" ]]; then
  if [[ "${STUB_FAIL_TRUE_ROLLOUT:-0}" == "1" && "$(cat "$STUB_STATE")" == "true" ]]; then
    exit 1
  fi
elif [[ "$1" == "annotate" ]]; then
  for value in "$@"; do
    case "$value" in
      betstan.dev/live-control-action=*)
        printf '%s\n' "${value#betstan.dev/live-control-action=}" \
          >"${STUB_STATE}.action"
        ;;
      betstan.dev/live-control-run-id=*)
        printf '%s\n' "${value#betstan.dev/live-control-run-id=}" \
          >"${STUB_STATE}.run"
        ;;
      betstan.dev/live-control-source-sha=*)
        printf '%s\n' "${value#betstan.dev/live-control-source-sha=}" \
          >"${STUB_STATE}.sha"
        ;;
    esac
  done
else
  echo "unexpected kubectl command: $*" >&2
  exit 1
fi
STUB
chmod +x "$WORK_DIR/bin/kubectl"

run_control() {
  local action="$1"
  local confirmation="$2"
  local output_dir="$3"
  PATH="$WORK_DIR/bin:$PATH" \
  STUB_LOG="$WORK_DIR/kubectl.log" \
  STUB_STATE="$WORK_DIR/flag" \
  ACTION="$action" \
  SOURCE_SHA="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" \
  CONTROL_RUN_ID=123 \
  CONFIRMATION="$confirmation" \
  NAMESPACE=betstan-oci \
  OUTPUT_DIR="$output_dir" \
    "$SCRIPT"
}

reset_state() {
  local flag="$1"
  local lease="${2:-}"
  printf '%s\n' "$flag" >"$WORK_DIR/flag"
  rm -f \
    "$WORK_DIR/flag.lease" \
    "$WORK_DIR/flag.action" \
    "$WORK_DIR/flag.run" \
    "$WORK_DIR/flag.sha"
  if [[ -n "$lease" ]]; then
    printf '%s\n' "$lease" >"$WORK_DIR/flag.lease"
  fi
}

: >"$WORK_DIR/kubectl.log"
reset_state false
run_control activate "ACTIVATE OCI LIVE BETTING" "$WORK_DIR/activate"
[[ "$(cat "$WORK_DIR/flag")" == "true" ]]
[[ "$(cat "$WORK_DIR/flag.lease")" =~ ^[1-9][0-9]*$ ]]
grep -Fq 'before_flag=false' "$WORK_DIR/activate/control.env"
grep -Fq 'after_flag=true' "$WORK_DIR/activate/control.env"
grep -Eq '^after_lease_until_epoch=[1-9][0-9]*$' \
  "$WORK_DIR/activate/control.env"
grep -Fq 'rollout_verified=true' "$WORK_DIR/activate/control.env"
grep -Fq 'LIVE_KICKOFFS_ENABLED=true' "$WORK_DIR/kubectl.log"
grep -Fq 'LIVE_KICKOFFS_LEASE_UNTIL_EPOCH=' "$WORK_DIR/kubectl.log"

: >"$WORK_DIR/kubectl.log"
run_control commit "COMMIT OCI LIVE BETTING" "$WORK_DIR/commit"
[[ "$(cat "$WORK_DIR/flag")" == "true" ]]
[[ ! -e "$WORK_DIR/flag.lease" ]]
grep -Fq 'before_action=activate' "$WORK_DIR/commit/control.env"
grep -Fq 'after_flag=true' "$WORK_DIR/commit/control.env"
grep -Fq 'after_lease_until_epoch=none' "$WORK_DIR/commit/control.env"
grep -Fq 'LIVE_KICKOFFS_LEASE_UNTIL_EPOCH-' "$WORK_DIR/kubectl.log"

: >"$WORK_DIR/kubectl.log"
run_control disable "DISABLE OCI LIVE BETTING" "$WORK_DIR/disable"
[[ "$(cat "$WORK_DIR/flag")" == "false" ]]
grep -Fq 'before_flag=true' "$WORK_DIR/disable/control.env"
grep -Fq 'after_flag=false' "$WORK_DIR/disable/control.env"
grep -Fq 'after_lease_until_epoch=none' "$WORK_DIR/disable/control.env"
grep -Fq 'LIVE_KICKOFFS_ENABLED=false' "$WORK_DIR/kubectl.log"

: >"$WORK_DIR/kubectl.log"
reset_state true 2000000000
rm -f "$WORK_DIR/fail-once"
if PATH="$WORK_DIR/bin:$PATH" \
    STUB_LOG="$WORK_DIR/kubectl.log" \
    STUB_STATE="$WORK_DIR/flag" \
    STUB_FAIL_FALSE_SET_ONCE=1 \
    STUB_FAIL_ONCE_STATE="$WORK_DIR/fail-once" \
    ACTION=disable \
    SOURCE_SHA="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" \
    CONTROL_RUN_ID=123 \
    CONFIRMATION="DISABLE OCI LIVE BETTING" \
    NAMESPACE=betstan-oci \
    OUTPUT_DIR="$WORK_DIR/disable-retry" \
      "$SCRIPT" >/dev/null 2>&1; then
  echo "failed first disable write unexpectedly succeeded" >&2
  exit 1
fi
[[ "$(cat "$WORK_DIR/flag")" == "false" ]]
grep -Fq 'rollback_attempted=true' "$WORK_DIR/disable-retry/control.env"
[[ "$(grep -Fc 'LIVE_KICKOFFS_ENABLED=false' "$WORK_DIR/kubectl.log")" -eq 2 ]]

: >"$WORK_DIR/kubectl.log"
reset_state false
if run_control activate "wrong confirmation" "$WORK_DIR/rejected" >/dev/null 2>&1; then
  echo "invalid confirmation unexpectedly succeeded" >&2
  exit 1
fi
[[ ! -s "$WORK_DIR/kubectl.log" ]]
[[ "$(cat "$WORK_DIR/flag")" == "false" ]]

: >"$WORK_DIR/kubectl.log"
reset_state false
if PATH="$WORK_DIR/bin:$PATH" \
    STUB_LOG="$WORK_DIR/kubectl.log" \
    STUB_STATE="$WORK_DIR/flag" \
    STUB_FAIL_TRUE_ROLLOUT=1 \
    ACTION=activate \
    SOURCE_SHA="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" \
    CONTROL_RUN_ID=123 \
    CONFIRMATION="ACTIVATE OCI LIVE BETTING" \
    NAMESPACE=betstan-oci \
    OUTPUT_DIR="$WORK_DIR/rollback" \
      "$SCRIPT" >/dev/null 2>&1; then
  echo "failed rollout unexpectedly succeeded" >&2
  exit 1
fi
[[ "$(cat "$WORK_DIR/flag")" == "false" ]]
[[ ! -e "$WORK_DIR/flag.lease" ]]
grep -Fq 'rollback_attempted=true' "$WORK_DIR/rollback/control.env"
grep -Fq 'LIVE_KICKOFFS_ENABLED=true' "$WORK_DIR/kubectl.log"
grep -Fq 'LIVE_KICKOFFS_ENABLED=false' "$WORK_DIR/kubectl.log"

: >"$WORK_DIR/kubectl.log"
reset_state false
if PATH="$WORK_DIR/bin:$PATH" \
    STUB_LOG="$WORK_DIR/kubectl.log" \
    STUB_STATE="$WORK_DIR/flag" \
    STUB_FAIL_TRUE_SET_AFTER_MUTATION=1 \
    ACTION=activate \
    SOURCE_SHA="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" \
    CONTROL_RUN_ID=123 \
    CONFIRMATION="ACTIVATE OCI LIVE BETTING" \
    NAMESPACE=betstan-oci \
    OUTPUT_DIR="$WORK_DIR/ambiguous-write" \
      "$SCRIPT" >/dev/null 2>&1; then
  echo "ambiguous activation write unexpectedly succeeded" >&2
  exit 1
fi
[[ "$(cat "$WORK_DIR/flag")" == "false" ]]
[[ ! -e "$WORK_DIR/flag.lease" ]]
grep -Fq 'rollback_attempted=true' "$WORK_DIR/ambiguous-write/control.env"
grep -Fq 'LIVE_KICKOFFS_ENABLED=true' "$WORK_DIR/kubectl.log"
grep -Fq 'LIVE_KICKOFFS_ENABLED=false' "$WORK_DIR/kubectl.log"

: >"$WORK_DIR/kubectl.log"
reset_state true 1
printf 'activate\n' >"$WORK_DIR/flag.action"
printf '123\n' >"$WORK_DIR/flag.run"
printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n' >"$WORK_DIR/flag.sha"
if run_control commit "COMMIT OCI LIVE BETTING" "$WORK_DIR/expired-commit" \
    >/dev/null 2>&1; then
  echo "expired activation lease unexpectedly committed" >&2
  exit 1
fi
[[ "$(cat "$WORK_DIR/flag")" == "false" ]]
[[ ! -e "$WORK_DIR/flag.lease" ]]
grep -Fq 'rollback_attempted=true' "$WORK_DIR/expired-commit/control.env"

: >"$WORK_DIR/kubectl.log"
reset_state false
run_control activate "ACTIVATE OCI LIVE BETTING" "$WORK_DIR/commit-ambiguous-start"
if PATH="$WORK_DIR/bin:$PATH" \
    STUB_LOG="$WORK_DIR/kubectl.log" \
    STUB_STATE="$WORK_DIR/flag" \
    STUB_FAIL_COMMIT_AFTER_MUTATION=1 \
    ACTION=commit \
    SOURCE_SHA="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" \
    CONTROL_RUN_ID=123 \
    CONFIRMATION="COMMIT OCI LIVE BETTING" \
    NAMESPACE=betstan-oci \
    OUTPUT_DIR="$WORK_DIR/commit-ambiguous" \
      "$SCRIPT" >/dev/null 2>&1; then
  echo "ambiguous activation commit unexpectedly succeeded" >&2
  exit 1
fi
[[ "$(cat "$WORK_DIR/flag")" == "false" ]]
[[ ! -e "$WORK_DIR/flag.lease" ]]
grep -Fq 'rollback_attempted=true' "$WORK_DIR/commit-ambiguous/control.env"

echo "live betting control contract: PASS"
