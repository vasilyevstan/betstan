#!/usr/bin/env python3

import copy
import datetime as dt
import unittest

from contracts import (
    ENVIRONMENT,
    INCIDENT_SCHEMA,
    anomaly_key,
    incident_fingerprint,
    load_policy,
    timestamp,
)
from publisher import parse_incident, render_incident
from repair_controller import RepairController, parse_repair, render_repair
from self_heal_controller import SelfHealController
from state_machine import new_repair


NOW = dt.datetime(2026, 9, 1, 12, 0, tzinfo=dt.timezone.utc)
POLICY = load_policy(__import__("pathlib").Path(__file__).with_name("policy-v1.json"))
ACTIVE_RELEASE_SHA = "e" * 40


def incident():
    key = anomaly_key("client", "workload-not-ready")
    return {
        "schema": INCIDENT_SCHEMA,
        "environment": ENVIRONMENT,
        "issue_number": 20,
        "anomaly_key": key,
        "fingerprint": incident_fingerprint(key, 1),
        "episode": 1,
        "service": "client",
        "code": "workload-not-ready",
        "severity": "high",
        "status": "confirmed",
        "failure_count": 2,
        "healthy_count": 0,
        "total_observations": 2,
        "first_seen": timestamp(NOW),
        "last_seen": timestamp(NOW + dt.timedelta(minutes=15)),
        "last_monitor_run_id": 2,
        "last_observation_sha256": "b" * 64,
        "active_release_sha": ACTIVE_RELEASE_SHA,
        "generation": 2,
        "repair_generation": 0,
    }


class MemoryStore:
    def __init__(self):
        self.incident = incident()
        self.issues = [
            {
                "number": 20,
                "state": "open",
                "body": render_incident(self.incident, None),
                "updated_at": "1",
            }
        ]
        self.comments = []
        self.dispatches = []
        self.assignments = []
        self.run = None
        self.clock = 2

    def list_all_incidents(self):
        return copy.deepcopy(self.issues)

    def list_incidents(self):
        return [
            copy.deepcopy(issue)
            for issue in self.issues
            if issue["state"] == "open"
        ]

    def list_comments(self, issue_number):
        return copy.deepcopy(self.comments)

    def master_sha(self):
        return "c" * 40

    def dev_sha(self):
        return "d" * 40

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

    def dispatch_self_heal(self, **options):
        self.dispatches.append(options)
        self.run = {
            "id": 500,
            "path": ".github/workflows/oci-production-self-heal.yml",
            "event": "workflow_dispatch",
            "head_branch": "master",
            "head_sha": self.master_sha(),
            "run_attempt": 1,
            "display_title": "oci-self-heal issue-20 repair-1",
            "status": "queued",
            "conclusion": None,
        }

    def self_heal_run(self, **_options):
        return copy.deepcopy(self.run)

    def assign_copilot(self, issue_number, **options):
        self.assignments.append((issue_number, options))
        return "task-2"

    @staticmethod
    def assert_cas(current, previous):
        if (
            current["updated_at"] != previous["updated_at"]
            or current["body"] != previous["body"]
        ):
            raise RuntimeError("CAS conflict")


class SelfHealControllerTest(unittest.TestCase):
    def test_dispatches_only_one_restart_attempt(self):
        store = MemoryStore()
        controller = SelfHealController(
            store,
            POLICY,
            now=lambda: NOW,
            sleeper=lambda _seconds: None,
        )
        result = controller.reconcile()
        self.assertEqual(1, len(result["dispatched"]))
        self.assertEqual(1, len(store.dispatches))
        self.assertEqual(ACTIVE_RELEASE_SHA, store.dispatches[0]["target_sha"])
        repair = parse_repair(store.comments[0]["body"])
        self.assertEqual("self-healing", repair["phase"])
        self.assertTrue(repair["self_heal_attempted"])
        self.assertEqual(ACTIVE_RELEASE_SHA, repair["target_sha"])
        self.assertEqual({"self-heal": 500}, repair["workflow_runs"])

        controller.reconcile()
        self.assertEqual(1, len(store.dispatches))

    def test_expired_unpublished_self_heal_claim_is_reconciled(self):
        store = MemoryStore()
        claimed = new_repair(
            incident(),
            owner="production-monitor-self-heal",
            base_sha=store.master_sha(),
            owned_paths=["client/**"],
            now=NOW - dt.timedelta(hours=2),
            ttl_seconds=3600,
        )
        store.create_comment(20, render_repair(claimed))
        current_incident = parse_incident(store.issues[0]["body"])
        current_incident["active_release_sha"] = ""
        store.issues[0]["body"] = render_incident(current_incident, None)

        result = SelfHealController(
            store,
            POLICY,
            now=lambda: NOW,
            sleeper=lambda _seconds: None,
        ).reconcile()

        repaired = parse_repair(store.comments[0]["body"])
        updated_incident = parse_incident(store.issues[0]["body"])
        self.assertEqual("failed", repaired["phase"])
        self.assertEqual("self-heal-claim-expired", repaired["terminal_reason"])
        self.assertEqual(1, updated_incident["repair_generation"])
        self.assertEqual(2, len(result["reconciled"]))
        self.assertEqual([], result["dispatched"])

    def test_failed_cooldown_allows_code_repair_escalation(self):
        store = MemoryStore()
        SelfHealController(
            store,
            POLICY,
            now=lambda: NOW,
            sleeper=lambda _seconds: None,
        ).reconcile()
        store.run["status"] = "completed"
        store.run["conclusion"] = "success"
        SelfHealController(
            store,
            POLICY,
            now=lambda: NOW + dt.timedelta(minutes=15),
            sleeper=lambda _seconds: None,
        ).reconcile()
        self.assertEqual(
            "validating", parse_repair(store.comments[0]["body"])["phase"]
        )

        SelfHealController(
            store,
            POLICY,
            now=lambda: NOW + dt.timedelta(minutes=76),
            sleeper=lambda _seconds: None,
        ).reconcile()
        self.assertEqual("failed", parse_repair(store.comments[0]["body"])["phase"])

        result = RepairController(store, POLICY).reconcile()
        self.assertEqual(1, len(result["dispatched"]))
        self.assertEqual(1, len(store.assignments))
        self.assertEqual("coding", parse_repair(store.comments[1]["body"])["phase"])


if __name__ == "__main__":
    unittest.main()
