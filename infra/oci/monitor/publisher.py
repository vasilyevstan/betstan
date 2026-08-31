#!/usr/bin/env python3
"""Publish deduplicated production incidents from trusted observation artifacts."""

from __future__ import annotations

import argparse
import copy
import json
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from contracts import (
    HASH,
    ContractError,
    anomaly_key,
    canonical_json,
    document_sha256,
    load_policy,
    parse_timestamp,
    validate_incident,
)
from detector import validate_artifact
from state_machine import apply_failure, apply_healthy, new_incident


INCIDENT_MARKER = "betstan-production-incident-v1"
INCIDENT_LABEL = "production-monitor-incident"
MANAGED_LABEL = "production-monitor-managed"
PAGE_SIZE = 100
MAX_MANAGED_PAGES = 10


class IssueStore(Protocol):
    def ensure_label(self, name: str, color: str, description: str) -> None: ...

    def list_incidents(self) -> list[dict[str, Any]]: ...

    def create_issue(self, title: str, body: str, labels: list[str]) -> dict[str, Any]: ...

    def update_issue(
        self,
        issue: dict[str, Any],
        *,
        title: str,
        body: str,
        state: str | None = None,
    ) -> dict[str, Any]: ...

    def comment(self, number: int, body: str) -> None: ...


def render_incident(document: dict[str, Any], anomaly: dict[str, Any] | None) -> str:
    validate_incident(document)
    evidence = anomaly["evidence"] if anomaly is not None else {}
    encoded = canonical_json(document)
    evidence_json = json.dumps(evidence, indent=2, sort_keys=True, ensure_ascii=True)
    return (
        "## OCI production incident\n\n"
        "This issue is managed by trusted production-monitor workflows. "
        "Editing the machine payload invalidates autonomous repair.\n\n"
        f"- Service: `{document['service']}`\n"
        f"- Anomaly: `{document['code']}`\n"
        f"- Severity: `{document['severity']}`\n"
        f"- Episode: `{document['episode']}`\n"
        f"- Status: `{document['status']}`\n"
        f"- Consecutive failures: `{document['failure_count']}`\n"
        f"- Consecutive healthy observations: `{document['healthy_count']}`\n"
        f"- Last monitor run: `{document['last_monitor_run_id']}`\n"
        f"- Active release SHA: `{document['active_release_sha'] or 'unavailable'}`\n"
        f"- Evidence digest: `{document['last_observation_sha256']}`\n\n"
        "<details><summary>Latest sanitized evidence</summary>\n\n"
        f"```json\n{evidence_json}\n```\n"
        "</details>\n\n"
        f"<!-- {INCIDENT_MARKER}\n{encoded}\n-->\n"
    )


def parse_incident(body: Any) -> dict[str, Any]:
    if not isinstance(body, str):
        raise ContractError("incident issue body is missing")
    pattern = re.compile(
        rf"<!-- {re.escape(INCIDENT_MARKER)}\n(?P<payload>[^\n]+)\n-->"
    )
    matches = list(pattern.finditer(body))
    if len(matches) != 1:
        raise ContractError("incident issue must contain exactly one machine payload")
    try:
        document = json.loads(matches[0].group("payload"))
    except json.JSONDecodeError as error:
        raise ContractError("incident issue payload is malformed") from error
    return validate_incident(document)


def incident_title(document: dict[str, Any]) -> str:
    return (
        f"[production][{document['severity']}] "
        f"{document['service']}: {document['code']} "
        f"(episode {document['episode']})"
    )


@dataclass
class StoredIncident:
    issue: dict[str, Any]
    document: dict[str, Any]


def _find_anomaly(observation: dict[str, Any], key: str) -> dict[str, Any] | None:
    for anomaly in observation["anomalies"]:
        if (
            anomaly["classification"] != "maintenance"
            and anomaly_key(anomaly["service"], anomaly["code"]) == key
        ):
            return anomaly
    return None


class IncidentPublisher:
    def __init__(self, store: IssueStore, policy: dict[str, Any]):
        self.store = store
        self.policy = policy

    def _load(self) -> dict[str, StoredIncident]:
        issues = self.store.list_incidents()
        result: dict[str, StoredIncident] = {}
        for issue in issues:
            if issue.get("pull_request"):
                continue
            document = parse_incident(issue.get("body"))
            issue_number = issue.get("number")
            if document["issue_number"] == 0 and isinstance(issue_number, int):
                document["issue_number"] = issue_number
                document = validate_incident(document)
                issue = self.store.update_issue(
                    issue,
                    title=incident_title(document),
                    body=render_incident(document, None),
                )
            elif document["issue_number"] != issue_number:
                raise ContractError("incident issue identity does not match its payload")
            key = document["anomaly_key"]
            existing = result.get(key)
            if existing is None or document["episode"] > existing.document["episode"]:
                result[key] = StoredIncident(copy.deepcopy(issue), document)
            elif document["episode"] == existing.document["episode"]:
                raise ContractError("duplicate incident episode exists")
        return result

    def reconcile(
        self,
        observation: dict[str, Any],
        *,
        previous: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        current_hash = document_sha256(observation)
        previous_hash = document_sha256(previous) if previous is not None else ""
        incidents = self._load()
        current_failures = {
            anomaly_key(anomaly["service"], anomaly["code"]): anomaly
            for anomaly in observation["anomalies"]
            if anomaly["classification"] != "maintenance"
        }
        transitions: list[dict[str, Any]] = []

        for key, anomaly in current_failures.items():
            stored = incidents.get(key)
            if stored is not None and stored.document["status"] != "resolved":
                prior_status = stored.document["status"]
                updated = apply_failure(
                    stored.document,
                    anomaly,
                    observation,
                    current_hash,
                    self.policy,
                )
                issue = self.store.update_issue(
                    stored.issue,
                    title=incident_title(updated),
                    body=render_incident(updated, anomaly),
                )
                incidents[key] = StoredIncident(issue, updated)
                if prior_status != updated["status"]:
                    self.store.comment(
                        updated["issue_number"],
                        f"Monitor transition: `{prior_status}` -> `{updated['status']}` "
                        f"at observation `{current_hash}`.",
                    )
                transitions.append(updated)
                continue

            previous_anomaly = _find_anomaly(previous, key) if previous is not None else None
            if previous_anomaly is None:
                continue
            current_time = parse_timestamp(observation["observed_at"], "observed_at")
            previous_time = parse_timestamp(previous["observed_at"], "previous observed_at")
            if (
                current_time <= previous_time
                or observation["monitor_run_id"] <= previous["monitor_run_id"]
                or (current_time - previous_time).total_seconds()
                > self.policy["observation"]["maximum_gap_seconds"]
            ):
                continue
            episode = stored.document["episode"] + 1 if stored is not None else 1
            pending = new_incident(
                previous_anomaly,
                previous,
                previous_hash,
                episode=episode,
            )
            confirmed = apply_failure(
                pending,
                anomaly,
                observation,
                current_hash,
                self.policy,
            )
            created = self.store.create_issue(
                incident_title(confirmed),
                render_incident(confirmed, anomaly),
                [INCIDENT_LABEL, MANAGED_LABEL, f"severity:{confirmed['severity']}"],
            )
            issue_number = created.get("number")
            if (
                isinstance(issue_number, bool)
                or not isinstance(issue_number, int)
                or issue_number < 1
            ):
                raise ContractError("created incident issue has no valid number")
            confirmed["issue_number"] = issue_number
            confirmed = validate_incident(confirmed)
            created = self.store.update_issue(
                created,
                title=incident_title(confirmed),
                body=render_incident(confirmed, anomaly),
            )
            incidents[key] = StoredIncident(created, confirmed)
            self.store.comment(
                issue_number,
                "Incident confirmed after two consecutive trusted failing observations.",
            )
            transitions.append(confirmed)

        can_advance_health = (
            observation["status"] in {"healthy", "anomalous"}
            and all(
                anomaly["classification"] != "unknown"
                for anomaly in observation["anomalies"]
            )
        )
        if can_advance_health:
            for key, stored in list(incidents.items()):
                if stored.document["status"] == "resolved" or key in current_failures:
                    continue
                prior_status = stored.document["status"]
                updated = apply_healthy(
                    stored.document,
                    observation,
                    current_hash,
                    self.policy,
                )
                state = "closed" if updated["status"] == "resolved" else None
                issue = self.store.update_issue(
                    stored.issue,
                    title=incident_title(updated),
                    body=render_incident(updated, None),
                    state=state,
                )
                incidents[key] = StoredIncident(issue, updated)
                if prior_status != updated["status"]:
                    self.store.comment(
                        updated["issue_number"],
                        "Incident resolved after three consecutive trusted healthy observations.",
                    )
                transitions.append(updated)

        confirmed = [
            item
            for item in transitions
            if item["status"] in {"confirmed", "repairing", "validating", "escalated"}
        ]
        return {
            "schema": "betstan.production-incident-publication.v1",
            "observation_sha256": current_hash,
            "confirmed": [
                {
                    "issue_number": item["issue_number"],
                    "fingerprint": item["fingerprint"],
                    "service": item["service"],
                    "code": item["code"],
                    "severity": item["severity"],
                    "generation": item["generation"],
                    "active_release_sha": item["active_release_sha"],
                }
                for item in sorted(confirmed, key=lambda value: value["issue_number"])
            ],
        }


class GitHubIssueStore:
    def __init__(self, repository: str):
        self.repository = repository

    def _api(
        self,
        path: str,
        *,
        method: str = "GET",
        payload: dict[str, Any] | None = None,
    ) -> Any:
        command = ["gh", "api", "--method", method, path]
        if payload is not None:
            command.extend(["--input", "-"])
        result = subprocess.run(
            command,
            check=True,
            text=True,
            input=canonical_json(payload) if payload is not None else None,
            capture_output=True,
            env={**__import__("os").environ, "GH_PROMPT_DISABLED": "1"},
        )
        return json.loads(result.stdout) if result.stdout.strip() else None

    def ensure_label(self, name: str, color: str, description: str) -> None:
        path = f"repos/{self.repository}/labels/{name}"
        try:
            current = self._api(path)
        except subprocess.CalledProcessError as error:
            if error.returncode != 1 or "404" not in error.stderr:
                raise
            self._api(
                f"repos/{self.repository}/labels",
                method="POST",
                payload={"name": name, "color": color, "description": description},
            )
            return
        if current.get("color") != color or current.get("description") != description:
            self._api(
                path,
                method="PATCH",
                payload={"new_name": name, "color": color, "description": description},
            )

    def list_incidents(self) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []
        for page in range(1, MAX_MANAGED_PAGES + 1):
            payload = self._api(
                f"repos/{self.repository}/issues?state=all&labels={INCIDENT_LABEL}"
                f"&per_page={PAGE_SIZE}&page={page}"
            )
            if not isinstance(payload, list) or len(payload) > PAGE_SIZE:
                raise ContractError("GitHub incident response is malformed")
            result.extend(payload)
            if len(payload) < PAGE_SIZE:
                return result
        raise ContractError("GitHub incident query exceeded its bounded page limit")

    def create_issue(self, title: str, body: str, labels: list[str]) -> dict[str, Any]:
        return self._api(
            f"repos/{self.repository}/issues",
            method="POST",
            payload={"title": title, "body": body, "labels": labels},
        )

    def update_issue(
        self,
        issue: dict[str, Any],
        *,
        title: str,
        body: str,
        state: str | None = None,
    ) -> dict[str, Any]:
        number = issue["number"]
        latest = self._api(f"repos/{self.repository}/issues/{number}")
        if (
            latest.get("updated_at") != issue.get("updated_at")
            or latest.get("body") != issue.get("body")
        ):
            raise ContractError(f"incident issue #{number} changed during compare-and-update")
        payload: dict[str, Any] = {"title": title, "body": body}
        if state is not None:
            payload["state"] = state
        return self._api(
            f"repos/{self.repository}/issues/{number}",
            method="PATCH",
            payload=payload,
        )

    def comment(self, number: int, body: str) -> None:
        self._api(
            f"repos/{self.repository}/issues/{number}/comments",
            method="POST",
            payload={"body": body},
        )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repository", required=True)
    parser.add_argument("--policy", required=True)
    parser.add_argument("--observation-directory", required=True)
    parser.add_argument("--previous-directory")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    try:
        policy = load_policy(args.policy)
        observation = validate_artifact(
            Path(args.observation_directory), Path(args.policy)
        )
        previous = None
        if args.previous_directory:
            previous = validate_artifact(Path(args.previous_directory), Path(args.policy))
        store = GitHubIssueStore(args.repository)
        store.ensure_label(
            INCIDENT_LABEL,
            "b60205",
            "Machine-managed OCI production anomaly incident",
        )
        store.ensure_label(
            MANAGED_LABEL,
            "5319e7",
            "Managed by the trusted production monitor controller",
        )
        for severity, color in (
            ("critical", "b60205"),
            ("high", "d93f0b"),
            ("medium", "fbca04"),
            ("low", "c5def5"),
        ):
            store.ensure_label(
                f"severity:{severity}",
                color,
                f"Production monitor severity: {severity}",
            )
        result = IncidentPublisher(store, policy).reconcile(
            observation, previous=previous
        )
        Path(args.output).write_text(canonical_json(result) + "\n", encoding="utf-8")
    except (ContractError, OSError, json.JSONDecodeError, subprocess.SubprocessError) as error:
        print(f"production_incident_publisher=FAIL reason={error}", file=sys.stderr)
        return 1
    print(
        f"production_incident_publisher=PASS confirmed={len(result['confirmed'])}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
