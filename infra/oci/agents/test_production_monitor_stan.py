#!/usr/bin/env python3
import copy
import datetime as dt
import hashlib
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch

from production_monitor_stan import (
    INCIDENT_LABEL,
    REPOSITORY,
    SCHEMA,
    SERVICES,
    IncidentManager,
    MonitorError,
    PLATFORM_IMAGES,
    classify,
    collect_cluster,
    http_check,
    validate_deployment_artifact,
)


NOW = dt.datetime(2026, 8, 27, 12, 0, tzinfo=dt.timezone.utc)
SHA = "a" * 40
INSTANCE_OCID = "ocid1.instance.oc1.eu-frankfurt-1.fixture"
RUNTIME_FINGERPRINT = hashlib.sha256(INSTANCE_OCID.encode()).hexdigest()


def image(service: str) -> str:
    digest = hashlib.sha256(service.encode()).hexdigest()
    return f"ghcr.io/vasilyevstan/betstan-images@sha256:{digest}"


def healthy_snapshot(run_id: int = 200) -> dict[str, Any]:
    images = {service: image(service) for service in SERVICES}
    return {
        "schema": SCHEMA,
        "observed_at": "2026-08-27T12:00:00Z",
        "monitor_run_id": run_id,
        "monitor_run_attempt": 1,
        "deployment": {
            "sha": SHA,
            "run_id": 100,
            "completed_at": "2026-08-27T10:00:00Z",
            "originating_pr": 77,
            "diagnostic_url": "https://192.0.2.10.nip.io",
            "images": images,
            "platform_digests": {
                service: image(service).rsplit("@", 1)[1]
                for service in SERVICES
            },
            "runtime_fingerprint": RUNTIME_FINGERPRINT,
            "namespace": "betstan-oci",
            "data_run_id": 90,
            "infrastructure_run_id": 80,
        },
        "cluster": {
            "api_ready": True,
            "nodes": [
                {
                    "name": "betstan-k3s",
                    "ready": True,
                    "memory_pressure": False,
                    "disk_pressure": False,
                    "pid_pressure": False,
                }
            ],
            "deployments": [
                {
                    "name": f"gaming-{service}-depl",
                    "service": service,
                    "generation": 1,
                    "observed_generation": 1,
                    "desired": 1,
                    "updated": 1,
                    "ready": 1,
                    "available": 1,
                    "unavailable": 0,
                    "image": images[service],
                }
                for service in SERVICES
            ],
            "pods": [
                {
                    "name": f"gaming-{service}-pod",
                    "service": service,
                    "created_at": "2026-08-27T10:00:00Z",
                    "phase": "Running",
                    "ready": True,
                    "restarts": 0,
                    "waiting_reason": "",
                    "last_terminated_reason": "",
                    "last_terminated_at": "",
                    "image": images[service],
                    "image_id": f"docker-pullable://{images[service]}",
                }
                for service in SERVICES
            ],
            "platform_workloads": [
                {
                    "kind": "StatefulSet"
                    if service == "auth-mongo"
                    else "Deployment",
                    "name": f"gaming-{service}-depl",
                    "service": service,
                    "generation": 1,
                    "observed_generation": 1,
                    "desired": 1,
                    "updated": 1,
                    "ready": 1,
                    "available": 1,
                    "unavailable": 0,
                    "image": PLATFORM_IMAGES[service]["image"],
                }
                for service in ("auth-mongo", "rabbitmq")
            ],
            "platform_pods": [
                {
                    "name": f"gaming-{service}-pod",
                    "service": service,
                    "created_at": "2026-08-27T10:00:00Z",
                    "phase": "Running",
                    "ready": True,
                    "restarts": 0,
                    "waiting_reason": "",
                    "last_terminated_reason": "",
                    "last_terminated_at": "",
                    "image": PLATFORM_IMAGES[service]["image"],
                    "image_id": (
                        "docker-pullable://fixture@"
                        + sorted(PLATFORM_IMAGES[service]["runtime_digests"])[0]
                    ),
                }
                for service in ("auth-mongo", "rabbitmq")
            ],
            "endpoints": {
                service: 1
                for service in SERVICES + ("auth-mongo", "rabbitmq")
            },
            "certificates": [
                {
                    "name": "betstan-tls",
                    "ready": True,
                    "not_after": "2026-11-01T00:00:00Z",
                    "dns_names": ["betstan.xyz", "www.betstan.xyz"],
                }
            ],
            "operation_lock": {
                "state": "released",
                "holder": "",
                "operation_id": "live-data-apply-slip-index",
                "source_sha": SHA,
                "lease_until_epoch": "0",
            },
        },
        "public": [
            {
                "name": name,
                "status": 200,
                "valid": True,
                "latency_ms": 20,
                "error": "",
            }
            for name in (
                "canonical-home",
                "auth-currentuser",
                "event-api",
                "www-redirect",
                "diagnostic-event",
            )
        ],
    }


class MemoryGh:
    def __init__(self) -> None:
        self.issues: dict[int, dict[str, Any]] = {}
        self.comments: list[tuple[int, str]] = []
        self.labels: set[str] = set()
        self.next_number = 10

    def ensure_label(self, name: str, _color: str, _description: str) -> None:
        self.labels.add(name)

    def list_incidents(self) -> list[dict[str, Any]]:
        return [
            copy.deepcopy(issue)
            for issue in self.issues.values()
            if issue["state"] == "open" and INCIDENT_LABEL in issue["labels"]
        ]

    def create_issue(self, title: str, body: str) -> dict[str, Any]:
        number = self.next_number
        self.next_number += 1
        issue = {
            "number": number,
            "title": title,
            "body": body,
            "labels": [INCIDENT_LABEL],
            "state": "open",
        }
        self.issues[number] = issue
        return copy.deepcopy(issue)

    def update_issue(
        self, number: int, body: str, *, state: str | None = None
    ) -> dict[str, Any]:
        self.issues[number]["body"] = body
        if state:
            self.issues[number]["state"] = state
        return copy.deepcopy(self.issues[number])

    def comment(self, number: int, body: str) -> None:
        self.comments.append((number, body))


class ProductionMonitorTest(unittest.TestCase):
    def test_healthy_snapshot_has_no_anomalies(self) -> None:
        self.assertEqual([], classify(healthy_snapshot(), NOW))

    def test_public_snapshot_skips_cluster_observations(self) -> None:
        snapshot = healthy_snapshot()
        snapshot["scope"] = "public"
        snapshot["cluster"] = None

        self.assertEqual([], classify(snapshot, NOW))
        snapshot["public"][2]["valid"] = False
        findings = classify(snapshot, NOW)

        self.assertEqual(1, len(findings))
        self.assertEqual("public-check-event-api-failed", findings[0]["type"])

    def test_public_snapshot_rejects_cluster_data(self) -> None:
        snapshot = healthy_snapshot()
        snapshot["scope"] = "public"

        with self.assertRaisesRegex(MonitorError, "must not contain cluster"):
            classify(snapshot, NOW)

    def test_groups_crash_and_detects_restricted_drift(self) -> None:
        snapshot = healthy_snapshot()
        client_pod = next(
            pod
            for pod in snapshot["cluster"]["pods"]
            if pod["service"] == "client"
        )
        client_pod["ready"] = False
        client_pod["waiting_reason"] = "CrashLoopBackOff"
        second = copy.deepcopy(client_pod)
        second["name"] = "gaming-client-pod-2"
        snapshot["cluster"]["pods"].append(second)
        auth = next(
            deployment
            for deployment in snapshot["cluster"]["deployments"]
            if deployment["service"] == "auth"
        )
        auth["image"] = "ghcr.io/attacker/image@sha256:" + "f" * 64

        findings = classify(snapshot, NOW)
        crash = [item for item in findings if item["type"] == "pod-crash-loop"]
        drift = [
            item for item in findings if item["type"] == "deployment-image-drift"
        ]

        self.assertEqual(1, len(crash))
        self.assertEqual(2, len(crash[0]["evidence"]))
        self.assertEqual("self-heal", crash[0]["automation_class"])
        self.assertEqual("restricted", drift[0]["automation_class"])

    def test_old_restart_is_not_a_new_anomaly(self) -> None:
        snapshot = healthy_snapshot()
        snapshot["cluster"]["pods"][0]["restarts"] = 4
        snapshot["cluster"]["pods"][0][
            "last_terminated_at"
        ] = "2026-08-26T12:00:00Z"

        self.assertFalse(
            any(item["type"] == "recent-pod-restart" for item in classify(snapshot, NOW))
        )

    def test_observations_deduplicate_without_claiming(self) -> None:
        gh = MemoryGh()
        manager = IncidentManager(gh, NOW)
        first = healthy_snapshot(200)
        first["public"][0]["valid"] = False
        first["public"][0]["status"] = 503
        incidents = manager.observe(first, "observation", False)
        self.assertEqual("observing", incidents[0].document["status"])

        second = copy.deepcopy(first)
        second["observed_at"] = "2026-08-27T12:15:00Z"
        second["monitor_run_id"] = 201
        manager = IncidentManager(
            gh, NOW + dt.timedelta(minutes=15)
        )
        incidents = manager.observe(second, "observation", False)

        self.assertEqual(1, len(gh.issues))
        self.assertEqual("observing", incidents[0].document["status"])
        self.assertEqual(2, incidents[0].document["total_observations"])
        self.assertEqual(2, len(gh.comments))

    def test_ownership_mode_is_disabled(self) -> None:
        gh = MemoryGh()
        first = healthy_snapshot(200)
        first["public"][2]["valid"] = False
        with self.assertRaisesRegex(MonitorError, "observation-only"):
            IncidentManager(gh, NOW).observe(first, "ownership", True)
        self.assertEqual({}, gh.issues)

    def test_claim_is_disabled(self) -> None:
        gh = MemoryGh()
        snapshot = healthy_snapshot(200)
        snapshot["public"][2]["valid"] = False
        manager = IncidentManager(gh, NOW)
        incident = manager.observe(snapshot, "observation", False)[0]
        with self.assertRaisesRegex(MonitorError, "observation-only"):
            manager.claim(
                incident.document["incident_issue"],
                incident.document["fingerprint"],
                88,
            )

    def test_resolution_requires_sustained_health(self) -> None:
        gh = MemoryGh()
        snapshot = healthy_snapshot(200)
        snapshot["public"][0]["valid"] = False
        IncidentManager(gh, NOW).observe(snapshot, "observation", False)

        for offset, run_id in ((15, 201), (30, 202)):
            healthy = healthy_snapshot(run_id)
            healthy["observed_at"] = (
                NOW + dt.timedelta(minutes=offset)
            ).isoformat().replace("+00:00", "Z")
            IncidentManager(
                gh, NOW + dt.timedelta(minutes=offset)
            ).observe(healthy, "observation", False)
        issue = next(iter(gh.issues.values()))
        self.assertEqual("open", issue["state"])

        healthy = healthy_snapshot(203)
        healthy["observed_at"] = "2026-08-27T12:45:00Z"
        IncidentManager(gh, NOW + dt.timedelta(minutes=45)).observe(
            healthy, "observation", False
        )
        self.assertEqual("closed", issue["state"])
        self.assertIn('"status":"resolved"', issue["body"])

    def test_validates_exact_deployment_artifact(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            rows = []
            for service in SERVICES:
                image_ref = image(service)
                digest = image_ref.rsplit("@", 1)[1]
                rows.append(
                    "\t".join(
                        [
                            service,
                            "ghcr.io/vasilyevstan/betstan-images",
                            image_ref,
                            digest,
                            digest,
                        ]
                    )
                )
            images = "\n".join(rows) + "\n"
            (root / "images.tsv").write_text(images, encoding="utf-8")
            values = {
                "source_sha": SHA,
                "runtime_mode": "k3s",
                "runtime_fingerprint": "1" * 64,
                "image_provenance_sha256": hashlib.sha256(
                    images.encode()
                ).hexdigest(),
                "rendered_manifest_sha256": "2" * 64,
                "rabbitmq_baseline_sha256": "3" * 64,
                "public_host": "betstan.xyz",
                "canonical_host": "betstan.xyz",
                "redirect_host": "www.betstan.xyz",
                "diagnostic_host": "8.8.8.8.nip.io",
                "deployment_workflow": "oci-production-deploy",
                "deployment_run_id": "100",
                "deployment_run_attempt": "1",
                "registry_provider": "ghcr",
                "registry_host": "ghcr.io",
                "registry_repository": "ghcr.io/vasilyevstan/betstan-images",
                "registry_public_anonymous": "true",
                "data_run_id": "90",
                "data_run_attempt": "1",
                "data_evidence_sha256": "4" * 64,
                "infrastructure_run_id": "80",
                "infrastructure_run_attempt": "1",
                "infrastructure_provenance_sha256": "5" * 64,
            }
            (root / "provenance.txt").write_text(
                "".join(f"{key}={value}\n" for key, value in values.items()),
                encoding="utf-8",
            )
            metadata = {
                "id": 100,
                "workflow_id": 50,
                "path": ".github/workflows/oci-production-deploy.yml",
                "event": "workflow_dispatch",
                "head_sha": SHA,
                "head_branch": "master",
                "head_repository": {"full_name": REPOSITORY},
                "status": "completed",
                "conclusion": "success",
                "run_attempt": 1,
                "display_title": f"oci-deploy {SHA}",
                "updated_at": "2026-08-27T10:00:00Z",
            }

            deployment = validate_deployment_artifact(root, metadata)
            self.assertEqual(100, deployment["run_id"])
            metadata["run_attempt"] = 2
            with self.assertRaises(MonitorError):
                validate_deployment_artifact(root, metadata)

    def test_collector_uses_only_read_only_cluster_queries(self) -> None:
        resources: dict[str, dict[str, Any]] = {
            "node": {
                "metadata": {
                    "name": "betstan-k3s",
                    "labels": {"betstan.io/runtime": "k3s"},
                },
                "spec": {"providerID": f"oci://{INSTANCE_OCID}"},
                "status": {
                    "conditions": [{"type": "Ready", "status": "True"}]
                },
            },
            "deployments": {
                "items": [
                    {
                        "metadata": {"name": "gaming-auth-depl", "generation": 2},
                        "spec": {
                            "replicas": 1,
                            "template": {
                                "metadata": {"labels": {"app": "gaming-auth"}},
                                "spec": {
                                    "containers": [
                                        {
                                            "name": "gaming-auth",
                                            "image": image("auth"),
                                        }
                                    ]
                                },
                            },
                        },
                        "status": {
                            "observedGeneration": 2,
                            "updatedReplicas": 1,
                            "readyReplicas": 1,
                            "availableReplicas": 1,
                        },
                    },
                    {
                        "metadata": {
                            "name": "gaming-rabbitmq-depl",
                            "generation": 1,
                        },
                        "spec": {
                            "replicas": 1,
                            "template": {
                                "metadata": {
                                    "labels": {"app": "gaming-rabbitmq"}
                                },
                                "spec": {
                                    "containers": [
                                        {
                                            "name": "gaming-rabbitmq",
                                            "image": "rabbitmq@sha256:" + "1" * 64,
                                        }
                                    ]
                                },
                            },
                        },
                        "status": {
                            "observedGeneration": 1,
                            "updatedReplicas": 1,
                            "readyReplicas": 1,
                            "availableReplicas": 1,
                        },
                    },
                ]
            },
            "statefulsets": {
                "items": [
                    {
                        "metadata": {
                            "name": "gaming-auth-mongo-depl",
                            "generation": 1,
                        },
                        "spec": {
                            "replicas": 1,
                            "template": {
                                "metadata": {
                                    "labels": {"app": "gaming-auth-mongo"}
                                },
                                "spec": {
                                    "containers": [
                                        {
                                            "name": "gaming-auth-mongo",
                                            "image": PLATFORM_IMAGES[
                                                "auth-mongo"
                                            ]["image"],
                                        }
                                    ]
                                },
                            },
                        },
                        "status": {
                            "observedGeneration": 1,
                            "updatedReplicas": 1,
                            "readyReplicas": 1,
                            "currentReplicas": 1,
                        },
                    }
                ]
            },
            "pods": {"items": []},
            "endpoints": {"items": []},
            "certificates.cert-manager.io": {"items": []},
            "configmap": {
                "data": {
                    "state": "released",
                    "holder": "",
                    "operation-id": "deploy",
                    "source-sha": SHA,
                    "lease-until-epoch": "0",
                }
            },
        }
        commands: list[list[str]] = []

        def fake_run_json(command: list[str], _label: str) -> dict[str, Any]:
            commands.append(command)
            resource = command[command.index("get") + 1]
            return copy.deepcopy(resources[resource])

        def fake_run(command: list[str], **_kwargs: Any) -> Any:
            output = (
                "https://127.0.0.1:16444\tbetstan-oci\tbetstan-monitor-oidc"
                if "config" in command
                else "ok\n"
            )
            return type(
                "Completed",
                (),
                {"returncode": 0, "stdout": output, "stderr": ""},
            )()

        with patch(
            "production_monitor_stan.run_json", side_effect=fake_run_json
        ), patch("production_monitor_stan.subprocess.run", side_effect=fake_run):
            cluster = collect_cluster("betstan-oci", RUNTIME_FINGERPRINT)

        self.assertEqual(["auth"], [item["service"] for item in cluster["deployments"]])
        self.assertEqual(
            {"auth-mongo", "rabbitmq"},
            {item["service"] for item in cluster["platform_workloads"]},
        )
        for command in commands:
            self.assertEqual("get", command[command.index("get")])
            self.assertNotIn("exec", command)
            self.assertNotIn("logs", command)
            self.assertNotIn("patch", command)

    def test_http_error_detail_is_normalized(self) -> None:
        completed = type(
            "Completed",
            (),
            {
                "returncode": 28,
                "stdout": "",
                "stderr": "hostile untrusted detail",
            },
        )()
        with patch("production_monitor_stan.subprocess.run", return_value=completed):
            result = http_check(
                "event-api",
                "https://betstan.xyz/api/event",
                {200},
                "array",
            )
        self.assertEqual("curl-exit-28", result["error"])
        self.assertNotIn("hostile", str(result))


if __name__ == "__main__":
    unittest.main()
