#!/usr/bin/env python3
import copy
import datetime as dt
import unittest
from typing import Any

from production_work_lease_stan import (
    LEASE_LABEL,
    LeaseError,
    LeaseManager,
    parse_body,
    render_body,
)


NOW = dt.datetime(2026, 8, 27, 12, 0, tzinfo=dt.timezone.utc)
PRODUCTION_SHA = "a" * 40
HEAD_SHA = "b" * 40
FINGERPRINT = "c" * 64


class MemoryStore:
    def __init__(self) -> None:
        self.issues: dict[int, dict[str, Any]] = {}
        self.comments: list[tuple[int, str]] = []
        self.labels: dict[str, tuple[str, str]] = {}
        self.next_number = 10

    def ensure_label(self, name: str, color: str, description: str) -> None:
        self.labels[name] = (color, description)

    def list_open_by_label(self, label: str) -> list[dict[str, Any]]:
        return [
            copy.deepcopy(issue)
            for issue in self.issues.values()
            if issue["state"] == "open" and label in issue["labels"]
        ]

    def create_issue(
        self, title: str, body: str, labels: list[str]
    ) -> dict[str, Any]:
        number = self.next_number
        self.next_number += 1
        issue = {
            "number": number,
            "title": title,
            "body": body,
            "labels": labels,
            "state": "open",
        }
        self.issues[number] = issue
        return copy.deepcopy(issue)

    def update_issue(
        self, number: int, body: str, state: str | None = None
    ) -> dict[str, Any]:
        self.issues[number]["body"] = body
        if state is not None:
            self.issues[number]["state"] = state
        return copy.deepcopy(self.issues[number])

    def comment(self, number: int, body: str) -> None:
        self.comments.append((number, body))


class ProductionWorkLeaseTest(unittest.TestCase):
    def setUp(self) -> None:
        self.store = MemoryStore()
        self.manager = LeaseManager(self.store, NOW, ttl_seconds=600)

    def acquire(self):
        return self.manager.acquire(
            kind="repair",
            incident=42,
            fingerprint=FINGERPRINT,
            production_sha=PRODUCTION_SHA,
            deployment_run_id=123,
            owner_task="incident-42",
        )

    def test_acquires_and_binds_one_owner(self) -> None:
        acquired = self.acquire()
        self.assertEqual(10, acquired.document["lease_issue"])
        self.assertIn(LEASE_LABEL, self.store.labels)

        registered = self.manager.register("incident-42", "copilot/fix-42", HEAD_SHA)
        bound = self.manager.bind_pr(
            "incident-42", 99, "copilot/fix-42", HEAD_SHA
        )

        self.assertEqual("coding", registered.document["phase"])
        self.assertEqual("review", bound.document["phase"])
        self.assertEqual(99, bound.document["owner_pr"])
        self.assertEqual(
            99,
            self.manager.verify(
                {
                    "owner_task": "incident-42",
                    "owner_pr": 99,
                    "head_sha": HEAD_SHA,
                    "production_sha": PRODUCTION_SHA,
                }
            ).document["owner_pr"],
        )

    def test_rejects_duplicate_and_wrong_owner(self) -> None:
        self.acquire()
        with self.assertRaises(LeaseError):
            self.acquire()
        with self.assertRaises(LeaseError):
            self.manager.heartbeat("incident-7")

    def test_detects_tampered_and_duplicate_lease_issues(self) -> None:
        active = self.acquire()
        self.store.issues[active.document["lease_issue"]]["body"] += (
            "\n<!-- betstan-production-work-lease\n{}\n-->\n"
        )
        with self.assertRaises(LeaseError):
            self.manager.current()

        self.store.issues[active.document["lease_issue"]]["body"] = render_body(
            active.document
        )
        duplicate = copy.deepcopy(self.store.issues[10])
        duplicate["number"] = 11
        duplicate_document = parse_body(duplicate["body"])
        duplicate_document["lease_issue"] = 11
        duplicate["body"] = render_body(duplicate_document)
        self.store.issues[11] = duplicate
        with self.assertRaises(LeaseError):
            self.manager.current()

    def test_expired_lease_needs_explicit_confirmed_handoff(self) -> None:
        self.acquire()
        later = LeaseManager(
            self.store, NOW + dt.timedelta(seconds=601), ttl_seconds=600
        )
        with self.assertRaises(LeaseError):
            later.verify({"owner_task": "incident-42"})
        with self.assertRaises(LeaseError):
            later.handoff("incident-42", "conductor-1", "stale", False)

        handed_off = later.handoff(
            "incident-42",
            "conductor-1",
            "expired heartbeat and no active related work",
            True,
        )
        self.assertEqual("conductor-1", handed_off.document["owner_task"])
        self.assertEqual(0, handed_off.document["owner_pr"])
        self.assertTrue(self.store.comments)

    def test_failed_lease_blocks_automatic_handoff(self) -> None:
        self.acquire()
        self.manager.mark_failed("incident-42", "repair validation failed")
        later = LeaseManager(
            self.store, NOW + dt.timedelta(seconds=601), ttl_seconds=600
        )
        with self.assertRaises(LeaseError):
            later.handoff("incident-42", "conductor-1", "retry", True)

    def test_release_requires_validation_and_health_proof(self) -> None:
        self.acquire()
        with self.assertRaises(LeaseError):
            self.manager.release("incident-42", "run 200", True)
        self.manager.transition(
            "incident-42",
            "validation",
            repair_sha=HEAD_SHA,
            workflow_runs={"deploy": 200},
        )
        with self.assertRaises(LeaseError):
            self.manager.release("incident-42", "run 200", False)

        released = self.manager.release(
            "incident-42",
            "monitor runs 300,301,302 passed",
            True,
        )
        self.assertEqual("released", released.document["state"])
        self.assertEqual("closed", self.store.issues[10]["state"])


if __name__ == "__main__":
    unittest.main()
