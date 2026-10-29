#!/usr/bin/env python3
"""Capture and reconcile bounded incident runner-access resources."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import time
from typing import Any


ACCESS_SCHEMA = "betstan.oci-live-data-incident-access.v1"
LINEAGE_CLEANUP_SCHEMA = (
    "betstan.oci-live-data-incident-access-cleanup-lineage.v1"
)
REPORT_SCHEMA = (
    "betstan.oci-live-data-incident-access-cleanup-report.v1"
)
MAX_CLEANUP_LINEAGE = 32
SHA40 = re.compile(r"[0-9a-f]{40}")
SHA64 = re.compile(r"[0-9a-f]{64}")
POSITIVE = re.compile(r"[1-9][0-9]*")
NONNEGATIVE = re.compile(r"0|[1-9][0-9]*")
SAFE_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{1,511}")
IPV4_CIDR = re.compile(
    r"(?:25[0-5]|2[0-4][0-9]|1?[0-9]{1,2})"
    r"(?:\.(?:25[0-5]|2[0-4][0-9]|1?[0-9]{1,2})){3}/32"
)
RULE_DESCRIPTION = re.compile(
    r"betstan-github-runner run=([1-9][0-9]*) "
    r"attempt=1 expires=([1-9][0-9]*)"
)


class AccessError(RuntimeError):
    pass


def fail(message: str) -> None:
    raise AccessError(message)


def unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            fail(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def digest(value: Any) -> str:
    return hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()


def load_json_text(raw: str, label: str) -> Any:
    try:
        return json.loads(raw, object_pairs_hook=unique_object)
    except AccessError:
        raise
    except (json.JSONDecodeError, TypeError, ValueError):
        fail(f"{label} is malformed JSON")


def load_json_file(path: str, label: str) -> Any:
    file_path = Path(path)
    if not file_path.is_file() or file_path.is_symlink():
        fail(f"{label} file is missing or unsafe")
    if file_path.stat().st_size > 131072:
        fail(f"{label} file exceeds its size bound")
    return load_json_text(file_path.read_text(encoding="utf-8"), label)


def write_private_json(path: str, value: Any) -> None:
    output = Path(path)
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(output.name + ".new")
    if temporary.exists() or temporary.is_symlink():
        fail("incident access output temporary path already exists")
    descriptor = os.open(
        temporary,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL,
        0o600,
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(canonical(value))
            handle.write("\n")
        os.replace(temporary, output)
        os.chmod(output, 0o600)
    finally:
        if temporary.exists():
            temporary.unlink()


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


def current_binding() -> dict[str, str]:
    attempt = require_env("INCIDENT_RUN_ATTEMPT", POSITIVE)
    if attempt != "1":
        fail("incident access requires run attempt 1")
    return {
        "manifest": require_env("INCIDENT_MANIFEST_SHA256", SHA64),
        "owner": require_env("INCIDENT_OWNER_RUN_ID", POSITIVE),
        "journal": require_env(
            "INCIDENT_JOURNAL_IDENTITY_SHA256", SHA64
        ),
        "run": require_env("INCIDENT_RESTORE_RUN_ID", POSITIVE),
        "control": require_env("INCIDENT_CONTROL_SHA", SHA40),
        "generation": require_env(
            "INCIDENT_CONTINUATION_GENERATION", NONNEGATIVE
        ),
        "predecessorAuthority": os.environ.get(
            "INCIDENT_CONTINUATION_AUTHORITY_SHA256", "none"
        ),
        "predecessorRun": os.environ.get(
            "INCIDENT_CONTINUATION_RUN_ID", "0"
        ),
        "predecessorControl": os.environ.get(
            "INCIDENT_CONTINUATION_CONTROL_SHA", "none"
        ),
    }


def oci(arguments: list[str]) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            ["oci", *arguments],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
    except OSError:
        fail("unable to execute OCI CLI")


def oci_json(
    arguments: list[str],
    label: str,
    *,
    normalize_empty_list: bool = False,
) -> Any:
    result = oci([*arguments, "--output", "json"])
    if result.returncode != 0:
        fail(f"unable to read {label}")
    if normalize_empty_list and not result.stdout.strip():
        return {"data": []}
    return load_json_text(result.stdout, label)


def data_list(value: Any, label: str) -> list[dict[str, Any]]:
    if (
        not isinstance(value, dict)
        or set(value) != {"data"}
        or not isinstance(value["data"], list)
        or not all(isinstance(item, dict) for item in value["data"])
    ):
        fail(f"{label} response schema differs")
    return value["data"]


def parse_state_file(path: str, label: str) -> dict[str, str]:
    file_path = Path(path)
    if not file_path.is_file() or file_path.is_symlink():
        fail(f"{label} state file is missing or unsafe")
    if file_path.stat().st_size > 32768:
        fail(f"{label} state file exceeds its size bound")
    values: dict[str, str] = {}
    for raw in file_path.read_text(encoding="utf-8").splitlines():
        match = re.fullmatch(r"([A-Za-z][A-Za-z0-9_]*)=(.*)", raw)
        if not match or match.group(1) in values:
            fail(f"{label} state file is malformed")
        decoded = shlex.split(match.group(2), posix=True)
        if len(decoded) > 1:
            fail(f"{label} state value is malformed")
        values[match.group(1)] = decoded[0] if decoded else ""
    return values


def validate_rule(
    rule: dict[str, Any],
    *,
    rule_id: str | None = None,
    description: str | None = None,
    cidr: str | None = None,
    run_id: str | None = None,
) -> tuple[str, str, str, str]:
    actual_id = rule.get("id")
    actual_description = rule.get("description")
    actual_cidr = rule.get("source")
    match = (
        RULE_DESCRIPTION.fullmatch(actual_description)
        if isinstance(actual_description, str)
        else None
    )
    tcp = rule.get("tcp-options")
    ports = (
        tcp.get("destination-port-range")
        if isinstance(tcp, dict)
        else None
    )
    if (
        not isinstance(actual_id, str)
        or SAFE_ID.fullmatch(actual_id) is None
        or match is None
        or IPV4_CIDR.fullmatch(str(actual_cidr)) is None
        or rule.get("direction") != "INGRESS"
        or str(rule.get("protocol")) != "6"
        or rule.get("source-type", "CIDR_BLOCK") != "CIDR_BLOCK"
        or not isinstance(ports, dict)
        or ports.get("min") != 6443
        or ports.get("max") != 6443
    ):
        fail("incident OKE runner rule shape differs")
    if (
        (rule_id is not None and actual_id != rule_id)
        or (
            description is not None
            and actual_description != description
        )
        or (cidr is not None and actual_cidr != cidr)
        or (run_id is not None and match.group(1) != run_id)
    ):
        fail("incident OKE runner rule identity differs")
    return (
        actual_id,
        actual_description,
        str(actual_cidr),
        match.group(2),
    )


def list_rules(nsg_id: str) -> list[dict[str, Any]]:
    return data_list(
        oci_json(
            [
                "network",
                "nsg",
                "rules",
                "list",
                "--nsg-id",
                nsg_id,
                "--direction",
                "INGRESS",
                "--all",
            ],
            "OKE NSG rules",
            normalize_empty_list=True,
        ),
        "OKE NSG rules",
    )


def list_sessions(
    bastion_id: str, session_name: str
) -> list[dict[str, Any]]:
    sessions = data_list(
        oci_json(
            [
                "bastion",
                "session",
                "list",
                "--bastion-id",
                bastion_id,
                "--display-name",
                session_name,
                "--all",
            ],
            "Bastion sessions",
            normalize_empty_list=True,
        ),
        "Bastion sessions",
    )
    return [
        item
        for item in sessions
        if item.get("lifecycle-state") != "DELETED"
    ]


def make_record(
    binding: dict[str, str],
    runtime: str,
    resource: dict[str, Any],
) -> dict[str, Any]:
    return {
        "schemaVersion": ACCESS_SCHEMA,
        "runtimeMode": runtime,
        "manifestSha256": binding["manifest"],
        "ownerRunId": int(binding["owner"]),
        "journalIdentitySha256": binding["journal"],
        "runId": int(binding["run"]),
        "runAttempt": 1,
        "controlSha": binding["control"],
        "authorityGeneration": int(binding["generation"]),
        "resource": resource,
    }


def validate_record(record: Any) -> dict[str, Any]:
    if not isinstance(record, dict):
        fail("incident access record is malformed")
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
        validate_rule(
            {
                "id": resource.get("ruleId"),
                "description": resource.get("description"),
                "source": resource.get("cidr"),
                "direction": "INGRESS",
                "protocol": "6",
                "source-type": "CIDR_BLOCK",
                "tcp-options": {
                    "destination-port-range": {
                        "min": 6443,
                        "max": 6443,
                    }
                },
            }
        )
        if (
            resource.get("kind") != "oke-nsg-rule"
            or SAFE_ID.fullmatch(
                str(resource.get("endpointNsgOcid", ""))
            )
            is None
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
            or resource.get("sessionName")
            != f"betstan-k3s-ssh-{record['runId']}-1"
        ):
            fail("incident k3s access resource is invalid")
    return record


def record_matches_binding(
    record: dict[str, Any], binding: dict[str, str]
) -> bool:
    return (
        record["manifestSha256"] == binding["manifest"]
        and str(record["ownerRunId"]) == binding["owner"]
        and record["journalIdentitySha256"] == binding["journal"]
        and str(record["runId"]) == binding["run"]
        and record["controlSha"] == binding["control"]
        and str(record["authorityGeneration"])
        == binding["generation"]
    )


def validate_cleanup_state(
    runtime: str, path: str, record: dict[str, Any]
) -> None:
    state = parse_state_file(path, "current incident access cleanup")
    resource = record["resource"]
    if runtime == "oke":
        if set(state) != {
            "OCI_ENDPOINT_NSG_OCID",
            "OCI_RUNNER_RULE_ID",
            "OCI_RUNNER_RULE_DESCRIPTION",
            "OCI_RUNNER_RULE_CIDR",
            "OCI_RUNNER_RULE_EXPIRES",
        } or state != {
            "OCI_ENDPOINT_NSG_OCID": resource["endpointNsgOcid"],
            "OCI_RUNNER_RULE_ID": resource["ruleId"],
            "OCI_RUNNER_RULE_DESCRIPTION": resource["description"],
            "OCI_RUNNER_RULE_CIDR": resource["cidr"],
            "OCI_RUNNER_RULE_EXPIRES": str(resource["expiresEpoch"]),
        }:
            fail("current OKE cleanup state differs from its access record")
        return
    if set(state) != {
        "bastion_ocid",
        "ssh_session_id",
        "ssh_session_name",
        "ssh_tunnel_pid",
        "api_tunnel_pid",
        "key_dir",
        "bastion_endpoint",
        "target_private_key",
        "target_known_hosts",
        "instance_ocid",
        "instance_private_ip",
        "os_user",
        "local_ssh_port",
    }:
        fail("current k3s cleanup state fields differ")
    if (
        state["bastion_ocid"] != resource["bastionOcid"]
        or state["ssh_session_id"] != resource["sessionId"]
        or state["ssh_session_name"] != resource["sessionName"]
    ):
        fail("current k3s cleanup state differs from its access record")


def capture_oke(
    binding: dict[str, str], state_file: str
) -> dict[str, Any]:
    state = parse_state_file(state_file, "OKE runner rule")
    required = {
        "OCI_ENDPOINT_NSG_OCID",
        "OCI_RUNNER_RULE_ID",
        "OCI_RUNNER_RULE_DESCRIPTION",
        "OCI_RUNNER_RULE_CIDR",
        "OCI_RUNNER_RULE_EXPIRES",
    }
    if set(state) != required:
        fail("OKE runner rule state fields differ")
    nsg_id = state["OCI_ENDPOINT_NSG_OCID"]
    if SAFE_ID.fullmatch(nsg_id) is None:
        fail("OKE endpoint NSG identity is invalid")
    rules = list_rules(nsg_id)
    matches = [
        rule
        for rule in rules
        if rule.get("id") == state["OCI_RUNNER_RULE_ID"]
    ]
    if len(matches) != 1:
        fail("exact current OKE runner rule is missing or ambiguous")
    rule_id, description, cidr, expires = validate_rule(
        matches[0],
        rule_id=state["OCI_RUNNER_RULE_ID"],
        description=state["OCI_RUNNER_RULE_DESCRIPTION"],
        cidr=state["OCI_RUNNER_RULE_CIDR"],
        run_id=binding["run"],
    )
    if expires != state["OCI_RUNNER_RULE_EXPIRES"]:
        fail("OKE runner rule expiry differs from its state")
    authority_matches: list[dict[str, Any]] = []
    for rule in rules:
        description_value = rule.get("description")
        authority = (
            RULE_DESCRIPTION.fullmatch(description_value)
            if isinstance(description_value, str)
            else None
        )
        if authority is not None and authority.group(1) == binding["run"]:
            validate_rule(rule, run_id=binding["run"])
            authority_matches.append(rule)
    if (
        len(authority_matches) != 1
        or authority_matches[0].get("id") != rule_id
    ):
        fail("current OKE access authority is ambiguous")
    return make_record(
        binding,
        "oke",
        {
            "kind": "oke-nsg-rule",
            "endpointNsgOcid": nsg_id,
            "ruleId": rule_id,
            "description": description,
            "cidr": cidr,
            "expiresEpoch": int(expires),
        },
    )


def capture_k3s(
    binding: dict[str, str], state_file: str
) -> dict[str, Any]:
    state = parse_state_file(state_file, "k3s access")
    bastion_id = state.get("bastion_ocid", "")
    session_id = state.get("ssh_session_id", "")
    session_name = state.get("ssh_session_name", "")
    if (
        SAFE_ID.fullmatch(bastion_id) is None
        or SAFE_ID.fullmatch(session_id) is None
        or session_name
        != f"betstan-k3s-ssh-{binding['run']}-1"
    ):
        fail("k3s access state identity differs")
    session = oci_json(
        [
            "bastion",
            "session",
            "get",
            "--session-id",
            session_id,
        ],
        "Bastion session",
    )
    data = session.get("data") if isinstance(session, dict) else None
    if (
        not isinstance(data, dict)
        or data.get("id") != session_id
        or data.get("bastion-id") != bastion_id
        or data.get("display-name") != session_name
        or data.get("lifecycle-state") != "ACTIVE"
    ):
        fail("current Bastion session identity differs")
    matches = list_sessions(bastion_id, session_name)
    if len(matches) != 1 or matches[0].get("id") != session_id:
        fail("current Bastion access authority is ambiguous")
    return make_record(
        binding,
        "k3s",
        {
            "kind": "k3s-bastion-session",
            "bastionOcid": bastion_id,
            "sessionId": session_id,
            "sessionName": session_name,
        },
    )


def remove_rule(record: dict[str, Any]) -> str:
    resource = record["resource"]
    nsg_id = resource["endpointNsgOcid"]
    rule_id = resource["ruleId"]
    matches = [
        rule for rule in list_rules(nsg_id)
        if rule.get("id") == rule_id
    ]
    if not matches:
        return "already-absent"
    if len(matches) != 1:
        fail("exact OKE runner rule identity is ambiguous")
    validate_rule(
        matches[0],
        rule_id=rule_id,
        description=resource["description"],
        cidr=resource["cidr"],
        run_id=str(record["runId"]),
    )
    result = oci(
        [
            "network",
            "nsg",
            "rules",
            "remove",
            "--nsg-id",
            nsg_id,
            "--security-rule-ids",
            canonical([rule_id]),
            "--force",
        ]
    )
    remaining = [
        rule for rule in list_rules(nsg_id)
        if rule.get("id") == rule_id
    ]
    if not remaining:
        return (
            "applied"
            if result.returncode == 0
            else "applied-after-reread"
        )
    if len(remaining) == 1:
        validate_rule(
            remaining[0],
            rule_id=rule_id,
            description=resource["description"],
            cidr=resource["cidr"],
            run_id=str(record["runId"]),
        )
        fail("exact OKE runner rule removal was not applied")
    fail("exact OKE runner rule removal is ambiguous")


def remove_session(record: dict[str, Any]) -> str:
    resource = record["resource"]
    bastion_id = resource["bastionOcid"]
    session_id = resource["sessionId"]
    session_name = resource["sessionName"]
    matches = list_sessions(bastion_id, session_name)
    if not matches:
        return "already-absent"
    if (
        len(matches) != 1
        or matches[0].get("id") != session_id
        or matches[0].get("display-name") != session_name
    ):
        fail("exact Bastion session identity is ambiguous")
    result = oci(
        [
            "bastion",
            "session",
            "delete",
            "--session-id",
            session_id,
            "--force",
            "--wait-for-state",
            "SUCCEEDED",
            "--max-wait-seconds",
            "300",
        ]
    )
    remaining = list_sessions(bastion_id, session_name)
    if not remaining:
        return (
            "applied"
            if result.returncode == 0
            else "applied-after-reread"
        )
    if (
        len(remaining) == 1
        and remaining[0].get("id") == session_id
    ):
        fail("exact Bastion session deletion was not applied")
    fail("exact Bastion session deletion is ambiguous")


def reset_bastion_allowlist(bastion_id: str) -> None:
    result = oci(
        [
            "bastion",
            "bastion",
            "update",
            "--bastion-id",
            bastion_id,
            "--client-cidr-list",
            '["192.0.2.1/32"]',
            "--force",
            "--wait-for-state",
            "SUCCEEDED",
            "--max-wait-seconds",
            "300",
        ]
    )
    if result.returncode != 0:
        fail("unable to reset the exact Bastion client allowlist")


def load_access_cleanup_lineage(path: str) -> list[dict[str, Any]]:
    file_path = Path(path)
    value = load_json_file(path, "incident access-cleanup lineage")
    if not isinstance(value, list) or len(value) > MAX_CLEANUP_LINEAGE:
        fail("incident access-cleanup lineage is invalid")
    raw = file_path.read_text(encoding="utf-8")
    if raw not in {canonical(value), canonical(value) + "\n"}:
        fail("incident access-cleanup lineage is not canonical JSON")
    binding = current_binding()
    if len(value) != int(binding["generation"]):
        fail("incident access-cleanup lineage length differs")
    seen_runs: set[int] = set()
    for expected_generation, item in enumerate(value):
        if not isinstance(item, dict) or set(item) != {
            "runId",
            "controlSha",
            "authorityGeneration",
            "authoritySha256",
        }:
            fail("incident access-cleanup lineage entry fields differ")
        if (
            type(item["runId"]) is not int
            or item["runId"] < 1
            or item["runId"] in seen_runs
            or type(item["authorityGeneration"]) is not int
            or item["authorityGeneration"] != expected_generation
            or SHA40.fullmatch(str(item["controlSha"])) is None
            or SHA64.fullmatch(str(item["authoritySha256"])) is None
        ):
            fail("incident access-cleanup lineage entry is invalid")
        seen_runs.add(item["runId"])
    if value:
        last = value[-1]
        if (
            str(last["runId"]) != binding["predecessorRun"]
            or last["controlSha"] != binding["predecessorControl"]
            or last["authoritySha256"]
            != binding["predecessorAuthority"]
        ):
            fail(
                "incident access-cleanup lineage does not bind the exact "
                "predecessor authority"
            )
    elif (
        binding["predecessorRun"] != "0"
        or binding["predecessorControl"] != "none"
        or binding["predecessorAuthority"] != "none"
    ):
        fail("initial incident access-cleanup authority is not neutral")
    return value


def cleanup_lineage_binding(
    current: dict[str, str], authority: dict[str, Any]
) -> dict[str, str]:
    result = dict(current)
    result["run"] = str(authority["runId"])
    result["control"] = authority["controlSha"]
    result["generation"] = str(authority["authorityGeneration"])
    return result


def cleanup_exact_authority(
    runtime: str,
    authority: dict[str, Any],
    current: dict[str, str],
) -> tuple[dict[str, Any] | None, str]:
    authority_binding = cleanup_lineage_binding(current, authority)
    run_id = str(authority["runId"])
    if runtime == "oke":
        nsg_id = require_env("OCI_ENDPOINT_NSG_OCID", SAFE_ID)
        matches: list[dict[str, Any]] = []
        for rule in list_rules(nsg_id):
            description = rule.get("description")
            match = (
                RULE_DESCRIPTION.fullmatch(description)
                if isinstance(description, str)
                else None
            )
            if match is not None and match.group(1) == run_id:
                validate_rule(rule, run_id=run_id)
                matches.append(rule)
        if len(matches) > 1:
            fail("lineage OKE runner rule identity is ambiguous")
        if not matches:
            return None, "already-absent"
        rule_id, description, cidr, expires = validate_rule(
            matches[0], run_id=run_id
        )
        record = make_record(
            authority_binding,
            runtime,
            {
                "kind": "oke-nsg-rule",
                "endpointNsgOcid": nsg_id,
                "ruleId": rule_id,
                "description": description,
                "cidr": cidr,
                "expiresEpoch": int(expires),
            },
        )
        return record, remove_rule(record)
    bastion_id = require_env("OCI_BASTION_OCID", SAFE_ID)
    session_name = f"betstan-k3s-ssh-{run_id}-1"
    matches = list_sessions(bastion_id, session_name)
    if len(matches) > 1:
        fail("lineage Bastion session identity is ambiguous")
    if not matches:
        reset_bastion_allowlist(bastion_id)
        return None, "already-absent"
    session_id = matches[0].get("id")
    if (
        SAFE_ID.fullmatch(str(session_id)) is None
        or matches[0].get("display-name") != session_name
    ):
        fail("lineage Bastion session identity differs")
    record = make_record(
        authority_binding,
        runtime,
        {
            "kind": "k3s-bastion-session",
            "bastionOcid": bastion_id,
            "sessionId": session_id,
            "sessionName": session_name,
        },
    )
    result = remove_session(record)
    reset_bastion_allowlist(bastion_id)
    return record, result


def cleanup_lineage(
    runtime: str, lineage_path: str
) -> dict[str, Any]:
    lineage = load_access_cleanup_lineage(lineage_path)
    current = current_binding()
    obligations = []
    for authority in lineage:
        resource, result = cleanup_exact_authority(
            runtime, authority, current
        )
        obligations.append(
            {
                "authority": authority,
                "resource": resource,
                "result": result,
            }
        )
    return {
        "schemaVersion": LINEAGE_CLEANUP_SCHEMA,
        "runtimeMode": runtime,
        "lineage": lineage,
        "lineageSha256": digest(lineage),
        "obligations": obligations,
        "allAbsent": True,
        "observedAtEpoch": now_epoch(),
    }


def validate_lineage_cleanup_receipt(
    value: Any,
    *,
    runtime: str,
    lineage: list[dict[str, Any]],
    current: dict[str, str],
) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {
        "schemaVersion",
        "runtimeMode",
        "lineage",
        "lineageSha256",
        "obligations",
        "allAbsent",
        "observedAtEpoch",
    }:
        fail("access-cleanup lineage receipt fields differ")
    obligations = value.get("obligations")
    if (
        value.get("schemaVersion") != LINEAGE_CLEANUP_SCHEMA
        or value.get("runtimeMode") != runtime
        or value.get("lineage") != lineage
        or value.get("lineageSha256") != digest(lineage)
        or not isinstance(obligations, list)
        or len(obligations) != len(lineage)
        or value.get("allAbsent") is not True
        or type(value.get("observedAtEpoch")) is not int
        or value["observedAtEpoch"] < 1
    ):
        fail("access-cleanup lineage receipt is invalid")
    for authority, obligation in zip(lineage, obligations):
        if not isinstance(obligation, dict) or set(obligation) != {
            "authority",
            "resource",
            "result",
        }:
            fail("access-cleanup lineage obligation fields differ")
        if (
            obligation["authority"] != authority
            or obligation["result"]
            not in {
                "already-absent",
                "applied",
                "applied-after-reread",
            }
        ):
            fail("access-cleanup lineage obligation is invalid")
        if obligation["resource"] is not None:
            record = validate_record(obligation["resource"])
            if (
                record["runtimeMode"] != runtime
                or not record_matches_binding(
                    record,
                    cleanup_lineage_binding(current, authority),
                )
            ):
                fail(
                    "access-cleanup lineage resource authority differs"
                )
    return value


def cleanup_published(
    runtime: str,
    records_path: str,
    current_record_path: str,
    current_state_path: str,
    lineage_receipt_path: str,
    cleanup_lineage_path: str,
) -> dict[str, Any]:
    state_path = Path(current_state_path)
    if not state_path.is_file() or state_path.is_symlink():
        fail("current incident access cleanup state is missing")
    records_value = load_json_file(
        records_path, "incident journal access records"
    )
    if (
        not isinstance(records_value, list)
        or not 1 <= len(records_value) <= 64
    ):
        fail("incident journal access records are invalid")
    records = [validate_record(record) for record in records_value]
    current = validate_record(
        load_json_file(current_record_path, "current incident access")
    )
    binding = current_binding()
    if (
        current["runtimeMode"] != runtime
        or not record_matches_binding(current, binding)
        or current not in records
    ):
        fail("current incident access record is not journal-bound")
    validate_cleanup_state(runtime, current_state_path, current)
    observed_runs: set[int] = set()
    observed_generations: set[int] = set()
    observed_resources: set[tuple[str, str]] = set()
    for record in records:
        resource = record["resource"]
        resource_id = (
            resource["ruleId"]
            if runtime == "oke"
            else resource["sessionId"]
        )
        fixed_container = (
            resource["endpointNsgOcid"]
            if runtime == "oke"
            else resource["bastionOcid"]
        )
        current_container = (
            current["resource"]["endpointNsgOcid"]
            if runtime == "oke"
            else current["resource"]["bastionOcid"]
        )
        if (
            record["runtimeMode"] != runtime
            or record["manifestSha256"] != binding["manifest"]
            or str(record["ownerRunId"]) != binding["owner"]
            or record["journalIdentitySha256"] != binding["journal"]
            or fixed_container != current_container
            or record["authorityGeneration"]
            > int(binding["generation"])
            or record["runId"] in observed_runs
            or record["authorityGeneration"] in observed_generations
            or (runtime, resource_id) in observed_resources
        ):
            fail("incident access authority lineage differs")
        observed_runs.add(record["runId"])
        observed_generations.add(record["authorityGeneration"])
        observed_resources.add((runtime, resource_id))
    cleanup_lineage_value = load_access_cleanup_lineage(
        cleanup_lineage_path
    )
    receipt = validate_lineage_cleanup_receipt(
        load_json_file(
            lineage_receipt_path,
            "access-cleanup lineage receipt",
        ),
        runtime=runtime,
        lineage=cleanup_lineage_value,
        current=binding,
    )
    results: list[dict[str, Any]] = []
    lineage_results: list[dict[str, Any]] = []
    for authority in cleanup_lineage_value:
        resource, result = cleanup_exact_authority(
            runtime, authority, binding
        )
        lineage_results.append(
            {
                "authoritySha256": authority["authoritySha256"],
                "runId": authority["runId"],
                "resourceSha256": (
                    None if resource is None else digest(resource)
                ),
                "result": result,
            }
        )
    bastions: set[str] = set()
    for record in records:
        if runtime == "oke":
            result = remove_rule(record)
        else:
            result = remove_session(record)
            bastions.add(record["resource"]["bastionOcid"])
        results.append(
            {
                "recordSha256": digest(record),
                "runId": record["runId"],
                "result": result,
            }
        )
    for bastion_id in sorted(bastions):
        reset_bastion_allowlist(bastion_id)
    for record in records:
        resource = record["resource"]
        if runtime == "oke":
            remaining = []
            for rule in list_rules(resource["endpointNsgOcid"]):
                description_value = rule.get("description")
                authority = (
                    RULE_DESCRIPTION.fullmatch(description_value)
                    if isinstance(description_value, str)
                    else None
                )
                if (
                    rule.get("id") == resource["ruleId"]
                    or (
                        authority is not None
                        and authority.group(1) == str(record["runId"])
                    )
                ):
                    remaining.append(rule)
            if remaining:
                fail("published OKE runner rule remains")
        elif list_sessions(
            resource["bastionOcid"], resource["sessionName"]
        ):
            fail("published Bastion session remains")
    return {
        "schemaVersion": REPORT_SCHEMA,
        "runtimeMode": runtime,
        "currentRunId": int(binding["run"]),
        "currentControlSha": binding["control"],
        "currentAuthorityGeneration": int(binding["generation"]),
        "lineageCleanupReceiptSha256": digest(receipt),
        "cleanupLineageSha256": digest(cleanup_lineage_value),
        "lineageObligations": lineage_results,
        "records": results,
        "allAbsent": True,
        "observedAtEpoch": now_epoch(),
    }


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser()
    commands = root.add_subparsers(dest="command", required=True)
    capture = commands.add_parser("capture")
    capture.add_argument(
        "--runtime-mode", required=True, choices=("oke", "k3s")
    )
    capture.add_argument("--state-file", required=True)
    capture.add_argument("--output", required=True)
    lineage_cleanup = commands.add_parser("cleanup-lineage")
    lineage_cleanup.add_argument(
        "--runtime-mode", required=True, choices=("oke", "k3s")
    )
    lineage_cleanup.add_argument("--lineage-file", required=True)
    lineage_cleanup.add_argument("--output", required=True)
    published = commands.add_parser("cleanup-published")
    published.add_argument(
        "--runtime-mode", required=True, choices=("oke", "k3s")
    )
    published.add_argument("--records-file", required=True)
    published.add_argument("--current-record-file", required=True)
    published.add_argument("--current-state-file", required=True)
    published.add_argument(
        "--lineage-cleanup-receipt-file", required=True
    )
    published.add_argument("--cleanup-lineage-file", required=True)
    published.add_argument("--output", required=True)
    return root


def main() -> int:
    arguments = parser().parse_args()
    if arguments.command == "capture":
        binding = current_binding()
        record = (
            capture_oke(binding, arguments.state_file)
            if arguments.runtime_mode == "oke"
            else capture_k3s(binding, arguments.state_file)
        )
        write_private_json(arguments.output, record)
    elif arguments.command == "cleanup-lineage":
        receipt = cleanup_lineage(
            arguments.runtime_mode,
            arguments.lineage_file,
        )
        write_private_json(arguments.output, receipt)
    else:
        report = cleanup_published(
            arguments.runtime_mode,
            arguments.records_file,
            arguments.current_record_file,
            arguments.current_state_file,
            arguments.lineage_cleanup_receipt_file,
            arguments.cleanup_lineage_file,
        )
        write_private_json(arguments.output, report)
    print(
        f"incident_access={arguments.command} status=PASS "
        f"runtime={arguments.runtime_mode}"
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except AccessError as error:
        print(f"incident_access status=FAIL reason={error}", file=sys.stderr)
        raise SystemExit(1)
