#!/usr/bin/env python3
"""Validate one Copilot repair PR and selectively approve its test runs."""

from __future__ import annotations

import argparse
import datetime as dt
import fnmatch
import os
import sys
import urllib.parse
from pathlib import Path
from typing import Any

from contracts import (
    SHA,
    ContractError,
    canonical_json,
    load_policy,
    timestamp,
    validate_repair,
)
from publisher import parse_incident
from repair_controller import (
    COPILOT_LOGIN,
    REPAIR_MARKER,
    GitHubRepairStore,
    parse_repair,
    render_repair,
)
from state_machine import transition_repair


POLICY_CONTEXT = "monitor-repair-policy/dev"
APPROVABLE_WORKFLOWS = {
    ".github/workflows/production-build.yml",
    ".github/workflows/oci-validate.yml",
}


def _matches(path: str, patterns: list[str]) -> bool:
    return any(fnmatch.fnmatchcase(path, pattern) for pattern in patterns)


class RepairPolicy:
    def __init__(
        self,
        store: GitHubRepairStore,
        policy: dict[str, Any],
        *,
        approve_actions: bool,
    ):
        self.store = store
        self.policy = policy
        self.approve_actions = approve_actions

    def _pull(self, number: int) -> dict[str, Any]:
        _status, payload = self.store._request(
            f"repos/{self.store.repository}/pulls/{number}"
        )
        if not isinstance(payload, dict):
            raise ContractError("repair pull request is malformed")
        return payload

    def _task(self, task_id: str) -> dict[str, Any]:
        encoded = urllib.parse.quote(task_id, safe="")
        _status, payload = self.store._request(
            f"agents/repos/{self.store.repository}/tasks/{encoded}",
            api_version="2026-03-10",
        )
        if not isinstance(payload, dict) or payload.get("id") != task_id:
            raise ContractError("Copilot task response is malformed")
        return payload

    def _repair_identity(
        self, pull: dict[str, Any]
    ) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any], dict[str, Any]]:
        matches = []
        for issue in self.store.list_incidents():
            incident = parse_incident(issue.get("body"))
            for comment in self.store.list_comments(incident["issue_number"]):
                if REPAIR_MARKER not in str(comment.get("body", "")):
                    continue
                repair = parse_repair(comment["body"])
                if repair["phase"] not in {"coding", "review"} or not repair["task_id"]:
                    continue
                task = self._task(repair["task_id"])
                artifacts = task.get("artifacts")
                if not isinstance(artifacts, list):
                    raise ContractError("Copilot task artifacts are malformed")
                pull_ids = {
                    item.get("data", {}).get("id")
                    for item in artifacts
                    if isinstance(item, dict) and item.get("type") == "pull"
                }
                branches = [
                    item.get("data", {})
                    for item in artifacts
                    if isinstance(item, dict) and item.get("type") == "branch"
                ]
                branch_match = any(
                    branch.get("head_ref") == pull.get("head", {}).get("ref")
                    and branch.get("base_ref") == "dev"
                    for branch in branches
                    if isinstance(branch, dict)
                )
                if pull.get("id") in pull_ids and branch_match:
                    custom_agent = task.get("custom_agent")
                    if (
                        not isinstance(custom_agent, dict)
                        or custom_agent.get("id")
                        != self.policy["services"][incident["service"]]["agent"]
                    ):
                        raise ContractError(
                            "Copilot task custom agent differs from policy"
                        )
                    state = task.get("state")
                    if state in {"failed", "cancelled", "timed_out"}:
                        failed = transition_repair(
                            repair,
                            "failed",
                            now=dt.datetime.now(dt.timezone.utc).replace(microsecond=0),
                            ttl_seconds=300,
                            updates={
                                "agent_branch": pull.get("head", {}).get("ref", ""),
                                "head_sha": pull.get("head", {}).get("sha", ""),
                                "repair_pr": pull.get("number", 0),
                                "terminal_reason": f"copilot-task-{state}",
                            },
                        )
                        self.store.update_comment(comment, render_repair(failed))
                        raise ContractError("Copilot task is terminal without a repair")
                    if state not in {
                        "queued",
                        "in_progress",
                        "idle",
                        "waiting_for_user",
                        "completed",
                    }:
                        raise ContractError("Copilot task is not in an acceptable state")
                    matches.append((issue, incident, comment, repair))
        if len(matches) != 1:
            raise ContractError(
                f"expected one repair task for pull request, found {len(matches)}"
            )
        return matches[0]

    def _validate_commits(self, number: int) -> None:
        _status, commits = self.store._request(
            f"repos/{self.store.repository}/pulls/{number}/commits?per_page=100"
        )
        if not isinstance(commits, list) or not commits or len(commits) >= 100:
            raise ContractError("repair commit list is empty or unbounded")
        for commit in commits:
            if (
                not isinstance(commit, dict)
                or (commit.get("author") or {}).get("login") != COPILOT_LOGIN
                or (commit.get("commit") or {})
                .get("verification", {})
                .get("verified")
                is not True
            ):
                raise ContractError("repair commits are not signed Copilot commits")

    def _validate_files(
        self,
        number: int,
        repair: dict[str, Any],
    ) -> list[str]:
        _status, files = self.store._request(
            f"repos/{self.store.repository}/pulls/{number}/files?per_page=100"
        )
        if not isinstance(files, list) or not files or len(files) >= 100:
            raise ContractError("repair file list is empty or unbounded")
        names: list[str] = []
        for item in files:
            if not isinstance(item, dict):
                raise ContractError("repair file entry is malformed")
            candidates = [item.get("filename")]
            if item.get("previous_filename"):
                candidates.append(item["previous_filename"])
            if any(not isinstance(path, str) or not path for path in candidates):
                raise ContractError("repair file path is malformed")
            if any(
                _matches(path, self.policy["forbidden_repair_paths"])
                for path in candidates
            ):
                raise ContractError("repair changes a forbidden path")
            if any(not _matches(path, repair["owned_paths"]) for path in candidates):
                raise ContractError("repair changes a path outside its ownership")
            names.append(item["filename"])
        return names

    def _publish_status(self, sha: str, state: str, description: str) -> None:
        self.store._request(
            f"repos/{self.store.repository}/statuses/{sha}",
            method="POST",
            payload={
                "state": state,
                "context": POLICY_CONTEXT,
                "description": description[:140],
            },
            expected={201},
        )

    def _label(self, number: int) -> None:
        self.store._request(
            f"repos/{self.store.repository}/issues/{number}/labels",
            method="POST",
            payload={
                "labels": [
                    self.policy["repair"]["managed_label"],
                    self.policy["repair"]["repair_label"],
                ]
            },
            expected={200},
        )

    def _approve_runs(self, pull: dict[str, Any]) -> list[int]:
        if not self.approve_actions:
            return []
        head_ref = urllib.parse.quote(pull["head"]["ref"], safe="")
        _status, payload = self.store._request(
            f"repos/{self.store.repository}/actions/runs"
            f"?event=pull_request&branch={head_ref}&per_page=100"
        )
        runs = payload.get("workflow_runs") if isinstance(payload, dict) else None
        if not isinstance(runs, list) or len(runs) >= 100:
            raise ContractError("repair workflow run list is malformed or unbounded")
        approved = []
        for run in runs:
            relations = run.get("pull_requests") if isinstance(run, dict) else None
            relation_match = isinstance(relations, list) and any(
                relation.get("number") == pull["number"]
                and relation.get("head", {}).get("sha") == pull["head"]["sha"]
                for relation in relations
                if isinstance(relation, dict)
            )
            if (
                not relation_match
                or run.get("path") not in APPROVABLE_WORKFLOWS
                or run.get("head_sha") != pull["head"]["sha"]
                or run.get("head_repository", {}).get("full_name")
                != self.store.repository
                or run.get("run_attempt") != 1
                or run.get("status") != "completed"
                or run.get("conclusion") != "action_required"
            ):
                continue
            run_id = run.get("id")
            if isinstance(run_id, bool) or not isinstance(run_id, int):
                raise ContractError("repair workflow run ID is malformed")
            latest = self._pull(pull["number"])
            if (
                latest.get("head", {}).get("sha") != pull["head"]["sha"]
                or latest.get("base", {}).get("sha") != pull["base"]["sha"]
            ):
                raise ContractError("repair pull changed before workflow approval")
            self.store._request(
                f"repos/{self.store.repository}/actions/runs/{run_id}/approve",
                method="POST",
                expected={202},
            )
            approved.append(run_id)
        return approved

    def evaluate(self, number: int) -> dict[str, Any]:
        pull = self._pull(number)
        open_pull = pull.get("state") == "open"
        completed_merge = (
            pull.get("state") == "closed"
            and pull.get("merged") is True
            and bool(pull.get("merged_at"))
        )
        if pull.get("state") == "closed" and not completed_merge:
            _issue, _incident, comment, repair = self._repair_identity(pull)
            if repair["repair_pr"] not in {0, number}:
                raise ContractError("repair record is bound to another pull request")
            failed = transition_repair(
                repair,
                "failed",
                now=dt.datetime.now(dt.timezone.utc).replace(microsecond=0),
                ttl_seconds=300,
                updates={
                    "agent_branch": pull.get("head", {}).get("ref", ""),
                    "head_sha": pull.get("head", {}).get("sha", ""),
                    "repair_pr": number,
                    "terminal_reason": "repair-pull-closed-without-merge",
                },
            )
            self.store.update_comment(comment, render_repair(failed))
            raise ContractError("repair pull request closed without merge")
        if (
            not (open_pull or completed_merge)
            or pull.get("base", {}).get("ref") != "dev"
            or pull.get("head", {}).get("repo", {}).get("full_name")
            != self.store.repository
            or pull.get("user", {}).get("login") != COPILOT_LOGIN
        ):
            raise ContractError("pull request identity is outside monitor policy")
        head_sha = pull.get("head", {}).get("sha")
        base_sha = pull.get("base", {}).get("sha")
        merge_sha = pull.get("merge_commit_sha")
        if not all(isinstance(value, str) and SHA.fullmatch(value) for value in (
            head_sha,
            base_sha,
            merge_sha,
        )):
            raise ContractError("pull request has no exact merge snapshot")
        issue, incident, comment, repair = self._repair_identity(pull)
        if repair["incident_fingerprint"] != incident["fingerprint"]:
            raise ContractError("repair and incident fingerprints differ")
        if repair["repair_pr"] not in {0, number}:
            raise ContractError("repair record is bound to another pull request")
        _status, comparison = self.store._request(
            f"repos/{self.store.repository}/compare/"
            f"{repair['base_sha']}...{head_sha}"
        )
        if (
            not isinstance(comparison, dict)
            or comparison.get("status") not in {"ahead", "identical"}
        ):
            raise ContractError("repair base SHA is not an ancestor of its head")
        self._validate_commits(number)
        files = self._validate_files(number, repair)

        now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
        updates = {
            "agent_branch": pull["head"]["ref"],
            "head_sha": head_sha,
            "repair_pr": number,
            "terminal_reason": "",
        }
        if repair["phase"] == "coding":
            updated = transition_repair(
                repair,
                "review",
                now=now,
                ttl_seconds=self.policy["repair"]["claim_ttl_seconds"],
                updates=updates,
            )
        else:
            updated = dict(repair)
            updated.update(updates)
            updated["heartbeat_at"] = timestamp(now)
            updated["expires_at"] = timestamp(
                now
                + dt.timedelta(
                    seconds=self.policy["repair"]["claim_ttl_seconds"]
                )
            )
            updated = validate_repair(updated)
        self.store.update_comment(comment, render_repair(updated))
        self._label(number)
        description = (
            f"Validated repair #{number} generation {updated['generation']}"
        )
        for sha in {head_sha, merge_sha}:
            self._publish_status(sha, "success", description)
        approved = self._approve_runs(pull) if open_pull else []
        return {
            "schema": "betstan.production-repair-policy.v1",
            "pull_request": number,
            "incident_issue": issue["number"],
            "repair_generation": updated["generation"],
            "head_sha": head_sha,
            "merge_sha": merge_sha,
            "files": files,
            "approved_runs": approved,
        }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repository", required=True)
    parser.add_argument("--policy", required=True)
    parser.add_argument("--pull-request", required=True, type=int)
    parser.add_argument("--approve-actions", choices=("true", "false"), required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    token = os.environ.get("COPILOT_AGENT_TOKEN", "")
    if not token or len(token) > 500:
        print("production_repair_policy=FAIL reason=token-unavailable", file=sys.stderr)
        return 1
    try:
        result = RepairPolicy(
            GitHubRepairStore(args.repository, token),
            load_policy(Path(args.policy)),
            approve_actions=args.approve_actions == "true",
        ).evaluate(args.pull_request)
        Path(args.output).write_text(canonical_json(result) + "\n", encoding="utf-8")
    except (ContractError, OSError, ValueError) as error:
        print(f"production_repair_policy=FAIL reason={error}", file=sys.stderr)
        return 1
    print(
        "production_repair_policy=PASS "
        f"pull_request={result['pull_request']} files={len(result['files'])}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
