#!/usr/bin/env python3
"""Merge one exact policy-approved monitor repair pull request into dev."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
from pathlib import Path
from typing import Any

from contracts import ContractError, SHA, canonical_json, load_policy
from repair_controller import GitHubRepairStore, parse_repair, render_repair
from state_machine import transition_repair


POLICY_CONTEXT = "monitor-repair-policy/dev"


class RepairMerger:
    def __init__(self, store: GitHubRepairStore, policy: dict[str, Any]):
        self.store = store
        self.policy = policy

    def _pull(self, number: int) -> dict[str, Any]:
        _status, payload = self.store._request(
            f"repos/{self.store.repository}/pulls/{number}"
        )
        if not isinstance(payload, dict):
            raise ContractError("repair pull request is malformed")
        return payload

    def _require_policy_status(self, sha: str) -> None:
        _status, payload = self.store._request(
            f"repos/{self.store.repository}/commits/{sha}/status"
        )
        statuses = payload.get("statuses") if isinstance(payload, dict) else None
        if not isinstance(statuses, list):
            raise ContractError("repair commit statuses are malformed")
        matches = [
            status
            for status in statuses
            if isinstance(status, dict) and status.get("context") == POLICY_CONTEXT
        ]
        if len(matches) != 1 or matches[0].get("state") != "success":
            raise ContractError("repair policy status is not successful")

    def _repair_comment(
        self,
        issue_number: int,
        generation: int,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        matches = []
        for comment in self.store.list_comments(issue_number):
            body = comment.get("body")
            if not isinstance(body, str) or "betstan-production-repair-v1" not in body:
                continue
            repair = parse_repair(body)
            if repair["generation"] == generation:
                matches.append((comment, repair))
        if len(matches) != 1:
            raise ContractError("repair record is missing or ambiguous")
        return matches[0]

    def _mark_ready(self, pull: dict[str, Any]) -> None:
        node_id = pull.get("node_id")
        if not isinstance(node_id, str) or not node_id:
            raise ContractError("repair pull request node ID is missing")
        self.store._request(
            "graphql",
            method="POST",
            payload={
                "query": (
                    "mutation($id:ID!){markPullRequestReadyForReview("
                    "input:{pullRequestId:$id}){pullRequest{isDraft}}}"
                ),
                "variables": {"id": node_id},
            },
            expected={200},
        )

    @staticmethod
    def _policy_number(policy_result: dict[str, Any]) -> int:
        expected_keys = {
            "schema",
            "pull_request",
            "incident_issue",
            "repair_generation",
            "head_sha",
            "merge_sha",
            "files",
            "approved_runs",
        }
        if set(policy_result) != expected_keys:
            raise ContractError("repair policy result fields are invalid")
        number = policy_result["pull_request"]
        if isinstance(number, bool) or not isinstance(number, int) or number < 1:
            raise ContractError("repair pull request number is malformed")
        return number

    def _validated_repair(
        self, policy_result: dict[str, Any]
    ) -> tuple[
        int,
        dict[str, Any],
        str,
        str,
        str,
        dict[str, Any],
        dict[str, Any],
    ]:
        number = self._policy_number(policy_result)
        pull = self._pull(number)
        head_sha = pull.get("head", {}).get("sha")
        base_sha = pull.get("base", {}).get("sha")
        merge_snapshot = pull.get("merge_commit_sha")
        if (
            pull.get("state") != "open"
            or pull.get("base", {}).get("ref") != "dev"
            or pull.get("head", {}).get("repo", {}).get("full_name")
            != self.store.repository
            or head_sha != policy_result["head_sha"]
            or merge_snapshot != policy_result["merge_sha"]
            or not isinstance(base_sha, str)
            or not SHA.fullmatch(base_sha)
        ):
            raise ContractError("repair pull request changed after policy validation")
        self._require_policy_status(head_sha)
        self._require_policy_status(merge_snapshot)
        comment, repair = self._repair_comment(
            policy_result["incident_issue"],
            policy_result["repair_generation"],
        )
        if (
            repair["phase"] != "review"
            or repair["repair_pr"] != number
            or repair["head_sha"] != head_sha
        ):
            raise ContractError("repair record is not ready for exact merge")
        return number, pull, head_sha, base_sha, merge_snapshot, comment, repair

    def prepare(self, policy_result: dict[str, Any]) -> dict[str, Any]:
        number = self._policy_number(policy_result)
        existing = self._pull(number)
        if existing.get("state") == "closed":
            merged = self._record_merged(policy_result, existing)
            return {
                "schema": "betstan.production-repair-ready.v1",
                "pull_request": number,
                "head_sha": merged["head_sha"],
                "base_sha": existing.get("base", {}).get("sha", ""),
                "merge_sha": merged["merge_sha"],
                "already_merged": True,
            }
        (
            number,
            pull,
            head_sha,
            base_sha,
            merge_snapshot,
            _comment,
            _repair,
        ) = self._validated_repair(policy_result)
        if pull.get("draft") is True:
            self._mark_ready(pull)
            pull = self._pull(number)
            if pull.get("draft") is True:
                raise ContractError("repair pull request remained draft")
        latest_head = pull.get("head", {}).get("sha")
        latest_base = pull.get("base", {}).get("sha")
        latest_merge = pull.get("merge_commit_sha")
        if (
            latest_head != head_sha
            or latest_base != base_sha
            or latest_merge != merge_snapshot
        ):
            raise ContractError("repair pull request changed while marking ready")
        return {
            "schema": "betstan.production-repair-ready.v1",
            "pull_request": number,
            "head_sha": head_sha,
            "base_sha": base_sha,
            "merge_sha": merge_snapshot,
            "already_merged": False,
        }

    def _record_merged(
        self,
        policy_result: dict[str, Any],
        pull: dict[str, Any],
    ) -> dict[str, Any]:
        number = self._policy_number(policy_result)
        head_sha = pull.get("head", {}).get("sha")
        merge_sha = pull.get("merge_commit_sha")
        if (
            pull.get("number") != number
            or pull.get("state") != "closed"
            or pull.get("merged") is not True
            or not pull.get("merged_at")
            or pull.get("base", {}).get("ref") != "dev"
            or pull.get("head", {}).get("repo", {}).get("full_name")
            != self.store.repository
            or head_sha != policy_result["head_sha"]
            or not isinstance(merge_sha, str)
            or not SHA.fullmatch(merge_sha)
        ):
            raise ContractError("repair pull request is not an exact completed merge")
        self._require_policy_status(head_sha)
        self._require_policy_status(policy_result["merge_sha"])
        comment, repair = self._repair_comment(
            policy_result["incident_issue"],
            policy_result["repair_generation"],
        )
        if repair["repair_pr"] != number or repair["head_sha"] != head_sha:
            raise ContractError("repair record does not match the merged pull request")
        if repair["phase"] == "review":
            repair = transition_repair(
                repair,
                "merging",
                now=dt.datetime.now(dt.timezone.utc).replace(microsecond=0),
                ttl_seconds=self.policy["repair"]["claim_ttl_seconds"],
                updates={"merge_sha": merge_sha, "terminal_reason": ""},
            )
            self.store.update_comment(comment, render_repair(repair))
        elif repair["phase"] != "merging" or repair["merge_sha"] != merge_sha:
            raise ContractError("merged repair record is in an inconsistent phase")
        return {
            "schema": "betstan.production-repair-merge.v1",
            "pull_request": number,
            "incident_issue": repair["incident_issue"],
            "repair_generation": repair["generation"],
            "head_sha": head_sha,
            "merge_sha": merge_sha,
        }

    def merge(self, policy_result: dict[str, Any]) -> dict[str, Any]:
        number = self._policy_number(policy_result)
        existing = self._pull(number)
        if existing.get("state") == "closed":
            return self._record_merged(policy_result, existing)
        (
            number,
            pull,
            head_sha,
            base_sha,
            merge_snapshot,
            comment,
            repair,
        ) = self._validated_repair(policy_result)
        if pull.get("draft") is True:
            raise ContractError("repair pull request must be ready before merge safety")
        if (
            pull.get("head", {}).get("sha") != head_sha
            or pull.get("base", {}).get("sha") != base_sha
            or pull.get("merge_commit_sha") != merge_snapshot
        ):
            raise ContractError("repair pull request changed before merge")
        _status, merged = self.store._request(
            f"repos/{self.store.repository}/pulls/{number}/merge",
            method="PUT",
            payload={
                "sha": head_sha,
                "merge_method": "merge",
                "commit_title": f"Merge production monitor repair #{number}",
            },
            expected={200, 405, 409},
        )
        merge_sha = merged.get("sha") if isinstance(merged, dict) else None
        if (
            not isinstance(merged, dict)
            or merged.get("merged") is not True
            or not isinstance(merge_sha, str)
            or not SHA.fullmatch(merge_sha)
        ):
            latest = self._pull(number)
            if latest.get("state") == "closed" and latest.get("merged") is True:
                return self._record_merged(policy_result, latest)
            message = merged.get("message") if isinstance(merged, dict) else ""
            raise ContractError(f"repair pull request was not merged: {message}")
        completed = dict(pull)
        completed.update(
            {
                "number": number,
                "state": "closed",
                "merged": True,
                "merged_at": completed.get("merged_at") or "recorded-by-merge-api",
                "merge_commit_sha": merge_sha,
            }
        )
        return self._record_merged(policy_result, completed)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repository", required=True)
    parser.add_argument("--policy", required=True)
    parser.add_argument("--policy-result", required=True)
    parser.add_argument("--mode", choices=("prepare", "merge"), default="merge")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    token = os.environ.get("COPILOT_AGENT_TOKEN", "")
    if not token or len(token) > 500:
        print("production_repair_merge=FAIL reason=token-unavailable", file=sys.stderr)
        return 1
    try:
        policy_result = json.loads(
            Path(args.policy_result).read_text(encoding="utf-8")
        )
        controller = RepairMerger(
            GitHubRepairStore(args.repository, token),
            load_policy(Path(args.policy)),
        )
        result = (
            controller.prepare(policy_result)
            if args.mode == "prepare"
            else controller.merge(policy_result)
        )
        Path(args.output).write_text(canonical_json(result) + "\n", encoding="utf-8")
    except (ContractError, OSError, ValueError, json.JSONDecodeError) as error:
        print(f"production_repair_merge=FAIL reason={error}", file=sys.stderr)
        return 1
    print(
        "production_repair_merge=PASS "
        f"mode={args.mode} pull_request={result['pull_request']} "
        f"merge_sha={result['merge_sha']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
