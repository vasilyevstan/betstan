#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
HELPER="$ROOT_DIR/infra/oci/scripts/k3s_disk_recovery_stan.py"
ORCHESTRATOR="$ROOT_DIR/infra/oci/scripts/k3s-node-disk-recovery-stan.sh"
REMOTE="$ROOT_DIR/infra/oci/scripts/k3s-node-disk-remote-stan.sh"
WORK_PARENT="$ROOT_DIR/infra/oci/tests/.k3s-disk-recovery-workdirs"
mkdir -p "$WORK_PARENT"
work_dir="$(mktemp -d "$WORK_PARENT/test.XXXXXX")"
cleanup() {
  while read -r pid; do
    [[ -n "$pid" ]] || continue
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done < <(jobs -p)
  rm -rf "$work_dir"
  rmdir "$WORK_PARENT" 2>/dev/null || true
}
trap cleanup EXIT

fail() {
  echo "k3s disk recovery contract test failed: $*" >&2
  exit 1
}

sha() {
  printf 'sha256:%064d' "$1"
}

SOURCE_SHA=1111111111111111111111111111111111111111
RECLAIM_SOURCE_SHA=3333333333333333333333333333333333333333
ROLLBACK_SOURCE_SHA=7777777777777777777777777777777777777777
CURRENT_ID="$(sha 1)"
CANDIDATE_ID="$(sha 2)"
RECLAIM_ID="$(sha 3)"
FOREIGN_ID="$(sha 4)"
UNTAGGED_ID="$(sha 5)"
PINNED_ID="$(sha 6)"
ROLLBACK_ID="$(sha 7)"
STOPPED_ID="$(sha 8)"
TELEMETRY_ID="$(sha 9)"

candidate_images="$work_dir/candidate-images.tsv"
: >"$candidate_images"
service_number=0
for service in auth bet backoffice client event gamemaster moderation resulting slip telemetry; do
  service_number=$((service_number + 1))
  manifest="$(sha "$((100 + service_number))")"
  platform="$(sha "$((200 + service_number))")"
  if [[ "$service" == "bet" ]]; then
    platform="$CANDIDATE_ID"
  elif [[ "$service" == "telemetry" ]]; then
    platform="$TELEMETRY_ID"
  fi
  printf '%s\t%s\t%s@%s\t%s\t%s\n' \
    "$service" \
    "ghcr.io/vasilyevstan/betstan-images" \
    "ghcr.io/vasilyevstan/betstan-images" \
    "$manifest" "$manifest" "$platform" >>"$candidate_images"
done

runtime="$work_dir/runtime.json"
python3 - "$runtime" \
  "$CURRENT_ID" "$CANDIDATE_ID" "$RECLAIM_ID" "$FOREIGN_ID" \
  "$UNTAGGED_ID" "$PINNED_ID" "$ROLLBACK_ID" "$STOPPED_ID" \
  "$SOURCE_SHA" "$RECLAIM_SOURCE_SHA" "$ROLLBACK_SOURCE_SHA" "$TELEMETRY_ID" <<'PY'
import json
import sys

(
    output,
    current_id,
    candidate_id,
    reclaim_id,
    foreign_id,
    untagged_id,
    pinned_id,
    rollback_id,
    stopped_id,
    source_sha,
    reclaim_source_sha,
    rollback_source_sha,
    telemetry_id,
) = sys.argv[1:]
repo = "ghcr.io/vasilyevstan/betstan-images"

def image(image_id, tags, digests, *, pinned=False, size=1000):
    return {
        "id": image_id,
        "repoTags": tags,
        "repoDigests": digests,
        "sizeBytes": size,
        "pinned": pinned,
    }

payload = {
    "schemaVersion": "k3s-node-disk-runtime.v1",
    "applicationRepository": repo,
    "root": {
        "mount": {
            "target": "/",
            "source": "/dev/root",
            "fstype": "ext4",
            "size": 50_000_000_000,
            "used": 37_000_000_000,
            "avail": 13_000_000_000,
        },
        "df": {
            "capacityBytes": 50_000_000_000,
            "usedBytes": 37_000_000_000,
            "availableBytes": 13_000_000_000,
            "usedPercent": 74,
        },
    },
    "mongo": {
        "mount": {
            "target": "/var/lib/betstan/mongo",
            "source": "/dev/oracleoci/oraclevdb",
            "fstype": "ext4",
            "size": 50_000_000_000,
            "used": 5_000_000_000,
            "avail": 45_000_000_000,
        },
        "separateFromRoot": True,
    },
    "consumers": [
        {"category": "apt-package-cache", "path": "/var/cache/apt", "bytes": 2_000_000_000},
        {"category": "k3s-containerd", "path": "/var/lib/rancher/k3s/agent/containerd", "bytes": 20_000_000_000},
        {"category": "k3s-server", "path": "/var/lib/rancher/k3s/server", "bytes": 1_000_000_000},
        {"category": "kubelet", "path": "/var/lib/kubelet", "bytes": 500_000_000},
        {"category": "mongo-data", "path": "/var/lib/betstan/mongo", "bytes": 5_000_000_000},
        {"category": "system-logs", "path": "/var/log", "bytes": 400_000_000},
    ],
    "images": [
        image(current_id, [f"{repo}:auth-{source_sha}"], [f"{repo}@{current_id}"]),
        image(candidate_id, [f"{repo}:bet-{source_sha}"], [f"{repo}@{candidate_id}"]),
        image(reclaim_id, [f"{repo}:event-{reclaim_source_sha}"], [f"{repo}@{reclaim_id}"], size=3_000_000_000),
        image(foreign_id, ["docker.io/library/busybox:latest"], [f"docker.io/library/busybox@{foreign_id}"]),
        image(untagged_id, [], []),
        image(pinned_id, [f"{repo}:client-{reclaim_source_sha}"], [f"{repo}@{pinned_id}"], pinned=True),
        image(rollback_id, [f"{repo}:slip-{rollback_source_sha}"], [f"{repo}@{rollback_id}"]),
        image(stopped_id, [f"{repo}:auth-{reclaim_source_sha}"], [f"{repo}@{stopped_id}"]),
        image(telemetry_id, [f"{repo}:telemetry-{source_sha}"], [f"{repo}@{telemetry_id}"]),
    ],
    "containerImageReferences": [
        {"imageRef": current_id, "requestedImage": f"{repo}@{current_id}", "state": "CONTAINER_RUNNING"},
        {"imageRef": stopped_id, "requestedImage": f"{repo}@{stopped_id}", "state": "CONTAINER_EXITED"},
    ],
    "kubernetesImageReferences": [
        f"{repo}@{current_id}",
        f"{repo}@{rollback_id}",
    ],
    "workload": {"podCount": 12, "unhealthyPodCount": 0, "restartCount": 4},
    "queue": {"queueCount": 11, "backlog": 7, "consumersHealthy": True},
    "publicRead": [
        {"name": "api-backoffice", "status": 200},
        {"name": "api-event", "status": 200},
        {"name": "home", "status": 200},
    ],
    "runtime": {
        "nodeName": "fixture-k3s",
        "k3sVersion": "k3s version v1.34.9+k3s1",
        "containerRuntimeVersion": "containerd://2.1.4-k3s1",
        "k3sActive": True,
    },
}
with open(output, "w", encoding="utf-8") as handle:
    json.dump(payload, handle, sort_keys=True)
PY

capacity="$work_dir/capacity.json"
cat >"$capacity" <<'JSON'
{"schemaVersion":"k3s-node-filesystem-capacity.v1","nodeName":"fixture-k3s","capacityBytes":50000000000,"usedBytes":37000000000,"availableBytes":13000000000,"usedPercent":74.0,"thresholdPercent":70,"withinLimit":false}
JSON

generation_map="$work_dir/generations.tsv"
{
  printf '%s\tauth\t1\t%s\n' "$SOURCE_SHA" "$CURRENT_ID"
  printf '%s\tbet\t2\t%s\n' "$SOURCE_SHA" "$CANDIDATE_ID"
  printf '%s\tevent\t3\t%s\n' "$RECLAIM_SOURCE_SHA" "$RECLAIM_ID"
  printf '%s\tclient\t6\t%s\n' "$RECLAIM_SOURCE_SHA" "$PINNED_ID"
  printf '%s\tslip\t7\t%s\n' "$ROLLBACK_SOURCE_SHA" "$ROLLBACK_ID"
  printf '%s\tauth\t8\t%s\n' "$RECLAIM_SOURCE_SHA" "$STOPPED_ID"
  printf '%s\ttelemetry\t9\t%s\n' "$SOURCE_SHA" "$TELEMETRY_ID"
} >"$generation_map"
protected_generations="$work_dir/validation-summary.json"
jq -n \
  --arg current "$SOURCE_SHA" \
  --arg rollback "$ROLLBACK_SOURCE_SHA" \
  --arg generations_checksum "$(sha256sum "$generation_map" | awk '{print $1}')" '
  {
    schema:"betstan.ghcr-package-management.v1",
    terminal_status:"VALIDATED",
    mode:"validate",
    registry_provider:"ghcr",
    registry_host:"ghcr.io",
    repository:"ghcr.io/vasilyevstan/betstan-images",
    package_visibility:"public",
    repository_linked:true,
    candidate_build_run_id:"300",
    generations_sha256:$generations_checksum,
    protected_sources:[$current,$rollback]
  }
' >"$protected_generations"

diagnosis="$work_dir/diagnosis.json"
invalid="$work_dir/invalid.json"
"$HELPER" diagnose \
  --runtime "$runtime" \
  --capacity "$capacity" \
  --candidate-images "$candidate_images" \
  --source-sha "$SOURCE_SHA" \
  --infrastructure-run-id 400 \
  --ghcr-build-run-id 300 \
  --workflow-run-id 500 \
  --output "$diagnosis"
jq -e \
  --arg reclaim "$RECLAIM_ID" \
  --arg foreign "$FOREIGN_ID" \
  --arg untagged "$UNTAGGED_ID" \
  --arg pinned "$PINNED_ID" \
  --arg rollback "$ROLLBACK_ID" \
  --arg stopped "$STOPPED_ID" \
  --arg telemetry "$TELEMETRY_ID" '
    .schemaVersion == "k3s-node-disk-diagnosis.v1" and
    .terminalStatus == "DIAGNOSED" and
    .thresholdPercent == 70 and
    [.protection.criOwnedUnusedImages[].id] == [$reclaim] and
    (.protection.preservedUnknownForeignOrPinnedImageIds | index($foreign)) != null and
    (.protection.preservedUnknownForeignOrPinnedImageIds | index($untagged)) != null and
    (.protection.preservedUnknownForeignOrPinnedImageIds | index($pinned)) != null and
    (.protection.protectedImageIds | index($rollback)) != null and
    (.protection.protectedImageIds | index($stopped)) != null and
    (.protection.protectedImageIds | index($telemetry)) != null and
    [.candidateImages[].service] ==
      ["auth","backoffice","bet","client","event","gamemaster","moderation","resulting","slip","telemetry"] and
    .protection.imageSizeEstimatesAreNonAdditive == true and
    .protection.rollbackProtectionProven == false and
    .protection.criReclaimRequiresBoundProtectedGenerations == true and
    .protection.futureCandidateHeadroomProven == false
  ' "$diagnosis" >/dev/null ||
  fail "diagnosis did not classify exact image ownership and protection"
"$HELPER" validate-diagnosis \
  --diagnosis "$diagnosis" \
  --source-sha "$SOURCE_SHA" \
  --infrastructure-run-id 400 \
  --ghcr-build-run-id 300 \
  --workflow-run-id 500
python3 - "$HELPER" "$diagnosis" <<'PY'
import copy
import importlib.util
import json
import sys
from pathlib import Path

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("disk", sys.argv[1])
disk = importlib.util.module_from_spec(spec)
spec.loader.exec_module(disk)
diagnosis = json.loads(Path(sys.argv[2]).read_text())
for case in ("missing", "duplicate", "unknown", "digest", "reference", "record"):
    invalid = copy.deepcopy(diagnosis)
    rows = invalid["candidateImages"]
    if case == "missing":
        rows.pop()
    elif case == "duplicate":
        rows[-1] = copy.deepcopy(rows[0])
    elif case == "unknown":
        rows[-1]["service"] = "unknown"
    elif case == "digest":
        rows[-1]["platformDigest"] = 42
    elif case == "reference":
        rows[-1]["imageRef"] = "invalid"
    else:
        del rows[-1]["manifestDigest"]
    del invalid["contentChecksumSha256"]
    invalid = disk.add_checksum(invalid)
    try:
        disk.validate_diagnosis(invalid)
    except SystemExit as exc:
        assert "candidate image evidence" in str(exc), (case, exc)
    else:
        raise SystemExit(f"diagnosis accepted invalid current candidate: {case}")
PY
for mismatch in \
  "--source-sha 2222222222222222222222222222222222222222" \
  "--infrastructure-run-id 401" \
  "--ghcr-build-run-id 301" \
  "--workflow-run-id 501"; do
  if "$HELPER" validate-diagnosis --diagnosis "$diagnosis" $mismatch \
      >/dev/null 2>&1; then
    fail "diagnosis accepted stale or wrong bound identity: $mismatch"
  fi
done
jq '.unexpected = true' "$diagnosis" >"$invalid"
if "$HELPER" validate-diagnosis --diagnosis "$invalid" >/dev/null 2>&1; then
  fail "diagnosis accepted an unexpected schema field"
fi
jq '.terminalStatus = "DIAGNOSED-TAMPERED"' "$diagnosis" >"$invalid"
if "$HELPER" validate-diagnosis --diagnosis "$invalid" >/dev/null 2>&1; then
  fail "diagnosis accepted a checksum mismatch"
fi

jq '.mongo.mount.source = .root.mount.source' "$runtime" >"$invalid"
if "$HELPER" diagnose --runtime "$invalid" --capacity "$capacity" \
    --candidate-images "$candidate_images" --source-sha "$SOURCE_SHA" \
    --infrastructure-run-id 400 --ghcr-build-run-id 300 \
    --workflow-run-id 500 --output "$work_dir/invalid-diagnosis.json" \
    >/dev/null 2>&1; then
  fail "diagnosis accepted Mongo on the root filesystem"
fi
jq 'del(.consumers[0])' "$runtime" >"$invalid"
if "$HELPER" diagnose --runtime "$invalid" --capacity "$capacity" \
    --candidate-images "$candidate_images" --source-sha "$SOURCE_SHA" \
    --infrastructure-run-id 400 --ghcr-build-run-id 300 \
    --workflow-run-id 500 --output "$work_dir/invalid-diagnosis.json" \
    >/dev/null 2>&1; then
  fail "diagnosis accepted missing fixed-path consumer evidence"
fi
jq '.images[0].repoDigests = [42]' "$runtime" >"$invalid"
if "$HELPER" diagnose --runtime "$invalid" --capacity "$capacity" \
    --candidate-images "$candidate_images" --source-sha "$SOURCE_SHA" \
    --infrastructure-run-id 400 --ghcr-build-run-id 300 \
    --workflow-run-id 500 --output "$work_dir/invalid-diagnosis.json" \
    >/dev/null 2>&1; then
  fail "diagnosis accepted malformed CRI references"
fi

selected="$(jq -cn --arg id "$RECLAIM_ID" '[$id]')"
"$HELPER" plan-reclaim \
  --diagnosis "$diagnosis" \
  --runtime "$runtime" \
  --capacity "$capacity" \
  --category cri-owned-unused-images \
  --image-ids "$selected" \
  --protected-generations "$protected_generations" \
  --generation-map "$generation_map" \
  --output "$work_dir/cri-plan.json"
if "$HELPER" plan-reclaim --diagnosis "$diagnosis" --runtime "$runtime" \
    --capacity "$capacity" --category cri-owned-unused-images \
    --image-ids "$selected" --generation-map "$generation_map" \
    --output "$work_dir/no-rollback-proof.json" \
    >/dev/null 2>&1; then
  fail "CRI reclaim did not fail closed without durable rollback evidence"
fi
if "$HELPER" plan-reclaim --diagnosis "$diagnosis" --runtime "$runtime" \
    --capacity "$capacity" --category cri-owned-unused-images \
    --image-ids "$selected" --protected-generations "$protected_generations" \
    --output "$work_dir/no-generation-map.json" >/dev/null 2>&1; then
  fail "CRI reclaim did not fail closed without the bound generation map"
fi
runtime_without_history="$work_dir/runtime-without-history.json"
jq --arg rollback "$ROLLBACK_ID" '
  .kubernetesImageReferences |= map(select(contains($rollback) | not))
' "$runtime" >"$runtime_without_history"
diagnosis_without_history="$work_dir/diagnosis-without-history.json"
"$HELPER" diagnose \
  --runtime "$runtime_without_history" \
  --capacity "$capacity" \
  --candidate-images "$candidate_images" \
  --source-sha "$SOURCE_SHA" \
  --infrastructure-run-id 400 \
  --ghcr-build-run-id 300 \
  --workflow-run-id 502 \
  --output "$diagnosis_without_history"
rollback_selected="$(jq -cn --arg id "$ROLLBACK_ID" '[$id]')"
if "$HELPER" plan-reclaim --diagnosis "$diagnosis_without_history" \
    --runtime "$runtime_without_history" --capacity "$capacity" \
    --category cri-owned-unused-images --image-ids "$rollback_selected" \
    --protected-generations "$protected_generations" \
    --generation-map "$generation_map" \
    --output "$work_dir/rollback-plan.json" >/dev/null 2>&1; then
  fail "durably protected rollback generation was reclaimable after history GC"
fi
if "$HELPER" plan-reclaim --diagnosis "$diagnosis" --runtime "$runtime" \
    --capacity "$capacity" --category cri-owned-unused-images \
    --image-ids "$(jq -cn --arg id "$FOREIGN_ID" '[$id]')" \
    --protected-generations "$protected_generations" \
    --generation-map "$generation_map" \
    --output "$work_dir/bad-plan.json" >/dev/null 2>&1; then
  fail "foreign CRI image was accepted for reclaim"
fi
if "$HELPER" plan-reclaim --diagnosis "$diagnosis" --runtime "$runtime" \
    --capacity "$capacity" --category injected-command --image-ids '[]' \
    --output "$work_dir/bad-plan.json" >/dev/null 2>&1; then
  fail "injected reclaim category was accepted"
fi
jq '.kubernetesImageReferences += ["ghcr.io/example/changed@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]' \
  "$runtime" >"$invalid"
if "$HELPER" plan-reclaim --diagnosis "$diagnosis" --runtime "$invalid" \
    --capacity "$capacity" --category cri-owned-unused-images \
    --image-ids "$selected" --protected-generations "$protected_generations" \
    --generation-map "$generation_map" \
    --output "$work_dir/bad-plan.json" >/dev/null 2>&1; then
  fail "security-relevant image-reference drift was accepted"
fi

python3 - "$HELPER" "$runtime" "$capacity" "$diagnosis" \
  "$protected_generations" "$generation_map" "$work_dir" <<'PY'
import copy
import hashlib
import importlib.util
import json
import sys
from pathlib import Path

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("disk", sys.argv[1])
disk = importlib.util.module_from_spec(spec)
spec.loader.exec_module(disk)
runtime = json.loads(Path(sys.argv[2]).read_text())
capacity = json.loads(Path(sys.argv[3]).read_text())
diagnosis = json.loads(Path(sys.argv[4]).read_text())
summary = json.loads(Path(sys.argv[5]).read_text())
base_rows = Path(sys.argv[6]).read_text().splitlines()
case_dir = Path(sys.argv[7]) / "generation-map-cases"
case_dir.mkdir()
table = case_dir / "generations.tsv"
summary_file = case_dir / "validation-summary.json"
reclaim_id = runtime["images"][2]["id"]
rollback_id = runtime["images"][6]["id"]
extra_id = "sha256:" + "9" * 64
other_source = "4" * 40
repo = disk.REPOSITORY


def rejected(callback, label):
    try:
        callback()
    except SystemExit:
        return
    raise SystemExit(f"accepted invalid generation evidence or selection: {label}")


def parse_rows(rows=None, raw=None, expected=None):
    if raw is None:
        raw = ("\n".join(base_rows if rows is None else rows) + "\n").encode()
    table.write_bytes(raw)
    bound = dict(summary)
    bound["generations_sha256"] = (
        hashlib.sha256(raw).hexdigest() if expected is None else expected
    )
    summary_file.write_text(json.dumps(bound))
    return disk.parse_protected_generations(summary_file, diagnosis, table)


sources, mapping = parse_rows()
digest_only = copy.deepcopy(runtime)
digest_only["images"][2]["repoTags"] = []
assert reclaim_id not in {
    item["id"] for item in disk.classify(
        digest_only, diagnosis["candidateImages"]
    )["criOwnedUnusedImages"]
}
disk.validate_fresh_against_diagnosis(diagnosis, runtime, capacity)
classification = disk.classify(
    digest_only, diagnosis["candidateImages"], sources, mapping
)
assert reclaim_id in {item["id"] for item in classification["criOwnedUnusedImages"]}

alias_row = f"{other_source}\tevent\t3\t{reclaim_id}"
sources, aliases = parse_rows(base_rows + [alias_row])
assert aliases[reclaim_id]["sources"] == {base_rows[2].split("\t")[0], other_source}
assert reclaim_id in {
    item["id"] for item in disk.classify(
        digest_only, diagnosis["candidateImages"], sources, aliases
    )["criOwnedUnusedImages"]
}
protected_alias = f"{diagnosis['sourceSha']}\tevent\t3\t{reclaim_id}"
sources, protected_mapping = parse_rows(base_rows + [alias_row, protected_alias])
for snapshot in (runtime, digest_only):
    assert reclaim_id in disk.classify(
        snapshot, diagnosis["candidateImages"], sources, protected_mapping
    )["protectedImageIds"]

sources, mapping = parse_rows()
without_history = copy.deepcopy(runtime)
without_history["images"][6]["repoTags"] = []
without_history["kubernetesImageReferences"] = [
    ref for ref in without_history["kubernetesImageReferences"]
    if rollback_id not in ref
]
assert rollback_id in disk.classify(
    without_history, diagnosis["candidateImages"], sources, mapping
)["protectedImageIds"]
for index in (0, 1, 5, 7, 8):
    snapshot = copy.deepcopy(runtime)
    snapshot["images"][index]["repoTags"] = []
    target_id = snapshot["images"][index]["id"]
    assert target_id not in {
        item["id"] for item in disk.classify(
            snapshot, diagnosis["candidateImages"], sources, mapping
        )["criOwnedUnusedImages"]
    }
manifest_snapshot = copy.deepcopy(digest_only)
manifest_snapshot["images"][2]["repoDigests"] = [
    diagnosis["candidateImages"][0]["imageRef"]
]
manifest_row = (
    f"{other_source}\tauth\t10\t"
    f"{diagnosis['candidateImages'][0]['manifestDigest']}"
)
sources, manifest_mapping = parse_rows(base_rows + [manifest_row])
assert reclaim_id in disk.classify(
    manifest_snapshot, diagnosis["candidateImages"], sources, manifest_mapping
)["protectedImageIds"]

sources, mapping = parse_rows()
invalid_images = {
    "unmapped": {"repoDigests": [f"{repo}@{extra_id}"]},
    "partly-unmapped": {"repoDigests": [f"{repo}@{reclaim_id}", f"{repo}@{extra_id}"]},
    "foreign": {"repoDigests": [f"docker.io/library/busybox@{reclaim_id}"]},
    "mixed": {"repoDigests": [f"{repo}@{reclaim_id}", f"docker.io/library/busybox@{extra_id}"]},
    "wrong-repository": {"repoDigests": [f"{repo}-other@{reclaim_id}"]},
    "short-digest": {"repoDigests": [f"{repo}@sha256:1234"]},
    "digest-suffix": {"repoDigests": [f"{repo}@{reclaim_id}:extra"]},
    "no-digests": {"repoDigests": []},
    "mutable-tag": {"repoTags": [f"{repo}:latest"]},
    "malformed-tag": {"repoTags": [f"{repo}:event-not-a-source"]},
    "foreign-tag": {"repoTags": ["docker.io/library/busybox:latest"]},
    "mixed-tags": {"repoTags": runtime["images"][2]["repoTags"] + ["docker.io/library/busybox:latest"]},
    "pinned": {"pinned": True},
    "different-services": {"repoDigests": [f"{repo}@{reclaim_id}", f"{repo}@{runtime['images'][5]['id']}"]},
}
for label, changes in invalid_images.items():
    snapshot = copy.deepcopy(digest_only)
    snapshot["images"][2].update(changes)
    assert reclaim_id not in {
        item["id"] for item in disk.classify(
            snapshot, diagnosis["candidateImages"], sources, mapping
        )["criOwnedUnusedImages"]
    }, label

for column, value in ((0, "bad-source"), (1, "unknown"), (2, "0"), (2, "-1"), (3, "sha256:bad")):
    rows = list(base_rows)
    fields = rows[2].split("\t")
    fields[column] = value
    rows[2] = "\t".join(fields)
    rejected(lambda: parse_rows(rows), f"invalid column {column}: {value}")
for label, rows in (
    ("duplicate-row", base_rows + [base_rows[2]]),
    ("cross-service", base_rows + [f"{other_source}\tauth\t3\t{reclaim_id}"]),
    ("missing-protected-source", [row for row in base_rows if row.split("\t")[0] != summary["protected_sources"][1]]),
    ("missing-column", ["\t".join(base_rows[0].split("\t")[:3])] + base_rows[1:]),
    ("extra-column", [base_rows[0] + "\textra"] + base_rows[1:]),
    ("empty-row", base_rows + [""]),
):
    rejected(lambda: parse_rows(rows), label)
rejected(lambda: parse_rows(raw=b""), "empty-table")
rejected(lambda: parse_rows(raw=b"\xff"), "invalid-UTF8")
rejected(lambda: parse_rows(expected="0" * 64), "wrong-checksum")
rejected(lambda: parse_rows(expected="malformed"), "malformed-checksum")
parse_rows()
bound = json.loads(summary_file.read_text())
del bound["generations_sha256"]
summary_file.write_text(json.dumps(bound))
rejected(lambda: disk.parse_protected_generations(summary_file, diagnosis, table), "missing-checksum")
parse_rows()
table.unlink()
rejected(lambda: disk.parse_protected_generations(summary_file, diagnosis, table), "missing-table")
table.symlink_to(Path(sys.argv[6]))
rejected(lambda: disk.parse_protected_generations(summary_file, diagnosis, table), "symlink-table")
table.unlink()

for label in ("id", "tag", "digest", "pin", "container", "kubernetes", "mount", "identity"):
    snapshot = copy.deepcopy(runtime)
    if label == "id":
        snapshot["images"][2]["id"] = extra_id
    elif label == "tag":
        snapshot["images"][2]["repoTags"] = []
    elif label == "digest":
        snapshot["images"][2]["repoDigests"] = [f"{repo}@{extra_id}"]
    elif label == "pin":
        snapshot["images"][2]["pinned"] = True
    elif label == "container":
        snapshot["containerImageReferences"][0]["requestedImage"] = f"{repo}@{extra_id}"
    elif label == "kubernetes":
        snapshot["kubernetesImageReferences"].append(f"{repo}@{extra_id}")
    elif label == "mount":
        snapshot["root"]["mount"]["source"] = "/dev/changed-root"
    else:
        snapshot["runtime"]["k3sVersion"] = "changed"
    rejected(
        lambda: disk.validate_fresh_against_diagnosis(diagnosis, snapshot, capacity),
        f"fresh {label} drift",
    )
PY

post_cri="$work_dir/post-cri.json"
jq --arg id "$RECLAIM_ID" '
  .images |= map(select(.id != $id)) |
  .root.mount.used = 34500000000 |
  .root.mount.avail = 15500000000 |
  .root.df.usedBytes = 34500000000 |
  .root.df.availableBytes = 15500000000 |
  .root.df.usedPercent = 69 |
  .queue.backlog = 9
' "$runtime" >"$post_cri"
post_capacity="$work_dir/post-capacity.json"
cat >"$post_capacity" <<'JSON'
{"schemaVersion":"k3s-node-filesystem-capacity.v1","nodeName":"fixture-k3s","capacityBytes":50000000000,"usedBytes":34500000000,"availableBytes":15500000000,"usedPercent":69.0,"thresholdPercent":70,"withinLimit":true}
JSON
"$HELPER" finalize-reclaim \
  --diagnosis "$diagnosis" \
  --post-runtime "$post_cri" \
  --post-capacity "$post_capacity" \
  --category cri-owned-unused-images \
  --image-ids "$selected" \
  --mutation-succeeded true \
  --output "$work_dir/cri-result.json"
jq -e '
  .terminalStatus == "RECLAIMED" and
  .thresholdPercent == 70 and
  .actualMeasuredRootBytesFreed == 2500000000 and
  .imageSizeEstimatesWereNonAdditive == true and
  .futureCandidateHeadroomProven == false
' "$work_dir/cri-result.json" >/dev/null ||
  fail "successful exact CRI reclaim result is invalid"

if "$HELPER" finalize-reclaim --diagnosis "$diagnosis" \
    --post-runtime "$post_cri" --post-capacity "$post_capacity" \
    --category cri-owned-unused-images --image-ids "$selected" \
    --mutation-succeeded false --output "$work_dir/partial-result.json" \
    >/dev/null 2>&1; then
  fail "partial CRI mutation masqueraded as success"
fi
jq -e '.terminalStatus == "INCOMPLETE"' "$work_dir/partial-result.json" >/dev/null ||
  fail "partial CRI mutation did not record an incomplete result"

"$HELPER" plan-reclaim \
  --diagnosis "$diagnosis" \
  --runtime "$runtime" \
  --capacity "$capacity" \
  --category apt-package-cache \
  --image-ids '[]' \
  --output "$work_dir/apt-plan.json"
post_apt="$work_dir/post-apt.json"
jq '
  (.consumers[] | select(.category == "apt-package-cache").bytes) = 100000000 |
  .root.mount.used = 34500000000 |
  .root.mount.avail = 15500000000 |
  .root.df.usedBytes = 34500000000 |
  .root.df.availableBytes = 15500000000 |
  .root.df.usedPercent = 69
' "$runtime" >"$post_apt"
"$HELPER" finalize-reclaim \
  --diagnosis "$diagnosis" \
  --post-runtime "$post_apt" \
  --post-capacity "$post_capacity" \
  --category apt-package-cache \
  --image-ids '[]' \
  --mutation-succeeded true \
  --output "$work_dir/apt-result.json"

over_capacity="$work_dir/over-capacity.json"
cat >"$over_capacity" <<'JSON'
{"schemaVersion":"k3s-node-filesystem-capacity.v1","nodeName":"fixture-k3s","capacityBytes":50000000000,"usedBytes":35500000000,"availableBytes":14500000000,"usedPercent":71.0,"thresholdPercent":70,"withinLimit":false}
JSON
if "$HELPER" finalize-reclaim --diagnosis "$diagnosis" \
    --post-runtime "$post_apt" --post-capacity "$over_capacity" \
    --category apt-package-cache --image-ids '[]' \
    --mutation-succeeded true --output "$work_dir/over-result.json" \
    >/dev/null 2>&1; then
  fail "reclaim above the unchanged 70 percent limit was accepted"
fi

grep -Fxq '    apt-get clean' "$REMOTE" ||
  fail "remote reclaim does not use native apt-get clean"
grep -Fq '      cri rmi "$image_id"' "$REMOTE" ||
  fail "remote reclaim does not remove exact CRI image IDs"
if grep -Eq 'crictl[[:space:]]+rmi[[:space:]]+--prune|docker[[:space:]].*prune|rm[[:space:]]+-rf' "$REMOTE"; then
  fail "remote reclaim contains a forbidden global or direct-filesystem prune"
fi

stub_bin="$work_dir/bin"
mkdir -p "$stub_bin"
cat >"$stub_bin/kubectl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "get nodes -o json" ]]; then
  printf '{"items":[{"metadata":{"name":"fixture-k3s"}}]}\n'
elif [[ "$*" == "get --raw /api/v1/nodes/fixture-k3s/proxy/stats/summary" ]]; then
  cat "${STUB_CAPACITY_SUMMARY:?}"
else
  echo "unexpected kubectl invocation: $*" >&2
  exit 1
fi
SH
chmod +x "$stub_bin/kubectl"
cat >"$work_dir/summary-before.json" <<'JSON'
{"node":{"fs":{"capacityBytes":50000000000,"usedBytes":37000000000,"availableBytes":13000000000}}}
JSON
cat >"$work_dir/summary-after.json" <<'JSON'
{"node":{"fs":{"capacityBytes":50000000000,"usedBytes":34500000000,"availableBytes":15500000000}}}
JSON
cp "$runtime" "$work_dir/current-runtime.json"
cp "$work_dir/summary-before.json" "$work_dir/current-summary.json"
cat >"$work_dir/remote-runner" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
action="$1"
selected="$2"
printf '%s\t%s\n' "$action" "$selected" >>"${STUB_REMOTE_LOG:?}"
case "$action" in
  baseline-proof)
    baseline_count="$(awk '$1 == "baseline-proof" {count++} END {print count+0}' "$STUB_REMOTE_LOG")"
    if [[ "$baseline_count" == "2" && -n "${STUB_BASELINE_AFTER:-}" ]]; then
      cat "$STUB_BASELINE_AFTER"
    else
      cat "${STUB_BASELINE_NODE:?}"
    fi
    ;;
  mongo-storage)
    [[ -n "${STUB_MONGO_STORAGE:-}" ]] || exit 1
    cat "$STUB_MONGO_STORAGE"
    ;;
  snapshot)
    cat "${STUB_CURRENT_RUNTIME:?}"
    ;;
  reclaim-cri-owned-unused-images)
    cp "${STUB_POST_RUNTIME:?}" "${STUB_CURRENT_RUNTIME:?}"
    cp "${STUB_POST_SUMMARY:?}" "${STUB_CURRENT_SUMMARY:?}"
    ;;
  reclaim-apt-package-cache)
    cp "${STUB_POST_RUNTIME:?}" "${STUB_CURRENT_RUNTIME:?}"
    cp "${STUB_POST_SUMMARY:?}" "${STUB_CURRENT_SUMMARY:?}"
    ;;
  *)
    exit 1
    ;;
esac
SH
chmod +x "$work_dir/remote-runner"
touch "$work_dir/key" "$work_dir/known-hosts"
sleep 300 &
tunnel_pid=$!
cat >"$work_dir/session.env" <<EOF
target_private_key=$work_dir/key
target_known_hosts=$work_dir/known-hosts
instance_ocid=ocid1.instance.oc1..test
instance_private_ip=10.0.0.2
os_user=ubuntu
local_ssh_port=12222
ssh_tunnel_pid=$tunnel_pid
EOF
cat >"$work_dir/infrastructure.env" <<'EOF'
canonical_host=fixture.example
k3s_node_name=fixture-k3s
EOF

common_env=(
  PATH="$stub_bin:$PATH"
  STUB_CAPACITY_SUMMARY="$work_dir/current-summary.json"
  STUB_CURRENT_RUNTIME="$work_dir/current-runtime.json"
  STUB_CURRENT_SUMMARY="$work_dir/current-summary.json"
  STUB_POST_RUNTIME="$post_cri"
  STUB_POST_SUMMARY="$work_dir/summary-after.json"
  STUB_REMOTE_LOG="$work_dir/remote.log"
  K3S_DISK_REMOTE_RUNNER="$work_dir/remote-runner"
  SOURCE_SHA="$SOURCE_SHA"
  INFRASTRUCTURE_RUN_ID=400
  GHCR_BUILD_RUN_ID=300
  GHCR_PACKAGE_VALIDATION_FILE="$protected_generations"
  GHCR_GENERATIONS_FILE="$generation_map"
  INFRA_PROVENANCE_FILE="$work_dir/infrastructure.env"
  OCI_K3S_NODE_NAME=fixture-k3s
  SESSION_STATE_FILE="$work_dir/session.env"
  CANDIDATE_IMAGES_FILE="$candidate_images"
  WORK_DIR="$work_dir/orchestrator-work"
  GITHUB_RUN_ATTEMPT=1
)
env "${common_env[@]}" \
  GITHUB_RUN_ID=500 \
  RECLAIM_CATEGORY=none \
  RECLAIM_IMAGE_IDS='[]' \
  OUTPUT_FILE="$work_dir/orchestrated-diagnosis.json" \
  "$ORCHESTRATOR" diagnose >/dev/null

cp "$runtime" "$work_dir/current-runtime.json"
cp "$work_dir/summary-before.json" "$work_dir/current-summary.json"
env "${common_env[@]}" \
  GITHUB_RUN_ID=501 \
  DIAGNOSIS_RUN_ID=500 \
  DIAGNOSIS_FILE="$work_dir/orchestrated-diagnosis.json" \
  RECLAIM_CATEGORY=cri-owned-unused-images \
  RECLAIM_IMAGE_IDS="$selected" \
  OUTPUT_FILE="$work_dir/orchestrated-reclaim.json" \
  "$ORCHESTRATOR" reclaim >/dev/null
[[ "$(awk '$1 == "reclaim-cri-owned-unused-images" {count++} END {print count+0}' "$work_dir/remote.log")" == "1" ]] ||
  fail "orchestrator did not issue exactly one native CRI reclaim category"
jq -e '.terminalStatus == "RECLAIMED"' "$work_dir/orchestrated-reclaim.json" >/dev/null ||
  fail "orchestrated reclaim did not produce checksummed success evidence"

digest_runtime="$work_dir/digest-only-runtime.json"
jq --arg id "$RECLAIM_ID" '
  (.images[] | select(.id == $id).repoTags) = []
' "$runtime" >"$digest_runtime"
cp "$digest_runtime" "$work_dir/current-runtime.json"
cp "$work_dir/summary-before.json" "$work_dir/current-summary.json"
env "${common_env[@]}" \
  GITHUB_RUN_ID=503 \
  RECLAIM_CATEGORY=none \
  RECLAIM_IMAGE_IDS='[]' \
  OUTPUT_FILE="$work_dir/digest-only-diagnosis.json" \
  "$ORCHESTRATOR" diagnose >/dev/null
jq -e '.protection.criOwnedUnusedImages == []' \
  "$work_dir/digest-only-diagnosis.json" >/dev/null ||
  fail "map-free diagnosis reclassified a digest-only record"
if env "${common_env[@]}" \
    GITHUB_RUN_ID=504 \
    DIAGNOSIS_RUN_ID=503 \
    DIAGNOSIS_FILE="$work_dir/digest-only-diagnosis.json" \
    RECLAIM_CATEGORY=cri-owned-unused-images \
    RECLAIM_IMAGE_IDS="$selected" \
    GHCR_GENERATIONS_FILE= \
    OUTPUT_FILE="$work_dir/missing-map-reclaim.json" \
    "$ORCHESTRATOR" reclaim >/dev/null 2>&1; then
  fail "orchestrator reclaimed digest-only images without the generation table"
fi
[[ "$(awk '$1 == "reclaim-cri-owned-unused-images" {count++} END {print count+0}' "$work_dir/remote.log")" == "1" ]] ||
  fail "missing generation evidence reached remote deletion"
env "${common_env[@]}" \
  GITHUB_RUN_ID=504 \
  DIAGNOSIS_RUN_ID=503 \
  DIAGNOSIS_FILE="$work_dir/digest-only-diagnosis.json" \
  RECLAIM_CATEGORY=cri-owned-unused-images \
  RECLAIM_IMAGE_IDS="$selected" \
  OUTPUT_FILE="$work_dir/digest-only-reclaim.json" \
  "$ORCHESTRATOR" reclaim >/dev/null
jq -e --arg id "$RECLAIM_ID" '
  .terminalStatus == "RECLAIMED" and .removedImageIds == [$id] and
  .thresholdPercent == 70 and .securityRelevantStateStable == true
' "$work_dir/digest-only-reclaim.json" >/dev/null ||
  fail "bound digest-only reclaim did not preserve exact postconditions"
[[ "$(awk '$1 == "reclaim-cri-owned-unused-images" {count++} END {print count+0}' "$work_dir/remote.log")" == "2" ]] ||
  fail "digest-only reclaim did not issue exactly one additional native deletion"

cri_only_bin="$work_dir/cri-only-bin"
mkdir -p "$cri_only_bin"
ln -s "$(command -v bash)" "$cri_only_bin/bash"
ln -s "$(command -v base64)" "$cri_only_bin/base64"
ln -s "$(command -v jq)" "$cri_only_bin/jq"
cat >"$cri_only_bin/k3s" <<'SH'
#!/bin/bash
set -euo pipefail
printf '%s\n' "$*" >>"${STUB_K3S_LOG:?}"
[[ "$1" == "crictl" ]]
[[ "$2" == "--runtime-endpoint" ]]
[[ "$3" == "unix:///run/k3s/containerd/containerd.sock" ]]
[[ "$4" == "--image-endpoint" ]]
[[ "$5" == "unix:///run/k3s/containerd/containerd.sock" ]]
[[ "$6" == "rmi" ]]
[[ "$7" =~ ^sha256:[0-9a-f]{64}$ ]]
SH
chmod +x "$cri_only_bin/k3s"
PATH="$cri_only_bin" STUB_K3S_LOG="$work_dir/k3s-crictl.log" \
  "$REMOTE" reclaim-cri-owned-unused-images "$selected"
[[ ! -e "$cri_only_bin/crictl" ]] ||
  fail "CRI fixture unexpectedly provided standalone crictl"
grep -Fq \
  "crictl --runtime-endpoint unix:///run/k3s/containerd/containerd.sock --image-endpoint unix:///run/k3s/containerd/containerd.sock rmi $RECLAIM_ID" \
  "$work_dir/k3s-crictl.log" ||
  fail "remote CRI reclaim did not use bundled k3s crictl with exact endpoint and ID"

public_bin="$work_dir/public-bin"
mkdir -p "$public_bin"
ln -s "$(command -v bash)" "$public_bin/bash"
ln -s "$(command -v base64)" "$public_bin/base64"
ln -s "$(command -v jq)" "$public_bin/jq"
cat >"$public_bin/curl" <<'SH'
#!/bin/bash
set -euo pipefail
url=""
for argument in "$@"; do
  url="$argument"
done
printf '%s\n' "$url" >>"${STUB_CURL_LOG:?}"
case "$url" in
  https://fixture.example/)
    printf '<html>ok</html>\n200'
    ;;
  https://fixture.example/api/event)
    if [[ "${STUB_API_FAILURE:-0}" == "1" ]]; then
      printf '<html>spa fallback</html>\n503'
    elif [[ "${STUB_NON_ARRAY:-0}" == "1" ]]; then
      printf '{"status":"ok"}\n200'
    else
      printf '[]\n200'
    fi
    ;;
  https://fixture.example/api/backoffice)
    printf '[]\n200'
    ;;
  https://fixture.example/Event | https://fixture.example/Backoffice)
    printf '<html>spa shell</html>\n200'
    ;;
  *)
    exit 1
    ;;
esac
SH
chmod +x "$public_bin/curl"
encoded_host="$(printf fixture.example | base64 | tr -d '\n')"
encoded_node="$(printf fixture-k3s | base64 | tr -d '\n')"
if PATH="$public_bin" STUB_CURL_LOG="$work_dir/curl-failed.log" \
    STUB_API_FAILURE=1 K3S_DISK_CANONICAL_HOST_B64="$encoded_host" \
    K3S_DISK_NODE_NAME_B64="$encoded_node" \
    "$REMOTE" probe-public-read >/dev/null 2>&1; then
  fail "SPA success masked a failing backend API"
fi
if grep -Eq '/Event$|/Backoffice$' "$work_dir/curl-failed.log"; then
  fail "public read evidence probed SPA routes instead of backend APIs"
fi
if PATH="$public_bin" STUB_CURL_LOG="$work_dir/curl-non-array.log" \
    STUB_NON_ARRAY=1 K3S_DISK_CANONICAL_HOST_B64="$encoded_host" \
    K3S_DISK_NODE_NAME_B64="$encoded_node" \
    "$REMOTE" probe-public-read >/dev/null 2>&1; then
  fail "HTTP 200 non-array backend response was accepted"
fi
PATH="$public_bin" STUB_CURL_LOG="$work_dir/curl-success.log" \
  K3S_DISK_CANONICAL_HOST_B64="$encoded_host" \
  K3S_DISK_NODE_NAME_B64="$encoded_node" \
  "$REMOTE" probe-public-read |
  jq -e '
    map(.name) == ["api-backoffice","api-event","home"] and
    all(.[]; .status == 200)
  ' >/dev/null ||
  fail "canonical-host backend API array probes did not pass"

# Exercise the real SSH stdin bundle and snapshot, not the prebuilt-JSON runner.
snapshot_bin="$work_dir/snapshot-bin"
mkdir -p "$snapshot_bin"
ln -s "$public_bin/curl" "$snapshot_bin/curl"
cat >"$snapshot_bin/jq" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
for argument in "$@"; do
  if [[ "${#argument}" -ge 131072 || "$argument" == *snapshot-native-payload-* ]]; then
    printf 'native JSON reached jq argv\n' >>"$STUB_JQ_ARGV_LOG"
    printf 'jq fixture argument limit exceeded\n' >&2
    exit 1
  fi
done
exec "$STUB_REAL_JQ" "$@"
SH
cat >"$snapshot_bin/ssh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
remote_command=""
for argument in "$@"; do remote_command="$argument"; done
[[ "$remote_command" == "sudo K3S_DISK_SELECTED_IMAGE_IDS_B64=W10= K3S_DISK_CANONICAL_HOST_B64=$K3S_DISK_CANONICAL_HOST_B64 K3S_DISK_NODE_NAME_B64=$K3S_DISK_NODE_NAME_B64 bash -s -- snapshot" ]]
exec bash -s -- snapshot
SH
cat >"$snapshot_bin/snapshot-fixture" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
case "${0##*/}:$*" in
  "findmnt:--json --bytes --output TARGET,SOURCE,FSTYPE,SIZE,USED,AVAIL --target /")
    jq '{filesystems:[.root.mount]}' "$STUB_CURRENT_RUNTIME"
    ;;
  "findmnt:--json --bytes --output TARGET,SOURCE,FSTYPE,SIZE,USED,AVAIL --target /var/lib/betstan/mongo")
    jq '{filesystems:[.mongo.mount]}' "$STUB_CURRENT_RUNTIME"
    ;;
  "df:--block-size=1 --output=size,used,avail,pcent,target /")
    printf 'Size Used Avail Use%% Mounted\n50000000000 37000000000 13000000000 74%% /\n'
    ;;
  "du:--bytes --summarize --one-file-system "*)
    printf '0\n'
    ;;
  "k3s:crictl --runtime-endpoint unix:///run/k3s/containerd/containerd.sock --image-endpoint unix:///run/k3s/containerd/containerd.sock images -o json")
    if [[ -n "${STUB_SNAPSHOT_IMAGES:-}" ]]; then
      cat "$STUB_SNAPSHOT_IMAGES"
    else
      jq '{images:[.images[] | .size=(.sizeBytes|tostring) | del(.sizeBytes)]}' "$STUB_CURRENT_RUNTIME"
    fi
    ;;
  "k3s:crictl --runtime-endpoint unix:///run/k3s/containerd/containerd.sock --image-endpoint unix:///run/k3s/containerd/containerd.sock ps -a -o json")
    if [[ -n "${STUB_SNAPSHOT_CONTAINERS:-}" ]]; then
      cat "$STUB_SNAPSHOT_CONTAINERS"
    else
      jq '{containers:[.containerImageReferences[] | {imageRef,state,image:{image:.requestedImage}}]}' "$STUB_CURRENT_RUNTIME"
    fi
    ;;
  "k3s:kubectl get pods -A -o json")
    if [[ -n "${STUB_SNAPSHOT_PODS:-}" ]]; then
      cat "$STUB_SNAPSHOT_PODS"
    else
      printf '%s\n' '{"items":[{"metadata":{"namespace":"betstan-oci","name":"fixture-rabbitmq","labels":{"app":"gaming-rabbitmq"}},"spec":{"containers":[{"image":"rabbitmq:3-management"}]},"status":{"phase":"Running","conditions":[{"type":"Ready","status":"True"}],"containerStatuses":[{"restartCount":0}]}}]}'
    fi
    ;;
  "k3s:kubectl get deployments,statefulsets,daemonsets,replicasets,jobs,cronjobs -A -o json")
    cat "$STUB_WORKLOADS"
    ;;
  "k3s:kubectl exec -n betstan-oci fixture-rabbitmq -- rabbitmqctl list_queues --quiet name messages_ready messages_unacknowledged consumers")
    [[ "${STUB_QUEUE_FAILURE:-0}" != "1" ]] || exit 42
    cat "$STUB_QUEUES"
    ;;
  "k3s:--version")
    if [[ "${STUB_K3S_VERSION_MALFORMED:-0}" == "1" ]]; then
      printf 'invalid version line\n'
    else
      printf 'k3s version v1.34.5+k3s1 (fixture)\n'
    fi
    if [[ "${STUB_K3S_VERSION_MULTILINE:-0}" == "1" ]]; then
      sleep 0.1
      printf 'go version go1.24 (fixture)\n'
    fi
    [[ "${STUB_K3S_VERSION_FAILURE:-0}" != "1" ]] || exit 42
    ;;
  "k3s:kubectl get nodes -o json")
    printf '%s\n' '{"items":[{"metadata":{"name":"fixture-k3s"},"status":{"nodeInfo":{"containerRuntimeVersion":"containerd://2.1.5-k3s1"}}}]}'
    ;;
  "systemctl:is-active --quiet k3s")
    ;;
  *)
    printf 'Unexpected snapshot fixture command: %s\n' "${0##*/}:$*" >&2
    exit 1
    ;;
esac
SH
chmod +x "$snapshot_bin/jq" "$snapshot_bin/ssh" "$snapshot_bin/snapshot-fixture"
for snapshot_command in findmnt df du k3s systemctl; do
  ln -s "$snapshot_bin/snapshot-fixture" "$snapshot_bin/$snapshot_command"
done
jq -n --arg image "ghcr.io/vasilyevstan/betstan-images@$CURRENT_ID" '
  {items:[
    ["auth","bet","backoffice","client","event","gamemaster","moderation","resulting","slip"][] |
    {
    kind:"Deployment",
    metadata:{namespace:"betstan-oci",name:("gaming-" + . + "-depl")},
    spec:{template:{spec:{containers:[{image:$image}]}}}
  }]}
' >"$work_dir/snapshot-workloads-base.json"
cp "$work_dir/snapshot-workloads-base.json" "$work_dir/snapshot-workloads.json"
queue_header=$'name\tmessages_ready\tmessages_unacknowledged\tconsumers'
active_queues=$'event_new_event\t2\t1\t1\ngamemaster_new_event\t0\t0\t1\nbet_place_bet\t0\t0\t1'
idle_telemetry=$'telemetry:events:v1\t0\t0\t0'
snapshot_env=(
  "${common_env[@]}"
  PATH="$snapshot_bin:$stub_bin:$PATH"
  K3S_DISK_REMOTE_RUNNER=
  STUB_CURRENT_RUNTIME="$runtime"
  STUB_CAPACITY_SUMMARY="$work_dir/summary-before.json"
  STUB_WORKLOADS="$work_dir/snapshot-workloads.json"
  STUB_QUEUES="$work_dir/snapshot-queues.tsv"
  STUB_CURL_LOG="$work_dir/snapshot-curl.log"
  STUB_REAL_JQ="$(command -v jq)"
  STUB_JQ_ARGV_LOG="$work_dir/snapshot-jq-argv.log"
  K3S_DISK_CANONICAL_HOST_B64="$encoded_host"
  K3S_DISK_NODE_NAME_B64="$encoded_node"
  GITHUB_RUN_ID=600
  RECLAIM_CATEGORY=none
  RECLAIM_IMAGE_IDS='[]'
)
snapshot_case() {
  local name="$1" expected="$2" evidence="$3"
  shift 3
  local output="$work_dir/snapshot-$name.json"
  local log="$work_dir/snapshot-$name.log"
  if env "${snapshot_env[@]}" "$@" \
      WORK_DIR="$work_dir/snapshot-$name-work" OUTPUT_FILE="$output" \
      "$ORCHESTRATOR" diagnose >"$log" 2>&1; then
    [[ "$expected" == "pass" ]] || fail "snapshot accepted $name"
    jq -e "$evidence" "$work_dir/snapshot-$name-work/runtime-before.json" >/dev/null ||
      fail "snapshot aggregate differs for $name"
    "$HELPER" validate-diagnosis --diagnosis "$output" \
      --source-sha "$SOURCE_SHA" --infrastructure-run-id 400 \
      --ghcr-build-run-id 300 --workflow-run-id 600 >/dev/null
    jq -e --arg telemetry "$TELEMETRY_ID" '
      (.candidateImages | length) == 10 and
      (.protection.protectedImageIds | index($telemetry)) != null
    ' "$output" >/dev/null || fail "snapshot lost the forward Telemetry candidate: $name"
    if grep -Fq 'queue_baseline=UNHEALTHY' "$log"; then
      fail "healthy snapshot emitted queue diagnostics: $name"
    fi
  else
    if [[ "$expected" != "fail" ]]; then
      tail -n 12 "$log" >&2
      fail "snapshot rejected $name"
    fi
    if ! grep -Fq "$evidence" "$log"; then
      tail -n 12 "$log" >&2
      fail "snapshot failed for the wrong reason: $name"
    fi
    [[ ! -e "$output" ]] || fail "failed snapshot produced diagnosis authority: $name"
    if [[ "$evidence" == "queue baseline is unhealthy or malformed" ]]; then
      grep -Fq 'queue_baseline=UNHEALTHY' "$log" ||
        fail "unhealthy snapshot omitted queue diagnostics: $name"
      grep -Fq 'queue_root capacity_bytes=50000000000 used_bytes=37000000000 available_bytes=13000000000 used_percent=74' "$log" ||
        fail "unhealthy snapshot omitted existing root measurements: $name"
      jq -e '.queue.consumersHealthy == false' \
        "$work_dir/snapshot-$name-work/runtime-before.json" >/dev/null ||
        fail "queue diagnostics changed the unhealthy runtime JSON: $name"
    elif grep -Fq 'queue_baseline=UNHEALTHY' "$log"; then
      fail "malformed snapshot emitted consumer-health diagnostics: $name"
    fi
  fi
}
snapshot_diagnostic() {
  local name="$1" expected="$2"
  grep -Fq "$expected" "$work_dir/snapshot-$name.log" ||
    fail "snapshot diagnostic differs for $name: $expected"
}

python3 - "$ROOT_DIR" "$REMOTE" "$work_dir/snapshot-known-queues.tsv" <<'PY'
import re
import sys
from pathlib import Path

root = Path(sys.argv[1])
declared = set()
for service in ("auth", "backoffice", "bet", "event", "gamemaster", "moderation", "resulting", "slip"):
    for path in (root / service / "src").rglob("*Listener.ts"):
        declared.update(re.findall(r'serviceName:\s*string\s*=\s*"([^"]+)"', path.read_text()))
declared.update(re.findall(
    r'assertQueue\("([^"]+)"',
    (root / "telemetry/src/event/TelemetryConsumer.ts").read_text(),
))
allowed = set(re.findall(r'known\["([^"]+)"\]=1', Path(sys.argv[2]).read_text()))
if allowed != declared:
    raise SystemExit("queue diagnostic allowlist differs from static listener declarations")
Path(sys.argv[3]).write_text("".join(f"{name}\t0\t0\t0\n" for name in sorted(declared)))
PY

printf '\n%s\n%s\n\n%s\n' "$queue_header" "$active_queues" "$idle_telemetry" >"$work_dir/snapshot-queues.tsv"
snapshot_case header-and-absent-telemetry pass \
  '.queue == {queueCount:4,backlog:3,consumersHealthy:true} and
   .runtime.k3sVersion == "k3s version v1.34.5+k3s1 (fixture)"'
awk -F '\t' '$1 != "telemetry"' "$candidate_images" >"$work_dir/candidate-missing.tsv"
awk -F '\t' 'BEGIN {OFS="\t"} $1 == "telemetry" {$1="auth"} {print}' \
  "$candidate_images" >"$work_dir/candidate-duplicate.tsv"
awk -F '\t' 'BEGIN {OFS="\t"} $1 == "telemetry" {$1="unknown"} {print}' \
  "$candidate_images" >"$work_dir/candidate-unknown.tsv"
awk -F '\t' 'BEGIN {OFS="\t"} $1 == "telemetry" {$5="invalid"} {print}' \
  "$candidate_images" >"$work_dir/candidate-digest.tsv"
for candidate_case in missing duplicate unknown digest; do
  snapshot_case "candidate-$candidate_case" fail "candidate image evidence" \
    CANDIDATE_IMAGES_FILE="$work_dir/candidate-$candidate_case.tsv"
done
printf '%s\n' "$active_queues" >"$work_dir/snapshot-queues.tsv"
snapshot_case headerless pass '.queue == {queueCount:3,backlog:3,consumersHealthy:true}'
snapshot_case rabbitmq-command-failure fail "unable to read RabbitMQ aggregate baseline" STUB_QUEUE_FAILURE=1
snapshot_case k3s-version-multiline pass \
  '.runtime.k3sVersion == "k3s version v1.34.5+k3s1 (fixture)"' STUB_K3S_VERSION_MULTILINE=1
snapshot_case k3s-version-producer-failure fail \
  "read-only runtime snapshot failed" STUB_K3S_VERSION_FAILURE=1
snapshot_case k3s-version-malformed fail \
  "k3s runtime version is malformed" STUB_K3S_VERSION_MALFORMED=1

snapshot_malformed_count=0
for malformed in \
  "$queue_header"$'\n'"$queue_header" \
  'name messages_ready messages_unacknowledged consumers extra' \
  'event_new_event invalid 0 1' \
  'event_new_event -1 0 1' \
  'event_new_event 2 1 1' \
  'Listing queues for vhost / ...'; do
  printf '%s\n%s\n' "$active_queues" "$malformed" >"$work_dir/snapshot-queues.tsv"
  snapshot_malformed_count=$((snapshot_malformed_count + 1))
  snapshot_case "malformed-$snapshot_malformed_count" \
    fail "RabbitMQ queue baseline is malformed"
done
printf '%s\n' "$queue_header" >"$work_dir/snapshot-queues.tsv"
snapshot_case header-only fail "RabbitMQ queue baseline is empty"
printf '\n' >"$work_dir/snapshot-queues.tsv"
snapshot_case empty fail "RabbitMQ queue baseline is empty"
printf '%s\nevent_result\t0\t0\t0\n' "$active_queues" >"$work_dir/snapshot-queues.tsv"
snapshot_case application-consumer-missing fail "queue baseline is unhealthy or malformed"
snapshot_diagnostic application-consumer-missing \
  'queue_baseline=UNHEALTHY telemetry_deployment=absent queue_count=4 backlog=3'
snapshot_diagnostic application-consumer-missing \
  'queue_zero_consumers name=event_result messages_ready=0 messages_unacknowledged=0 consumers=0'
printf '%s\ntelemetry:events:v1\t2\t0\t0\n' "$active_queues" >"$work_dir/snapshot-queues.tsv"
snapshot_case absent-telemetry-backlog pass \
  '.queue == {queueCount:4,backlog:5,consumersHealthy:true}'
printf '%s\ntelemetry:events:v1\t0\t1\t0\n' "$active_queues" >"$work_dir/snapshot-queues.tsv"
snapshot_case absent-telemetry-unacknowledged fail "queue baseline is unhealthy or malformed"
snapshot_diagnostic absent-telemetry-unacknowledged \
  'queue_zero_consumers name=telemetry:events:v1 messages_ready=0 messages_unacknowledged=1 consumers=0'
printf '%s\n' "$idle_telemetry" >"$work_dir/snapshot-queues.tsv"
snapshot_case only-idle-telemetry fail "queue baseline is unhealthy or malformed"
snapshot_diagnostic only-idle-telemetry 'queue_consumers positive_queues=0'

printf '%s\ncustomer_private_token\t3\t1\t0\nevent_result_private\t5\t2\t0\nevent_live_update.private-pod-id\t7\t3\t0\n' \
  "$active_queues" >"$work_dir/snapshot-queues.tsv"
snapshot_case redacted-queue-names fail "queue baseline is unhealthy or malformed"
snapshot_diagnostic redacted-queue-names \
  'other_zero_consumer_queues=3 messages_ready=15 messages_unacknowledged=6 consumers=0'
if grep -Eq 'customer_private_token|event_result_private|private-pod-id' \
    "$work_dir/snapshot-redacted-queue-names.log"; then
  fail "snapshot diagnostic exposed an unknown queue name"
fi
{
  printf 'fixture_active_queue\t0\t0\t1\n'
  awk '{print $1 "\t1\t2\t0"}' "$work_dir/snapshot-known-queues.tsv"
  awk 'BEGIN {for (i=0; i<100; i++) print "fixture_private_queue_" i "\t1\t2\t0"}'
} >"$work_dir/snapshot-queues.tsv"
snapshot_case bounded-queue-details fail "queue baseline is unhealthy or malformed"
expected_details="$(awk 'END {print (NR < 24 ? NR : 24)}' "$work_dir/snapshot-known-queues.tsv")"
other_details="$(awk 'END {print 100 + (NR > 24 ? NR - 24 : 0)}' "$work_dir/snapshot-known-queues.tsv")"
[[ "$(grep -c '^queue_zero_consumers ' "$work_dir/snapshot-bounded-queue-details.log")" == "$expected_details" ]] ||
  fail "snapshot queue detail count is not bounded"
snapshot_diagnostic bounded-queue-details \
  "other_zero_consumer_queues=$other_details messages_ready=$other_details messages_unacknowledged=$((other_details * 2)) consumers=0"
if grep -Fq 'fixture_private_queue_' "$work_dir/snapshot-bounded-queue-details.log"; then
  fail "bounded snapshot diagnostic exposed an unknown queue name"
fi
{
  printf 'fixture_active_queue\t0\t0\t1\n'
  cat "$work_dir/snapshot-known-queues.tsv"
} >"$work_dir/snapshot-queues.tsv"
snapshot_case source-declared-queues fail "queue baseline is unhealthy or malformed"
while IFS=$'\t' read -r queue_name _; do
  snapshot_diagnostic source-declared-queues "queue_zero_consumers name=$queue_name "
done <"$work_dir/snapshot-known-queues.tsv"

jq '.items += [{kind:"Deployment",metadata:{namespace:"betstan-oci",name:"gaming-telemetry-depl"}}]' \
  "$work_dir/snapshot-workloads-base.json" >"$work_dir/snapshot-workloads.json"
printf '%s\n' "$active_queues" >"$work_dir/snapshot-queues.tsv"
snapshot_case deployed-telemetry-queue-missing fail "queue baseline is unhealthy or malformed"
snapshot_diagnostic deployed-telemetry-queue-missing 'telemetry_deployment=present'
snapshot_diagnostic deployed-telemetry-queue-missing 'queue_telemetry row=missing'
printf '%s\n%s\n%s\n' "$queue_header" "$active_queues" "$idle_telemetry" >"$work_dir/snapshot-queues.tsv"
snapshot_case deployed-telemetry-consumer-missing fail "queue baseline is unhealthy or malformed"
snapshot_diagnostic deployed-telemetry-consumer-missing 'telemetry_deployment=present'
snapshot_diagnostic deployed-telemetry-consumer-missing \
  'queue_zero_consumers name=telemetry:events:v1 messages_ready=0 messages_unacknowledged=0 consumers=0'
printf '%s\ntelemetry:events:v1\t2\t0\t0\n' "$active_queues" >"$work_dir/snapshot-queues.tsv"
snapshot_case deployed-telemetry-backlog-consumer-missing fail "queue baseline is unhealthy or malformed"
snapshot_diagnostic deployed-telemetry-backlog-consumer-missing \
  'queue_zero_consumers name=telemetry:events:v1 messages_ready=2 messages_unacknowledged=0 consumers=0'
printf '%s\ntelemetry:events:v1\t0\t0\t1\n' "$active_queues" >"$work_dir/snapshot-queues.tsv"
snapshot_case deployed-telemetry-healthy pass \
  '.queue == {queueCount:4,backlog:3,consumersHealthy:true}'
jq '.items += [{kind:"Deployment",metadata:{namespace:"other",name:"gaming-telemetry-depl"}}]' \
  "$work_dir/snapshot-workloads-base.json" >"$work_dir/snapshot-workloads.json"
printf '%s\n%s\n' "$active_queues" "$idle_telemetry" >"$work_dir/snapshot-queues.tsv"
snapshot_case other-namespace-telemetry pass '.queue.consumersHealthy == true'
for field in kind metadata.namespace metadata.name; do
  jq "del(.items[0].$field)" "$work_dir/snapshot-workloads-base.json" >"$work_dir/snapshot-workloads.json"
  snapshot_case "incomplete-workload-$field" fail "workload inventory is malformed"
done

python3 - "$work_dir" "$runtime" <<'PY'
import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
baseline = json.loads(Path(sys.argv[2]).read_text())
workloads = json.loads((root / "snapshot-workloads-base.json").read_text())
images = {"images": [
    {**{key: value for key, value in image.items() if key != "sizeBytes"},
     "size": str(image["sizeBytes"])}
    for image in baseline["images"]
]}
references = list(baseline["containerImageReferences"])
pods = {"items": [{
    "metadata": {"namespace": "betstan-oci", "name": "fixture-rabbitmq",
                 "labels": {"app": "gaming-rabbitmq"}},
    "spec": {"containers": [{"image": "rabbitmq:3-management"}]},
    "status": {"phase": "Running", "conditions": [{"type": "Ready", "status": "True"}]},
}]}
expected_refs = {"rabbitmq:3-management",
                 workloads["items"][0]["spec"]["template"]["spec"]["containers"][0]["image"]}
for index, position in enumerate(("beginning", "middle", "end")):
    image = baseline["images"][index * 4]
    references.append({"imageRef": image["id"], "requestedImage": f"example.invalid/{position}:cri",
                       "state": "CONTAINER_RUNNING"})
    spec, status = {}, {"phase": "Running", "conditions": [{"type": "Ready", "status": "True"}]}
    for field in ("initContainers", "containers", "ephemeralContainers"):
        reference = f"example.invalid/{position}:{field}"
        image_id = f"containerd://sha256:{1000 + len(expected_refs):064d}"
        spec[field] = [{"image": reference}]
        status[field.replace("Containers", "ContainerStatuses").replace("containers", "containerStatuses")] = [
            {"imageID": image_id, "restartCount": index}
        ]
        expected_refs.update((reference, image_id))
    pods["items"].append({"metadata": {"namespace": "fixture", "name": position},
                          "spec": spec, "status": status})
    workload_spec = {"initContainers": [{"image": f"example.invalid/{position}:job-init"}],
                     "containers": [{"image": f"example.invalid/{position}:job-main"}]}
    expected_refs.update(item["image"] for values in workload_spec.values() for item in values)
    workloads["items"].append({
        "kind": "CronJob", "metadata": {"namespace": "fixture", "name": position},
        "spec": {"jobTemplate": {"spec": {"template": {"spec": workload_spec}}}},
    })
containers = {"containers": [
    {"imageRef": row["imageRef"], "image": {"image": row["requestedImage"]}, "state": row["state"]}
    for row in references
]}
for name, payload in (("images", images), ("containers", containers), ("pods", pods), ("workloads", workloads)):
    payload["fixturePadding"] = f"snapshot-native-payload-{name}" + "x" * 140000
    serialized = json.dumps(payload)
    assert len(serialized.encode()) > 131072, name
    (root / f"snapshot-large-{name}.json").write_text(serialized + "\n")
(root / "snapshot-large-expected.json").write_text(json.dumps({
    "images": baseline["images"], "containerImageReferences": references,
    "kubernetesImageReferences": sorted(expected_refs),
    "workload": {"podCount": 4, "unhealthyPodCount": 0, "restartCount": 9},
}))
PY
large_snapshot_env=(
  STUB_SNAPSHOT_IMAGES="$work_dir/snapshot-large-images.json"
  STUB_SNAPSHOT_CONTAINERS="$work_dir/snapshot-large-containers.json"
  STUB_SNAPSHOT_PODS="$work_dir/snapshot-large-pods.json"
  STUB_WORKLOADS="$work_dir/snapshot-large-workloads.json"
)
printf '%s\n%s\n' "$active_queues" "$idle_telemetry" >"$work_dir/snapshot-queues.tsv"
snapshot_case large-native-inventories pass '.workload.podCount == 4' "${large_snapshot_env[@]}"
jq -e --slurpfile expected "$work_dir/snapshot-large-expected.json" '
  .images == $expected[0].images and
  .containerImageReferences == $expected[0].containerImageReferences and
  .kubernetesImageReferences == $expected[0].kubernetesImageReferences and
  .workload == $expected[0].workload
' "$work_dir/snapshot-large-native-inventories-work/runtime-before.json" >/dev/null ||
  fail "large snapshot lost or changed native references or health aggregates"
[[ ! -e "$work_dir/snapshot-jq-argv.log" ]] || fail "native snapshot JSON reached jq argv"
jq '.images = {}' "$work_dir/snapshot-large-images.json" >"$work_dir/snapshot-large-malformed.json"
snapshot_case large-malformed-inventory fail "CRI image inventory is malformed" \
  "${large_snapshot_env[@]}" STUB_SNAPSHOT_IMAGES="$work_dir/snapshot-large-malformed.json"
cp "$work_dir/snapshot-large-images.json" "$work_dir/native-large-extra-document.json"
printf '\n{"images":[]}\n' >>"$work_dir/native-large-extra-document.json"
snapshot_case large-extra-document fail "snapshot requires exactly 12 JSON values" \
  "${large_snapshot_env[@]}" STUB_SNAPSHOT_IMAGES="$work_dir/native-large-extra-document.json"

python3 - "$ROOT_DIR/.github/workflows/oci-infrastructure.yml" <<'PY'
import sys

text = open(sys.argv[1], encoding="utf-8").read()
required = (
    "group: oci-control-plane",
    "name: oci-infrastructure",
    "- diagnose-disk",
    "- reclaim-disk",
    "github.run_attempt == 1",
    'OCI_K3S_RETAIN_TARGET_SSH: "true"',
    "bind-infrastructure-prerequisites-stan.sh",
    "oci-k3s-disk-diagnosis-${{ github.run_id }}-${{ github.run_attempt }}",
    "configure-k3s-access.sh cleanup",
    '[ -z "$DISK_INFRASTRUCTURE_RUN_ID" ]',
    '[ "$DISK_RECLAIM_CATEGORY" = "none" ]',
    '[ "$DISK_RECLAIM_IMAGE_IDS" = "[]" ]',
)
for literal in required:
    if literal not in text:
        raise SystemExit(f"disk workflow contract is missing: {literal}")
if text.count("name: oci-infrastructure") < 2:
    raise SystemExit("disk recovery does not reuse the protected infrastructure environment")
validation = text.split(
    "      - name: Validate bounded k3s disk request", 1
)[1].split("\n      - name:", 1)[0]
if "${{ inputs." in validation:
    raise SystemExit("bounded disk validation interpolates workflow input into shell")
if "crictl rmi --prune" in text or "prune-registry-generation.sh" in text[
    text.index("\n  k3s-disk-recovery:"):
]:
    raise SystemExit("disk recovery job invokes a global or remote-registry prune")
PY
grep -Fq -- '-o StrictHostKeyChecking=yes' "$ORCHESTRATOR" ||
  fail "disk recovery SSH does not require the attested host key"
grep -Fq -- '-o UserKnownHostsFile="$target_known_hosts"' "$ORCHESTRATOR" ||
  fail "disk recovery SSH does not use the retained attested host-key file"

python3 - "$HELPER" "$work_dir" "$runtime" "$capacity" "$candidate_images" "$SOURCE_SHA" <<'PY'
import argparse
import copy
import importlib.util
import json
import sys
from pathlib import Path

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("disk", sys.argv[1])
disk = importlib.util.module_from_spec(spec)
spec.loader.exec_module(disk)
root = Path(sys.argv[2])
stamp = "2026-09-22T00:00:00.000Z"

def row(database, collection, count=12):
    return {
        "database": database, "collection": collection, "kind": "collection",
        "status": "MEASURED", "observedAt": stamp, "documentCount": count,
        "countUnit": "documents", "logicalBytes": 480,
        "allocatedDataBytes": 4096, "allocatedIndexBytes": 8192, "errorCode": None,
    }

raw = {
    "schemaVersion": "mongo-collection-storage-raw.v1",
    "expectedServerVersion": "8.2.12", "observedServerVersion": "8.2.12",
    "startedAt": stamp, "finishedAt": stamp, "limits": dict(disk.MONGO_LIMITS),
    "status": "COMPLETE", "discoveryComplete": True, "truncated": False, "errors": [],
    "databases": [{"name": name, "complete": True} for name in
                  ("gaming_event", "local", "private-customer-database")],
    "collections": [
        row("gaming_event", "events"), row("gaming_event", "private-token-collection", 0),
        row("local", "startup_log"), row("private-customer-database", "credential-value"),
    ],
}
raw_path = root / "mongo-storage.json"
def project(value):
    raw_path.write_text(json.dumps(value))
    return disk.read_mongo_storage(raw_path)

public = project(raw)
assert public["status"] == "COMPLETE"
assert [item["scope"] for item in public["collections"]] == [
    "application", "application", "system", "unattributed"
]
assert public["collections"][0]["collectionLabel"] == "events"
assert public["collections"][1]["documentCount"] == 0
assert public["totals"][0]["allocatedDataBytes"] == 8192
for private in ("private-token", "private-customer", "credential-value"):
    assert private not in disk.canonical(public)

for value in (-1, True, "12", None, 1.2, disk.MONGO_SAFE_INTEGER + 1):
    invalid = copy.deepcopy(raw)
    invalid["collections"][0]["documentCount"] = value
    assert project(invalid)["errors"] == ["MALFORMED_OUTPUT"]
large = copy.deepcopy(raw)
large["collections"][0]["documentCount"] = disk.MONGO_SAFE_INTEGER
assert project(large)["collections"][0]["documentCount"] == disk.MONGO_SAFE_INTEGER
for mutation in ("duplicate", "extra-field", "wrong-version", "false-complete"):
    invalid = copy.deepcopy(raw)
    if mutation == "duplicate":
        invalid["collections"].append(invalid["collections"][0])
    elif mutation == "extra-field":
        invalid["credentials"] = "mongodb://private-token@private-host"
    elif mutation == "wrong-version":
        invalid["observedServerVersion"] = "private-runtime"
    else:
        invalid["discoveryComplete"] = False
    assert project(invalid)["errors"] == ["MALFORMED_OUTPUT"], mutation
partial = copy.deepcopy(raw)
partial.update(status="PARTIAL", errors=["NAMESPACE_MISSING"])
partial["collections"][0].update({
    "status": "UNAVAILABLE", "errorCode": "NAMESPACE_MISSING",
    "observedAt": None, "countUnit": None, **{key: None for key in disk.MONGO_METRICS},
})
assert project(partial)["status"] == "PARTIAL"
assert project(partial)["collections"][0]["documentCount"] is None
raw_path.write_bytes(b"x" * (disk.MONGO_LIMITS["outputBytes"] + 1))
assert disk.read_mongo_storage(raw_path)["errors"] == ["OUTPUT_LIMIT"]
assert disk.read_mongo_storage(raw_path, "TRANSPORT_FAILED")["errors"] == ["OUTPUT_LIMIT"]
raw_path.write_text("invalid mongodb://private-token@private-host")
assert disk.read_mongo_storage(raw_path)["errors"] == ["MALFORMED_OUTPUT"]
assert disk.read_mongo_storage(raw_path, "TRANSPORT_FAILED")["errors"] == ["TRANSPORT_FAILED"]
raw_path.write_text("[" * 1100 + "0" + "]" * 1100)
assert disk.read_mongo_storage(raw_path)["errors"] == ["MALFORMED_OUTPUT"]

timeseries = copy.deepcopy(raw)
timeseries.update(status="PARTIAL", errors=["TIMESERIES_LOGICAL_UNAVAILABLE"])
logical = row("gaming_event", "metrics")
logical.update(kind="timeseries", status="UNAVAILABLE", observedAt=None, countUnit=None,
               errorCode="TIMESERIES_LOGICAL_UNAVAILABLE",
               **{key: None for key in disk.MONGO_METRICS})
bucket = row("gaming_event", "system.buckets.metrics", 2)
bucket.update(kind="timeseries-buckets", countUnit="buckets")
view = copy.deepcopy(logical)
view.update(collection="metric_view", kind="view", status="NON_STORAGE", errorCode=None)
timeseries["collections"].extend([logical, bucket, view])
ts_public = project(timeseries)
assert ts_public["totals"][0]["allocatedDataBytes"] == 12288
assert ts_public["collections"][-2]["scope"] == "application"
assert ts_public["collections"][-2]["countUnit"] == "buckets"
assert ts_public["collections"][-1]["documentCount"] is None

project(raw)
args = argparse.Namespace(
    runtime=sys.argv[3], capacity=sys.argv[4], candidate_images=sys.argv[5],
    source_sha=sys.argv[6], infrastructure_run_id="400", ghcr_build_run_id="300",
    workflow_run_id="500", output=str(root / "mongo-diagnosis.json"),
    mongo_storage=str(raw_path), mongo_storage_failure="",
)
disk.build_diagnosis(args)
v2 = json.loads(Path(args.output).read_text())
legacy = json.loads((root / "diagnosis.json").read_text())
disk.validate_diagnosis(legacy)
disk.validate_diagnosis(v2)
assert v2["schemaVersion"] == "k3s-node-disk-diagnosis.v2"
assert v2["securityStateSha256"] == legacy["securityStateSha256"]
raw_path.write_text("[" * 1100 + "0" + "]" * 1100)
disk.build_diagnosis(args)
malformed = json.loads(Path(args.output).read_text())
disk.validate_diagnosis(malformed)
assert malformed["mongoStorage"]["errors"] == ["MALFORMED_OUTPUT"]
assert malformed["mongoStorage"]["status"] == "UNAVAILABLE"
assert malformed["securityStateSha256"] == legacy["securityStateSha256"]
assert malformed["terminalStatus"] == "DIAGNOSED"
project(raw)
assert "fixture-k3s" not in disk.canonical(v2)
assert v2["runtime"]["runtime"]["nodeNameSha256"] == v2["kubeletCapacity"]["nodeNameSha256"]
live = json.loads(Path(sys.argv[3]).read_text())
capacity = json.loads(Path(sys.argv[4]).read_text())
assert disk.validate_fresh_against_diagnosis(v2, live, capacity) == disk.classify(
    live, v2["candidateImages"]
)
changed = copy.deepcopy(raw)
changed["collections"][0]["logicalBytes"] += 999
project(changed)
disk.build_diagnosis(args)
new = json.loads(Path(args.output).read_text())
assert new["securityStateSha256"] == v2["securityStateSha256"]
assert new["contentChecksumSha256"] != v2["contentChecksumSha256"]
drifted = copy.deepcopy(live)
drifted["runtime"]["nodeName"] = "different-node"
drifted_capacity = {**capacity, "nodeName": "different-node"}
try:
    disk.validate_fresh_against_diagnosis(v2, drifted, drifted_capacity)
except SystemExit:
    pass
else:
    raise AssertionError("v2 allowed node identity drift")
tampered = copy.deepcopy(v2)
tampered["mongoStorage"]["collections"][0]["logicalBytes"] += 1
try:
    disk.validate_diagnosis(tampered)
except SystemExit:
    pass
else:
    raise AssertionError("Mongo storage was not covered by diagnosis checksum")
project(raw)
print("mongo_storage_projection_tests=PASS")
PY

python3 - "$HELPER" "$work_dir" "$runtime" "$capacity" "$candidate_images" "$SOURCE_SHA" <<'PY'
import argparse
import copy
import hashlib
import importlib.util
import json
import sys
from pathlib import Path

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("disk", sys.argv[1])
disk = importlib.util.module_from_spec(spec)
spec.loader.exec_module(disk)
root = Path(sys.argv[2])
source, control = sys.argv[6], "3" * 40
candidates = disk.parse_candidate_images(sys.argv[5])
cloud = {
    "instanceId": "ocid1.instance.oc1..test",
    "instanceFingerprint": hashlib.sha256(b"ocid1.instance.oc1..test").hexdigest(),
    "volumeId": "ocid1.volume.oc1..test",
    "attachmentId": "ocid1.volumeattachment.oc1..test",
    "device": "/dev/oracleoci/oraclevdb", "volumeSizeBytes": 50 * 1073741824,
}
node = {
    "schemaVersion": "k3s-baseline-node.v1", "expectedNode": "fixture-k3s",
    "requestedDevice": cloud["device"], "resolvedDevice": "/dev/sdb",
    "mountedDevice": "/dev/sdb", "rootDeviceNumber": "8:1",
    "mongoMount": {"target": "/var/lib/betstan/mongo", "fstype": "ext4"},
    "blockDevice": {"path": "/dev/sdb", "type": "disk",
                    "size": cloud["volumeSizeBytes"], "deviceNumber": "8:16"},
    "nodes": [{"name": "fixture-k3s", "uid": "fixture-node", "ready": True}],
    "claim": {"name": "gaming-auth-mongo-data", "uid": "fixture-claim",
              "phase": "Bound", "volumeName": "gaming-auth-mongo-data"},
    "volume": {"name": "gaming-auth-mongo-data", "phase": "Bound",
               "localPath": "/var/lib/betstan/mongo",
               "claim": {"name": "gaming-auth-mongo-data", "namespace": "betstan-oci",
                         "uid": "fixture-claim"}},
    "deployments": [], "pods": [],
}
for candidate in candidates:
    app = "gaming-" + candidate["service"]
    node["deployments"].append({
        "name": app + "-depl", "uid": "deployment-" + app, "deleting": False,
        "generation": 1, "observedGeneration": 1, "replicas": 1, "readyReplicas": 1,
        "availableReplicas": 1, "updatedReplicas": 1,
        "containers": [{"name": app, "image": candidate["imageRef"]}],
    })
    node["pods"].append({
        "uid": "pod-" + app, "app": app, "nodeName": "fixture-k3s",
        "deleting": False, "phase": "Running", "ready": True,
        "containers": [{"name": app, "image": candidate["imageRef"]}],
        "statuses": [{"name": app, "ready": True,
                      "imageID": disk.REPOSITORY + "@" + candidate["platformDigest"]}],
    })
node["pods"].append({
    "uid": "fixture-mongo", "app": "gaming-auth-mongo", "nodeName": "fixture-k3s",
    "deleting": False, "phase": "Running", "ready": True,
    "containers": [{
        "name": "gaming-auth-mongo", "image": "mongo:8.2.12", "defaultCommand": True,
        "mounts": [{"name": "mongo-data", "mountPath": "/data/db", "readOnly": False,
                    "subPath": "", "subPathExpr": ""}],
    }],
    "volumes": [{"name": "mongo-data", "claimName": "gaming-auth-mongo-data"}],
    "statuses": [{"name": "gaming-auth-mongo", "ready": True, "imageID": "fixture"}],
})
cloud_path, node_path = root / "baseline-cloud.json", root / "baseline-node.json"
proof_path = root / "baseline-proof.json"
args = argparse.Namespace(
    cloud=str(cloud_path), node=str(node_path), candidate_images=sys.argv[5],
    expected_node="fixture-k3s", source_sha=source, control_sha=control,
    workflow_run_id="500", output=str(proof_path),
)
def capture(cloud_value=cloud, node_value=node):
    cloud_path.write_text(json.dumps(cloud_value))
    node_path.write_text(json.dumps(node_value))
    proof_path.unlink(missing_ok=True)
    disk.build_baseline_proof(args)
    return json.loads(proof_path.read_text())

before = capture()
for private in ("ocid1.", "fixture-k3s", "/dev/", "fixture-claim"):
    assert private not in disk.canonical(before)
mutations = {
    "wrong-instance": lambda c, n: c.update(instanceFingerprint="0" * 64),
    "wrong-device": lambda c, n: c.update(device="/dev/oracleoci/other"),
    "wrong-capacity": lambda c, n: c.update(volumeSizeBytes=1),
    "wrong-mounted-device": lambda c, n: n.update(mountedDevice="/dev/sdc"),
    "mongo-on-root": lambda c, n: n.update(rootDeviceNumber="8:16"),
    "ambiguous-node": lambda c, n: n["nodes"].append(n["nodes"][0]),
    "missing-app": lambda c, n: n["deployments"].pop(),
    "duplicate-app": lambda c, n: n["deployments"].append(n["deployments"][0]),
    "extra-app": lambda c, n: n["deployments"].append(
        {**n["deployments"][0], "name": "gaming-unexpected-depl"}),
    "wrong-template-image": lambda c, n: n["deployments"][0]["containers"][0].update(image="wrong"),
    "wrong-running-image": lambda c, n: n["pods"][0]["statuses"][0].update(imageID="wrong"),
    "unhealthy-app": lambda c, n: n["pods"][0].update(ready=False),
    "terminating-app": lambda c, n: n["pods"][0].update(deleting=True),
    "terminating-mongo": lambda c, n: n["pods"][-1].update(deleting=True),
    "wrong-claim": lambda c, n: n["claim"].update(volumeName="wrong"),
    "wrong-volume-path": lambda c, n: n["volume"].update(localPath="/different"),
    "claim-rebound": lambda c, n: n["volume"]["claim"].update(uid="different"),
    "custom-mongo-command": lambda c, n: n["pods"][-1]["containers"][0].update(defaultCommand=False),
    "wrong-mongo-claim": lambda c, n: n["pods"][-1]["volumes"][0].update(claimName="different"),
    "ambiguous-mongo": lambda c, n: n["pods"].append(n["pods"][-1]),
}
for label, mutate in mutations.items():
    changed_cloud, changed_node = copy.deepcopy(cloud), copy.deepcopy(node)
    mutate(changed_cloud, changed_node)
    try:
        capture(changed_cloud, changed_node)
    except SystemExit:
        assert not proof_path.exists(), label
    else:
        raise AssertionError("accepted invalid baseline: " + label)
before = capture()
before_path, after_path = root / "baseline-before.json", root / "baseline-after.json"
before_path.write_text(disk.canonical(before))
after_path.write_text(disk.canonical(capture()))
observation_path = root / "historical-observation.json"
observation_args = argparse.Namespace(
    runtime=sys.argv[3], capacity=sys.argv[4], candidate_images=sys.argv[5],
    source_sha=source, infrastructure_run_id="400", ghcr_build_run_id="300",
    workflow_run_id="500", output=str(observation_path),
    mongo_storage=str(root / "mongo-storage.json"), mongo_storage_failure="",
    control_sha=control, baseline_before=str(before_path), baseline_after=str(after_path),
)
disk.build_diagnosis(observation_args)
observation = json.loads(observation_path.read_text())
disk.validate_diagnosis(observation, observation=True)
assert observation["terminalStatus"] == "OBSERVED"
assert observation["sourceSha"] == source and observation["controlSha"] == control
for forged_equal in (False, True):
    rejected = copy.deepcopy(observation)
    if forged_equal:
        rejected["controlSha"] = rejected["sourceSha"]
        rejected.pop("contentChecksumSha256")
        rejected = disk.add_checksum(rejected)
    observation_path.write_text(disk.canonical(rejected))
    for handler in (disk.plan_reclaim, disk.finalize_reclaim, disk.write_incomplete_reclaim):
        try:
            handler(argparse.Namespace(diagnosis=str(observation_path)))
        except SystemExit as error:
            assert "diagnosis manifest" in str(error)
        else:
            raise AssertionError("observation reached reclaim handling")
after = json.loads(after_path.read_text())
after["identitySha256"] = "0" * 64
after_path.write_text(disk.canonical(after))
observation_path.unlink()
try:
    disk.build_diagnosis(observation_args)
except SystemExit as error:
    assert "baseline proof" in str(error)
    assert not observation_path.exists()
else:
    raise AssertionError("baseline drift produced observation evidence")
capture()
after_path.write_text(disk.canonical(before))
disk.build_diagnosis(observation_args)
api = {
    "instance": {
        "id": cloud["instanceId"], "compartment-id": "ocid1.compartment.oc1..test",
        "availability-domain": "fixture-ad", "lifecycle-state": "RUNNING",
        "shape": "VM.Standard.A1.Flex", "shape-config": {"ocpus": 2, "memory-in-gbs": 12},
        "freeform-tags": {"betstan-runtime": "k3s"},
    },
    "volume": {
        "id": cloud["volumeId"], "compartment-id": "ocid1.compartment.oc1..test",
        "availability-domain": "fixture-ad", "lifecycle-state": "AVAILABLE",
        "size-in-gbs": 50,
    },
    "attachment": {
        "id": cloud["attachmentId"], "instance-id": cloud["instanceId"],
        "volume-id": cloud["volumeId"], "lifecycle-state": "ATTACHED",
        "attachment-type": "paravirtualized", "is-read-only": False,
        "is-shareable": False, "device": cloud["device"],
    },
}
for name, value in api.items():
    (root / ("baseline-api-" + name + ".json")).write_text(json.dumps({"data": value}))
drifted = copy.deepcopy(node)
drifted["nodes"][0]["uid"] = "replacement-node"
(root / "baseline-node-drifted.json").write_text(json.dumps(drifted))
terminating = copy.deepcopy(node)
wrong_generation = copy.deepcopy(terminating["pods"][0])
wrong_generation.update(uid="terminating-wrong-generation", deleting=True)
wrong_generation["containers"][0]["image"] = "wrong-generation"
wrong_generation["statuses"][0]["imageID"] = "wrong-generation"
terminating["pods"].append(wrong_generation)
(root / "baseline-node-terminating.json").write_text(json.dumps(terminating))
print("historical_baseline_observation_tests=PASS")
PY

python3 - "$work_dir" <<'PY'
import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
node = json.loads((root / "baseline-node.json").read_text())
def write(name, value):
    (root / ("native-baseline-" + name + ".json")).write_text(json.dumps(value))

write("nodes", {"items": [{
    "metadata": {"name": n["name"], "uid": n["uid"]},
    "status": {"conditions": [{"type": "Ready", "status": "True"}]},
} for n in node["nodes"]]})
write("deployments", {"items": [{
    "metadata": {key: d[key] for key in ("name", "uid", "generation")},
    "spec": {"replicas": d["replicas"], "template": {
        "spec": {"containers": d["containers"]}}},
    "status": {key: d[key] for key in (
        "observedGeneration", "readyReplicas", "availableReplicas", "updatedReplicas")},
} for d in node["deployments"]]})
pods = []
for p in node["pods"]:
    containers = [{
        "name": c["name"], "image": c["image"],
        "env": [{"name": "PRIVATE_VALUE", "value": "fixture-private-secret"}],
        "volumeMounts": c.get("mounts", []),
    } for c in p["containers"]]
    pods.append({
        "metadata": {"uid": p["uid"], "labels": {"app": p["app"]}},
        "spec": {"nodeName": p["nodeName"], "containers": containers, "volumes": [
            {"name": v["name"], "persistentVolumeClaim": {"claimName": v["claimName"]}}
            for v in p.get("volumes", [])]},
        "status": {"phase": p["phase"], "containerStatuses": p["statuses"],
                   "conditions": [{"type": "Ready", "status": "True"}]},
    })
write("pods", {"items": pods})
write("pvc", {"metadata": {"name": node["claim"]["name"], "uid": node["claim"]["uid"]},
              "status": {"phase": "Bound"},
              "spec": {"volumeName": node["claim"]["volumeName"]}})
write("pv", {"metadata": {"name": node["volume"]["name"]}, "status": {"phase": "Bound"},
             "spec": {"local": {"path": node["volume"]["localPath"]},
                      "claimRef": node["volume"]["claim"]}})
write("mount", {"filesystems": [{
    **node["mongoMount"], "source": "/dev/sdb", "size": 50 * 1073741824,
    "used": 1073741824, "avail": 49 * 1073741824,
}]})
write("block", {"blockdevices": [{
    "path": "/dev/sdb", "type": "disk", "size": 50 * 1073741824, "maj:min": "8:16",
}]})
PY
baseline_bin="$work_dir/baseline-bin"
mkdir -p "$baseline_bin"
cat >"$baseline_bin/metadata" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
case "$(basename "$0"):$*" in
  "readlink:-e -- /dev/oracleoci/oraclevdb") printf '/dev/sdb\n' ;;
  "readlink:-e -- /dev/sdb") printf '%s\n' "${STUB_BASELINE_MOUNT_DEVICE:-/dev/sdb}" ;;
  "findmnt:--json --bytes --output TARGET,SOURCE,FSTYPE,SIZE,USED,AVAIL --target /var/lib/betstan/mongo")
    cat "${STUB_BASELINE_MOUNT:-$STUB_BASELINE_DIR/native-baseline-mount.json}" ;;
  "findmnt:--noheadings --output MAJ:MIN --target /")
    printf '  %s\n' "${STUB_BASELINE_ROOT_NUMBER:-8:1}" ;;
  "lsblk:--json --bytes --output PATH,TYPE,SIZE,MAJ:MIN /dev/sdb")
    cat "${STUB_BASELINE_BLOCK:-$STUB_BASELINE_DIR/native-baseline-block.json}" ;;
  "k3s:kubectl --request-timeout=10s get nodes -o json")
    cat "$STUB_BASELINE_DIR/native-baseline-nodes.json" ;;
  "k3s:kubectl --request-timeout=10s get deployments -n betstan-oci -o json")
    cat "$STUB_BASELINE_DIR/native-baseline-deployments.json" ;;
  "k3s:kubectl --request-timeout=10s get pods -n betstan-oci -o json")
    cat "$STUB_BASELINE_DIR/native-baseline-pods.json" ;;
  "k3s:kubectl --request-timeout=10s get pvc gaming-auth-mongo-data -n betstan-oci -o json")
    cat "$STUB_BASELINE_DIR/native-baseline-pvc.json" ;;
  "k3s:kubectl --request-timeout=10s get pv gaming-auth-mongo-data -o json")
    cat "$STUB_BASELINE_DIR/native-baseline-pv.json" ;;
  *) echo "unexpected native baseline operation" >&2; exit 1 ;;
esac
SH
chmod +x "$baseline_bin/metadata"
for command_name in readlink findmnt lsblk k3s; do
  ln -s metadata "$baseline_bin/$command_name"
done
baseline_env=(
  PATH="$baseline_bin:$PATH" STUB_BASELINE_DIR="$work_dir"
  K3S_DISK_CANONICAL_HOST_B64="$(printf 'fixture.example.test' | base64)"
  K3S_DISK_NODE_NAME_B64="$(printf 'fixture-k3s' | base64)"
  K3S_DISK_MONGO_DEVICE_B64="$(printf '/dev/oracleoci/oraclevdb' | base64)"
)
env "${baseline_env[@]}" "$REMOTE" baseline-proof >"$work_dir/native-baseline.json"
if grep -Fq 'fixture-private-secret' "$work_dir/native-baseline.json"; then
  fail "native baseline exposed container environment values"
fi
"$HELPER" validate-baseline --cloud "$work_dir/baseline-cloud.json" \
  --node "$work_dir/native-baseline.json" --candidate-images "$candidate_images" \
  --expected-node fixture-k3s --source-sha "$SOURCE_SHA" \
  --control-sha "$RECLAIM_SOURCE_SHA" --workflow-run-id 500 \
  --output "$work_dir/native-baseline-proof.json"
for invalid_native in wrong-device ambiguous-mount partitioned-disk; do
  case "$invalid_native" in
    wrong-device)
      invalid_native_env=STUB_BASELINE_MOUNT_DEVICE=/dev/sdc ;;
    ambiguous-mount)
      jq '.filesystems += .filesystems' "$work_dir/native-baseline-mount.json" \
        >"$work_dir/native-baseline-invalid.json"
      invalid_native_env="STUB_BASELINE_MOUNT=$work_dir/native-baseline-invalid.json" ;;
    partitioned-disk)
      jq '.blockdevices[0].children = [{"path":"/dev/sdb1"}]' \
        "$work_dir/native-baseline-block.json" >"$work_dir/native-baseline-invalid.json"
      invalid_native_env="STUB_BASELINE_BLOCK=$work_dir/native-baseline-invalid.json" ;;
  esac
  if env "${baseline_env[@]}" "$invalid_native_env" "$REMOTE" baseline-proof \
    >"$work_dir/native-baseline-error" 2>&1; then
    fail "native baseline accepted $invalid_native"
  fi
done
if env "${baseline_env[@]}" "$REMOTE" baseline-proof arbitrary-argument \
  >"$work_dir/native-baseline-error" 2>&1; then
  fail "native baseline accepted arbitrary arguments"
fi
env "${baseline_env[@]}" STUB_BASELINE_ROOT_NUMBER=8:16 "$REMOTE" baseline-proof \
  >"$work_dir/native-baseline-on-root.json"
if "$HELPER" validate-baseline --cloud "$work_dir/baseline-cloud.json" \
  --node "$work_dir/native-baseline-on-root.json" --candidate-images "$candidate_images" \
  --expected-node fixture-k3s --source-sha "$SOURCE_SHA" \
  --control-sha "$RECLAIM_SOURCE_SHA" --workflow-run-id 500 \
  --output "$work_dir/native-baseline-invalid-proof.json" >"$work_dir/native-baseline-error" 2>&1; then
  fail "native baseline authorized Mongo on root"
fi

mongo_bin="$work_dir/mongo-bin"
mkdir -p "$mongo_bin"
cat >"$mongo_bin/timeout" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == "--signal=KILL" && "$2" == "35s" ]]
shift 2
exec "$@"
SH
cat >"$mongo_bin/k3s" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  "kubectl --request-timeout=5s get pods -n betstan-oci -l app=gaming-auth-mongo -o json")
    cat "$STUB_MONGO_PODS"
    ;;
  "kubectl --request-timeout=35s exec -i -n betstan-oci fixture-mongo -- mongosh --norc --quiet mongodb://127.0.0.1:27017/admin?serverSelectionTimeoutMS=2000&connectTimeoutMS=2000&socketTimeoutMS=2000 --file /dev/stdin")
    cat >"$STUB_MONGO_PROGRAM"
    cat "$STUB_MONGO_STORAGE"
    ;;
  *)
    exit 1
    ;;
esac
SH
chmod +x "$mongo_bin/timeout" "$mongo_bin/k3s"
cat >"$work_dir/mongo-pods.json" <<'JSON'
{"items":[{"metadata":{"name":"fixture-mongo"},"status":{"phase":"Running","conditions":[{"type":"Ready","status":"True"}]}}]}
JSON
mongo_env=(
  PATH="$mongo_bin:$PATH"
  STUB_MONGO_PODS="$work_dir/mongo-pods.json"
  STUB_MONGO_STORAGE="$work_dir/mongo-storage.json"
  STUB_MONGO_PROGRAM="$work_dir/mongo-program.js"
)
env "${mongo_env[@]}" "$REMOTE" mongo-storage >"$work_dir/mongo-remote.json"
cmp "$work_dir/mongo-storage.json" "$work_dir/mongo-remote.json"
grep -Fq 'authorizedDatabases: false' "$work_dir/mongo-program.js"
if env "${mongo_env[@]}" "$REMOTE" mongo-storage 'arbitrary-query' >"$work_dir/mongo-error" 2>&1; then
  fail "Mongo collector accepted an arbitrary argument"
fi
for invalid_pods in '{"items":[]}' \
  '{"items":[{"metadata":{"name":"fixture-mongo"},"status":{"phase":"Running","conditions":[]}}]}' \
  '{"items":[{"metadata":{"name":"first"},"status":{"phase":"Running","conditions":[{"type":"Ready","status":"True"}]}},{"metadata":{"name":"second"},"status":{"phase":"Running","conditions":[{"type":"Ready","status":"True"}]}}]}'; do
  printf '%s\n' "$invalid_pods" >"$work_dir/mongo-pods.json"
  if env "${mongo_env[@]}" "$REMOTE" mongo-storage >"$work_dir/mongo-error" 2>&1; then
    fail "Mongo collector accepted a missing, unready, or ambiguous pod"
  fi
  grep -Fq 'ready Mongo pod is missing or ambiguous' "$work_dir/mongo-error"
done

node - "$REMOTE" <<'JS'
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(process.argv[2], "utf8");
const program = source.split("<<'MONGO_STORAGE_JS'\n")[1].split("\nMONGO_STORAGE_JS")[0];
assert.ok(source.includes("socketTimeoutMS=2000"));
assert.ok(source.includes("timeout --signal=KILL 35s"));

async function collect(options = {}) {
  let now = 0;
  class Clock extends Date {
    constructor(value) { super(value === undefined ? now : value); }
    static now() { return now; }
  }
  const names = options.databases || ["gaming_event"];
  const entries = options.entries || Array.from({ length: 40 }, (_, i) => ({
    name: "collection_" + i, type: "collection"
  }));
  let remaining = [], nextCursor = 1, output;
  const commands = [];
  const context = {
    Date: Clock, Buffer,
    print(value) { assert.equal(output, undefined); output = value; },
    db: { getSiblingDB(name) { return { async runCommand(command) {
      const kind = Object.keys(command)[0];
      commands.push(kind);
      assert.ok(["buildInfo", "listDatabases", "listCollections", "getMore",
        "killCursors", "collStats"].includes(kind));
      if (kind === "getMore") assert.equal(command.maxTimeMS, undefined);
      else assert.ok(command.maxTimeMS > 0 && command.maxTimeMS <= 2000);
      if (kind === "buildInfo") return { ok: 1, version: options.version || "8.2.12" };
      if (kind === "listDatabases") {
        assert.equal(command.authorizedDatabases, false);
        if (options.unauthorized) return {
          ok: 0, code: 13, errmsg: "mongodb://private-token@private-host"
        };
        return { ok: 1, databases: names.map(name => ({ name })) };
      }
      if (kind === "listCollections") {
        assert.equal(command.nameOnly, true);
        if (command.filter) {
          return { ok: 1, cursor: { id: 0, firstBatch: options.missing ? [] :
            entries.filter(item => item.name === command.filter.name) } };
        }
        assert.equal(command.authorizedCollections, false);
        assert.equal(command.cursor.batchSize, 32);
        remaining = entries.slice(32);
        return { ok: 1, cursor: { id: remaining.length ? nextCursor : 0,
          firstBatch: entries.slice(0, 32) } };
      }
      if (kind === "getMore") {
        assert.equal(command.collection, "$cmd.listCollections");
        const batch = remaining.splice(0, 32);
        return { ok: 1, cursor: { id: remaining.length ? nextCursor : 0, nextBatch: batch } };
      }
      if (kind === "killCursors") return { ok: 1 };
      assert.equal(command.scale, 1);
      if (options.deadline) now += 30001;
      const count = Object.hasOwn(options, "count") ? options.count : 12;
      const bucket = command.collStats.startsWith("system.buckets.");
      return { ok: 1, ns: name + "." + command.collStats,
        count: bucket ? undefined : count, timeseries: bucket ? { bucketCount: count } : undefined,
        size: 480, storageSize: 4096, totalIndexSize: 8192 };
    } }; } }
  };
  await vm.runInNewContext(program, context);
  assert.ok(output);
  assert.ok(Buffer.byteLength(output) <= 262144);
  return { value: JSON.parse(output), commands, output };
}
(async () => {
  let { value, commands } = await collect();
  assert.equal(value.status, "COMPLETE");
  assert.equal(value.collections.length, 40);
  assert.ok(commands.includes("getMore"));
  assert.equal(value.collections[0].allocatedIndexBytes, 8192);
  value = (await collect({ count: 0 })).value;
  assert.equal(value.collections[0].documentCount, 0);
  value = (await collect({ count: Number.MAX_SAFE_INTEGER })).value;
  assert.equal(value.status, "COMPLETE");
  for (const count of [-1, NaN, Infinity, true, null, "12", Number.MAX_SAFE_INTEGER + 1]) {
    value = (await collect({ count })).value;
    assert.equal(value.status, "PARTIAL");
    assert.ok(value.errors.includes("INVALID_STATISTICS"));
    assert.equal(value.collections[0].documentCount, null);
  }
  const denied = await collect({ unauthorized: true });
  assert.equal(denied.value.status, "UNAVAILABLE");
  assert.deepEqual(denied.value.errors, ["UNAUTHORIZED"]);
  assert.ok(!denied.output.includes("private-token"));
  value = (await collect({ version: "9.0.0" })).value;
  assert.deepEqual(value.errors, ["VERSION_MISMATCH"]);
  value = (await collect({ missing: true })).value;
  assert.ok(value.errors.includes("NAMESPACE_MISSING"));
  value = (await collect({ deadline: true })).value;
  assert.equal(value.status, "PARTIAL");
  assert.ok(value.truncated && value.errors.includes("TIME_LIMIT"));
  value = (await collect({ entries: [], databases: Array.from({ length: 33 }, (_, i) => "db" + i) })).value;
  assert.equal(value.databases.length, 32);
  assert.ok(value.truncated && value.errors.includes("DATABASE_LIMIT"));
  value = (await collect({ entries: Array.from({ length: 260 }, (_, i) => ({
    name: "c" + i, type: "collection"
  })) })).value;
  assert.equal(value.collections.length, 256);
  assert.ok(value.truncated && value.errors.includes("COLLECTION_LIMIT"));
  value = (await collect({ entries: Array.from({ length: 256 }, (_, i) => ({
    name: "x".repeat(1024) + i, type: "collection"
  })) })).value;
  assert.equal(value.status, "UNAVAILABLE");
  assert.deepEqual(value.collections, []);
  assert.ok(value.truncated && value.errors.includes("OUTPUT_LIMIT"));
  value = (await collect({ entries: [
    { name: "events", type: "collection" }, { name: "event_view", type: "view" },
    { name: "metrics", type: "timeseries" }, { name: "system.buckets.metrics", type: "collection" }
  ] })).value;
  assert.equal(value.collections[1].status, "NON_STORAGE");
  assert.equal(value.collections[1].documentCount, null);
  assert.equal(value.collections[2].errorCode, "TIMESERIES_LOGICAL_UNAVAILABLE");
  assert.equal(value.collections[3].countUnit, "buckets");
  console.log("mongo_storage_fixed_program_tests=PASS");
})().catch(error => { console.error(error); process.exitCode = 1; });
JS

cp "$runtime" "$work_dir/current-runtime.json"
cp "$work_dir/summary-before.json" "$work_dir/current-summary.json"
env "${common_env[@]}" \
  STUB_MONGO_STORAGE="$work_dir/mongo-storage.json" \
  GITHUB_RUN_ID=500 RECLAIM_CATEGORY=none RECLAIM_IMAGE_IDS='[]' \
  OUTPUT_FILE="$work_dir/mongo-orchestrated-diagnosis.json" \
  "$ORCHESTRATOR" diagnose >/dev/null
jq -e '
  .schemaVersion == "k3s-node-disk-diagnosis.v2" and
  .mongoStorage.status == "COMPLETE" and
  .mongoStorage.collections[0].collectionLabel == "events" and
  .runtime.runtime.nodeName == "k3s-node"
' "$work_dir/mongo-orchestrated-diagnosis.json" >/dev/null ||
  fail "governed diagnosis omitted complete Mongo evidence"
jq -e '.mongoStorage.status == "UNAVAILABLE" and
  .mongoStorage.errors == ["TRANSPORT_FAILED"]' \
  "$work_dir/orchestrated-diagnosis.json" >/dev/null ||
  fail "Mongo failure did not preserve explicit incomplete disk evidence"

cat >"$stub_bin/oci" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$STUB_CLOUD_LOG"
case "$*" in
  "compute instance get --instance-id ocid1.instance.oc1..test --connection-timeout 5 --read-timeout 10 --max-retries 0")
    kind=instance
    ;;
  "bv volume get --volume-id ocid1.volume.oc1..test --connection-timeout 5 --read-timeout 10 --max-retries 0")
    kind=volume
    ;;
  "compute volume-attachment get --volume-attachment-id ocid1.volumeattachment.oc1..test --connection-timeout 5 --read-timeout 10 --max-retries 0")
    kind=attachment
    ;;
  *)
    echo "unexpected cloud mutation or unbounded read" >&2
    exit 1
    ;;
esac
case "${STUB_CLOUD_FAILURE:-}" in
  wrong-instance)
    if [[ "$kind" == "instance" ]]; then
      jq '.data.id="ocid1.instance.oc1..different"' "$STUB_CLOUD_DIR/baseline-api-$kind.json"
      exit
    fi
    ;;
  detached-volume)
    if [[ "$kind" == "attachment" ]]; then
      jq '.data."lifecycle-state"="DETACHED"' "$STUB_CLOUD_DIR/baseline-api-$kind.json"
      exit
    fi
    ;;
  wrong-volume)
    if [[ "$kind" == "attachment" ]]; then
      jq '.data."volume-id"="ocid1.volume.oc1..different"' "$STUB_CLOUD_DIR/baseline-api-$kind.json"
      exit
    fi
    ;;
esac
cat "$STUB_CLOUD_DIR/baseline-api-$kind.json"
SH
chmod +x "$stub_bin/oci"
cat >"$work_dir/historical-infrastructure.env" <<EOF
canonical_host=fixture.example
k3s_node_name=fixture-k3s
source_sha=$SOURCE_SHA
infrastructure_run_id=400
ghcr_build_run_id=300
infrastructure_finalized=true
namespace=betstan-oci
compartment_ocid=ocid1.compartment.oc1..test
region=fixture-region
availability_domain=fixture-ad
instance_ocid=ocid1.instance.oc1..test
instance_fingerprint=$(printf '%s' 'ocid1.instance.oc1..test' | sha256sum | awk '{print $1}')
mongo_volume_ocid=ocid1.volume.oc1..test
mongo_volume_attachment_ocid=ocid1.volumeattachment.oc1..test
mongo_volume_gb=50
EOF
historical_env=(
  "${common_env[@]}"
  CONTROL_SHA=3333333333333333333333333333333333333333
  OCI_COMPARTMENT_OCID=ocid1.compartment.oc1..test
  OCI_CLI_REGION=fixture-region
  INFRA_PROVENANCE_FILE="$work_dir/historical-infrastructure.env"
  STUB_BASELINE_NODE="$work_dir/baseline-node.json"
  STUB_MONGO_STORAGE="$work_dir/mongo-storage.json"
  STUB_CLOUD_DIR="$work_dir"
  STUB_CLOUD_LOG="$work_dir/historical-cloud.log"
  STUB_REMOTE_LOG="$work_dir/historical-remote.log"
  GITHUB_RUN_ID=500
  RECLAIM_CATEGORY=none
  RECLAIM_IMAGE_IDS='[]'
)
: >"$work_dir/historical-remote.log"
: >"$work_dir/historical-cloud.log"
env "${historical_env[@]}" WORK_DIR="$work_dir/historical-good" \
  OUTPUT_FILE="$work_dir/historical-good.json" "$ORCHESTRATOR" diagnose >/dev/null
"$HELPER" validate-observation --diagnosis "$work_dir/historical-good.json" \
  --source-sha "$SOURCE_SHA" --control-sha 3333333333333333333333333333333333333333
jq -e '.terminalStatus == "OBSERVED" and .mongoStorage.status == "COMPLETE"' \
  "$work_dir/historical-good.json" >/dev/null
[[ "$(wc -l <"$work_dir/historical-cloud.log" | tr -d ' ')" == "6" ]] ||
  fail "historical observation did not recheck cloud identity"
[[ "$(awk '$1 == "baseline-proof" {count++} END {print count+0}' "$work_dir/historical-remote.log")" == "2" ]] ||
  fail "historical observation did not recheck runtime identity"
if grep -Eq 'reclaim|apply|update|create|delete|provision|finalize|helm|mount' \
    "$work_dir/historical-cloud.log" "$work_dir/historical-remote.log"; then
  fail "historical observation reached a mutation"
fi
for failure in wrong-instance detached-volume wrong-volume; do
  : >"$work_dir/historical-remote.log"
  if env "${historical_env[@]}" STUB_CLOUD_FAILURE="$failure" \
      WORK_DIR="$work_dir/historical-$failure" \
      OUTPUT_FILE="$work_dir/historical-$failure.json" \
      "$ORCHESTRATOR" diagnose >"$work_dir/historical-error" 2>&1; then
    fail "historical observation accepted $failure"
  fi
  grep -Fq "historical instance or Mongo attachment identity drifted" "$work_dir/historical-error"
  [[ ! -e "$work_dir/historical-$failure.json" ]] ||
    fail "invalid historical identity produced observation authority"
  [[ ! -s "$work_dir/historical-remote.log" ]] ||
    fail "invalid cloud identity reached runtime collection"
done
: >"$work_dir/historical-remote.log"
if env "${historical_env[@]}" STUB_BASELINE_AFTER="$work_dir/baseline-node-drifted.json" \
    WORK_DIR="$work_dir/historical-drift" OUTPUT_FILE="$work_dir/historical-drift.json" \
    "$ORCHESTRATOR" diagnose >"$work_dir/historical-error" 2>&1; then
  fail "post-observation drift was accepted"
fi
grep -Fq "baseline proof is missing or drifted" "$work_dir/historical-error"
[[ ! -e "$work_dir/historical-drift.json" ]] ||
  fail "drifted baseline produced observation authority"
: >"$work_dir/historical-remote.log"
if env "${historical_env[@]}" STUB_BASELINE_AFTER="$work_dir/baseline-node-terminating.json" \
    WORK_DIR="$work_dir/historical-terminating" OUTPUT_FILE="$work_dir/historical-terminating.json" \
    "$ORCHESTRATOR" diagnose >"$work_dir/historical-error" 2>&1; then
  fail "post-observation running terminating wrong-generation pod was accepted"
fi
grep -Fq "live image generation is invalid" "$work_dir/historical-error"
grep -Fq "mongo-storage" "$work_dir/historical-remote.log"
[[ "$(awk '$1 == "baseline-proof" {count++} END {print count+0}' "$work_dir/historical-remote.log")" == "2" ]] ||
  fail "terminating-pod regression did not reach the after-observation proof"
[[ ! -e "$work_dir/historical-terminating.json" ]] ||
  fail "running terminating wrong-generation pod produced observation authority"
if env "${historical_env[@]}" OUTPUT_FILE="$work_dir/historical-reclaim.json" \
    "$ORCHESTRATOR" reclaim >"$work_dir/historical-error" 2>&1; then
  fail "historical control was accepted by reclaim"
fi
grep -Fq "historical observations cannot reclaim" "$work_dir/historical-error"

echo "k3s_disk_recovery_tests=PASS"
