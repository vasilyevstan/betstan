#!/usr/bin/env python3

import copy
import datetime as dt
import unittest

from contracts import (
    ENVIRONMENT,
    PROMOTION_SCHEMA,
    ContractError,
    load_policy,
    timestamp,
    validate_promotion,
)
from repair_controller import parse_repair, render_repair
from repair_deploy import NoRepairCohort, RepairDeployment
from repair_promotion import render_promotion
from state_machine import transition_repair
from test_repair_merge import HEAD_SHA, MERGE_SHA, NOW, review_repair


POLICY = load_policy(__import__("pathlib").Path(__file__).with_name("policy-v1.json"))
MASTER_BASE_SHA = "e" * 40
DEV_SHA = "f" * 40
SOURCE_SHA = "1" * 40
BUILD_RUN_ID = 70
UPSTREAM_RUN_ID = 60
DEPLOY_RUN_ID = 80
PROMOTION_PR = 30


def building_repair(
    *,
    issue_number=10,
    repair_pr=22,
    head_sha=HEAD_SHA,
    merge_sha=MERGE_SHA,
    owned_paths=None,
):
    repair = review_repair()
    repair = copy.deepcopy(repair)
    repair["incident_issue"] = issue_number
    repair["incident_fingerprint"] = f"{issue_number:064x}"
    repair["repair_pr"] = repair_pr
    repair["head_sha"] = head_sha
    repair["owned_paths"] = owned_paths or ["client/**"]
    repair = transition_repair(
        repair,
        "merging",
        now=NOW,
        ttl_seconds=3600,
        updates={"merge_sha": merge_sha},
    )
    repair = transition_repair(
        repair,
        "promoting",
        now=NOW,
        ttl_seconds=3600,
        updates={"promotion_pr": PROMOTION_PR, "target_sha": DEV_SHA},
    )
    return transition_repair(
        repair,
        "building",
        now=NOW,
        ttl_seconds=3600,
        updates={"target_sha": SOURCE_SHA},
    )


def promotion_for(repairs):
    return validate_promotion(
        {
            "schema": PROMOTION_SCHEMA,
            "environment": ENVIRONMENT,
            "repository": "vasilyevstan/betstan",
            "promotion_pr": PROMOTION_PR,
            "base_sha": MASTER_BASE_SHA,
            "target_sha": DEV_SHA,
            "repairs": [
                {
                    "incident_issue": repair["incident_issue"],
                    "generation": repair["generation"],
                    "repair_pr": repair["repair_pr"],
                    "merge_sha": repair["merge_sha"],
                    "owned_paths": repair["owned_paths"],
                }
                for repair in sorted(
                    repairs,
                    key=lambda item: (item["incident_issue"], item["generation"]),
                )
            ],
            "files": sorted(
                "client/src/app.ts"
                if repair["owned_paths"] == ["client/**"]
                else "backoffice/src/app.ts"
                for repair in repairs
            ),
            "created_at": timestamp(NOW),
        }
    )


class MemoryStore:
    repository = "vasilyevstan/betstan"

    def __init__(self, repairs=None):
        repairs = repairs or [building_repair()]
        self.master = SOURCE_SHA
        self.comments = {
            repair["incident_issue"]: {
                "id": 100 + index,
                "updated_at": "1",
                "body": render_repair(repair),
            }
            for index, repair in enumerate(repairs)
        }
        promotion = promotion_for(repairs)
        self.pull = {
            "number": PROMOTION_PR,
            "state": "closed",
            "merged": True,
            "merged_at": "2026-09-01T12:10:00Z",
            "base": {"ref": "master"},
            "head": {
                "ref": "dev",
                "repo": {"full_name": self.repository},
            },
            "merge_commit_sha": SOURCE_SHA,
            "body": render_promotion(promotion),
        }
        self.runs = {
            BUILD_RUN_ID: {
                "id": BUILD_RUN_ID,
                "path": ".github/workflows/oci-production-build.yml",
                "event": "workflow_run",
                "head_branch": "master",
                "head_sha": SOURCE_SHA,
                "head_repository": {"full_name": self.repository},
                "run_attempt": 1,
                "status": "completed",
                "conclusion": "success",
                "display_title": (
                    f"oci-build {SOURCE_SHA} upstream-{UPSTREAM_RUN_ID}"
                ),
            },
            UPSTREAM_RUN_ID: {
                "id": UPSTREAM_RUN_ID,
                "path": ".github/workflows/production-build.yml",
                "event": "push",
                "head_branch": "master",
                "head_sha": SOURCE_SHA,
                "head_repository": {"full_name": self.repository},
                "run_attempt": 1,
                "status": "completed",
                "conclusion": "success",
            },
            DEPLOY_RUN_ID: {
                "id": DEPLOY_RUN_ID,
                "path": ".github/workflows/oci-production-repair-deploy.yml",
                "event": "workflow_dispatch",
                "head_branch": "master",
                "head_sha": SOURCE_SHA,
                "head_repository": {"full_name": self.repository},
                "run_attempt": 1,
                "status": "completed",
                "conclusion": "success",
                "display_title": (
                    f"oci-repair-deploy {SOURCE_SHA} build-{BUILD_RUN_ID}"
                ),
            },
        }
        self.update_calls = 0
        self.fail_update_call = None
        self.release_published = False

    def master_sha(self):
        return self.master

    def list_incidents(self):
        return [{"number": number} for number in sorted(self.comments)]

    def list_comments(self, issue_number):
        return [copy.deepcopy(self.comments[issue_number])]

    def update_comment(self, comment, body):
        self.update_calls += 1
        if self.update_calls == self.fail_update_call:
            raise OSError("simulated comment write failure")
        current = self.comments[parse_repair(body)["incident_issue"]]
        if (
            current["id"] != comment["id"]
            or current["updated_at"] != comment["updated_at"]
        ):
            raise OSError("CAS conflict")
        current["body"] = body
        current["updated_at"] = str(int(current["updated_at"]) + 1)
        return copy.deepcopy(current)

    def _request(self, path, *, method="GET", payload=None, expected=None):
        if path.endswith(f"/pulls/{PROMOTION_PR}"):
            return 200, copy.deepcopy(self.pull)
        for run_id, run in self.runs.items():
            if path.endswith(f"/actions/runs/{run_id}/attempts/1"):
                return 200, copy.deepcopy(run)
        if path.endswith(f"/actions/runs/{DEPLOY_RUN_ID}/attempts/1/jobs?per_page=100"):
            return 200, {
                "jobs": [
                    {
                        "name": "commit-release",
                        "steps": [
                            {
                                "name": "Verify durable release commitment",
                                "conclusion": (
                                    "success" if self.release_published else "failure"
                                ),
                            }
                        ],
                    }
                ]
            }
        raise AssertionError((path, method, payload, expected))


class LifecycleStore(MemoryStore):
    def __init__(self, repairs=None):
        super().__init__(repairs)
        self.build_history = [copy.deepcopy(self.runs[BUILD_RUN_ID])]
        self.deploy_history = []
        self.dispatches = []

    def _request(self, path, *, method="GET", payload=None, expected=None):
        if "/actions/workflows/oci-production-build.yml/runs?" in path:
            return 200, {"workflow_runs": copy.deepcopy(self.build_history)}
        if "/actions/workflows/oci-production-repair-deploy.yml/runs?" in path:
            return 200, {"workflow_runs": copy.deepcopy(self.deploy_history)}
        if path.endswith(
            "/actions/workflows/oci-production-repair-deploy.yml/dispatches"
        ):
            self.dispatches.append(copy.deepcopy(payload))
            return 204, None
        return super()._request(
            path,
            method=method,
            payload=payload,
            expected=expected,
        )


class RepairDeploymentTest(unittest.TestCase):
    def test_authorizes_exact_promoted_build(self):
        result = RepairDeployment(MemoryStore(), POLICY).authorize(
            BUILD_RUN_ID,
            SOURCE_SHA,
        )
        self.assertTrue(result["authorized"])
        self.assertEqual(PROMOTION_PR, result["promotion_pr"])
        self.assertEqual(UPSTREAM_RUN_ID, result["upstream_build_run_id"])

    def test_rejects_stale_master_and_unrelated_build(self):
        stale = MemoryStore()
        stale.master = "2" * 40
        with self.assertRaisesRegex(ContractError, "not current master"):
            RepairDeployment(stale, POLICY).authorize(BUILD_RUN_ID, SOURCE_SHA)

        unrelated = MemoryStore()
        repair = parse_repair(unrelated.comments[10]["body"])
        repair["target_sha"] = "3" * 40
        unrelated.comments[10]["body"] = render_repair(repair)
        with self.assertRaisesRegex(NoRepairCohort, "no building repair cohort"):
            RepairDeployment(unrelated, POLICY).authorize(
                BUILD_RUN_ID,
                SOURCE_SHA,
            )

    def test_rejects_malformed_promotion_cohort(self):
        store = MemoryStore()
        promotion = promotion_for([building_repair()])
        promotion["repairs"][0]["merge_sha"] = "4" * 40
        store.pull["body"] = render_promotion(promotion)
        with self.assertRaisesRegex(ContractError, "identity changed"):
            RepairDeployment(store, POLICY).authorize(BUILD_RUN_ID, SOURCE_SHA)

    def test_successful_deployment_advances_to_validating(self):
        store = MemoryStore()
        result = RepairDeployment(store, POLICY).reconcile(DEPLOY_RUN_ID)
        self.assertEqual("success", result["conclusion"])
        repair = parse_repair(store.comments[10]["body"])
        self.assertEqual("validating", repair["phase"])
        self.assertEqual(
            {
                "oci-production-build": BUILD_RUN_ID,
                "oci-production-repair-deploy": DEPLOY_RUN_ID,
            },
            repair["workflow_runs"],
        )

    def test_failed_deployment_is_idempotently_recorded(self):
        store = MemoryStore()
        store.runs[DEPLOY_RUN_ID]["conclusion"] = "failure"
        controller = RepairDeployment(store, POLICY)
        controller.reconcile(DEPLOY_RUN_ID)
        controller.reconcile(DEPLOY_RUN_ID)
        repair = parse_repair(store.comments[10]["body"])
        self.assertEqual("failed", repair["phase"])
        self.assertEqual("repair-deployment-failed", repair["terminal_reason"])

    def test_cancelled_timed_out_and_action_required_deployments_fail(self):
        for conclusion in ("cancelled", "timed_out", "action_required"):
            with self.subTest(conclusion=conclusion):
                store = MemoryStore()
                store.runs[DEPLOY_RUN_ID]["conclusion"] = conclusion
                result = RepairDeployment(store, POLICY).reconcile(DEPLOY_RUN_ID)
                self.assertFalse(result["release_published"])
                self.assertEqual(
                    "failed", parse_repair(store.comments[10]["body"])["phase"]
                )

    def test_failed_workflow_after_release_publication_still_validates(self):
        store = MemoryStore()
        store.runs[DEPLOY_RUN_ID]["conclusion"] = "failure"
        store.release_published = True
        result = RepairDeployment(store, POLICY).reconcile(DEPLOY_RUN_ID)
        self.assertTrue(result["release_published"])
        self.assertEqual(
            "validating", parse_repair(store.comments[10]["body"])["phase"]
        )

    def test_published_release_reconciliation_skips_terminal_cohort_members(self):
        active = building_repair()
        terminal = building_repair(
            issue_number=11,
            repair_pr=23,
            head_sha="5" * 40,
            merge_sha="6" * 40,
            owned_paths=["backoffice/**"],
        )
        terminal = transition_repair(
            terminal,
            "failed",
            now=NOW,
            ttl_seconds=300,
            updates={"terminal_reason": "post-deploy-validation-expired"},
        )
        store = MemoryStore([active, terminal])
        store.release_published = True
        result = RepairDeployment(store, POLICY).reconcile(DEPLOY_RUN_ID)
        phases = {
            item["incident_issue"]: item["phase"] for item in result["repairs"]
        }
        self.assertEqual({10: "validating", 11: "failed"}, phases)
        self.assertEqual(
            "validating", parse_repair(store.comments[10]["body"])["phase"]
        )
        self.assertEqual(
            "failed", parse_repair(store.comments[11]["body"])["phase"]
        )

    def test_retry_recovers_partial_comment_updates(self):
        repairs = [
            building_repair(),
            building_repair(
                issue_number=11,
                repair_pr=23,
                head_sha="5" * 40,
                merge_sha="6" * 40,
                owned_paths=["backoffice/**"],
            ),
        ]
        store = MemoryStore(repairs)
        store.fail_update_call = 2
        controller = RepairDeployment(store, POLICY)
        with self.assertRaisesRegex(OSError, "simulated"):
            controller.reconcile(DEPLOY_RUN_ID)
        self.assertEqual("validating", parse_repair(store.comments[10]["body"])["phase"])
        self.assertEqual("building", parse_repair(store.comments[11]["body"])["phase"])

        store.fail_update_call = None
        controller.reconcile(DEPLOY_RUN_ID)
        self.assertEqual("validating", parse_repair(store.comments[10]["body"])["phase"])
        self.assertEqual("validating", parse_repair(store.comments[11]["body"])["phase"])

    def test_lifecycle_renews_an_active_build(self):
        store = LifecycleStore()
        store.build_history[0]["status"] = "in_progress"
        store.build_history[0]["conclusion"] = None
        result = RepairDeployment(
            store,
            POLICY,
            now=lambda: NOW + dt.timedelta(minutes=10),
        ).reconcile_lifecycle()
        self.assertEqual("build-active", result["actions"][0]["action"])
        repair = parse_repair(store.comments[10]["body"])
        self.assertEqual(BUILD_RUN_ID, repair["workflow_runs"]["oci-production-build"])
        self.assertEqual("", repair["terminal_reason"])

    def test_lifecycle_fails_a_terminal_build(self):
        store = LifecycleStore()
        store.build_history[0]["conclusion"] = "failure"
        result = RepairDeployment(
            store,
            POLICY,
            now=lambda: NOW + dt.timedelta(minutes=10),
        ).reconcile_lifecycle()
        self.assertEqual("failed-build", result["actions"][0]["action"])
        repair = parse_repair(store.comments[10]["body"])
        self.assertEqual("failed", repair["phase"])
        self.assertEqual("repair-build-failure", repair["terminal_reason"])

    def test_lifecycle_dispatches_only_once_while_run_identity_is_pending(self):
        store = LifecycleStore()
        controller = RepairDeployment(
            store,
            POLICY,
            now=lambda: NOW + dt.timedelta(minutes=10),
        )
        first = controller.reconcile_lifecycle()
        second = controller.reconcile_lifecycle()
        self.assertEqual("deployment-dispatched", first["actions"][0]["action"])
        self.assertEqual(
            "deployment-dispatch-pending",
            second["actions"][0]["action"],
        )
        self.assertEqual(1, len(store.dispatches))
        self.assertEqual(
            "repair-deployment-dispatch-pending",
            parse_repair(store.comments[10]["body"])["terminal_reason"],
        )

    def test_lifecycle_renews_an_active_deployment(self):
        store = LifecycleStore()
        active = copy.deepcopy(store.runs[DEPLOY_RUN_ID])
        active["status"] = "in_progress"
        active["conclusion"] = None
        store.deploy_history = [active]
        result = RepairDeployment(
            store,
            POLICY,
            now=lambda: NOW + dt.timedelta(minutes=10),
        ).reconcile_lifecycle()
        self.assertEqual("deployment-active", result["actions"][0]["action"])
        repair = parse_repair(store.comments[10]["body"])
        self.assertEqual(
            DEPLOY_RUN_ID,
            repair["workflow_runs"]["oci-production-repair-deploy"],
        )

    def test_lifecycle_tracks_an_existing_deployment_after_master_moves(self):
        store = LifecycleStore()
        store.master = "3" * 40
        active = copy.deepcopy(store.runs[DEPLOY_RUN_ID])
        active["status"] = "in_progress"
        active["conclusion"] = None
        store.deploy_history = [active]
        result = RepairDeployment(
            store,
            POLICY,
            now=lambda: NOW + dt.timedelta(minutes=10),
        ).reconcile_lifecycle()
        self.assertEqual("deployment-active", result["actions"][0]["action"])
        self.assertEqual(
            "building",
            parse_repair(store.comments[10]["body"])["phase"],
        )

    def test_lifecycle_recovers_a_missed_deployment_completion_trigger(self):
        store = LifecycleStore()
        store.deploy_history = [copy.deepcopy(store.runs[DEPLOY_RUN_ID])]
        result = RepairDeployment(
            store,
            POLICY,
            now=lambda: NOW + dt.timedelta(minutes=10),
        ).reconcile_lifecycle()
        self.assertEqual(
            "deployment-reconciled",
            result["actions"][0]["action"],
        )
        self.assertEqual(
            "validating",
            parse_repair(store.comments[10]["body"])["phase"],
        )

    def test_lifecycle_reconciles_completed_deploy_with_terminal_member(self):
        active = building_repair()
        terminal = building_repair(
            issue_number=11,
            repair_pr=23,
            head_sha="5" * 40,
            merge_sha="6" * 40,
            owned_paths=["backoffice/**"],
        )
        terminal = transition_repair(
            terminal,
            "failed",
            now=NOW,
            ttl_seconds=300,
            updates={"terminal_reason": "post-deploy-validation-expired"},
        )
        store = LifecycleStore([active, terminal])
        store.release_published = True
        store.deploy_history = [copy.deepcopy(store.runs[DEPLOY_RUN_ID])]
        result = RepairDeployment(
            store,
            POLICY,
            now=lambda: NOW + dt.timedelta(minutes=10),
        ).reconcile_lifecycle()
        self.assertEqual(
            "deployment-reconciled",
            result["actions"][0]["action"],
        )
        self.assertEqual(
            "validating",
            parse_repair(store.comments[10]["body"])["phase"],
        )
        self.assertEqual(
            "failed",
            parse_repair(store.comments[11]["body"])["phase"],
        )

    def test_lifecycle_recovers_partial_successful_comment_updates(self):
        repairs = [
            building_repair(),
            building_repair(
                issue_number=11,
                repair_pr=23,
                head_sha="5" * 40,
                merge_sha="6" * 40,
                owned_paths=["backoffice/**"],
            ),
        ]
        store = LifecycleStore(repairs)
        store.deploy_history = [copy.deepcopy(store.runs[DEPLOY_RUN_ID])]
        store.fail_update_call = 2
        direct = RepairDeployment(store, POLICY)
        with self.assertRaisesRegex(OSError, "simulated"):
            direct.reconcile(DEPLOY_RUN_ID)
        self.assertEqual(
            "validating",
            parse_repair(store.comments[10]["body"])["phase"],
        )
        self.assertEqual(
            "building",
            parse_repair(store.comments[11]["body"])["phase"],
        )

        store.fail_update_call = None
        result = RepairDeployment(
            store,
            POLICY,
            now=lambda: NOW + dt.timedelta(minutes=10),
        ).reconcile_lifecycle()
        self.assertEqual(
            "deployment-reconciled",
            result["actions"][0]["action"],
        )
        self.assertEqual(
            "validating",
            parse_repair(store.comments[11]["body"])["phase"],
        )

    def test_lifecycle_fails_an_expired_missing_build(self):
        store = LifecycleStore()
        store.build_history = []
        result = RepairDeployment(
            store,
            POLICY,
            now=lambda: NOW + dt.timedelta(hours=2),
        ).reconcile_lifecycle()
        self.assertEqual("failed-missing-build", result["actions"][0]["action"])
        self.assertEqual(
            "repair-build-run-not-found",
            parse_repair(store.comments[10]["body"])["terminal_reason"],
        )


if __name__ == "__main__":
    unittest.main()
