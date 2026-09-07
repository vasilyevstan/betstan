#!/usr/bin/env bash
set -euo pipefail

# Behavioural contract for protected upstream run bindings.
#
# A release chain once consumed a one-use protected authority and only then
# discovered that a required upstream run did not exist for that SHA, which
# permanently stranded that master commit. These cases exercise the shared
# validator against recorded GitHub API fixtures so every rejection is proven by
# behaviour rather than by grepping source text.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
POLICY="$ROOT_DIR/infra/azure/agents/copilot-cli-protected-operation-policy-stan.sh"
VALIDATOR="$ROOT_DIR/infra/oci/scripts/upstream_run_binding_stan.py"
BINDING_MANIFEST="$ROOT_DIR/infra/oci/policy/upstream-run-bindings.json"
DISPATCHER="$ROOT_DIR/infra/azure/agents/copilot-cli-dispatch-stan.sh"
WORKFLOW="$ROOT_DIR/.github/workflows/oci-infrastructure.yml"
AUTHORITY_HELPER="$ROOT_DIR/infra/azure/agents/copilot_cli_authority_stan.py"

REPO="vasilyevstan/betstan"
SUBJECT_SHA="ac1008081411d64d96dd0221126090577ea72c6b"
CAPACITY_RUN=34122018082
WORKFLOW_ID=325567150

WORK="$(mktemp -d "${TMPDIR:-/tmp}/betstan-upstream-binding-XXXXXX")"
chmod 700 "$WORK"
trap 'rm -rf "$WORK"' EXIT

passed=0
fail() {
  printf 'upstream binding contract failed: %s\n' "$*" >&2
  exit 1
}
ok() {
  passed=$((passed + 1))
  printf 'PASS %s\n' "$1"
}

mkdir -p "$WORK/bin"
cat >"$WORK/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[ "${1:-}" = "api" ] || { echo "unexpected gh invocation: $*" >&2; exit 1; }
file="$FIXTURE_DIR/$(printf '%s' "$2" | tr '/?=&' '____')"
[ -f "$file" ] || { echo "no fixture for $2" >&2; exit 1; }
cat "$file"
EOF
chmod 755 "$WORK/bin/gh"

fixture() {
  cat >"$FIXTURE_DIR/$(printf '%s' "$1" | tr '/?=&' '____')"
}

reset_fixtures() {
  FIXTURE_DIR="$WORK/api"
  rm -rf "$FIXTURE_DIR"
  mkdir -p "$FIXTURE_DIR"
  export FIXTURE_DIR
}

artifact_zip_fixture() {
  local artifact_id="$1"
  local file_name="$2"
  local content="$3"
  local destination
  destination="$FIXTURE_DIR/$(printf '%s' \
    "repos/$REPO/actions/artifacts/$artifact_id/zip" | tr '/?=&' '____')"
  python3 - "$destination" "$file_name" "$content" <<'PY'
import sys
import zipfile

destination, file_name, content = sys.argv[1:]
with zipfile.ZipFile(destination, "w", zipfile.ZIP_DEFLATED) as bundle:
    bundle.writestr(file_name, content)
PY
}

# attempt event title path repo branch sha status conclusion workflow_id
write_capacity_fixtures() {
  local attempt="${1:-1}" event="${2:-workflow_dispatch}" title="${3:-}"
  local path="${4:-.github/workflows/oci-capacity-acquire.yml}"
  local repo="${5:-$REPO}" branch="${6:-master}" sha="${7:-$SUBJECT_SHA}"
  local status="${8:-completed}" conclusion="${9:-success}"
  local wfid="${10:-$WORKFLOW_ID}"
  [ -n "$title" ] || title="oci-capacity-acquire $SUBJECT_SHA"
  fixture "repos/$REPO/actions/workflows/oci-capacity-acquire.yml" <<EOF2
{"id": $WORKFLOW_ID}
EOF2
  fixture "repos/$REPO/actions/runs/$CAPACITY_RUN" <<EOF2
{"id": $CAPACITY_RUN, "run_attempt": $attempt, "workflow_id": $wfid, "path": "$path",
 "head_repository": {"full_name": "$repo"}, "head_branch": "$branch",
 "head_sha": "$sha", "status": "$status", "conclusion": "$conclusion",
 "event": "$event", "display_title": "$title"}
EOF2
  fixture "repos/$REPO/actions/runs/$CAPACITY_RUN/attempts/1" <<EOF2
{"id": $CAPACITY_RUN, "run_attempt": 1, "workflow_id": $wfid, "path": "$path",
 "head_repository": {"full_name": "$repo"}, "head_branch": "$branch",
 "head_sha": "$sha", "status": "$status", "conclusion": "$conclusion",
 "event": "$event", "display_title": "$title"}
EOF2
  fixture "repos/$REPO/actions/runs/$CAPACITY_RUN/artifacts?per_page=100" <<EOF2
{"total_count": 1, "artifacts": [{"name": "oci-capacity-provenance-$CAPACITY_RUN-1",
 "id": 9001, "expired": false, "size_in_bytes": 1361}]}
EOF2
  artifact_zip_fixture 9001 provenance.env \
    "source_sha=$sha
acquisition_run_id=$CAPACITY_RUN
runtime_mode=k3s
shape=VM.Standard.A1.Flex
ocpus=2
memory_gb=12
boot_volume_gb=50
boot_volume_vpus_per_gb=10
"
}

binding_json() {
  "$POLICY" get oci-infrastructure-finalize-k3s |
    python3 -c '
import json, sys
for binding in json.load(sys.stdin)["upstreamRunBindings"]:
    if binding["input"] == "capacity_acquisition_run_id":
        print(json.dumps(binding))
        break
'
}
CAPACITY_BINDING_JSON="$(binding_json)"

run_validator() {
  PATH="$WORK/bin:$PATH" "$VALIDATOR" validate \
    --repository "$REPO" \
    --binding "$CAPACITY_BINDING_JSON" \
    --subject-sha "$SUBJECT_SHA" \
    --run-id "$CAPACITY_RUN" 2>"$WORK/err.txt"
}

expect_reject() {
  local label="$1"; shift
  reset_fixtures
  write_capacity_fixtures "$@"
  if run_validator >/dev/null; then
    fail "$label was accepted"
  fi
  ok "reject $label"
}

# ------------------------------------------------------------ accept good ---
reset_fixtures
write_capacity_fixtures
run_validator >/dev/null || fail "exact capacity run rejected: $(cat "$WORK/err.txt")"
ok "accept exact first-attempt dispatched capacity run"

reset_fixtures
write_capacity_fixtures
fixture "repos/$REPO/actions/runs/$CAPACITY_RUN/artifacts?per_page=100" <<EOF2
[
  {
    "total_count": 2,
    "artifacts": [
      {"name": "unrelated", "expired": false, "size_in_bytes": 10}
    ]
  },
  {
    "total_count": 2,
    "artifacts": [
      {
        "name": "oci-capacity-provenance-$CAPACITY_RUN-1",
        "id": 9001,
        "expired": false,
        "size_in_bytes": 1361
      }
    ]
  }
]
EOF2
run_validator >/dev/null || fail "artifact on a later page was rejected"
ok "accept exact artifact from the complete paginated inventory"

reset_fixtures
write_capacity_fixtures 1 schedule "oci-capacity-acquire scheduled-master"
run_validator >/dev/null || fail "scheduled capacity run rejected"
ok "accept scheduled capacity run with its exact title"

# ------------------------------------------------------------ reject cases ---
expect_reject "rerun with current attempt 2" 2
expect_reject "wrong event" 1 push
expect_reject "wrong title" 1 workflow_dispatch "oci-capacity-acquire wrong"
expect_reject "scheduled title on a dispatch event" 1 workflow_dispatch \
  "oci-capacity-acquire scheduled-master"
expect_reject "wrong workflow path" 1 workflow_dispatch "" \
  ".github/workflows/oci-production-build.yml"
expect_reject "wrong repository" 1 workflow_dispatch "" \
  ".github/workflows/oci-capacity-acquire.yml" "someone/else"
expect_reject "wrong branch" 1 workflow_dispatch "" \
  ".github/workflows/oci-capacity-acquire.yml" "$REPO" "dev"
expect_reject "wrong subject SHA" 1 workflow_dispatch "" \
  ".github/workflows/oci-capacity-acquire.yml" "$REPO" master "$(printf 'b%.0s' {1..40})"
expect_reject "incomplete run" 1 workflow_dispatch "" \
  ".github/workflows/oci-capacity-acquire.yml" "$REPO" master "$SUBJECT_SHA" in_progress
expect_reject "failed run" 1 workflow_dispatch "" \
  ".github/workflows/oci-capacity-acquire.yml" "$REPO" master "$SUBJECT_SHA" completed failure
expect_reject "wrong workflow id" 1 workflow_dispatch "" \
  ".github/workflows/oci-capacity-acquire.yml" "$REPO" master "$SUBJECT_SHA" completed success 999

artifact_case() {
  reset_fixtures
  write_capacity_fixtures
  fixture "repos/$REPO/actions/runs/$CAPACITY_RUN/artifacts?per_page=100" <<<"$2"
  if run_validator >/dev/null; then
    fail "$1 was accepted"
  fi
  ok "reject $1"
}
artifact_case "missing artifact" '{"total_count":0,"artifacts":[]}'
artifact_case "expired artifact" \
  "{\"total_count\":1,\"artifacts\":[{\"name\":\"oci-capacity-provenance-$CAPACITY_RUN-1\",\"expired\":true,\"size_in_bytes\":10}]}"
artifact_case "zero-byte artifact" \
  "{\"total_count\":1,\"artifacts\":[{\"name\":\"oci-capacity-provenance-$CAPACITY_RUN-1\",\"expired\":false,\"size_in_bytes\":0}]}"
artifact_case "duplicate artifact" \
  "{\"total_count\":2,\"artifacts\":[{\"name\":\"oci-capacity-provenance-$CAPACITY_RUN-1\",\"expired\":false,\"size_in_bytes\":5},{\"name\":\"oci-capacity-provenance-$CAPACITY_RUN-1\",\"expired\":false,\"size_in_bytes\":5}]}"

reset_fixtures
write_capacity_fixtures
artifact_zip_fixture 9001 provenance.env \
  "source_sha=$(printf 'b%.0s' {1..40})
acquisition_run_id=$CAPACITY_RUN
runtime_mode=k3s
shape=VM.Standard.A1.Flex
ocpus=2
memory_gb=12
boot_volume_gb=50
boot_volume_vpus_per_gb=10
"
if run_validator >/dev/null; then
  fail "capacity artifact with wrong source SHA was accepted"
fi
ok "reject capacity artifact content mismatch"

reset_fixtures
write_capacity_fixtures
fixture "repos/$REPO/actions/runs/$CAPACITY_RUN" <<EOF2
{"id": 99, "run_attempt": 1, "workflow_id": $WORKFLOW_ID,
 "path": ".github/workflows/oci-capacity-acquire.yml",
 "head_repository": {"full_name": "$REPO"}, "head_branch": "master",
 "head_sha": "$SUBJECT_SHA", "status": "completed", "conclusion": "success",
 "event": "workflow_dispatch",
 "display_title": "oci-capacity-acquire $SUBJECT_SHA"}
EOF2
if run_validator >/dev/null; then
  fail "run endpoint with a different ID was accepted"
fi
ok "reject run endpoint identity mismatch"

reset_fixtures
write_capacity_fixtures
fixture "repos/$REPO/actions/runs/$CAPACITY_RUN/attempts/1" <<EOF2
{"id": $CAPACITY_RUN, "run_attempt": 1, "workflow_id": $WORKFLOW_ID,
 "path": ".github/workflows/oci-capacity-acquire.yml",
 "head_repository": {"full_name": "$REPO"}, "head_branch": "master",
 "head_sha": "$(printf 'c%.0s' {1..40})", "status": "completed",
 "conclusion": "success", "event": "workflow_dispatch",
 "display_title": "oci-capacity-acquire $SUBJECT_SHA"}
EOF2
if run_validator >/dev/null; then
  fail "attempt-1 identity mismatch was accepted"
fi
ok "reject attempt-1 identity mismatch"

write_build_package_fixtures() {
  local candidate_build_id="$1"
  local build_run=101 package_run=202
  fixture "repos/$REPO/actions/workflows/oci-production-build.yml" <<'EOF2'
{"id": 401}
EOF2
  fixture "repos/$REPO/actions/runs/$build_run" <<EOF2
{"id": $build_run, "run_attempt": 1, "workflow_id": 401,
 "path": ".github/workflows/oci-production-build.yml",
 "head_repository": {"full_name": "$REPO"}, "head_branch": "master",
 "head_sha": "$SUBJECT_SHA", "status": "completed", "conclusion": "success",
 "event": "workflow_run", "display_title": "unpredictable build title",
 "created_at": "2026-01-01T00:00:00Z",
 "updated_at": "2026-01-01T00:10:00Z"}
EOF2
  fixture "repos/$REPO/actions/runs/$build_run/attempts/1" <<EOF2
{"id": $build_run, "run_attempt": 1, "workflow_id": 401,
 "path": ".github/workflows/oci-production-build.yml",
 "head_repository": {"full_name": "$REPO"}, "head_branch": "master",
 "head_sha": "$SUBJECT_SHA", "status": "completed", "conclusion": "success",
 "event": "workflow_run", "display_title": "unpredictable build title"}
EOF2
  fixture "repos/$REPO/actions/runs/$build_run/artifacts?per_page=100" <<EOF2
{"total_count": 1, "artifacts": [{
 "id": 9101,
 "name": "oci-image-provenance-$SUBJECT_SHA-$build_run-1",
 "expired": false, "size_in_bytes": 2048}]}
EOF2
  artifact_zip_fixture 9101 build-chain.txt \
    "source_sha=$SUBJECT_SHA
build_run_id=$build_run
build_run_attempt=1
registry_provider=ghcr
registry_host=ghcr.io
registry_repository=ghcr.io/vasilyevstan/betstan-images
registry_public=true
anonymous_pull=pass
"

  fixture "repos/$REPO/actions/workflows/ghcr-package-management.yml" <<'EOF2'
{"id": 402}
EOF2
  fixture "repos/$REPO/actions/runs/$package_run" <<EOF2
{"id": $package_run, "run_attempt": 1, "workflow_id": 402,
 "path": ".github/workflows/ghcr-package-management.yml",
 "head_repository": {"full_name": "$REPO"}, "head_branch": "master",
 "head_sha": "$SUBJECT_SHA", "status": "completed", "conclusion": "success",
 "event": "workflow_dispatch",
 "display_title": "ghcr-package validate $SUBJECT_SHA",
 "created_at": "2026-01-01T00:11:00Z",
 "updated_at": "2026-01-01T00:20:00Z"}
EOF2
  fixture "repos/$REPO/actions/runs/$package_run/attempts/1" <<EOF2
{"id": $package_run, "run_attempt": 1, "workflow_id": 402,
 "path": ".github/workflows/ghcr-package-management.yml",
 "head_repository": {"full_name": "$REPO"}, "head_branch": "master",
 "head_sha": "$SUBJECT_SHA", "status": "completed", "conclusion": "success",
 "event": "workflow_dispatch",
 "display_title": "ghcr-package validate $SUBJECT_SHA"}
EOF2
  fixture "repos/$REPO/actions/runs/$package_run/artifacts?per_page=100" <<EOF2
{"total_count": 1, "artifacts": [{
 "id": 9102,
 "name": "ghcr-package-management-validate-$package_run-1",
 "expired": false, "size_in_bytes": 2048}]}
EOF2
  artifact_zip_fixture 9102 validation-summary.json \
    "{\"terminal_status\":\"VALIDATED\",\"registry_provider\":\"ghcr\",\"registry_host\":\"ghcr.io\",\"repository\":\"ghcr.io/vasilyevstan/betstan-images\",\"package_visibility\":\"public\",\"repository_linked\":true,\"candidate_build_run_id\":\"$candidate_build_id\"}"
}

reset_fixtures
write_build_package_fixtures 101
PATH="$WORK/bin:$PATH" "$VALIDATOR" validate-all \
  --repository "$REPO" \
  --policy-json "$("$POLICY" get oci-infrastructure-finalize-oke)" \
  --subject-sha "$SUBJECT_SHA" \
  --dispatch-inputs \
    '{"ghcr_build_run_id":"101","ghcr_package_validation_run_id":"202"}' \
  >/dev/null || fail "matching build/package content was rejected"
ok "accept package artifact bound to the exact build"

reset_fixtures
write_build_package_fixtures 999
if PATH="$WORK/bin:$PATH" "$VALIDATOR" validate-all \
  --repository "$REPO" \
  --policy-json "$("$POLICY" get oci-infrastructure-finalize-oke)" \
  --subject-sha "$SUBJECT_SHA" \
  --dispatch-inputs \
    '{"ghcr_build_run_id":"101","ghcr_package_validation_run_id":"202"}' \
  >/dev/null 2>&1; then
  fail "package artifact for a different candidate build was accepted"
fi
ok "reject package artifact for a different candidate build"

reset_fixtures
if PATH="$WORK/bin:$PATH" "$VALIDATOR" validate --repository "$REPO" \
  --binding '{"input":"x","workflow":"a.yml","titleTemplates":{"workflow_run":null},"artifactTemplate":"only-{run_id}"}' \
  --subject-sha "$SUBJECT_SHA" --run-id 1 >/dev/null 2>&1; then
  fail "null title without a SHA-bound artifact was accepted"
fi
ok "reject null title unless the artifact binds subject SHA and run"

if PATH="$WORK/bin:$PATH" "$VALIDATOR" validate-all \
  --repository "$REPO" \
  --policy-json '{
    "upstreamRunBindings": [
      {
        "input": "duplicate",
        "workflow": "a.yml",
        "titleTemplates": {"workflow_dispatch": "a {subject_sha}"},
        "artifactTemplate": "a-{run_id}"
      },
      {
        "input": "duplicate",
        "workflow": "b.yml",
        "titleTemplates": {"workflow_dispatch": "b {subject_sha}"},
        "artifactTemplate": "b-{run_id}"
      }
    ]
  }' \
  --subject-sha "$SUBJECT_SHA" \
  --dispatch-inputs '{"duplicate":"1"}' >/dev/null 2>&1; then
  fail "duplicate binding inputs were accepted"
fi
ok "reject duplicate binding inputs"

if PATH="$WORK/bin:$PATH" "$VALIDATOR" validate-all \
  --repository "$REPO" \
  --policy-json '{
    "upstreamRunBindings": [
      {
        "input": "current",
        "afterInput": "missing",
        "workflow": "a.yml",
        "titleTemplates": {"workflow_dispatch": "a {subject_sha}"},
        "artifactTemplate": "a-{run_id}"
      }
    ]
  }' \
  --subject-sha "$SUBJECT_SHA" \
  --dispatch-inputs '{"current":"1"}' >/dev/null 2>&1; then
  fail "unknown chronology dependency was accepted"
fi
ok "reject unknown chronology dependencies"

# ---------------------------------------------------- k3s / OKE mode split ---
"$POLICY" get oci-infrastructure-finalize-k3s | python3 -c '
import json, sys
p = json.load(sys.stdin)
assert p["fixedInputs"]["runtime_mode"] == "k3s"
assert "capacity_acquisition_run_id" in p["positiveIntegerInputs"]
assert "capacity_acquisition_run_id" not in p["fixedInputs"]
assert [b["input"] for b in p["upstreamRunBindings"]] == [
    "ghcr_build_run_id", "ghcr_package_validation_run_id",
    "capacity_acquisition_run_id"]
' || fail "k3s finalize policy is wrong"
ok "k3s finalize requires the exact capacity run"

"$POLICY" get oci-infrastructure-finalize-oke | python3 -c '
import json, sys
p = json.load(sys.stdin)
assert p["fixedInputs"]["runtime_mode"] == "oke"
assert p["fixedInputs"]["capacity_acquisition_run_id"] == ""
assert "capacity_acquisition_run_id" not in p["positiveIntegerInputs"]
assert [b["input"] for b in p["upstreamRunBindings"]] == [
    "ghcr_build_run_id", "ghcr_package_validation_run_id"]
' || fail "OKE finalize policy is wrong"
ok "OKE finalize forces an empty capacity run and keeps GHCR bindings"

"$POLICY" get oci-infrastructure-finalize-k3s | python3 -c '
import json, sys
by = {b["input"]: b for b in json.load(sys.stdin)["upstreamRunBindings"]}
build = by["ghcr_build_run_id"]
assert build["artifactTemplate"] == "oci-image-provenance-{subject_sha}-{run_id}-1"
assert build["titleTemplates"] == {"workflow_run": None}
pkg = by["ghcr_package_validation_run_id"]
assert pkg["titleTemplates"] == {"workflow_dispatch": "ghcr-package validate {subject_sha}"}
assert pkg["artifactTemplate"] == "ghcr-package-management-validate-{run_id}-1"
assert pkg["afterInput"] == "ghcr_build_run_id"
cap = by["capacity_acquisition_run_id"]
assert cap["titleTemplates"] == {
    "workflow_dispatch": "oci-capacity-acquire {subject_sha}",
    "schedule": "oci-capacity-acquire scheduled-master"}
assert "titleOptionalEvents" not in cap
assert cap["afterInput"] == "ghcr_package_validation_run_id"
' || fail "finalize prerequisite bindings are incomplete"
ok "GHCR build and package validation are bound like capacity"

# ------------------------------------------- input hash must include the run ---
policy_file="$WORK/policy.json"
"$POLICY" get oci-infrastructure-finalize-k3s >"$policy_file"
emit_hash() {
  python3 - "$1" >"$WORK/request.json" <<'PY'
import json
import sys
print(json.dumps({
    "schemaVersion": "betstan.copilot-cli-dispatch-request.v1",
    "repository": "vasilyevstan/betstan",
    "operation": "oci-infrastructure-finalize-k3s",
    "controlSha": "a" * 40, "subjectSha": "a" * 40, "targetSha": None,
    "inputs": {
        "approved_sha": "a" * 40,
        "confirmation": "PROVISION OCI ZERO COST", "phase": "finalize",
        "candidate_build_run_id": "", "obsolete_sha": "",
        "obsolete_build_run_id": "", "obsolete_generations": "",
        "deployed_sha": "", "deployed_run_id": "", "fallback_sha": "",
        "fallback_build_run_id": "", "validation_run_id": "",
        "ghcr_build_run_id": "11", "ghcr_package_validation_run_id": "22",
        "capacity_acquisition_run_id": sys.argv[1], "runtime_mode": "k3s",
    },
}))
PY
  chmod 600 "$WORK/request.json"
  "$AUTHORITY_HELPER" validate-request \
    --request "$WORK/request.json" --policy-json "$(cat "$policy_file")" \
    --repository "$REPO" --current-master "$(printf 'a%.0s' {1..40})" \
    --repo-root "$ROOT_DIR" --output "$WORK/normalized-$1.json" >/dev/null
  python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["inputHash"])' \
    "$WORK/normalized-$1.json"
}
hash_a="$(emit_hash 4444)" || fail "normalization failed for capacity run 4444"
hash_b="$(emit_hash 5555)" || fail "normalization failed for capacity run 5555"
[ "$hash_a" != "$hash_b" ] ||
  fail "explicit capacity run ID does not change the dispatch input hash"
ok "capacity run ID is covered by the dispatch input hash"

# ----------------------------- validation precedes authority and cloud use ---
python3 - "$DISPATCHER" <<'PY' || fail "prerequisites are not proven before authority"
import sys

text = open(sys.argv[1], encoding="utf-8").read()
definition = text.index("validate_protected_prerequisites() {")
materialization = text.index("materialize_record() {")
resume_validation = text.index("resume_with_prerequisite_validation() {")
resume_run = text.index('if [[ "$ACTION" = "--resume-run" ]]; then')
resume_captured = text.index('if [[ "$ACTION" = "--resume-captured" ]]; then')
if not materialization < definition < resume_validation < resume_run < resume_captured:
    raise SystemExit("materialization and validator must precede both resume paths")
for start in (resume_run, resume_captured):
    window = text[start:start + 800]
    if "bind-intent" not in window or "resume_with_prerequisite_validation" not in window:
        raise SystemExit("a resume path does not bind and validate its exact run")
    if window.index("bind-intent") > window.index("resume_with_prerequisite_validation"):
        raise SystemExit("a resume path validates before binding the captured run")
materialization_body = text[
    materialization:text.index("\nif [[ -n \"$ACTION\" ]]", materialization)
]
if materialization_body.index("validate_protected_prerequisites") > materialization_body.index(
    '"$AUTHORITY_HELPER" issue'
):
    raise SystemExit("a materialized claim can be issued before prerequisites pass")
if "begin_prerequisite_rejection" not in materialization_body:
    raise SystemExit("materialization does not persist prerequisite rejection")
retirement = text[
    text.index("begin_prerequisite_rejection() {"):resume_validation
]
for required in (
    "begin-prerequisite-rejection",
    'actions/runs/$run_id/cancel',
    "retire-prerequisite-rejected-claim",
):
    if required not in retirement:
        raise SystemExit(f"resume rejection omits safe terminalization: {required}")
guard = text.index('[[ "$ACTION" = "--dispatch" ]] || exit 0')
ready = text.index("dispatch=READY operation=")
call = text.rindex("\nvalidate_protected_prerequisites\n")
if not call < ready < guard < text.index("blocking-record", guard):
    raise SystemExit("fresh dispatch must prove prerequisites before READY and blocking")
claim = text.index('"$AUTHORITY_HELPER" claim-request', guard)
post_claim = text.index("dispatch_revalidation_error=", claim)
dispatch = text.index("gh workflow run", post_claim)
if "validate_protected_prerequisites" not in text[post_claim:dispatch]:
    raise SystemExit("fresh dispatch does not revalidate prerequisites after its claim")
post_claim_body = text[post_claim:dispatch]
if post_claim_body.rfind("revalidate_dispatch_target") < post_claim_body.index(
    "validate_protected_prerequisites"
):
    raise SystemExit("fresh dispatch does not revalidate mutable master after prerequisites")
if ".dispatchInputs" not in text:
    raise SystemExit("dispatcher must read the hashed dispatchInputs map")
if "OCI_RUNTIME_MODE" not in text:
    raise SystemExit("dispatcher must prove the authoritative runtime mode")
print("ordering ok")
PY
ok "fresh dispatch and bound resume paths prove prerequisites before issuance"

python3 - "$WORKFLOW" "$ROOT_DIR/infra/oci/scripts/bind-infrastructure-prerequisites-stan.sh" \
  <<'PY' || fail "workflow validates bindings after cloud access"
import sys

text = open(sys.argv[1], encoding="utf-8").read()
gate_body = open(sys.argv[2], encoding="utf-8").read()
provision = text.index("\n  provision:")
gate = text.index("Bind runtime mode and prove upstream prerequisites", provision)
ghcr = text.index("Verify GHCR build and package evidence content", provision)
capacity = text.index("Download bound k3s capacity provenance", provision)
for name in (
    "Install pinned OCI CLI and verify identity",
    "Zero-cost preflight and cloud reconciliation",
    "Reconcile expired GitHub runner rules",
    "Install pinned cluster add-ons",
    "Open ephemeral OCI Bastion access",
):
    if not gate < ghcr < capacity < text.index(name, provision):
        raise SystemExit(f"binding validation must precede: {name}")
if "--workflow oci-capacity-acquire.yml" in text:
    raise SystemExit("finalize still scans for capacity runs")
# The gate body lives in an executable script so it can be run under `set -u`
# instead of only statically inspected; the workflow must invoke exactly it.
if "bind-infrastructure-prerequisites-stan.sh" not in text:
    raise SystemExit("workflow does not invoke the extracted prerequisite gate")
if "DISPATCH_INPUTS: ${{ toJSON(inputs) }}" not in text:
    raise SystemExit("workflow does not export the real dispatch input map")
if "source artifacts/oci-capacity/provenance.env" in text:
    raise SystemExit("capacity provenance can overwrite values it is checked against")
if "capacity provenance contains an unsafe or duplicate assignment" not in text:
    raise SystemExit("capacity provenance is not parsed without shell evaluation")
if 'BOUND_RUNTIME_MODE" = "$OCI_RUNTIME_MODE' not in gate_body:
    raise SystemExit("gate does not bind runtime mode to the environment")
if "validate-all" not in gate_body:
    raise SystemExit("gate does not use the shared upstream validator")
if "$DISPATCH_INPUTS" not in gate_body:
    raise SystemExit("gate does not forward the exported dispatch input map")
# Run identity for the finalize prerequisites belongs to the shared validator.
# A second, weaker copy inside the GHCR/capacity evidence steps is exactly the
# drift this contract exists to prevent. Unrelated phases (registry prune,
# image provenance) keep their own long-standing validate_run helper.
evidence = text.index("Verify GHCR build and package evidence content", provision)
after_capacity = text.index(
    "Install pinned OCI CLI and verify identity", provision
)
finalize_region = text[evidence:after_capacity]
for duplicated in ("head_sha", "run_attempt", "actions/workflows/"):
    if duplicated in finalize_region:
        raise SystemExit(
            f"finalize evidence steps duplicate run identity: {duplicated}"
        )
print("workflow ordering ok")
PY
ok "workflow proves bindings before every cloud access and mutation"

for forbidden in SKIP_CAPACITY FORCE_FINALIZE BYPASS_CAPACITY IGNORE_UPSTREAM \
  titleOptionalEvents allow-missing-upstream; do
  if grep -rqF -- "$forbidden" "$DISPATCHER" "$WORKFLOW" "$POLICY" "$VALIDATOR"; then
    fail "a bypass or escape hatch is present: $forbidden"
  fi
done
ok "no force, retry, skip or allow-missing knob was introduced"

# The workflow reads a checked-in manifest so it never depends on the Azure
# agent tree. Prove that manifest is exactly the policy the dispatcher uses.
python3 - "$POLICY" "$BINDING_MANIFEST" <<'EQUIV' || fail "binding manifest drifted from the policy"
import json
import subprocess
import sys

policy_script, manifest_path = sys.argv[1:3]
manifest = json.load(open(manifest_path, encoding="utf-8"))
if sorted(manifest) != [
    "oci-infrastructure-finalize-k3s",
    "oci-infrastructure-finalize-oke",
]:
    raise SystemExit("manifest does not cover exactly both finalize operations")
for operation, bindings in manifest.items():
    policy = json.loads(
        subprocess.run(
            [policy_script, "get", operation],
            capture_output=True, text=True, check=True,
        ).stdout
    )
    if policy["upstreamRunBindings"] != bindings:
        raise SystemExit(f"{operation} manifest differs from the policy")
for operation in (
    "oci-infrastructure-prepare-k3s",
    "oci-infrastructure-prepare-oke",
):
    policy = json.loads(
        subprocess.run(
            [policy_script, "get", operation],
            capture_output=True, text=True, check=True,
        ).stdout
    )
    if policy["upstreamRunBindings"] != []:
        raise SystemExit(f"{operation} silently bypasses declared prerequisites")
print("manifest equivalence ok")
EQUIV
ok "workflow binding manifest is byte-equivalent to the dispatcher policy"

printf 'oci_upstream_binding_contract=PASS cases=%d\n' "$passed"
