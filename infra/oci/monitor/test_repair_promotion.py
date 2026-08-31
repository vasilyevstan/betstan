#!/usr/bin/env python3

import copy
import datetime as dt
import unittest

from contracts import ContractError, load_policy
from repair_controller import parse_repair, render_repair
from repair_promotion import RepairPromotion
from state_machine import transition_repair
from test_repair_merge import HEAD_SHA, MERGE_SHA, NOW, review_repair


POLICY = load_policy(__import__("pathlib").Path(__file__).with_name("policy-v1.json"))
MASTER_SHA = "e" * 40
DEV_SHA = "f" * 40
PROMOTION_SNAPSHOT_SHA = "1" * 40
SOURCE_SHA = "2" * 40


def merging_repair():
    return transition_repair(
        review_repair(),
        "merging",
        now=NOW,
        ttl_seconds=3600,
        updates={"merge_sha": MERGE_SHA},
    )


class MemoryStore:
    repository = "vasilyevstan/betstan"

    def __init__(self):
        self.comments = [
            {"id": 100, "body": render_repair(merging_repair()), "updated_at": "1"}
        ]
        self.repair_pull = {
            "number": 22,
            "state": "closed",
            "merged": True,
            "merged_at": "2026-09-01T12:05:00Z",
            "head": {
                "ref": "copilot/fix-client",
                "sha": HEAD_SHA,
                "repo": {"full_name": self.repository},
            },
            "base": {"ref": "dev"},
            "merge_commit_sha": MERGE_SHA,
        }
        self.promotion_pull = None
        self.compare_commits = [HEAD_SHA, MERGE_SHA]
        self.statuses = []
        self.fail_body_patch = False
        self.fail_comment_update = False

    def list_incidents(self):
        return [{"number": 10}]

    def list_comments(self, issue_number):
        if issue_number != 10:
            raise AssertionError(issue_number)
        return copy.deepcopy(self.comments)

    def master_sha(self):
        return MASTER_SHA

    def dev_sha(self):
        return DEV_SHA

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
        self.comments[0]["updated_at"] = str(
            int(self.comments[0]["updated_at"]) + 1
        )
        return copy.deepcopy(self.comments[0])

    def _request(self, path, *, method="GET", payload=None, expected=None):
        if path.endswith("/pulls?state=open&base=master&head=vasilyevstan%3Adev&per_page=10"):
            return 200, (
                []
                if self.promotion_pull is None or self.promotion_pull["state"] != "open"
                else [copy.deepcopy(self.promotion_pull)]
            )
        if path.endswith("/pulls?state=closed&base=master&head=vasilyevstan%3Adev&per_page=20"):
            return 200, (
                []
                if self.promotion_pull is None or self.promotion_pull["state"] != "closed"
                else [copy.deepcopy(self.promotion_pull)]
            )
        if path.endswith("/pulls/22") and method == "GET":
            return 200, copy.deepcopy(self.repair_pull)
        if path.endswith("/pulls/22/commits?per_page=100"):
            return 200, [{"sha": HEAD_SHA}]
        if path.endswith(f"/compare/{MASTER_SHA}...{DEV_SHA}?per_page=100"):
            return 200, {
                "status": "ahead",
                "base_commit": {"sha": MASTER_SHA},
                "total_commits": len(self.compare_commits),
                "commits": [{"sha": sha} for sha in self.compare_commits],
                "files": [{"filename": "client/src/app.ts"}],
            }
        if path.endswith("/pulls") and method == "POST":
            if payload["head"] != "dev" or payload["base"] != "master":
                raise AssertionError(payload)
            self.promotion_pull = {
                "number": 30,
                "node_id": "PR_promotion",
                "state": "open",
                "draft": True,
                "body": payload["body"],
                "head": {
                    "ref": "dev",
                    "sha": DEV_SHA,
                    "repo": {"full_name": self.repository},
                },
                "base": {"ref": "master", "sha": MASTER_SHA},
                "merge_commit_sha": PROMOTION_SNAPSHOT_SHA,
            }
            return 201, {"number": 30}
        if path.endswith("/pulls/30") and method == "PATCH":
            if self.fail_body_patch:
                self.fail_body_patch = False
                raise OSError("simulated body patch failure")
            self.promotion_pull["body"] = payload["body"]
            return 200, copy.deepcopy(self.promotion_pull)
        if path.endswith("/issues/30/labels") and method == "POST":
            return 200, [{"name": payload["labels"][0]}]
        if path.endswith("/pulls/30") and method == "GET":
            return 200, copy.deepcopy(self.promotion_pull)
        if path.endswith(f"/statuses/{DEV_SHA}") or path.endswith(
            f"/statuses/{PROMOTION_SNAPSHOT_SHA}"
        ):
            self.statuses.append((path, payload))
            return 201, {}
        if path == "graphql" and method == "POST":
            self.promotion_pull["draft"] = False
            return 200, {"data": {"markPullRequestReadyForReview": {}}}
        if path.endswith("/pulls/30/merge") and method == "PUT":
            if payload["sha"] != DEV_SHA or payload["merge_method"] != "merge":
                raise AssertionError(payload)
            self.promotion_pull["state"] = "closed"
            self.promotion_pull["merged"] = True
            self.promotion_pull["merged_at"] = "2026-09-01T12:10:00Z"
            self.promotion_pull["merge_commit_sha"] = SOURCE_SHA
            return 200, {"merged": True, "sha": SOURCE_SHA}
        raise AssertionError((path, method, payload, expected))


class RepairPromotionTest(unittest.TestCase):
    def test_creates_isolated_promotion_and_binds_repair(self):
        store = MemoryStore()
        result = RepairPromotion(store, POLICY).create()
        self.assertEqual("created", result["action"])
        self.assertEqual(30, result["promotion"]["promotion_pr"])
        repair = parse_repair(store.comments[0]["body"])
        self.assertEqual("promoting", repair["phase"])
        self.assertEqual(30, repair["promotion_pr"])
        self.assertEqual(DEV_SHA, repair["target_sha"])

    def test_rejects_unrelated_dev_commit(self):
        store = MemoryStore()
        store.compare_commits.insert(0, "3" * 40)
        with self.assertRaisesRegex(
            ContractError, "dev contains commits outside the repair cohort"
        ):
            RepairPromotion(store, POLICY).create()

    def test_merges_exact_promotion_and_advances_repair_to_building(self):
        store = MemoryStore()
        RepairPromotion(store, POLICY).create()
        result = RepairPromotion(store, POLICY).merge(30)
        self.assertEqual("merged", result["action"])
        self.assertEqual(SOURCE_SHA, result["source_sha"])
        self.assertEqual(2, len(store.statuses))
        repair = parse_repair(store.comments[0]["body"])
        self.assertEqual("building", repair["phase"])
        self.assertEqual(SOURCE_SHA, repair["target_sha"])

    def test_recovers_promotion_created_before_identity_patch(self):
        store = MemoryStore()
        store.fail_body_patch = True
        with self.assertRaisesRegex(OSError, "simulated body patch failure"):
            RepairPromotion(store, POLICY).create()
        result = RepairPromotion(store, POLICY).create()
        self.assertEqual("reused", result["action"])
        self.assertEqual(30, result["promotion"]["promotion_pr"])
        self.assertEqual(
            "promoting", parse_repair(store.comments[0]["body"])["phase"]
        )

    def test_recovers_comment_write_after_promotion_merge(self):
        store = MemoryStore()
        controller = RepairPromotion(store, POLICY)
        controller.create()
        controller.prepare(30)
        store.fail_comment_update = True
        with self.assertRaisesRegex(OSError, "simulated comment write failure"):
            controller.merge(30)
        result = controller.create()
        self.assertEqual("merged-reconciled", result["action"])
        repair = parse_repair(store.comments[0]["body"])
        self.assertEqual("building", repair["phase"])
        self.assertEqual(SOURCE_SHA, repair["target_sha"])

    def test_closed_unmerged_promotion_fails_the_cohort(self):
        store = MemoryStore()
        controller = RepairPromotion(store, POLICY)
        controller.create()
        store.promotion_pull["state"] = "closed"
        store.promotion_pull["merged"] = False
        result = controller.create()
        self.assertEqual("failed-closed-promotion", result["action"])
        repair = parse_repair(store.comments[0]["body"])
        self.assertEqual("failed", repair["phase"])
        self.assertEqual(
            "promotion-pull-closed-without-merge",
            repair["terminal_reason"],
        )


if __name__ == "__main__":
    unittest.main()
