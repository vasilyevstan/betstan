#!/usr/bin/env python3

import datetime as dt
import unittest

from contracts import ContractError, load_policy
from publisher import render_incident
from repair_controller import render_repair
from self_heal_controller import SELF_HEAL_OWNER, repair_id
from self_heal_request import validate_request
from state_machine import new_repair, transition_repair
from test_self_heal_controller import NOW, incident
from test_self_heal_controller import ACTIVE_RELEASE_SHA


POLICY = load_policy(__import__("pathlib").Path(__file__).with_name("policy-v1.json"))


class SelfHealRequestTest(unittest.TestCase):
    def fixture(self):
        value = incident()
        value["status"] = "repairing"
        value["repair_generation"] = 1
        repair = new_repair(
            {**value, "repair_generation": 0},
            owner=SELF_HEAL_OWNER,
            base_sha="c" * 40,
            owned_paths=["client/**"],
            now=NOW,
            ttl_seconds=3600,
        )
        repair = transition_repair(
            repair,
            "self-healing",
            now=NOW,
            ttl_seconds=3600,
            updates={
                "attempts": 1,
                "self_heal_attempted": True,
                "target_sha": ACTIVE_RELEASE_SHA,
                "workflow_runs": {"self-heal": 500},
            },
        )
        issue = {
            "number": 20,
            "state": "open",
            "body": render_incident(value, None),
        }
        comments = [{"body": render_repair(repair)}]
        return issue, comments

    def test_accepts_exact_controller_dispatch(self):
        issue, comments = self.fixture()
        result = validate_request(
            issue=issue,
            comments=comments,
            policy=POLICY,
            issue_number=20,
            fingerprint=incident()["fingerprint"],
            repair_generation=1,
            expected_repair_id=repair_id(20, 1),
            service="client",
            target_sha=ACTIVE_RELEASE_SHA,
            run_id=500,
        )
        self.assertEqual("betstan.production-self-heal-request.v1", result["schema"])

    def test_rejects_a_different_workflow_run(self):
        issue, comments = self.fixture()
        with self.assertRaisesRegex(ContractError, "does not authorize"):
            validate_request(
                issue=issue,
                comments=comments,
                policy=POLICY,
                issue_number=20,
                fingerprint=incident()["fingerprint"],
                repair_generation=1,
                expected_repair_id=repair_id(20, 1),
                service="client",
                target_sha=ACTIVE_RELEASE_SHA,
                run_id=501,
            )


if __name__ == "__main__":
    unittest.main()
