#!/usr/bin/env bash
set -euo pipefail

# Authority is one-use. If an upstream prerequisite decays between dispatch and
# approval, or between the inflight claim and the GitHub approval call, the
# approver must refuse and release the claim rather than spend authority on an
# invalid binding. These cases exercise the extracted revalidation contract with
# stubbed gh/policy/validator behaviour.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
APPROVER="$ROOT_DIR/infra/azure/agents/copilot-cli-run-approval-stan.sh"
WORKDIR="$ROOT_DIR/infra/oci/tests/.test-workdirs/approval-drift"
PASS=0
FAIL=0

rm -rf "$WORKDIR"
mkdir -p "$WORKDIR"
trap 'rm -rf "$WORKDIR"' EXIT

ok() {
  PASS=$((PASS + 1))
  echo "PASS $1"
}
bad() {
  FAIL=$((FAIL + 1))
  echo "FAIL $1"
}

# --- Structural guarantees the runtime cases depend on -----------------------

python3 - "$APPROVER" <<'PY' || bad "approver revalidation ordering is wrong"
import sys

text = open(sys.argv[1], encoding="utf-8").read()
definition = text.index("revalidate_upstream_bindings() {")
claim = text.index('"$AUTHORITY_HELPER" claim-approval')
approve_api = text.index("--method POST")
release = text.index('"$AUTHORITY_HELPER" release-approval')
pre = text.index("\nrevalidate_upstream_bindings\n", definition)
post = text.index("    revalidate_upstream_bindings\n", claim)
if not definition < pre < claim:
    raise SystemExit("bindings are not revalidated before the inflight claim")
if not claim < post < approve_api:
    raise SystemExit("bindings are not revalidated after the claim")
if not post < release < approve_api:
    raise SystemExit("post-claim drift does not release the inflight claim")
# The approver must reuse the shared validator and shared policy, never a third
# implementation that can drift from dispatch-time enforcement.
if "upstream_run_binding_stan.py" not in text:
    raise SystemExit("approver does not reuse the shared validator")
if "copilot-cli-protected-operation-policy-stan.sh" not in text:
    raise SystemExit("approver does not reuse the shared policy definition")
if "OCI_RUNTIME_MODE" not in text:
    raise SystemExit("approver does not revalidate the authoritative mode")
for knob in ("--force", "--skip", "allow_missing", "ALLOW_MISSING", "--retry"):
    if knob in text:
        raise SystemExit(f"approver introduced a bypass knob: {knob}")
print("approver ordering ok")
PY
[ "$FAIL" -eq 0 ] && ok "revalidation brackets the claim and reuses shared policy"

# --- Behavioural drift cases against the shared validator --------------------

VALIDATOR="$ROOT_DIR/infra/oci/scripts/upstream_run_binding_stan.py"
SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
POLICY_JSON='{"upstreamRunBindings":[{"artifactTemplate":"oci-capacity-provenance-{run_id}-1","input":"capacity_acquisition_run_id","titleTemplates":{"workflow_dispatch":"oci-capacity-acquire {subject_sha}"},"workflow":"oci-capacity-acquire.yml"}]}'

mkdir -p "$WORKDIR/bin"
export PATH="$WORKDIR/bin:$PATH"

write_gh() {
  cat >"$WORKDIR/bin/gh" <<STUB
#!/usr/bin/env bash
set -euo pipefail
source "$WORKDIR/state.sh"
path="\$2"
case "\$path" in
  *"/actions/workflows/oci-capacity-acquire.yml") echo '{"id":991,"path":".github/workflows/oci-capacity-acquire.yml","state":"active"}';;
  *"/actions/runs/700/attempts/1") echo "\$ATTEMPT1_JSON";;
  *"/actions/runs/700") echo "\$BASE_RUN_JSON";;
  *"/actions/runs/700/artifacts"*) echo "\$ARTIFACTS_JSON";;
  *) echo "unexpected gh path: \$path" >&2; exit 1;;
esac
STUB
  chmod 755 "$WORKDIR/bin/gh"
}
write_gh

good_run='{"id":700,"workflow_id":991,"path":".github/workflows/oci-capacity-acquire.yml","event":"workflow_dispatch","display_title":"oci-capacity-acquire '"$SHA"'","head_sha":"'"$SHA"'","head_branch":"master","head_repository":{"full_name":"vasilyevstan/betstan"},"status":"completed","conclusion":"success","run_attempt":1}'
future="$(python3 -c "
import datetime
print((datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(days=30)).strftime('%Y-%m-%dT%H:%M:%SZ'))
")"
past="$(python3 -c "
import datetime
print((datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(days=1)).strftime('%Y-%m-%dT%H:%M:%SZ'))
")"
good_artifacts='{"total_count":1,"artifacts":[{"name":"oci-capacity-provenance-700-1","expired":false,"size_in_bytes":4096,"expires_at":"'"$future"'"}]}'

set_state() {
  {
    echo "BASE_RUN_JSON='${1:-$good_run}'"
    echo "ATTEMPT1_JSON='${2:-$good_run}'"
    echo "ARTIFACTS_JSON='${3:-$good_artifacts}'"
  } >"$WORKDIR/state.sh"
}

drift_case() {
  local name="$1" expected="$2"
  local status=0 output
  output="$(
    "$VALIDATOR" validate-all \
      --repository vasilyevstan/betstan \
      --policy-json "$POLICY_JSON" \
      --subject-sha "$SHA" \
      --dispatch-inputs '{"capacity_acquisition_run_id":"700"}' 2>&1
  )" || status=$?
  if [ "$expected" = "accept" ] && [ "$status" -eq 0 ]; then
    ok "$name"
  elif [ "$expected" = "reject" ] && [ "$status" -ne 0 ]; then
    ok "$name (refused)"
  else
    bad "$name (status=$status expected=$expected) $output"
  fi
}

set_state
drift_case "approval accepts an unchanged valid binding" accept

# The artifact was deleted between dispatch and approval.
set_state "" "" '{"total_count":0,"artifacts":[]}'
drift_case "refuses a deleted upstream artifact" reject

# The artifact expired while the run waited at the protected gate.
set_state "" "" '{"total_count":1,"artifacts":[{"name":"oci-capacity-provenance-700-1","expired":true,"size_in_bytes":4096,"expires_at":"'"$past"'"}]}'
drift_case "refuses an expired upstream artifact" reject

# A zero-byte artifact proves nothing.
set_state "" "" '{"total_count":1,"artifacts":[{"name":"oci-capacity-provenance-700-1","expired":false,"size_in_bytes":0,"expires_at":"'"$future"'"}]}'
drift_case "refuses a zero-byte upstream artifact" reject

# Someone reran the upstream run after dispatch: attempt 1 still exists, so the
# base run's *current* attempt is the only honest signal.
rerun="$(python3 -c "
import json
d=json.loads('''$good_run'''); d['run_attempt']=2
print(json.dumps(d))
")"
set_state "$rerun" "$good_run"
drift_case "refuses an upstream run that was rerun after dispatch" reject

# The upstream run was retargeted to a different SHA.
other="$(python3 -c "
import json
d=json.loads('''$good_run'''); d['head_sha']='b'*40
print(json.dumps(d))
")"
set_state "$other" "$other"
drift_case "refuses an upstream run for a different SHA" reject

# Conclusion changed to failure.
failed="$(python3 -c "
import json
d=json.loads('''$good_run'''); d['conclusion']='failure'
print(json.dumps(d))
")"
set_state "$failed" "$failed"
drift_case "refuses an upstream run that is not successful" reject

# Title no longer matches the exact per-event template.
retitled="$(python3 -c "
import json
d=json.loads('''$good_run'''); d['display_title']='oci-capacity-acquire something-else'
print(json.dumps(d))
")"
set_state "$retitled" "$retitled"
drift_case "refuses an upstream run with a mismatched exact title" reject

echo "approval drift: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
