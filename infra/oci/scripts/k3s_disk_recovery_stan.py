#!/usr/bin/env python3
"""Build and validate bounded k3s node-disk recovery evidence."""

import argparse
import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path

FULL_SHA = re.compile(r"^[0-9a-f]{40}$")
IMAGE_ID = re.compile(r"^sha256:[0-9a-f]{64}$")
POSITIVE_INTEGER = re.compile(r"^[1-9][0-9]*$")
REPOSITORY = "ghcr.io/vasilyevstan/betstan-images"
REPOSITORY_DIGEST = re.compile(
    rf"{re.escape(REPOSITORY)}@(sha256:[0-9a-f]{{64}})"
)
THRESHOLD = 70
DNS_LABEL = re.compile(r"^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$")
CURRENT_SERVICES = frozenset(
    ("auth", "bet", "backoffice", "client", "event", "gamemaster",
     "moderation", "resulting", "slip", "telemetry")
)
MONGO_LIMITS = {
    "databases": 32, "collections": 256, "commandMilliseconds": 2000,
    "collectionMilliseconds": 30000, "transportSeconds": 35, "outputBytes": 262144,
}
MONGO_METRICS = ("documentCount", "logicalBytes", "allocatedDataBytes", "allocatedIndexBytes")
MONGO_ERRORS = frozenset((
    "DATABASE_LIMIT", "COLLECTION_LIMIT", "TIME_LIMIT", "OUTPUT_LIMIT",
    "UNAUTHORIZED", "NAMESPACE_MISSING", "COMMAND_FAILED", "INVALID_METADATA",
    "INVALID_STATISTICS", "VERSION_MISMATCH", "TIMESERIES_LOGICAL_UNAVAILABLE",
    "CURSOR_CLEANUP_FAILED", "TRANSPORT_FAILED", "MALFORMED_OUTPUT",
))
MONGO_PUBLIC_COLLECTIONS = {
    "gaming_auth": {"users", "loginattempts"},
    "gaming_backoffice": {"events"},
    "gaming_bet": {"bets", "betplacementconflicts", "pendingbetupdates"},
    "gaming_event": {"events", "eventrescheduleoperations"},
    "gaming_gamemaster": {"events", "eventarchives"},
    "gaming_moderation": {"bets", "liveeventmirrors", "parkedplacebets", "resulteds"},
    "gaming_resulting": {"bets", "betarchives", "finalscoreledgers",
                        "livesettlementledgers", "pendingmoderationresults", "retryrecords"},
    "gaming_slip": {"slips", "sliparchives"},
    "gaming_telemetry": {"telemetryrecords"},
    "admin": {"system.version"},
    "config": {"system.sessions", "system.indexBuilds", "system.preimages"},
    "local": {"startup_log", "oplog.rs", "system.replset"},
}
MONGO_SYSTEM_DATABASES = {"admin", "config", "local"}
MONGO_SAFE_INTEGER = 9007199254740991


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


def validate_candidate_images(rows):
    if not isinstance(rows, list) or len(rows) != len(CURRENT_SERVICES):
        fail("candidate image evidence must contain all ten current services")
    for row in rows:
        if not isinstance(row, dict) or set(row) != {
            "service", "imageRef", "manifestDigest", "platformDigest"
        }:
            fail("candidate image evidence has an unexpected record schema")
        if (
            not isinstance(row["service"], str)
            or row["service"] not in CURRENT_SERVICES
            or not isinstance(row["manifestDigest"], str)
            or not IMAGE_ID.fullmatch(row["manifestDigest"])
            or not isinstance(row["platformDigest"], str)
            or not IMAGE_ID.fullmatch(row["platformDigest"])
            or row["imageRef"] != f"{REPOSITORY}@{row['manifestDigest']}"
        ):
            fail("candidate image evidence contains an invalid immutable image")
    if {row["service"] for row in rows} != CURRENT_SERVICES:
        fail("candidate image evidence must contain every current service exactly once")


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
        if repository != REPOSITORY:
            fail("candidate image evidence contains an invalid repository")
        rows.append(
            {
                "service": service,
                "imageRef": image_ref,
                "manifestDigest": manifest_digest,
                "platformDigest": platform_digest,
            }
        )
    validate_candidate_images(rows)
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


def classify(runtime, candidate_images, protected_sources=None, generation_map=None):
    protected_sources = set(protected_sources or [])
    generation_map = generation_map or {}
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
        digest_attribution = []
        for value in image["repoDigests"]:
            match = REPOSITORY_DIGEST.fullmatch(value)
            digest_attribution.append(
                generation_map.get(match.group(1)) if match else None
            )
        digest_sources = {
            source
            for attribution in digest_attribution
            if attribution is not None
            for source in attribution["sources"]
        }
        if not image["repoTags"] and digest_attribution and all(digest_attribution):
            source_attributed = len(
                {attribution["service"] for attribution in digest_attribution}
            ) == 1
        generation_protected = bool(
            protected_sources & (set(tag_sources) | digest_sources)
        )
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


def parse_protected_generations(path, diagnosis, generation_map_path):
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
        or not all(isinstance(item, str) and FULL_SHA.fullmatch(item) for item in sources)
        or len(sources) != len(set(sources))
        or diagnosis["sourceSha"] not in sources
    ):
        fail("GHCR protected-generation source set is invalid")
    return sorted(sources), parse_generation_map(generation_map_path, value, sources)


def parse_generation_map(path, summary, protected_sources):
    table = Path(path)
    if table.is_symlink() or not table.is_file():
        fail("GHCR generation map must be a regular file")
    try:
        raw = table.read_bytes()
    except OSError:
        fail("GHCR generation map is unavailable")
    expected = summary.get("generations_sha256")
    if (
        not isinstance(expected, str)
        or not re.fullmatch(r"[0-9a-f]{64}", expected)
        or hashlib.sha256(raw).hexdigest() != expected
    ):
        fail("GHCR generation map checksum does not match the validation summary")
    try:
        lines = raw.decode("utf-8").splitlines()
    except UnicodeDecodeError:
        fail("GHCR generation map is not valid UTF-8")
    if not lines:
        fail("GHCR generation map is empty")
    rows = set()
    sources = set()
    attribution = {}
    for line in lines:
        fields = line.split("\t")
        if len(fields) != 4:
            fail("GHCR generation map must contain four columns")
        source, service, version, digest = fields
        require_sha(source, "GHCR generation source")
        require_positive(version, "GHCR generation version")
        if service not in CURRENT_SERVICES or not IMAGE_ID.fullmatch(digest):
            fail("GHCR generation map service or manifest digest is invalid")
        row = tuple(fields)
        if row in rows:
            fail("GHCR generation map contains a duplicate row")
        rows.add(row)
        sources.add(source)
        if digest not in attribution:
            attribution[digest] = {"service": service, "sources": set()}
        elif attribution[digest]["service"] != service:
            fail("GHCR generation map assigns one digest to multiple services")
        attribution[digest]["sources"].add(source)
    if not set(protected_sources).issubset(sources):
        fail("GHCR generation map is missing a protected source")
    return attribution


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


def public_node_identity(identity):
    return {
        **identity,
        "nodeName": "k3s-node",
        "nodeNameSha256": hashlib.sha256(identity["nodeName"].encode()).hexdigest(),
    }


def sanitized_runtime(runtime, private_node=False):
    result = {
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
    if private_node:
        result["runtime"] = public_node_identity(result["runtime"])
    return result


def require_storage(condition):
    if not condition:
        raise ValueError("invalid Mongo storage evidence")


def storage_timestamp(value):
    require_storage(isinstance(value, str) and re.fullmatch(
        r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z", value
    ))
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def storage_scope(database, collection="", kind="collection"):
    if database in MONGO_SYSTEM_DATABASES:
        return "system"
    if collection.startswith("system.") and kind != "timeseries-buckets":
        return "system"
    return "application" if database in MONGO_PUBLIC_COLLECTIONS else "unattributed"


def validate_storage_row(row):
    require_storage(row["kind"] in {"collection", "view", "timeseries", "timeseries-buckets"})
    require_storage(row["status"] in {"MEASURED", "NON_STORAGE", "UNAVAILABLE"})
    if row["status"] == "MEASURED":
        require_storage(row["kind"] in {"collection", "timeseries-buckets"})
        require_storage(row["countUnit"] ==
                        ("buckets" if row["kind"] == "timeseries-buckets" else "documents"))
        require_storage(row["errorCode"] is None)
        storage_timestamp(row["observedAt"])
        for key in MONGO_METRICS:
            require_storage(type(row[key]) is int and 0 <= row[key] <= MONGO_SAFE_INTEGER)
    else:
        require_storage(all(row[key] is None for key in MONGO_METRICS))
        require_storage(row["observedAt"] is None and row["countUnit"] is None)
        if row["status"] == "NON_STORAGE":
            require_storage(row["kind"] == "view" and row["errorCode"] is None)
        else:
            require_storage(row["errorCode"] in MONGO_ERRORS)


def storage_totals(storage):
    totals = []
    for scope in ("application", "system", "unattributed"):
        rows = [row for row in storage["collections"]
                if row["scope"] == scope and row["status"] == "MEASURED"]
        complete = storage["status"] == "COMPLETE"
        total = {"scope": scope, "complete": complete, "measuredCollections": len(rows)}
        for field in MONGO_METRICS[1:]:
            value = sum(row[field] for row in rows)
            require_storage(value <= MONGO_SAFE_INTEGER)
            total[field] = value if rows or complete else None
        totals.append(total)
    return totals


def validate_mongo_storage(storage):
    require_storage(isinstance(storage, dict) and set(storage) == {
        "schemaVersion", "expectedServerVersion", "observedServerVersion",
        "startedAt", "finishedAt", "limits", "status", "discoveryComplete",
        "truncated", "errors", "databases", "collections", "totals",
    })
    require_storage(storage["schemaVersion"] == "mongo-collection-storage.v1")
    require_storage(storage["expectedServerVersion"] == "8.2.12")
    version = storage["observedServerVersion"]
    require_storage(version is None or
                    (isinstance(version, str) and re.fullmatch(r"\d+\.\d+\.\d+", version)))
    start, finish = storage["startedAt"], storage["finishedAt"]
    if start is not None:
        require_storage(storage_timestamp(start) <= storage_timestamp(finish))
    else:
        storage_timestamp(finish)
    require_storage(storage["limits"] == MONGO_LIMITS)
    require_storage(storage["status"] in {"COMPLETE", "PARTIAL", "UNAVAILABLE"})
    require_storage(type(storage["discoveryComplete"]) is bool and
                    type(storage["truncated"]) is bool)
    errors = storage["errors"]
    require_storage(isinstance(errors, list) and all(isinstance(item, str) for item in errors))
    require_storage(len(errors) == len(set(errors)) and set(errors) <= MONGO_ERRORS)
    databases, rows = storage["databases"], storage["collections"]
    require_storage(isinstance(databases, list) and len(databases) <= MONGO_LIMITS["databases"])
    require_storage(isinstance(rows, list) and len(rows) <= MONGO_LIMITS["collections"])
    labels = set()
    for database in databases:
        require_storage(isinstance(database, dict) and set(database) ==
                        {"label", "scope", "discoveryComplete"})
        label = database["label"]
        require_storage(isinstance(label, str) and label not in labels and
                        (label in MONGO_PUBLIC_COLLECTIONS or
                         re.fullmatch(r"database-\d{3}", label)))
        require_storage(database["scope"] == storage_scope(label))
        require_storage(type(database["discoveryComplete"]) is bool)
        labels.add(label)
    namespaces = set()
    for row in rows:
        require_storage(isinstance(row, dict) and set(row) == {
            "databaseLabel", "collectionLabel", "scope", "kind", "status", "observedAt",
            "documentCount", "countUnit", "logicalBytes", "allocatedDataBytes",
            "allocatedIndexBytes", "errorCode",
        })
        database, collection = row["databaseLabel"], row["collectionLabel"]
        require_storage(database in labels and isinstance(collection, str) and
                        (collection in MONGO_PUBLIC_COLLECTIONS.get(database, set()) or
                         re.fullmatch(r"collection-\d{3}", collection)))
        require_storage((database, collection) not in namespaces)
        namespaces.add((database, collection))
        require_storage(row["scope"] in {"application", "system", "unattributed"})
        if database in MONGO_SYSTEM_DATABASES:
            require_storage(row["scope"] == "system")
        elif database not in MONGO_PUBLIC_COLLECTIONS:
            require_storage(row["scope"] in {"system", "unattributed"})
        else:
            require_storage(row["scope"] in {"application", "system"})
        validate_storage_row(row)
        require_storage(row["errorCode"] is None or row["errorCode"] in errors)
    if storage["discoveryComplete"]:
        require_storage(not storage["truncated"] and
                        all(item["discoveryComplete"] for item in databases))
    if storage["status"] == "UNAVAILABLE":
        require_storage(not databases and not rows and errors)
    elif storage["status"] == "PARTIAL":
        require_storage(databases and start is not None)
    complete = storage["discoveryComplete"] and not errors
    require_storage((storage["status"] == "COMPLETE") == complete)
    if complete:
        require_storage(version == "8.2.12" and start is not None and
                        all(row["status"] != "UNAVAILABLE" for row in rows))
    require_storage(storage["totals"] == storage_totals(storage))


def unavailable_mongo_storage(code):
    result = {
        "schemaVersion": "mongo-collection-storage.v1",
        "expectedServerVersion": "8.2.12", "observedServerVersion": None,
        "startedAt": None,
        "finishedAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "limits": dict(MONGO_LIMITS), "status": "UNAVAILABLE",
        "discoveryComplete": False, "truncated": code == "OUTPUT_LIMIT",
        "errors": [code], "databases": [], "collections": [],
    }
    result["totals"] = storage_totals(result)
    return result


def read_mongo_storage(path, failure=""):
    try:
        input_path = Path(path)
        require_storage(not input_path.is_symlink())
        with input_path.open("rb") as handle:
            data = handle.read(MONGO_LIMITS["outputBytes"] + 1)
        if len(data) > MONGO_LIMITS["outputBytes"]:
            return unavailable_mongo_storage("OUTPUT_LIMIT")
        if failure:
            return unavailable_mongo_storage("TRANSPORT_FAILED")
        raw = json.loads(data)
        require_storage(isinstance(raw, dict) and set(raw) == {
            "schemaVersion", "expectedServerVersion", "observedServerVersion",
            "startedAt", "finishedAt", "limits", "status", "discoveryComplete",
            "truncated", "errors", "databases", "collections",
        })
        require_storage(raw["schemaVersion"] == "mongo-collection-storage-raw.v1")
        require_storage(isinstance(raw["databases"], list) and
                        len(raw["databases"]) <= MONGO_LIMITS["databases"])
        require_storage(isinstance(raw["collections"], list) and
                        len(raw["collections"]) <= MONGO_LIMITS["collections"])
        result = {**raw, "schemaVersion": "mongo-collection-storage.v1",
                  "databases": [], "collections": []}
        database_labels, collection_counts, seen = {}, {}, set()
        for index, database in enumerate(raw["databases"], 1):
            require_storage(isinstance(database, dict) and set(database) == {"name", "complete"})
            name = database["name"]
            require_storage(isinstance(name, str) and 0 < len(name.encode("utf-8")) <= 1024)
            require_storage(name not in database_labels and type(database["complete"]) is bool)
            label = name if name in MONGO_PUBLIC_COLLECTIONS else f"database-{index:03d}"
            database_labels[name] = label
            collection_counts[name] = 0
            result["databases"].append({
                "label": label, "scope": storage_scope(name),
                "discoveryComplete": database["complete"],
            })
        for row in raw["collections"]:
            require_storage(isinstance(row, dict) and set(row) == {
                "database", "collection", "kind", "status", "observedAt",
                "documentCount", "countUnit", "logicalBytes", "allocatedDataBytes",
                "allocatedIndexBytes", "errorCode",
            })
            database, collection = row["database"], row["collection"]
            require_storage(isinstance(database, str) and database in database_labels)
            require_storage(isinstance(collection, str) and
                            0 < len(collection.encode("utf-8")) <= 1024)
            require_storage((database, collection) not in seen)
            seen.add((database, collection))
            validate_storage_row(row)
            require_storage((row["kind"] == "timeseries-buckets") ==
                            collection.startswith("system.buckets."))
            collection_counts[database] += 1
            label = collection if collection in MONGO_PUBLIC_COLLECTIONS.get(database, set()) \
                else f"collection-{collection_counts[database]:03d}"
            projected = {key: value for key, value in row.items()
                         if key not in {"database", "collection"}}
            result["collections"].append({
                **projected, "databaseLabel": database_labels[database],
                "collectionLabel": label,
                "scope": storage_scope(database, collection, row["kind"]),
            })
        result["totals"] = storage_totals(result)
        validate_mongo_storage(result)
        return result
    except (OSError, ValueError, UnicodeError, KeyError, TypeError, RecursionError):
        return unavailable_mongo_storage("TRANSPORT_FAILED" if failure else "MALFORMED_OUTPUT")


BASELINE_HASHES = (
    "identitySha256", "instanceFingerprintSha256", "volumeFingerprintSha256",
    "attachmentFingerprintSha256", "deviceFingerprintSha256", "candidateImagesSha256",
)


def validate_baseline_proof(value, source_sha, control_sha, run_id, candidates):
    require_storage(isinstance(value, dict) and set(value) == {
        "schemaVersion", "sourceSha", "controlSha", "workflowRunId", "observedAt",
        *BASELINE_HASHES,
    })
    require_storage(value["schemaVersion"] == "k3s-observed-baseline.v1")
    require_storage(value["sourceSha"] == source_sha and value["controlSha"] == control_sha)
    require_storage(value["workflowRunId"] == str(run_id))
    storage_timestamp(value["observedAt"])
    for field in BASELINE_HASHES:
        require_storage(isinstance(value[field], str) and
                        re.fullmatch(r"[0-9a-f]{64}", value[field]))
    require_storage(value["candidateImagesSha256"] == checksum(candidates))


def build_baseline_proof(args):
    try:
        cloud = load_json(args.cloud, "private cloud baseline")
        node = load_json(args.node, "private node baseline")
        candidates = parse_candidate_images(args.candidate_images)
        require_storage(set(cloud) == {
            "instanceId", "instanceFingerprint", "volumeId", "attachmentId",
            "device", "volumeSizeBytes",
        })
        for key in ("instanceId", "volumeId", "attachmentId"):
            require_storage(isinstance(cloud[key], str) and
                            re.fullmatch(r"ocid1\.[a-z0-9.-]+", cloud[key]))
        require_storage(cloud["instanceFingerprint"] ==
                        hashlib.sha256(cloud["instanceId"].encode()).hexdigest())
        require_storage(cloud["device"] == "/dev/oracleoci/oraclevdb" and
                        cloud["volumeSizeBytes"] == 50 * 1073741824)
        require_storage(node["schemaVersion"] == "k3s-baseline-node.v1")
        require_storage(node["expectedNode"] == args.expected_node)
        require_storage(isinstance(node["nodes"], list) and len(node["nodes"]) == 1)
        identity = node["nodes"][0]
        require_storage(identity["name"] == args.expected_node and identity["ready"] is True)
        require_storage(isinstance(identity["uid"], str) and identity["uid"])
        require_storage(node["requestedDevice"] == cloud["device"])
        device = node["resolvedDevice"]
        require_storage(isinstance(device, str) and re.fullmatch(r"/dev/[A-Za-z0-9_-]+", device))
        require_storage(node["mountedDevice"] == device)
        block = node["blockDevice"]
        require_storage(block["path"] == device and block["type"] == "disk" and
                        block["size"] == cloud["volumeSizeBytes"])
        require_storage(isinstance(block["deviceNumber"], str) and
                        re.fullmatch(r"[0-9]+:[0-9]+", block["deviceNumber"]))
        require_storage(isinstance(node["rootDeviceNumber"], str) and
                        re.fullmatch(r"[0-9]+:[0-9]+", node["rootDeviceNumber"]))
        require_storage(block["deviceNumber"] != node["rootDeviceNumber"])
        require_storage(node["mongoMount"]["target"] == "/var/lib/betstan/mongo" and
                        node["mongoMount"]["fstype"] == "ext4")
        claim, volume = node["claim"], node["volume"]
        require_storage(claim["name"] == volume["name"] == claim["volumeName"] ==
                        "gaming-auth-mongo-data")
        require_storage(claim["phase"] == volume["phase"] == "Bound")
        require_storage(volume["localPath"] == "/var/lib/betstan/mongo")
        require_storage(volume["claim"]["namespace"] == "betstan-oci" and
                        volume["claim"]["name"] == claim["name"] and
                        volume["claim"]["uid"] == claim["uid"] and
                        isinstance(claim["uid"], str) and claim["uid"])
        expected = {f"gaming-{item['service']}": item for item in candidates}
        auxiliaries = {"gaming-auth-mongo", "gaming-rabbitmq"}
        deployments = node["deployments"]
        require_storage(isinstance(deployments, list) and len(deployments) <= 64)
        app_deployments = {}
        for deployment in deployments:
            name = deployment["name"]
            require_storage(isinstance(name, str) and name.endswith("-depl"))
            app = name[:-5]
            if app in auxiliaries:
                continue
            require_storage(app in expected and app not in app_deployments)
            require_storage(deployment["deleting"] is False)
            for field in ("generation", "observedGeneration", "replicas", "readyReplicas",
                          "availableReplicas", "updatedReplicas"):
                require_storage(type(deployment[field]) is int and deployment[field] >= 0)
            require_storage(deployment["replicas"] > 0 and
                            deployment["observedGeneration"] == deployment["generation"])
            require_storage(all(deployment[field] >= deployment["replicas"]
                                for field in ("readyReplicas", "availableReplicas", "updatedReplicas")))
            require_storage(deployment["containers"] ==
                            [{"name": app, "image": expected[app]["imageRef"]}])
            require_storage(isinstance(deployment["uid"], str) and deployment["uid"])
            app_deployments[app] = deployment
        require_storage(set(app_deployments) == set(expected))
        require_storage(isinstance(node["pods"], list) and len(node["pods"]) <= 128)
        app_pods = {name: [] for name in expected}
        mongo_pods = []
        for pod in node["pods"]:
            if pod["phase"] in {"Succeeded", "Failed"}:
                continue
            app = pod["app"]
            require_storage(app in expected or app in auxiliaries)
            if app == "gaming-rabbitmq":
                continue
            require_storage(pod["deleting"] is False)
            require_storage(pod["phase"] == "Running" and pod["ready"] is True and
                            pod["nodeName"] == args.expected_node)
            require_storage(isinstance(pod["uid"], str) and pod["uid"])
            require_storage(len(pod["containers"]) == len(pod["statuses"]) == 1)
            container, status = pod["containers"][0], pod["statuses"][0]
            require_storage(container["name"] == status["name"] == app and status["ready"] is True)
            if app == "gaming-auth-mongo":
                mongo_pods.append(pod)
                require_storage(container["defaultCommand"] is True)
                mounts = [item for item in container["mounts"] if item["mountPath"] == "/data/db"]
                require_storage(len(mounts) == 1)
                mount = mounts[0]
                require_storage(mount["readOnly"] is False and mount["subPath"] == "" and
                                mount["subPathExpr"] == "")
                volumes = [item for item in pod["volumes"] if item["name"] == mount["name"]]
                require_storage(len(volumes) == 1 and volumes[0]["claimName"] == claim["name"])
                continue
            candidate = expected[app]
            require_storage(container["image"] == candidate["imageRef"])
            require_storage(isinstance(status["imageID"], str) and any(
                status["imageID"].endswith("@" + digest)
                for digest in (candidate["manifestDigest"], candidate["platformDigest"])
            ))
            app_pods[app].append({
                "uid": pod["uid"], "image": container["image"], "imageID": status["imageID"],
            })
        require_storage(len(mongo_pods) == 1)
        require_storage(all(len(app_pods[name]) >= app_deployments[name]["replicas"]
                            for name in expected))
        stable = {
            "cloud": cloud, "node": identity, "device": device,
            "deviceNumber": block["deviceNumber"], "rootDeviceNumber": node["rootDeviceNumber"],
            "claimUid": claim["uid"], "mongoPodUid": mongo_pods[0]["uid"],
            "deployments": [app_deployments[name] for name in sorted(expected)],
            "pods": {name: sorted(app_pods[name], key=lambda row: row["uid"])
                     for name in sorted(expected)},
        }
        proof = {
            "schemaVersion": "k3s-observed-baseline.v1",
            "sourceSha": require_sha(args.source_sha, "baseline subject SHA"),
            "controlSha": require_sha(args.control_sha, "baseline control SHA"),
            "workflowRunId": require_positive(args.workflow_run_id, "baseline workflow run"),
            "observedAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "identitySha256": checksum(stable),
            "instanceFingerprintSha256": cloud["instanceFingerprint"],
            "volumeFingerprintSha256": hashlib.sha256(cloud["volumeId"].encode()).hexdigest(),
            "attachmentFingerprintSha256": hashlib.sha256(cloud["attachmentId"].encode()).hexdigest(),
            "deviceFingerprintSha256": hashlib.sha256(device.encode()).hexdigest(),
            "candidateImagesSha256": checksum(candidates),
        }
        validate_baseline_proof(proof, args.source_sha, args.control_sha, args.workflow_run_id, candidates)
    except (KeyError, TypeError, ValueError, IndexError, RecursionError):
        fail("historical baseline identity, storage binding, or live image generation is invalid")
    Path(args.output).write_text(canonical(proof) + "\n", encoding="utf-8")


def validate_diagnosis(value, observation=False):
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
    version_two = value.get("schemaVersion") == "k3s-node-disk-diagnosis.v2"
    if version_two:
        required.add("mongoStorage")
    if observation:
        required.update(("controlSha", "baselineValidation"))
    if set(value) != required:
        fail("diagnosis manifest has an unexpected schema")
    validate_checksum(value, "diagnosis manifest")
    if (
        value["schemaVersion"] not in {"k3s-node-disk-diagnosis.v1", "k3s-node-disk-diagnosis.v2"}
        or value["phase"] != "diagnose-disk"
        or value["workflowRunAttempt"] != "1"
        or value["thresholdPercent"] != THRESHOLD
        or value["terminalStatus"] != ("OBSERVED" if observation else "DIAGNOSED")
    ):
        fail("diagnosis manifest identity is invalid")
    require_sha(value["sourceSha"], "diagnosis source SHA")
    if observation:
        require_sha(value["controlSha"], "observation control SHA")
        if not version_two or value["controlSha"] == value["sourceSha"]:
            fail("historical observation control and subject identities are invalid")
        try:
            proofs = value["baselineValidation"]
            require_storage(isinstance(proofs, dict) and set(proofs) == {"before", "after"})
            for proof in proofs.values():
                validate_baseline_proof(proof, value["sourceSha"], value["controlSha"],
                                        value["workflowRunId"], value["candidateImages"])
            require_storage(all(proofs["before"][key] == proofs["after"][key]
                                for key in BASELINE_HASHES))
            require_storage(storage_timestamp(proofs["before"]["observedAt"]) <=
                            storage_timestamp(proofs["after"]["observedAt"]))
        except (KeyError, TypeError, ValueError):
            fail("historical observation baseline proof is missing or drifted")
    for name in ("infrastructureRunId", "ghcrBuildRunId", "workflowRunId"):
        require_positive(value[name], f"diagnosis {name}")
    if not re.fullmatch(r"[0-9a-f]{64}", value["securityStateSha256"]):
        fail("diagnosis security-state checksum is invalid")
    capacity = value["kubeletCapacity"]
    if version_two:
        try:
            validate_mongo_storage(value["mongoStorage"])
            identity = value["runtime"]["runtime"]
            fingerprint = capacity["nodeNameSha256"]
            require_storage(isinstance(fingerprint, str) and
                            re.fullmatch(r"[0-9a-f]{64}", fingerprint))
            require_storage(identity["nodeNameSha256"] == fingerprint and
                            identity["nodeName"] == capacity["nodeName"] == "k3s-node")
            require_storage(set(identity) == {
                "nodeName", "nodeNameSha256", "k3sVersion", "containerRuntimeVersion", "k3sActive",
            })
            capacity = {key: item for key, item in capacity.items() if key != "nodeNameSha256"}
        except (ValueError, KeyError, TypeError):
            fail("Mongo storage or public node evidence is malformed")
    validate_capacity(capacity)
    validate_candidate_images(value["candidateImages"])
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
    storage_path = getattr(args, "mongo_storage", None)
    content = {
            "schemaVersion": "k3s-node-disk-diagnosis.v2" if storage_path else "k3s-node-disk-diagnosis.v1",
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
            "kubeletCapacity": public_node_identity(capacity) if storage_path else capacity,
            "runtime": sanitized_runtime(runtime, private_node=bool(storage_path)),
            "candidateImages": candidate_images,
            "protection": classification,
            "securityStateSha256": state_sha,
            "terminalStatus": "DIAGNOSED",
        }
    if storage_path:
        content["mongoStorage"] = read_mongo_storage(
            storage_path, getattr(args, "mongo_storage_failure", "")
        )
    control_sha = getattr(args, "control_sha", None) or args.source_sha
    observation = control_sha != args.source_sha
    if observation:
        if not storage_path or not getattr(args, "baseline_before", None) or \
                not getattr(args, "baseline_after", None):
            fail("historical observations require fresh before/after baseline proofs")
        content.update({
            "controlSha": require_sha(control_sha, "observation control SHA"),
            "terminalStatus": "OBSERVED",
            "baselineValidation": {
                "before": load_json(args.baseline_before, "before-observation baseline"),
                "after": load_json(args.baseline_after, "after-observation baseline"),
            },
        })
    result = add_checksum(content)
    validate_diagnosis(result, observation=observation)
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
    if diagnosis["schemaVersion"] == "k3s-node-disk-diagnosis.v2":
        if public_node_identity(runtime["runtime"]) != diagnosis["runtime"]["runtime"]:
            fail("runtime node identity drifted since diagnosis")
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
        if not args.generation_map:
            fail("CRI reclaim requires a bound GHCR generation map")
        protected_sources, generation_map = parse_protected_generations(
            args.protected_generations, diagnosis, args.generation_map
        )
        proven_classification = classify(
            runtime, diagnosis["candidateImages"], protected_sources, generation_map
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
        and before["runtime"] == (
            public_node_identity(post["runtime"])
            if diagnosis["schemaVersion"] == "k3s-node-disk-diagnosis.v2"
            else post["runtime"]
        )
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


def validate_observation_command(args):
    observation = load_json(args.diagnosis, "historical observation")
    validate_diagnosis(observation, observation=True)
    if observation["controlSha"] != args.control_sha:
        fail("observation control SHA differs from the bound value")
    if observation["sourceSha"] != args.source_sha:
        fail("observation baseline SHA differs from the bound value")


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
    diagnose.add_argument("--mongo-storage")
    diagnose.add_argument("--mongo-storage-failure", choices=("", "TRANSPORT_FAILED"), default="")
    diagnose.add_argument("--control-sha")
    diagnose.add_argument("--baseline-before")
    diagnose.add_argument("--baseline-after")
    diagnose.add_argument("--output", required=True)
    diagnose.set_defaults(handler=build_diagnosis)

    validate = subparsers.add_parser("validate-diagnosis")
    validate.add_argument("--diagnosis", required=True)
    validate.add_argument("--source-sha")
    validate.add_argument("--infrastructure-run-id")
    validate.add_argument("--ghcr-build-run-id")
    validate.add_argument("--workflow-run-id")
    validate.set_defaults(handler=validate_diagnosis_command)

    baseline = subparsers.add_parser("validate-baseline")
    baseline.add_argument("--cloud", required=True)
    baseline.add_argument("--node", required=True)
    baseline.add_argument("--candidate-images", required=True)
    baseline.add_argument("--expected-node", required=True)
    baseline.add_argument("--source-sha", required=True)
    baseline.add_argument("--control-sha", required=True)
    baseline.add_argument("--workflow-run-id", required=True)
    baseline.add_argument("--output", required=True)
    baseline.set_defaults(handler=build_baseline_proof)

    observation = subparsers.add_parser("validate-observation")
    observation.add_argument("--diagnosis", required=True)
    observation.add_argument("--source-sha", required=True)
    observation.add_argument("--control-sha", required=True)
    observation.set_defaults(handler=validate_observation_command)

    plan = subparsers.add_parser("plan-reclaim")
    plan.add_argument("--diagnosis", required=True)
    plan.add_argument("--runtime", required=True)
    plan.add_argument("--capacity", required=True)
    plan.add_argument("--category", required=True)
    plan.add_argument("--image-ids", required=True)
    plan.add_argument("--protected-generations")
    plan.add_argument("--generation-map")
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
