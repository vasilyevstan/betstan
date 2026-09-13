#!/usr/bin/env python3
"""Build and validate bounded k3s node-disk recovery evidence."""

import argparse
import hashlib
import json
import re
from pathlib import Path

FULL_SHA = re.compile(r"^[0-9a-f]{40}$")
IMAGE_ID = re.compile(r"^sha256:[0-9a-f]{64}$")
POSITIVE_INTEGER = re.compile(r"^[1-9][0-9]*$")
REPOSITORY = "ghcr.io/vasilyevstan/betstan-images"
THRESHOLD = 70
DNS_LABEL = re.compile(r"^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$")


def fail(message):
    raise SystemExit(f"k3s disk evidence rejected: {message}")


def load_json(path, label):
    try:
        value = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        fail(f"{label} is unavailable or malformed: {exc}")
    if not isinstance(value, dict):
        fail(f"{label} must be an object")
    return value


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def checksum(value):
    return hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()


def add_checksum(value):
    result = dict(value)
    result["contentChecksumSha256"] = checksum(result)
    return result


def validate_checksum(value, label):
    observed = value.get("contentChecksumSha256")
    if not isinstance(observed, str) or not re.fullmatch(r"[0-9a-f]{64}", observed):
        fail(f"{label} checksum is missing or malformed")
    content = dict(value)
    del content["contentChecksumSha256"]
    if checksum(content) != observed:
        fail(f"{label} checksum does not match its canonical content")


def require_positive(value, label):
    if not POSITIVE_INTEGER.fullmatch(str(value)):
        fail(f"{label} must be a positive integer")
    return str(value)


def require_sha(value, label):
    if not isinstance(value, str) or not FULL_SHA.fullmatch(value):
        fail(f"{label} must be a full lowercase SHA")
    return value


def parse_candidate_images(path):
    rows = []
    try:
        lines = Path(path).read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        fail(f"candidate image evidence is unavailable: {exc}")
    for line in lines:
        fields = line.split("\t")
        if len(fields) != 5:
            fail("candidate image evidence must contain five columns")
        service, repository, image_ref, manifest_digest, platform_digest = fields
        if (
            not service
            or repository != REPOSITORY
            or not image_ref.startswith(f"{REPOSITORY}@sha256:")
            or not IMAGE_ID.fullmatch(manifest_digest)
            or not IMAGE_ID.fullmatch(platform_digest)
            or not image_ref.endswith(manifest_digest)
        ):
            fail("candidate image evidence contains an invalid immutable image")
        rows.append(
            {
                "service": service,
                "imageRef": image_ref,
                "manifestDigest": manifest_digest,
                "platformDigest": platform_digest,
            }
        )
    if len(rows) != 9 or len({row["service"] for row in rows}) != 9:
        fail("candidate image evidence must contain exactly nine services")
    return sorted(rows, key=lambda row: row["service"])


def validate_capacity(capacity):
    expected = {
        "schemaVersion",
        "nodeName",
        "capacityBytes",
        "usedBytes",
        "availableBytes",
        "usedPercent",
        "thresholdPercent",
        "withinLimit",
    }
    if set(capacity) != expected:
        fail("kubelet capacity evidence has an unexpected schema")
    if (
        not isinstance(capacity["nodeName"], str)
        or not DNS_LABEL.fullmatch(capacity["nodeName"])
    ):
        fail("kubelet capacity evidence names an invalid node")
    if capacity["thresholdPercent"] != THRESHOLD:
        fail("kubelet capacity threshold must remain 70")
    for name in ("capacityBytes", "usedBytes", "availableBytes"):
        if type(capacity[name]) is not int or capacity[name] < 0:
            fail(f"kubelet capacity {name} is invalid")
    if capacity["capacityBytes"] <= 0 or capacity["usedBytes"] > capacity["capacityBytes"]:
        fail("kubelet capacity byte values are inconsistent")
    calculated = round(capacity["usedBytes"] / capacity["capacityBytes"] * 100, 2)
    if abs(float(capacity["usedPercent"]) - calculated) > 0.01:
        fail("kubelet capacity percentage is inconsistent")
    if capacity["withinLimit"] != (
        capacity["usedBytes"] * 100 <= capacity["capacityBytes"] * THRESHOLD
    ):
        fail("kubelet capacity limit result is inconsistent")


def validate_runtime(runtime):
    required = {
        "schemaVersion",
        "applicationRepository",
        "root",
        "mongo",
        "consumers",
        "images",
        "containerImageReferences",
        "kubernetesImageReferences",
        "workload",
        "queue",
        "publicRead",
        "runtime",
    }
    if set(runtime) != required:
        fail("runtime snapshot has an unexpected schema")
    if runtime["schemaVersion"] != "k3s-node-disk-runtime.v1":
        fail("runtime snapshot schema version is unsupported")
    if runtime["applicationRepository"] != REPOSITORY:
        fail("runtime snapshot application repository differs")
    root = runtime["root"]
    mongo = runtime["mongo"]
    if (
        not isinstance(root, dict)
        or set(root) != {"mount", "df"}
        or not isinstance(mongo, dict)
        or set(mongo) != {"mount", "separateFromRoot"}
    ):
        fail("runtime mount evidence is malformed")
    for label, mount, target in (
        ("root", root["mount"], "/"),
        ("Mongo", mongo["mount"], "/var/lib/betstan/mongo"),
    ):
        if not isinstance(mount, dict) or mount.get("target") != target:
            fail(f"{label} mount target is invalid")
        for name in ("source", "fstype"):
            if not isinstance(mount.get(name), str) or not mount[name]:
                fail(f"{label} mount {name} is missing")
        for name in ("size", "used", "avail"):
            if type(mount.get(name)) is not int or mount[name] < 0:
                fail(f"{label} mount {name} is invalid")
    if (
        mongo["separateFromRoot"] is not True
        or root["mount"]["source"] == mongo["mount"]["source"]
    ):
        fail("Mongo data is not proven to use a separate filesystem")
    root_df = root["df"]
    if not isinstance(root_df, dict) or set(root_df) != {
        "capacityBytes",
        "usedBytes",
        "availableBytes",
        "usedPercent",
    }:
        fail("root df evidence is malformed")
    for name in ("capacityBytes", "usedBytes", "availableBytes"):
        if type(root_df[name]) is not int or root_df[name] < 0:
            fail(f"root df {name} is invalid")
    if root_df["capacityBytes"] <= 0 or root_df["usedBytes"] > root_df["capacityBytes"]:
        fail("root df byte values are inconsistent")

    expected_consumers = {
        "apt-package-cache": "/var/cache/apt",
        "k3s-containerd": "/var/lib/rancher/k3s/agent/containerd",
        "k3s-server": "/var/lib/rancher/k3s/server",
        "kubelet": "/var/lib/kubelet",
        "mongo-data": "/var/lib/betstan/mongo",
        "system-logs": "/var/log",
    }
    consumers = runtime["consumers"]
    if (
        not isinstance(consumers, list)
        or {item.get("category") for item in consumers} != set(expected_consumers)
    ):
        fail("fixed-path aggregate consumer evidence is incomplete")
    for item in consumers:
        if (
            set(item) != {"category", "path", "bytes"}
            or item["path"] != expected_consumers[item["category"]]
            or type(item["bytes"]) is not int
            or item["bytes"] < 0
        ):
            fail("fixed-path aggregate consumer evidence is invalid")

    images = runtime["images"]
    if not isinstance(images, list):
        fail("CRI image inventory is malformed")
    seen_ids = set()
    for image in images:
        if set(image) != {"id", "repoTags", "repoDigests", "sizeBytes", "pinned"}:
            fail("CRI image record has an unexpected schema")
        if not IMAGE_ID.fullmatch(image["id"]) or image["id"] in seen_ids:
            fail("CRI image inventory contains an invalid or duplicate ID")
        seen_ids.add(image["id"])
        if (
            not isinstance(image["repoTags"], list)
            or not all(isinstance(item, str) for item in image["repoTags"])
            or not isinstance(image["repoDigests"], list)
            or not all(isinstance(item, str) for item in image["repoDigests"])
            or type(image["sizeBytes"]) is not int
            or image["sizeBytes"] < 0
            or type(image["pinned"]) is not bool
        ):
            fail("CRI image ownership evidence is invalid")
    refs = runtime["containerImageReferences"]
    if not isinstance(refs, list):
        fail("CRI container reference evidence is malformed")
    for ref in refs:
        if set(ref) != {"imageRef", "requestedImage", "state"} or not all(
            isinstance(ref[name], str) for name in ref
        ):
            fail("CRI container reference evidence is invalid")
    if not isinstance(runtime["kubernetesImageReferences"], list) or not all(
        isinstance(item, str) and item
        for item in runtime["kubernetesImageReferences"]
    ):
        fail("Kubernetes image reference evidence is invalid")
    workload = runtime["workload"]
    if (
        not isinstance(workload, dict)
        or set(workload) != {"podCount", "unhealthyPodCount", "restartCount"}
        or not all(type(workload[name]) is int and workload[name] >= 0 for name in workload)
        or workload["unhealthyPodCount"] != 0
    ):
        fail("workload baseline is unhealthy or malformed")
    queue = runtime["queue"]
    if (
        not isinstance(queue, dict)
        or set(queue) != {"queueCount", "backlog", "consumersHealthy"}
        or type(queue["queueCount"]) is not int
        or queue["queueCount"] < 1
        or type(queue["backlog"]) is not int
        or queue["backlog"] < 0
        or queue["consumersHealthy"] is not True
    ):
        fail("queue baseline is unhealthy or malformed")
    public_read = runtime["publicRead"]
    if (
        not isinstance(public_read, list)
        or {item.get("name") for item in public_read}
        != {"home", "api-event", "api-backoffice"}
        or not all(set(item) == {"name", "status"} and item["status"] == 200 for item in public_read)
    ):
        fail("public read baseline is unhealthy or malformed")
    identity = runtime["runtime"]
    if (
        not isinstance(identity, dict)
        or set(identity)
        != {"nodeName", "k3sVersion", "containerRuntimeVersion", "k3sActive"}
        or not isinstance(identity["nodeName"], str)
        or not DNS_LABEL.fullmatch(identity["nodeName"])
        or not isinstance(identity["k3sVersion"], str)
        or not isinstance(identity["containerRuntimeVersion"], str)
        or identity["k3sActive"] is not True
    ):
        fail("runtime identity is invalid")


def crosscheck_filesystem(runtime, capacity):
    if runtime["runtime"]["nodeName"] != capacity["nodeName"]:
        fail("runtime and kubelet capacity evidence name different nodes")
    root = runtime["root"]["df"]
    capacity_delta = abs(root["capacityBytes"] - capacity["capacityBytes"])
    used_delta = abs(root["usedBytes"] - capacity["usedBytes"])
    if capacity_delta > max(1024**3, capacity["capacityBytes"] // 50):
        fail("root df capacity differs materially from kubelet nodefs capacity")
    if used_delta > max(2 * 1024**3, capacity["capacityBytes"] // 20):
        fail("root df usage differs materially from kubelet nodefs usage")


def reference_variants(value):
    values = {value}
    if "@sha256:" in value:
        values.add(value.rsplit("@", 1)[1])
    if value.startswith("docker-pullable://"):
        stripped = value.removeprefix("docker-pullable://")
        values.update(reference_variants(stripped))
    if value.startswith("docker://"):
        values.add(value.removeprefix("docker://"))
    return {item for item in values if item}


def immutable_tag_source(value):
    match = re.fullmatch(
        rf"{re.escape(REPOSITORY)}:[a-z][a-z0-9-]*-([0-9a-f]{{40}})",
        value,
    )
    return match.group(1) if match else None


def classify(runtime, candidate_images, protected_sources=None):
    protected_sources = set(protected_sources or [])
    protected_refs = set()
    for item in runtime["containerImageReferences"]:
        protected_refs.update(reference_variants(item["imageRef"]))
        protected_refs.update(reference_variants(item["requestedImage"]))
    for item in runtime["kubernetesImageReferences"]:
        protected_refs.update(reference_variants(item))
    for item in candidate_images:
        protected_refs.update(reference_variants(item["imageRef"]))
        protected_refs.add(item["manifestDigest"])
        protected_refs.add(item["platformDigest"])

    candidates = []
    protected_ids = []
    preserved_ids = []
    candidate_cached_bytes = 0
    for image in runtime["images"]:
        image_refs = {image["id"]}
        for value in image["repoTags"] + image["repoDigests"]:
            image_refs.update(reference_variants(value))
        references = image["repoTags"] + image["repoDigests"]
        owned = bool(references) and bool(image["repoDigests"]) and all(
            value.startswith(f"{REPOSITORY}:")
            or value.startswith(f"{REPOSITORY}@sha256:")
            for value in references
        )
        tag_sources = [immutable_tag_source(value) for value in image["repoTags"]]
        source_attributed = bool(tag_sources) and all(tag_sources)
        generation_protected = bool(protected_sources & set(tag_sources))
        protected = bool(image_refs & protected_refs)
        protected = protected or generation_protected
        if any(
            image_refs
            & {
                item["manifestDigest"],
                item["platformDigest"],
                item["imageRef"],
            }
            for item in candidate_images
        ):
            candidate_cached_bytes += image["sizeBytes"]
        if owned and source_attributed and not protected and not image["pinned"]:
            candidates.append(
                {
                    "id": image["id"],
                    "repoDigests": sorted(image["repoDigests"]),
                    "repoTags": sorted(image["repoTags"]),
                    "sizeBytesEstimateNonAdditive": image["sizeBytes"],
                }
            )
        elif protected:
            protected_ids.append(image["id"])
        else:
            preserved_ids.append(image["id"])
    return {
        "protectedImageIds": sorted(protected_ids),
        "preservedUnknownForeignOrPinnedImageIds": sorted(preserved_ids),
        "criOwnedUnusedImages": sorted(candidates, key=lambda item: item["id"]),
        "candidateCachedImageBytesEstimateNonAdditive": candidate_cached_bytes,
        "imageSizeEstimatesAreNonAdditive": True,
        "rollbackProtectionSource": (
            "bound-ghcr-protected-generations-and-runtime-references"
            if protected_sources
            else "unproven-requires-bound-ghcr-protected-generations"
        ),
        "rollbackProtectionProven": bool(protected_sources),
        "criReclaimRequiresBoundProtectedGenerations": not bool(protected_sources),
        "futureCandidateHeadroomProven": False,
    }


def parse_protected_generations(path, diagnosis):
    value = load_json(path, "GHCR protected-generation evidence")
    if (
        value.get("schema") != "betstan.ghcr-package-management.v1"
        or value.get("terminal_status") != "VALIDATED"
        or value.get("mode") != "validate"
        or value.get("registry_provider") != "ghcr"
        or value.get("registry_host") != "ghcr.io"
        or value.get("repository") != REPOSITORY
        or value.get("package_visibility") != "public"
        or value.get("repository_linked") is not True
        or str(value.get("candidate_build_run_id")) != diagnosis["ghcrBuildRunId"]
    ):
        fail("GHCR protected-generation evidence identity is invalid")
    sources = value.get("protected_sources")
    if (
        not isinstance(sources, list)
        or not sources
        or len(sources) != len(set(sources))
        or not all(isinstance(item, str) and FULL_SHA.fullmatch(item) for item in sources)
        or diagnosis["sourceSha"] not in sources
    ):
        fail("GHCR protected-generation source set is invalid")
    return sorted(sources)


def security_state(runtime, classification):
    value = {
        "root": {
            "sourceSha256": hashlib.sha256(
                runtime["root"]["mount"]["source"].encode()
            ).hexdigest(),
            "fsType": runtime["root"]["mount"]["fstype"],
            "capacityBytes": runtime["root"]["mount"]["size"],
        },
        "mongo": {
            "sourceSha256": hashlib.sha256(
                runtime["mongo"]["mount"]["source"].encode()
            ).hexdigest(),
            "fsType": runtime["mongo"]["mount"]["fstype"],
            "capacityBytes": runtime["mongo"]["mount"]["size"],
            "separateFromRoot": runtime["mongo"]["separateFromRoot"],
        },
        "images": sorted(
            [
                {
                    "id": image["id"],
                    "repoTags": sorted(image["repoTags"]),
                    "repoDigests": sorted(image["repoDigests"]),
                    "pinned": image["pinned"],
                }
                for image in runtime["images"]
            ],
            key=lambda item: item["id"],
        ),
        "containerImageReferences": sorted(
            runtime["containerImageReferences"],
            key=lambda item: (
                item["imageRef"],
                item["requestedImage"],
                item["state"],
            ),
        ),
        "kubernetesImageReferences": sorted(runtime["kubernetesImageReferences"]),
        "runtime": runtime["runtime"],
        "reclaimCandidateIds": [
            item["id"] for item in classification["criOwnedUnusedImages"]
        ],
    }
    return checksum(value), value


def sanitized_runtime(runtime):
    return {
        "root": {
            "mountSourceSha256": hashlib.sha256(
                runtime["root"]["mount"]["source"].encode()
            ).hexdigest(),
            "fsType": runtime["root"]["mount"]["fstype"],
            "capacityBytes": runtime["root"]["df"]["capacityBytes"],
            "usedBytes": runtime["root"]["df"]["usedBytes"],
            "availableBytes": runtime["root"]["df"]["availableBytes"],
            "usedPercent": runtime["root"]["df"]["usedPercent"],
        },
        "mongo": {
            "mountSourceSha256": hashlib.sha256(
                runtime["mongo"]["mount"]["source"].encode()
            ).hexdigest(),
            "fsType": runtime["mongo"]["mount"]["fstype"],
            "capacityBytes": runtime["mongo"]["mount"]["size"],
            "usedBytes": runtime["mongo"]["mount"]["used"],
            "separateFromRoot": runtime["mongo"]["separateFromRoot"],
        },
        "consumers": runtime["consumers"],
        "images": runtime["images"],
        "containerImageReferences": runtime["containerImageReferences"],
        "kubernetesImageReferences": runtime["kubernetesImageReferences"],
        "workload": runtime["workload"],
        "queue": runtime["queue"],
        "publicRead": runtime["publicRead"],
        "runtime": runtime["runtime"],
    }


def validate_diagnosis(value):
    required = {
        "schemaVersion",
        "phase",
        "sourceSha",
        "infrastructureRunId",
        "ghcrBuildRunId",
        "workflowRunId",
        "workflowRunAttempt",
        "thresholdPercent",
        "kubeletCapacity",
        "runtime",
        "candidateImages",
        "protection",
        "securityStateSha256",
        "terminalStatus",
        "contentChecksumSha256",
    }
    if set(value) != required:
        fail("diagnosis manifest has an unexpected schema")
    validate_checksum(value, "diagnosis manifest")
    if (
        value["schemaVersion"] != "k3s-node-disk-diagnosis.v1"
        or value["phase"] != "diagnose-disk"
        or value["workflowRunAttempt"] != "1"
        or value["thresholdPercent"] != THRESHOLD
        or value["terminalStatus"] != "DIAGNOSED"
    ):
        fail("diagnosis manifest identity is invalid")
    require_sha(value["sourceSha"], "diagnosis source SHA")
    for name in ("infrastructureRunId", "ghcrBuildRunId", "workflowRunId"):
        require_positive(value[name], f"diagnosis {name}")
    if not re.fullmatch(r"[0-9a-f]{64}", value["securityStateSha256"]):
        fail("diagnosis security-state checksum is invalid")
    validate_capacity(value["kubeletCapacity"])
    if not isinstance(value["candidateImages"], list) or len(value["candidateImages"]) != 9:
        fail("diagnosis candidate image evidence is incomplete")
    protection = value["protection"]
    if (
        not isinstance(protection, dict)
        or protection.get("imageSizeEstimatesAreNonAdditive") is not True
        or protection.get("futureCandidateHeadroomProven") is not False
        or protection.get("rollbackProtectionProven") is not False
        or protection.get("rollbackProtectionSource")
        != "unproven-requires-bound-ghcr-protected-generations"
        or protection.get("criReclaimRequiresBoundProtectedGenerations") is not True
        or not isinstance(protection.get("criOwnedUnusedImages"), list)
    ):
        fail("diagnosis protection evidence is malformed")


def build_diagnosis(args):
    runtime = load_json(args.runtime, "runtime snapshot")
    capacity = load_json(args.capacity, "kubelet capacity evidence")
    validate_runtime(runtime)
    validate_capacity(capacity)
    crosscheck_filesystem(runtime, capacity)
    candidate_images = parse_candidate_images(args.candidate_images)
    classification = classify(runtime, candidate_images)
    state_sha, _ = security_state(runtime, classification)
    result = add_checksum(
        {
            "schemaVersion": "k3s-node-disk-diagnosis.v1",
            "phase": "diagnose-disk",
            "sourceSha": require_sha(args.source_sha, "source SHA"),
            "infrastructureRunId": require_positive(
                args.infrastructure_run_id, "infrastructure run ID"
            ),
            "ghcrBuildRunId": require_positive(
                args.ghcr_build_run_id, "GHCR build run ID"
            ),
            "workflowRunId": require_positive(args.workflow_run_id, "workflow run ID"),
            "workflowRunAttempt": "1",
            "thresholdPercent": THRESHOLD,
            "kubeletCapacity": capacity,
            "runtime": sanitized_runtime(runtime),
            "candidateImages": candidate_images,
            "protection": classification,
            "securityStateSha256": state_sha,
            "terminalStatus": "DIAGNOSED",
        }
    )
    Path(args.output).write_text(canonical(result) + "\n", encoding="utf-8")


def selected_ids(raw):
    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        fail("selected image IDs are malformed JSON")
    if (
        not isinstance(value, list)
        or len(value) != len(set(value))
        or not all(isinstance(item, str) and IMAGE_ID.fullmatch(item) for item in value)
    ):
        fail("selected image IDs must be a unique array of exact CRI IDs")
    return value


def validate_fresh_against_diagnosis(diagnosis, runtime, capacity):
    validate_runtime(runtime)
    validate_capacity(capacity)
    crosscheck_filesystem(runtime, capacity)
    classification = classify(runtime, diagnosis["candidateImages"])
    state_sha, _ = security_state(runtime, classification)
    if state_sha != diagnosis["securityStateSha256"]:
        fail("runtime ownership, references, mounts, or identity drifted since diagnosis")
    return classification


def plan_reclaim(args):
    diagnosis = load_json(args.diagnosis, "diagnosis manifest")
    validate_diagnosis(diagnosis)
    runtime = load_json(args.runtime, "fresh runtime snapshot")
    capacity = load_json(args.capacity, "fresh kubelet capacity")
    classification = validate_fresh_against_diagnosis(diagnosis, runtime, capacity)
    ids = selected_ids(args.image_ids)
    if args.category == "apt-package-cache":
        if ids:
            fail("apt package-cache reclaim cannot select image IDs")
        apt = next(
            item for item in runtime["consumers"]
            if item["category"] == "apt-package-cache"
        )
        if apt["bytes"] <= 0:
            fail("apt package-cache has no evidenced reclaim candidate")
    elif args.category == "cri-owned-unused-images":
        if not ids:
            fail("CRI reclaim requires at least one exact image ID")
        if not args.protected_generations:
            fail("CRI reclaim requires bound GHCR protected-generation evidence")
        protected_sources = parse_protected_generations(
            args.protected_generations, diagnosis
        )
        proven_classification = classify(
            runtime, diagnosis["candidateImages"], protected_sources
        )
        candidates = {
            item["id"] for item in proven_classification["criOwnedUnusedImages"]
        }
        if not set(ids).issubset(candidates):
            fail(
                "selected CRI image IDs are not exact owned unused candidates "
                "after protected-generation validation"
            )
    else:
        fail("reclaim category is unsupported")
    plan = add_checksum(
        {
            "schemaVersion": "k3s-node-disk-reclaim-plan.v1",
            "sourceSha": diagnosis["sourceSha"],
            "diagnosisWorkflowRunId": diagnosis["workflowRunId"],
            "category": args.category,
            "selectedImageIds": sorted(ids),
            "securityStateSha256": diagnosis["securityStateSha256"],
            "preRootUsedBytes": runtime["root"]["df"]["usedBytes"],
            "preRootUsedPercent": runtime["root"]["df"]["usedPercent"],
            "terminalStatus": "AUTHORIZED",
        }
    )
    Path(args.output).write_text(canonical(plan) + "\n", encoding="utf-8")


def finalize_reclaim(args):
    diagnosis = load_json(args.diagnosis, "diagnosis manifest")
    validate_diagnosis(diagnosis)
    post = load_json(args.post_runtime, "post-reclaim runtime snapshot")
    capacity = load_json(args.post_capacity, "post-reclaim kubelet capacity")
    validate_runtime(post)
    validate_capacity(capacity)
    crosscheck_filesystem(post, capacity)
    ids = sorted(selected_ids(args.image_ids))
    mutation_succeeded = args.mutation_succeeded == "true"
    before = diagnosis["runtime"]
    post_ids = {item["id"] for item in post["images"]}
    before_ids = {item["id"] for item in before["images"]}
    removed = sorted(before_ids - post_ids)
    added = sorted(post_ids - before_ids)
    stable = (
        before["root"]["mountSourceSha256"]
        == hashlib.sha256(post["root"]["mount"]["source"].encode()).hexdigest()
        and before["mongo"]["mountSourceSha256"]
        == hashlib.sha256(post["mongo"]["mount"]["source"].encode()).hexdigest()
        and before["mongo"]["separateFromRoot"] is True
        and before["containerImageReferences"] == post["containerImageReferences"]
        and before["kubernetesImageReferences"] == post["kubernetesImageReferences"]
        and before["runtime"] == post["runtime"]
        and before["workload"]["restartCount"] == post["workload"]["restartCount"]
        and post["workload"]["unhealthyPodCount"] == 0
        and before["queue"]["queueCount"] == post["queue"]["queueCount"]
        and post["queue"]["consumersHealthy"] is True
        and all(item["status"] == 200 for item in post["publicRead"])
    )
    if args.category == "cri-owned-unused-images":
        category_converged = removed == ids and not added
    elif args.category == "apt-package-cache":
        before_apt = next(
            item["bytes"] for item in before["consumers"]
            if item["category"] == "apt-package-cache"
        )
        post_apt = next(
            item["bytes"] for item in post["consumers"]
            if item["category"] == "apt-package-cache"
        )
        category_converged = not removed and not added and post_apt <= before_apt
    else:
        fail("reclaim category is unsupported")
    within_limit = capacity["withinLimit"] is True
    success = mutation_succeeded and category_converged and stable and within_limit
    result = add_checksum(
        {
            "schemaVersion": "k3s-node-disk-reclaim.v1",
            "phase": "reclaim-disk",
            "sourceSha": diagnosis["sourceSha"],
            "diagnosisWorkflowRunId": diagnosis["workflowRunId"],
            "category": args.category,
            "selectedImageIds": ids,
            "removedImageIds": removed,
            "unexpectedAddedImageIds": added,
            "mutationCommandSucceeded": mutation_succeeded,
            "categoryConverged": category_converged,
            "securityRelevantStateStable": stable,
            "thresholdPercent": THRESHOLD,
            "postKubeletCapacity": capacity,
            "actualRootUsedBytesBefore": before["root"]["usedBytes"],
            "actualRootUsedBytesAfter": post["root"]["df"]["usedBytes"],
            "actualMeasuredRootBytesFreed": max(
                0, before["root"]["usedBytes"] - post["root"]["df"]["usedBytes"]
            ),
            "imageSizeEstimatesWereNonAdditive": True,
            "futureCandidateHeadroomProven": False,
            "terminalStatus": "RECLAIMED" if success else "INCOMPLETE",
        }
    )
    Path(args.output).write_text(canonical(result) + "\n", encoding="utf-8")
    if not success:
        fail("reclaim did not satisfy the fixed post-state contract")


def validate_diagnosis_command(args):
    diagnosis = load_json(args.diagnosis, "diagnosis manifest")
    validate_diagnosis(diagnosis)
    if args.source_sha and diagnosis["sourceSha"] != args.source_sha:
        fail("diagnosis source SHA differs from the bound value")
    if args.infrastructure_run_id and diagnosis["infrastructureRunId"] != args.infrastructure_run_id:
        fail("diagnosis infrastructure run differs from the bound value")
    if args.ghcr_build_run_id and diagnosis["ghcrBuildRunId"] != args.ghcr_build_run_id:
        fail("diagnosis GHCR build run differs from the bound value")
    if args.workflow_run_id and diagnosis["workflowRunId"] != args.workflow_run_id:
        fail("diagnosis workflow run differs from the bound value")


def write_incomplete_reclaim(args):
    diagnosis = load_json(args.diagnosis, "diagnosis manifest")
    validate_diagnosis(diagnosis)
    ids = sorted(selected_ids(args.image_ids))
    if args.category == "apt-package-cache" and ids:
        fail("apt package-cache reclaim cannot select image IDs")
    if args.category not in {"apt-package-cache", "cri-owned-unused-images"}:
        fail("reclaim category is unsupported")
    result = add_checksum(
        {
            "schemaVersion": "k3s-node-disk-reclaim.v1",
            "phase": "reclaim-disk",
            "sourceSha": diagnosis["sourceSha"],
            "diagnosisWorkflowRunId": diagnosis["workflowRunId"],
            "category": args.category,
            "selectedImageIds": ids,
            "thresholdPercent": THRESHOLD,
            "reason": args.reason,
            "terminalStatus": "INCOMPLETE",
        }
    )
    Path(args.output).write_text(canonical(result) + "\n", encoding="utf-8")


def main():
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)

    diagnose = subparsers.add_parser("diagnose")
    diagnose.add_argument("--runtime", required=True)
    diagnose.add_argument("--capacity", required=True)
    diagnose.add_argument("--candidate-images", required=True)
    diagnose.add_argument("--source-sha", required=True)
    diagnose.add_argument("--infrastructure-run-id", required=True)
    diagnose.add_argument("--ghcr-build-run-id", required=True)
    diagnose.add_argument("--workflow-run-id", required=True)
    diagnose.add_argument("--output", required=True)
    diagnose.set_defaults(handler=build_diagnosis)

    validate = subparsers.add_parser("validate-diagnosis")
    validate.add_argument("--diagnosis", required=True)
    validate.add_argument("--source-sha")
    validate.add_argument("--infrastructure-run-id")
    validate.add_argument("--ghcr-build-run-id")
    validate.add_argument("--workflow-run-id")
    validate.set_defaults(handler=validate_diagnosis_command)

    plan = subparsers.add_parser("plan-reclaim")
    plan.add_argument("--diagnosis", required=True)
    plan.add_argument("--runtime", required=True)
    plan.add_argument("--capacity", required=True)
    plan.add_argument("--category", required=True)
    plan.add_argument("--image-ids", required=True)
    plan.add_argument("--protected-generations")
    plan.add_argument("--output", required=True)
    plan.set_defaults(handler=plan_reclaim)

    finalize = subparsers.add_parser("finalize-reclaim")
    finalize.add_argument("--diagnosis", required=True)
    finalize.add_argument("--post-runtime", required=True)
    finalize.add_argument("--post-capacity", required=True)
    finalize.add_argument("--category", required=True)
    finalize.add_argument("--image-ids", required=True)
    finalize.add_argument(
        "--mutation-succeeded", required=True, choices=("true", "false")
    )
    finalize.add_argument("--output", required=True)
    finalize.set_defaults(handler=finalize_reclaim)

    incomplete = subparsers.add_parser("write-incomplete-reclaim")
    incomplete.add_argument("--diagnosis", required=True)
    incomplete.add_argument("--category", required=True)
    incomplete.add_argument("--image-ids", required=True)
    incomplete.add_argument("--reason", required=True)
    incomplete.add_argument("--output", required=True)
    incomplete.set_defaults(handler=write_incomplete_reclaim)

    args = parser.parse_args()
    args.handler(args)


if __name__ == "__main__":
    main()
