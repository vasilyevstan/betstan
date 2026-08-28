#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
INVENTORY="$ROOT_DIR/infra/azure/agents/production-workflow-inventory-stan.sh"
tmp_dir="$(mktemp -d "$ROOT_DIR/.workflow-inventory-test.XXXXXX")"
support_dir="$(mktemp -d "$ROOT_DIR/.workflow-inventory-support.XXXXXX")"
local_extra_paths_file="$support_dir/local-extra-paths.bin"
cleanup() {
  rm -rf -- "$tmp_dir"
  rm -rf -- "$support_dir"
}
trap cleanup EXIT

reset_fixtures() {
  python3 - "$tmp_dir" <<'PY'
import shutil
import sys
from pathlib import Path

root = Path(sys.argv[1])
for child in root.iterdir():
    if child.is_dir() and not child.is_symlink():
        shutil.rmtree(child)
    else:
        child.unlink()
PY
  rm -f -- "$local_extra_paths_file"
  cp "$ROOT_DIR/.github/workflows/production-build.yml" "$tmp_dir/"
  cp "$ROOT_DIR/.github/workflows/production-deploy.yml" "$tmp_dir/"
  cp "$ROOT_DIR/.github/workflows/production-rollback.yml" "$tmp_dir/"

  cat > "$tmp_dir/oci-validate.yml" <<'YAML'
name: oci-validate
on:
  pull_request:
    branches: [dev, master]
jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - run: terraform validate
YAML
}

write_complete_oci_set() {
  cat > "$tmp_dir/oci-capacity-acquire.yml" <<'YAML'
name: oci-capacity-acquire
run-name: oci-capacity-acquire ${{ inputs.approved_sha || 'scheduled-master' }}
on:
  schedule:
    - cron: "*/5 * * * *"
  workflow_dispatch:
    inputs:
      approved_sha:
        required: true
        type: string
jobs:
  acquire:
    if: github.run_attempt == 1 && ((github.event_name == 'schedule' && vars.OCI_CAPACITY_CATCHER_ENABLED == 'true') || github.event_name == 'workflow_dispatch')
    runs-on: ubuntu-latest
    environment:
      name: oci-capacity-acquire
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ inputs.approved_sha }}
      - env:
          OCI_CLI_KEY_CONTENT: ${{ secrets.OCI_CAPACITY_PRIVATE_KEY_PEM }}
        run: |
          [ "$GITHUB_REF_NAME" = "master" ]
          source_sha="${{ inputs.approved_sha }}"
          if [ -z "$source_sha" ]; then
            source_sha="$(git rev-parse HEAD)"
          fi
          [[ "$source_sha" =~ ^[0-9a-f]{40}$ ]]
          git fetch origin master:refs/remotes/origin/master
          [ "$source_sha" = "$(git rev-parse origin/master)" ]
          oci compute compute-capacity-report create
YAML

  cat > "$tmp_dir/oci-production-build.yml" <<'YAML'
name: oci-production-build
on:
  workflow_run:
    workflows: ["production-build", "ghcr-package-management"]
    types: [completed]
env:
  IMAGE_TAG: ${{ github.event.workflow_run.head_sha }}
jobs:
  build:
    if: >-
      github.run_attempt == 1 &&
      github.event.workflow_run.conclusion == 'success' &&
      github.event.workflow_run.event == 'push' &&
      github.event.workflow_run.head_branch == 'master' &&
      github.event.workflow_run.head_repository.full_name == github.repository &&
      github.event.workflow_run.run_attempt == 1
    runs-on: ubuntu-latest
    environment:
      name: oci-build
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.workflow_run.head_sha }}
      - uses: docker/build-push-action@v6
        with:
          push: true
          tags: iad.ocir.io/example/betstan:${{ env.IMAGE_TAG }}
      - env:
          REPAIR_EXISTING_TAGS: ${{ steps.trust.outputs.repair_mode }}
        run: echo repair-guard
YAML

  cat > "$tmp_dir/oci-infrastructure.yml" <<'YAML'
name: oci-infrastructure
run-name: provision ${{ inputs.approved_sha }}
on:
  workflow_dispatch:
    inputs:
      approved_sha:
        required: true
        type: string
jobs:
  apply:
    if: github.run_attempt == 1
    runs-on: ubuntu-latest
    environment:
      name: oci-infrastructure
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ inputs.approved_sha }}
      - run: |
          [ "$GITHUB_REF_NAME" = "master" ]
          [[ "${{ inputs.approved_sha }}" =~ ^[0-9a-f]{40}$ ]]
          git fetch origin master:refs/remotes/origin/master
          [ "${{ inputs.approved_sha }}" = "$(git rev-parse origin/master)" ]
          terraform apply
YAML

  cat > "$tmp_dir/oci-production-deploy.yml" <<'YAML'
name: oci-production-deploy
run-name: deploy ${{ inputs.approved_sha }}
on:
  workflow_dispatch:
    inputs:
      approved_sha:
        required: true
        type: string
jobs:
  deploy:
    if: github.run_attempt == 1
    runs-on: ubuntu-latest
    environment:
      name: oci-production
    env:
      SHARED_MONGO_DEPLOY_LOCK_LEASE_SECONDS: "10800"
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ inputs.approved_sha }}
      - run: |
          [ "$GITHUB_REF_NAME" = "master" ]
          [[ "${{ inputs.approved_sha }}" =~ ^[0-9a-f]{40}$ ]]
          git fetch origin master:refs/remotes/origin/master
          [ "${{ inputs.approved_sha }}" = "$(git rev-parse origin/master)" ]
          kubectl set image deployment/client client=iad.ocir.io/example/client:${{ inputs.approved_sha }}
          printf 'infrastructure_run_id=%s\n' "$INFRASTRUCTURE_RUN_ID"
          printf 'infrastructure_run_attempt=1\n'
          printf 'infrastructure_provenance_sha256=%s\n' "$INFRASTRUCTURE_SHA256"
          echo ".github/workflows/oci-production-rollback.yml"
          echo 'oci-production-rollback-${BASELINE_RECOVERY_RUN_ID}-1'
          ./infra/oci/scripts/validate-rollback-baseline-stan.sh
          LOCK_LEASE_SECONDS="$SHARED_MONGO_DEPLOY_LOCK_LEASE_SECONDS" \
            ./infra/oci/scripts/shared-mongo-operation-lock-stan.sh acquire
          ./infra/oci/scripts/shared-mongo-operation-lock-stan.sh renew
          LOCK_LEASE_SECONDS="$SHARED_MONGO_DEPLOY_LOCK_LEASE_SECONDS" \
            ./infra/oci/scripts/shared-mongo-operation-lock-stan.sh acquire
          ./infra/oci/scripts/shared-mongo-operation-lock-stan.sh renew
          echo "steps.handoff.outcome == 'success'"
          echo "steps.release_runtime.outcome != 'success'"
YAML

  cat > "$tmp_dir/oci-migrate.yml" <<'YAML'
name: oci-migrate
run-name: migrate ${{ inputs.approved_sha }}
on:
  workflow_dispatch:
    inputs:
      approved_sha:
        required: true
        type: string
jobs:
  migrate:
    if: github.run_attempt == 1
    runs-on: ubuntu-latest
    environment:
      name: oci-migration
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ inputs.approved_sha }}
      - env:
          AZURE_CREDENTIALS: ${{ secrets.AZURE_CREDENTIALS }}
          OCI_CLI_USER: ${{ secrets.OCI_CLI_USER }}
        run: |
          [ "$GITHUB_REF_NAME" = "master" ]
          [[ "${{ inputs.approved_sha }}" =~ ^[0-9a-f]{40}$ ]]
          git fetch origin master:refs/remotes/origin/master
          [ "${{ inputs.approved_sha }}" = "$(git rev-parse origin/master)" ]
          echo migrate
YAML

  cat > "$tmp_dir/oci-migration-recovery.yml" <<'YAML'
name: oci-migration-recovery
on:
  workflow_run:
    workflows: ["oci-migrate"]
    types: [completed]
    branches: [master]
  schedule:
    - cron: "*/15 * * * *"
  workflow_dispatch:
permissions:
  actions: write
  contents: read
concurrency:
  group: azure-migration-recovery
  cancel-in-progress: true
jobs:
  recover:
    if: >-
      github.run_attempt == 1 &&
      (
        github.event_name == 'workflow_dispatch' ||
        (
          github.event_name == 'schedule' &&
          vars.OCI_MIGRATION_RECOVERY_ENABLED == 'true'
        ) ||
        (
          github.event_name == 'workflow_run' &&
          github.event.workflow_run.head_branch == 'master' &&
          github.event.workflow_run.head_repository.full_name == github.repository &&
          github.event.workflow_run.run_attempt == 1
        )
      )
    runs-on: ubuntu-latest
    timeout-minutes: 30
    environment:
      name: azure-migration-recovery
    env:
      RECOVERY_ENABLED: ${{ vars.OCI_MIGRATION_RECOVERY_ENABLED || 'false' }}
      RECOVERY_ARM_UNTIL_EPOCH: ${{ vars.OCI_MIGRATION_RECOVERY_ARM_UNTIL_EPOCH || '0' }}
    steps:
      - uses: actions/checkout@v4
        with:
          ref: master
      - uses: azure/login@v2
        with:
          creds: ${{ secrets.AZURE_MIGRATION_RECOVERY_CREDENTIALS }}
      - run: |
          git fetch origin master:refs/remotes/origin/master
          [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/master)" ]
          [ $((RECOVERY_ARM_UNTIL_EPOCH - 1)) -le 86400 ]
          az aks show --name betstan-aks
          az aks stop --name betstan-aks
YAML

  cp "$ROOT_DIR/.github/workflows/oci-live-data-rollout.yml" "$tmp_dir/"
  cp "$ROOT_DIR/.github/workflows/oci-live-betting-activate.yml" "$tmp_dir/"
  cp "$ROOT_DIR/.github/workflows/oci-live-betting-disable.yml" "$tmp_dir/"
  cp "$ROOT_DIR/.github/workflows/oci-production-rollback.yml" "$tmp_dir/"
  cp "$ROOT_DIR/.github/workflows/oci-production-monitor.yml" "$tmp_dir/"
  cp "$ROOT_DIR/.github/workflows/ghcr-package-management.yml" "$tmp_dir/"
  cp "$ROOT_DIR/.github/workflows/oci-ghcr-cache-recovery.yml" "$tmp_dir/"
}

assert_pass() {
  local expected="$1"
  local actual
  actual="$(
    run_local_inventory |
      sed -n 's/^production_workflows=//p'
  )"
  [[ "$actual" == "$expected" ]] || {
    echo "expected=$expected actual=$actual" >&2
    exit 1
  }
}

assert_fail() {
  local label="$1"
  local expected_message="$2"
  local output
  if output="$(run_local_inventory 2>&1)"; then
    echo "$label unexpectedly passed: $output" >&2
    exit 1
  fi
  grep -Fq "$expected_message" <<<"$output" || {
    echo "$label failed without expected message: $output" >&2
    exit 1
  }
}

run_local_inventory() {
  if [[ -f "$local_extra_paths_file" ]]; then
    WORKFLOW_DIR="$tmp_dir" \
      WORKFLOW_INVENTORY_EXTRA_LOCAL_PATHS_FILE="$local_extra_paths_file" \
      "$INVENTORY"
  else
    WORKFLOW_DIR="$tmp_dir" "$INVENTORY"
  fi
}

pr_repo="example/repo"
pr_number="41"
pr_head_sha="1111111111111111111111111111111111111111"
pr_alt_head_sha="2222222222222222222222222222222222222222"
pr_tree_sha="3333333333333333333333333333333333333333"
pr_stub_dir="$support_dir/pr-bin"
pr_remote_root="$support_dir/pr-remote"
pr_state_dir="$support_dir/pr-state"
pr_tree_payload_file="$support_dir/pr-tree-payload.json"
pr_head_sha_after=""
pr_commit_lookup_fail="0"
pr_commit_tree_sha=""
pr_tree_truncated="0"

install_pr_gh_stub() {
  mkdir -p "$pr_stub_dir"
  cat >"$pr_stub_dir/gh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

repo="${GH_STUB_REPO:?}"
fixture_dir="${GH_STUB_FIXTURE_DIR:?}"
state_dir="${GH_STUB_STATE_DIR:?}"
head_sha="${GH_STUB_PR_HEAD_SHA:?}"
tree_sha="${GH_STUB_TREE_SHA:?}"
tree_payload_file="${GH_STUB_TREE_PAYLOAD_FILE:-}"
mkdir -p "$state_dir"

command_name="${1:-}"
[[ -n "$command_name" ]] || {
  echo "missing gh subcommand" >&2
  exit 1
}
shift || true

case "$command_name" in
  pr)
    [[ "${1:-}" == "view" ]] || {
      echo "unsupported gh pr subcommand" >&2
      exit 1
    }
    shift
    pr_number="${1:-}"
    shift || true
    repo_arg=""
    json_fields=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --repo)
          repo_arg="$2"
          shift 2
          ;;
        --json)
          json_fields="$2"
          shift 2
          ;;
        *)
          shift
          ;;
      esac
    done
    [[ -n "$pr_number" ]] || {
      echo "missing PR number" >&2
      exit 1
    }
    [[ "$repo_arg" == "$repo" ]] || {
      echo "unexpected repo=$repo_arg" >&2
      exit 1
    }
    [[ "$json_fields" == "headRefOid" ]] || {
      echo "unsupported gh pr view fields=$json_fields" >&2
      exit 1
    }
    count_file="$state_dir/pr-view-count"
    count=0
    [[ -f "$count_file" ]] && count="$(<"$count_file")"
    count=$((count + 1))
    printf '%s' "$count" >"$count_file"
    response_head="$head_sha"
    if [[ -n "${GH_STUB_PR_HEAD_SHA_AFTER:-}" && "$count" -ge 2 ]]; then
      response_head="$GH_STUB_PR_HEAD_SHA_AFTER"
    fi
    printf '{"headRefOid":"%s"}\n' "$response_head"
    ;;
  api)
    endpoint="${1:-}"
    [[ -n "$endpoint" ]] || {
      echo "missing gh api endpoint" >&2
      exit 1
    }
    case "$endpoint" in
      "repos/$repo/git/commits/"*)
        commit_sha="${endpoint##*/}"
        [[ "$commit_sha" == "$head_sha" ]] || {
          echo "unexpected commit lookup=$endpoint" >&2
          exit 1
        }
        if [[ "${GH_STUB_COMMIT_LOOKUP_FAIL:-0}" == "1" ]]; then
          echo "simulated commit lookup failure" >&2
          exit 1
        fi
        response_commit_sha="${GH_STUB_COMMIT_RESPONSE_SHA:-$head_sha}"
        response_tree_sha="${GH_STUB_COMMIT_TREE_SHA:-$tree_sha}"
        tree_url="https://api.github.com/repos/$repo/git/trees/$response_tree_sha"
        python3 - "$response_commit_sha" "$response_tree_sha" "$tree_url" <<'PY'
import json
import sys

print(
    json.dumps(
        {
            "sha": sys.argv[1],
            "tree": {"sha": sys.argv[2], "url": sys.argv[3]},
        }
    )
)
PY
        ;;
      "repos/$repo/git/trees/"*"?recursive=1")
        requested_tree_sha="${endpoint#repos/$repo/git/trees/}"
        requested_tree_sha="${requested_tree_sha%\?recursive=1}"
        [[ "$requested_tree_sha" == "$tree_sha" ]] || {
          echo "unexpected tree lookup=$endpoint" >&2
          exit 1
        }
        python3 - "$fixture_dir" "$tree_sha" "${GH_STUB_TREE_TRUNCATED:-0}" "$tree_payload_file" <<'PY'
import json
import sys
from pathlib import Path

fixture_dir = Path(sys.argv[1])
tree_sha = sys.argv[2]
truncated = sys.argv[3] == "1"
payload_path = Path(sys.argv[4]) if sys.argv[4] else None
if payload_path and payload_path.is_file():
    entries = json.loads(payload_path.read_text(encoding="utf-8"))
else:
    workflows_dir = fixture_dir / ".github" / "workflows"
    entries = []
    for path in sorted(workflows_dir.iterdir()):
        if path.is_file():
            entries.append({"path": path.relative_to(fixture_dir).as_posix(), "type": "blob"})
print(json.dumps({"sha": tree_sha, "truncated": truncated, "tree": entries}))
PY
        ;;
      "repos/$repo/contents/"*"?ref="*)
        fetch_count_file="$state_dir/content-fetch-count"
        fetch_count=0
        [[ -f "$fetch_count_file" ]] && fetch_count="$(<"$fetch_count_file")"
        fetch_count=$((fetch_count + 1))
        printf '%s' "$fetch_count" >"$fetch_count_file"
        python3 - "$endpoint" "$repo" "$head_sha" "$fixture_dir" <<'PY'
import base64
import hashlib
import json
import sys
import urllib.parse
from pathlib import Path

endpoint = sys.argv[1]
repo = sys.argv[2]
head_sha = sys.argv[3]
fixture_dir = Path(sys.argv[4])
prefix = f"repos/{repo}/contents/"

if not endpoint.startswith(prefix) or "?ref=" not in endpoint:
    raise SystemExit(f"unexpected contents lookup={endpoint}")

path, ref = endpoint[len(prefix) :].split("?ref=", 1)
if ref != head_sha:
    raise SystemExit(f"unexpected contents ref={ref}")
path = urllib.parse.unquote(path)

workflow_path = fixture_dir / Path(path)
content = workflow_path.read_bytes()
print(
    json.dumps(
        {
            "path": path,
            "sha": hashlib.sha1(content).hexdigest(),
            "type": "file",
            "encoding": "base64",
            "content": base64.b64encode(content).decode("ascii"),
        }
    )
)
PY
        ;;
      *)
        echo "unexpected gh api endpoint=$endpoint" >&2
        exit 1
        ;;
    esac
    ;;
  *)
    echo "unsupported gh command=$command_name" >&2
    exit 1
    ;;
esac
SH
  chmod +x "$pr_stub_dir/gh"
}

reset_pr_stub_state() {
  rm -rf -- "$pr_state_dir"
  mkdir -p "$pr_state_dir"
  rm -f -- "$pr_tree_payload_file"
  pr_head_sha_after=""
  pr_commit_lookup_fail="0"
  pr_commit_tree_sha=""
  pr_tree_truncated="0"
}

prepare_pr_remote() {
  reset_pr_stub_state
  rm -rf -- "$pr_remote_root"
  mkdir -p "$pr_remote_root/.github/workflows"
  reset_fixtures
  write_complete_oci_set
  while IFS= read -r -d '' file; do
    cp "$file" "$pr_remote_root/.github/workflows/"
  done < <(
    find "$tmp_dir" -maxdepth 1 -type f \( -name '*.yml' -o -name '*.yaml' \) -print0
  )
}

run_inventory_pr() {
  env \
    PATH="$pr_stub_dir:$PATH" \
    REPO="$pr_repo" \
    PR="$pr_number" \
    EXPECTED_HEAD_SHA="$pr_head_sha" \
    GH_STUB_REPO="$pr_repo" \
    GH_STUB_FIXTURE_DIR="$pr_remote_root" \
    GH_STUB_STATE_DIR="$pr_state_dir" \
    GH_STUB_PR_HEAD_SHA="$pr_head_sha" \
    GH_STUB_PR_HEAD_SHA_AFTER="$pr_head_sha_after" \
    GH_STUB_TREE_SHA="$pr_tree_sha" \
    GH_STUB_TREE_PAYLOAD_FILE="$pr_tree_payload_file" \
    GH_STUB_COMMIT_LOOKUP_FAIL="$pr_commit_lookup_fail" \
    GH_STUB_COMMIT_TREE_SHA="$pr_commit_tree_sha" \
    GH_STUB_TREE_TRUNCATED="$pr_tree_truncated" \
    "$INVENTORY"
}

assert_pr_pass() {
  local expected="$1"
  local actual
  actual="$(
    run_inventory_pr |
      sed -n 's/^production_workflows=//p'
  )"
  [[ "$actual" == "$expected" ]] || {
    echo "expected=$expected actual=$actual" >&2
    exit 1
  }
}

assert_pr_fail() {
  local label="$1"
  local expected_message="$2"
  local output
  if output="$(run_inventory_pr 2>&1)"; then
    echo "$label unexpectedly passed: $output" >&2
    exit 1
  fi
  grep -Fq "$expected_message" <<<"$output" || {
    echo "$label failed without expected message: $output" >&2
    exit 1
  }
}

pr_content_fetch_count() {
  local count_file="$pr_state_dir/content-fetch-count"
  if [[ -f "$count_file" ]]; then
    cat "$count_file"
  else
    echo 0
  fi
}

assert_pr_no_fetches() {
  local label="$1"
  local actual
  actual="$(pr_content_fetch_count)"
  [[ "$actual" == "0" ]] || {
    echo "$label unexpectedly fetched workflow contents count=$actual" >&2
    exit 1
  }
}

assert_pr_fail_no_fetch() {
  local label="$1"
  local expected_message="$2"
  assert_pr_fail "$label" "$expected_message"
  assert_pr_no_fetches "$label"
}

write_pr_tree_payload() {
  local extras_literal="$1"
  python3 - "$pr_remote_root" "$pr_tree_payload_file" "$extras_literal" <<'PY'
import json
import sys
from pathlib import Path

remote_root = Path(sys.argv[1])
payload_path = Path(sys.argv[2])
extras_literal = sys.argv[3]
extras = json.loads(extras_literal)
if isinstance(extras, dict):
    extras = [extras]
entries = []
for path in sorted((remote_root / ".github" / "workflows").iterdir()):
    if path.is_file():
        entries.append({"path": path.relative_to(remote_root).as_posix(), "type": "blob"})
entries.extend(extras)
payload_path.write_text(json.dumps(entries), encoding="utf-8")
PY
}

write_local_extra_paths() {
  local extras_literal="$1"
  python3 - "$local_extra_paths_file" "$extras_literal" <<'PY'
import json
import sys
from pathlib import Path

payload_path = Path(sys.argv[1])
extras = json.loads(sys.argv[2])
if isinstance(extras, str):
    extras = [extras]
payload_path.write_bytes(b"".join(item.encode("utf-8") + b"\0" for item in extras))
PY
}

copy_named_workflow_fixture() {
  local destination_root="$1"
  local source_path="$2"
  local relative_path="$3"
  python3 - "$destination_root" "$source_path" "$relative_path" <<'PY'
import sys
from pathlib import Path

destination_root = Path(sys.argv[1])
source_path = Path(sys.argv[2])
target_path = destination_root / Path(sys.argv[3])
target_path.parent.mkdir(parents=True, exist_ok=True)
target_path.write_bytes(source_path.read_bytes())
PY
}

rename_named_workflow_fixture() {
  local destination_root="$1"
  local current_name="$2"
  local relative_path="$3"
  python3 - "$destination_root" "$current_name" "$relative_path" <<'PY'
import sys
from pathlib import Path

destination_root = Path(sys.argv[1])
current_path = destination_root / sys.argv[2]
target_path = destination_root / Path(sys.argv[3])
target_path.parent.mkdir(parents=True, exist_ok=True)
current_path.rename(target_path)
PY
}

azure_set="production-build,production-deploy,production-rollback"
full_set="ghcr-package-management,oci-capacity-acquire,oci-ghcr-cache-recovery,oci-infrastructure,oci-live-betting-activate,oci-live-betting-disable,oci-live-data-rollout,oci-migrate,oci-migration-recovery,oci-production-build,oci-production-deploy,oci-production-rollback,production-build,production-deploy,production-rollback"
install_pr_gh_stub

reset_fixtures
assert_fail "Azure-only set" "expected $full_set; found $azure_set"

reset_fixtures
write_complete_oci_set
assert_pass "$full_set"

reset_fixtures
write_complete_oci_set
sed -i.bak \
  '/^      failed_deploy_run_id:/,/^        type: string$/d' \
  "$tmp_dir/oci-live-data-rollout.yml"
rm "$tmp_dir/oci-live-data-rollout.yml.bak"
assert_fail "live data rollout without failed-deploy selector" \
  "oci-live-data-rollout must expose exactly these workflow_dispatch inputs"

reset_fixtures
write_complete_oci_set
sed -i.bak \
  '/^      resume_recovery_run_id:/,/^        type: string$/d' \
  "$tmp_dir/oci-ghcr-cache-recovery.yml"
rm "$tmp_dir/oci-ghcr-cache-recovery.yml.bak"
assert_fail "cache recovery without resume selector" \
  "oci-ghcr-cache-recovery must expose exactly these workflow_dispatch inputs"

reset_fixtures
write_complete_oci_set
sed -i.bak \
  's/Upload immutable pre-rebind plan before rollout/Upload transition plan after rollout/' \
  "$tmp_dir/oci-ghcr-cache-recovery.yml"
rm "$tmp_dir/oci-ghcr-cache-recovery.yml.bak"
assert_fail "cache recovery without pre-mutation plan upload" \
  "oci-ghcr-cache-recovery is missing pre-mutation plan persistence"

reset_fixtures
write_complete_oci_set
cat > "$tmp_dir/safe space.yml" <<'YAML'
name: safe space
on:
  pull_request:
jobs:
  noop:
    runs-on: ubuntu-latest
    steps:
      - run: echo safe-space
YAML
cat > "$tmp_dir/safe+plus.yml" <<'YAML'
name: safe-plus
on:
  pull_request:
jobs:
  noop:
    runs-on: ubuntu-latest
    steps:
      - run: echo safe-plus
YAML
cat > "$tmp_dir/safe,comma.yaml" <<'YAML'
name: safe-comma
on:
  pull_request:
jobs:
  noop:
    runs-on: ubuntu-latest
    steps:
      - run: echo safe-comma
YAML
assert_pass "$full_set"

reset_fixtures
write_complete_oci_set
copy_named_workflow_fixture "$tmp_dir" "$ROOT_DIR/.github/workflows/production-build.yml" 'Twin.yml'
write_local_extra_paths '[".github/workflows/twin.yml"]'
assert_fail "local workflow case-only collision" "local workflow directory contained a normalization collision"

reset_fixtures
write_complete_oci_set
python3 - "$tmp_dir" "$ROOT_DIR/.github/workflows/production-build.yml" <<'PY'
from pathlib import Path
import sys

destination = Path(sys.argv[1]) / "caf\u00e9.yml"
destination.write_bytes(Path(sys.argv[2]).read_bytes())
PY
write_local_extra_paths '[".github/workflows/cafe\u0301.yml"]'
assert_fail "local workflow Unicode normalization collision" "local workflow directory contained a normalization collision"

reset_fixtures
write_complete_oci_set
copy_named_workflow_fixture "$tmp_dir" "$ROOT_DIR/.github/workflows/production-build.yml" $'rogue\nworkflow.yml'
assert_fail "local workflow newline injection" "local workflow directory contained an unsafe path"

reset_fixtures
write_complete_oci_set
copy_named_workflow_fixture "$tmp_dir" "$ROOT_DIR/.github/workflows/production-build.yml" $'rogue\rworkflow.yml'
assert_fail "local workflow carriage return injection" "local workflow directory contained an unsafe path"

reset_fixtures
write_complete_oci_set
copy_named_workflow_fixture "$tmp_dir" "$ROOT_DIR/.github/workflows/production-build.yml" $'rogue\tworkflow.yml'
assert_fail "local workflow tab injection" "local workflow directory contained an unsafe path"

reset_fixtures
write_complete_oci_set
copy_named_workflow_fixture "$tmp_dir" "$ROOT_DIR/.github/workflows/production-build.yml" $'rogue\x7fworkflow.yml'
assert_fail "local workflow DEL injection" "local workflow directory contained an unsafe path"

reset_fixtures
write_complete_oci_set
copy_named_workflow_fixture "$tmp_dir" "$ROOT_DIR/.github/workflows/production-build.yml" $'rogue\u2028workflow.yml'
assert_fail "local workflow Unicode line separator injection" "local workflow directory contained an unsafe path"

reset_fixtures
write_complete_oci_set
copy_named_workflow_fixture "$tmp_dir" "$ROOT_DIR/.github/workflows/production-build.yml" $'rogue\u2029workflow.yml'
assert_fail "local workflow Unicode paragraph separator injection" "local workflow directory contained an unsafe path"

reset_fixtures
write_complete_oci_set
copy_named_workflow_fixture "$tmp_dir" "$ROOT_DIR/.github/workflows/production-build.yml" 'rogue\workflow.yml'
assert_fail "local workflow backslash path" "local workflow directory contained an unsafe path"

reset_fixtures
write_complete_oci_set
copy_named_workflow_fixture "$tmp_dir" "$ROOT_DIR/.github/workflows/production-build.yml" 'rogue%2Fworkflow.yml'
assert_fail "local workflow percent-encoded separator" "local workflow directory contained an unsafe path"

reset_fixtures
write_complete_oci_set
copy_named_workflow_fixture "$tmp_dir" "$ROOT_DIR/.github/workflows/production-build.yml" 'rogue%0Aworkflow.yml'
assert_fail "local workflow percent-encoded control" "local workflow directory contained an unsafe path"

reset_fixtures
write_complete_oci_set
copy_named_workflow_fixture "$tmp_dir" "$ROOT_DIR/.github/workflows/production-build.yml" '%70roduction-build.yml'
assert_fail "local workflow percent-encoded colliding filename" "local workflow directory contained an unsafe path"

reset_fixtures
write_complete_oci_set
copy_named_workflow_fixture "$tmp_dir" "$ROOT_DIR/.github/workflows/production-build.yml" 'nested/rogue.yml'
assert_fail "local workflow nested path" "local workflow directory contained an unsafe path"

reset_fixtures
write_complete_oci_set
rm "$tmp_dir/oci-migrate.yml"
assert_fail "partial OCI set" "expected $full_set; found"

reset_fixtures
write_complete_oci_set
rm "$tmp_dir/oci-migration-recovery.yml"
assert_fail "partial OCI set without migration recovery" "expected $full_set; found"

reset_fixtures
write_complete_oci_set
rm "$tmp_dir/oci-capacity-acquire.yml"
assert_fail "partial OCI set without capacity acquisition" "expected $full_set; found"

reset_fixtures
write_complete_oci_set
sed -i.bak 's/name: oci-infrastructure/name: oci-platform/' "$tmp_dir/oci-infrastructure.yml"
rm "$tmp_dir/oci-infrastructure.yml.bak"
assert_fail "renamed OCI identity" "oci-platform"

reset_fixtures
cat > "$tmp_dir/rogue-production.yml" <<'YAML'
name: rogue-production
on:
  push:
    branches: [master]
jobs:
  mutate:
    runs-on: ubuntu-latest
    environment: production-emergency
    steps:
      - run: echo unsafe
YAML
assert_fail "unexpected production workflow" "rogue-production"

reset_fixtures
write_complete_oci_set
python3 - "$tmp_dir/production-rollback.yml" <<'PY'
from pathlib import Path
path = Path(__import__("sys").argv[1])
text = path.read_text()
path.write_text(text.replace("on:\n  workflow_dispatch:", "on:\n  push:\n    branches: [master]\n  workflow_dispatch:", 1))
PY
assert_fail "automatic production rollback" "production-rollback must be workflow_dispatch-only"

reset_fixtures
write_complete_oci_set
sed -i.bak 's/actions: read/actions: write/' "$tmp_dir/production-rollback.yml"
rm "$tmp_dir/production-rollback.yml.bak"
assert_fail "production rollback with write permissions" \
  "production-rollback must set exact permissions actions=read,contents=read"

reset_fixtures
write_complete_oci_set
sed -i.bak \
  's#actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683#actions/checkout@v4#' \
  "$tmp_dir/production-rollback.yml"
rm "$tmp_dir/production-rollback.yml.bak"
assert_fail "floating production rollback action ref" \
  "must pin actions/checkout to a full 40-character lowercase hex commit SHA"

reset_fixtures
write_complete_oci_set
sed -i.bak '/\[ "\$GITHUB_REF_NAME" = "master" \]/d' "$tmp_dir/production-rollback.yml"
rm "$tmp_dir/production-rollback.yml.bak"
assert_fail "production rollback without master guard" \
  "production-rollback must reject non-master dispatches"

reset_fixtures
write_complete_oci_set
sed -i.bak '/BASELINE_ARTIFACT_NAME/d' "$tmp_dir/production-rollback.yml"
rm "$tmp_dir/production-rollback.yml.bak"
assert_fail "production rollback without artifact provenance binding" \
  "production-rollback must bind rollback provenance to the exact baseline artifact"

reset_fixtures
write_complete_oci_set
python3 - "$tmp_dir/oci-production-rollback.yml" <<'PY'
from pathlib import Path
path = Path(__import__("sys").argv[1])
text = path.read_text()
path.write_text(text.replace("on:\n  workflow_dispatch:", "on:\n  workflow_run:\n    workflows: [oci-production-build]\n    types: [completed]\n  workflow_dispatch:", 1))
PY
assert_fail "automatic OCI rollback" "oci-production-rollback must be workflow_dispatch-only"

reset_fixtures
write_complete_oci_set
sed -i.bak \
  's#actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093#actions/download-artifact@v4#' \
  "$tmp_dir/oci-production-rollback.yml"
rm "$tmp_dir/oci-production-rollback.yml.bak"
assert_fail "floating OCI rollback action ref" \
  "must pin actions/download-artifact to a full 40-character lowercase hex commit SHA"

reset_fixtures
write_complete_oci_set
sed -i.bak 's/contents: read/contents: write/' "$tmp_dir/oci-production-rollback.yml"
rm "$tmp_dir/oci-production-rollback.yml.bak"
assert_fail "OCI rollback with write permissions" \
  "oci-production-rollback must set exact permissions actions=read,contents=read"

reset_fixtures
write_complete_oci_set
sed -i.bak '/\[ "\$GITHUB_REF_NAME" = "master" \]/d' "$tmp_dir/oci-production-rollback.yml"
rm "$tmp_dir/oci-production-rollback.yml.bak"
assert_fail "OCI rollback without master guard" \
  "oci-production-rollback must reject non-master dispatches"

reset_fixtures
write_complete_oci_set
sed -i.bak 's#actions/runs/\$INFRASTRUCTURE_RUN_ID/attempts/1#actions/runs/\$INFRASTRUCTURE_RUN_ID#' \
  "$tmp_dir/oci-production-rollback.yml"
rm "$tmp_dir/oci-production-rollback.yml.bak"
assert_fail "OCI rollback without immutable infrastructure provenance" \
  "oci-production-rollback must inspect the immutable first-attempt infrastructure provenance"

reset_fixtures
write_complete_oci_set
sed -i.bak \
  's/partial_rollback_run_id:/disabled_partial_rollback_run_id:/' \
  "$tmp_dir/oci-production-rollback.yml"
rm "$tmp_dir/oci-production-rollback.yml.bak"
assert_fail "OCI rollback without partial recovery input" \
  "oci-production-rollback must expose exactly these workflow_dispatch inputs"

reset_fixtures
write_complete_oci_set
sed -i.bak \
  's/pre_recovery_build_run_id:/disabled_pre_recovery_build_run_id:/' \
  "$tmp_dir/oci-production-rollback.yml"
rm "$tmp_dir/oci-production-rollback.yml.bak"
assert_fail "OCI rollback without pre-recovery build input" \
  "oci-production-rollback must expose exactly these workflow_dispatch inputs"

reset_fixtures
write_complete_oci_set
sed -i.bak \
  's#recover-partial-rollback-stan.sh#disabled-partial-rollback-operator.sh#' \
  "$tmp_dir/oci-production-rollback.yml"
rm "$tmp_dir/oci-production-rollback.yml.bak"
assert_fail "OCI rollback without partial recovery operator" \
  "oci-production-rollback must call the reviewed partial rollback recovery operator"

reset_fixtures
write_complete_oci_set
python3 - "$tmp_dir/oci-production-deploy.yml" <<'PY'
from pathlib import Path
path = Path(__import__("sys").argv[1])
text = path.read_text()
path.write_text(text.replace("on:\n  workflow_dispatch:", "on:\n  push:\n    branches: [master]\n  workflow_dispatch:"))
PY
assert_fail "automatic OCI deployment" "oci-production-deploy must be workflow_dispatch-only"

reset_fixtures
write_complete_oci_set
sed -i.bak 's/:${{ inputs.approved_sha }}/:latest/' "$tmp_dir/oci-production-deploy.yml"
rm "$tmp_dir/oci-production-deploy.yml.bak"
assert_fail "mutable OCI image" "must not use a mutable latest image tag"

reset_fixtures
write_complete_oci_set
sed -i.bak '/GITHUB_REF_NAME/d' "$tmp_dir/oci-infrastructure.yml"
rm "$tmp_dir/oci-infrastructure.yml.bak"
assert_fail "non-master OCI dispatch" "must reject non-master dispatches"

reset_fixtures
write_complete_oci_set
sed -i.bak '/environment:/,+1d' "$tmp_dir/oci-migrate.yml"
rm "$tmp_dir/oci-migrate.yml.bak"
assert_fail "missing protected environment" "must use reviewer-gated oci-migration"

reset_fixtures
write_complete_oci_set
sed -i.bak '/environment:/,+1d' "$tmp_dir/oci-migration-recovery.yml"
rm "$tmp_dir/oci-migration-recovery.yml.bak"
assert_fail "missing recovery protected environment" \
  "must use reviewer-gated azure-migration-recovery"

reset_fixtures
write_complete_oci_set
sed -i.bak \
  's/AZURE_MIGRATION_RECOVERY_CREDENTIALS/OCI_MIGRATION_AZURE_CREDENTIALS/' \
  "$tmp_dir/oci-migration-recovery.yml"
rm "$tmp_dir/oci-migration-recovery.yml.bak"
assert_fail "recovery with broad migration credential" \
  "must use the dedicated Azure stop-only credential"

reset_fixtures
write_complete_oci_set
sed -i.bak '/az aks stop/i\
          az aks start --name betstan-aks' "$tmp_dir/oci-migration-recovery.yml"
rm "$tmp_dir/oci-migration-recovery.yml.bak"
assert_fail "recovery with Azure start permission" \
  "must never start, create, resize, or delete Azure compute"

reset_fixtures
write_complete_oci_set
sed -i.bak \
  "s/vars.OCI_MIGRATION_RECOVERY_ENABLED == 'true'/true/" \
  "$tmp_dir/oci-migration-recovery.yml"
rm "$tmp_dir/oci-migration-recovery.yml.bak"
assert_fail "recovery schedule without activation guard" \
  "schedule must retain the explicit false-by-default activation guard"

reset_fixtures
write_complete_oci_set
sed -i.bak 's/86400/172800/' "$tmp_dir/oci-migration-recovery.yml"
rm "$tmp_dir/oci-migration-recovery.yml.bak"
assert_fail "recovery schedule with unbounded arm deadline" \
  "schedule arm deadline must be bounded to one day"

reset_fixtures
write_complete_oci_set
sed -i.bak 's/github.event.workflow_run.head_sha/github.sha/g' "$tmp_dir/oci-production-build.yml"
rm "$tmp_dir/oci-production-build.yml.bak"
assert_fail "downstream workflow SHA" "must use the upstream workflow_run head SHA"

reset_fixtures
write_complete_oci_set
sed -i.bak '/github.run_attempt == 1/d' "$tmp_dir/oci-infrastructure.yml"
rm "$tmp_dir/oci-infrastructure.yml.bak"
assert_fail "missing run-attempt guard" "must reject rerun attempts"

reset_fixtures
write_complete_oci_set
sed -i.bak '/github.run_attempt == 1/d' "$tmp_dir/oci-capacity-acquire.yml"
rm "$tmp_dir/oci-capacity-acquire.yml.bak"
assert_fail "missing capacity run-attempt guard" "must reject rerun attempts"

reset_fixtures
write_complete_oci_set
python3 - "$tmp_dir/oci-capacity-acquire.yml" <<'PY'
from pathlib import Path
path = Path(__import__("sys").argv[1])
text = path.read_text()
start = text.index("  workflow_dispatch:\n")
end = text.index("jobs:\n", start)
path.write_text(text[:start] + text[end:])
PY
assert_fail "schedule-only capacity workflow" "must have schedule and workflow_dispatch only"

reset_fixtures
write_complete_oci_set
sed -i.bak '/required: true/d' "$tmp_dir/oci-capacity-acquire.yml"
rm "$tmp_dir/oci-capacity-acquire.yml.bak"
assert_fail "optional manual capacity SHA" "must require the approved_sha dispatch input"

reset_fixtures
write_complete_oci_set
sed -i.bak "s/vars.OCI_CAPACITY_CATCHER_ENABLED == 'true'/true/" \
  "$tmp_dir/oci-capacity-acquire.yml"
rm "$tmp_dir/oci-capacity-acquire.yml.bak"
assert_fail "capacity workflow without kill switch" "schedule must retain the explicit activation kill switch"

reset_fixtures
write_complete_oci_set
sed -i.bak "s/ || github.event_name == 'workflow_dispatch'//" \
  "$tmp_dir/oci-capacity-acquire.yml"
rm "$tmp_dir/oci-capacity-acquire.yml.bak"
assert_fail "capacity workflow without manual bypass" \
  "must permit an audited manual attempt independently of scheduling"

reset_fixtures
write_complete_oci_set
sed -i.bak 's#\*/5 \* \* \* \*#*/10 * * * *#' "$tmp_dir/oci-capacity-acquire.yml"
rm "$tmp_dir/oci-capacity-acquire.yml.bak"
assert_fail "capacity workflow with unreviewed cadence" "must use the reviewed five-minute schedule"

reset_fixtures
write_complete_oci_set
sed -i.bak '/GITHUB_REF_NAME/d' "$tmp_dir/oci-capacity-acquire.yml"
rm "$tmp_dir/oci-capacity-acquire.yml.bak"
assert_fail "non-master capacity workflow" "must reject non-master executions"

reset_fixtures
write_complete_oci_set
sed -i.bak '/ref:.*inputs.approved_sha/d' "$tmp_dir/oci-infrastructure.yml"
rm "$tmp_dir/oci-infrastructure.yml.bak"
assert_fail "missing exact-SHA checkout" "must check out inputs.approved_sha"

reset_fixtures
write_complete_oci_set
sed -i.bak '/terraform apply/i\
          echo "${{ secrets.AZURE_CREDENTIALS }}"' "$tmp_dir/oci-infrastructure.yml"
rm "$tmp_dir/oci-infrastructure.yml.bak"
assert_fail "Azure credentials outside migration" "must not receive Azure credentials"

reset_fixtures
write_complete_oci_set
sed -i.bak '/terraform apply/i\
          echo "${{ secrets[\"AZURE_CREDENTIALS\"] }}"' "$tmp_dir/oci-infrastructure.yml"
rm "$tmp_dir/oci-infrastructure.yml.bak"
assert_fail "bracketed Azure credentials outside migration" "must not receive Azure credentials"

reset_fixtures
write_complete_oci_set
sed -i.bak '/terraform apply/i\
          echo "${{ secrets[env.RUNTIME_SECRET_NAME] }}"' "$tmp_dir/oci-infrastructure.yml"
rm "$tmp_dir/oci-infrastructure.yml.bak"
assert_fail "dynamic secret lookup outside migration" "must not use dynamic secret contexts"

reset_fixtures
write_complete_oci_set
sed -i.bak '/terraform apply/i\
          echo "${{ secrets[\"OCI_CLI_USER\"] }}"' "$tmp_dir/oci-infrastructure.yml"
rm "$tmp_dir/oci-infrastructure.yml.bak"
assert_pass "$full_set"

reset_fixtures
write_complete_oci_set
sed -i.bak "/steps.accepted.outcome != 'success'/d" \
  "$tmp_dir/oci-live-betting-activate.yml"
rm "$tmp_dir/oci-live-betting-activate.yml.bak"
assert_fail \
  "activation without automatic disable" \
  "is missing failure-triggered disable gate"

reset_fixtures
write_complete_oci_set
python3 - "$tmp_dir/oci-live-betting-activate.yml" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()
needle = "run: ./infra/oci/scripts/revalidate-live-activation-stan.sh"
path.write_text(text.replace(needle, "run: echo skipped-revalidation", 1))
PY
assert_fail \
  "activation with only two release revalidations" \
  "must revalidate before mutation, acceptance, and permanent activation"

reset_fixtures
write_complete_oci_set
sed -i.bak '/MODE=rollback-drain/d' \
  "$tmp_dir/oci-live-betting-disable.yml"
rm "$tmp_dir/oci-live-betting-disable.yml.bak"
assert_fail \
  "disable without drain gate" \
  "is missing live-aware drain gate"

reset_fixtures
write_complete_oci_set
sed -i.bak "/steps.disable.outcome != 'success'/d" \
  "$tmp_dir/oci-live-betting-disable.yml"
rm "$tmp_dir/oci-live-betting-disable.yml.bak"
assert_fail \
  "disable without final dark reassertion" \
  "is missing workflow-level dark reassertion"

reset_fixtures
write_complete_oci_set
sed -i.bak \
  's#actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020#actions/setup-node@v4#' \
  "$tmp_dir/oci-live-betting-activate.yml"
rm "$tmp_dir/oci-live-betting-activate.yml.bak"
assert_fail \
  "activation with mutable action" \
  "must pin actions/setup-node to a full 40-character lowercase hex commit SHA"

reset_fixtures
write_complete_oci_set
sed -i.bak '/infrastructure_provenance_sha256=%s/d' \
  "$tmp_dir/oci-production-deploy.yml"
rm "$tmp_dir/oci-production-deploy.yml.bak"
assert_fail \
  "deployment without infrastructure artifact binding" \
  "is missing infrastructure artifact digest binding"

reset_fixtures
write_complete_oci_set
sed -i.bak '/\.github\/workflows\/oci-production-rollback\.yml/d' \
  "$tmp_dir/oci-production-deploy.yml"
rm "$tmp_dir/oci-production-deploy.yml.bak"
assert_fail \
  "deployment without partial recovery workflow binding" \
  "is missing partial-recovery workflow binding"

reset_fixtures
write_complete_oci_set
sed -i.bak '/oci-production-rollback-${BASELINE_RECOVERY_RUN_ID}-1/d' \
  "$tmp_dir/oci-production-deploy.yml"
rm "$tmp_dir/oci-production-deploy.yml.bak"
assert_fail \
  "deployment without partial recovery artifact binding" \
  "is missing partial-recovery artifact binding"

reset_fixtures
write_complete_oci_set
sed -i.bak '/validate-rollback-baseline-stan.sh/d' \
  "$tmp_dir/oci-production-deploy.yml"
rm "$tmp_dir/oci-production-deploy.yml.bak"
assert_fail \
  "deployment without executable rollback baseline validation" \
  "is missing executable pre-deploy rollback validation"

reset_fixtures
write_complete_oci_set
sed -i.bak '/runtime_fingerprint/d' \
  "$tmp_dir/oci-live-betting-disable.yml"
rm "$tmp_dir/oci-live-betting-disable.yml.bak"
assert_fail \
  "disable without runtime identity binding" \
  "is missing deployment-to-infrastructure runtime binding"

reset_fixtures
write_complete_oci_set
cat >"$tmp_dir/_azure-bridge.yml" <<'YAML'
name: azure-bridge
on:
  workflow_call:
jobs:
  leak:
    runs-on: ubuntu-latest
    steps:
      - run: echo "${{ secrets.AZURE_CREDENTIALS }}"
YAML
python3 - "$tmp_dir/oci-production-build.yml" <<'PY'
from pathlib import Path
path = Path(__import__("sys").argv[1])
text = path.read_text()
path.write_text(text.replace(
    "jobs:\n",
    "jobs:\n  bridge:\n    uses: ./.github/workflows/_azure-bridge.yml\n    secrets: inherit\n",
    1,
))
PY
assert_fail "reusable workflow from governed OCI job" "must not call a reusable workflow"

reset_fixtures
write_complete_oci_set
sed -i.bak 's/issues: write/issues: read/' \
  "$tmp_dir/oci-production-monitor.yml"
rm "$tmp_dir/oci-production-monitor.yml.bak"
assert_fail \
  "observer without incident write boundary" \
  "must set exact permissions"

reset_fixtures
write_complete_oci_set
sed -i.bak 's#7,22,37,52 \* \* \* \*#*/5 * * * *#' \
  "$tmp_dir/oci-production-monitor.yml"
rm "$tmp_dir/oci-production-monitor.yml.bak"
assert_fail \
  "observer with unreviewed cadence" \
  "must use the reviewed fifteen-minute schedule"

reset_fixtures
write_complete_oci_set
sed -i.bak '/command -v python3/a\
          kubectl get pods' "$tmp_dir/oci-production-monitor.yml"
rm "$tmp_dir/oci-production-monitor.yml.bak"
assert_fail \
  "observer with cluster access" \
  "contains forbidden production access or repair capability"

prepare_pr_remote
assert_pr_pass "$full_set"

prepare_pr_remote
cat > "$pr_remote_root/.github/workflows/safe space.yml" <<'YAML'
name: safe space
on:
  pull_request:
jobs:
  noop:
    runs-on: ubuntu-latest
    steps:
      - run: echo safe-space
YAML
cat > "$pr_remote_root/.github/workflows/safe+plus.yml" <<'YAML'
name: safe-plus
on:
  pull_request:
jobs:
  noop:
    runs-on: ubuntu-latest
    steps:
      - run: echo safe-plus
YAML
cat > "$pr_remote_root/.github/workflows/safe,comma.yaml" <<'YAML'
name: safe-comma
on:
  pull_request:
jobs:
  noop:
    runs-on: ubuntu-latest
    steps:
      - run: echo safe-comma
YAML
assert_pr_pass "$full_set"

prepare_pr_remote
copy_named_workflow_fixture "$pr_remote_root/.github/workflows" \
  "$ROOT_DIR/.github/workflows/production-build.yml" 'Twin.yml'
write_pr_tree_payload '[{"path": ".github/workflows/twin.yml", "type": "blob"}]'
assert_pr_fail_no_fetch "PR workflow case-only collision" \
  "PR workflow tree response contained a normalization collision"

prepare_pr_remote
python3 - "$pr_remote_root/.github/workflows" "$ROOT_DIR/.github/workflows/production-build.yml" <<'PY'
from pathlib import Path
import sys

destination = Path(sys.argv[1]) / "caf\u00e9.yml"
destination.write_bytes(Path(sys.argv[2]).read_bytes())
PY
write_pr_tree_payload '[{"path": ".github/workflows/cafe\u0301.yml", "type": "blob"}]'
assert_pr_fail_no_fetch "PR workflow Unicode normalization collision" \
  "PR workflow tree response contained a normalization collision"

prepare_pr_remote
pr_head_sha_after="$pr_alt_head_sha"
assert_pr_fail "PR head changed during inventory" "PR head changed during workflow inventory"

prepare_pr_remote
pr_commit_lookup_fail="1"
assert_pr_fail "PR commit lookup failure" "unable to resolve PR head commit $pr_head_sha"

prepare_pr_remote
pr_commit_tree_sha="not-a-tree-sha"
assert_pr_fail "PR malformed tree SHA" \
  "PR head commit response did not include a complete lowercase tree SHA"

prepare_pr_remote
pr_tree_truncated="1"
assert_pr_fail "PR truncated workflow tree" "PR workflow tree response was truncated"

prepare_pr_remote
cat > "$pr_remote_root/.github/workflows/rogue-production.yml" <<'YAML'
name: rogue-production
on:
  push:
    branches: [master]
jobs:
  mutate:
    runs-on: ubuntu-latest
    environment: production-emergency
    steps:
      - run: echo unsafe
YAML
assert_pr_fail "PR unknown production workflow" "rogue-production"

prepare_pr_remote
python3 - "$pr_remote_root/.github/workflows/production-rollback.yml" <<'PY'
from pathlib import Path
path = Path(__import__("sys").argv[1])
text = path.read_text()
path.write_text(text.replace("on:\n  workflow_dispatch:", "on:\n  push:\n    branches: [master]\n  workflow_dispatch:", 1))
PY
assert_pr_fail "PR automatic production rollback" \
  "production-rollback must be workflow_dispatch-only"

prepare_pr_remote
sed -i.bak \
  's#actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093#actions/download-artifact@v4#' \
  "$pr_remote_root/.github/workflows/oci-production-rollback.yml"
rm "$pr_remote_root/.github/workflows/oci-production-rollback.yml.bak"
assert_pr_fail "PR floating OCI rollback action ref" \
  "must pin actions/download-artifact to a full 40-character lowercase hex commit SHA"

prepare_pr_remote
write_pr_tree_payload '[{"path": ".github/workflows/rogue.yml\\n.github/workflows/production-build.yml", "type": "blob"}]'
assert_pr_fail_no_fetch "PR workflow newline injection" \
  "PR workflow tree response contained an unsafe path"

prepare_pr_remote
write_pr_tree_payload '[{"path": ".github/workflows/rogue\\rproduction.yml", "type": "blob"}]'
assert_pr_fail_no_fetch "PR workflow carriage return injection" \
  "PR workflow tree response contained an unsafe path"

prepare_pr_remote
write_pr_tree_payload '[{"path": ".github/workflows/rogue\\tproduction.yml", "type": "blob"}]'
assert_pr_fail_no_fetch "PR workflow tab injection" \
  "PR workflow tree response contained an unsafe path"

prepare_pr_remote
write_pr_tree_payload '[{"path": ".github/workflows/rogue\u007fproduction.yml", "type": "blob"}]'
assert_pr_fail_no_fetch "PR workflow DEL injection" \
  "PR workflow tree response contained an unsafe path"

prepare_pr_remote
write_pr_tree_payload '[{"path": ".github/workflows/rogue\\u0000production.yml", "type": "blob"}]'
assert_pr_fail_no_fetch "PR workflow NUL injection" \
  "PR workflow tree response contained an unsafe path"

prepare_pr_remote
write_pr_tree_payload '[{"path": ".github/workflows/rogue\\u2028production.yml", "type": "blob"}]'
assert_pr_fail_no_fetch "PR workflow Unicode line separator injection" \
  "PR workflow tree response contained an unsafe path"

prepare_pr_remote
write_pr_tree_payload '[{"path": ".github/workflows/rogue\\u2029production.yml", "type": "blob"}]'
assert_pr_fail_no_fetch "PR workflow Unicode paragraph separator injection" \
  "PR workflow tree response contained an unsafe path"

prepare_pr_remote
write_pr_tree_payload '[{"path": ".github\\\\workflows\\\\rogue.yml", "type": "blob"}]'
assert_pr_fail_no_fetch "PR workflow backslash path" \
  "PR workflow tree response contained an unsafe path"

prepare_pr_remote
write_pr_tree_payload '[{"path": ".github/workflows/%2e%2e%2frogue.yml", "type": "blob"}]'
assert_pr_fail_no_fetch "PR workflow percent-encoded traversal" \
  "PR workflow tree response contained an unsafe path"

prepare_pr_remote
write_pr_tree_payload '[{"path": ".github%2Fworkflows%2Frogue.yml", "type": "blob"}]'
assert_pr_fail_no_fetch "PR workflow percent-encoded separator" \
  "PR workflow tree response contained an unsafe path"

prepare_pr_remote
write_pr_tree_payload '[{"path": ".github/workflows/rogue%0Aworkflow.yml", "type": "blob"}]'
assert_pr_fail_no_fetch "PR workflow percent-encoded control" \
  "PR workflow tree response contained an unsafe path"

prepare_pr_remote
write_pr_tree_payload '[{"path": ".github/workflows/%70roduction-build.yml", "type": "blob"}]'
assert_pr_fail_no_fetch "PR workflow percent-encoded colliding filename" \
  "PR workflow tree response contained an unsafe path"

prepare_pr_remote
write_pr_tree_payload '[{"path": ".github//workflows/rogue.yml", "type": "blob"}]'
assert_pr_fail_no_fetch "PR workflow empty component path" \
  "PR workflow tree response contained an unsafe path"

prepare_pr_remote
write_pr_tree_payload '[{"path": ".github/workflows/production-build.yml", "type": "blob"}]'
assert_pr_fail_no_fetch "PR duplicate workflow path" \
  "PR workflow tree response contained a duplicate path"

"$ROOT_DIR/infra/azure/agents/test-shared-mongo-consolidation-stan.sh"

echo "production_workflow_inventory_tests=PASS"
