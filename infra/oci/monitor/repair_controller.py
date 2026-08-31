#!/usr/bin/env python3
"""Acquire repair ownership and assign eligible incidents to Copilot."""

from __future__ import annotations

import argparse
import datetime as dt
import fnmatch
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable, Protocol

from contracts import (
    SHA,
    ContractError,
    canonical_json,
    load_policy,
    parse_timestamp,
    timestamp,
    validate_incident,
    validate_repair,
)
from publisher import INCIDENT_LABEL, incident_title, parse_incident, render_incident
from state_machine import new_repair, transition_repair


REPAIR_MARKER = "betstan-production-repair-v1"
COPILOT_LOGIN = "copilot-swe-agent[bot]"
TERMINAL_PHASES = {"resolved", "failed", "unsupported-runbook"}
MAX_RESPONSE_BYTES = 1024 * 1024
PAGE_SIZE = 100
MAX_MANAGED_PAGES = 10


class RepairStore(Protocol):
    def list_incidents(self) -> list[dict[str, Any]]: ...

    def list_comments(self, issue_number: int) -> list[dict[str, Any]]: ...

    def dev_sha(self) -> str: ...

    def can_assign_copilot(self) -> bool: ...

    def create_comment(self, issue_number: int, body: str) -> dict[str, Any]: ...

    def update_comment(
        self, comment: dict[str, Any], body: str
    ) -> dict[str, Any]: ...

    def update_incident(
        self,
        issue: dict[str, Any],
        incident: dict[str, Any],
    ) -> dict[str, Any]: ...

    def assign_copilot(
        self,
        issue_number: int,
        *,
        base_branch: str,
        custom_instructions: str,
        custom_agent: str,
    ) -> str: ...

    def find_copilot_task(
        self,
        issue_number: int,
        *,
        base_branch: str,
        owned_paths: list[str],
        custom_agent: str,
        not_before: dt.datetime,
        excluded_ids: set[str],
    ) -> dict[str, Any] | None: ...

    def copilot_task(self, task_id: str) -> dict[str, Any]: ...


def render_repair(document: dict[str, Any]) -> str:
    validate_repair(document)
    return (
        "## Production monitor repair\n\n"
        "This repair claim is managed by the trusted repair controller. "
        "Issue comments and pull request text are not authority.\n\n"
        f"- Generation: `{document['generation']}`\n"
        f"- Phase: `{document['phase']}`\n"
        f"- Base: `{document['base_branch']}@{document['base_sha']}`\n"
        f"- Owner: `{document['owner']}`\n\n"
        f"<!-- {REPAIR_MARKER}\n{canonical_json(document)}\n-->\n"
    )


def parse_repair(body: Any) -> dict[str, Any]:
    if not isinstance(body, str):
        raise ContractError("repair comment body is missing")
    pattern = re.compile(
        rf"<!-- {re.escape(REPAIR_MARKER)}\n(?P<payload>[^\n]+)\n-->"
    )
    matches = list(pattern.finditer(body))
    if len(matches) != 1:
        raise ContractError("repair comment must contain exactly one machine payload")
    try:
        payload = json.loads(matches[0].group("payload"))
    except json.JSONDecodeError as error:
        raise ContractError("repair comment payload is malformed") from error
    return validate_repair(payload)


def _paths_overlap(left: list[str], right: list[str]) -> bool:
    return bool(set(left) & set(right))


def _instructions(
    issue_number: int,
    incident: dict[str, Any],
    repair: dict[str, Any],
    policy: dict[str, Any],
) -> str:
    allowed = ", ".join(f"`{path}`" for path in repair["owned_paths"])
    forbidden = ", ".join(f"`{path}`" for path in policy["forbidden_repair_paths"])
    return (
        f"Repair confirmed OCI production incident #{issue_number}: "
        f"{incident['service']}/{incident['code']}. "
        f"Use base branch `dev` at `{repair['base_sha']}` and open a draft pull request. "
        f"Only modify files matching: {allowed}. "
        f"Do not modify files matching: {forbidden}. "
        "Add or update focused tests that reproduce the defect. "
        "Do not edit workflows, monitor policy, agent definitions, infrastructure, "
        "deployment code, manifests, generated artifacts, lockfiles, secrets, or "
        "production state. Do not run or propose production commands. "
        f"Bind the PR to incident fingerprint `{incident['fingerprint']}` and "
        f"repair generation `{repair['generation']}`."
    )


class RepairController:
    def __init__(
        self,
        store: RepairStore,
        policy: dict[str, Any],
        *,
        now: Callable[[], dt.datetime] | None = None,
    ):
        self.store = store
        self.policy = policy
        self.now = now or (
            lambda: dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
        )

    def _repairs(
        self, issues: list[dict[str, Any]]
    ) -> tuple[dict[int, list[tuple[dict[str, Any], dict[str, Any]]]], list[dict[str, Any]]]:
        by_issue: dict[int, list[tuple[dict[str, Any], dict[str, Any]]]] = {}
        active: list[dict[str, Any]] = []
        for issue in issues:
            number = issue.get("number")
            if isinstance(number, bool) or not isinstance(number, int):
                raise ContractError("incident issue number is malformed")
            records: list[tuple[dict[str, Any], dict[str, Any]]] = []
            for comment in self.store.list_comments(number):
                body = comment.get("body")
                if not isinstance(body, str) or REPAIR_MARKER not in body:
                    continue
                repair = parse_repair(body)
                if repair["incident_issue"] != number:
                    raise ContractError("repair comment belongs to another issue")
                records.append((comment, repair))
                if repair["phase"] not in TERMINAL_PHASES:
                    active.append(repair)
            generations = [repair["generation"] for _comment, repair in records]
            if len(generations) != len(set(generations)):
                raise ContractError("duplicate repair generation exists")
            by_issue[number] = sorted(
                records, key=lambda item: item[1]["generation"]
            )
        return by_issue, active

    def _reconcile_claimed_repairs(
        self,
        repairs_by_issue: dict[
            int, list[tuple[dict[str, Any], dict[str, Any]]]
        ],
        *,
        now: dt.datetime,
    ) -> list[dict[str, Any]]:
        reconciled = []
        for issue_number, records in repairs_by_issue.items():
            for index, (comment, repair) in enumerate(records):
                if (
                    repair["owner"] != "copilot-swe-agent"
                    or repair["phase"] != "claimed"
                    or parse_timestamp(repair["expires_at"], "repair expires_at") > now
                ):
                    continue
                updated = transition_repair(
                    repair,
                    "failed",
                    now=now,
                    ttl_seconds=300,
                    updates={"terminal_reason": "copilot-claim-expired"},
                )
                latest = self.store.update_comment(comment, render_repair(updated))
                records[index] = (latest, updated)
                reconciled.append(
                    {
                        "issue_number": issue_number,
                        "repair_generation": updated["generation"],
                        "phase": updated["phase"],
                    }
                )
        return reconciled

    def _reconcile_incident_generations(
        self,
        issues: list[dict[str, Any]],
        repairs_by_issue: dict[
            int, list[tuple[dict[str, Any], dict[str, Any]]]
        ],
        incidents_by_issue: dict[int, dict[str, Any]],
    ) -> list[dict[str, Any]]:
        reconciled = []
        recoverable_reasons = {
            "copilot-assignment-failed",
            "copilot-claim-expired",
            "copilot-task-identity-unresolved",
        }
        for issue in issues:
            number = issue.get("number")
            incident = incidents_by_issue.get(number)
            if incident is None:
                continue
            records = repairs_by_issue.get(number, [])
            expected = len(records)
            if incident["repair_generation"] == expected:
                continue
            if (
                incident["repair_generation"] + 1 != expected
                or not records
                or records[-1][1]["phase"] != "failed"
                or records[-1][1]["terminal_reason"] not in recoverable_reasons
                or any(
                    repair["phase"] not in TERMINAL_PHASES
                    for _comment, repair in records
                )
            ):
                raise ContractError(
                    "incident repair generation differs from its comments"
                )
            updated = dict(incident)
            updated.update(
                {
                    "repair_generation": expected,
                    "status": "confirmed",
                    "generation": incident["generation"] + 1,
                }
            )
            updated = validate_incident(updated)
            latest = self.store.update_incident(issue, updated)
            issue.update(latest)
            incidents_by_issue[number] = updated
            reconciled.append(
                {
                    "issue_number": number,
                    "repair_generation": expected,
                    "phase": "incident-recovered",
                }
            )
        return reconciled

    def _reconcile_coding_repairs(
        self,
        repairs_by_issue: dict[
            int, list[tuple[dict[str, Any], dict[str, Any]]]
        ],
        incidents_by_issue: dict[int, dict[str, Any]],
        *,
        now: dt.datetime,
    ) -> list[dict[str, Any]]:
        known_task_ids = {
            repair["task_id"]
            for records in repairs_by_issue.values()
            for _comment, repair in records
            if repair["task_id"]
        }
        reconciled = []
        for issue_number, records in repairs_by_issue.items():
            for index, (comment, repair) in enumerate(records):
                if repair["owner"] != "copilot-swe-agent" or repair["phase"] != "coding":
                    continue
                task = None
                task_was_missing = not repair["task_id"]
                if task_was_missing:
                    incident = incidents_by_issue.get(issue_number)
                    if incident is None:
                        raise ContractError("repair incident is missing")
                    task = self.store.find_copilot_task(
                        issue_number,
                        base_branch=repair["base_branch"],
                        owned_paths=repair["owned_paths"],
                        custom_agent=self.policy["services"][
                            incident["service"]
                        ]["agent"],
                        not_before=parse_timestamp(
                            repair["heartbeat_at"], "repair heartbeat_at"
                        )
                        - dt.timedelta(minutes=5),
                        excluded_ids=known_task_ids,
                    )
                    if task is None and parse_timestamp(
                        repair["expires_at"], "repair expires_at"
                    ) > now:
                        continue
                elif parse_timestamp(repair["expires_at"], "repair expires_at") <= now:
                    task = self.store.copilot_task(repair["task_id"])
                else:
                    continue

                task_id = task.get("id") if isinstance(task, dict) else ""
                state = task.get("state") if isinstance(task, dict) else None
                if task_id and task_was_missing and (
                    not isinstance(task_id, str) or task_id in known_task_ids
                ):
                    raise ContractError("recovered Copilot task identity is ambiguous")
                if task is None:
                    if repair["attempts"] >= self.policy["repair"]["maximum_attempts"]:
                        updated = transition_repair(
                            repair,
                            "failed",
                            now=now,
                            ttl_seconds=300,
                            updates={
                                "terminal_reason": "copilot-task-identity-unresolved",
                            },
                        )
                    else:
                        updated = dict(repair)
                        updated.update(
                            {
                                "attempts": repair["attempts"] + 1,
                                "heartbeat_at": timestamp(now),
                                "expires_at": timestamp(
                                    now
                                    + dt.timedelta(
                                        seconds=self.policy["repair"][
                                            "claim_ttl_seconds"
                                        ]
                                    )
                                ),
                                "terminal_reason": "copilot-task-identity-unresolved",
                            }
                        )
                        updated = validate_repair(updated)
                elif state in {"failed", "cancelled", "timed_out"}:
                    updated = transition_repair(
                        repair,
                        "failed",
                        now=now,
                        ttl_seconds=300,
                        updates={
                            "task_id": task_id,
                            "terminal_reason": f"copilot-task-{state}",
                        },
                    )
                elif state == "completed" and (
                    not isinstance(task.get("artifacts"), list)
                    or not any(
                        isinstance(artifact, dict) and artifact.get("type") == "pull"
                        for artifact in task["artifacts"]
                    )
                ):
                    updated = transition_repair(
                        repair,
                        "failed",
                        now=now,
                        ttl_seconds=300,
                        updates={
                            "task_id": task_id,
                            "terminal_reason": "copilot-task-completed-without-pull-request",
                        },
                    )
                elif state in {
                    "queued",
                    "in_progress",
                    "idle",
                    "waiting_for_user",
                    "completed",
                }:
                    updated = dict(repair)
                    updated.update(
                        {
                            "task_id": task_id,
                            "heartbeat_at": timestamp(now),
                            "expires_at": timestamp(
                                now
                                + dt.timedelta(
                                    seconds=self.policy["repair"][
                                        "claim_ttl_seconds"
                                    ]
                                )
                            ),
                            "terminal_reason": "",
                        }
                    )
                    updated = validate_repair(updated)
                else:
                    raise ContractError("recovered Copilot task state is unsupported")
                latest = self.store.update_comment(comment, render_repair(updated))
                records[index] = (latest, updated)
                if updated["task_id"]:
                    known_task_ids.add(updated["task_id"])
                reconciled.append(
                    {
                        "issue_number": issue_number,
                        "repair_generation": updated["generation"],
                        "phase": updated["phase"],
                        "task_id": updated["task_id"],
                    }
                )
        return reconciled

    def resolve_completed(self) -> dict[str, Any]:
        all_issues = (
            self.store.list_all_incidents()
            if hasattr(self.store, "list_all_incidents")
            else self.store.list_incidents()
        )
        resolved_repairs: list[dict[str, Any]] = []
        failed_repairs: list[dict[str, Any]] = []
        for issue in all_issues:
            if issue.get("pull_request"):
                continue
            incident = parse_incident(issue.get("body"))
            for comment in self.store.list_comments(incident["issue_number"]):
                body = comment.get("body")
                if not isinstance(body, str) or REPAIR_MARKER not in body:
                    continue
                repair = parse_repair(body)
                if repair["phase"] != "validating":
                    continue
                now = self.now()
                if issue.get("state") == "closed" and incident["status"] == "resolved":
                    repair = transition_repair(
                        repair,
                        "resolved",
                        now=now,
                        ttl_seconds=self.policy["repair"]["claim_ttl_seconds"],
                        updates={"terminal_reason": "three-healthy-observations"},
                    )
                    self.store.update_comment(comment, render_repair(repair))
                    resolved_repairs.append(
                        {
                            "issue_number": repair["incident_issue"],
                            "repair_generation": repair["generation"],
                        }
                    )
                elif parse_timestamp(
                    repair["expires_at"], "repair expires_at"
                ) <= now:
                    repair = transition_repair(
                        repair,
                        "failed",
                        now=now,
                        ttl_seconds=300,
                        updates={"terminal_reason": "post-deploy-validation-expired"},
                    )
                    self.store.update_comment(comment, render_repair(repair))
                    failed_repairs.append(
                        {
                            "issue_number": repair["incident_issue"],
                            "repair_generation": repair["generation"],
                        }
                    )
        return {
            "schema": "betstan.production-repair-resolution.v1",
            "resolved": resolved_repairs,
            "failed": failed_repairs,
        }

    def dispatch(self) -> dict[str, Any]:
        issues = self.store.list_incidents()
        repairs_by_issue, active_repairs = self._repairs(issues)
        incidents_by_issue = {
            incident["issue_number"]: incident
            for issue in issues
            if not issue.get("pull_request")
            for incident in [parse_incident(issue.get("body"))]
        }
        now = self.now()
        reconciled = self._reconcile_claimed_repairs(
            repairs_by_issue,
            now=now,
        )
        reconciled.extend(self._reconcile_coding_repairs(
            repairs_by_issue,
            incidents_by_issue,
            now=now,
        ))
        reconciled.extend(
            self._reconcile_incident_generations(
                issues,
                repairs_by_issue,
                incidents_by_issue,
            )
        )
        active_repairs = [
            repair
            for records in repairs_by_issue.values()
            for _comment, repair in records
            if repair["phase"] not in TERMINAL_PHASES
        ]
        base_sha = self.store.dev_sha()
        if not SHA.fullmatch(base_sha):
            raise ContractError("dev branch SHA is malformed")
        if not self.store.can_assign_copilot():
            raise ContractError("Copilot is not assignable in this repository")

        dispatched: list[dict[str, Any]] = []
        for issue in sorted(issues, key=lambda item: int(item.get("number", 0))):
            if issue.get("state") != "open" or issue.get("pull_request"):
                continue
            incident = parse_incident(issue.get("body"))
            if incident["status"] not in {"confirmed", "repairing"}:
                continue
            anomaly = self.policy["anomalies"].get(incident["code"])
            service = self.policy["services"].get(incident["service"])
            prior = repairs_by_issue.get(incident["issue_number"], [])
            self_heal_failed = any(
                repair["self_heal_attempted"] and repair["phase"] == "failed"
                for _comment, repair in prior
            )
            if (
                not isinstance(anomaly, dict)
                or (
                    anomaly["automation"] != "code-repair"
                    and not (
                        anomaly["automation"] == "self-heal"
                        and self_heal_failed
                    )
                )
                or not self.policy["runbooks"]["code-repair"]["enabled"]
                or not isinstance(service, dict)
                or not service["paths"]
            ):
                continue
            if any(
                repair["phase"] not in TERMINAL_PHASES
                for _comment, repair in prior
            ):
                continue
            if len(prior) >= self.policy["repair"]["maximum_attempts"]:
                continue
            if incident["repair_generation"] != len(prior):
                raise ContractError("incident repair generation differs from its comments")
            if any(
                _paths_overlap(service["paths"], repair["owned_paths"])
                for repair in active_repairs
            ):
                continue

            repair = new_repair(
                incident,
                owner="copilot-swe-agent",
                base_sha=base_sha,
                owned_paths=service["paths"],
                now=now,
                ttl_seconds=self.policy["repair"]["claim_ttl_seconds"],
            )
            comment = self.store.create_comment(
                incident["issue_number"], render_repair(repair)
            )
            updated_incident = dict(incident)
            updated_incident.update(
                {
                    "status": "repairing",
                    "repair_generation": repair["generation"],
                    "generation": incident["generation"] + 1,
                }
            )
            updated_incident = validate_incident(updated_incident)
            try:
                issue = self.store.update_incident(issue, updated_incident)
                task_id = self.store.assign_copilot(
                    incident["issue_number"],
                    base_branch=self.policy["repair"]["base_branch"],
                    custom_instructions=_instructions(
                        incident["issue_number"],
                        updated_incident,
                        repair,
                        self.policy,
                    ),
                    custom_agent=service["agent"],
                )
                repair = transition_repair(
                    repair,
                    "coding",
                    now=now,
                    ttl_seconds=self.policy["repair"]["claim_ttl_seconds"],
                    updates={
                        "attempts": repair["attempts"] + 1,
                        "task_id": task_id,
                        "terminal_reason": "" if task_id else "task-id-pending",
                    },
                )
                comment = self.store.update_comment(comment, render_repair(repair))
            except (ContractError, OSError):
                try:
                    failed = transition_repair(
                        repair,
                        "failed",
                        now=now,
                        ttl_seconds=self.policy["repair"]["claim_ttl_seconds"],
                        updates={
                            "attempts": repair["attempts"] + 1,
                            "terminal_reason": "copilot-assignment-failed",
                        },
                    )
                    self.store.update_comment(comment, render_repair(failed))
                except (ContractError, OSError) as finalization_error:
                    raise ContractError(
                        "Copilot assignment failed and the repair claim "
                        "could not be finalized"
                    ) from finalization_error
                raise
            active_repairs.append(repair)
            repairs_by_issue.setdefault(incident["issue_number"], []).append(
                (comment, repair)
            )
            dispatched.append(
                {
                    "issue_number": incident["issue_number"],
                    "fingerprint": incident["fingerprint"],
                    "service": incident["service"],
                    "code": incident["code"],
                    "repair_generation": repair["generation"],
                    "base_sha": base_sha,
                    "phase": repair["phase"],
                }
            )
            if not repair["task_id"]:
                break
        return {
            "schema": "betstan.production-repair-dispatch.v1",
            "dispatched": dispatched,
            "reconciled": reconciled,
        }

    def reconcile(self) -> dict[str, Any]:
        resolution = self.resolve_completed()
        result = self.dispatch()
        result["resolved"] = resolution["resolved"]
        return result


class GitHubRepairStore:
    def __init__(self, repository: str, token: str):
        self.repository = repository
        self.token = token

    def _request(
        self,
        path: str,
        *,
        method: str = "GET",
        payload: dict[str, Any] | None = None,
        expected: set[int] = {200},
        api_version: str = "2022-11-28",
    ) -> tuple[int, Any]:
        encoded = (
            canonical_json(payload).encode("utf-8") if payload is not None else None
        )
        request = urllib.request.Request(
            f"https://api.github.com/{path.lstrip('/')}",
            data=encoded,
            method=method,
            headers={
                "Accept": "application/vnd.github+json",
                "Authorization": f"Bearer {self.token}",
                "Content-Type": "application/json",
                "User-Agent": "betstan-production-monitor-controller/1",
                "X-GitHub-Api-Version": api_version,
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                raw = response.read(MAX_RESPONSE_BYTES + 1)
                status = response.status
        except urllib.error.HTTPError as error:
            status = error.code
            raw = error.read(MAX_RESPONSE_BYTES + 1)
        except OSError as error:
            raise ContractError("GitHub controller request failed") from error
        if len(raw) > MAX_RESPONSE_BYTES:
            raise ContractError("GitHub controller response exceeded its limit")
        if status not in expected:
            raise ContractError(f"GitHub controller request returned HTTP {status}")
        if not raw:
            return status, None
        try:
            return status, json.loads(raw)
        except json.JSONDecodeError as error:
            raise ContractError("GitHub controller response is malformed") from error

    def list_incidents(self) -> list[dict[str, Any]]:
        return self._paged_issues("open")

    def list_all_incidents(self) -> list[dict[str, Any]]:
        return self._paged_issues("all")

    def _paged_issues(self, state: str) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []
        for page in range(1, MAX_MANAGED_PAGES + 1):
            _status, payload = self._request(
                f"repos/{self.repository}/issues"
                f"?state={state}&labels={urllib.parse.quote(INCIDENT_LABEL)}"
                f"&per_page={PAGE_SIZE}&page={page}"
            )
            if not isinstance(payload, list) or len(payload) > PAGE_SIZE:
                raise ContractError("GitHub incident list is malformed")
            result.extend(payload)
            if len(payload) < PAGE_SIZE:
                return result
        raise ContractError("GitHub incident query exceeded its bounded page limit")

    def list_comments(self, issue_number: int) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []
        for page in range(1, MAX_MANAGED_PAGES + 1):
            _status, payload = self._request(
                f"repos/{self.repository}/issues/{issue_number}/comments"
                f"?per_page={PAGE_SIZE}&page={page}"
            )
            if not isinstance(payload, list) or len(payload) > PAGE_SIZE:
                raise ContractError("GitHub repair comment list is malformed")
            result.extend(payload)
            if len(payload) < PAGE_SIZE:
                return result
        raise ContractError("GitHub repair comment query exceeded its bounded page limit")

    def get_issue(self, issue_number: int) -> dict[str, Any]:
        _status, payload = self._request(
            f"repos/{self.repository}/issues/{issue_number}"
        )
        if not isinstance(payload, dict):
            raise ContractError("GitHub incident response is malformed")
        return payload

    def dev_sha(self) -> str:
        _status, payload = self._request(
            f"repos/{self.repository}/git/ref/heads/dev"
        )
        value = payload.get("object", {}).get("sha") if isinstance(payload, dict) else None
        if not isinstance(value, str):
            raise ContractError("GitHub dev ref response is malformed")
        return value

    def master_sha(self) -> str:
        _status, payload = self._request(
            f"repos/{self.repository}/git/ref/heads/master"
        )
        value = payload.get("object", {}).get("sha") if isinstance(payload, dict) else None
        if not isinstance(value, str) or not SHA.fullmatch(value):
            raise ContractError("GitHub master ref response is malformed")
        return value

    def dispatch_self_heal(
        self,
        *,
        issue_number: int,
        incident_fingerprint: str,
        repair_generation: int,
        repair_id: str,
        service: str,
        target_sha: str,
    ) -> None:
        self._request(
            f"repos/{self.repository}/actions/workflows/"
            "oci-production-self-heal.yml/dispatches",
            method="POST",
            payload={
                "ref": "master",
                "inputs": {
                    "issue_number": str(issue_number),
                    "incident_fingerprint": incident_fingerprint,
                    "repair_generation": str(repair_generation),
                    "repair_id": repair_id,
                    "service": service,
                    "target_sha": target_sha,
                },
            },
            expected={204},
        )

    def self_heal_run(
        self,
        *,
        issue_number: int,
        repair_generation: int,
        control_sha: str,
    ) -> dict[str, Any] | None:
        _status, payload = self._request(
            f"repos/{self.repository}/actions/workflows/"
            "oci-production-self-heal.yml/runs"
            "?branch=master&event=workflow_dispatch&per_page=20"
        )
        runs = payload.get("workflow_runs") if isinstance(payload, dict) else None
        if not isinstance(runs, list) or len(runs) > 20:
            raise ContractError("GitHub self-heal run list is malformed")
        title = f"oci-self-heal issue-{issue_number} repair-{repair_generation}"
        matches = [
            run
            for run in runs
            if isinstance(run, dict)
            and run.get("path") == ".github/workflows/oci-production-self-heal.yml"
            and run.get("event") == "workflow_dispatch"
            and run.get("head_branch") == "master"
            and run.get("head_sha") == control_sha
            and run.get("run_attempt") == 1
            and run.get("display_title") == title
        ]
        if len(matches) > 1:
            raise ContractError("multiple self-heal runs match one repair")
        return matches[0] if matches else None

    def can_assign_copilot(self) -> bool:
        login = urllib.parse.quote(COPILOT_LOGIN, safe="")
        status, _payload = self._request(
            f"repos/{self.repository}/assignees/{login}",
            expected={204, 404},
        )
        return status == 204

    def create_comment(self, issue_number: int, body: str) -> dict[str, Any]:
        _status, payload = self._request(
            f"repos/{self.repository}/issues/{issue_number}/comments",
            method="POST",
            payload={"body": body},
            expected={201},
        )
        if not isinstance(payload, dict):
            raise ContractError("created repair comment is malformed")
        return payload

    def update_comment(self, comment: dict[str, Any], body: str) -> dict[str, Any]:
        comment_id = comment.get("id")
        _status, latest = self._request(
            f"repos/{self.repository}/issues/comments/{comment_id}"
        )
        if (
            not isinstance(latest, dict)
            or latest.get("updated_at") != comment.get("updated_at")
            or latest.get("body") != comment.get("body")
        ):
            raise ContractError("repair comment changed during compare-and-update")
        _status, payload = self._request(
            f"repos/{self.repository}/issues/comments/{comment_id}",
            method="PATCH",
            payload={"body": body},
        )
        if not isinstance(payload, dict):
            raise ContractError("updated repair comment is malformed")
        return payload

    def update_incident(
        self,
        issue: dict[str, Any],
        incident: dict[str, Any],
    ) -> dict[str, Any]:
        number = issue.get("number")
        _status, latest = self._request(
            f"repos/{self.repository}/issues/{number}"
        )
        if (
            not isinstance(latest, dict)
            or latest.get("updated_at") != issue.get("updated_at")
            or latest.get("body") != issue.get("body")
        ):
            raise ContractError("incident changed during repair claim")
        _status, payload = self._request(
            f"repos/{self.repository}/issues/{number}",
            method="PATCH",
            payload={
                "title": incident_title(incident),
                "body": render_incident(incident, None),
            },
        )
        if not isinstance(payload, dict):
            raise ContractError("updated incident is malformed")
        return payload

    def assign_copilot(
        self,
        issue_number: int,
        *,
        base_branch: str,
        custom_instructions: str,
        custom_agent: str,
    ) -> str:
        before = self._tasks()
        before_ids = {
            task["id"]
            for task in before
            if isinstance(task, dict) and isinstance(task.get("id"), str)
        }
        _status, payload = self._request(
            f"repos/{self.repository}/issues/{issue_number}/assignees",
            method="POST",
            payload={
                "assignees": [COPILOT_LOGIN],
                "agent_assignment": {
                    "target_repo": self.repository,
                    "base_branch": base_branch,
                    "custom_instructions": custom_instructions,
                    "custom_agent": custom_agent,
                },
            },
            expected={201},
        )
        assignees = payload.get("assignees") if isinstance(payload, dict) else None
        if not isinstance(assignees, list) or COPILOT_LOGIN not in {
            item.get("login") for item in assignees if isinstance(item, dict)
        }:
            raise ContractError("Copilot assignment was not confirmed")
        for _attempt in range(5):
            try:
                candidates = [
                    task
                    for task in self._tasks()
                    if isinstance(task.get("id"), str)
                    and task["id"] not in before_ids
                    and task.get("state")
                    in {
                        "queued",
                        "in_progress",
                        "idle",
                        "waiting_for_user",
                        "completed",
                    }
                ]
            except ContractError:
                candidates = []
                break
            if len(candidates) == 1:
                return candidates[0]["id"]
            if len(candidates) > 1:
                break
            time.sleep(2)
        print(
            "production_repair_controller=WAITING reason=task-id-not-yet-visible",
            file=sys.stderr,
        )
        return ""

    def find_copilot_task(
        self,
        issue_number: int,
        *,
        base_branch: str,
        owned_paths: list[str],
        custom_agent: str,
        not_before: dt.datetime,
        excluded_ids: set[str],
    ) -> dict[str, Any] | None:
        matches = []
        for task in self._tasks():
            if not isinstance(task, dict):
                continue
            task_id = task.get("id")
            created_at = task.get("created_at")
            if (
                not isinstance(task_id, str)
                or not task_id
                or task_id in excluded_ids
                or parse_timestamp(created_at, "Copilot task created_at") < not_before
            ):
                continue
            agent = task.get("custom_agent")
            if not isinstance(agent, dict) or agent.get("id") != custom_agent:
                continue
            artifacts = task.get("artifacts")
            if not isinstance(artifacts, list):
                raise ContractError("Copilot task artifacts are malformed")
            branches = [
                artifact.get("data", {})
                for artifact in artifacts
                if isinstance(artifact, dict) and artifact.get("type") == "branch"
            ]
            pull_ids = [
                artifact.get("data", {}).get("id")
                for artifact in artifacts
                if isinstance(artifact, dict) and artifact.get("type") == "pull"
            ]
            if (
                len(branches) != 1
                or branches[0].get("base_ref") != base_branch
                or len(pull_ids) != 1
                or isinstance(pull_ids[0], bool)
                or not isinstance(pull_ids[0], int)
            ):
                continue
            _status, pull = self._request(
                f"repos/{self.repository}/pulls/{pull_ids[0]}"
            )
            if (
                not isinstance(pull, dict)
                or pull.get("base", {}).get("ref") != base_branch
                or pull.get("head", {}).get("ref") != branches[0].get("head_ref")
                or pull.get("head", {}).get("repo", {}).get("full_name")
                != self.repository
            ):
                continue
            _status, files = self._request(
                f"repos/{self.repository}/pulls/{pull_ids[0]}/files?per_page=100"
            )
            if (
                not isinstance(files, list)
                or not files
                or len(files) >= 100
                or any(
                    not isinstance(item, dict)
                    or not isinstance(item.get("filename"), str)
                    or not any(
                        fnmatch.fnmatchcase(item["filename"], pattern)
                        for pattern in owned_paths
                    )
                    for item in files
                )
            ):
                continue
            matches.append(task)
        if len(matches) > 1:
            raise ContractError("multiple delayed Copilot tasks match one repair")
        return matches[0] if matches else None

    def copilot_task(self, task_id: str) -> dict[str, Any]:
        encoded = urllib.parse.quote(task_id, safe="")
        _status, payload = self._request(
            f"agents/repos/{self.repository}/tasks/{encoded}",
            api_version="2026-03-10",
        )
        if not isinstance(payload, dict) or payload.get("id") != task_id:
            raise ContractError("Copilot task response is malformed")
        return payload

    def _tasks(self) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []
        for page in range(1, MAX_MANAGED_PAGES + 1):
            _status, payload = self._request(
                f"agents/repos/{self.repository}/tasks"
                f"?per_page={PAGE_SIZE}&page={page}"
                "&sort=created_at&direction=desc",
                api_version="2026-03-10",
            )
            tasks = payload.get("tasks") if isinstance(payload, dict) else None
            if not isinstance(tasks, list) or len(tasks) > PAGE_SIZE:
                raise ContractError("Copilot task list is malformed")
            result.extend(tasks)
            if len(tasks) < PAGE_SIZE:
                return result
        raise ContractError("Copilot task query exceeded its bounded page limit")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repository", required=True)
    parser.add_argument("--policy", required=True)
    parser.add_argument("--mode", choices=("dispatch", "resolve"), default="dispatch")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    token_name = "COPILOT_AGENT_TOKEN" if args.mode == "dispatch" else "GITHUB_TOKEN"
    token = os.environ.get(token_name, "")
    if not token or len(token) > 500:
        print("production_repair_controller=FAIL reason=token-unavailable", file=sys.stderr)
        return 1
    try:
        controller = RepairController(
            GitHubRepairStore(args.repository, token),
            load_policy(Path(args.policy)),
        )
        result = (
            controller.dispatch()
            if args.mode == "dispatch"
            else controller.resolve_completed()
        )
        Path(args.output).write_text(canonical_json(result) + "\n", encoding="utf-8")
    except (ContractError, OSError, ValueError) as error:
        print(f"production_repair_controller=FAIL reason={error}", file=sys.stderr)
        return 1
    values = result["dispatched"] if args.mode == "dispatch" else result["resolved"]
    print(f"production_repair_controller=PASS mode={args.mode} count={len(values)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
