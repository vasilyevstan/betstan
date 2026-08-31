#!/usr/bin/env python3

import copy
import datetime as dt
import unittest

from contracts import (
    ENVIRONMENT,
    INCIDENT_SCHEMA,
    ContractError,
    anomaly_key,
    incident_fingerprint,
    load_policy,
    parse_timestamp,
    timestamp,
)
from publisher import render_incident
from repair_controller import GitHubRepairStore, RepairController, parse_incident, parse_repair, render_repair
from state_machine import new_repair, transition_repair


NOW = dt.datetime(2026, 9, 1, 12, 0, tzinfo=dt.timezone.utc)
POLICY = load_policy(__import__("pathlib").Path(__file__).with_name("policy-v1.json"))


def incident():
    key = anomaly_key("client", "public-home-failed")
    document = {
        "schema": INCIDENT_SCHEMA,
        "environment": ENVIRONMENT,
        "issue_number": 10,
        "anomaly_key": key,
        "fingerprint": incident_fingerprint(key, 1),
        "episode": 1,
        "service": "client",
        "code": "public-home-failed",
        "severity": "high",
        "status": "confirmed",
        "failure_count": 2,
        "healthy_count": 0,
        "total_observations": 2,
        "first_seen": timestamp(NOW),
        "last_seen": timestamp(NOW + dt.timedelta(minutes=15)),
        "last_monitor_run_id": 2,
        "last_observation_sha256": "b" * 64,
        "active_release_sha": "c" * 40,
        "generation": 2,
        "repair_generation": 0,
    }
    return document


class MemoryStore:
    def __init__(self):
        value = incident()
        self.issues = [
            {
                "number": 10,
                "state": "open",
                "body": render_incident(value, None),
                "updated_at": "1",
            }
        ]
        self.comments = []
        self.assignments = []
        self.assignment_task_id = "task-1"
        self.delayed_task = None
        self.clock = 2

    def list_incidents(self):
        return copy.deepcopy(
            [issue for issue in self.issues if issue["state"] == "open"]
        )

    def list_all_incidents(self):
        return copy.deepcopy(self.issues)

    def list_comments(self, issue_number):
        return copy.deepcopy(self.comments)

    def dev_sha(self):
        return "c" * 40

    def can_assign_copilot(self):
        return True

    def create_comment(self, issue_number, body):
        comment = {
            "id": len(self.comments) + 100,
            "body": body,
            "updated_at": str(self.clock),
        }
        self.clock += 1
        self.comments.append(comment)
        return copy.deepcopy(comment)

    def update_comment(self, comment, body):
        current = next(item for item in self.comments if item["id"] == comment["id"])
        self.assert_cas(current, comment)
        current["body"] = body
        current["updated_at"] = str(self.clock)
        self.clock += 1
        return copy.deepcopy(current)

    def update_incident(self, issue, updated):
        current = self.issues[0]
        self.assert_cas(current, issue)
        current["body"] = render_incident(updated, None)
        current["updated_at"] = str(self.clock)
        self.clock += 1
        return copy.deepcopy(current)

    def assign_copilot(self, issue_number, **options):
        self.assignments.append((issue_number, options))
        return self.assignment_task_id

    def find_copilot_task(self, issue_number, **_options):
        if self.delayed_task is None:
            return None
        if issue_number != 10:
            raise AssertionError(issue_number)
        return copy.deepcopy(self.delayed_task)

    def copilot_task(self, task_id):
        if self.delayed_task is None or self.delayed_task["id"] != task_id:
            raise AssertionError(task_id)
        return copy.deepcopy(self.delayed_task)

    @staticmethod
    def assert_cas(current, previous):
        if (
            current["updated_at"] != previous["updated_at"]
            or current["body"] != previous["body"]
        ):
            raise RuntimeError("CAS conflict")


class TaskMatchingStore(GitHubRepairStore):
    def __init__(self, tasks, *, files=None):
        super().__init__("vasilyevstan/betstan", "token")
        self.tasks = tasks
        self.files = files or {
            task["artifacts"][1]["data"]["id"]: [{"filename": "client/src/App.js"}]
            for task in tasks
        }

    def _tasks(self):
        return copy.deepcopy(self.tasks)

    def _request(self, path, **_options):
        if "/pulls/" in path and path.endswith("/files?per_page=100"):
            pull_id = int(path.split("/pulls/", 1)[1].split("/", 1)[0])
            return 200, copy.deepcopy(self.files[pull_id])
        if "/pulls/" in path:
            pull_id = int(path.rsplit("/", 1)[1])
            task = next(
                item
                for item in self.tasks
                if item["artifacts"][1]["data"]["id"] == pull_id
            )
            branch = task["artifacts"][0]["data"]
            return 200, {
                "base": {"ref": branch["base_ref"]},
                "head": {
                    "ref": branch["head_ref"],
                    "repo": {"full_name": self.repository},
                },
            }
        raise AssertionError(path)


def delayed_task(task_id="task-delayed", *, pull_id=501, base_ref="dev", agent=None):
    return {
        "id": task_id,
        "state": "in_progress",
        "created_at": timestamp(NOW),
        "custom_agent": {
            "id": agent or "betstan-production-monitor-repair",
        },
        "artifacts": [
            {
                "type": "branch",
                "data": {
                    "head_ref": f"copilot/fix-client-{pull_id}",
                    "base_ref": base_ref,
                },
            },
            {"type": "pull", "data": {"id": pull_id}},
        ],
    }


class RepairControllerTest(unittest.TestCase):
    def test_dispatches_one_exact_copilot_repair(self):
        store = MemoryStore()
        result = RepairController(store, POLICY).reconcile()
        self.assertEqual(1, len(result["dispatched"]))
        self.assertEqual(1, len(store.assignments))
        self.assertEqual("dev", store.assignments[0][1]["base_branch"])
        self.assertEqual(
            "coding", parse_repair(store.comments[0]["body"])["phase"]
        )
        self.assertEqual(
            "task-1", parse_repair(store.comments[0]["body"])["task_id"]
        )

    def test_active_claim_prevents_duplicate_assignment(self):
        store = MemoryStore()
        controller = RepairController(store, POLICY)
        controller.reconcile()
        result = controller.reconcile()
        self.assertEqual([], result["dispatched"])
        self.assertEqual(1, len(store.assignments))

    def test_expired_unpublished_claim_is_failed_and_incident_is_reconciled(self):
        store = MemoryStore()
        claimed = new_repair(
            incident(),
            owner="copilot-swe-agent",
            base_sha=store.dev_sha(),
            owned_paths=["client/**"],
            now=NOW - dt.timedelta(hours=2),
            ttl_seconds=3600,
        )
        store.create_comment(10, render_repair(claimed))
        controller = RepairController(store, POLICY, now=lambda: NOW)
        repairs_by_issue, _active = controller._repairs(store.list_incidents())
        controller._reconcile_claimed_repairs(repairs_by_issue, now=NOW)
        incidents = {10: parse_incident(store.issues[0]["body"])}
        reconciled = controller._reconcile_incident_generations(
            store.issues,
            repairs_by_issue,
            incidents,
        )
        repaired = parse_repair(store.comments[0]["body"])
        updated_incident = parse_incident(store.issues[0]["body"])
        self.assertEqual("failed", repaired["phase"])
        self.assertEqual("copilot-claim-expired", repaired["terminal_reason"])
        self.assertEqual(1, updated_incident["repair_generation"])
        self.assertEqual("confirmed", updated_incident["status"])
        self.assertEqual(1, len(reconciled))

    def test_recovers_delayed_copilot_task_without_reassignment(self):
        store = MemoryStore()
        store.assignment_task_id = ""
        controller = RepairController(store, POLICY)
        controller.reconcile()
        self.assertEqual("", parse_repair(store.comments[0]["body"])["task_id"])
        store.delayed_task = {
            "id": "task-delayed",
            "issue_number": 10,
            "base_ref": "dev",
            "state": "in_progress",
            "created_at": timestamp(
                dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
            ),
            "artifacts": [],
        }
        result = controller.reconcile()
        self.assertEqual(1, len(result["reconciled"]))
        self.assertEqual(
            "task-delayed", parse_repair(store.comments[0]["body"])["task_id"]
        )
        self.assertEqual(1, len(store.assignments))

    def test_unresolved_delayed_task_identity_eventually_fails(self):
        store = MemoryStore()
        store.assignment_task_id = ""
        controller = RepairController(store, POLICY, now=lambda: NOW)
        controller.reconcile()
        repair = parse_repair(store.comments[0]["body"])

        first_expiry = parse_timestamp(repair["expires_at"], "repair expires_at")
        repairs_by_issue, _active = controller._repairs(store.list_incidents())
        controller._reconcile_coding_repairs(
            repairs_by_issue,
            {10: incident()},
            now=first_expiry,
        )
        pending = parse_repair(store.comments[0]["body"])
        self.assertEqual("coding", pending["phase"])
        self.assertEqual(2, pending["attempts"])
        self.assertEqual(
            "copilot-task-identity-unresolved",
            pending["terminal_reason"],
        )

        second_expiry = parse_timestamp(pending["expires_at"], "repair expires_at")
        controller._reconcile_coding_repairs(
            repairs_by_issue,
            {10: incident()},
            now=second_expiry,
        )
        failed = parse_repair(store.comments[0]["body"])
        self.assertEqual("failed", failed["phase"])
        self.assertEqual(
            "copilot-task-identity-unresolved",
            failed["terminal_reason"],
        )

    def test_delayed_task_requires_exact_base_agent_and_owned_paths(self):
        cases = (
            (delayed_task(base_ref="main"), None),
            (delayed_task(agent="another-agent"), None),
            (
                delayed_task(),
                {501: [{"filename": "backoffice/src/App.js"}]},
            ),
        )
        for task, files in cases:
            with self.subTest(task=task, files=files):
                store = TaskMatchingStore([task], files=files)
                self.assertIsNone(
                    store.find_copilot_task(
                        10,
                        base_branch="dev",
                        owned_paths=["client/**"],
                        custom_agent="betstan-production-monitor-repair",
                        not_before=NOW - dt.timedelta(minutes=1),
                        excluded_ids=set(),
                    )
                )

    def test_delayed_task_rejects_ambiguous_matches(self):
        store = TaskMatchingStore(
            [
                delayed_task("task-one", pull_id=501),
                delayed_task("task-two", pull_id=502),
            ]
        )
        with self.assertRaisesRegex(ContractError, "multiple delayed"):
            store.find_copilot_task(
                10,
                base_branch="dev",
                owned_paths=["client/**"],
                custom_agent="betstan-production-monitor-repair",
                not_before=NOW - dt.timedelta(minutes=1),
                excluded_ids=set(),
            )

    def test_expired_completed_task_without_pull_fails_repair(self):
        store = MemoryStore()
        controller = RepairController(store, POLICY)
        controller.reconcile()
        repair = parse_repair(store.comments[0]["body"])
        repair["heartbeat_at"] = timestamp(NOW - dt.timedelta(hours=1))
        repair["expires_at"] = timestamp(NOW - dt.timedelta(minutes=1))
        store.comments[0]["body"] = render_repair(repair)
        store.delayed_task = {
            "id": "task-1",
            "state": "completed",
            "artifacts": [],
        }
        repairs_by_issue, _active = controller._repairs(store.list_incidents())
        reconciled = controller._reconcile_coding_repairs(
            repairs_by_issue,
            {10: incident()},
            now=NOW,
        )
        failed = parse_repair(store.comments[0]["body"])
        self.assertEqual(1, len(reconciled))
        self.assertEqual("failed", failed["phase"])
        self.assertEqual(
            "copilot-task-completed-without-pull-request",
            failed["terminal_reason"],
        )

    def test_github_store_pages_incidents_and_comments(self):
        class PagedStore(GitHubRepairStore):
            def __init__(self):
                super().__init__("vasilyevstan/betstan", "token")
                self.requests = []

            def _request(self, path, **_options):
                self.requests.append(path)
                page = int(path.rsplit("page=", 1)[1])
                return 200, [{} for _index in range(100 if page == 1 else 1)]

        store = PagedStore()
        self.assertEqual(101, len(store.list_incidents()))
        self.assertEqual(101, len(store.list_all_incidents()))
        self.assertEqual(101, len(store.list_comments(10)))
        self.assertEqual(6, len(store.requests))

    def test_github_store_pages_copilot_tasks(self):
        class PagedStore(GitHubRepairStore):
            def __init__(self):
                super().__init__("vasilyevstan/betstan", "token")
                self.requests = []

            def _request(self, path, **_options):
                self.requests.append(path)
                page = int(path.rsplit("page=", 1)[1].split("&", 1)[0])
                return 200, {
                    "tasks": [{} for _index in range(100 if page == 1 else 1)]
                }

        store = PagedStore()
        self.assertEqual(101, len(store._tasks()))
        self.assertEqual(2, len(store.requests))

    def test_resolves_validating_repair_after_incident_closes(self):
        store = MemoryStore()
        RepairController(store, POLICY).reconcile()
        repair = parse_repair(store.comments[0]["body"])
        for phase, updates in (
            (
                "review",
                {
                    "agent_branch": "copilot/fix-client",
                    "head_sha": "d" * 40,
                    "repair_pr": 22,
                },
            ),
            ("merging", {"merge_sha": "e" * 40}),
            ("promoting", {"promotion_pr": 30, "target_sha": "f" * 40}),
            ("building", {"target_sha": "1" * 40}),
            ("deploying", {}),
            ("validating", {}),
        ):
            repair = transition_repair(
                repair,
                phase,
                now=NOW,
                ttl_seconds=3600,
                updates=updates,
            )
        store.comments[0]["body"] = render_repair(repair)
        resolved = parse_incident(store.issues[0]["body"])
        resolved.update(
            {
                "status": "resolved",
                "healthy_count": 3,
                "generation": resolved["generation"] + 1,
            }
        )
        store.issues[0]["body"] = render_incident(resolved, None)
        store.issues[0]["state"] = "closed"

        result = RepairController(store, POLICY).resolve_completed()

        self.assertEqual(1, len(result["resolved"]))
        repaired = parse_repair(store.comments[0]["body"])
        self.assertEqual("resolved", repaired["phase"])
        self.assertEqual(
            "three-healthy-observations",
            repaired["terminal_reason"],
        )

    def test_expired_post_deploy_validation_fails_visibly(self):
        store = MemoryStore()
        RepairController(store, POLICY).reconcile()
        repair = parse_repair(store.comments[0]["body"])
        for phase, updates in (
            (
                "review",
                {
                    "agent_branch": "copilot/fix-client",
                    "head_sha": "d" * 40,
                    "repair_pr": 22,
                },
            ),
            ("merging", {"merge_sha": "e" * 40}),
            ("promoting", {"promotion_pr": 30, "target_sha": "f" * 40}),
            ("building", {"target_sha": "1" * 40}),
            ("deploying", {}),
            ("validating", {}),
        ):
            repair = transition_repair(
                repair,
                phase,
                now=NOW,
                ttl_seconds=3600,
                updates=updates,
            )
        store.comments[0]["body"] = render_repair(repair)
        result = RepairController(
            store,
            POLICY,
            now=lambda: NOW + dt.timedelta(hours=2),
        ).resolve_completed()
        failed = parse_repair(store.comments[0]["body"])
        self.assertEqual([], result["resolved"])
        self.assertEqual([{"issue_number": 10, "repair_generation": 1}], result["failed"])
        self.assertEqual("failed", failed["phase"])
        self.assertEqual("post-deploy-validation-expired", failed["terminal_reason"])


if __name__ == "__main__":
    unittest.main()
