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
from publisher import render_incident
from repair_controller import parse_repair, render_repair
from repair_policy import RepairPolicy
from state_machine import new_repair, transition_repair


NOW = dt.datetime(2026, 9, 1, 12, 0, tzinfo=dt.timezone.utc)
POLICY = load_policy(__import__("pathlib").Path(__file__).with_name("policy-v1.json"))


def records():
    key = anomaly_key("client", "public-home-failed")
    incident = {
        "schema": INCIDENT_SCHEMA,
        "environment": ENVIRONMENT,
        "issue_number": 10,
        "anomaly_key": key,
        "fingerprint": incident_fingerprint(key, 1),
        "episode": 1,
        "service": "client",
        "code": "public-home-failed",
        "severity": "high",
        "status": "repairing",
        "failure_count": 2,
        "healthy_count": 0,
        "total_observations": 2,
        "first_seen": timestamp(NOW),
        "last_seen": timestamp(NOW + dt.timedelta(minutes=15)),
        "last_monitor_run_id": 2,
        "last_observation_sha256": "b" * 64,
        "active_release_sha": "c" * 40,
        "generation": 3,
        "repair_generation": 1,
    }
    repair = new_repair(
        {**incident, "status": "confirmed", "repair_generation": 0},
        owner="copilot-swe-agent",
        base_sha="c" * 40,
        owned_paths=["client/**"],
        now=NOW,
        ttl_seconds=3600,
    )
    repair = transition_repair(
        repair,
        "coding",
        now=NOW,
        ttl_seconds=3600,
        updates={"task_id": "task-1", "attempts": 1},
    )
    return incident, repair


class MemoryPolicyStore:
    repository = "vasilyevstan/betstan"

    def __init__(self):
        incident, repair = records()
        self.issue = {
            "number": 10,
            "state": "open",
            "body": render_incident(incident, None),
            "updated_at": "1",
        }
        self.comment = {
            "id": 100,
            "body": render_repair(repair),
            "updated_at": "2",
        }
        self.statuses = []
        self.labels = []

    def list_incidents(self):
        return [copy.deepcopy(self.issue)]

    def list_comments(self, issue_number):
        return [copy.deepcopy(self.comment)]

    def update_comment(self, comment, body):
        self.comment["body"] = body
        self.comment["updated_at"] = "3"
        return copy.deepcopy(self.comment)

    def _request(self, path, *, method="GET", payload=None, expected={200}, api_version="2022-11-28"):
        if path == "repos/vasilyevstan/betstan/pulls/42":
            return 200, {
                "id": 501,
                "number": 42,
                "state": "open",
                "draft": True,
                "merge_commit_sha": "d" * 40,
                "user": {"login": "copilot-swe-agent[bot]"},
                "head": {
                    "ref": "copilot/fix-client",
                    "sha": "e" * 40,
                    "repo": {"full_name": self.repository},
                },
                "base": {"ref": "dev", "sha": "f" * 40},
            }
        if path == "agents/repos/vasilyevstan/betstan/tasks/task-1":
            return 200, {
                "id": "task-1",
                "state": "completed",
                "custom_agent": {"id": "betstan-production-monitor-repair"},
                "artifacts": [
                    {"type": "pull", "data": {"id": 501}},
                    {
                        "type": "branch",
                        "data": {
                            "head_ref": "copilot/fix-client",
                            "base_ref": "dev",
                        },
                    },
                ],
            }
        if path == "repos/vasilyevstan/betstan/pulls/42/commits?per_page=100":
            return 200, [
                {
                    "author": {"login": "copilot-swe-agent[bot]"},
                    "commit": {"verification": {"verified": True}},
                }
            ]
        if path == "repos/vasilyevstan/betstan/pulls/42/files?per_page=100":
            return 200, [{"filename": "client/src/App.js", "status": "modified"}]
        if path == f"repos/vasilyevstan/betstan/compare/{'c' * 40}...{'e' * 40}":
            return 200, {"status": "ahead"}
        if path == "repos/vasilyevstan/betstan/issues/42/labels":
            self.labels.extend(payload["labels"])
            return 200, []
        if path.startswith("repos/vasilyevstan/betstan/statuses/"):
            self.statuses.append((path.rsplit("/", 1)[1], payload))
            return 201, {}
        raise AssertionError(f"unexpected API request: {method} {path}")


class RepairPolicyTest(unittest.TestCase):
    def test_validates_exact_task_commits_and_paths(self):
        store = MemoryPolicyStore()
        result = RepairPolicy(store, POLICY, approve_actions=False).evaluate(42)
        self.assertEqual(["client/src/App.js"], result["files"])
        self.assertEqual(2, len(store.statuses))
        self.assertIn("production-monitor-repair", store.labels)

    def test_rejects_forbidden_path(self):
        store = MemoryPolicyStore()
        original = store._request

        def request(path, **kwargs):
            if path.endswith("/files?per_page=100"):
                return 200, [
                    {
                        "filename": ".github/workflows/production-build.yml",
                        "status": "modified",
                    }
                ]
            return original(path, **kwargs)

        store._request = request
        with self.assertRaisesRegex(Exception, "forbidden|outside"):
            RepairPolicy(store, POLICY, approve_actions=False).evaluate(42)

    def test_revalidates_an_already_merged_repair_pull(self):
        store = MemoryPolicyStore()
        original = store._request

        def request(path, **kwargs):
            status, payload = original(path, **kwargs)
            if path.endswith("/pulls/42"):
                payload["state"] = "closed"
                payload["merged"] = True
                payload["merged_at"] = "2026-09-01T12:10:00Z"
            return status, payload

        store._request = request
        result = RepairPolicy(store, POLICY, approve_actions=False).evaluate(42)
        self.assertEqual(42, result["pull_request"])
        self.assertEqual("review", parse_repair(store.comment["body"])["phase"])

    def test_rejects_task_from_a_different_custom_agent(self):
        store = MemoryPolicyStore()
        original = store._request

        def request(path, **kwargs):
            status, payload = original(path, **kwargs)
            if "/tasks/" in path:
                payload["custom_agent"] = {"id": "another-agent"}
            return status, payload

        store._request = request
        with self.assertRaisesRegex(Exception, "custom agent differs"):
            RepairPolicy(store, POLICY, approve_actions=False).evaluate(42)

    def test_closed_unmerged_pull_fails_the_repair(self):
        store = MemoryPolicyStore()
        original = store._request

        def request(path, **kwargs):
            status, payload = original(path, **kwargs)
            if path.endswith("/pulls/42"):
                payload["state"] = "closed"
                payload["merged"] = False
            return status, payload

        store._request = request
        with self.assertRaisesRegex(Exception, "closed without merge"):
            RepairPolicy(store, POLICY, approve_actions=False).evaluate(42)
        repair = parse_repair(store.comment["body"])
        self.assertEqual("failed", repair["phase"])
        self.assertEqual(
            "repair-pull-closed-without-merge",
            repair["terminal_reason"],
        )


if __name__ == "__main__":
    unittest.main()
