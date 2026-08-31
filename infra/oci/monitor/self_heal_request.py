#!/usr/bin/env python3
"""Validate one exact self-heal workflow request against trusted issue state."""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

from contracts import ContractError, SHA, canonical_json, load_policy
from publisher import parse_incident
from repair_controller import GitHubRepairStore, parse_repair
from self_heal_controller import SELF_HEAL_OWNER, repair_id


def validate_request(
    *,
    issue: dict,
    comments: list[dict],
    policy: dict,
    issue_number: int,
    fingerprint: str,
    repair_generation: int,
    expected_repair_id: str,
    service: str,
    target_sha: str,
    run_id: int,
) -> dict:
    if issue.get("state") != "open" or issue.get("pull_request"):
        raise ContractError("self-heal incident issue is not open")
    incident = parse_incident(issue.get("body"))
    if (
        incident["issue_number"] != issue_number
        or incident["fingerprint"] != fingerprint
        or incident["repair_generation"] != repair_generation
        or incident["service"] != service
        or incident["status"] != "repairing"
        or incident["active_release_sha"] != target_sha
    ):
        raise ContractError("self-heal incident binding changed")
    anomaly = policy["anomalies"].get(incident["code"])
    service_policy = policy["services"].get(service)
    if (
        not isinstance(anomaly, dict)
        or anomaly["automation"] != "self-heal"
        or not policy["runbooks"]["self-heal"]["enabled"]
        or not isinstance(service_policy, dict)
        or service_policy["restart_safe"] is not True
    ):
        raise ContractError("self-heal request is outside reviewed policy")
    if expected_repair_id != repair_id(issue_number, repair_generation):
        raise ContractError("self-heal repair ID is malformed")
    if not SHA.fullmatch(target_sha):
        raise ContractError("self-heal target SHA is malformed")
    matches = []
    for comment in comments:
        body = comment.get("body")
        if not isinstance(body, str) or "betstan-production-repair-v1" not in body:
            continue
        repair = parse_repair(body)
        if repair["generation"] == repair_generation:
            matches.append(repair)
    if len(matches) != 1:
        raise ContractError("self-heal repair record is missing or ambiguous")
    repair = matches[0]
    if (
        repair["incident_issue"] != issue_number
        or repair["incident_fingerprint"] != fingerprint
        or repair["owner"] != SELF_HEAL_OWNER
        or repair["phase"] != "self-healing"
        or repair["self_heal_attempted"] is not True
        or repair["target_sha"] != target_sha
        or repair["workflow_runs"].get("self-heal") != run_id
    ):
        raise ContractError("self-heal repair record does not authorize this run")
    return {
        "schema": "betstan.production-self-heal-request.v1",
        "issue_number": issue_number,
        "incident_fingerprint": fingerprint,
        "repair_generation": repair_generation,
        "repair_id": expected_repair_id,
        "service": service,
        "target_sha": target_sha,
        "run_id": run_id,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repository", required=True)
    parser.add_argument("--policy", required=True)
    parser.add_argument("--issue-number", required=True, type=int)
    parser.add_argument("--incident-fingerprint", required=True)
    parser.add_argument("--repair-generation", required=True, type=int)
    parser.add_argument("--repair-id", required=True)
    parser.add_argument("--service", required=True)
    parser.add_argument("--target-sha", required=True)
    parser.add_argument("--run-id", required=True, type=int)
    parser.add_argument("--wait-seconds", type=int, default=60)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    token = os.environ.get("GH_TOKEN", "")
    if not token or len(token) > 500:
        print("self_heal_request=FAIL reason=token-unavailable", file=sys.stderr)
        return 1
    store = GitHubRepairStore(args.repository, token)
    deadline = time.monotonic() + max(0, min(args.wait_seconds, 120))
    last_error: ContractError | None = None
    while True:
        try:
            result = validate_request(
                issue=store.get_issue(args.issue_number),
                comments=store.list_comments(args.issue_number),
                policy=load_policy(Path(args.policy)),
                issue_number=args.issue_number,
                fingerprint=args.incident_fingerprint,
                repair_generation=args.repair_generation,
                expected_repair_id=args.repair_id,
                service=args.service,
                target_sha=args.target_sha,
                run_id=args.run_id,
            )
            output = Path(args.output)
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(canonical_json(result) + "\n", encoding="utf-8")
            print("self_heal_request=PASS")
            return 0
        except ContractError as error:
            last_error = error
            if time.monotonic() >= deadline:
                break
            time.sleep(5)
    print(f"self_heal_request=FAIL reason={last_error}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
