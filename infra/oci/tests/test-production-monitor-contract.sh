#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MONITOR_DIR="$ROOT_DIR/infra/oci/monitor"
EXPORTER_DIR="$MONITOR_DIR/exporter"
NPM_CACHE="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/betstan-monitor-npm-cache"

(
  cd "$MONITOR_DIR"
  python3 -m unittest -v \
    test_contracts.py \
    test_active_release_evidence.py \
    test_deep_client.py \
    test_detector.py \
    test_github_observer.py \
    test_publisher.py \
    test_production_state.py \
    test_repair_controller.py \
    test_repair_deploy.py \
    test_repair_merge.py \
    test_repair_lifecycle.py \
    test_repair_promotion.py \
    test_repair_policy.py \
    test_self_heal_controller.py \
    test_self_heal_request.py
)

(
  cd "$EXPORTER_DIR"
  npm ci --ignore-scripts --no-audit --no-fund --cache "$NPM_CACHE"
  npm test
)

"$ROOT_DIR/infra/oci/tests/test-deploy-repair-images.sh"

python3 - "$ROOT_DIR/infra/oci/k8s/monitor.yaml" <<'PY'
import re
import sys
from pathlib import Path

content = Path(sys.argv[1]).read_text(encoding="utf-8")
documents = re.split(r"^---\s*$", content, flags=re.MULTILINE)
repair_roles = [
    document
    for document in documents
    if re.search(r"^kind:\s*Role\s*$", document, re.MULTILINE)
    and re.search(
        r"^metadata:\s*\n\s+name:\s*betstan-monitor-repair\s*$",
        document,
        re.MULTILINE,
    )
]
if len(repair_roles) != 1:
    raise SystemExit("monitor repair Role is missing or ambiguous")
role = repair_roles[0]
operation_rule = re.search(
    r"resources:\s*\[configmaps\]\s*\n"
    r"\s+resourceNames:\s*\n"
    r"\s+- betstan-production-operation-v1\s*\n"
    r"\s+verbs:\s*\[get, update\]",
    role,
)
release_rule = re.search(
    r"resources:\s*\[configmaps\]\s*\n"
    r"\s+resourceNames:\s*\n"
    r"\s+- betstan-active-release-v1\s*\n"
    r"\s+verbs:\s*\[get\]",
    role,
)
if operation_rule is None or release_rule is None:
    raise SystemExit("monitor repair ConfigMap permissions are not split safely")
if re.search(
    r"betstan-active-release-v1[\s\S]{0,80}verbs:\s*\[[^\]]*update",
    role,
):
    raise SystemExit("self-heal Role may update the active release")
for annotation in (
    'nginx.ingress.kubernetes.io/proxy-read-timeout: "180"',
    'nginx.ingress.kubernetes.io/proxy-send-timeout: "180"',
):
    if annotation not in content:
        raise SystemExit(f"monitor ingress is missing {annotation}")
PY

if command -v actionlint >/dev/null 2>&1; then
  actionlint \
    "$ROOT_DIR/.github/workflows/oci-production-monitor.yml" \
    "$ROOT_DIR/.github/workflows/oci-production-monitor-publish.yml" \
    "$ROOT_DIR/.github/workflows/oci-production-repair-controller.yml" \
    "$ROOT_DIR/.github/workflows/oci-production-monitor-repair-policy.yml" \
    "$ROOT_DIR/.github/workflows/oci-production-repair-promotion.yml" \
    "$ROOT_DIR/.github/workflows/oci-production-repair-deploy-controller.yml" \
    "$ROOT_DIR/.github/workflows/oci-production-repair-deploy.yml" \
    "$ROOT_DIR/.github/workflows/oci-production-repair-deploy-reconcile.yml" \
    "$ROOT_DIR/.github/workflows/oci-production-self-heal.yml"
fi

echo "oci_production_monitor_contract=PASS"
