#!/usr/bin/env python3
"""Create and merge an isolated dev-to-master monitor repair promotion."""

from __future__ import annotations

import argparse
import datetime as dt
import fnmatch
import json
import os
import re
import sys
import urllib.parse
from pathlib import Path
from typing import Any

from contracts import (
    ENVIRONMENT,
    PROMOTION_SCHEMA,
    REPOSITORY,
    SHA,
    ContractError,
    canonical_json,
    load_policy,
    timestamp,
    validate_promotion,
)
from repair_controller import (
    REPAIR_MARKER,
    GitHubRepairStore,
    parse_repair,
    render_repair,
)
from state_machine import transition_repair


PROMOTION_MARKER = "betstan-production-repair-promotion-v1"
PROMOTION_CONTEXT = "monitor-repair-promotion/master"


def render_promotion(document: dict[str, Any]) -> str:
    validate_promotion(document)
    repairs = ", ".join(
        f"#{repair['repair_pr']} (incident #{repair['incident_issue']}, "
        f"generation {repair['generation']})"
        for repair in document["repairs"]
    )
    return (
        "## Production monitor repair promotion\n\n"
        "This promotion is managed by the trusted production monitor controller. "
        "Its body, labels, and title are not sufficient authority without the "
        "matching incident repair records and exact GitHub commit graph.\n\n"
        f"- Repairs: {repairs}\n"
        f"- Base: `master@{document['base_sha']}`\n"
        f"- Target: `dev@{document['target_sha']}`\n\n"
        f"<!-- {PROMOTION_MARKER}\n{canonical_json(document)}\n-->\n"
    )


def parse_promotion(body: Any) -> dict[str, Any]:
    if not isinstance(body, str):
        raise ContractError("promotion pull request body is missing")
    matches = list(
        re.finditer(
            rf"<!-- {re.escape(PROMOTION_MARKER)}\n(?P<payload>[^\n]+)\n-->",
            body,
        )
    )
    if len(matches) != 1:
        raise ContractError("promotion body must contain exactly one machine payload")
    try:
        payload = json.loads(matches[0].group("payload"))
    except json.JSONDecodeError as error:
        raise ContractError("promotion payload is malformed") from error
    return validate_promotion(payload)


class RepairPromotion:
    def __init__(self, store: GitHubRepairStore, policy: dict[str, Any]):
        self.store = store
        self.policy = policy

    def _pull(self, number: int) -> dict[str, Any]:
        _status, payload = self.store._request(
            f"repos/{self.store.repository}/pulls/{number}"
        )
        if not isinstance(payload, dict):
            raise ContractError("promotion pull request is malformed")
        return payload

    def _repair_records(
        self,
    ) -> list[tuple[dict[str, Any], dict[str, Any]]]:
        records = []
        issues = self.store.list_incidents()
        for issue in issues:
            issue_number = issue.get("number")
            if (
                isinstance(issue_number, bool)
                or not isinstance(issue_number, int)
                or issue_number < 1
            ):
                raise ContractError("incident issue number is malformed")
            for comment in self.store.list_comments(issue_number):
                body = comment.get("body")
                if not isinstance(body, str) or REPAIR_MARKER not in body:
                    continue
                repair = parse_repair(body)
                if repair["incident_issue"] != issue_number:
                    raise ContractError("repair comment belongs to another incident")
                records.append((comment, repair))
        identities = [
            (repair["incident_issue"], repair["generation"])
            for _comment, repair in records
        ]
        if len(identities) != len(set(identities)):
            raise ContractError("duplicate repair generation exists")
        return records

    def _open_promotions(self) -> list[dict[str, Any]]:
        head = urllib.parse.quote(
            f"{self.store.repository.split('/', 1)[0]}:dev", safe=""
        )
        _status, payload = self.store._request(
            f"repos/{self.store.repository}/pulls"
            f"?state=open&base=master&head={head}&per_page=10"
        )
        if not isinstance(payload, list) or len(payload) >= 10:
            raise ContractError("open promotion query is malformed or unbounded")
        return payload

    def _closed_promotions(self) -> list[dict[str, Any]]:
        head = urllib.parse.quote(
            f"{self.store.repository.split('/', 1)[0]}:dev", safe=""
        )
        _status, payload = self.store._request(
            f"repos/{self.store.repository}/pulls"
            f"?state=closed&base=master&head={head}&per_page=20"
        )
        if not isinstance(payload, list) or len(payload) > 20:
            raise ContractError("closed promotion query is malformed or unbounded")
        return [
            pull
            for pull in payload
            if isinstance(pull, dict)
            and PROMOTION_MARKER in str(pull.get("body", ""))
        ]

    def _ensure_managed_label(self, number: int) -> None:
        self.store._request(
            f"repos/{self.store.repository}/issues/{number}/labels",
            method="POST",
            payload={"labels": [self.policy["repair"]["managed_label"]]},
        )

    def _recover_promotion_identity(
        self,
        pull: dict[str, Any],
        promotion: dict[str, Any],
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        number = pull.get("number")
        if isinstance(number, bool) or not isinstance(number, int) or number < 1:
            raise ContractError("promotion pull request number is malformed")
        if promotion["promotion_pr"] == 0:
            promotion = dict(promotion)
            promotion["promotion_pr"] = number
            promotion = validate_promotion(promotion)
            _status, pull = self.store._request(
                f"repos/{self.store.repository}/pulls/{number}",
                method="PATCH",
                payload={"body": render_promotion(promotion)},
            )
            if not isinstance(pull, dict):
                raise ContractError("updated promotion pull request is malformed")
        elif promotion["promotion_pr"] != number:
            raise ContractError("promotion pull request number is inconsistent")
        self._ensure_managed_label(number)
        return pull, promotion

    def _pull_commits(self, number: int) -> set[str]:
        _status, payload = self.store._request(
            f"repos/{self.store.repository}/pulls/{number}/commits?per_page=100"
        )
        if not isinstance(payload, list) or not payload or len(payload) >= 100:
            raise ContractError("repair commit list is malformed or unbounded")
        commits = {
            item.get("sha")
            for item in payload
            if isinstance(item, dict) and isinstance(item.get("sha"), str)
        }
        if len(commits) != len(payload) or any(not SHA.fullmatch(sha) for sha in commits):
            raise ContractError("repair commit list contains malformed SHAs")
        return commits

    def _selected_records(
        self,
        promotion: dict[str, Any],
        records: list[tuple[dict[str, Any], dict[str, Any]]],
    ) -> list[tuple[dict[str, Any], dict[str, Any]]]:
        by_identity = {
            (repair["incident_issue"], repair["generation"]): (comment, repair)
            for comment, repair in records
        }
        selected = []
        for identity in promotion["repairs"]:
            key = (identity["incident_issue"], identity["generation"])
            pair = by_identity.get(key)
            if pair is None:
                raise ContractError("promotion repair record is missing")
            _comment, repair = pair
            if (
                repair["repair_pr"] != identity["repair_pr"]
                or repair["merge_sha"] != identity["merge_sha"]
                or repair["owned_paths"] != identity["owned_paths"]
            ):
                raise ContractError("promotion repair identity changed")
            selected.append(pair)
        return selected

    def _isolation(
        self,
        records: list[tuple[dict[str, Any], dict[str, Any]]],
        *,
        base_sha: str,
        target_sha: str,
    ) -> tuple[list[str], list[dict[str, Any]]]:
        if not records:
            raise ContractError("promotion has no repair cohort")
        allowed_commits: set[str] = set()
        identities = []
        patterns: list[tuple[tuple[int, int], list[str]]] = []
        for _comment, repair in sorted(
            records,
            key=lambda pair: (
                pair[1]["incident_issue"],
                pair[1]["generation"],
            ),
        ):
            if repair["phase"] not in {"merging", "promoting"}:
                raise ContractError("repair is outside the promotion lifecycle")
            pull = self._pull(repair["repair_pr"])
            if (
                pull.get("state") != "closed"
                or pull.get("merged") is not True
                or not pull.get("merged_at")
                or pull.get("base", {}).get("ref") != "dev"
                or pull.get("head", {}).get("repo", {}).get("full_name")
                != self.store.repository
                or pull.get("head", {}).get("sha") != repair["head_sha"]
                or pull.get("merge_commit_sha") != repair["merge_sha"]
            ):
                raise ContractError("repair pull request merge identity is invalid")
            allowed_commits.update(self._pull_commits(repair["repair_pr"]))
            allowed_commits.add(repair["merge_sha"])
            identity = (repair["incident_issue"], repair["generation"])
            patterns.append((identity, repair["owned_paths"]))
            identities.append(
                {
                    "incident_issue": repair["incident_issue"],
                    "generation": repair["generation"],
                    "repair_pr": repair["repair_pr"],
                    "merge_sha": repair["merge_sha"],
                    "owned_paths": repair["owned_paths"],
                }
            )
        _status, comparison = self.store._request(
            f"repos/{self.store.repository}/compare/{base_sha}...{target_sha}"
            "?per_page=100"
        )
        commits = comparison.get("commits") if isinstance(comparison, dict) else None
        files = comparison.get("files") if isinstance(comparison, dict) else None
        total = comparison.get("total_commits") if isinstance(comparison, dict) else None
        if (
            not isinstance(comparison, dict)
            or comparison.get("status") != "ahead"
            or comparison.get("base_commit", {}).get("sha") != base_sha
            or not isinstance(commits, list)
            or not isinstance(files, list)
            or isinstance(total, bool)
            or not isinstance(total, int)
            or total != len(commits)
            or len(commits) >= 100
            or not files
            or len(files) > 300
        ):
            raise ContractError("master-to-dev comparison is malformed or unbounded")
        observed_commits = {
            item.get("sha")
            for item in commits
            if isinstance(item, dict) and isinstance(item.get("sha"), str)
        }
        if (
            len(observed_commits) != len(commits)
            or any(not SHA.fullmatch(sha) for sha in observed_commits)
            or observed_commits != allowed_commits
        ):
            raise ContractError("dev contains commits outside the repair cohort")
        changed_files = sorted(
            item.get("filename")
            for item in files
            if isinstance(item, dict) and isinstance(item.get("filename"), str)
        )
        if len(changed_files) != len(files):
            raise ContractError("promotion changed-file list is malformed")
        for path in changed_files:
            owners = [
                identity
                for identity, owned_paths in patterns
                if any(fnmatch.fnmatchcase(path, pattern) for pattern in owned_paths)
            ]
            if len(owners) != 1:
                raise ContractError(
                    f"promotion file does not have exactly one repair owner: {path}"
                )
        return changed_files, identities

    def _publish_status(self, sha: str, state: str, description: str) -> None:
        self.store._request(
            f"repos/{self.store.repository}/statuses/{sha}",
            method="POST",
            payload={
                "state": state,
                "context": PROMOTION_CONTEXT,
                "description": description[:140],
            },
            expected={201},
        )

    def _mark_ready(self, pull: dict[str, Any]) -> None:
        node_id = pull.get("node_id")
        if not isinstance(node_id, str) or not node_id:
            raise ContractError("promotion pull request node ID is missing")
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
        )

    def create(self) -> dict[str, Any]:
        records = self._repair_records()
        promotable = [
            pair for pair in records if pair[1]["phase"] in {"merging", "promoting"}
        ]
        existing = self._open_promotions()
        if len(existing) > 1:
            raise ContractError("multiple open dev-to-master promotions exist")
        if existing:
            promotion = parse_promotion(existing[0].get("body"))
            pull, promotion = self._recover_promotion_identity(
                existing[0], promotion
            )
            selected = self._selected_records(promotion, promotable)
            base_sha = self.store.master_sha()
            target_sha = self.store.dev_sha()
            if (
                base_sha != promotion["base_sha"]
                or target_sha != promotion["target_sha"]
            ):
                raise ContractError("open promotion refs changed")
            files, identities = self._isolation(
                selected, base_sha=base_sha, target_sha=target_sha
            )
            if files != promotion["files"] or identities != promotion["repairs"]:
                raise ContractError("open promotion cohort changed")
            self._bind_promotion(selected, promotion)
            return {"action": "reused", "promotion": promotion}
        if any(repair["phase"] == "promoting" for _comment, repair in records):
            matches = []
            for pull in self._closed_promotions():
                promotion = parse_promotion(pull.get("body"))
                identities = {
                    (item["incident_issue"], item["generation"])
                    for item in promotion["repairs"]
                }
                if identities == {
                    (repair["incident_issue"], repair["generation"])
                    for _comment, repair in records
                    if repair["phase"] in {"promoting", "building"}
                }:
                    matches.append((pull, promotion))
            if len(matches) != 1:
                raise ContractError("promoting repair has no unique completed promotion")
            if matches[0][0].get("merged") is not True:
                self._fail_closed_promotion(*matches[0], records)
                return {
                    "action": "failed-closed-promotion",
                    "promotion": None,
                }
            source_sha = self._reconcile_merged_promotion(*matches[0], records)
            return {
                "action": "merged-reconciled",
                "promotion": None,
                "source_sha": source_sha,
            }
        promotable = [pair for pair in records if pair[1]["phase"] == "merging"]
        if not promotable:
            return {"action": "none", "promotion": None}
        base_sha = self.store.master_sha()
        target_sha = self.store.dev_sha()
        if not SHA.fullmatch(base_sha) or not SHA.fullmatch(target_sha):
            raise ContractError("promotion branch refs are malformed")
        files, identities = self._isolation(
            promotable, base_sha=base_sha, target_sha=target_sha
        )
        promotion = validate_promotion(
            {
                "schema": PROMOTION_SCHEMA,
                "environment": ENVIRONMENT,
                "repository": REPOSITORY,
                "promotion_pr": 0,
                "base_sha": base_sha,
                "target_sha": target_sha,
                "repairs": identities,
                "files": files,
                "created_at": timestamp(
                    dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
                ),
            }
        )
        _status, created = self.store._request(
            f"repos/{self.store.repository}/pulls",
            method="POST",
            payload={
                "title": (
                    "Promote validated production monitor repair"
                    + ("s" if len(identities) > 1 else "")
                ),
                "head": "dev",
                "base": "master",
                "body": render_promotion(promotion),
                "draft": True,
            },
            expected={201},
        )
        number = created.get("number") if isinstance(created, dict) else None
        if isinstance(number, bool) or not isinstance(number, int) or number < 1:
            raise ContractError("created promotion pull request is malformed")
        promotion["promotion_pr"] = number
        promotion = validate_promotion(promotion)
        self.store._request(
            f"repos/{self.store.repository}/pulls/{number}",
            method="PATCH",
            payload={"body": render_promotion(promotion)},
        )
        self._ensure_managed_label(number)
        self._bind_promotion(promotable, promotion)
        return {"action": "created", "promotion": promotion}

    def _reconcile_merged_promotion(
        self,
        pull: dict[str, Any],
        promotion: dict[str, Any],
        records: list[tuple[dict[str, Any], dict[str, Any]]],
    ) -> str:
        pull, promotion = self._recover_promotion_identity(pull, promotion)
        number = promotion["promotion_pr"]
        source_sha = pull.get("merge_commit_sha")
        if (
            pull.get("state") != "closed"
            or pull.get("merged") is not True
            or not pull.get("merged_at")
            or pull.get("base", {}).get("ref") != "master"
            or pull.get("head", {}).get("ref") != "dev"
            or pull.get("head", {}).get("repo", {}).get("full_name")
            != self.store.repository
            or pull.get("base", {}).get("sha") != promotion["base_sha"]
            or pull.get("head", {}).get("sha") != promotion["target_sha"]
            or not isinstance(source_sha, str)
            or not SHA.fullmatch(source_sha)
        ):
            raise ContractError("completed promotion pull request identity changed")
        selected = self._selected_records(promotion, records)
        now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
        for comment, repair in selected:
            if (
                repair["repair_pr"]
                != next(
                    identity["repair_pr"]
                    for identity in promotion["repairs"]
                    if identity["incident_issue"] == repair["incident_issue"]
                    and identity["generation"] == repair["generation"]
                )
                or repair["merge_sha"]
                != next(
                    identity["merge_sha"]
                    for identity in promotion["repairs"]
                    if identity["incident_issue"] == repair["incident_issue"]
                    and identity["generation"] == repair["generation"]
                )
            ):
                raise ContractError("completed promotion repair identity changed")
            if repair["phase"] == "promoting":
                if (
                    repair["promotion_pr"] != number
                    or repair["target_sha"] != promotion["target_sha"]
                ):
                    raise ContractError("repair is bound to another promotion")
                updated = transition_repair(
                    repair,
                    "building",
                    now=now,
                    ttl_seconds=self.policy["repair"]["claim_ttl_seconds"],
                    updates={"target_sha": source_sha},
                )
                self.store.update_comment(comment, render_repair(updated))
            elif (
                repair["phase"] != "building"
                or repair["promotion_pr"] != number
                or repair["target_sha"] != source_sha
            ):
                raise ContractError("completed promotion repair phase is inconsistent")
        return source_sha

    def _fail_closed_promotion(
        self,
        pull: dict[str, Any],
        promotion: dict[str, Any],
        records: list[tuple[dict[str, Any], dict[str, Any]]],
    ) -> None:
        pull, promotion = self._recover_promotion_identity(pull, promotion)
        if pull.get("state") != "closed" or pull.get("merged") is True:
            raise ContractError("promotion is not an exact closed unmerged pull request")
        selected = self._selected_records(promotion, records)
        now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
        for comment, repair in selected:
            if (
                repair["phase"] != "promoting"
                or repair["promotion_pr"] != promotion["promotion_pr"]
                or repair["target_sha"] != promotion["target_sha"]
            ):
                raise ContractError("closed promotion repair identity changed")
            failed = transition_repair(
                repair,
                "failed",
                now=now,
                ttl_seconds=300,
                updates={"terminal_reason": "promotion-pull-closed-without-merge"},
            )
            self.store.update_comment(comment, render_repair(failed))

    def _bind_promotion(
        self,
        records: list[tuple[dict[str, Any], dict[str, Any]]],
        promotion: dict[str, Any],
    ) -> None:
        now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
        for comment, repair in records:
            if repair["phase"] == "merging":
                updated = transition_repair(
                    repair,
                    "promoting",
                    now=now,
                    ttl_seconds=self.policy["repair"]["claim_ttl_seconds"],
                    updates={
                        "promotion_pr": promotion["promotion_pr"],
                        "target_sha": promotion["target_sha"],
                    },
                )
                self.store.update_comment(comment, render_repair(updated))
            elif (
                repair["phase"] != "promoting"
                or repair["promotion_pr"] != promotion["promotion_pr"]
                or repair["target_sha"] != promotion["target_sha"]
            ):
                raise ContractError("repair is bound to another promotion")

    def prepare(self, number: int) -> dict[str, Any]:
        pull = self._pull(number)
        promotion = parse_promotion(pull.get("body"))
        if (
            promotion["promotion_pr"] != number
            or pull.get("state") != "open"
            or pull.get("base", {}).get("ref") != "master"
            or pull.get("head", {}).get("ref") != "dev"
            or pull.get("head", {}).get("repo", {}).get("full_name")
            != self.store.repository
            or pull.get("base", {}).get("sha") != promotion["base_sha"]
            or pull.get("head", {}).get("sha") != promotion["target_sha"]
        ):
            raise ContractError("promotion pull request identity changed")
        merge_snapshot = pull.get("merge_commit_sha")
        if not isinstance(merge_snapshot, str) or not SHA.fullmatch(merge_snapshot):
            raise ContractError("promotion merge snapshot is missing")
        records = self._repair_records()
        selected = self._selected_records(promotion, records)
        for _comment, repair in selected:
            if (
                repair["phase"] != "promoting"
                or repair["promotion_pr"] != number
                or repair["target_sha"] != promotion["target_sha"]
            ):
                raise ContractError("repair record is not ready for promotion")
        if (
            self.store.master_sha() != promotion["base_sha"]
            or self.store.dev_sha() != promotion["target_sha"]
        ):
            raise ContractError("promotion refs changed before merge")
        files, identities = self._isolation(
            selected,
            base_sha=promotion["base_sha"],
            target_sha=promotion["target_sha"],
        )
        if files != promotion["files"] or identities != promotion["repairs"]:
            raise ContractError("promotion cohort changed before merge")
        description = f"Validated monitor promotion #{number}"
        self._publish_status(promotion["target_sha"], "success", description)
        self._publish_status(merge_snapshot, "success", description)
        if pull.get("draft") is True:
            self._mark_ready(pull)
        latest = self._pull(number)
        if (
            latest.get("draft") is True
            or latest.get("base", {}).get("sha") != promotion["base_sha"]
            or latest.get("head", {}).get("sha") != promotion["target_sha"]
            or latest.get("merge_commit_sha") != merge_snapshot
        ):
            raise ContractError("promotion changed while marking ready")
        return {
            "action": "prepared",
            "promotion_pr": number,
            "target_sha": promotion["target_sha"],
            "merge_sha": merge_snapshot,
        }

    def merge(self, number: int) -> dict[str, Any]:
        prepared = self.prepare(number)
        pull = self._pull(number)
        promotion = parse_promotion(pull.get("body"))
        merge_snapshot = pull.get("merge_commit_sha")
        if (
            pull.get("state") != "open"
            or pull.get("draft") is True
            or pull.get("base", {}).get("sha") != promotion["base_sha"]
            or pull.get("head", {}).get("sha") != promotion["target_sha"]
            or merge_snapshot != prepared["merge_sha"]
        ):
            raise ContractError("promotion changed after merge safety")
        records = self._repair_records()
        selected = self._selected_records(promotion, records)
        if (
            self.store.master_sha() != promotion["base_sha"]
            or self.store.dev_sha() != promotion["target_sha"]
        ):
            raise ContractError("promotion refs changed after merge safety")
        files, identities = self._isolation(
            selected,
            base_sha=promotion["base_sha"],
            target_sha=promotion["target_sha"],
        )
        if files != promotion["files"] or identities != promotion["repairs"]:
            raise ContractError("promotion cohort changed after merge safety")
        _status, merged = self.store._request(
            f"repos/{self.store.repository}/pulls/{number}/merge",
            method="PUT",
            payload={
                "sha": promotion["target_sha"],
                "merge_method": "merge",
                "commit_title": f"Merge production monitor promotion #{number}",
            },
            expected={200, 405, 409},
        )
        source_sha = merged.get("sha") if isinstance(merged, dict) else None
        if (
            not isinstance(merged, dict)
            or merged.get("merged") is not True
            or not isinstance(source_sha, str)
            or not SHA.fullmatch(source_sha)
        ):
            message = merged.get("message") if isinstance(merged, dict) else ""
            latest = self._pull(number)
            if latest.get("state") == "closed" and latest.get("merged") is True:
                source_sha = self._reconcile_merged_promotion(
                    latest, promotion, records
                )
                return {
                    "action": "merged",
                    "promotion_pr": number,
                    "target_sha": promotion["target_sha"],
                    "source_sha": source_sha,
                    "repairs": promotion["repairs"],
                }
            raise ContractError(f"promotion pull request was not merged: {message}")
        completed = dict(pull)
        completed.update(
            {
                "state": "closed",
                "merged": True,
                "merged_at": completed.get("merged_at") or "recorded-by-merge-api",
                "merge_commit_sha": source_sha,
            }
        )
        source_sha = self._reconcile_merged_promotion(
            completed, promotion, records
        )
        return {
            "action": "merged",
            "promotion_pr": number,
            "target_sha": promotion["target_sha"],
            "source_sha": source_sha,
            "repairs": [
                {
                    "incident_issue": repair["incident_issue"],
                    "generation": repair["generation"],
                }
                for _comment, repair in selected
            ],
        }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repository", required=True)
    parser.add_argument("--policy", required=True)
    parser.add_argument("--mode", choices=("create", "prepare", "merge"), required=True)
    parser.add_argument("--promotion-pr", type=int)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    if args.mode in {"prepare", "merge"} and (
        args.promotion_pr is None or args.promotion_pr < 1
    ):
        parser.error("--promotion-pr is required for prepare and merge modes")
    token = os.environ.get("COPILOT_AGENT_TOKEN", "")
    if not token or len(token) > 500:
        print("production_repair_promotion=FAIL reason=token-unavailable", file=sys.stderr)
        return 1
    try:
        controller = RepairPromotion(
            GitHubRepairStore(args.repository, token),
            load_policy(Path(args.policy)),
        )
        if args.mode == "create":
            result = controller.create()
        elif args.mode == "prepare":
            result = controller.prepare(args.promotion_pr)
        else:
            result = controller.merge(args.promotion_pr)
        Path(args.output).write_text(canonical_json(result) + "\n", encoding="utf-8")
    except (ContractError, OSError, ValueError) as error:
        print(f"production_repair_promotion=FAIL reason={error}", file=sys.stderr)
        return 1
    print(
        "production_repair_promotion=PASS "
        f"mode={args.mode} action={result['action']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
