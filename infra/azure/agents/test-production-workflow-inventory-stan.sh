#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
INVENTORY="$ROOT_DIR/infra/azure/agents/production-workflow-inventory-stan.sh"
tmp_dir="$(mktemp -d "$ROOT_DIR/.workflow-inventory-test.XXXXXX")"
cleanup() {
  rm -rf -- "$tmp_dir"
}
trap cleanup EXIT

reset_fixtures() {
  rm -f -- "$tmp_dir"/*.yml "$tmp_dir"/*.yaml
  cp "$ROOT_DIR/.github/workflows/production-build.yml" "$tmp_dir/"
  cp "$ROOT_DIR/.github/workflows/production-deploy.yml" "$tmp_dir/"

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
    workflows: ["production-build"]
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
}

assert_pass() {
  local expected="$1"
  local actual
  actual="$(
    WORKFLOW_DIR="$tmp_dir" "$INVENTORY" |
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
  if output="$(WORKFLOW_DIR="$tmp_dir" "$INVENTORY" 2>&1)"; then
    echo "$label unexpectedly passed: $output" >&2
    exit 1
  fi
  grep -Fq "$expected_message" <<<"$output" || {
    echo "$label failed without expected message: $output" >&2
    exit 1
  }
}

azure_set="production-build,production-deploy"
full_set="oci-capacity-acquire,oci-infrastructure,oci-migrate,oci-migration-recovery,oci-production-build,oci-production-deploy,production-build,production-deploy"

reset_fixtures
assert_fail "Azure-only set" "expected $full_set; found $azure_set"

reset_fixtures
write_complete_oci_set
assert_pass "$full_set"

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
assert_fail "renamed OCI identity" "found oci-capacity-acquire,oci-migrate,oci-migration-recovery,oci-platform"

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

"$ROOT_DIR/infra/azure/agents/test-shared-mongo-consolidation-stan.sh"

echo "production_workflow_inventory_tests=PASS"
