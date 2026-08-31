#!/usr/bin/env python3
"""Authorize and reconcile one exact monitor-managed repair deployment."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sys
import urllib.parse
from pathlib import Path
from typing import Any, Callable

from contracts import (
    REPOSITORY,
    SHA,
    ContractError,
    canonical_json,
    load_policy,
    parse_timestamp,
    timestamp,
    validate_repair,
)
from repair_controller import (
    MAX_MANAGED_PAGES,
    PAGE_SIZE,
    REPAIR_MARKER,
    GitHubRepairStore,
    parse_repair,
    render_repair,
)
from repair_promotion import parse_promotion
from state_machine import transition_repair


REPAIR_DEPLOY_PATH = ".github/workflows/oci-production-repair-deploy.yml"
OCI_BUILD_PATH = ".github/workflows/oci-production-build.yml"
UPSTREAM_BUILD_PATH = ".github/workflows/production-build.yml"
COMPLETED_CONCLUSIONS = {
    "success",
    "failure",
    "cancelled",
    "timed_out",
    "action_required",
    "startup_failure",
    "stale",
    "neutral",
    "skipped",
}
ACTIVE_RUN_STATUSES = {"queued", "in_progress", "waiting", "pending", "requested"}


class NoRepairCohort(ContractError):
    """Raised when a successful build is unrelated to monitor repair work."""


class RepairDeployment:
    def __init__(
        self,
        store: GitHubRepairStore,
        policy: dict[str, Any],
        *,
        now: Callable[[], dt.datetime] | None = None,
    ):
        self.store = store
        self.policy = policy
        self.now = now or (
            lambda: dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
        )

    def _pull(self, number: int) -> dict[str, Any]:
        _status, payload = self.store._request(
            f"repos/{self.store.repository}/pulls/{number}"
        )
        if not isinstance(payload, dict):
            raise ContractError("repair promotion pull request is malformed")
        return payload

    def _run(self, run_id: int) -> dict[str, Any]:
        _status, payload = self.store._request(
            f"repos/{self.store.repository}/actions/runs/{run_id}/attempts/1"
        )
        if not isinstance(payload, dict):
            raise ContractError("repair workflow run is malformed")
        return payload

    def _release_was_published(self, run_id: int) -> bool:
        _status, payload = self.store._request(
            f"repos/{self.store.repository}/actions/runs/{run_id}/attempts/1/jobs"
            "?per_page=100"
        )
        jobs = payload.get("jobs") if isinstance(payload, dict) else None
        if not isinstance(jobs, list) or len(jobs) >= 100:
            raise ContractError("repair deployment job list is malformed or unbounded")
        matches = [
            job
            for job in jobs
            if isinstance(job, dict) and job.get("name") == "commit-release"
        ]
        if len(matches) > 1:
            raise ContractError("repair deployment has multiple release commit jobs")
        if not matches:
            return False
        steps = matches[0].get("steps")
        if not isinstance(steps, list):
            raise ContractError("repair release commit steps are malformed")
        commitment = [
            step
            for step in steps
            if isinstance(step, dict)
            and step.get("name") == "Verify durable release commitment"
        ]
        if len(commitment) != 1:
            raise ContractError("repair release commitment step is missing or ambiguous")
        return commitment[0].get("conclusion") == "success"

    def _records(
        self,
    ) -> dict[tuple[int, int], tuple[dict[str, Any], dict[str, Any]]]:
        result = {}
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
                key = (repair["incident_issue"], repair["generation"])
                if key in result:
                    raise ContractError("duplicate repair generation exists")
                if repair["incident_issue"] != issue_number:
                    raise ContractError("repair comment belongs to another incident")
                result[key] = (comment, repair)
        return result

    def _workflow_runs(self, workflow: str) -> list[dict[str, Any]]:
        workflow_name = urllib.parse.quote(Path(workflow).name, safe="")
        result: list[dict[str, Any]] = []
        for page in range(1, MAX_MANAGED_PAGES + 1):
            _status, payload = self.store._request(
                f"repos/{self.store.repository}/actions/workflows/{workflow_name}/runs"
                f"?branch=master&per_page={PAGE_SIZE}&page={page}"
            )
            runs = payload.get("workflow_runs") if isinstance(payload, dict) else None
            if not isinstance(runs, list) or len(runs) > PAGE_SIZE:
                raise ContractError("repair workflow run list is malformed")
            result.extend(runs)
            if len(runs) < PAGE_SIZE:
                return result
        raise ContractError("repair workflow run query exceeded its bounded page limit")

    def _build_run(self, source_sha: str) -> dict[str, Any] | None:
        title = re.compile(rf"oci-build {source_sha} upstream-[1-9][0-9]*")
        matches = [
            run
            for run in self._workflow_runs(OCI_BUILD_PATH)
            if isinstance(run, dict)
            and run.get("path") == OCI_BUILD_PATH
            and run.get("event") == "workflow_run"
            and run.get("head_branch") == "master"
            and run.get("head_sha") == source_sha
            and run.get("run_attempt") == 1
            and (run.get("head_repository") or {}).get("full_name")
            == self.store.repository
            and isinstance(run.get("display_title"), str)
            and title.fullmatch(run["display_title"])
        ]
        if len(matches) > 1:
            raise ContractError("multiple OCI builds match one repair source")
        return matches[0] if matches else None

    def _deploy_run(
        self,
        source_sha: str,
        build_run_id: int,
    ) -> dict[str, Any] | None:
        title = f"oci-repair-deploy {source_sha} build-{build_run_id}"
        matches = [
            run
            for run in self._workflow_runs(REPAIR_DEPLOY_PATH)
            if isinstance(run, dict)
            and run.get("path") == REPAIR_DEPLOY_PATH
            and run.get("event") == "workflow_dispatch"
            and run.get("head_branch") == "master"
            and run.get("head_sha") == source_sha
            and run.get("run_attempt") == 1
            and (run.get("head_repository") or {}).get("full_name")
            == self.store.repository
            and run.get("display_title") == title
        ]
        if len(matches) > 1:
            raise ContractError("multiple deployments match one repair build")
        return matches[0] if matches else None

    def _refresh_building(
        self,
        records: list[tuple[dict[str, Any], dict[str, Any]]],
        *,
        now: dt.datetime,
        build_run_id: int | None = None,
        deploy_run_id: int | None = None,
        terminal_reason: str = "",
    ) -> None:
        for comment, repair in records:
            updated = dict(repair)
            workflow_runs = dict(updated["workflow_runs"])
            if build_run_id is not None:
                workflow_runs["oci-production-build"] = build_run_id
            if deploy_run_id is not None:
                workflow_runs["oci-production-repair-deploy"] = deploy_run_id
            updated.update(
                {
                    "workflow_runs": workflow_runs,
                    "heartbeat_at": timestamp(now),
                    "expires_at": timestamp(
                        now
                        + dt.timedelta(
                            seconds=self.policy["repair"]["claim_ttl_seconds"]
                        )
                    ),
                    "terminal_reason": terminal_reason,
                }
            )
            self.store.update_comment(comment, render_repair(validate_repair(updated)))

    def _fail_building(
        self,
        records: list[tuple[dict[str, Any], dict[str, Any]]],
        *,
        now: dt.datetime,
        reason: str,
        build_run_id: int | None = None,
        deploy_run_id: int | None = None,
    ) -> None:
        for comment, repair in records:
            workflow_runs = dict(repair["workflow_runs"])
            if build_run_id is not None:
                workflow_runs["oci-production-build"] = build_run_id
            if deploy_run_id is not None:
                workflow_runs["oci-production-repair-deploy"] = deploy_run_id
            failed = transition_repair(
                repair,
                "failed",
                now=now,
                ttl_seconds=300,
                updates={
                    "workflow_runs": workflow_runs,
                    "terminal_reason": reason,
                },
            )
            self.store.update_comment(comment, render_repair(failed))

    def reconcile_lifecycle(self) -> dict[str, Any]:
        records = self._records()
        all_records = list(records.values())
        cohorts: dict[
            str, list[tuple[dict[str, Any], dict[str, Any]]]
        ] = {}
        for comment, repair in records.values():
            if repair["phase"] in {"building", "deploying"}:
                cohorts.setdefault(repair["target_sha"], []).append((comment, repair))
        now = self.now()
        actions = []
        for source_sha, cohort in sorted(cohorts.items()):
            if not SHA.fullmatch(source_sha):
                raise ContractError("building repair target SHA is malformed")
            current_master = self.store.master_sha()
            build = self._build_run(source_sha)
            if build is None:
                if current_master != source_sha:
                    self._fail_building(
                        cohort,
                        now=now,
                        reason="repair-source-no-longer-current-master",
                    )
                    actions.append(
                        {"source_sha": source_sha, "action": "failed-stale-source"}
                    )
                    continue
                if any(
                    parse_timestamp(repair["expires_at"], "repair expires_at") <= now
                    for _comment, repair in cohort
                ):
                    self._fail_building(
                        cohort,
                        now=now,
                        reason="repair-build-run-not-found",
                    )
                    actions.append(
                        {"source_sha": source_sha, "action": "failed-missing-build"}
                    )
                else:
                    actions.append({"source_sha": source_sha, "action": "awaiting-build"})
                continue
            build_run_id = build.get("id")
            if isinstance(build_run_id, bool) or not isinstance(build_run_id, int):
                raise ContractError("repair build run ID is malformed")
            build_status = build.get("status")
            if build_status in ACTIVE_RUN_STATUSES:
                if current_master != source_sha:
                    self._fail_building(
                        cohort,
                        now=now,
                        reason="repair-source-no-longer-current-master",
                        build_run_id=build_run_id,
                    )
                    actions.append(
                        {"source_sha": source_sha, "action": "failed-stale-source"}
                    )
                    continue
                self._refresh_building(
                    cohort,
                    now=now,
                    build_run_id=build_run_id,
                )
                actions.append(
                    {
                        "source_sha": source_sha,
                        "action": "build-active",
                        "build_run_id": build_run_id,
                    }
                )
                continue
            if build_status != "completed":
                raise ContractError("repair build run state is unsupported")
            if build.get("conclusion") != "success":
                conclusion = re.sub(
                    r"[^a-z0-9_-]+",
                    "-",
                    str(build.get("conclusion") or "unknown").lower(),
                )[:80]
                self._fail_building(
                    cohort,
                    now=now,
                    reason=f"repair-build-{conclusion}",
                    build_run_id=build_run_id,
                )
                actions.append(
                    {
                        "source_sha": source_sha,
                        "action": "failed-build",
                        "build_run_id": build_run_id,
                    }
                )
                continue

            authorization = self.authorize(
                build_run_id,
                source_sha,
                allowed_phases={"building", "deploying", "validating", "failed"},
                require_current_master=False,
            )
            deploy = self._deploy_run(source_sha, build_run_id)
            if deploy is None:
                if current_master != source_sha:
                    self._fail_building(
                        cohort,
                        now=now,
                        reason="repair-source-no-longer-current-master",
                        build_run_id=build_run_id,
                    )
                    actions.append(
                        {"source_sha": source_sha, "action": "failed-stale-source"}
                    )
                    continue
                if any(
                    repair["target_sha"] == source_sha
                    and repair["phase"] in {"validating", "failed"}
                    for _comment, repair in all_records
                ):
                    self._fail_building(
                        cohort,
                        now=now,
                        reason="repair-cohort-member-failed",
                        build_run_id=build_run_id,
                    )
                    actions.append(
                        {
                            "source_sha": source_sha,
                            "action": "failed-incomplete-cohort",
                            "build_run_id": build_run_id,
                        }
                    )
                    continue
                pending = all(
                    repair["terminal_reason"] == "repair-deployment-dispatch-pending"
                    for _comment, repair in cohort
                )
                if pending:
                    if any(
                        parse_timestamp(repair["expires_at"], "repair expires_at") <= now
                        for _comment, repair in cohort
                    ):
                        self._fail_building(
                            cohort,
                            now=now,
                            reason="repair-deployment-run-not-found",
                            build_run_id=build_run_id,
                        )
                        actions.append(
                            {
                                "source_sha": source_sha,
                                "action": "failed-missing-deployment",
                                "build_run_id": build_run_id,
                            }
                        )
                    else:
                        actions.append(
                            {
                                "source_sha": source_sha,
                                "action": "deployment-dispatch-pending",
                                "build_run_id": build_run_id,
                            }
                        )
                    continue
                self._refresh_building(
                    cohort,
                    now=now,
                    build_run_id=build_run_id,
                    terminal_reason="repair-deployment-dispatch-pending",
                )
                self.store._request(
                    f"repos/{self.store.repository}/actions/workflows/"
                    "oci-production-repair-deploy.yml/dispatches",
                    method="POST",
                    payload={
                        "ref": "master",
                        "inputs": {
                            "source_sha": source_sha,
                            "build_run_id": str(build_run_id),
                            "repair_id": authorization["repair_id"],
                        },
                    },
                    expected={204},
                )
                actions.append(
                    {
                        "source_sha": source_sha,
                        "action": "deployment-dispatched",
                        "build_run_id": build_run_id,
                    }
                )
                break

            deploy_run_id = deploy.get("id")
            if isinstance(deploy_run_id, bool) or not isinstance(deploy_run_id, int):
                raise ContractError("repair deployment run ID is malformed")
            deploy_status = deploy.get("status")
            if deploy_status in ACTIVE_RUN_STATUSES:
                self._refresh_building(
                    cohort,
                    now=now,
                    build_run_id=build_run_id,
                    deploy_run_id=deploy_run_id,
                )
                actions.append(
                    {
                        "source_sha": source_sha,
                        "action": "deployment-active",
                        "build_run_id": build_run_id,
                        "deploy_run_id": deploy_run_id,
                    }
                )
            elif deploy_status == "completed":
                result = self.reconcile(deploy_run_id)
                actions.append(
                    {
                        "source_sha": source_sha,
                        "action": "deployment-reconciled",
                        "build_run_id": build_run_id,
                        "deploy_run_id": deploy_run_id,
                        "release_published": result["release_published"],
                    }
                )
            else:
                raise ContractError("repair deployment run state is unsupported")
        return {
            "schema": "betstan.production-repair-lifecycle-reconciliation.v1",
            "actions": actions,
            "reconciled_at": timestamp(now),
        }

    def authorize(
        self,
        build_run_id: int,
        source_sha: str,
        *,
        allowed_phases: set[str] | None = None,
        require_current_master: bool = True,
    ) -> dict[str, Any]:
        if not SHA.fullmatch(source_sha):
            raise ContractError("repair deployment source SHA is malformed")
        if require_current_master and self.store.master_sha() != source_sha:
            raise ContractError("repair deployment source is not current master")
        build = self._run(build_run_id)
        repository = (build.get("head_repository") or {}).get("full_name")
        title = build.get("display_title")
        match = (
            re.fullmatch(rf"oci-build {source_sha} upstream-([1-9][0-9]*)", title)
            if isinstance(title, str)
            else None
        )
        if (
            build.get("id") != build_run_id
            or build.get("path") != OCI_BUILD_PATH
            or build.get("event") != "workflow_run"
            or build.get("head_branch") != "master"
            or build.get("head_sha") != source_sha
            or build.get("run_attempt") != 1
            or build.get("status") != "completed"
            or build.get("conclusion") != "success"
            or repository != self.store.repository
            or match is None
        ):
            raise ContractError("OCI build provenance is invalid")
        upstream_run_id = int(match.group(1))
        upstream = self._run(upstream_run_id)
        upstream_repository = (upstream.get("head_repository") or {}).get("full_name")
        if (
            upstream.get("id") != upstream_run_id
            or upstream.get("path") != UPSTREAM_BUILD_PATH
            or upstream.get("event") != "push"
            or upstream.get("head_branch") != "master"
            or upstream.get("head_sha") != source_sha
            or upstream.get("run_attempt") != 1
            or upstream.get("status") != "completed"
            or upstream.get("conclusion") != "success"
            or upstream_repository != self.store.repository
        ):
            raise ContractError("upstream production build provenance is invalid")
        records = self._records()
        phases = allowed_phases or {"building"}
        building = [
            (comment, repair)
            for comment, repair in records.values()
            if repair["phase"] in phases and repair["target_sha"] == source_sha
        ]
        if not building:
            raise NoRepairCohort(
                "no building repair cohort matches the OCI build"
            )
        promotion_numbers = {repair["promotion_pr"] for _comment, repair in building}
        if len(promotion_numbers) != 1 or 0 in promotion_numbers:
            raise ContractError("building repairs do not share one promotion")
        promotion_number = promotion_numbers.pop()
        pull = self._pull(promotion_number)
        promotion = parse_promotion(pull.get("body"))
        if (
            pull.get("state") != "closed"
            or pull.get("merged") is not True
            or not pull.get("merged_at")
            or pull.get("base", {}).get("ref") != "master"
            or pull.get("head", {}).get("ref") != "dev"
            or pull.get("head", {}).get("repo", {}).get("full_name")
            != self.store.repository
            or pull.get("merge_commit_sha") != source_sha
            or promotion["promotion_pr"] != promotion_number
        ):
            raise ContractError("repair promotion provenance is invalid")
        expected = {
            (identity["incident_issue"], identity["generation"]): identity
            for identity in promotion["repairs"]
        }
        if set(expected) != {
            (repair["incident_issue"], repair["generation"])
            for _comment, repair in building
        }:
            raise ContractError("building repair cohort differs from its promotion")
        for _comment, repair in building:
            identity = expected[(repair["incident_issue"], repair["generation"])]
            if (
                identity["repair_pr"] != repair["repair_pr"]
                or identity["merge_sha"] != repair["merge_sha"]
                or identity["owned_paths"] != repair["owned_paths"]
            ):
                raise ContractError("building repair identity changed")
        repair_id = f"code-repair-{promotion_number}-{source_sha[:12]}"
        return {
            "schema": "betstan.production-repair-deployment-authorization.v1",
            "authorized": True,
            "repository": REPOSITORY,
            "repair_id": repair_id,
            "source_sha": source_sha,
            "build_run_id": build_run_id,
            "upstream_build_run_id": upstream_run_id,
            "promotion_pr": promotion_number,
            "repairs": [
                {
                    "incident_issue": repair["incident_issue"],
                    "generation": repair["generation"],
                }
                for _comment, repair in sorted(
                    building,
                    key=lambda pair: (
                        pair[1]["incident_issue"],
                        pair[1]["generation"],
                    ),
                )
            ],
        }

    def reconcile(self, deploy_run_id: int) -> dict[str, Any]:
        run = self._run(deploy_run_id)
        repository = (run.get("head_repository") or {}).get("full_name")
        title = run.get("display_title")
        match = (
            re.fullmatch(
                r"oci-repair-deploy ([0-9a-f]{40}) build-([1-9][0-9]*)",
                title,
            )
            if isinstance(title, str)
            else None
        )
        if (
            run.get("id") != deploy_run_id
            or run.get("path") != REPAIR_DEPLOY_PATH
            or run.get("event") != "workflow_dispatch"
            or run.get("head_branch") != "master"
            or run.get("run_attempt") != 1
            or run.get("status") != "completed"
            or run.get("conclusion") not in COMPLETED_CONCLUSIONS
            or repository != self.store.repository
            or match is None
        ):
            raise ContractError("repair deployment workflow provenance is invalid")
        source_sha = match.group(1)
        build_run_id = int(match.group(2))
        if run.get("head_sha") != source_sha:
            raise ContractError("repair deployment run source SHA is inconsistent")
        authorization = self.authorize(
            build_run_id,
            source_sha,
            allowed_phases={"building", "deploying", "validating", "failed"},
            require_current_master=False,
        )
        records = self._records()
        selected = [
            records[(identity["incident_issue"], identity["generation"])]
            for identity in authorization["repairs"]
        ]
        now = self.now()
        release_published = (
            run["conclusion"] == "success"
            or self._release_was_published(deploy_run_id)
        )
        updated_repairs = []
        for comment, repair in selected:
            workflow_runs = dict(repair["workflow_runs"])
            workflow_runs["oci-production-build"] = build_run_id
            workflow_runs["oci-production-repair-deploy"] = deploy_run_id
            if release_published:
                if repair["phase"] == "failed":
                    updated_repairs.append(
                        {
                            "incident_issue": repair["incident_issue"],
                            "generation": repair["generation"],
                            "phase": repair["phase"],
                        }
                    )
                    continue
                if repair["phase"] == "building":
                    repair = transition_repair(
                        repair,
                        "deploying",
                        now=now,
                        ttl_seconds=self.policy["repair"]["claim_ttl_seconds"],
                        updates={"workflow_runs": workflow_runs},
                    )
                if repair["phase"] == "deploying":
                    repair = transition_repair(
                        repair,
                        "validating",
                        now=now,
                        ttl_seconds=self.policy["repair"]["claim_ttl_seconds"],
                        updates={"workflow_runs": workflow_runs},
                    )
                elif repair["phase"] == "validating":
                    repair = dict(repair)
                    repair["workflow_runs"] = workflow_runs
                    repair["heartbeat_at"] = timestamp(now)
                    repair["expires_at"] = timestamp(
                        now
                        + dt.timedelta(
                            seconds=self.policy["repair"]["claim_ttl_seconds"]
                        )
                    )
                    repair = validate_repair(repair)
                else:
                    raise ContractError("successful deployment repair phase is invalid")
            else:
                if repair["phase"] == "failed":
                    updated_repairs.append(
                        {
                            "incident_issue": repair["incident_issue"],
                            "generation": repair["generation"],
                            "phase": repair["phase"],
                        }
                    )
                    continue
                if repair["phase"] not in {"building", "deploying", "validating"}:
                    raise ContractError("failed deployment repair phase is invalid")
                repair = transition_repair(
                    repair,
                    "failed",
                    now=now,
                    ttl_seconds=self.policy["repair"]["claim_ttl_seconds"],
                    updates={
                        "workflow_runs": workflow_runs,
                        "terminal_reason": "repair-deployment-failed",
                    },
                )
            self.store.update_comment(comment, render_repair(repair))
            updated_repairs.append(
                {
                    "incident_issue": repair["incident_issue"],
                    "generation": repair["generation"],
                    "phase": repair["phase"],
                }
            )
        return {
            "schema": "betstan.production-repair-deployment-reconciliation.v1",
            "deploy_run_id": deploy_run_id,
            "source_sha": source_sha,
            "conclusion": run["conclusion"],
            "release_published": release_published,
            "repairs": updated_repairs,
            "reconciled_at": timestamp(now),
        }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repository", required=True)
    parser.add_argument("--policy", required=True)
    parser.add_argument(
        "--mode",
        choices=("authorize", "reconcile", "lifecycle"),
        required=True,
    )
    parser.add_argument("--build-run-id", type=int)
    parser.add_argument("--source-sha")
    parser.add_argument("--deploy-run-id", type=int)
    parser.add_argument("--allow-no-match", action="store_true")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    if args.mode == "authorize" and (
        args.build_run_id is None or args.build_run_id < 1 or not args.source_sha
    ):
        parser.error("--build-run-id and --source-sha are required for authorize mode")
    if args.mode == "reconcile" and (
        args.deploy_run_id is None or args.deploy_run_id < 1
    ):
        parser.error("--deploy-run-id is required for reconcile mode")
    token_name = "GITHUB_TOKEN" if args.mode == "authorize" else "COPILOT_AGENT_TOKEN"
    token = os.environ.get(token_name, "")
    if not token or len(token) > 500:
        print("production_repair_deploy=FAIL reason=token-unavailable", file=sys.stderr)
        return 1
    try:
        controller = RepairDeployment(
            GitHubRepairStore(args.repository, token),
            load_policy(Path(args.policy)),
        )
        if args.mode == "authorize":
            result = controller.authorize(args.build_run_id, args.source_sha)
        elif args.mode == "reconcile":
            result = controller.reconcile(args.deploy_run_id)
        else:
            result = controller.reconcile_lifecycle()
        Path(args.output).write_text(canonical_json(result) + "\n", encoding="utf-8")
    except NoRepairCohort as error:
        if args.mode != "authorize" or not args.allow_no_match:
            print(f"production_repair_deploy=FAIL reason={error}", file=sys.stderr)
            return 1
        result = {
            "schema": "betstan.production-repair-deployment-authorization.v1",
            "authorized": False,
            "reason": "no-repair-cohort",
        }
        Path(args.output).write_text(canonical_json(result) + "\n", encoding="utf-8")
        print("production_repair_deploy=PASS mode=authorize authorized=false")
        return 0
    except (ContractError, OSError, ValueError, json.JSONDecodeError) as error:
        print(f"production_repair_deploy=FAIL reason={error}", file=sys.stderr)
        return 1
    print(f"production_repair_deploy=PASS mode={args.mode}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
