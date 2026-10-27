#!/usr/bin/env python3
"""Classify and persist the bounded incident restoration continuation state."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
from typing import Any


SCHEMA = "betstan.oci-live-data-incident-restore-state.v1"
ACCESS_SCHEMA = "betstan.oci-live-data-incident-access.v1"
HANDOFF_SCHEMA = "betstan.oci-live-data-incident-control-handoff.v1"
PHASES = (
    "incident-active-fenced",
    "released-fenced",
    "released-unfenced-pending-publication",
    "readiness-captured",
    "sealed-pending-publication",
    "published",
)
DATA_KEYS = {
    "schema-version",
    "manifest-sha256",
    "owner-run-id",
    "control-sha",
    "operation-run-id",
    "operation-run-attempt",
    "phase",
    "sequence",
    "active-lock-json",
    "active-lock-sha256",
    "released-lock-json",
    "released-lock-sha256",
    "readiness-sha256",
    "evidence-sha256",
    "access-records-json",
    "access-records-sha256",
    "updated-at-epoch",
}
CORE_LOCK_KEYS = {
    "state",
    "holder",
    "operation-id",
    "source-sha",
    "acquired-at-epoch",
    "lease-duration-seconds",
    "lease-until-epoch",
    "released-at-epoch",
    "fencing-generation",
}
INCIDENT_LOCK_KEYS = {
    "incident-manifest-sha256",
    "incident-owner-run-id",
    "incident-restore-run-id",
    "incident-control-sha",
    "incident-current-run-metadata-sha256",
    "incident-request-created-at-epoch",
    "incident-provider-transition-epoch",
    "incident-predecessor-lease-until-epoch",
    "incident-new-lease-until-epoch",
}
SHA40 = re.compile(r"[0-9a-f]{40}")
SHA64 = re.compile(r"[0-9a-f]{64}")
POSITIVE = re.compile(r"[1-9][0-9]*")
NONNEGATIVE = re.compile(r"0|[1-9][0-9]*")
DNS_LABEL = re.compile(r"[a-z0-9]([-a-z0-9.]*[a-z0-9])?")
SAFE_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{1,511}")
IPV4_CIDR = re.compile(
    r"(?:25[0-5]|2[0-4][0-9]|1?[0-9]{1,2})"
    r"(?:\.(?:25[0-5]|2[0-4][0-9]|1?[0-9]{1,2})){3}/32"
)


class StateError(RuntimeError):
    pass


def fail(message: str) -> None:
    raise StateError(message)


def unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            fail(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def load_json(raw: str, label: str) -> dict[str, Any]:
    try:
        value = json.loads(raw, object_pairs_hook=unique_object)
    except StateError:
        raise
    except (json.JSONDecodeError, TypeError, ValueError):
        fail(f"{label} is malformed JSON")
    if not isinstance(value, dict):
        fail(f"{label} must be a JSON object")
    return value


def canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def require_env(name: str, pattern: re.Pattern[str]) -> str:
    value = os.environ.get(name, "")
    if pattern.fullmatch(value) is None:
        fail(f"{name} is missing or invalid")
    return value


def now_epoch() -> int:
    value = os.environ.get("NOW_EPOCH", "")
    if not value:
        return int(time.time())
    if POSITIVE.fullmatch(value) is None:
        fail("NOW_EPOCH is invalid")
    return int(value)


def bindings() -> dict[str, str]:
    return {
        "manifest": require_env("INCIDENT_MANIFEST_SHA256", SHA64),
        "owner": require_env("INCIDENT_OWNER_RUN_ID", POSITIVE),
        "control": require_env("INCIDENT_CONTROL_SHA", SHA40),
        "run": require_env("INCIDENT_RESTORE_RUN_ID", POSITIVE),
        "attempt": require_env("INCIDENT_RUN_ATTEMPT", POSITIVE),
        "journal": require_env(
            "INCIDENT_JOURNAL_IDENTITY_SHA256", SHA64
        ),
        "generation": require_env(
            "INCIDENT_CONTINUATION_GENERATION", NONNEGATIVE
        ),
        "lease_duration": require_env(
            "INCIDENT_LOCK_LEASE_SECONDS", POSITIVE
        ),
    }


def authenticated_journal_control(expected: dict[str, str]) -> str:
    value = os.environ.get(
        "INCIDENT_AUTHENTICATED_JOURNAL_CONTROL_SHA",
        expected["control"],
    )
    if SHA40.fullmatch(value) is None:
        fail("authenticated incident journal control is invalid")
    if value == expected["control"]:
        return value
    proof_path = os.environ.get(
        "INCIDENT_JOURNAL_CONTROL_HANDOFF_FILE", ""
    )
    if not proof_path:
        fail("authenticated incident journal control proof is missing")
    proof = exact_document(
        proof_path, "incident journal control handoff proof"
    )
    required = {
        "schemaVersion",
        "fromControlSha",
        "toControlSha",
        "relation",
        "manifestSha256",
        "journalIdentity",
        "journalIdentitySha256",
        "imageInputs",
        "proofSha256",
    }
    if set(proof) != required:
        fail("incident journal control handoff proof fields differ")
    proof_digest = proof.get("proofSha256")
    unsigned = dict(proof)
    unsigned.pop("proofSha256", None)
    if (
        proof.get("schemaVersion") != HANDOFF_SCHEMA
        or proof.get("fromControlSha") != value
        or proof.get("toControlSha") != expected["control"]
        or proof.get("relation")
        != (
            "same"
            if value == expected["control"]
            else "descendant"
        )
        or proof.get("manifestSha256") != expected["manifest"]
        or proof.get("journalIdentitySha256") != expected["journal"]
        or proof.get("imageInputs") != "unchanged"
        or not isinstance(proof.get("journalIdentity"), dict)
        or sha256_text(canonical(proof["journalIdentity"]))
        != expected["journal"]
        or SHA64.fullmatch(str(proof_digest)) is None
        or sha256_text(canonical(unsigned)) != proof_digest
    ):
        fail("incident journal control handoff proof differs")
    return value


def continuation_predecessor_bindings(
    expected: dict[str, str],
) -> dict[str, str]:
    run = os.environ.get("INCIDENT_CONTINUATION_RUN_ID", "0")
    control = os.environ.get(
        "INCIDENT_CONTINUATION_CONTROL_SHA", "none"
    )
    if run == "0" and control == "none":
        return expected
    if POSITIVE.fullmatch(run) is None or SHA40.fullmatch(control) is None:
        fail("incident continuation predecessor binding is invalid")
    result = dict(expected)
    result["run"] = run
    result["control"] = control
    return result


def lock_bindings(
    expected: dict[str, str], document: dict[str, Any]
) -> dict[str, str]:
    data = lock_data(document, "active incident lock")
    result = dict(expected)
    result["control"] = data.get("incident-control-sha", "")
    result["run"] = data.get("incident-restore-run-id", "")
    return result


def names() -> tuple[str, str, str]:
    namespace = os.environ.get("OCI_K8S_NAMESPACE", "betstan-oci")
    lock_name = os.environ.get(
        "LOCK_CONFIGMAP", "gaming-mongo-migration-lock"
    )
    state_name = os.environ.get(
        "INCIDENT_STATE_CONFIGMAP",
        "gaming-oci-live-data-incident-restore",
    )
    for label, value in (
        ("OCI_K8S_NAMESPACE", namespace),
        ("LOCK_CONFIGMAP", lock_name),
        ("INCIDENT_STATE_CONFIGMAP", state_name),
    ):
        if DNS_LABEL.fullmatch(value) is None:
            fail(f"{label} is invalid")
    return namespace, lock_name, state_name


def kubectl(arguments: list[str], input_text: str | None = None) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            ["kubectl", *arguments],
            input=input_text,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
    except OSError:
        fail("unable to execute kubectl")


def get_configmap(name: str, *, optional: bool = False) -> dict[str, Any] | None:
    namespace, _, _ = names()
    result = kubectl(
        ["get", "configmap", name, "-n", namespace, "-o", "json"]
    )
    if result.returncode == 0:
        return load_json(result.stdout, f"ConfigMap {name}")
    if optional and re.search(r"not[ -]?found", result.stderr, re.IGNORECASE):
        return None
    fail(f"unable to read ConfigMap {name}")


def metadata_identity(document: dict[str, Any], label: str) -> tuple[str, str]:
    metadata = document.get("metadata")
    if not isinstance(metadata, dict):
        fail(f"{label} metadata is missing")
    uid = metadata.get("uid")
    resource_version = metadata.get("resourceVersion")
    if not isinstance(uid, str) or not uid:
        fail(f"{label} UID is missing")
    if not isinstance(resource_version, str) or POSITIVE.fullmatch(resource_version) is None:
        fail(f"{label} resourceVersion is invalid")
    return uid, resource_version


def lock_data(document: dict[str, Any], label: str) -> dict[str, str]:
    metadata_identity(document, label)
    data = document.get("data")
    if not isinstance(data, dict) or any(
        not isinstance(key, str) or not isinstance(value, str)
        for key, value in data.items()
    ):
        fail(f"{label} data is malformed")
    return data


def positive_data(data: dict[str, str], key: str, label: str) -> int:
    value = data.get(key, "")
    if POSITIVE.fullmatch(value) is None:
        fail(f"{label} {key} is invalid")
    return int(value)


def validate_access_record(
    record: dict[str, Any],
    expected: dict[str, str] | None = None,
) -> None:
    required = {
        "schemaVersion",
        "runtimeMode",
        "manifestSha256",
        "ownerRunId",
        "journalIdentitySha256",
        "runId",
        "runAttempt",
        "controlSha",
        "authorityGeneration",
        "resource",
    }
    if set(record) != required:
        fail("incident access record fields differ")
    runtime = record.get("runtimeMode")
    resource = record.get("resource")
    if (
        record.get("schemaVersion") != ACCESS_SCHEMA
        or runtime not in {"oke", "k3s"}
        or SHA64.fullmatch(str(record.get("manifestSha256", "")))
        is None
        or type(record.get("ownerRunId")) is not int
        or record["ownerRunId"] < 1
        or SHA64.fullmatch(
            str(record.get("journalIdentitySha256", ""))
        )
        is None
        or type(record.get("runId")) is not int
        or record["runId"] < 1
        or type(record.get("runAttempt")) is not int
        or record["runAttempt"] != 1
        or SHA40.fullmatch(str(record.get("controlSha", ""))) is None
        or type(record.get("authorityGeneration")) is not int
        or record["authorityGeneration"] < 0
        or not isinstance(resource, dict)
    ):
        fail("incident access record binding is invalid")
    if expected is not None and (
        record["manifestSha256"] != expected["manifest"]
        or str(record["ownerRunId"]) != expected["owner"]
        or record["journalIdentitySha256"] != expected["journal"]
        or str(record["runId"]) != expected["run"]
        or record["controlSha"] != expected["control"]
        or str(record["authorityGeneration"])
        != expected["generation"]
    ):
        fail("incident access record does not bind the current authority")
    if runtime == "oke":
        if set(resource) != {
            "kind",
            "endpointNsgOcid",
            "ruleId",
            "description",
            "cidr",
            "expiresEpoch",
        }:
            fail("incident OKE access resource fields differ")
        if (
            resource.get("kind") != "oke-nsg-rule"
            or SAFE_ID.fullmatch(str(resource.get("endpointNsgOcid", "")))
            is None
            or SAFE_ID.fullmatch(str(resource.get("ruleId", ""))) is None
            or not isinstance(resource.get("description"), str)
            or len(resource["description"]) > 512
            or "\n" in resource["description"]
            or IPV4_CIDR.fullmatch(str(resource.get("cidr", ""))) is None
            or type(resource.get("expiresEpoch")) is not int
            or resource["expiresEpoch"] < 1
        ):
            fail("incident OKE access resource is invalid")
    else:
        if set(resource) != {
            "kind",
            "bastionOcid",
            "sessionId",
            "sessionName",
        }:
            fail("incident k3s access resource fields differ")
        if (
            resource.get("kind") != "k3s-bastion-session"
            or SAFE_ID.fullmatch(str(resource.get("bastionOcid", "")))
            is None
            or SAFE_ID.fullmatch(str(resource.get("sessionId", "")))
            is None
            or not re.fullmatch(
                r"betstan-k3s-ssh-[1-9][0-9]*-1",
                str(resource.get("sessionName", "")),
            )
        ):
            fail("incident k3s access resource is invalid")


def access_record_key(record: dict[str, Any]) -> tuple[str, str, str]:
    resource = record["resource"]
    identity = (
        resource["ruleId"]
        if record["runtimeMode"] == "oke"
        else resource["sessionId"]
    )
    return record["runtimeMode"], str(record["runId"]), identity


def parse_access_records(
    data: dict[str, str],
    expected: dict[str, str] | None = None,
) -> list[dict[str, Any]]:
    raw = data.get("access-records-json", "")
    digest = data.get("access-records-sha256", "")
    if (
        not raw
        or SHA64.fullmatch(digest) is None
        or sha256_text(raw) != digest
    ):
        fail("incident state access record binding is invalid")
    try:
        records = json.loads(raw, object_pairs_hook=unique_object)
    except StateError:
        raise
    except (json.JSONDecodeError, TypeError, ValueError):
        fail("incident state access records are malformed JSON")
    if (
        not isinstance(records, list)
        or not 1 <= len(records) <= 64
        or canonical(records) != raw
    ):
        fail("incident state access records are invalid")
    observed: set[tuple[str, str, str]] = set()
    observed_runs: set[tuple[str, str]] = set()
    observed_generations: set[int] = set()
    observed_runtimes: set[str] = set()
    for record in records:
        if not isinstance(record, dict):
            fail("incident state access record is malformed")
        validate_access_record(record)
        if expected is not None and (
            record["manifestSha256"] != expected["manifest"]
            or str(record["ownerRunId"]) != expected["owner"]
            or record["journalIdentitySha256"] != expected["journal"]
        ):
            fail("incident state access authority lineage differs")
        key = access_record_key(record)
        run_key = record["runtimeMode"], str(record["runId"])
        generation = record["authorityGeneration"]
        if (
            key in observed
            or run_key in observed_runs
            or generation in observed_generations
        ):
            fail("incident state contains duplicate access authority")
        observed.add(key)
        observed_runs.add(run_key)
        observed_generations.add(generation)
        observed_runtimes.add(record["runtimeMode"])
    if len(observed_runtimes) != 1:
        fail("incident state access runtime changed")
    return records


def load_current_access_record(
    expected: dict[str, str],
) -> dict[str, Any]:
    path = os.environ.get("INCIDENT_ACCESS_RECORD_FILE", "")
    if not path:
        fail("current incident access record file is missing")
    record = exact_document(path, "current incident access record")
    validate_access_record(record, expected)
    return record


def append_access_record(
    records: list[dict[str, Any]],
    record: dict[str, Any],
) -> tuple[list[dict[str, Any]], bool]:
    key = access_record_key(record)
    for existing in records:
        if (
            existing["runtimeMode"] == record["runtimeMode"]
            and str(existing["runId"]) == str(record["runId"])
        ):
            if existing != record:
                fail("incident access authority was rebound")
            return records, False
        if access_record_key(existing) == key:
            fail("incident access resource identity was reused")
    if len(records) >= 64:
        fail("incident access record limit exceeded")
    return [*records, record], True


def validate_active_lock(
    document: dict[str, Any],
    expected: dict[str, str],
    *,
    require_current_run: bool,
) -> None:
    data = lock_data(document, "active incident lock")
    if set(data) != CORE_LOCK_KEYS | INCIDENT_LOCK_KEYS:
        fail("active incident lock fields differ")
    restore_run = data.get("incident-restore-run-id", "")
    if POSITIVE.fullmatch(restore_run) is None:
        fail("active incident lock restore run is invalid")
    if require_current_run and restore_run != expected["run"]:
        fail("active incident lock is not owned by the current run")
    exact = {
        "state": "active",
        "holder": f"live-data-incident-{restore_run}-1",
        "operation-id": "live-data-incident-restore",
        "source-sha": expected["control"],
        "released-at-epoch": "0",
        "incident-manifest-sha256": expected["manifest"],
        "incident-owner-run-id": expected["owner"],
        "incident-restore-run-id": restore_run,
        "incident-control-sha": expected["control"],
    }
    if any(data.get(key) != value for key, value in exact.items()):
        fail("active incident lock binding differs")
    acquired = positive_data(data, "acquired-at-epoch", "active incident lock")
    duration = positive_data(
        data, "lease-duration-seconds", "active incident lock"
    )
    lease_until = positive_data(
        data, "lease-until-epoch", "active incident lock"
    )
    request_created = positive_data(
        data,
        "incident-request-created-at-epoch",
        "active incident lock",
    )
    transition = positive_data(
        data,
        "incident-provider-transition-epoch",
        "active incident lock",
    )
    predecessor_cutoff = positive_data(
        data,
        "incident-predecessor-lease-until-epoch",
        "active incident lock",
    )
    incident_new_lease = positive_data(
        data,
        "incident-new-lease-until-epoch",
        "active incident lock",
    )
    positive_data(data, "fencing-generation", "active incident lock")
    if SHA64.fullmatch(
        data.get("incident-current-run-metadata-sha256", "")
    ) is None:
        fail("active incident lock current-run metadata digest is invalid")
    if (
        lease_until != acquired + duration
        or acquired != transition
        or incident_new_lease != lease_until
        or request_created <= predecessor_cutoff
        or transition < request_created
        or transition <= predecessor_cutoff
        or duration != int(expected["lease_duration"])
        or not 60 <= duration <= 86400
    ):
        fail("active incident lock lease is inconsistent")


def validate_active_successor(
    predecessor: dict[str, Any],
    successor: dict[str, Any],
    successor_expected: dict[str, str],
) -> None:
    predecessor_bindings = lock_bindings(successor_expected, predecessor)
    validate_active_lock(
        predecessor,
        predecessor_bindings,
        require_current_run=True,
    )
    validate_active_lock(
        successor,
        successor_expected,
        require_current_run=True,
    )
    predecessor_uid, predecessor_version = metadata_identity(
        predecessor, "predecessor active incident lock"
    )
    successor_uid, successor_version = metadata_identity(
        successor, "successor active incident lock"
    )
    predecessor_data = lock_data(
        predecessor, "predecessor active incident lock"
    )
    successor_data = lock_data(
        successor, "successor active incident lock"
    )
    predecessor_generation = positive_data(
        predecessor_data,
        "fencing-generation",
        "predecessor active incident lock",
    )
    successor_generation = positive_data(
        successor_data,
        "fencing-generation",
        "successor active incident lock",
    )
    predecessor_lease_until = positive_data(
        predecessor_data,
        "lease-until-epoch",
        "predecessor active incident lock",
    )
    successor_acquired = positive_data(
        successor_data,
        "acquired-at-epoch",
        "successor active incident lock",
    )
    successor_cutoff = positive_data(
        successor_data,
        "incident-predecessor-lease-until-epoch",
        "successor active incident lock",
    )
    if (
        successor_uid != predecessor_uid
        or int(successor_version) <= int(predecessor_version)
        or successor_generation != predecessor_generation + 1
        or successor_cutoff != predecessor_lease_until
        or successor_acquired < predecessor_lease_until
    ):
        fail("active incident lock is not the exact successor")


def validate_released_successor(
    active_document: dict[str, Any], released_document: dict[str, Any]
) -> None:
    active_uid, active_version = metadata_identity(
        active_document, "active incident lock"
    )
    released_uid, released_version = metadata_identity(
        released_document, "released incident lock"
    )
    active = lock_data(active_document, "active incident lock")
    released = lock_data(released_document, "released incident lock")
    if set(released) != CORE_LOCK_KEYS:
        fail("released incident lock is not canonical")
    if (
        released_uid != active_uid
        or int(released_version) <= int(active_version)
    ):
        fail("released incident lock identity did not advance")
    active_generation = positive_data(
        active, "fencing-generation", "active incident lock"
    )
    released_generation = positive_data(
        released, "fencing-generation", "released incident lock"
    )
    released_at = positive_data(
        released, "released-at-epoch", "released incident lock"
    )
    expected = {
        "state": "released",
        "holder": "",
        "operation-id": active["operation-id"],
        "source-sha": active["source-sha"],
        "acquired-at-epoch": active["acquired-at-epoch"],
        "lease-duration-seconds": "0",
        "lease-until-epoch": "0",
        "fencing-generation": str(active_generation + 1),
    }
    if any(released.get(key) != value for key, value in expected.items()):
        fail("released incident lock is not the exact active successor")
    if released_at < int(active["acquired-at-epoch"]):
        fail("released incident lock timestamp is inconsistent")


def embedded_lock(data: dict[str, str], prefix: str) -> dict[str, Any] | None:
    raw = data[f"{prefix}-lock-json"]
    digest = data[f"{prefix}-lock-sha256"]
    if not raw and not digest:
        return None
    if not raw or SHA64.fullmatch(digest) is None or sha256_text(raw) != digest:
        fail(f"incident state {prefix} lock binding is invalid")
    document = load_json(raw, f"incident state {prefix} lock")
    if canonical(document) != raw:
        fail(f"incident state {prefix} lock is not canonical")
    return document


def validate_journal(document: dict[str, Any], expected: dict[str, str]) -> dict[str, str]:
    metadata_identity(document, "incident state")
    data = document.get("data")
    if not isinstance(data, dict) or set(data) != DATA_KEYS or any(
        not isinstance(value, str) for value in data.values()
    ):
        fail("incident state fields differ")
    control = data.get("control-sha", "")
    if control not in {
        expected["control"],
        authenticated_journal_control(expected),
    }:
        fail("incident state control is not authenticated")
    fixed = {
        "schema-version": SCHEMA,
        "manifest-sha256": expected["manifest"],
        "owner-run-id": expected["owner"],
        "operation-run-attempt": "1",
    }
    if any(data.get(key) != value for key, value in fixed.items()):
        fail("incident state immutable binding differs")
    if POSITIVE.fullmatch(data["operation-run-id"]) is None:
        fail("incident state operation run is invalid")
    if data["phase"] not in PHASES:
        fail("incident state phase is invalid")
    if POSITIVE.fullmatch(data["sequence"]) is None:
        fail("incident state sequence is invalid")
    if POSITIVE.fullmatch(data["updated-at-epoch"]) is None:
        fail("incident state timestamp is invalid")
    active = embedded_lock(data, "active")
    released = embedded_lock(data, "released")
    parse_access_records(data, expected)
    if active is None:
        fail("incident state active lock is missing")
    journal_expected = lock_bindings(expected, active)
    if journal_expected["control"] != control:
        fail("incident state control differs from its active lock")
    validate_active_lock(
        active, journal_expected, require_current_run=True
    )
    if data["phase"] == "incident-active-fenced":
        if data["operation-run-id"] != journal_expected["run"]:
            fail("active incident state operation run differs")
        if released is not None or data["readiness-sha256"] or data["evidence-sha256"]:
            fail("active incident state contains later-phase evidence")
    else:
        if released is None:
            fail("released incident state lock is missing")
        validate_released_successor(active, released)
    if data["phase"] in {
        "incident-active-fenced",
        "released-fenced",
        "released-unfenced-pending-publication",
    } and (data["readiness-sha256"] or data["evidence-sha256"]):
        fail("incident state contains premature publication evidence")
    if data["phase"] == "readiness-captured":
        if SHA64.fullmatch(data["readiness-sha256"]) is None or data["evidence-sha256"]:
            fail("readiness incident state is invalid")
    if data["phase"] in {"sealed-pending-publication", "published"}:
        if (
            SHA64.fullmatch(data["readiness-sha256"]) is None
            or SHA64.fullmatch(data["evidence-sha256"]) is None
        ):
            fail("sealed incident state evidence is invalid")
    return data


def exact_document(path: str, label: str) -> dict[str, Any]:
    file_path = Path(path)
    if not file_path.is_file() or file_path.is_symlink():
        fail(f"{label} file is missing or unsafe")
    return load_json(file_path.read_text(encoding="utf-8"), label)


def observed_fence() -> bool:
    value = os.environ.get("OBSERVED_FENCE_STATUS", "")
    if value not in {"true", "false"}:
        fail("OBSERVED_FENCE_STATUS must be true or false")
    return value == "true"


def held_preimage() -> tuple[str, int, dict[str, str]]:
    expected = {
        "state": "active",
        "holder": require_env("HELD_LOCK_HOLDER", re.compile(r"[A-Za-z0-9._-]+")),
        "operation-id": require_env(
            "HELD_LOCK_OPERATION_ID", re.compile(r"[A-Za-z0-9._-]+")
        ),
        "source-sha": require_env("HELD_LOCK_SOURCE_SHA", SHA40),
        "acquired-at-epoch": require_env("HELD_ACQUIRED_AT_EPOCH", POSITIVE),
        "lease-duration-seconds": require_env(
            "HELD_LEASE_DURATION_SECONDS", POSITIVE
        ),
        "lease-until-epoch": require_env("HELD_LEASE_UNTIL_EPOCH", POSITIVE),
        "released-at-epoch": os.environ.get("HELD_RELEASED_AT_EPOCH", ""),
        "fencing-generation": require_env("HELD_FENCING_GENERATION", POSITIVE),
    }
    if expected["released-at-epoch"] != "0":
        fail("HELD_RELEASED_AT_EPOCH must be zero")
    uid = require_env("HELD_LOCK_UID", re.compile(r"[A-Za-z0-9._-]+"))
    version = int(require_env("HELD_RESOURCE_VERSION", POSITIVE))
    return uid, version, expected


def held_preimage_matches(document: dict[str, Any]) -> bool:
    expected_uid, expected_version, expected = held_preimage()
    uid, version = metadata_identity(document, "held lock")
    if (
        uid != expected_uid
        or int(version) != expected_version
    ):
        return False
    return lock_data(document, "held lock") == expected


def validate_held_successor(
    document: dict[str, Any], expected: dict[str, str]
) -> None:
    validate_active_lock(
        document, expected, require_current_run=True
    )
    held_uid, held_version, held = held_preimage()
    successor_uid, successor_version = metadata_identity(
        document, "active incident lock successor"
    )
    successor = lock_data(
        document, "active incident lock successor"
    )
    generation = positive_data(
        successor,
        "fencing-generation",
        "active incident lock successor",
    )
    acquired = positive_data(
        successor,
        "acquired-at-epoch",
        "active incident lock successor",
    )
    request_created = positive_data(
        successor,
        "incident-request-created-at-epoch",
        "active incident lock successor",
    )
    predecessor_cutoff = positive_data(
        successor,
        "incident-predecessor-lease-until-epoch",
        "active incident lock successor",
    )
    if (
        successor_uid != held_uid
        or int(successor_version) <= held_version
        or generation != int(held["fencing-generation"]) + 1
        or predecessor_cutoff != int(held["lease-until-epoch"])
        or request_created <= int(held["lease-until-epoch"])
        or acquired < request_created
    ):
        fail(
            "active incident lock is not the exact expired held successor"
        )


def classify() -> dict[str, Any]:
    expected = bindings()
    _, lock_name, state_name = names()
    fence = observed_fence()
    live = get_configmap(lock_name)
    assert live is not None
    journal = get_configmap(state_name, optional=True)
    if journal is None:
        if held_preimage_matches(live):
            if not fence:
                fail("held predecessor lost the incident fence")
            return {"classification": "held-predecessor"}
        predecessor_expected = continuation_predecessor_bindings(expected)
        validate_held_successor(live, predecessor_expected)
        if not fence:
            fail("unrecorded active incident lock lost the incident fence")
        data = lock_data(live, "active incident lock")
        return {
            "classification": "incident-active-successor-fenced",
            "predecessorRestoreRunId": data["incident-restore-run-id"],
            "successorControlSha": data["incident-control-sha"],
            "journalPhase": "missing",
        }

    data = validate_journal(journal, expected)
    active = embedded_lock(data, "active")
    assert active is not None
    released = embedded_lock(data, "released")
    live_canonical = canonical(live)
    active_canonical = canonical(active)
    released_canonical = canonical(released) if released is not None else ""

    if data["phase"] == "incident-active-fenced":
        if live_canonical == active_canonical:
            if not fence:
                fail("active incident state lost the incident fence")
            active_data = lock_data(active, "active incident lock")
            return {
                "classification": "incident-active-fenced",
                "predecessorRestoreRunId": active_data[
                    "incident-restore-run-id"
                ],
                "journalPhase": data["phase"],
            }
        live_data = lock_data(live, "live incident lock")
        if live_data.get("state") == "active":
            successor_expected = continuation_predecessor_bindings(
                expected
            )
            validate_active_successor(
                active, live, successor_expected
            )
            if not fence:
                fail("active incident successor lost the incident fence")
            return {
                "classification": "incident-active-successor-fenced",
                "predecessorRestoreRunId": live_data[
                    "incident-restore-run-id"
                ],
                "successorControlSha": live_data[
                    "incident-control-sha"
                ],
                "journalPhase": data["phase"],
            }
        validate_released_successor(active, live)
        return {
            "classification": (
                "released-fenced-recovery"
                if fence
                else "released-unfenced-recovery"
            ),
            "journalPhase": data["phase"],
        }

    if released is None or live_canonical != released_canonical:
        fail("live released lock differs from incident state")
    if data["phase"] == "released-fenced":
        return {
            "classification": (
                "released-fenced"
                if fence
                else "released-unfenced-recovery"
            ),
            "journalPhase": data["phase"],
        }
    if fence:
        fail("publication phase unexpectedly regained the incident fence")
    if data["phase"] == "published":
        return {"classification": "published", "journalPhase": data["phase"]}
    return {
        "classification": "released-unfenced-pending-publication",
        "journalPhase": data["phase"],
    }


def desired_document(
    observed: dict[str, Any],
    data: dict[str, str],
) -> dict[str, Any]:
    document = json.loads(canonical(observed))
    metadata = document.setdefault("metadata", {})
    metadata.pop("managedFields", None)
    document.pop("status", None)
    document["data"] = data
    return document


def replace_once(
    observed: dict[str, Any],
    desired_data: dict[str, str],
) -> str:
    _, _, state_name = names()
    preimage = canonical(observed)
    replacement = desired_document(observed, desired_data)
    result = kubectl(["replace", "-f", "-"], canonical(replacement))
    if result.returncode == 0:
        return "applied"
    reread = get_configmap(state_name, optional=True)
    if reread is None:
        fail("incident state replace result is ambiguous")
    if reread.get("data") == desired_data:
        return "applied-after-reread"
    if canonical(reread) == preimage:
        fail("incident state replace was not applied; no retry is permitted")
    fail("incident state replace result is ambiguous")


def create_once(data: dict[str, str]) -> str:
    namespace, _, state_name = names()
    document = {
        "apiVersion": "v1",
        "kind": "ConfigMap",
        "metadata": {"name": state_name, "namespace": namespace},
        "data": data,
    }
    result = kubectl(["create", "-f", "-"], canonical(document))
    if result.returncode == 0:
        return "applied"
    reread = get_configmap(state_name, optional=True)
    if reread is not None and reread.get("data") == data:
        return "applied-after-reread"
    if reread is None:
        fail("incident state create was not applied; no retry is permitted")
    fail("incident state create result is ambiguous")


def base_data(
    expected: dict[str, str],
    phase: str,
    sequence: int,
    active: dict[str, Any],
    released: dict[str, Any] | None,
    access_records: list[dict[str, Any]],
    readiness_sha256: str = "",
    evidence_sha256: str = "",
) -> dict[str, str]:
    active_raw = canonical(active)
    released_raw = canonical(released) if released is not None else ""
    access_raw = canonical(access_records)
    return {
        "schema-version": SCHEMA,
        "manifest-sha256": expected["manifest"],
        "owner-run-id": expected["owner"],
        "control-sha": expected["control"],
        "operation-run-id": expected["run"],
        "operation-run-attempt": expected["attempt"],
        "phase": phase,
        "sequence": str(sequence),
        "active-lock-json": active_raw,
        "active-lock-sha256": sha256_text(active_raw),
        "released-lock-json": released_raw,
        "released-lock-sha256": (
            sha256_text(released_raw) if released_raw else ""
        ),
        "readiness-sha256": readiness_sha256,
        "evidence-sha256": evidence_sha256,
        "access-records-json": access_raw,
        "access-records-sha256": sha256_text(access_raw),
        "updated-at-epoch": str(now_epoch()),
    }


def record_active(path: str) -> str:
    expected = bindings()
    if expected["attempt"] != "1":
        fail("incident restoration supports only run attempt 1")
    active = exact_document(path, "active lock postimage")
    access_record = load_current_access_record(expected)
    validate_active_lock(active, expected, require_current_run=True)
    if not observed_fence():
        fail("active incident state requires the incident fence")
    _, lock_name, state_name = names()
    live = get_configmap(lock_name)
    if live is None or canonical(live) != canonical(active):
        fail("active lock postimage differs from the live lock")
    observed = get_configmap(state_name, optional=True)
    if observed is None:
        validate_held_successor(active, expected)
        return create_once(
            base_data(
                expected,
                PHASES[0],
                1,
                active,
                None,
                [access_record],
            )
        )
    current = validate_journal(observed, expected)
    if current["phase"] != PHASES[0]:
        fail("active incident state cannot replace a later phase")
    access_records, appended = append_access_record(
        parse_access_records(current), access_record
    )
    if (
        current["active-lock-json"] == canonical(active)
        and not appended
    ):
        return "already-applied"
    predecessor = embedded_lock(current, "active")
    assert predecessor is not None
    if canonical(predecessor) != canonical(active):
        validate_active_successor(predecessor, active, expected)
    desired = base_data(
        expected,
        PHASES[0],
        int(current["sequence"]) + 1,
        active,
        None,
        access_records,
    )
    return replace_once(observed, desired)


def adopt_active(path: str) -> str:
    expected = bindings()
    if expected["attempt"] != "1":
        fail("incident restoration supports only run attempt 1")
    active = exact_document(path, "active lock successor")
    access_record = load_current_access_record(expected)
    successor_expected = continuation_predecessor_bindings(expected)
    validate_active_lock(
        active, successor_expected, require_current_run=True
    )
    if not observed_fence():
        fail("active incident successor requires the incident fence")
    _, lock_name, state_name = names()
    live = get_configmap(lock_name)
    if live is None or canonical(live) != canonical(active):
        fail("active lock successor differs from the live lock")
    observed = get_configmap(state_name, optional=True)
    if observed is None:
        validate_held_successor(active, successor_expected)
        return create_once(
            base_data(
                successor_expected,
                PHASES[0],
                1,
                active,
                None,
                [access_record],
            )
        )
    current = validate_journal(observed, expected)
    if current["phase"] != PHASES[0]:
        fail("active incident successor cannot replace a later phase")
    predecessor = embedded_lock(current, "active")
    assert predecessor is not None
    access_records, appended = append_access_record(
        parse_access_records(current), access_record
    )
    if canonical(predecessor) == canonical(active) and not appended:
        return "already-applied"
    if canonical(predecessor) != canonical(active):
        validate_active_successor(
            predecessor, active, successor_expected
        )
    desired = base_data(
        successor_expected,
        PHASES[0],
        int(current["sequence"]) + 1,
        active,
        None,
        access_records,
    )
    return replace_once(observed, desired)


def record_access(path: str) -> str:
    expected = bindings()
    access_record = exact_document(
        path, "current incident access record"
    )
    validate_access_record(access_record, expected)
    _, _, state_name = names()
    observed = get_configmap(state_name)
    assert observed is not None
    current = validate_journal(observed, expected)
    records, appended = append_access_record(
        parse_access_records(current), access_record
    )
    if not appended:
        return "already-applied"
    active = embedded_lock(current, "active")
    released = embedded_lock(current, "released")
    assert active is not None
    journal_expected = dict(expected)
    journal_expected["control"] = current["control-sha"]
    journal_expected["run"] = current["operation-run-id"]
    desired = base_data(
        journal_expected,
        current["phase"],
        int(current["sequence"]) + 1,
        active,
        released,
        records,
        current["readiness-sha256"],
        current["evidence-sha256"],
    )
    return replace_once(observed, desired)


def access_records() -> list[dict[str, Any]]:
    expected = bindings()
    _, _, state_name = names()
    observed = get_configmap(state_name)
    assert observed is not None
    current = validate_journal(observed, expected)
    return parse_access_records(current)


def record_released(path: str) -> str:
    expected = bindings()
    released = exact_document(path, "released lock postimage")
    _, lock_name, state_name = names()
    live = get_configmap(lock_name)
    if live is None or canonical(live) != canonical(released):
        fail("released lock postimage differs from the live lock")
    observed = get_configmap(state_name)
    assert observed is not None
    current = validate_journal(observed, expected)
    active = embedded_lock(current, "active")
    assert active is not None
    validate_released_successor(active, released)
    if current["phase"] == "released-fenced":
        if current["released-lock-json"] != canonical(released):
            fail("released incident state differs")
        return "already-applied"
    if current["phase"] != "incident-active-fenced":
        fail("released incident state transition is out of order")
    journal_expected = dict(expected)
    journal_expected["control"] = current["control-sha"]
    desired = base_data(
        journal_expected,
        "released-fenced",
        int(current["sequence"]) + 1,
        active,
        released,
        parse_access_records(current),
    )
    return replace_once(observed, desired)


def transition(phase: str, digest_name: str | None = None) -> str:
    expected = bindings()
    _, lock_name, state_name = names()
    observed = get_configmap(state_name)
    assert observed is not None
    current = validate_journal(observed, expected)
    active = embedded_lock(current, "active")
    released = embedded_lock(current, "released")
    assert active is not None and released is not None
    live = get_configmap(lock_name)
    if live is None or canonical(live) != canonical(released):
        fail("live released lock differs before incident state transition")
    readiness = current["readiness-sha256"]
    evidence = current["evidence-sha256"]
    journal_expected = dict(expected)
    journal_expected["control"] = current["control-sha"]
    if phase == "released-unfenced-pending-publication":
        if observed_fence():
            fail("unfenced incident state requires the released fence")
        allowed = {"released-fenced", phase}
    elif phase == "readiness-captured":
        if observed_fence():
            fail("readiness state requires the released fence")
        allowed = {
            "released-unfenced-pending-publication",
            "readiness-captured",
            "sealed-pending-publication",
        }
        readiness = require_env(digest_name or "", SHA64)
        if current["phase"] == "sealed-pending-publication":
            evidence = ""
    elif phase == "sealed-pending-publication":
        if observed_fence():
            fail("sealed incident state requires the released fence")
        allowed = {"readiness-captured", phase}
        evidence = require_env(digest_name or "", SHA64)
    elif phase == "published":
        if observed_fence():
            fail("published incident state requires the released fence")
        allowed = {"sealed-pending-publication", phase}
    else:
        fail("unsupported incident state transition")
    if current["phase"] not in allowed:
        fail("incident state transition is out of order")
    if current["phase"] == phase:
        if current["readiness-sha256"] != readiness or current[
            "evidence-sha256"
        ] != evidence:
            desired = base_data(
                journal_expected,
                phase,
                int(current["sequence"]) + 1,
                active,
                released,
                parse_access_records(current),
                readiness,
                evidence,
            )
            return replace_once(observed, desired)
        return "already-applied"
    desired = base_data(
        journal_expected,
        phase,
        int(current["sequence"]) + 1,
        active,
        released,
        parse_access_records(current),
        readiness,
        evidence,
    )
    return replace_once(observed, desired)


def main(argv: list[str]) -> int:
    if not argv:
        fail("incident state command is required")
    command = argv[0]
    if command == "classify" and len(argv) == 1:
        print(canonical(classify()))
        return 0
    if command == "access-records" and len(argv) == 1:
        print(canonical(access_records()))
        return 0
    if command == "record-active" and len(argv) == 2:
        result = record_active(argv[1])
    elif command == "adopt-active" and len(argv) == 2:
        result = adopt_active(argv[1])
    elif command == "record-access" and len(argv) == 2:
        result = record_access(argv[1])
    elif command == "record-released" and len(argv) == 2:
        result = record_released(argv[1])
    elif command == "record-unfenced" and len(argv) == 1:
        result = transition("released-unfenced-pending-publication")
    elif command == "record-readiness" and len(argv) == 1:
        result = transition("readiness-captured", "READINESS_SHA256")
    elif command == "record-sealed" and len(argv) == 1:
        result = transition(
            "sealed-pending-publication", "EVIDENCE_SHA256"
        )
    elif command == "record-published" and len(argv) == 1:
        result = transition("published")
    else:
        fail("incident state command or arguments are invalid")
    print(f"incident_restore_state={command} status=PASS result={result}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except StateError as error:
        print(
            f"incident_restore_state={sys.argv[1] if len(sys.argv) > 1 else 'missing'} "
            f"status=FAIL reason={error}",
            file=sys.stderr,
        )
        raise SystemExit(1)
