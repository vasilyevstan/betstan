#!/usr/bin/env python3

import copy
import datetime as dt
import unittest
from typing import Any

from contracts import ACTIVE_RELEASE_SCHEMA, ENVIRONMENT, OBSERVATION_SCHEMA, document_sha256, load_policy, timestamp
from publisher import GitHubIssueStore, INCIDENT_LABEL, IncidentPublisher, parse_incident, render_incident


NOW = dt.datetime(2026, 9, 1, 12, 0, tzinfo=dt.timezone.utc)
SHA = "a" * 40
IMAGE_DIGESTS = {
    service: "sha256:" + "b" * 64
    for service in (
        "auth",
        "backoffice",
        "bet",
        "client",
        "event",
        "gamemaster",
        "moderation",
        "resulting",
        "slip",
    )
}
POLICY = load_policy(__import__("pathlib").Path(__file__).with_name("policy-v1.json"))


class MemoryStore:
    def __init__(self):
        self.issues: dict[int, dict[str, Any]] = {}
        self.comments: list[tuple[int, str]] = []
        self.labels: dict[str, tuple[str, str]] = {}
        self.next_number = 10
        self.clock = 1

    def ensure_label(self, name, color, description):
        self.labels[name] = (color, description)

    def list_incidents(self):
        return [copy.deepcopy(issue) for issue in self.issues.values()]

    def create_issue(self, title, body, labels):
        number = self.next_number
        self.next_number += 1
        issue = {
            "number": number,
            "title": title,
            "body": body,
            "labels": labels,
            "state": "open",
            "updated_at": str(self.clock),
        }
        self.clock += 1
        self.issues[number] = issue
        return copy.deepcopy(issue)

    def update_issue(self, issue, *, title, body, state=None):
        current = self.issues[issue["number"]]
        if current["updated_at"] != issue["updated_at"] or current["body"] != issue["body"]:
            raise RuntimeError("CAS conflict")
        current["title"] = title
        current["body"] = body
        if state:
            current["state"] = state
        current["updated_at"] = str(self.clock)
        self.clock += 1
        return copy.deepcopy(current)

    def comment(self, number, body):
        self.comments.append((number, body))


def observation(run_id, minutes, failing=False, unknown=False):
    anomaly = {
        "code": "public-home-failed" if not unknown else "monitor-unknown",
        "service": "client" if not unknown else "platform",
        "severity": "high",
        "classification": "anomaly" if not unknown else "unknown",
        "message": "bounded public probe failed" if not unknown else "monitor data unavailable",
        "evidence": {"status": 503} if not unknown else {"reason": "timeout"},
    }
    anomalies = [anomaly] if failing or unknown else []
    status = "anomalous" if failing else "unknown" if unknown else "healthy"
    return {
        "schema": OBSERVATION_SCHEMA,
        "environment": ENVIRONMENT,
        "observed_at": timestamp(NOW + dt.timedelta(minutes=minutes)),
        "monitor_run_id": run_id,
        "monitor_run_attempt": 1,
        "source_sha": SHA,
        "status": status,
        "baseline_status": "warming",
        "active_release": {
            "schema": ACTIVE_RELEASE_SCHEMA,
            "environment": ENVIRONMENT,
            "generation": 1,
            "source_sha": SHA,
            "workflow_path": ".github/workflows/oci-production-deploy.yml",
            "run_id": 1,
            "run_attempt": 1,
            "infrastructure_run_id": 9,
            "image_digests": IMAGE_DIGESTS,
            "infrastructure_fingerprint_sha256": "c" * 64,
            "validated_at": timestamp(NOW),
            "state": "active",
        },
        "production_operation": None,
        "activity": {
            "classification": "idle",
            "workflow_path": "",
            "run_id": 0,
            "run_attempt": 0,
            "control_sha": "",
            "target_sha": "",
            "phase": "",
            "repair_id": "",
            "expected_transient_codes": [],
        },
        "public": {"checks": []},
        "deep": {"available": True},
        "anomalies": anomalies,
    }


class PublisherTest(unittest.TestCase):
    def setUp(self):
        self.store = MemoryStore()
        self.publisher = IncidentPublisher(self.store, POLICY)

    def test_first_failure_does_not_open_issue(self):
        result = self.publisher.reconcile(observation(2, 15, failing=True), previous=None)
        self.assertEqual([], result["confirmed"])
        self.assertEqual({}, self.store.issues)

    def test_second_failure_opens_one_confirmed_issue(self):
        first = observation(1, 0, failing=True)
        second = observation(2, 15, failing=True)
        result = self.publisher.reconcile(second, previous=first)
        self.assertEqual(1, len(result["confirmed"]))
        self.assertEqual(1, len(self.store.issues))
        incident = parse_incident(self.store.issues[10]["body"])
        self.assertEqual("confirmed", incident["status"])
        self.assertEqual(2, incident["failure_count"])

    def test_overlapping_publication_updates_one_issue(self):
        first = observation(1, 0, failing=True)
        second = observation(2, 15, failing=True)
        self.publisher.reconcile(second, previous=first)
        third = observation(3, 30, failing=True)
        self.publisher.reconcile(third, previous=second)
        self.assertEqual(1, len(self.store.issues))
        self.assertEqual(3, parse_incident(self.store.issues[10]["body"])["failure_count"])

    def test_three_healthy_observations_close_issue(self):
        first = observation(1, 0, failing=True)
        second = observation(2, 15, failing=True)
        self.publisher.reconcile(second, previous=first)
        for index in range(3):
            self.publisher.reconcile(observation(3 + index, 30 + index * 15))
        self.assertEqual("closed", self.store.issues[10]["state"])
        self.assertEqual("resolved", parse_incident(self.store.issues[10]["body"])["status"])

    def test_unknown_does_not_resolve_incident(self):
        first = observation(1, 0, failing=True)
        second = observation(2, 15, failing=True)
        self.publisher.reconcile(second, previous=first)
        self.publisher.reconcile(observation(3, 30, unknown=True), previous=second)
        self.assertEqual("open", self.store.issues[10]["state"])
        self.assertEqual(0, parse_incident(self.store.issues[10]["body"])["healthy_count"])

    def test_unrelated_known_anomaly_does_not_block_recovery(self):
        first = observation(1, 0, failing=True)
        second = observation(2, 15, failing=True)
        self.publisher.reconcile(second, previous=first)
        for index in range(3):
            other = observation(3 + index, 30 + index * 15)
            other["status"] = "anomalous"
            other["anomalies"] = [
                {
                    "code": "rabbitmq-backlog",
                    "service": "platform",
                    "severity": "high",
                    "classification": "anomaly",
                    "message": "bounded queue backlog",
                    "evidence": {"backlog": 1},
                }
            ]
            self.publisher.reconcile(other)
        self.assertEqual("closed", self.store.issues[10]["state"])
        self.assertEqual(
            "resolved", parse_incident(self.store.issues[10]["body"])["status"]
        )

    def test_tampered_payload_fails_closed(self):
        first = observation(1, 0, failing=True)
        second = observation(2, 15, failing=True)
        self.publisher.reconcile(second, previous=first)
        self.store.issues[10]["body"] += "\n<!-- betstan-production-incident-v1\n{}\n-->\n"
        with self.assertRaises(Exception):
            self.publisher.reconcile(observation(3, 30, failing=True), previous=second)

    def test_recovers_issue_created_before_identity_patch(self):
        first = observation(1, 0, failing=True)
        second = observation(2, 15, failing=True)
        self.publisher.reconcile(second, previous=first)
        pending = parse_incident(self.store.issues[10]["body"])
        pending["issue_number"] = 0
        self.store.issues[10]["body"] = render_incident(pending, None)
        self.publisher.reconcile(observation(3, 30, failing=True), previous=second)
        recovered = parse_incident(self.store.issues[10]["body"])
        self.assertEqual(10, recovered["issue_number"])
        self.assertEqual(3, recovered["failure_count"])

    def test_github_store_pages_beyond_first_hundred_incidents(self):
        class PagedStore(GitHubIssueStore):
            def __init__(self):
                super().__init__("vasilyevstan/betstan")
                self.pages = []

            def _api(self, path, **_options):
                page = int(path.rsplit("page=", 1)[1])
                self.pages.append(page)
                return [{"number": page * 100 + index} for index in range(100 if page == 1 else 1)]

        store = PagedStore()
        self.assertEqual(101, len(store.list_incidents()))
        self.assertEqual([1, 2], store.pages)


if __name__ == "__main__":
    unittest.main()
