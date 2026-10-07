#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
HELPER="$ROOT_DIR/infra/oci/scripts/k3s_disk_recovery_stan.py"
ORCHESTRATOR="$ROOT_DIR/infra/oci/scripts/k3s-node-disk-recovery-stan.sh"
REMOTE="$ROOT_DIR/infra/oci/scripts/k3s-node-disk-remote-stan.sh"
WORK_PARENT="$ROOT_DIR/infra/oci/tests/.k3s-disk-recovery-workdirs"
mkdir -p "$WORK_PARENT"
work_dir="$WORK_PARENT/test.$$"
mkdir -m 700 "$work_dir"
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

candidate_cases="$work_dir/candidate-cases"
mkdir -p "$candidate_cases"
python3 - "$candidate_images" "$candidate_cases" <<'PY'
import json
import sys
from pathlib import Path

source = Path(sys.argv[1])
destination = Path(sys.argv[2])
rows = [line.split("\t") for line in source.read_text().splitlines()]

(destination / "shuffled.tsv").write_text(
    "\n".join("\t".join(row) for row in reversed(rows)) + "\n"
)
(destination / "expected.json").write_text(
    json.dumps([row[2] for row in sorted(rows)], separators=(",", ":")) + "\n"
)

cases = {}
cases["malformed"] = rows[:]
cases["malformed"][2] = ["event", "too", "few", "columns"]
cases["missing"] = rows[:-1]
cases["extra"] = rows + [["unexpected", *rows[0][1:]]]
cases["duplicate-service"] = [row[:] for row in rows]
cases["duplicate-service"][-1][0] = rows[0][0]
cases["repository"] = [row[:] for row in rows]
cases["repository"][0][1] = "ghcr.io/other/repository"
cases["tag"] = [row[:] for row in rows]
cases["tag"][0][2] = "ghcr.io/vasilyevstan/betstan-images:auth-latest"
cases["manifest-digest"] = [row[:] for row in rows]
cases["manifest-digest"][0][3] = "sha256:" + "f" * 64
cases["platform-digest"] = [row[:] for row in rows]
cases["platform-digest"][0][4] = "sha256:short"
for name, value in cases.items():
    (destination / f"{name}.tsv").write_text(
        "\n".join("\t".join(row) for row in value) + "\n"
    )
(destination / "final-row.tsv").write_text(
    "\n".join("\t".join(row) for row in rows[:-1])
    + "\n"
    + "\t".join(rows[-1][:-1])
    + "\n"
)

shared = [row[:] for row in rows]
for row in shared:
    row[2:] = rows[0][2:]
(destination / "shared.tsv").write_text(
    "\n".join("\t".join(row) for row in shared) + "\n"
)

different = [row[:] for row in rows]
for index, row in enumerate(different, start=1):
    manifest = "sha256:" + f"{9000 + index:064x}"
    platform = "sha256:" + f"{10000 + index:064x}"
    row[2] = f"{row[1]}@{manifest}"
    row[3] = manifest
    row[4] = platform
(destination / "different-valid.tsv").write_text(
    "\n".join("\t".join(row) for row in different) + "\n"
)
PY

"$HELPER" candidate-image-refs \
  --candidate-images "$candidate_cases/shuffled.tsv" \
  >"$candidate_cases/actual.json"
cmp "$candidate_cases/expected.json" "$candidate_cases/actual.json" ||
  fail "candidate image references were not compact, complete, and service sorted"
jq -e '
  type == "array" and length == 10 and
  all(.[]; test("^ghcr[.]io/vasilyevstan/betstan-images@sha256:[0-9a-f]{64}$"))
' "$candidate_cases/actual.json" >/dev/null ||
  fail "candidate image reference payload shape is invalid"
trailing_lf_candidate_refs="$(
  jq -c '.[-1] += "\n"' "$candidate_cases/actual.json"
)"
jq -e '.[-1] | endswith("\n")' <<<"$trailing_lf_candidate_refs" >/dev/null ||
  fail "trailing-LF candidate reference fixture is invalid"

for candidate_case in \
  malformed missing extra duplicate-service repository tag manifest-digest \
  platform-digest final-row; do
  if "$HELPER" candidate-image-refs \
      --candidate-images "$candidate_cases/$candidate_case.tsv" \
      >"$candidate_cases/$candidate_case.out" 2>/dev/null; then
    fail "candidate image reference parser accepted $candidate_case evidence"
  fi
  [[ ! -s "$candidate_cases/$candidate_case.out" ]] ||
    fail "candidate image reference parser leaked a payload for $candidate_case"
done

"$HELPER" candidate-image-refs \
  --candidate-images "$candidate_cases/shared.tsv" \
  >"$candidate_cases/shared.json"
jq -e 'length == 10 and ([.[]] | unique | length) == 1' \
  "$candidate_cases/shared.json" >/dev/null ||
  fail "shared immutable image references were newly rejected"

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

apt_candidate_cases="$work_dir/apt-candidate-finalize-cases"
mkdir -p "$apt_candidate_cases"
python3 - "$post_apt" "$diagnosis" "$apt_candidate_cases" "$CURRENT_ID" <<'PY'
import copy
import json
import sys
from pathlib import Path

runtime_path, diagnosis_path, output_path, removed_id = sys.argv[1:]
runtime = json.loads(Path(runtime_path).read_text())
diagnosis = json.loads(Path(diagnosis_path).read_text())
output = Path(output_path)


def image(image_id, digests):
    return {
        "id": image_id,
        "repoTags": [],
        "repoDigests": digests,
        "sizeBytes": 1000,
        "pinned": False,
    }


def native_id(value):
    return "sha256:" + f"{value:064d}"


candidate = diagnosis["candidateImages"][0]
candidate_native = native_id(901)
ambiguous_native = native_id(902)
foreign_native = native_id(903)
platform_native = candidate["platformDigest"]
assert platform_native not in {item["id"] for item in runtime["images"]}

partial = copy.deepcopy(runtime)
partial["images"].append(image(candidate_native, [candidate["imageRef"]]))
(output / "candidate-partial.json").write_text(json.dumps(partial, sort_keys=True))

platform = copy.deepcopy(runtime)
platform["images"].append(
    image(platform_native, [f"docker.io/library/test@{platform_native}"])
)
(output / "platform-is-not-native-proof.json").write_text(
    json.dumps(platform, sort_keys=True)
)

foreign = copy.deepcopy(runtime)
foreign["images"].append(
    image(foreign_native, [f"docker.io/library/test@{foreign_native}"])
)
(output / "foreign.json").write_text(json.dumps(foreign, sort_keys=True))

ambiguous = copy.deepcopy(runtime)
ambiguous["images"].extend(
    [
        image(candidate_native, [candidate["imageRef"]]),
        image(ambiguous_native, [candidate["imageRef"]]),
    ]
)
(output / "ambiguous.json").write_text(json.dumps(ambiguous, sort_keys=True))

removed = copy.deepcopy(partial)
removed["images"] = [
    item for item in removed["images"] if item["id"] != removed_id
]
(output / "removed.json").write_text(json.dumps(removed, sort_keys=True))

(output / "ids.json").write_text(
    json.dumps(
        {
            "candidateNative": candidate_native,
            "ambiguousNative": ambiguous_native,
            "foreignNative": foreign_native,
            "platformNative": platform_native,
            "removed": removed_id,
        },
        sort_keys=True,
    )
)
PY

"$HELPER" finalize-reclaim \
  --diagnosis "$diagnosis" \
  --post-runtime "$apt_candidate_cases/candidate-partial.json" \
  --post-capacity "$post_capacity" \
  --category apt-package-cache \
  --image-ids '[]' \
  --mutation-succeeded true \
  --output "$apt_candidate_cases/candidate-partial-result.json"
jq -e '
  .terminalStatus == "RECLAIMED" and
  .removedImageIds == [] and
  .unexpectedAddedImageIds == []
' "$apt_candidate_cases/candidate-partial-result.json" >/dev/null ||
  fail "diagnosis candidate native ID was not exempted from APT additions"

for apt_case in platform-is-not-native-proof foreign ambiguous removed; do
  if "$HELPER" finalize-reclaim \
      --diagnosis "$diagnosis" \
      --post-runtime "$apt_candidate_cases/$apt_case.json" \
      --post-capacity "$post_capacity" \
      --category apt-package-cache \
      --image-ids '[]' \
      --mutation-succeeded true \
      --output "$apt_candidate_cases/$apt_case-result.json" \
      >/dev/null 2>&1; then
    fail "APT reclaim accepted an unsafe image inventory transition: $apt_case"
  fi
  jq -e '.terminalStatus == "INCOMPLETE"' \
    "$apt_candidate_cases/$apt_case-result.json" >/dev/null ||
    fail "unsafe APT image transition lacked durable evidence: $apt_case"
done
jq -e --slurpfile ids "$apt_candidate_cases/ids.json" '
  .unexpectedAddedImageIds == [$ids[0].platformNative]
' "$apt_candidate_cases/platform-is-not-native-proof-result.json" >/dev/null ||
  fail "candidate platform digest was incorrectly treated as a native CRI ID"
jq -e --slurpfile ids "$apt_candidate_cases/ids.json" '
  .unexpectedAddedImageIds == [$ids[0].foreignNative]
' "$apt_candidate_cases/foreign-result.json" >/dev/null ||
  fail "foreign APT image addition was not retained as unexpected"
jq -e --slurpfile ids "$apt_candidate_cases/ids.json" '
  .unexpectedAddedImageIds ==
    ([$ids[0].candidateNative, $ids[0].ambiguousNative] | sort)
' "$apt_candidate_cases/ambiguous-result.json" >/dev/null ||
  fail "ambiguous candidate residency incorrectly granted an exemption"
jq -e --slurpfile ids "$apt_candidate_cases/ids.json" '
  .removedImageIds == [$ids[0].removed] and
  .unexpectedAddedImageIds == []
' "$apt_candidate_cases/removed-result.json" >/dev/null ||
  fail "APT reclaim did not retain removal failure after candidate exemption"

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

journal_cases="$work_dir/journal-cases"
mkdir -p "$journal_cases"
python3 - "$HELPER" "$runtime" "$capacity" "$candidate_images" \
  "$journal_cases" "$SOURCE_SHA" <<'PY'
import argparse
import copy
import importlib.util
import json
import sys
from pathlib import Path

sys.dont_write_bytecode = True
helper, runtime_path, capacity_path, candidates_path, output_path, source = sys.argv[1:]
spec = importlib.util.spec_from_file_location("disk", helper)
disk = importlib.util.module_from_spec(spec)
spec.loader.exec_module(disk)
output = Path(output_path)
legacy = json.loads(Path(runtime_path).read_text())
capacity = json.loads(Path(capacity_path).read_text())
candidates = disk.parse_candidate_images(candidates_path)


def write(name, value):
    path = output / f"{name}.json"
    path.write_text(disk.canonical(value) + "\n")
    return str(path)


def rejected(callback, label, reason=None):
    try:
        callback()
    except SystemExit as exc:
        if reason is not None:
            assert reason in str(exc), (label, str(exc))
    else:
        raise AssertionError(f"accepted {label}")


disk.validate_runtime(legacy)
v2 = copy.deepcopy(legacy)
v2.update(schemaVersion="k3s-node-disk-runtime.v2", snapshotProfile="public")
v2["applicationImages"] = [
    {"service": row["service"], "imageRef": row["imageRef"]} for row in candidates
]
disk.validate_runtime(v2)
before = copy.deepcopy(v2)
before["schemaVersion"] = "k3s-node-disk-runtime.v3"
before["consumers"].append({
    "category": "system-journal", "path": "/var/log/journal", "bytes": 3_000_000_000,
    "isDirectory": True, "onRootFilesystem": True,
})
disk.validate_runtime(before)
for version in (legacy, v2):
    extra = copy.deepcopy(version)
    extra["consumers"].append(copy.deepcopy(before["consumers"][-1]))
    rejected(lambda: disk.validate_runtime(extra), "seventh consumer in legacy schema")
for change in (
    lambda value: value["consumers"].pop(),
    lambda value: value["consumers"].append(copy.deepcopy(value["consumers"][-1])),
    lambda value: value["consumers"].__setitem__(0, copy.deepcopy(value["consumers"][-1])),
    lambda value: value["consumers"][-1].update(path="/run/log/journal"),
    lambda value: value["consumers"][-1].update(isDirectory=1),
    lambda value: value["consumers"][-1].update(extra=True),
    lambda value: value.pop("applicationImages"),
):
    invalid = copy.deepcopy(before)
    change(invalid)
    rejected(lambda: disk.validate_runtime(invalid), "non-strict v3 runtime")
assert disk.JOURNAL_TARGET_BYTES == 536870912
assert disk.JOURNAL_PATH == "/var/log/journal"
before_path = write("before", before)
diagnosis_path = str(output / "diagnosis.json")
disk.build_diagnosis(argparse.Namespace(
    runtime=before_path, capacity=capacity_path, candidate_images=candidates_path,
    source_sha=source, infrastructure_run_id="400", ghcr_build_run_id="300",
    workflow_run_id="500", mongo_storage=str(output / "unavailable.json"),
    mongo_storage_failure="TRANSPORT_FAILED", output=diagnosis_path,
))
diagnosis = json.loads(Path(diagnosis_path).read_text())
assert diagnosis["schemaVersion"] == "k3s-node-disk-diagnosis.v2"
plan_args = dict(
    diagnosis=diagnosis_path, runtime=before_path, capacity=capacity_path,
    category="system-journal", image_ids="[]", protected_generations=None,
    generation_map=None, output=str(output / "plan.json"),
)


def plan(**overrides):
    disk.plan_reclaim(argparse.Namespace(**{**plan_args, **overrides}))


plan()
assert set(json.loads(Path(plan_args["output"]).read_text())) == {
    "schemaVersion", "sourceSha", "diagnosisWorkflowRunId", "category",
    "selectedImageIds", "securityStateSha256", "preRootUsedBytes",
    "preRootUsedPercent", "terminalStatus", "contentChecksumSha256",
}
assert json.loads(Path(plan_args["output"]).read_text())["schemaVersion"] == \
    "k3s-node-disk-reclaim-plan.v1"
rejected(lambda: plan(image_ids=json.dumps([before["images"][0]["id"]])), "selected IDs")
for label, change in (
    ("missing", lambda rows: rows.pop()),
    ("wrong-path", lambda rows: rows[-1].update(path="/var/log")),
    ("not-directory", lambda rows: rows[-1].update(isDirectory=False)),
    ("non-root", lambda rows: rows[-1].update(onRootFilesystem=False)),
    ("at-target", lambda rows: rows[-1].update(bytes=536870912)),
    ("below-target", lambda rows: rows[-1].update(bytes=536870911)),
):
    old = copy.deepcopy(diagnosis)
    change(old["runtime"]["consumers"])
    old.pop("contentChecksumSha256")
    old_path = write(f"bound-{label}", disk.add_checksum(old))
    rejected(lambda: plan(diagnosis=old_path), f"bound journal {label}")
    fresh = copy.deepcopy(before)
    change(fresh["consumers"])
    fresh_path = write(f"fresh-{label}", fresh)
    rejected(lambda: plan(runtime=fresh_path), f"fresh journal {label}")
rejected(lambda: plan(runtime=write("fresh-v2", v2)), "legacy fresh snapshot")
for larger in ("root", "kubelet"):
    fresh = copy.deepcopy(before)
    fresh_capacity = copy.deepcopy(capacity)
    if larger == "root":
        fresh["root"]["df"]["usedBytes"] += 500_000_000
    else:
        fresh_capacity.update(usedBytes=37_500_000_000, availableBytes=12_500_000_000,
                              usedPercent=75.0)
    fresh["consumers"][-1]["bytes"] = 2_500_000_000
    fresh_capacity_path = write(f"capacity-{larger}", fresh_capacity)
    plan(runtime=write(f"gross-equality-{larger}", fresh), capacity=fresh_capacity_path)
    fresh["consumers"][-1]["bytes"] -= 1
    rejected(
        lambda: plan(runtime=write(f"insufficient-{larger}", fresh),
                     capacity=fresh_capacity_path),
        f"insufficient journal for larger {larger} excess", "cannot cover",
    )

after = copy.deepcopy(before)
after["root"]["df"].update(usedBytes=34_500_000_000, availableBytes=15_500_000_000,
                          usedPercent=69)
after["root"]["mount"].update(used=34_500_000_000, avail=15_500_000_000)
after["consumers"][-1]["bytes"] = 500_000_000
post_capacity = copy.deepcopy(capacity)
post_capacity.update(usedBytes=34_500_000_000, availableBytes=15_500_000_000,
                     usedPercent=69.0, withinLimit=True)
post_capacity_path = write("post-capacity", post_capacity)
write("cleaned", after)
for index, candidate in enumerate(candidates):
    after["images"].append({
        "id": f"sha256:{9000 + index:064x}", "repoTags": [],
        "repoDigests": [candidate["imageRef"]], "sizeBytes": 1000, "pinned": False,
    })
after_path = write("complete", after)
partial = copy.deepcopy(after)
partial["images"] = partial["images"][:len(before["images"]) + 1]
write("partial", partial)
over = copy.deepcopy(partial)
over["root"]["df"].update(usedBytes=35_500_000_000, availableBytes=14_500_000_000,
                         usedPercent=71)
write("over-limit", over)
final_args = dict(
    diagnosis=diagnosis_path, pre_runtime=before_path, post_runtime=after_path,
    post_capacity=post_capacity_path,
    category="system-journal", image_ids="[]", mutation_succeeded="true",
    output=str(output / "reclaim.json"),
)


def finalize(**overrides):
    disk.finalize_reclaim(argparse.Namespace(**{**final_args, **overrides}))


finalize()
result = json.loads(Path(final_args["output"]).read_text())
assert result["schemaVersion"] == "k3s-node-disk-reclaim.v1"
assert result["terminalStatus"] == "RECLAIMED"
assert result["removedImageIds"] == result["unexpectedAddedImageIds"] == []
for label, change in (
    ("no-decrease", lambda value: value["consumers"][-1].update(bytes=3_000_000_000)),
    ("increase", lambda value: value["consumers"][-1].update(bytes=3_000_000_001)),
    ("removal", lambda value: value["images"].pop(0)),
    ("foreign", lambda value: value["images"].append({
        "id": "sha256:" + "f" * 64, "repoTags": [], "sizeBytes": 1, "pinned": False,
        "repoDigests": ["docker.io/library/foreign@sha256:" + "f" * 64],
    })),
    ("ambiguous", lambda value: value["images"].append({
        **value["images"][-1], "id": "sha256:" + "e" * 64,
    })),
    ("mount", lambda value: value["root"]["mount"].update(source="/dev/other")),
    ("mount-size", lambda value: value["root"]["mount"].update(size=50_000_000_001)),
    ("runtime", lambda value: value["runtime"].update(k3sVersion="k3s version v1.35.0")),
    ("pod-count", lambda value: value["workload"].update(podCount=13)),
    ("restarts", lambda value: value["workload"].update(restartCount=5)),
    ("queue-count", lambda value: value["queue"].update(queueCount=12)),
    ("queue-backlog", lambda value: value["queue"].update(backlog=8)),
):
    invalid = copy.deepcopy(after)
    change(invalid)
    rejected(lambda: finalize(post_runtime=write(label, invalid)), label)
    assert json.loads(Path(final_args["output"]).read_text())["terminalStatus"] == "INCOMPLETE"
invalid = copy.deepcopy(after)
invalid["publicRead"][0]["status"] = 503
rejected(lambda: finalize(post_runtime=write("public-read", invalid)), "public read drift")
rejected(lambda: finalize(mutation_succeeded="false"), "mutation failure")
rejected(lambda: finalize(image_ids=json.dumps([before["images"][0]["id"]])), "final IDs")
rejected(lambda: finalize(pre_runtime=None), "missing fresh journal baseline")
fresh = copy.deepcopy(before)
fresh["consumers"][-1]["bytes"] = 2_000_000_000
growing = copy.deepcopy(after)
growing["consumers"][-1]["bytes"] = 2_000_000_001
rejected(lambda: finalize(pre_runtime=write("fresh-smaller", fresh),
                          post_runtime=write("post-growing", growing)),
         "journal growth hidden by an older larger diagnosis")
for root_extra, kubelet_extra in ((0, 0), (1, 0), (0, 1)):
    equality = copy.deepcopy(after)
    equality["root"]["df"].update(usedBytes=35_000_000_000 + root_extra,
                                 availableBytes=15_000_000_000 - root_extra,
                                 usedPercent=70)
    equality_capacity = copy.deepcopy(post_capacity)
    equality_capacity.update(usedBytes=35_000_000_000 + kubelet_extra,
                             availableBytes=15_000_000_000 - kubelet_extra,
                             usedPercent=70.0, withinLimit=kubelet_extra == 0)
    overrides = dict(post_runtime=write("threshold-runtime", equality),
                     post_capacity=write("threshold-capacity", equality_capacity))
    if root_extra or kubelet_extra:
        rejected(lambda: finalize(**overrides), "one byte above root/kubelet limit")
    else:
        finalize(**overrides)
finalize()
checkpoint_path = str(output / "checkpoint.json")
disk.write_release_checkpoint(argparse.Namespace(
    diagnosis=diagnosis_path, reclaim=final_args["output"], runtime=after_path,
    capacity=post_capacity_path, source_sha=source, control_sha=source,
    producer_run_id="501", output=checkpoint_path,
))
checkpoint = json.loads(Path(checkpoint_path).read_text())
assert checkpoint["schemaVersion"] == "k3s-release-disk-checkpoint.v1"
assert checkpoint["disposition"] == "READY_RECLAIMED"
assert checkpoint["reclaimCategory"] == "system-journal"
disk.validate_release_checkpoint(checkpoint)
for updates in ({"disposition": "READY_NO_RECLAIM"}, {"reclaimCategory": "cri-owned-unused-images"}):
    invalid = {**checkpoint, **updates}
    invalid.pop("contentChecksumSha256")
    rejected(lambda: disk.validate_release_checkpoint(disk.add_checksum(invalid)),
             "invalid journal checkpoint authority")
held = {key: after[key] for key in ("applicationRepository", "root", "mongo", "images", "runtime")}
held.update(schemaVersion="k3s-node-disk-held-runtime.v1", snapshotProfile="held")
for profile, runtime_file in (("public", after_path), ("held", write("held", held))):
    disk.revalidate_release_checkpoint(argparse.Namespace(
        checkpoint=checkpoint_path, runtime=runtime_file, capacity=post_capacity_path,
        candidate_images=candidates_path, source_sha=source, producer_run_id="501",
        profile=profile,
    ))
print("journal schema, planning, convergence, drift, residency, threshold and checkpoint contracts passed")
PY

checkpoint_runtime="$work_dir/checkpoint-runtime.json"
checkpoint_capacity="$work_dir/checkpoint-capacity.json"
python3 - "$runtime" "$candidate_images" "$checkpoint_runtime" <<'PY'
import json
import sys
from pathlib import Path

runtime_path, candidates_path, output_path = map(Path, sys.argv[1:])
runtime = json.loads(runtime_path.read_text())
candidates = []
for raw in candidates_path.read_text().splitlines():
    service, _, image_ref, _, platform = raw.split("\t")
    candidates.append((service, image_ref, platform))
runtime["schemaVersion"] = "k3s-node-disk-runtime.v2"
runtime["snapshotProfile"] = "public"
runtime["applicationImages"] = [
    {"service": service, "imageRef": image_ref}
    for service, image_ref, _ in candidates
]
runtime["images"] = [
    {
        "id": platform,
        "repoTags": [],
        "repoDigests": [image_ref],
        "sizeBytes": 1000,
        "pinned": False,
    }
    for _, image_ref, platform in candidates
]
runtime["containerImageReferences"] = []
runtime["kubernetesImageReferences"] = [
    image_ref for _, image_ref, _ in candidates
]
runtime["root"]["mount"]["used"] = 35_000_000_000
runtime["root"]["mount"]["avail"] = 15_000_000_000
runtime["root"]["df"].update({
    "usedBytes": 35_000_000_000,
    "availableBytes": 15_000_000_000,
    "usedPercent": 70,
})
output_path.write_text(json.dumps(runtime, sort_keys=True))
PY
cat >"$checkpoint_capacity" <<'JSON'
{"schemaVersion":"k3s-node-filesystem-capacity.v1","nodeName":"fixture-k3s","capacityBytes":50000000000,"usedBytes":35000000000,"availableBytes":15000000000,"usedPercent":70.0,"thresholdPercent":70,"withinLimit":true}
JSON
checkpoint_diagnosis="$work_dir/checkpoint-diagnosis.json"
"$HELPER" diagnose \
  --runtime "$checkpoint_runtime" \
  --capacity "$checkpoint_capacity" \
  --candidate-images "$candidate_images" \
  --source-sha "$SOURCE_SHA" \
  --infrastructure-run-id 400 \
  --ghcr-build-run-id 300 \
  --workflow-run-id 700 \
  --output "$checkpoint_diagnosis"
checkpoint="$work_dir/checkpoint.json"
"$HELPER" write-release-checkpoint \
  --diagnosis "$checkpoint_diagnosis" \
  --runtime "$checkpoint_runtime" \
  --capacity "$checkpoint_capacity" \
  --source-sha "$SOURCE_SHA" \
  --control-sha "$SOURCE_SHA" \
  --producer-run-id 700 \
  --output "$checkpoint" >/dev/null
"$HELPER" validate-release-checkpoint \
  --checkpoint "$checkpoint" \
  --source-sha "$SOURCE_SHA" \
  --producer-run-id 700 \
  --runtime-mode k3s \
  --infrastructure-run-id 400 \
  --ghcr-build-run-id 300 \
  --candidate-images "$candidate_images" >/dev/null
jq -e '
  .schemaVersion == "k3s-release-disk-checkpoint.v1" and
  .sourceSha == .controlSha and
  .disposition == "READY_NO_RECLAIM" and
  .terminalStatus == "RELEASE_ELIGIBLE" and
  .thresholdPercent == 70 and
  .root.usedBytes == 35000000000 and
  (.candidateResidency | length) == 10 and
  (.rollbackResidency | length) == 10 and
  .publicStateStatus == "PASS" and
  .diagnosisRunId == "700" and
  (.diagnosisChecksumSha256 | test("^[0-9a-f]{64}$")) and
  .reclaimRunId == "0" and
  .reclaimChecksumSha256 == "none" and
  .reclaimCategory == "none" and
  (.contentChecksumSha256 | test("^[0-9a-f]{64}$"))
' "$checkpoint" >/dev/null ||
  fail "canonical no-reclaim checkpoint is incomplete"
jq -e '
  ((keys | sort) == ([
    "candidateResidency",
    "contentChecksumSha256",
    "controlSha",
    "diagnosisRunId",
    "diagnosisChecksumSha256",
    "disposition",
    "ghcrBuildRunId",
    "infrastructureRunId",
    "producerRunAttempt",
    "producerRunId",
    "publicStateStatus",
    "reclaimCategory",
    "reclaimRunId",
    "reclaimChecksumSha256",
    "rollbackResidency",
    "root",
    "runtimeMode",
    "schemaVersion",
    "sourceSha",
    "stableIdentity",
    "thresholdPercent",
    "terminalStatus"
  ] | sort)) and
  ((.root | keys | sort) == ([
    "capacityBytes",
    "usedBytes"
  ] | sort)) and
  ((.stableIdentity | keys | sort) == ([
    "containerRuntimeVersion",
    "k3sActive",
    "k3sVersion",
    "mongoFsType",
    "mongoMountCapacityBytes",
    "mongoMountSourceSha256",
    "mongoSeparateFromRoot",
    "nodeNameSha256",
    "rootFsType",
    "rootMountCapacityBytes",
    "rootMountSourceSha256"
  ] | sort)) and
  all(.candidateResidency[];
    ((keys | sort) == ([
      "imageRef",
      "manifestDigest",
      "platformDigest",
      "residentImageId",
      "residentRepoDigest",
      "service"
    ] | sort))) and
  all(.rollbackResidency[];
    ((keys | sort) == ([
      "imageRef",
      "residentImageId",
      "residentRepoDigest",
      "service"
    ] | sort)))
' "$checkpoint" >/dev/null ||
  fail "k3s release checkpoint key sets drifted"

"$HELPER" revalidate-release-checkpoint \
  --checkpoint "$checkpoint" \
  --runtime "$checkpoint_runtime" \
  --capacity "$checkpoint_capacity" \
  --candidate-images "$candidate_images" \
  --source-sha "$SOURCE_SHA" \
  --producer-run-id 700 \
  --profile public >/dev/null

held_runtime="$work_dir/checkpoint-held-runtime.json"
jq '{
  schemaVersion:"k3s-node-disk-held-runtime.v1",
  snapshotProfile:"held",
  applicationRepository,
  root,
  mongo,
  images,
  runtime
}' "$checkpoint_runtime" >"$held_runtime"
"$HELPER" revalidate-release-checkpoint \
  --checkpoint "$checkpoint" \
  --runtime "$held_runtime" \
  --capacity "$checkpoint_capacity" \
  --candidate-images "$candidate_images" \
  --source-sha "$SOURCE_SHA" \
  --producer-run-id 700 \
  --profile held >/dev/null

raw_over_runtime="$work_dir/checkpoint-raw-over-runtime.json"
jq '
  .root.df.usedBytes = 35000000001 |
  .root.df.availableBytes = 14999999999
' "$checkpoint_runtime" >"$raw_over_runtime"
raw_over_diagnosis="$work_dir/checkpoint-raw-over-diagnosis.json"
"$HELPER" diagnose \
  --runtime "$raw_over_runtime" \
  --capacity "$checkpoint_capacity" \
  --candidate-images "$candidate_images" \
  --source-sha "$SOURCE_SHA" \
  --infrastructure-run-id 400 \
  --ghcr-build-run-id 300 \
  --workflow-run-id 703 \
  --output "$raw_over_diagnosis"
jq -e '.terminalStatus == "DIAGNOSED"' "$raw_over_diagnosis" >/dev/null ||
  fail "diagnosis incorrectly enforced the checkpoint-only raw root veto"

raw_over_checkpoint="$work_dir/checkpoint-raw-over-output.json"
printf 'stale\n' >"$raw_over_checkpoint"
raw_over_message="$(
  "$HELPER" write-release-checkpoint \
    --diagnosis "$raw_over_diagnosis" \
    --runtime "$raw_over_runtime" \
    --capacity "$checkpoint_capacity" \
    --source-sha "$SOURCE_SHA" \
    --control-sha "$SOURCE_SHA" \
    --producer-run-id 703 \
    --output "$raw_over_checkpoint"
)"
[[ "$raw_over_message" == "k3s_release_disk_checkpoint=INELIGIBLE" &&
   ! -e "$raw_over_checkpoint" ]] ||
  fail "raw root one-byte breach did not remove stale checkpoint output"

if "$HELPER" revalidate-release-checkpoint \
    --checkpoint "$checkpoint" \
    --runtime "$raw_over_runtime" \
    --capacity "$checkpoint_capacity" \
    --candidate-images "$candidate_images" \
    --source-sha "$SOURCE_SHA" \
    --producer-run-id 700 \
    --profile public >/dev/null 2>&1; then
  fail "public checkpoint revalidation ignored the raw root byte veto"
fi
held_raw_over="$work_dir/checkpoint-held-raw-over.json"
jq '{
  schemaVersion:"k3s-node-disk-held-runtime.v1",
  snapshotProfile:"held",
  applicationRepository,
  root,
  mongo,
  images,
  runtime
}' "$raw_over_runtime" >"$held_raw_over"
if "$HELPER" revalidate-release-checkpoint \
    --checkpoint "$checkpoint" \
    --runtime "$held_raw_over" \
    --capacity "$checkpoint_capacity" \
    --candidate-images "$candidate_images" \
    --source-sha "$SOURCE_SHA" \
    --producer-run-id 700 \
    --profile held >/dev/null 2>&1; then
  fail "held checkpoint revalidation ignored the raw root byte veto"
fi

kubelet_over_capacity="$work_dir/checkpoint-kubelet-over-capacity.json"
cat >"$kubelet_over_capacity" <<'JSON'
{"schemaVersion":"k3s-node-filesystem-capacity.v1","nodeName":"fixture-k3s","capacityBytes":50000000000,"usedBytes":35000000001,"availableBytes":14999999999,"usedPercent":70.0,"thresholdPercent":70,"withinLimit":false}
JSON
kubelet_over_checkpoint="$work_dir/checkpoint-kubelet-over-output.json"
kubelet_over_message="$(
  "$HELPER" write-release-checkpoint \
    --diagnosis "$checkpoint_diagnosis" \
    --runtime "$checkpoint_runtime" \
    --capacity "$kubelet_over_capacity" \
    --source-sha "$SOURCE_SHA" \
    --control-sha "$SOURCE_SHA" \
    --producer-run-id 700 \
    --output "$kubelet_over_checkpoint"
)"
[[ "$kubelet_over_message" == "k3s_release_disk_checkpoint=INELIGIBLE" &&
   ! -e "$kubelet_over_checkpoint" ]] ||
  fail "kubelet one-byte breach passed checkpoint creation with raw root below limit"
if "$HELPER" revalidate-release-checkpoint \
    --checkpoint "$checkpoint" \
    --runtime "$checkpoint_runtime" \
    --capacity "$kubelet_over_capacity" \
    --candidate-images "$candidate_images" \
    --source-sha "$SOURCE_SHA" \
    --producer-run-id 700 \
    --profile public >/dev/null 2>&1; then
  fail "checkpoint revalidation ignored the independent kubelet byte veto"
fi

rollback_generation_drift="$work_dir/checkpoint-rollback-generation-drift.json"
python3 - "$checkpoint_runtime" "$rollback_generation_drift" <<'PY'
import json
import sys
from pathlib import Path

source, destination = map(Path, sys.argv[1:])
runtime = json.loads(source.read_text())
new_digest = (
    "ghcr.io/vasilyevstan/betstan-images@sha256:"
    + "9" * 64
)
runtime["applicationImages"][0]["imageRef"] = new_digest
runtime["kubernetesImageReferences"][0] = new_digest
runtime["images"].append({
    "id": "sha256:" + "8" * 64,
    "repoTags": [],
    "repoDigests": [new_digest],
    "sizeBytes": 1000,
    "pinned": False,
})
destination.write_text(json.dumps(runtime, sort_keys=True))
PY
if "$HELPER" revalidate-release-checkpoint \
    --checkpoint "$checkpoint" \
    --runtime "$rollback_generation_drift" \
    --capacity "$checkpoint_capacity" \
    --candidate-images "$candidate_images" \
    --source-sha "$SOURCE_SHA" \
    --producer-run-id 700 \
    --profile public >/dev/null 2>&1; then
  fail "public revalidation ignored current rollback generation drift"
fi

rollback_generation_held="$work_dir/checkpoint-rollback-generation-held.json"
jq '{
  schemaVersion:"k3s-node-disk-held-runtime.v1",
  snapshotProfile:"held",
  applicationRepository,
  root,
  mongo,
  images,
  runtime
}' "$rollback_generation_drift" >"$rollback_generation_held"
"$HELPER" revalidate-release-checkpoint \
  --checkpoint "$checkpoint" \
  --runtime "$rollback_generation_held" \
  --capacity "$checkpoint_capacity" \
  --candidate-images "$candidate_images" \
  --source-sha "$SOURCE_SHA" \
  --producer-run-id 700 \
  --profile held >/dev/null

for mutation in \
  '.unexpected = true' \
  'del(.stableIdentity.k3sVersion)' \
  '.root.unexpected = 1' \
  '.candidateResidency[0].unexpected = true' \
  '.rollbackResidency[0].unexpected = true'; do
  invalid_checkpoint="$work_dir/checkpoint-schema-$(
    printf '%s' "$mutation" | sha256sum | cut -c1-12
  ).json"
  jq "$mutation" "$checkpoint" >"$invalid_checkpoint"
  if "$HELPER" validate-release-checkpoint \
      --checkpoint "$invalid_checkpoint" \
      --source-sha "$SOURCE_SHA" \
      --producer-run-id 700 \
      --runtime-mode k3s >/dev/null 2>&1; then
    fail "release checkpoint accepted missing or extra schema fields: $mutation"
  fi
done

for mutation in \
  '.runtime.k3sVersion = "k3s version v1.35.0+k3s1"' \
  '.runtime.containerRuntimeVersion = "containerd://2.2.0-k3s1"' \
  '.root.mount.source = "/dev/substituted-root"' \
  '.images[0].id = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"' \
  '.images[0].repoDigests[0] = "ghcr.io/vasilyevstan/betstan-images@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"'; do
  drifted_runtime="$work_dir/checkpoint-held-drift-$(
    printf '%s' "$mutation" | sha256sum | cut -c1-12
  ).json"
  jq "$mutation" "$held_runtime" >"$drifted_runtime"
  if "$HELPER" revalidate-release-checkpoint \
      --checkpoint "$checkpoint" \
      --runtime "$drifted_runtime" \
      --capacity "$checkpoint_capacity" \
      --candidate-images "$candidate_images" \
      --source-sha "$SOURCE_SHA" \
      --producer-run-id 700 \
      --profile held >/dev/null 2>&1; then
    fail "held checkpoint accepted stable identity or CRI residency substitution: $mutation"
  fi
done

held_extra_mount="$work_dir/checkpoint-held-extra-mount.json"
jq '.root.mount.unexpected = "drift"' "$held_runtime" >"$held_extra_mount"
if "$HELPER" revalidate-release-checkpoint \
    --checkpoint "$checkpoint" \
    --runtime "$held_extra_mount" \
    --capacity "$checkpoint_capacity" \
    --candidate-images "$candidate_images" \
    --source-sha "$SOURCE_SHA" \
    --producer-run-id 700 \
    --profile held >/dev/null 2>&1; then
  fail "held runtime accepted an extra mount schema field"
fi

over_boundary_capacity="$work_dir/checkpoint-over-boundary-capacity.json"
cat >"$over_boundary_capacity" <<'JSON'
{"schemaVersion":"k3s-node-filesystem-capacity.v1","nodeName":"fixture-k3s","capacityBytes":50000000000,"usedBytes":35000000001,"availableBytes":14999999999,"usedPercent":70.0,"thresholdPercent":70,"withinLimit":false}
JSON
over_boundary_runtime="$work_dir/checkpoint-over-boundary-runtime.json"
jq '
  .root.mount.used = 35000000001 |
  .root.mount.avail = 14999999999 |
  .root.df.usedBytes = 35000000001 |
  .root.df.availableBytes = 14999999999 |
  .root.df.usedPercent = 70
' "$checkpoint_runtime" >"$over_boundary_runtime"
if "$HELPER" revalidate-release-checkpoint \
    --checkpoint "$checkpoint" \
    --runtime "$over_boundary_runtime" \
    --capacity "$over_boundary_capacity" \
    --candidate-images "$candidate_images" \
    --source-sha "$SOURCE_SHA" \
    --producer-run-id 700 \
    --profile public >/dev/null 2>&1; then
  fail "one byte above 70 percent passed release revalidation"
fi

missing_candidate_runtime="$work_dir/checkpoint-missing-candidate.json"
jq 'del(.images[0])' "$checkpoint_runtime" >"$missing_candidate_runtime"
missing_candidate_checkpoint="$work_dir/checkpoint-missing-candidate-output.json"
"$HELPER" write-release-checkpoint \
  --diagnosis "$checkpoint_diagnosis" \
  --runtime "$missing_candidate_runtime" \
  --capacity "$checkpoint_capacity" \
  --source-sha "$SOURCE_SHA" \
  --control-sha "$SOURCE_SHA" \
  --producer-run-id 700 \
  --output "$missing_candidate_checkpoint" >/dev/null
[[ ! -e "$missing_candidate_checkpoint" ]] ||
  fail "checkpoint was emitted with incomplete candidate residency"

unhealthy_runtime="$work_dir/checkpoint-unhealthy-runtime.json"
jq '.workload.unhealthyPodCount = 1' \
  "$checkpoint_runtime" >"$unhealthy_runtime"
unhealthy_checkpoint="$work_dir/checkpoint-unhealthy-output.json"
if "$HELPER" write-release-checkpoint \
    --diagnosis "$checkpoint_diagnosis" \
    --runtime "$unhealthy_runtime" \
    --capacity "$checkpoint_capacity" \
    --source-sha "$SOURCE_SHA" \
    --control-sha "$SOURCE_SHA" \
    --producer-run-id 700 \
    --output "$unhealthy_checkpoint" >/dev/null 2>&1; then
  fail "unhealthy public state was accepted for a release checkpoint"
fi
[[ ! -e "$unhealthy_checkpoint" ]] ||
  fail "unhealthy public state emitted a release checkpoint"

post_apt_v2="$work_dir/post-apt-v2.json"
python3 - "$post_apt" "$candidate_images" "$post_apt_v2" <<'PY'
import json
import sys
from pathlib import Path

runtime_path, candidates_path, output_path = map(Path, sys.argv[1:])
runtime = json.loads(runtime_path.read_text())
candidates = [raw.split("\t") for raw in candidates_path.read_text().splitlines()]
runtime["schemaVersion"] = "k3s-node-disk-runtime.v2"
runtime["snapshotProfile"] = "public"
runtime["applicationImages"] = [
    {"service": row[0], "imageRef": row[2]}
    for row in candidates
]
runtime["images"] = [
    {
        "id": row[4],
        "repoTags": [],
        "repoDigests": [row[2]],
        "sizeBytes": 1000,
        "pinned": False,
    }
    for row in candidates
]
runtime["containerImageReferences"] = []
runtime["kubernetesImageReferences"] = [row[2] for row in candidates]
output_path.write_text(json.dumps(runtime, sort_keys=True))
PY
apt_checkpoint="$work_dir/apt-checkpoint.json"
"$HELPER" write-release-checkpoint \
  --diagnosis "$diagnosis" \
  --reclaim "$work_dir/apt-result.json" \
  --runtime "$post_apt_v2" \
  --capacity "$post_capacity" \
  --source-sha "$SOURCE_SHA" \
  --control-sha "$SOURCE_SHA" \
  --producer-run-id 701 \
  --output "$apt_checkpoint" >/dev/null
jq -e '
  .disposition == "READY_RECLAIMED" and
  .reclaimCategory == "apt-package-cache" and
  .reclaimRunId == "701" and
  (.reclaimChecksumSha256 | test("^[0-9a-f]{64}$"))
' "$apt_checkpoint" >/dev/null ||
  fail "APT-only reclaim did not produce the fixed eligible disposition"

cri_checkpoint="$work_dir/cri-checkpoint.json"
"$HELPER" write-release-checkpoint \
  --diagnosis "$diagnosis" \
  --reclaim "$work_dir/cri-result.json" \
  --runtime "$post_apt_v2" \
  --capacity "$post_capacity" \
  --source-sha "$SOURCE_SHA" \
  --control-sha "$SOURCE_SHA" \
  --producer-run-id 702 \
  --output "$cri_checkpoint" >/dev/null
[[ ! -e "$cri_checkpoint" ]] ||
  fail "CRI reclaim produced a release-eligible checkpoint"

tampered_checkpoint="$work_dir/checkpoint-tampered.json"
jq '.root.usedBytes -= 1' "$checkpoint" >"$tampered_checkpoint"
if "$HELPER" validate-release-checkpoint \
    --checkpoint "$tampered_checkpoint" \
    --source-sha "$SOURCE_SHA" \
    --producer-run-id 700 \
    --runtime-mode k3s >/dev/null 2>&1; then
  fail "checkpoint checksum substitution was accepted"
fi
if "$HELPER" validate-release-checkpoint \
    --checkpoint "$checkpoint" \
    --source-sha 2222222222222222222222222222222222222222 \
    --producer-run-id 700 \
    --runtime-mode k3s >/dev/null 2>&1; then
  fail "checkpoint source identity mismatch was accepted"
fi

oke_checkpoint="$work_dir/oke-checkpoint.json"
"$HELPER" write-not-applicable-checkpoint \
  --source-sha "$SOURCE_SHA" \
  --control-sha "$SOURCE_SHA" \
  --infrastructure-run-id 800 \
  --ghcr-build-run-id 300 \
  --producer-run-id 800 \
  --output "$oke_checkpoint"
"$HELPER" validate-release-checkpoint \
  --checkpoint "$oke_checkpoint" \
  --source-sha "$SOURCE_SHA" \
  --producer-run-id 800 \
  --runtime-mode oke \
  --infrastructure-run-id 800 \
  --ghcr-build-run-id 300 >/dev/null
jq -e '
  .runtimeMode == "oke" and
  .disposition == "NOT_APPLICABLE" and
  .terminalStatus == "RELEASE_ELIGIBLE" and
  ((keys | sort) == ([
    "contentChecksumSha256",
    "controlSha",
    "disposition",
    "ghcrBuildRunId",
    "infrastructureRunId",
    "producerRunAttempt",
    "producerRunId",
    "runtimeMode",
    "schemaVersion",
    "sourceSha",
    "terminalStatus"
  ] | sort))
' "$oke_checkpoint" >/dev/null ||
  fail "OKE checkpoint fabricated disk fields"

PYTHONDONTWRITEBYTECODE=1 python3 -I - \
  "$HELPER" "$checkpoint" "$oke_checkpoint" <<'PY'
import copy
import importlib.util
import json
import sys
from pathlib import Path

helper_path, k3s_path, oke_path = sys.argv[1:]
spec = importlib.util.spec_from_file_location("k3s_disk_recovery", helper_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
k3s = json.loads(Path(k3s_path).read_text(encoding="utf-8"))
oke = json.loads(Path(oke_path).read_text(encoding="utf-8"))
module.validate_release_checkpoint(k3s)
module.validate_release_checkpoint(oke)


def reseal(value):
    value.pop("contentChecksumSha256", None)
    value["contentChecksumSha256"] = module.checksum(value)
    return value


alternates = []
ready = copy.deepcopy(k3s)
ready["terminalStatus"] = "READY"
alternates.append(ready)
healthy = copy.deepcopy(k3s)
healthy["publicStateStatus"] = "HEALTHY"
alternates.append(healthy)
nested = copy.deepcopy(k3s)
nested["root"]["thresholdPercent"] = nested.pop("thresholdPercent")
alternates.append(nested)
old_checksums = copy.deepcopy(k3s)
old_checksums["diagnosisSha256"] = old_checksums.pop(
    "diagnosisChecksumSha256"
)
old_checksums["reclaimSha256"] = old_checksums.pop(
    "reclaimChecksumSha256"
)
alternates.append(old_checksums)
old_oke = copy.deepcopy(oke)
old_oke["terminalStatus"] = "NOT_APPLICABLE"
alternates.append(old_oke)

for alternate in alternates:
    try:
        module.validate_release_checkpoint(reseal(alternate))
    except SystemExit:
        continue
    raise AssertionError("alternate release checkpoint schema passed")
PY

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
  if [[ -n "${STUB_CAPACITY_LOG:-}" ]]; then
    printf 'capacity\n' >>"$STUB_CAPACITY_LOG"
  fi
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
  preload-candidate-images)
    jq -e '
      type == "array" and length == 10 and
      all(.[]; type == "string")
    ' <<<"$selected" >/dev/null
    if [[ -n "${STUB_PRELOAD_POST_RUNTIME:-}" ]]; then
      cp "$STUB_PRELOAD_POST_RUNTIME" "${STUB_CURRENT_RUNTIME:?}"
    fi
    if [[ -n "${STUB_PRELOAD_POST_SUMMARY:-}" ]]; then
      cp "$STUB_PRELOAD_POST_SUMMARY" "${STUB_CURRENT_SUMMARY:?}"
    fi
    exit "${STUB_PRELOAD_STATUS:-0}"
    ;;
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
  snapshot|snapshot-held)
    if [[ "${STUB_POST_CAPTURE_STATUS:-0}" != "0" &&
          "$(awk '$1 == "snapshot" {count++} END {print count+0}' "$STUB_REMOTE_LOG")" == "2" ]]; then
      exit "$STUB_POST_CAPTURE_STATUS"
    fi
    if [[ -n "${STUB_SNAPSHOT_RUNNER:-}" &&
          "$(awk '$1 == "snapshot" {count++} END {print count+0}' "$STUB_REMOTE_LOG")" == "$STUB_SNAPSHOT_AT" ]]; then
      exec "$STUB_SNAPSHOT_RUNNER"
    fi
    cat "${STUB_CURRENT_RUNTIME:?}"
    ;;
  reclaim-cri-owned-unused-images)
    cp "${STUB_POST_RUNTIME:?}" "${STUB_CURRENT_RUNTIME:?}"
    cp "${STUB_POST_SUMMARY:?}" "${STUB_CURRENT_SUMMARY:?}"
    ;;
  reclaim-apt-package-cache)
    [[ "${STUB_APT_STATUS:-0}" == "0" ]] || exit "$STUB_APT_STATUS"
    cp "${STUB_APT_POST_RUNTIME:-${STUB_POST_RUNTIME:?}}" \
      "${STUB_CURRENT_RUNTIME:?}"
    cp "${STUB_APT_POST_SUMMARY:-${STUB_POST_SUMMARY:?}}" \
      "${STUB_CURRENT_SUMMARY:?}"
    ;;
  reclaim-system-journal)
    [[ "$selected" == "[]" ]]
    [[ "${STUB_JOURNAL_STATUS:-0}" == "0" ]] || exit "$STUB_JOURNAL_STATUS"
    if [[ -n "${STUB_JOURNAL_REMOTE:-}" ]]; then
      "$STUB_JOURNAL_REMOTE" reclaim-system-journal "$selected"
    fi
    cp "${STUB_JOURNAL_POST_RUNTIME:?}" "${STUB_CURRENT_RUNTIME:?}"
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
source_sha=1111111111111111111111111111111111111111
infrastructure_run_id=400
infrastructure_run_attempt=1
ghcr_build_run_id=300
infrastructure_finalized=true
runtime_mode=k3s
instance_ocid=ocid1.instance.oc1..test
instance_fingerprint=0938f1aad31453e408d76d875f5348a89c4e9a4c636f5ca1c4c23e4eb8945ab3
instance_private_ip=10.0.0.2
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

access_producer="$work_dir/access-producer.sh"
python3 - "$ROOT_DIR/infra/oci/scripts/configure-k3s-access.sh" \
  "$access_producer" <<'PY'
from pathlib import Path
import re
import sys

source = Path(sys.argv[1]).read_text(encoding="utf-8")
parts = [next(line for line in source.splitlines()
              if line.startswith('OCI_K3S_RETAIN_TARGET_SSH='))]
for name in ("write_session_state", "release_target_ssh_key"):
    match = re.search(rf"^{name}\(\) \{{\n.*?^\}}$", source, re.M | re.S)
    assert match, f"missing access producer function: {name}"
    parts.append(match.group())
parts.append("write_session_state")
release = re.search(
    r'^if \[\[ "\$OCI_K3S_RETAIN_TARGET_SSH" == "false" \]\]; then\n.*?^fi$',
    source, re.M | re.S,
)
assert release, "missing default target-key removal"
parts.append(release.group())
Path(sys.argv[2]).write_text("\n".join(parts) + "\n", encoding="utf-8")
PY

produce_access_state() (
  local key_dir="$1" OCI_K3S_RETAIN_TARGET_SSH="$2"
  local SESSION_STATE_FILE="$key_dir/session.env"
  local target_private_key="$key_dir/key" target_public_key="$key_dir/key.pub"
  local target_known_hosts="$key_dir/known-hosts"
  local bastion_ocid=ocid1.bastion.oc1.fixture
  local ssh_session_id=ocid1.bastionsession.oc1.fixture ssh_session_name=fixture
  local ssh_tunnel_pid="$tunnel_pid" api_tunnel_pid="$tunnel_pid"
  local bastion_endpoint=fixture.example
  local instance_ocid=ocid1.instance.oc1..test instance_private_ip=10.0.0.2
  local OCI_K3S_OS_USER=ubuntu OCI_K3S_LOCAL_SSH_PORT=12222
  oci_die() { fail "$@"; }
  mkdir -p "$key_dir"
  touch "$target_private_key" "$target_public_key" "$target_known_hosts"
  source "$access_producer"
)

jq '{node:{fs:{capacityBytes,usedBytes,availableBytes}}}' \
  "$checkpoint_capacity" >"$work_dir/access-capacity-summary.json"
for workflow in oci-live-data-rollout.yml oci-production-deploy.yml; do
  retain="$(
    python3 - "$ROOT_DIR/.github/workflows/$workflow" <<'PY'
from pathlib import Path
import re
import sys

workflow = Path(sys.argv[1]).read_text(encoding="utf-8")
start = workflow.index("      - name: Open ephemeral OCI Bastion access to k3s")
end = workflow.index("\n      - name:", start + 1)
setting = re.search(
    r'^          OCI_K3S_RETAIN_TARGET_SSH: "(true|false)"$',
    workflow[start:end], re.M,
)
print(setting.group(1) if setting else "")
PY
  )"
  access_dir="$work_dir/$workflow-access"
  profile=public
  snapshot="$checkpoint_runtime"
  expected_snapshot=snapshot
  if [[ "$workflow" == "oci-production-deploy.yml" ]]; then
    profile=held
    snapshot="$held_runtime"
    expected_snapshot=snapshot-held
  fi
  produce_access_state "$access_dir" "$retain"
  : >"$work_dir/remote.log"
  env "${common_env[@]}" \
    SESSION_STATE_FILE="$access_dir/session.env" \
    STUB_CURRENT_RUNTIME="$snapshot" \
    STUB_CAPACITY_SUMMARY="$work_dir/access-capacity-summary.json" \
    GITHUB_RUN_ID=710 CONTROL_SHA="$SOURCE_SHA" \
    CHECKPOINT_FILE="$checkpoint" DISK_CHECKPOINT_RUN_ID=700 \
    REVALIDATION_PROFILE="$profile" \
    "$ORCHESTRATOR" revalidate >"$access_dir/revalidate.log" 2>&1 || {
      cat "$access_dir/revalidate.log" >&2
      fail "$workflow cannot revalidate with its actual access producer state"
    }
  [[ "$(cut -f1 "$work_dir/remote.log")" == "$expected_snapshot" ]] ||
    fail "$workflow did not use only its required read-only snapshot profile"

  produce_access_state "$access_dir" ""
  [[ ! -e "$access_dir/key" && ! -e "$access_dir/key.pub" &&
     ! -e "$access_dir/known-hosts" ]] ||
    fail "default API-only access retained target SSH key material"
  : >"$work_dir/remote.log"
  if env "${common_env[@]}" \
      SESSION_STATE_FILE="$access_dir/session.env" \
      STUB_CURRENT_RUNTIME="$snapshot" \
      STUB_CAPACITY_SUMMARY="$work_dir/access-capacity-summary.json" \
      GITHUB_RUN_ID=710 CONTROL_SHA="$SOURCE_SHA" \
      CHECKPOINT_FILE="$checkpoint" DISK_CHECKPOINT_RUN_ID=700 \
      REVALIDATION_PROFILE="$profile" \
      "$ORCHESTRATOR" revalidate >"$access_dir/default.log" 2>&1; then
    fail "$workflow accepted the default access state without target SSH keys"
  fi
  grep -Fq 'k3s access state is incomplete' "$access_dir/default.log" ||
    fail "$workflow failed outside the expected missing-access boundary"
  [[ ! -s "$work_dir/remote.log" ]] ||
    fail "$workflow reached the node after its target SSH keys were removed"
done

preload_wrapper_output="$work_dir/preload-wrapper-output.json"
preload_wrapper_checkpoint="$work_dir/preload-wrapper-checkpoint.json"
: >"$work_dir/remote.log"
env "${common_env[@]}" \
  GITHUB_RUN_ID=400 \
  CONTROL_SHA="$SOURCE_SHA" \
  OUTPUT_FILE="$preload_wrapper_output" \
  CHECKPOINT_OUTPUT_FILE="$preload_wrapper_checkpoint" \
  RECLAIM_CATEGORY=none \
  RECLAIM_IMAGE_IDS='[]' \
  "$ORCHESTRATOR" preload >"$work_dir/preload-wrapper-success.log"
[[ "$(awk -F '\t' '$1 == "preload-candidate-images" {count++} END {print count+0}' "$work_dir/remote.log")" == "1" ]] ||
  fail "preload wrapper did not issue exactly one remote preload action"
cut -f2- "$work_dir/remote.log" >"$work_dir/preload-wrapper-transport.json"
cmp "$candidate_cases/actual.json" "$work_dir/preload-wrapper-transport.json" ||
  fail "preload wrapper did not transport the complete canonical candidate payload"
if grep -Eq 'snapshot|mongo-storage|diagnos|reclaim' "$work_dir/remote.log" ||
   [[ -e "$preload_wrapper_output" || -e "$preload_wrapper_checkpoint" ]]; then
  fail "preload wrapper performed diagnosis, reclaim, snapshot, Mongo, or output work"
fi

: >"$work_dir/remote.log"
preload_wrapper_status=0
env "${common_env[@]}" \
  GITHUB_RUN_ID=400 \
  CONTROL_SHA="$SOURCE_SHA" \
  STUB_PRELOAD_STATUS=20 \
  "$ORCHESTRATOR" preload >"$work_dir/preload-wrapper-20.log" 2>&1 ||
  preload_wrapper_status=$?
[[ "$preload_wrapper_status" == "20" &&
   "$(awk -F '\t' '$1 == "preload-candidate-images" {count++} END {print count+0}' "$work_dir/remote.log")" == "1" ]] ||
  fail "preload wrapper did not preserve remote candidacy status 20"

: >"$work_dir/remote.log"
preload_wrapper_status=0
env "${common_env[@]}" \
  GITHUB_RUN_ID=400 \
  CONTROL_SHA="$SOURCE_SHA" \
  STUB_PRELOAD_STATUS=42 \
  "$ORCHESTRATOR" preload >"$work_dir/preload-wrapper-fatal.log" 2>&1 ||
  preload_wrapper_status=$?
[[ "$preload_wrapper_status" == "42" &&
   "$(awk -F '\t' '$1 == "preload-candidate-images" {count++} END {print count+0}' "$work_dir/remote.log")" == "1" ]] ||
  fail "preload wrapper collapsed a fatal remote status into candidacy"

: >"$work_dir/remote.log"
preload_wrapper_status=0
env "${common_env[@]}" \
  GITHUB_RUN_ID=400 \
  CONTROL_SHA="$SOURCE_SHA" \
  CANDIDATE_IMAGES_FILE="$candidate_cases/tag.tsv" \
  "$ORCHESTRATOR" preload >"$work_dir/preload-wrapper-invalid.log" 2>&1 ||
  preload_wrapper_status=$?
[[ "$preload_wrapper_status" == "20" && ! -s "$work_dir/remote.log" ]] ||
  fail "invalid local candidate evidence reached the preload transport"

local_guard_bin="$work_dir/local-guard-bin"
mkdir -p "$local_guard_bin"
cat >"$local_guard_bin/python3" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == */k3s_disk_recovery_stan.py ]]
[[ "$2" == "candidate-image-refs" ]]
printf '%s\n' "${STUB_CANDIDATE_REFS:?}"
SH
chmod +x "$local_guard_bin/python3"
: >"$work_dir/remote.log"
preload_wrapper_status=0
env "${common_env[@]}" \
  PATH="$local_guard_bin:$stub_bin:$PATH" \
  STUB_CANDIDATE_REFS="$trailing_lf_candidate_refs" \
  GITHUB_RUN_ID=400 \
  CONTROL_SHA="$SOURCE_SHA" \
  "$ORCHESTRATOR" preload >"$work_dir/preload-wrapper-trailing-lf.log" 2>&1 ||
  preload_wrapper_status=$?
[[ "$preload_wrapper_status" != "0" && ! -s "$work_dir/remote.log" ]] ||
  fail "local candidate guard normalized a final-element trailing-LF reference"

for authority_case in \
  "RECLAIM_CATEGORY=apt-package-cache" \
  "CONTROL_SHA=2222222222222222222222222222222222222222" \
  "GITHUB_RUN_ATTEMPT=2"; do
  : >"$work_dir/remote.log"
  preload_wrapper_status=0
  env "${common_env[@]}" \
    GITHUB_RUN_ID=400 \
    CONTROL_SHA="$SOURCE_SHA" \
    "$authority_case" \
    "$ORCHESTRATOR" preload >"$work_dir/preload-wrapper-authority.log" 2>&1 ||
    preload_wrapper_status=$?
  [[ "$preload_wrapper_status" != "0" &&
     "$preload_wrapper_status" != "20" &&
     ! -s "$work_dir/remote.log" ]] ||
    fail "preload wrapper accepted mismatched authority: $authority_case"
done

for provenance_override in \
  "source_sha=2222222222222222222222222222222222222222" \
  "infrastructure_run_id=401" \
  "ghcr_build_run_id=301" \
  "infrastructure_finalized=false" \
  "instance_fingerprint=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; do
  preload_provenance="$work_dir/preload-provenance.env"
  cp "$work_dir/infrastructure.env" "$preload_provenance"
  printf '%s\n' "$provenance_override" >>"$preload_provenance"
  : >"$work_dir/remote.log"
  preload_wrapper_status=0
  env "${common_env[@]}" \
    GITHUB_RUN_ID=400 \
    CONTROL_SHA="$SOURCE_SHA" \
    INFRA_PROVENANCE_FILE="$preload_provenance" \
    "$ORCHESTRATOR" preload >"$work_dir/preload-wrapper-provenance.log" 2>&1 ||
    preload_wrapper_status=$?
  [[ "$preload_wrapper_status" != "0" &&
     "$preload_wrapper_status" != "20" &&
     ! -s "$work_dir/remote.log" ]] ||
    fail "preload wrapper accepted mismatched finalized provenance: $provenance_override"
done

for session_override in \
  "instance_ocid=ocid1.instance.oc1..other" \
  "instance_private_ip=10.0.0.3"; do
  preload_session="$work_dir/preload-session.env"
  cp "$work_dir/session.env" "$preload_session"
  printf '%s\n' "$session_override" >>"$preload_session"
  : >"$work_dir/remote.log"
  preload_wrapper_status=0
  env "${common_env[@]}" \
    GITHUB_RUN_ID=400 \
    CONTROL_SHA="$SOURCE_SHA" \
    SESSION_STATE_FILE="$preload_session" \
    "$ORCHESTRATOR" preload >"$work_dir/preload-wrapper-session.log" 2>&1 ||
    preload_wrapper_status=$?
  [[ "$preload_wrapper_status" != "0" &&
     "$preload_wrapper_status" != "20" &&
     ! -s "$work_dir/remote.log" ]] ||
    fail "preload wrapper accepted mismatched access session: $session_override"
done

env "${common_env[@]}" \
  GITHUB_RUN_ID=500 \
  RECLAIM_CATEGORY=none \
  RECLAIM_IMAGE_IDS='[]' \
  OUTPUT_FILE="$work_dir/orchestrated-diagnosis.json" \
  "$ORCHESTRATOR" diagnose >/dev/null

apt_orchestrator_cases="$work_dir/apt-orchestrator-cases"
mkdir -p "$apt_orchestrator_cases"
python3 - "$post_apt" "$work_dir/orchestrated-diagnosis.json" \
  "$apt_orchestrator_cases" <<'PY'
import copy
import json
import sys
from pathlib import Path

runtime_path, diagnosis_path, output_path = map(Path, sys.argv[1:])
runtime = json.loads(runtime_path.read_text())
diagnosis = json.loads(diagnosis_path.read_text())
output_path.mkdir(exist_ok=True)
candidates = sorted(diagnosis["candidateImages"], key=lambda row: row["service"])


def candidate_image(index, candidate):
    return {
        "id": "sha256:" + f"{950 + index:064d}",
        "repoTags": [],
        "repoDigests": [candidate["imageRef"]],
        "sizeBytes": 1000,
        "pinned": False,
    }


def write(name, candidate_count, *, used=34_500_000_000):
    value = copy.deepcopy(runtime)
    value["schemaVersion"] = "k3s-node-disk-runtime.v2"
    value["snapshotProfile"] = "public"
    value["applicationImages"] = [
        {"service": row["service"], "imageRef": row["imageRef"]}
        for row in candidates
    ]
    value["images"].extend(
        candidate_image(index, candidate)
        for index, candidate in enumerate(candidates[:candidate_count], start=1)
    )
    value["root"]["mount"]["used"] = used
    value["root"]["mount"]["avail"] = value["root"]["mount"]["size"] - used
    value["root"]["df"]["usedBytes"] = used
    value["root"]["df"]["availableBytes"] = (
        value["root"]["df"]["capacityBytes"] - used
    )
    value["root"]["df"]["usedPercent"] = used * 100 / value["root"]["df"]["capacityBytes"]
    (output_path / f"{name}.json").write_text(json.dumps(value, sort_keys=True))


write("complete", len(candidates))
write("partial", 1)
write("over-limit", 1, used=35_500_000_000)
PY
cat >"$work_dir/summary-over.json" <<'JSON'
{"node":{"fs":{"capacityBytes":50000000000,"usedBytes":35500000000,"availableBytes":14500000000}}}
JSON

cp "$runtime" "$work_dir/current-runtime.json"
cp "$work_dir/summary-before.json" "$work_dir/current-summary.json"
: >"$work_dir/remote.log"
env "${common_env[@]}" \
  GITHUB_RUN_ID=501 \
  DIAGNOSIS_RUN_ID=500 \
  DIAGNOSIS_FILE="$work_dir/orchestrated-diagnosis.json" \
  CANDIDATE_IMAGES_FILE="$candidate_cases/different-valid.tsv" \
  RECLAIM_CATEGORY=apt-package-cache \
  RECLAIM_IMAGE_IDS='[]' \
  STUB_APT_POST_RUNTIME="$post_apt" \
  STUB_PRELOAD_POST_RUNTIME="$apt_orchestrator_cases/complete.json" \
  OUTPUT_FILE="$work_dir/orchestrated-apt-reclaim.json" \
  CHECKPOINT_OUTPUT_FILE="$work_dir/orchestrated-apt-checkpoint.json" \
  "$ORCHESTRATOR" reclaim >"$work_dir/orchestrated-apt-success.log"
printf '%s\n' snapshot reclaim-apt-package-cache preload-candidate-images snapshot \
  >"$work_dir/expected-apt-actions"
awk -F '\t' '{print $1}' "$work_dir/remote.log" >"$work_dir/actual-apt-actions"
cmp "$work_dir/expected-apt-actions" "$work_dir/actual-apt-actions" ||
  fail "APT reclaim did not preserve exact snapshot-clean-preload-snapshot order"
[[ "$(awk -F '\t' '$1 == "reclaim-apt-package-cache" {count++} END {print count+0}' "$work_dir/remote.log")" == "1" &&
   "$(awk -F '\t' '$1 == "preload-candidate-images" {count++} END {print count+0}' "$work_dir/remote.log")" == "1" ]] ||
  fail "APT reclaim did not issue exactly one cleanup and one candidate preload"
jq -c '[.candidateImages | sort_by(.service)[] | .imageRef]' \
  "$work_dir/orchestrated-diagnosis.json" >"$work_dir/diagnosis-candidate-refs.json"
awk -F '\t' '$1 == "preload-candidate-images" {print $2}' \
  "$work_dir/remote.log" >"$work_dir/orchestrated-apt-preload-refs.json"
cmp "$work_dir/diagnosis-candidate-refs.json" \
  "$work_dir/orchestrated-apt-preload-refs.json" ||
  fail "APT preload used current candidate TSV instead of the bound diagnosis"
jq -e '
  .terminalStatus == "RECLAIMED" and
  .unexpectedAddedImageIds == [] and
  .removedImageIds == []
' "$work_dir/orchestrated-apt-reclaim.json" >/dev/null ||
  fail "successful diagnosis-bound APT preload lacked reclaim evidence"
jq -e '
  .terminalStatus == "RELEASE_ELIGIBLE" and
  .disposition == "READY_RECLAIMED" and
  (.candidateResidency | length) == 10
' "$work_dir/orchestrated-apt-checkpoint.json" >/dev/null ||
  fail "successful diagnosis-bound APT preload lacked an eligible checkpoint"

cp "$runtime" "$work_dir/current-runtime.json"
cp "$work_dir/summary-before.json" "$work_dir/current-summary.json"
: >"$work_dir/remote.log"
printf 'stale\n' >"$work_dir/orchestrated-apt-20-checkpoint.json"
env "${common_env[@]}" \
  GITHUB_RUN_ID=502 \
  DIAGNOSIS_RUN_ID=500 \
  DIAGNOSIS_FILE="$work_dir/orchestrated-diagnosis.json" \
  RECLAIM_CATEGORY=apt-package-cache \
  RECLAIM_IMAGE_IDS='[]' \
  STUB_APT_POST_RUNTIME="$post_apt" \
  STUB_PRELOAD_POST_RUNTIME="$apt_orchestrator_cases/partial.json" \
  STUB_PRELOAD_STATUS=20 \
  OUTPUT_FILE="$work_dir/orchestrated-apt-20-reclaim.json" \
  CHECKPOINT_OUTPUT_FILE="$work_dir/orchestrated-apt-20-checkpoint.json" \
  "$ORCHESTRATOR" reclaim >"$work_dir/orchestrated-apt-20.log" 2>&1
jq -e '
  .terminalStatus == "RECLAIMED" and
  .unexpectedAddedImageIds == []
' "$work_dir/orchestrated-apt-20-reclaim.json" >/dev/null ||
  fail "status-20 candidate preload did not finalize valid APT postconditions"
[[ ! -e "$work_dir/orchestrated-apt-20-checkpoint.json" &&
   "$(grep -Fxc 'k3s_release_disk_checkpoint=INELIGIBLE reason=candidate_preload' "$work_dir/orchestrated-apt-20.log")" == "1" &&
   "$(awk -F '\t' '$1 == "preload-candidate-images" {count++} END {print count+0}' "$work_dir/remote.log")" == "1" &&
   "$(awk -F '\t' '$1 == "snapshot" {count++} END {print count+0}' "$work_dir/remote.log")" == "2" ]] ||
  fail "status-20 candidate preload retried, skipped post evidence, or retained a checkpoint"

cp "$runtime" "$work_dir/current-runtime.json"
cp "$work_dir/summary-before.json" "$work_dir/current-summary.json"
: >"$work_dir/remote.log"
printf 'stale\n' >"$work_dir/orchestrated-apt-over-checkpoint.json"
apt_over_status=0
env "${common_env[@]}" \
  GITHUB_RUN_ID=503 \
  DIAGNOSIS_RUN_ID=500 \
  DIAGNOSIS_FILE="$work_dir/orchestrated-diagnosis.json" \
  RECLAIM_CATEGORY=apt-package-cache \
  RECLAIM_IMAGE_IDS='[]' \
  STUB_APT_POST_RUNTIME="$post_apt" \
  STUB_PRELOAD_POST_RUNTIME="$apt_orchestrator_cases/over-limit.json" \
  STUB_PRELOAD_POST_SUMMARY="$work_dir/summary-over.json" \
  STUB_PRELOAD_STATUS=20 \
  OUTPUT_FILE="$work_dir/orchestrated-apt-over-reclaim.json" \
  CHECKPOINT_OUTPUT_FILE="$work_dir/orchestrated-apt-over-checkpoint.json" \
  "$ORCHESTRATOR" reclaim >"$work_dir/orchestrated-apt-over.log" 2>&1 ||
  apt_over_status=$?
[[ "$apt_over_status" != "0" &&
   ! -e "$work_dir/orchestrated-apt-over-checkpoint.json" &&
   "$(awk -F '\t' '$1 == "preload-candidate-images" {count++} END {print count+0}' "$work_dir/remote.log")" == "1" ]] ||
  fail "status-20 over-limit APT reclaim passed or retried preload"
jq -e '
  .terminalStatus == "INCOMPLETE" and
  .postKubeletCapacity.withinLimit == false
' "$work_dir/orchestrated-apt-over-reclaim.json" >/dev/null ||
  fail "status-20 over-limit APT reclaim lacked durable failure evidence"

cp "$runtime" "$work_dir/current-runtime.json"
cp "$work_dir/summary-before.json" "$work_dir/current-summary.json"
: >"$work_dir/remote.log"
apt_fatal_status=0
env "${common_env[@]}" \
  GITHUB_RUN_ID=504 \
  DIAGNOSIS_RUN_ID=500 \
  DIAGNOSIS_FILE="$work_dir/orchestrated-diagnosis.json" \
  RECLAIM_CATEGORY=apt-package-cache \
  RECLAIM_IMAGE_IDS='[]' \
  STUB_APT_POST_RUNTIME="$post_apt" \
  STUB_PRELOAD_POST_RUNTIME="$apt_orchestrator_cases/partial.json" \
  STUB_PRELOAD_STATUS=42 \
  OUTPUT_FILE="$work_dir/orchestrated-apt-fatal-reclaim.json" \
  CHECKPOINT_OUTPUT_FILE="$work_dir/orchestrated-apt-fatal-checkpoint.json" \
  "$ORCHESTRATOR" reclaim >"$work_dir/orchestrated-apt-fatal.log" 2>&1 ||
  apt_fatal_status=$?
[[ "$apt_fatal_status" == "42" &&
   ! -e "$work_dir/orchestrated-apt-fatal-checkpoint.json" &&
   "$(awk -F '\t' '$1 == "preload-candidate-images" {count++} END {print count+0}' "$work_dir/remote.log")" == "1" &&
   "$(awk -F '\t' '$1 == "snapshot" {count++} END {print count+0}' "$work_dir/remote.log")" == "2" ]] ||
  fail "fatal APT candidate preload was retried, collapsed, or skipped post evidence"
jq -e '.terminalStatus == "RECLAIMED"' \
  "$work_dir/orchestrated-apt-fatal-reclaim.json" >/dev/null ||
  fail "fatal APT candidate preload lacked finalized reclaim evidence"
if grep -Fq 'k3s_release_disk_checkpoint=INELIGIBLE reason=candidate_preload' \
    "$work_dir/orchestrated-apt-fatal.log"; then
  fail "fatal APT candidate preload was converted to candidacy status 20"
fi

cp "$runtime" "$work_dir/current-runtime.json"
cp "$work_dir/summary-before.json" "$work_dir/current-summary.json"
: >"$work_dir/remote.log"
apt_failure_status=0
env "${common_env[@]}" \
  GITHUB_RUN_ID=505 \
  DIAGNOSIS_RUN_ID=500 \
  DIAGNOSIS_FILE="$work_dir/orchestrated-diagnosis.json" \
  RECLAIM_CATEGORY=apt-package-cache \
  RECLAIM_IMAGE_IDS='[]' \
  STUB_APT_STATUS=41 \
  OUTPUT_FILE="$work_dir/orchestrated-apt-failure-reclaim.json" \
  "$ORCHESTRATOR" reclaim >"$work_dir/orchestrated-apt-failure.log" 2>&1 ||
  apt_failure_status=$?
[[ "$apt_failure_status" != "0" &&
   "$(awk -F '\t' '$1 == "reclaim-apt-package-cache" {count++} END {print count+0}' "$work_dir/remote.log")" == "1" &&
   "$(awk -F '\t' '$1 == "preload-candidate-images" {count++} END {print count+0}' "$work_dir/remote.log")" == "0" &&
   "$(awk -F '\t' '$1 == "snapshot" {count++} END {print count+0}' "$work_dir/remote.log")" == "2" ]] ||
  fail "failed APT cleanup reached candidate preload or skipped post evidence"
jq -e '
  .terminalStatus == "INCOMPLETE" and
  .mutationCommandSucceeded == false
' "$work_dir/orchestrated-apt-failure-reclaim.json" >/dev/null ||
  fail "failed APT cleanup lacked durable incomplete evidence"

journal_bin="$work_dir/journal-bin"
mkdir -p "$journal_bin"
for command_name in bash base64 jq; do
  ln -s "$(command -v "$command_name")" "$journal_bin/$command_name"
done
cat >"$journal_bin/journalctl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$STUB_JOURNAL_LOG"
printf '/synthetic-private-journal/stdout-marker\n'
printf '/synthetic-private-journal/stderr-marker\n' >&2
case "$*" in
  --rotate) exit "${STUB_ROTATE_STATUS:-0}" ;;
  "--directory=/var/log/journal --vacuum-size=536870912") exit "${STUB_VACUUM_STATUS:-0}" ;;
  *) exit 99 ;;
esac
SH
chmod +x "$journal_bin/journalctl"

for journal_case in success candidacy candidacy-over fatal mutation-failure rotate-failure vacuum-failure \
  post-capture-failure fatal-post-capture candidacy-post-capture; do
  cp "$journal_cases/before.json" "$work_dir/current-runtime.json"
  cp "$work_dir/summary-before.json" "$work_dir/current-summary.json"
  : >"$work_dir/remote.log"
  : >"$work_dir/journal-capacity.log"
  : >"$work_dir/journal-command.log"
  journal_checkpoint="$work_dir/journal-$journal_case-checkpoint.json"
  journal_result="$work_dir/journal-$journal_case-reclaim.json"
  journal_log="$work_dir/journal-$journal_case.log"
  printf 'stale\n' >"$journal_checkpoint"
  journal_args=(
    STUB_JOURNAL_STATUS=0 STUB_PRELOAD_STATUS=0 STUB_POST_CAPTURE_STATUS=0
    STUB_ROTATE_STATUS=0 STUB_VACUUM_STATUS=0
    STUB_PRELOAD_POST_RUNTIME="$journal_cases/complete.json"
  )
  case "$journal_case" in
    candidacy | candidacy-post-capture)
      journal_args+=(STUB_PRELOAD_STATUS=20 STUB_PRELOAD_POST_RUNTIME="$journal_cases/partial.json")
      ;;
    candidacy-over)
      journal_args+=(STUB_PRELOAD_STATUS=20 STUB_PRELOAD_POST_RUNTIME="$journal_cases/over-limit.json"
        STUB_PRELOAD_POST_SUMMARY="$work_dir/summary-over.json")
      ;;
    fatal | fatal-post-capture)
      journal_args+=(STUB_PRELOAD_STATUS=42 STUB_PRELOAD_POST_RUNTIME="$journal_cases/partial.json")
      ;;
    mutation-failure)
      journal_args+=(STUB_JOURNAL_STATUS=41)
      ;;
    rotate-failure)
      journal_args+=(STUB_ROTATE_STATUS=41)
      ;;
    vacuum-failure)
      journal_args+=(STUB_VACUUM_STATUS=42)
      ;;
  esac
  case "$journal_case" in
    *post-capture*) journal_args+=(STUB_POST_CAPTURE_STATUS=43) ;;
  esac
  journal_status=0
  env "${common_env[@]}" \
    PATH="$journal_bin:$stub_bin:$PATH" \
    STUB_JOURNAL_REMOTE="$REMOTE" STUB_JOURNAL_LOG="$work_dir/journal-command.log" \
    GITHUB_RUN_ID=501 DIAGNOSIS_RUN_ID=500 \
    DIAGNOSIS_FILE="$journal_cases/diagnosis.json" \
    CANDIDATE_IMAGES_FILE="$candidate_cases/different-valid.tsv" \
    RECLAIM_CATEGORY=system-journal RECLAIM_IMAGE_IDS='[]' \
    STUB_JOURNAL_POST_RUNTIME="$journal_cases/cleaned.json" \
    STUB_CAPACITY_LOG="$work_dir/journal-capacity.log" \
    "${journal_args[@]}" OUTPUT_FILE="$journal_result" \
    CHECKPOINT_OUTPUT_FILE="$journal_checkpoint" \
    "$ORCHESTRATOR" reclaim >"$journal_log" 2>&1 || journal_status=$?
  expected_actions=$'snapshot\nreclaim-system-journal\npreload-candidate-images\nsnapshot'
  expected_commands=$'--rotate\n--directory=/var/log/journal --vacuum-size=536870912'
  case "$journal_case" in
    mutation-failure | rotate-failure | vacuum-failure)
      expected_actions=$'snapshot\nreclaim-system-journal\nsnapshot'
      case "$journal_case" in
        mutation-failure) expected_commands="" ;;
        rotate-failure) expected_commands=--rotate ;;
      esac
      ;;
  esac
  [[ "$(awk -F '\t' '{print $1}' "$work_dir/remote.log")" == "$expected_actions" &&
     "$(cat "$work_dir/journal-command.log")" == "$expected_commands" &&
     "$(wc -l <"$work_dir/journal-capacity.log" | tr -d ' ')" == "2" ]] ||
    fail "journal $journal_case changed single-mutation/preload order or skipped post capture"
  if grep -Fq '/synthetic-private-journal/' "$journal_log"; then
    fail "journal $journal_case exposed raw journalctl output through the orchestrator"
  fi
  jq -e '.category == "system-journal" and .selectedImageIds == []' \
    "$journal_result" >/dev/null ||
    fail "journal $journal_case lost bounded reclaim evidence"
  if [[ "$journal_case" != mutation-failure && "$journal_case" != rotate-failure &&
        "$journal_case" != vacuum-failure ]]; then
    awk -F '\t' '$1 == "preload-candidate-images" {print $2}' "$work_dir/remote.log" \
      >"$work_dir/journal-preload-refs.json"
    cmp "$work_dir/diagnosis-candidate-refs.json" "$work_dir/journal-preload-refs.json" ||
      fail "journal preload ignored diagnosis-bound, service-sorted candidate references"
  fi
  case "$journal_case" in
    success)
      [[ "$journal_status" == "0" ]] || fail "journal success failed: $(cat "$journal_log")"
      jq -e '.disposition == "READY_RECLAIMED" and .reclaimCategory == "system-journal"' \
        "$journal_checkpoint" >/dev/null || fail "journal success lacked its checkpoint"
      ;;
    candidacy)
      [[ "$journal_status" == "0" ]] || fail "valid status-20 journal reclaim became fatal"
      ;;
    fatal*)
      [[ "$journal_status" == "42" ]] || fail "journal fatal preload status was collapsed"
      ;;
    *)
      [[ "$journal_status" != "0" ]] || fail "journal failure passed: $journal_case"
      ;;
  esac
  if [[ "$journal_case" != success ]]; then
    [[ ! -e "$journal_checkpoint" ]] || fail "journal failure retained a checkpoint"
  fi
  case "$journal_case" in
    success | candidacy | fatal)
      jq -e '.terminalStatus == "RECLAIMED" and .unexpectedAddedImageIds == []' \
        "$journal_result" >/dev/null || fail "journal valid postconditions were not finalized"
      ;;
    *post-capture*)
      jq -e '.terminalStatus == "INCOMPLETE" and .reason == "post-state-capture-failed"' \
        "$journal_result" >/dev/null || fail "journal failed capture lacked incomplete evidence"
      ;;
    mutation-failure | rotate-failure | vacuum-failure)
      jq -e '.terminalStatus == "INCOMPLETE" and .mutationCommandSucceeded == false' \
        "$journal_result" >/dev/null || fail "journal command failure lost mutation status"
      ;;
    *)
      jq -e '.terminalStatus == "INCOMPLETE"' "$journal_result" >/dev/null ||
        fail "journal failed mutation or threshold lacked incomplete evidence"
      ;;
  esac
  case "$journal_case" in
    candidacy*)
      grep -Fxq 'k3s_release_disk_checkpoint=INELIGIBLE reason=candidate_preload' \
        "$journal_log" || fail "journal candidacy failure reason was lost"
      ;;
    fatal*)
      if grep -Fq 'reason=candidate_preload' "$journal_log"; then
        fail "journal fatal error was converted to candidacy status"
      fi
      ;;
  esac
done

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

for journal_command_case in success rotate-failure vacuum-failure; do
  : >"$work_dir/journal-command.log"
  journal_command_args=(STUB_ROTATE_STATUS=0 STUB_VACUUM_STATUS=0)
  expected_status=0
  expected_diagnostic=""
  expected_commands=$'--rotate\n--directory=/var/log/journal --vacuum-size=536870912'
  case "$journal_command_case" in
    rotate-failure)
      journal_command_args+=(STUB_ROTATE_STATUS=41)
      expected_status=41
      expected_commands=--rotate
      expected_diagnostic="k3s_disk_remote=reclaim-system-journal status=FAIL reason=system journal rotation failed"
      ;;
    vacuum-failure)
      journal_command_args+=(STUB_VACUUM_STATUS=42)
      expected_status=42
      expected_diagnostic="k3s_disk_remote=reclaim-system-journal status=FAIL reason=system journal vacuum failed"
      ;;
  esac
  journal_command_status=0
  env PATH="$journal_bin" STUB_JOURNAL_LOG="$work_dir/journal-command.log" \
    "${journal_command_args[@]}" "$REMOTE" reclaim-system-journal '[]' \
    >"$work_dir/journal-command.stdout" 2>"$work_dir/journal-command.stderr" ||
    journal_command_status=$?
  [[ "$journal_command_status" == "$expected_status" &&
     "$(cat "$work_dir/journal-command.log")" == "$expected_commands" ]] ||
    fail "journal commands were changed, reordered, retried, or fell through: $journal_command_case"
  [[ ! -s "$work_dir/journal-command.stdout" &&
     "$(cat "$work_dir/journal-command.stderr")" == "$expected_diagnostic" ]] ||
    fail "journal $journal_command_case exposed output other than fixed sanitized diagnostics"
done
for invalid_ids in "$selected" '[ ]' '{}'; do
  : >"$work_dir/journal-command.log"
  if PATH="$journal_bin" STUB_JOURNAL_LOG="$work_dir/journal-command.log" \
      "$REMOTE" reclaim-system-journal "$invalid_ids" >/dev/null 2>&1; then
    fail "journal mutation accepted nonliteral empty IDs"
  fi
  [[ ! -s "$work_dir/journal-command.log" ]] || fail "invalid IDs reached journalctl"
done
: >"$work_dir/journal-command.log"
if PATH="$journal_bin" STUB_JOURNAL_LOG="$work_dir/journal-command.log" \
    "$REMOTE" reclaim-system-journal '[]' --vacuum-size=1 >/dev/null 2>&1; then
  fail "journal mutation accepted caller arguments"
fi
[[ ! -s "$work_dir/journal-command.log" ]] || fail "caller arguments reached journalctl"
PATH="$journal_bin" STUB_JOURNAL_LOG="$work_dir/journal-command.log" \
  K3S_DISK_SELECTED_IMAGE_IDS_B64=W10= \
  "$REMOTE" reclaim-system-journal >"$work_dir/journal-encoded.log" 2>&1
[[ "$(cat "$work_dir/journal-command.log")" == \
   $'--rotate\n--directory=/var/log/journal --vacuum-size=536870912' ]] ||
  fail "journal encoded transport changed its literal commands"
[[ ! -s "$work_dir/journal-encoded.log" ]] ||
  fail "journal encoded transport exposed raw command output"

{
  sed -n '/^fail()/,/^}/p' "$REMOTE"
  sed -n '/^fixed_path_bytes()/,/^}/p' "$REMOTE"
} >"$work_dir/journal-path-helper.sh"
mkdir "$work_dir/journal-directory"
ln -s "$work_dir/journal-directory" "$work_dir/journal-link"
touch "$work_dir/journal-file"
for path_case in directory non-root aliased-parent symlink file missing \
  du-failure readlink-failure mount-failure; do
  journal_path="$work_dir/journal-directory"
  canonical_path="$journal_path"
  stub_mount_target=/
  expected_directory=true
  expected_root=true
  expected_failure=""
  case "$path_case" in
    non-root) stub_mount_target=/separate; expected_root=false ;;
    aliased-parent) canonical_path="$work_dir/elsewhere"; expected_directory=false; expected_root=false ;;
    symlink) journal_path="$work_dir/journal-link"; expected_directory=false; expected_root=false ;;
    file) journal_path="$work_dir/journal-file"; expected_directory=false; expected_root=false ;;
    missing) journal_path="$work_dir/journal-missing"; expected_directory=false; expected_root=false ;;
    du-failure) expected_failure="aggregate size measurement failed for system-journal" ;;
    readlink-failure) expected_failure="path resolution failed for system-journal" ;;
    mount-failure) expected_failure="mount measurement failed for system-journal" ;;
  esac
  path_status=0
  (
    source "$work_dir/journal-path-helper.sh"
    ACTION=snapshot
    readlink() { printf '%s\n' "$canonical_path"; [[ "$path_case" != readlink-failure ]]; }
    findmnt() { printf '%s\n' "$stub_mount_target"; [[ "$path_case" != mount-failure ]]; }
    du() { printf '1234567890\n'; [[ "$path_case" != du-failure ]]; }
    row="$(fixed_path_bytes system-journal "$journal_path")" || exit "$?"
    printf '%s\n' "$row"
  ) >"$work_dir/journal-path.stdout" 2>"$work_dir/journal-path.stderr" || path_status=$?
  if [[ -n "$expected_failure" ]]; then
    [[ "$path_status" != "0" && ! -s "$work_dir/journal-path.stdout" ]] ||
      fail "failed journal $path_case emitted accepted consumer evidence"
    grep -Fq "reason=$expected_failure" "$work_dir/journal-path.stderr" ||
      fail "journal $path_case failed for the wrong reason"
    continue
  fi
  [[ "$path_status" == "0" ]] || fail "journal path measurement failed: $path_case"
  jq -e --argjson directory "$expected_directory" --argjson root "$expected_root" '
    .category == "system-journal" and
    .isDirectory == $directory and .onRootFilesystem == $root
  ' "$work_dir/journal-path.stdout" >/dev/null ||
    fail "journal directory/root evidence was incorrect: $path_case"
done

preload_bin="$work_dir/preload-bin"
mkdir -p "$preload_bin"
ln -s "$(command -v bash)" "$preload_bin/bash"
ln -s "$(command -v base64)" "$preload_bin/base64"
ln -s "$(command -v jq)" "$preload_bin/jq"
cat >"$preload_bin/uname" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[[ "${STUB_UNAME_FAIL:-0}" != "1" ]] || exit 42
case "$1" in
  -s) printf '%s\n' "${STUB_UNAME_KERNEL:-Linux}" ;;
  -m) printf '%s\n' "${STUB_UNAME_MACHINE:-aarch64}" ;;
  *) exit 42 ;;
esac
SH
cat >"$preload_bin/df" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[[ "$*" == "--block-size=1 --output=size,used,target /" ]]
count=0
[[ ! -s "$STUB_DF_STATE" ]] || read -r count <"$STUB_DF_STATE"
count=$((count + 1))
printf '%s\n' "$count" >"$STUB_DF_STATE"
printf 'df\t%s\n' "$count" >>"$STUB_PRELOAD_COMMAND_LOG"
index=0
measurement=""
while IFS= read -r line; do
  index=$((index + 1))
  if ((index == count)); then
    measurement="$line"
    break
  fi
done <"$STUB_DF_MEASUREMENTS"
[[ -n "$measurement" ]] || exit 42
case "$measurement" in
  FAIL)
    exit 42
    ;;
  EMPTY)
    exit 0
    ;;
  EXTRA)
    printf 'Size Used Mounted\n10 7 /\n10 7 /\n'
    exit 0
    ;;
esac
read -r capacity used extra <<<"$measurement"
[[ -z "$extra" ]] || exit 42
printf 'Size Used Mounted\n%s %s /\n' "$capacity" "$used"
SH
cat >"$preload_bin/k3s" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[[ "$#" == "7" ]]
[[ "$1" == "crictl" ]]
[[ "$2" == "--runtime-endpoint" ]]
[[ "$3" == "unix:///run/k3s/containerd/containerd.sock" ]]
[[ "$4" == "--image-endpoint" ]]
[[ "$5" == "unix:///run/k3s/containerd/containerd.sock" ]]
[[ "$6" == "pull" ]]
[[ "$7" =~ ^ghcr\.io/vasilyevstan/betstan-images@sha256:[0-9a-f]{64}$ ]]
count=0
[[ ! -s "$STUB_PULL_STATE" ]] || read -r count <"$STUB_PULL_STATE"
count=$((count + 1))
printf '%s\n' "$count" >"$STUB_PULL_STATE"
printf 'pull\t%s\n' "$7" >>"$STUB_PRELOAD_COMMAND_LOG"
[[ "$count" != "${STUB_PULL_FAIL_AT:-0}" ]] || exit 42
SH
chmod +x "$preload_bin/uname" "$preload_bin/df" "$preload_bin/k3s"

preload_measurements="$work_dir/preload-measurements"
preload_df_state="$work_dir/preload-df-state"
preload_pull_state="$work_dir/preload-pull-state"
preload_command_log="$work_dir/preload-command.log"
preload_refs="$(<"$candidate_cases/actual.json")"
shared_preload_refs="$(<"$candidate_cases/shared.json")"
preload_env=(
  PATH="$preload_bin"
  STUB_DF_MEASUREMENTS="$preload_measurements"
  STUB_DF_STATE="$preload_df_state"
  STUB_PULL_STATE="$preload_pull_state"
  STUB_PRELOAD_COMMAND_LOG="$preload_command_log"
)
reset_preload_case() {
  : >"$preload_df_state"
  : >"$preload_pull_state"
  : >"$preload_command_log"
}
write_safe_measurements() {
  : >"$preload_measurements"
  for ((measurement_index = 0; measurement_index < 20; measurement_index++)); do
    printf '%s\n' "${1:-10} ${2:-7}" >>"$preload_measurements"
  done
}
run_preload() {
  local output="$1" payload="$2"
  shift 2
  local status=0
  env "${preload_env[@]}" "$@" \
    "$REMOTE" preload-candidate-images "$payload" >"$output" 2>&1 ||
    status=$?
  printf '%s' "$status"
}

reset_preload_case
write_safe_measurements 10 7
preload_status="$(run_preload "$work_dir/preload-success.log" "$preload_refs")"
[[ "$preload_status" == "0" ]] ||
  fail "candidate preload rejected exact 70 percent equality: status=$preload_status output=$(<"$work_dir/preload-success.log")"
[[ "$(awk -F '\t' '$1 == "pull" {count++} END {print count+0}' "$preload_command_log")" == "10" &&
   "$(awk -F '\t' '$1 == "df" {count++} END {print count+0}' "$preload_command_log")" == "20" ]] ||
  fail "candidate preload did not measure immediately around ten sequential pulls"
jq -r '.[]' "$candidate_cases/actual.json" >"$work_dir/preload-expected-refs"
awk -F '\t' '$1 == "pull" {print $2}' "$preload_command_log" \
  >"$work_dir/preload-actual-refs"
cmp "$work_dir/preload-expected-refs" "$work_dir/preload-actual-refs" ||
  fail "candidate preload changed service-sorted pull order"

reset_preload_case
write_safe_measurements 11 7
preload_status="$(run_preload "$work_dir/preload-nondivisible.log" "$shared_preload_refs")"
[[ "$preload_status" == "0" &&
   "$(awk -F '\t' '$1 == "pull" {count++} END {print count+0}' "$preload_command_log")" == "10" ]] ||
  fail "non-divisible floor boundary or shared references were rejected"

reset_preload_case
write_safe_measurements 9223372036854775807 6456360425798343064
preload_status="$(
  run_preload "$work_dir/preload-signed-max-boundary.log" "$shared_preload_refs"
)"
[[ "$preload_status" == "0" &&
   "$(awk -F '\t' '$1 == "pull" {count++} END {print count+0}' "$preload_command_log")" == "10" &&
   "$(awk -F '\t' '$1 == "df" {count++} END {print count+0}' "$preload_command_log")" == "20" ]] ||
  fail "maximum signed-safe capacity overflowed at its exact 70 percent floor"

reset_preload_case
printf '9223372036854775807 6456360425798343065\n' >"$preload_measurements"
preload_status="$(
  run_preload "$work_dir/preload-signed-max-over.log" "$preload_refs"
)"
[[ "$preload_status" == "20" &&
   "$(awk -F '\t' '$1 == "pull" {count++} END {print count+0}' "$preload_command_log")" == "0" &&
   "$(awk -F '\t' '$1 == "df" {count++} END {print count+0}' "$preload_command_log")" == "1" ]] ||
  fail "maximum signed-safe one-byte threshold breach reached CRI"

reset_preload_case
printf '11 8\n' >"$preload_measurements"
preload_status="$(run_preload "$work_dir/preload-pre-over.log" "$preload_refs")"
[[ "$preload_status" == "20" &&
   "$(awk -F '\t' '$1 == "pull" {count++} END {print count+0}' "$preload_command_log")" == "0" &&
   "$(awk -F '\t' '$1 == "df" {count++} END {print count+0}' "$preload_command_log")" == "1" ]] ||
  fail "one byte above the non-divisible pre-pull limit reached CRI"

reset_preload_case
printf '11 7\n11 8\n' >"$preload_measurements"
preload_status="$(run_preload "$work_dir/preload-post-over.log" "$preload_refs")"
[[ "$preload_status" == "20" &&
   "$(awk -F '\t' '$1 == "pull" {count++} END {print count+0}' "$preload_command_log")" == "1" &&
   "$(awk -F '\t' '$1 == "df" {count++} END {print count+0}' "$preload_command_log")" == "2" ]] ||
  fail "post-pull threshold breach did not stop before the next image"

reset_preload_case
printf '11 7\n11 7\n' >"$preload_measurements"
preload_status="$(
  run_preload "$work_dir/preload-pull-failure.log" "$preload_refs" \
    STUB_PULL_FAIL_AT=1
)"
[[ "$preload_status" == "20" &&
   "$(awk -F '\t' '$1 == "pull" {count++} END {print count+0}' "$preload_command_log")" == "1" &&
   "$(awk -F '\t' '$1 == "df" {count++} END {print count+0}' "$preload_command_log")" == "2" ]] ||
  fail "failed pull did not retain failure after its post-attempt measurement"

df_rejection_cases=(
  "failed|FAIL"
  "empty|EMPTY"
  "extra-line|EXTRA"
  "zero-capacity|0 0"
  "used-over-capacity|10 11"
  "nonnumeric-capacity|bogus 7"
  "negative-used|11 -1"
  "overflow-capacity|9223372036854775808 7"
)
for df_case in "${df_rejection_cases[@]}"; do
  IFS='|' read -r df_case_name malformed_measurement <<<"$df_case"
  reset_preload_case
  printf '%s\n' "$malformed_measurement" >"$preload_measurements"
  preload_status="$(
    run_preload "$work_dir/preload-pre-df-$df_case_name.log" "$preload_refs"
  )"
  [[ "$preload_status" == "20" &&
     "$(awk -F '\t' '$1 == "pull" {count++} END {print count+0}' "$preload_command_log")" == "0" &&
     "$(awk -F '\t' '$1 == "df" {count++} END {print count+0}' "$preload_command_log")" == "1" ]] ||
    fail "invalid pre-pull df result did not fail before CRI: $df_case_name"
done

for df_case in "${df_rejection_cases[@]}"; do
  IFS='|' read -r df_case_name malformed_measurement <<<"$df_case"
  reset_preload_case
  printf '11 7\n%s\n' "$malformed_measurement" >"$preload_measurements"
  preload_status="$(
    run_preload "$work_dir/preload-post-df-$df_case_name.log" "$preload_refs"
  )"
  [[ "$preload_status" == "20" &&
     "$(awk -F '\t' '$1 == "pull" {count++} END {print count+0}' "$preload_command_log")" == "1" &&
     "$(awk -F '\t' '$1 == "df" {count++} END {print count+0}' "$preload_command_log")" == "2" ]] ||
    fail "invalid post-pull df result did not stop later pulls: $df_case_name"
done

invalid_preload_payload() {
  local name="$1" payload="$2" status
  reset_preload_case
  printf '10 0\n' >"$preload_measurements"
  status="$(run_preload "$work_dir/preload-payload-$name.log" "$payload")"
  [[ "$status" == "20" && ! -s "$preload_command_log" ]] ||
    fail "invalid transported candidate payload reached measurement or pull: $name"
}
invalid_preload_payload object '{}'
invalid_preload_payload missing "$(jq -c '.[0:9]' "$candidate_cases/actual.json")"
invalid_preload_payload extra "$(jq -c '. + [.[0]]' "$candidate_cases/actual.json")"
invalid_preload_payload tag "$(
  jq -c '.[0] = "ghcr.io/vasilyevstan/betstan-images:auth-latest"' \
    "$candidate_cases/actual.json"
)"
invalid_preload_payload repository "$(
  jq -c '.[0] = "ghcr.io/other/repository@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"' \
    "$candidate_cases/actual.json"
)"
invalid_preload_payload digest "$(
  jq -c '.[0] = "ghcr.io/vasilyevstan/betstan-images@sha256:SHORT"' \
    "$candidate_cases/actual.json"
)"
invalid_preload_payload trailing-lf "$trailing_lf_candidate_refs"

reset_preload_case
write_safe_measurements 10 0
preload_status="$(
  run_preload "$work_dir/preload-host-identity.log" "$preload_refs" \
    STUB_UNAME_MACHINE=x86_64
)"
[[ "$preload_status" != "0" && "$preload_status" != "20" &&
   ! -s "$preload_command_log" ]] ||
  fail "host identity failure was misclassified as candidacy or reached CRI"

preload_function="$work_dir/preload-function.sh"
sed -n '/^preload_candidate_images() {$/,/^}$/p' "$REMOTE" >"$preload_function"
[[ "$(grep -Fc 'cri pull "$image_ref"' "$preload_function")" == "1" ]] ||
  fail "candidate preload does not contain exactly one native CRI pull pass"
if grep -Eiq '(^|[^[:alnum:]_])(ctr|rmi|prune|apt(-get)?|docker|login|credential)([^[:alnum:]_]|$)' \
    "$preload_function"; then
  fail "candidate preload contains forbidden fallback, credential, deletion, prune, or APT behavior"
fi

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
if [[ "$remote_command" == "sudo K3S_DISK_SELECTED_IMAGE_IDS_B64=${STUB_EXPECTED_PRELOAD_B64:-missing} K3S_DISK_CANONICAL_HOST_B64=$K3S_DISK_CANONICAL_HOST_B64 K3S_DISK_NODE_NAME_B64=$K3S_DISK_NODE_NAME_B64 bash -s -- preload-candidate-images" ]]; then
  while IFS= read -r _; do :; done
  printf 'preload-transport\n' >>"$STUB_PRELOAD_TRANSPORT_LOG"
  exit 0
fi
[[ "$remote_command" == "sudo K3S_DISK_SELECTED_IMAGE_IDS_B64=W10= K3S_DISK_CANONICAL_HOST_B64=$K3S_DISK_CANONICAL_HOST_B64 K3S_DISK_NODE_NAME_B64=$K3S_DISK_NODE_NAME_B64 bash -s -- snapshot" ]]
exec bash -s -- snapshot
SH
cat >"$snapshot_bin/snapshot-fixture" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [[ -n "${STUB_SNAPSHOT_COMMAND_LOG:-}" ]]; then
  printf '%s:%s\n' "${0##*/}" "$*" >>"$STUB_SNAPSHOT_COMMAND_LOG"
fi
case "${0##*/}:$*" in
  "findmnt:--json --bytes --output TARGET,SOURCE,FSTYPE,SIZE,USED,AVAIL --target /")
    jq '{filesystems:[.root.mount]}' "$STUB_CURRENT_RUNTIME"
    ;;
  "findmnt:--json --bytes --output TARGET,SOURCE,FSTYPE,SIZE,USED,AVAIL --target /var/lib/betstan/mongo")
    jq '{filesystems:[.mongo.mount]}' "$STUB_CURRENT_RUNTIME"
    ;;
  "findmnt:--noheadings --output TARGET --target /var/log/journal")
    printf '/\n'
    ;;
  "df:--block-size=1 --output=size,used,avail,pcent,target /")
    printf 'Size Used Avail Use%% Mounted\n50000000000 37000000000 13000000000 74%% /\n'
    ;;
  "du:--bytes --summarize --one-file-system "*)
    if [[ "$4" == "${STUB_DU_FAILURE_PATH:-}" ]]; then
      printf '1234567890\t%s\n' "$4"
      exit 47
    fi
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
snapshot_journal_mount="$(
  "$snapshot_bin/findmnt" --noheadings --output TARGET --target /var/log/journal
)" || fail "snapshot journal mount fixture rejected the fixed probe"
[[ "$snapshot_journal_mount" == "/" ]] ||
  fail "snapshot journal mount fixture did not identify the root filesystem"

expected_preload_b64="$(printf '%s' "$preload_refs" | base64 | tr -d '\n')"
: >"$work_dir/preload-transport.log"
env "${common_env[@]}" \
  PATH="$snapshot_bin:$stub_bin:$PATH" \
  K3S_DISK_REMOTE_RUNNER= \
  GITHUB_RUN_ID=400 \
  CONTROL_SHA="$SOURCE_SHA" \
  K3S_DISK_CANONICAL_HOST_B64="$encoded_host" \
  K3S_DISK_NODE_NAME_B64="$encoded_node" \
  STUB_REAL_JQ="$(command -v jq)" \
  STUB_EXPECTED_PRELOAD_B64="$expected_preload_b64" \
  STUB_PRELOAD_TRANSPORT_LOG="$work_dir/preload-transport.log" \
  "$ORCHESTRATOR" preload >"$work_dir/preload-transport-output.log"
grep -Fxq preload-transport "$work_dir/preload-transport.log" ||
  fail "preload wrapper did not use the complete encoded strict-SSH transport"

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

: >"$work_dir/held-command.log"
rm -f "$work_dir/held-curl.log"
PATH="$snapshot_bin:$stub_bin:$PATH" \
  STUB_CURRENT_RUNTIME="$runtime" \
  STUB_CAPACITY_SUMMARY="$work_dir/summary-before.json" \
  STUB_WORKLOADS="$work_dir/snapshot-workloads.json" \
  STUB_QUEUES="$work_dir/snapshot-queues.tsv" \
  STUB_QUEUE_FAILURE=1 \
  STUB_CURL_LOG="$work_dir/held-curl.log" \
  STUB_REAL_JQ="$(command -v jq)" \
  STUB_JQ_ARGV_LOG="$work_dir/held-jq-argv.log" \
  STUB_SNAPSHOT_COMMAND_LOG="$work_dir/held-command.log" \
  K3S_DISK_NODE_NAME_B64="$encoded_node" \
  "$REMOTE" snapshot-held >"$work_dir/held-snapshot.json"
jq -e '
  .schemaVersion == "k3s-node-disk-held-runtime.v1" and
  .snapshotProfile == "held" and
  ((keys | sort) == ([
    "applicationRepository",
    "images",
    "mongo",
    "root",
    "runtime",
    "schemaVersion",
    "snapshotProfile"
  ] | sort)) and
  ((.root | keys | sort) == (["df","mount"] | sort)) and
  ((.mongo | keys | sort) == (["mount","separateFromRoot"] | sort)) and
  ((.runtime | keys | sort) == ([
    "containerRuntimeVersion",
    "k3sActive",
    "k3sVersion",
    "nodeName"
  ] | sort))
' "$work_dir/held-snapshot.json" >/dev/null ||
  fail "held snapshot did not use its exact stable-only schema"
if [[ -s "$work_dir/held-curl.log" ]] ||
   grep -Eq 'rabbitmqctl|get pods|get deployments|statefulsets|daemonsets|replicasets|jobs|cronjobs' \
     "$work_dir/held-command.log"; then
  fail "held snapshot invoked public, RabbitMQ, pod, or workload checks"
fi
if grep -Fq 'canonical host is unavailable' "$work_dir/held-command.log"; then
  fail "held snapshot still depended on a public canonical host"
fi

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
    jq -e '
      .schemaVersion == "k3s-node-disk-runtime.v3" and
      (.consumers | length) == 7 and
      ([.consumers[] | select(.category == "system-journal")] | length) == 1 and
      (.consumers[] | select(.category == "system-journal") |
        .path == "/var/log/journal" and
        (.isDirectory | type) == "boolean" and
        (.onRootFilesystem | type) == "boolean")
    ' "$work_dir/snapshot-$name-work/runtime-before.json" >/dev/null ||
      fail "public snapshot did not produce strict seventh-consumer runtime v3"
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

cat >"$work_dir/measurement-snapshot-runner" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
source "$STUB_LIB"
source "$STUB_SNAPSHOT_REMOTE" snapshot
SH
chmod +x "$work_dir/measurement-snapshot-runner"
for capture_phase in pre post; do
  cp "$journal_cases/before.json" "$work_dir/current-runtime.json"
  cp "$work_dir/summary-before.json" "$work_dir/current-summary.json"
  : >"$work_dir/remote.log"
  : >"$work_dir/journal-capacity.log"
  : >"$work_dir/journal-command.log"
  : >"$work_dir/measurement-command.log"
  measurement_work="$work_dir/journal-$capture_phase-measurement-work"
  measurement_result="$work_dir/journal-$capture_phase-measurement-reclaim.json"
  measurement_checkpoint="$work_dir/journal-$capture_phase-measurement-checkpoint.json"
  measurement_log="$work_dir/journal-$capture_phase-measurement.log"
  printf 'stale\n' >"$measurement_checkpoint"
  snapshot_at=1
  [[ "$capture_phase" != post ]] || snapshot_at=2
  measurement_status=0
  env "${snapshot_env[@]}" \
    PATH="$snapshot_bin:$journal_bin:$stub_bin:$PATH" \
    K3S_DISK_REMOTE_RUNNER="$work_dir/remote-runner" \
    STUB_SNAPSHOT_RUNNER="$work_dir/measurement-snapshot-runner" \
    STUB_SNAPSHOT_AT="$snapshot_at" STUB_SNAPSHOT_REMOTE="$REMOTE" \
    STUB_LIB="$ROOT_DIR/infra/oci/scripts/lib.sh" STUB_DU_FAILURE_PATH=/var/log \
    STUB_SNAPSHOT_COMMAND_LOG="$work_dir/measurement-command.log" \
    STUB_CURRENT_RUNTIME="$work_dir/current-runtime.json" \
    STUB_CAPACITY_SUMMARY="$work_dir/current-summary.json" \
    STUB_JOURNAL_REMOTE="$REMOTE" STUB_JOURNAL_LOG="$work_dir/journal-command.log" \
    STUB_JOURNAL_POST_RUNTIME="$journal_cases/cleaned.json" \
    STUB_PRELOAD_POST_RUNTIME="$journal_cases/complete.json" \
    STUB_CAPACITY_LOG="$work_dir/journal-capacity.log" \
    GITHUB_RUN_ID=501 DIAGNOSIS_RUN_ID=500 \
    DIAGNOSIS_FILE="$journal_cases/diagnosis.json" \
    RECLAIM_CATEGORY=system-journal RECLAIM_IMAGE_IDS='[]' \
    WORK_DIR="$measurement_work" OUTPUT_FILE="$measurement_result" \
    CHECKPOINT_OUTPUT_FILE="$measurement_checkpoint" \
    "$ORCHESTRATOR" reclaim >"$measurement_log" 2>&1 || measurement_status=$?
  [[ "$measurement_status" != "0" && ! -e "$measurement_checkpoint" ]] ||
    fail "journal $capture_phase measurement failure retained successful release authority"
  grep -Fxq 'du:--bytes --summarize --one-file-system /var/log' \
    "$work_dir/measurement-command.log" ||
    fail "journal $capture_phase measurement did not reach the real consumer collection"
  grep -Fq 'reason=aggregate size measurement failed for system-logs' "$measurement_log" ||
    fail "journal $capture_phase measurement failed for the wrong reason"
  if grep -Eq 'k3s_disk_recovery=reclaim status=PASS|/synthetic-private-journal/' "$measurement_log"; then
    fail "journal $capture_phase measurement exposed native output or finalized successfully"
  fi
  if [[ "$capture_phase" == pre ]]; then
    [[ "$(awk -F '\t' '{print $1}' "$work_dir/remote.log")" == snapshot &&
       ! -s "$work_dir/journal-command.log" && ! -s "$work_dir/journal-capacity.log" &&
       ! -s "$measurement_work/runtime-before.json" && ! -e "$measurement_result" ]] ||
      fail "partial pre-state measurement reached mutation or emitted accepted evidence"
  else
    [[ "$(awk -F '\t' '{print $1}' "$work_dir/remote.log")" == \
       $'snapshot\nreclaim-system-journal\npreload-candidate-images\nsnapshot' &&
       "$(cat "$work_dir/journal-command.log")" == \
       $'--rotate\n--directory=/var/log/journal --vacuum-size=536870912' &&
       "$(wc -l <"$work_dir/journal-capacity.log" | tr -d ' ')" == "2" &&
       ! -s "$measurement_work/runtime-after.json" ]] ||
      fail "partial post-state measurement changed command order or skipped post evidence"
    jq -e '
      .category == "system-journal" and .terminalStatus == "INCOMPLETE" and
      .reason == "post-state-capture-failed"
    ' "$measurement_result" >/dev/null ||
      fail "partial post-state measurement did not prevent successful finalization"
  fi
done

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

jq --arg image "ghcr.io/vasilyevstan/betstan-images@$TELEMETRY_ID" '
  .items += [{
    kind:"Deployment",
    metadata:{namespace:"betstan-oci",name:"gaming-telemetry-depl"},
    spec:{template:{spec:{containers:[{image:$image}]}}}
  }]
' \
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
    "- system-journal",
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
