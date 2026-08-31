#!/usr/bin/env python3
"""List exact active repair lifecycle work for trusted periodic reconciliation."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

from contracts import ContractError, canonical_json
from repair_controller import (
    REPAIR_MARKER,
    GitHubRepairStore,
    parse_repair,
)


def lifecycle_candidates(store: GitHubRepairStore) -> dict[str, Any]:
    issues = store.list_incidents()
    reviews = []
    identities = set()
    for issue in issues:
        issue_number = issue.get("number")
        if (
            isinstance(issue_number, bool)
            or not isinstance(issue_number, int)
            or issue_number < 1
        ):
            raise ContractError("incident issue number is malformed")
        for comment in store.list_comments(issue_number):
            body = comment.get("body")
            if not isinstance(body, str) or REPAIR_MARKER not in body:
                continue
            repair = parse_repair(body)
            identity = (repair["incident_issue"], repair["generation"])
            if identity in identities:
                raise ContractError("duplicate repair generation exists")
            identities.add(identity)
            if repair["incident_issue"] != issue_number:
                raise ContractError("repair comment belongs to another incident")
            if repair["phase"] == "review":
                if repair["repair_pr"] < 1:
                    raise ContractError("review repair has no pull request")
                reviews.append(repair["repair_pr"])
    if len(reviews) != len(set(reviews)):
        raise ContractError("multiple repair records reference one pull request")
    return {
        "schema": "betstan.production-repair-lifecycle-candidates.v1",
        "review_pull_requests": sorted(reviews),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repository", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    token = os.environ.get("COPILOT_AGENT_TOKEN", "")
    if not token or len(token) > 500:
        print("production_repair_lifecycle=FAIL reason=token-unavailable", file=sys.stderr)
        return 1
    try:
        result = lifecycle_candidates(GitHubRepairStore(args.repository, token))
        Path(args.output).write_text(canonical_json(result) + "\n", encoding="utf-8")
    except (ContractError, OSError, ValueError, json.JSONDecodeError) as error:
        print(f"production_repair_lifecycle=FAIL reason={error}", file=sys.stderr)
        return 1
    print(
        "production_repair_lifecycle=PASS "
        f"reviews={len(result['review_pull_requests'])}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
