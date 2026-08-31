#!/usr/bin/env python3

import copy
import datetime as dt
import unittest

from contracts import ContractError, load_policy
from repair_controller import parse_repair, render_repair
from repair_merge import RepairMerger
from state_machine import new_repair, transition_repair
from test_repair_controller import incident


NOW = dt.datetime(2026, 9, 1, 12, 0, tzinfo=dt.timezone.utc)
POLICY = load_policy(__import__("pathlib").Path(__file__).with_name("policy-v1.json"))
BASE_SHA = "a" * 40
HEAD_SHA = "b" * 40
SNAPSHOT_SHA = "c" * 40
MERGE_SHA = "d" * 40


def review_repair():
    repair = new_repair(
        incident(),
        owner="copilot-swe-agent",
        base_sha=BASE_SHA,
        owned_paths=["client/**"],
        now=NOW,
        ttl_seconds=3600,
    )
    repair = transition_repair(
        repair,
        "coding",
        now=NOW,
        ttl_seconds=3600,
        updates={"task_id": "task-1"},
    )
    return transition_repair(
        repair,
        "review",
        now=NOW,
        ttl_seconds=3600,
        updates={
            "agent_branch": "copilot/fix-client",
            "head_sha": HEAD_SHA,
            "repair_pr": 22,
        },
    )


def policy_result():
    return {
        "schema": "betstan.production-repair-policy.v1",
        "pull_request": 22,
        "incident_issue": 10,
        "repair_generation": 1,
        "head_sha": HEAD_SHA,
        "merge_sha": SNAPSHOT_SHA,
        "files": ["client/src/app.ts"],
        "approved_runs": [],
    }


class MemoryStore:
    repository = "vasilyevstan/betstan"

    def __init__(self):
        self.pull = {
            "number": 22,
            "node_id": "PR_node",
            "state": "open",
            "draft": True,
            "head": {
                "sha": HEAD_SHA,
                "ref": "copilot/fix-client",
                "repo": {"full_name": self.repository},
            },
            "base": {"sha": BASE_SHA, "ref": "dev"},
            "merge_commit_sha": SNAPSHOT_SHA,
        }
        self.comments = [
            {"id": 100, "body": render_repair(review_repair()), "updated_at": "1"}
        ]
        self.policy_state = "success"
        self.fail_comment_update = False

    def list_comments(self, issue_number):
        self.assertEqual(issue_number, 10)
        return copy.deepcopy(self.comments)

    def update_comment(self, comment, body):
        if self.fail_comment_update:
            self.fail_comment_update = False
            raise OSError("simulated comment write failure")
        if (
            comment["id"] != self.comments[0]["id"]
            or comment["updated_at"] != self.comments[0]["updated_at"]
        ):
            raise RuntimeError("CAS conflict")
        self.comments[0]["body"] = body
        self.comments[0]["updated_at"] = "2"
        return copy.deepcopy(self.comments[0])

    def _request(self, path, *, method="GET", payload=None, expected=None):
        if path.endswith("/pulls/22") and method == "GET":
            return 200, copy.deepcopy(self.pull)
        if path.endswith(f"/commits/{HEAD_SHA}/status") or path.endswith(
            f"/commits/{SNAPSHOT_SHA}/status"
        ):
            return 200, {
                "statuses": [
                    {
                        "context": "monitor-repair-policy/dev",
                        "state": self.policy_state,
                    }
                ]
            }
        if path == "graphql" and method == "POST":
            self.pull["draft"] = False
            return 200, {"data": {"markPullRequestReadyForReview": {}}}
        if path.endswith("/pulls/22/merge") and method == "PUT":
            self.assertEqual(payload["sha"], HEAD_SHA)
            self.assertEqual(payload["merge_method"], "merge")
            self.pull["state"] = "closed"
            self.pull["merged"] = True
            self.pull["merged_at"] = "2026-09-01T12:10:00Z"
            self.pull["merge_commit_sha"] = MERGE_SHA
            return 200, {"merged": True, "sha": MERGE_SHA}
        raise AssertionError((path, method, payload, expected))

    def assertEqual(self, left, right):
        if left != right:
            raise AssertionError(f"{left!r} != {right!r}")


class RepairMergerTest(unittest.TestCase):
    def test_marks_ready_merges_exact_head_and_records_merge_sha(self):
        store = MemoryStore()
        controller = RepairMerger(store, POLICY)
        ready = controller.prepare(policy_result())
        self.assertEqual(SNAPSHOT_SHA, ready["merge_sha"])
        result = controller.merge(policy_result())
        self.assertEqual(MERGE_SHA, result["merge_sha"])
        self.assertFalse(store.pull["draft"])
        repair = parse_repair(store.comments[0]["body"])
        self.assertEqual("merging", repair["phase"])
        self.assertEqual(MERGE_SHA, repair["merge_sha"])

    def test_retry_records_an_already_merged_pull(self):
        store = MemoryStore()
        controller = RepairMerger(store, POLICY)
        controller.prepare(policy_result())
        store.fail_comment_update = True
        with self.assertRaisesRegex(OSError, "simulated"):
            controller.merge(policy_result())
        result = controller.merge(policy_result())
        self.assertEqual(MERGE_SHA, result["merge_sha"])
        self.assertEqual(
            "merging", parse_repair(store.comments[0]["body"])["phase"]
        )

    def test_rejects_missing_exact_policy_status(self):
        store = MemoryStore()
        store.policy_state = "pending"
        with self.assertRaisesRegex(
            ContractError, "repair policy status is not successful"
        ):
            RepairMerger(store, POLICY).prepare(policy_result())

    def test_rejects_pull_changed_after_policy_validation(self):
        store = MemoryStore()
        store.pull["head"]["sha"] = "e" * 40
        with self.assertRaisesRegex(
            ContractError, "changed after policy validation"
        ):
            RepairMerger(store, POLICY).prepare(policy_result())

    def test_merge_requires_prepared_non_draft_pull(self):
        store = MemoryStore()
        with self.assertRaisesRegex(ContractError, "must be ready"):
            RepairMerger(store, POLICY).merge(policy_result())


if __name__ == "__main__":
    unittest.main()
