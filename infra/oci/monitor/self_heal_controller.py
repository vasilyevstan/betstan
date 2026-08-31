#!/usr/bin/env python3
"""Claim, dispatch, and reconcile one bounded stateless self-heal attempt."""

from __future__ import annotations

import argparse
import datetime as dt
import os
import sys
import time
from pathlib import Path
from typing import Any, Callable, Protocol

from contracts import ContractError, SHA, canonical_json, load_policy, parse_timestamp, validate_incident
from publisher import parse_incident
from repair_controller import (
    TERMINAL_PHASES,
    GitHubRepairStore,
    parse_repair,
    render_repair,
)
from state_machine import new_repair, transition_repair


SELF_HEAL_OWNER = "production-monitor-self-heal"


class SelfHealStore(Protocol):
    def list_all_incidents(self) -> list[dict[str, Any]]: ...

    def list_comments(self, issue_number: int) -> list[dict[str, Any]]: ...

    def master_sha(self) -> str: ...

    def create_comment(self, issue_number: int, body: str) -> dict[str, Any]: ...

    def update_comment(
        self, comment: dict[str, Any], body: str
    ) -> dict[str, Any]: ...

    def update_incident(
        self, issue: dict[str, Any], incident: dict[str, Any]
    ) -> dict[str, Any]: ...

    def dispatch_self_heal(
        self,
        *,
        issue_number: int,
        incident_fingerprint: str,
        repair_generation: int,
        repair_id: str,
        service: str,
        target_sha: str,
    ) -> None: ...

    def self_heal_run(
        self,
        *,
        issue_number: int,
        repair_generation: int,
        control_sha: str,
    ) -> dict[str, Any] | None: ...


def repair_id(issue_number: int, generation: int) -> str:
    return f"incident-{issue_number}-repair-{generation}"


class SelfHealController:
    def __init__(
        self,
        store: SelfHealStore,
        policy: dict[str, Any],
        *,
        now: Callable[[], dt.datetime] | None = None,
        sleeper: Callable[[float], None] = time.sleep,
    ):
        self.store = store
        self.policy = policy
        self.now = now or (lambda: dt.datetime.now(dt.timezone.utc).replace(microsecond=0))
        self.sleeper = sleeper

    def _discover_run(
        self,
        incident: dict[str, Any],
        repair: dict[str, Any],
        control_sha: str,
        *,
        poll: bool,
    ) -> dict[str, Any] | None:
        attempts = 5 if poll else 1
        for attempt in range(attempts):
            run = self.store.self_heal_run(
                issue_number=incident["issue_number"],
                repair_generation=repair["generation"],
                control_sha=control_sha,
            )
            if run is not None:
                return run
            if attempt + 1 < attempts:
                self.sleeper(2)
        return None

    def reconcile(self) -> dict[str, Any]:
        issues = self.store.list_all_incidents()
        master_sha = self.store.master_sha()
        if not SHA.fullmatch(master_sha):
            raise ContractError("master branch SHA is malformed")
        now = self.now()
        dispatched: list[dict[str, Any]] = []
        reconciled: list[dict[str, Any]] = []
        active_paths: set[str] = set()

        parsed: list[
            tuple[
                dict[str, Any],
                dict[str, Any],
                list[tuple[dict[str, Any], dict[str, Any]]],
            ]
        ] = []
        for issue in issues:
            incident = parse_incident(issue.get("body"))
            records: list[tuple[dict[str, Any], dict[str, Any]]] = []
            for comment in self.store.list_comments(incident["issue_number"]):
                body = comment.get("body")
                if not isinstance(body, str) or "betstan-production-repair-v1" not in body:
                    continue
                record = parse_repair(body)
                if record["incident_issue"] != incident["issue_number"]:
                    raise ContractError("repair comment belongs to another issue")
                records.append((comment, record))
                if record["phase"] not in TERMINAL_PHASES:
                    active_paths.update(record["owned_paths"])
            parsed.append((issue, incident, records))

        for issue, incident, records in parsed:
            for index, (comment, current) in enumerate(records):
                if (
                    current["owner"] != SELF_HEAL_OWNER
                    or current["phase"] in TERMINAL_PHASES
                ):
                    continue
                updated = current
                if issue.get("state") == "closed" or incident["status"] == "resolved":
                    updated = transition_repair(
                        current,
                        "resolved",
                        now=now,
                        ttl_seconds=300,
                        updates={"terminal_reason": "incident-resolved"},
                    )
                elif (
                    current["phase"] == "claimed"
                    and parse_timestamp(current["expires_at"], "repair expires_at")
                    <= now
                ):
                    updated = transition_repair(
                        current,
                        "failed",
                        now=now,
                        ttl_seconds=300,
                        updates={"terminal_reason": "self-heal-claim-expired"},
                    )
                elif current["phase"] == "self-healing":
                    run = self._discover_run(
                        incident,
                        current,
                        current["base_sha"],
                        poll=False,
                    )
                    if run is not None:
                        run_id = run.get("id")
                        status = run.get("status")
                        conclusion = run.get("conclusion")
                        if isinstance(run_id, bool) or not isinstance(run_id, int):
                            raise ContractError("self-heal run ID is malformed")
                        updates = {
                            "workflow_runs": {"self-heal": run_id},
                            "terminal_reason": "",
                        }
                        if status == "completed" and conclusion == "success":
                            updated = transition_repair(
                                current,
                                "validating",
                                now=now,
                                ttl_seconds=self.policy["repair"][
                                    "self_heal_cooldown_seconds"
                                ],
                                updates=updates,
                            )
                        elif status == "completed":
                            updated = transition_repair(
                                current,
                                "failed",
                                now=now,
                                ttl_seconds=300,
                                updates={
                                    **updates,
                                    "terminal_reason": "self-heal-workflow-failed",
                                },
                            )
                        elif status in {"queued", "in_progress", "waiting"}:
                            updated = transition_repair(
                                current,
                                "self-healing",
                                now=now,
                                ttl_seconds=self.policy["repair"][
                                    "self_heal_cooldown_seconds"
                                ],
                                updates=updates,
                            )
                        else:
                            raise ContractError("self-heal run state is unsupported")
                    elif parse_timestamp(current["expires_at"], "repair expires_at") <= now:
                        updated = transition_repair(
                            current,
                            "failed",
                            now=now,
                            ttl_seconds=300,
                            updates={"terminal_reason": "self-heal-run-not-found"},
                        )
                elif (
                    current["phase"] == "validating"
                    and parse_timestamp(current["expires_at"], "repair expires_at") <= now
                ):
                    updated = transition_repair(
                        current,
                        "failed",
                        now=now,
                        ttl_seconds=300,
                        updates={"terminal_reason": "self-heal-cooldown-expired"},
                    )
                if updated != current:
                    latest = self.store.update_comment(comment, render_repair(updated))
                    records[index] = (latest, updated)
                    reconciled.append(
                        {
                            "issue_number": incident["issue_number"],
                            "repair_generation": updated["generation"],
                            "phase": updated["phase"],
                        }
                    )
                    if updated["phase"] in TERMINAL_PHASES:
                        active_paths.difference_update(current["owned_paths"])

            expected_generation = len(records)
            if incident["repair_generation"] != expected_generation:
                last = records[-1][1] if records else None
                if (
                    incident["repair_generation"] + 1 != expected_generation
                    or not isinstance(last, dict)
                    or last["owner"] != SELF_HEAL_OWNER
                    or last["phase"] != "failed"
                    or last["terminal_reason"]
                    not in {
                        "self-heal-claim-expired",
                        "self-heal-dispatch-failed",
                    }
                    or any(
                        repair["phase"] not in TERMINAL_PHASES
                        for _comment, repair in records
                    )
                ):
                    raise ContractError(
                        "incident repair generation differs from its comments"
                    )
                updated_incident = dict(incident)
                updated_incident.update(
                    {
                        "repair_generation": expected_generation,
                        "status": "confirmed",
                        "generation": incident["generation"] + 1,
                    }
                )
                updated_incident = validate_incident(updated_incident)
                latest_issue = self.store.update_incident(issue, updated_incident)
                issue.update(latest_issue)
                incident.update(updated_incident)
                reconciled.append(
                    {
                        "issue_number": incident["issue_number"],
                        "repair_generation": expected_generation,
                        "phase": "incident-recovered",
                    }
                )

        for issue, incident, records in parsed:
            if issue.get("state") != "open" or incident["status"] not in {
                "confirmed",
                "repairing",
            }:
                continue
            anomaly = self.policy["anomalies"].get(incident["code"])
            service = self.policy["services"].get(incident["service"])
            if (
                not isinstance(anomaly, dict)
                or anomaly["automation"] != "self-heal"
                or not self.policy["runbooks"]["self-heal"]["enabled"]
                or not isinstance(service, dict)
                or service["restart_safe"] is not True
                or not service["paths"]
            ):
                continue
            if any(record["phase"] not in TERMINAL_PHASES for _comment, record in records):
                continue
            if any(record["self_heal_attempted"] for _comment, record in records):
                continue
            if active_paths.intersection(service["paths"]):
                continue
            if incident["repair_generation"] != len(records):
                raise ContractError("incident repair generation differs from its comments")
            target_sha = incident["active_release_sha"]
            if not SHA.fullmatch(target_sha):
                continue

            repair = new_repair(
                incident,
                owner=SELF_HEAL_OWNER,
                base_sha=master_sha,
                owned_paths=service["paths"],
                now=now,
                ttl_seconds=self.policy["repair"]["self_heal_cooldown_seconds"],
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
                self.store.update_incident(issue, updated_incident)
                identifier = repair_id(
                    incident["issue_number"], repair["generation"]
                )
                repair = transition_repair(
                    repair,
                    "self-healing",
                    now=now,
                    ttl_seconds=self.policy["repair"]["self_heal_cooldown_seconds"],
                    updates={
                        "attempts": repair["attempts"] + 1,
                        "self_heal_attempted": True,
                        "target_sha": target_sha,
                        "workflow_runs": {},
                        "terminal_reason": "self-heal-dispatch-pending",
                    },
                )
                comment = self.store.update_comment(comment, render_repair(repair))
                self.store.dispatch_self_heal(
                    issue_number=incident["issue_number"],
                    incident_fingerprint=incident["fingerprint"],
                    repair_generation=repair["generation"],
                    repair_id=identifier,
                    service=incident["service"],
                    target_sha=target_sha,
                )
                run = self._discover_run(
                    incident,
                    repair,
                    master_sha,
                    poll=True,
                )
                workflow_runs = (
                    {"self-heal": int(run["id"])}
                    if run is not None and isinstance(run.get("id"), int)
                    else {}
                )
                if workflow_runs:
                    repair = transition_repair(
                        repair,
                        "self-healing",
                        now=now,
                        ttl_seconds=self.policy["repair"][
                            "self_heal_cooldown_seconds"
                        ],
                        updates={
                            "workflow_runs": workflow_runs,
                            "terminal_reason": "",
                        },
                    )
                    comment = self.store.update_comment(
                        comment, render_repair(repair)
                    )
            except (ContractError, OSError):
                failed = transition_repair(
                    repair,
                    "failed",
                    now=now,
                    ttl_seconds=300,
                    updates={
                        "attempts": repair["attempts"] + 1,
                        "self_heal_attempted": True,
                        "target_sha": target_sha,
                        "terminal_reason": "self-heal-dispatch-failed",
                    },
                )
                self.store.update_comment(comment, render_repair(failed))
                raise
            active_paths.update(service["paths"])
            dispatched.append(
                {
                    "issue_number": incident["issue_number"],
                    "repair_generation": repair["generation"],
                    "repair_id": identifier,
                    "service": incident["service"],
                    "target_sha": target_sha,
                    "workflow_run_id": workflow_runs.get("self-heal", 0),
                }
            )
        return {
            "schema": "betstan.production-self-heal-dispatch.v1",
            "dispatched": dispatched,
            "reconciled": reconciled,
        }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repository", required=True)
    parser.add_argument("--policy", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    token = os.environ.get("GH_TOKEN", "")
    if not token or len(token) > 500:
        print("production_self_heal_controller=FAIL reason=token-unavailable", file=sys.stderr)
        return 1
    try:
        result = SelfHealController(
            GitHubRepairStore(args.repository, token),
            load_policy(Path(args.policy)),
        ).reconcile()
        output = Path(args.output)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(canonical_json(result) + "\n", encoding="utf-8")
    except (ContractError, OSError, ValueError) as error:
        print(f"production_self_heal_controller=FAIL reason={error}", file=sys.stderr)
        return 1
    print(
        "production_self_heal_controller=PASS "
        f"dispatched={len(result['dispatched'])} reconciled={len(result['reconciled'])}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
