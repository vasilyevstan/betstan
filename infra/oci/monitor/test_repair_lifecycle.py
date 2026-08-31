#!/usr/bin/env python3

import unittest

from contracts import ContractError
from repair_controller import render_repair
from repair_lifecycle import lifecycle_candidates
from test_repair_merge import review_repair


class MemoryStore:
    def __init__(self):
        self.comments = [
            {"id": 1, "body": render_repair(review_repair())},
        ]

    def list_incidents(self):
        return [{"number": 10}]

    def list_comments(self, issue_number):
        return self.comments


class RepairLifecycleTest(unittest.TestCase):
    def test_lists_exact_review_pull_requests(self):
        result = lifecycle_candidates(MemoryStore())
        self.assertEqual([22], result["review_pull_requests"])

    def test_rejects_duplicate_repair_generation(self):
        store = MemoryStore()
        store.comments.append(dict(store.comments[0], id=2))
        with self.assertRaisesRegex(ContractError, "duplicate repair generation"):
            lifecycle_candidates(store)


if __name__ == "__main__":
    unittest.main()
