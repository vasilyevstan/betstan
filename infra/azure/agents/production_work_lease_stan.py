#!/usr/bin/env python3
"""Repository-wide lease for automated delivery and production repair work."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import subprocess
import sys
import urllib.parse
from dataclasses import dataclass
from typing import Any, Protocol


SCHEMA = "betstan.production-work-lease.v1"
LEASE_LABEL = "production-work-lease"
MARKER = "betstan-production-work-lease"
SHA = re.compile(r"^[0-9a-f]{40}$")
FINGERPRINT = re.compile(r"^[0-9a-f]{64}$")
OWNER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$")
BRANCH = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$")
RUN_KEY = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")
PHASES = {
    "claimed",
    "coding",
    "review",
    "promotion",
    "release",
    "validation",
    "failed",
}
LEASE_KEYS = {
    "schema",
    "lease_issue",
    "state",
    "kind",
    "incident",
    "incident_fingerprint",
    "production_sha",
    "deployment_run_id",
    "repair_sha",
    "owner_task",
    "owner_branch",
    "owner_pr",
    "head_sha",
    "phase",
    "workflow_runs",
    "heartbeat_at",
    "expires_at",
    "generation",
    "handoff_reason",
    "health_evidence",
}


class LeaseError(RuntimeError):
    pass


class IssueStore(Protocol):
    def ensure_label(self, name: str, color: str, description: str) -> None: ...

    def list_open_by_label(self, label: str) -> list[dict[str, Any]]: ...

    def create_issue(
        self, title: str, body: str, labels: list[str]
    ) -> dict[str, Any]: ...

    def update_issue(
        self, number: int, body: str, state: str | None = None
    ) -> dict[str, Any]: ...

    def comment(self, number: int, body: str) -> None: ...


def utc_now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0)


def timestamp(value: dt.datetime) -> str:
    return value.astimezone(dt.timezone.utc).replace(microsecond=0).isoformat().replace(
        "+00:00", "Z"
    )


def parse_timestamp(value: Any, field: str) -> dt.datetime:
    if not isinstance(value, str):
        raise LeaseError(f"{field} is not a timestamp")
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise LeaseError(f"{field} is not a timestamp") from error
    if parsed.tzinfo is None:
        raise LeaseError(f"{field} is not timezone-aware")
    return parsed.astimezone(dt.timezone.utc)


def positive_int(value: Any, field: str, *, allow_zero: bool = False) -> int:
    if isinstance(value, bool):
        raise LeaseError(f"{field} is not an integer")
    try:
        parsed = int(value)
    except (TypeError, ValueError) as error:
        raise LeaseError(f"{field} is not an integer") from error
    minimum = 0 if allow_zero else 1
    if parsed < minimum or str(parsed) != str(value):
        raise LeaseError(f"{field} is outside its supported range")
    return parsed


def validate_lease(document: dict[str, Any]) -> dict[str, Any]:
    if set(document) != LEASE_KEYS:
        raise LeaseError(
            "lease keys differ from the reviewed schema "
            f"missing={sorted(LEASE_KEYS - set(document))} "
            f"extra={sorted(set(document) - LEASE_KEYS)}"
        )
    if document["schema"] != SCHEMA:
        raise LeaseError("lease schema is unsupported")
    positive_int(document["lease_issue"], "lease_issue", allow_zero=True)
    if document["state"] not in {"active", "failed", "released"}:
        raise LeaseError("lease state is unsupported")
    if document["kind"] not in {"delivery", "repair"}:
        raise LeaseError("lease kind is unsupported")
    positive_int(document["incident"], "incident", allow_zero=True)
    if not FINGERPRINT.fullmatch(str(document["incident_fingerprint"])):
        raise LeaseError("incident_fingerprint must be a lowercase SHA-256")
    if not SHA.fullmatch(str(document["production_sha"])):
        raise LeaseError("production_sha must be a full lowercase SHA")
    positive_int(document["deployment_run_id"], "deployment_run_id")
    repair_sha = document["repair_sha"]
    if repair_sha and not SHA.fullmatch(str(repair_sha)):
        raise LeaseError("repair_sha must be empty or a full lowercase SHA")
    if not OWNER.fullmatch(str(document["owner_task"])):
        raise LeaseError("owner_task is malformed")
    owner_branch = document["owner_branch"]
    if owner_branch and not BRANCH.fullmatch(str(owner_branch)):
        raise LeaseError("owner_branch is malformed")
    positive_int(document["owner_pr"], "owner_pr", allow_zero=True)
    head_sha = document["head_sha"]
    if head_sha and not SHA.fullmatch(str(head_sha)):
        raise LeaseError("head_sha must be empty or a full lowercase SHA")
    if document["phase"] not in PHASES:
        raise LeaseError("lease phase is unsupported")
    runs = document["workflow_runs"]
    if not isinstance(runs, dict):
        raise LeaseError("workflow_runs must be an object")
    for key, value in runs.items():
        if not RUN_KEY.fullmatch(str(key)):
            raise LeaseError("workflow run key is malformed")
        positive_int(value, f"workflow_runs.{key}")
    heartbeat = parse_timestamp(document["heartbeat_at"], "heartbeat_at")
    expires = parse_timestamp(document["expires_at"], "expires_at")
    if expires <= heartbeat:
        raise LeaseError("lease expiry must follow its heartbeat")
    positive_int(document["generation"], "generation")
    for field in ("handoff_reason", "health_evidence"):
        value = document[field]
        if not isinstance(value, str) or len(value) > 500:
            raise LeaseError(f"{field} is malformed")
    return document


def render_body(document: dict[str, Any]) -> str:
    validate_lease(document)
    encoded = json.dumps(document, sort_keys=True, separators=(",", ":"))
    return (
        "## Production work lease\n\n"
        "This issue is machine-managed. Editing the lease payload invalidates "
        "automatic merge, promotion, and deployment.\n\n"
        f"- Kind: `{document['kind']}`\n"
        f"- Phase: `{document['phase']}`\n"
        f"- Production SHA: `{document['production_sha']}`\n"
        f"- Deployment run: `{document['deployment_run_id']}`\n"
        f"- Owner task: `{document['owner_task']}`\n"
        f"- Expires: `{document['expires_at']}`\n\n"
        f"<!-- {MARKER}\n{encoded}\n-->\n"
    )


def parse_body(body: Any) -> dict[str, Any]:
    if not isinstance(body, str):
        raise LeaseError("lease issue body is missing")
    pattern = re.compile(
        rf"<!-- {re.escape(MARKER)}\n(?P<payload>[^\n]+)\n-->"
    )
    matches = list(pattern.finditer(body))
    if len(matches) != 1:
        raise LeaseError("lease issue must contain exactly one machine payload")
    try:
        document = json.loads(matches[0].group("payload"))
    except json.JSONDecodeError as error:
        raise LeaseError("lease payload is not valid JSON") from error
    if not isinstance(document, dict):
        raise LeaseError("lease payload is not an object")
    return validate_lease(document)


@dataclass
class ActiveLease:
    issue: dict[str, Any]
    document: dict[str, Any]


class LeaseManager:
    def __init__(
        self, store: IssueStore, now: dt.datetime | None = None, ttl_seconds: int = 3600
    ):
        self.store = store
        self.now = (now or utc_now()).astimezone(dt.timezone.utc).replace(microsecond=0)
        if ttl_seconds < 300 or ttl_seconds > 86400:
            raise LeaseError("lease TTL must be between 300 and 86400 seconds")
        self.ttl_seconds = ttl_seconds

    def _open(self) -> list[ActiveLease]:
        issues = self.store.list_open_by_label(LEASE_LABEL)
        if len(issues) >= 100:
            raise LeaseError("open lease query reached its fail-closed page bound")
        leases: list[ActiveLease] = []
        seen: set[int] = set()
        for issue in issues:
            number = positive_int(issue.get("number"), "issue.number")
            if number in seen:
                raise LeaseError("lease query returned a duplicate issue")
            seen.add(number)
            document = parse_body(issue.get("body"))
            if document["lease_issue"] != number:
                raise LeaseError(f"lease issue #{number} has a mismatched identity")
            leases.append(ActiveLease(issue, document))
        if len(leases) > 1:
            raise LeaseError("multiple open production work leases exist")
        return leases

    def current(self, *, include_expired: bool = False) -> ActiveLease:
        leases = self._open()
        if not leases:
            raise LeaseError("no open production work lease exists")
        lease = leases[0]
        if not include_expired and parse_timestamp(
            lease.document["expires_at"], "expires_at"
        ) <= self.now:
            raise LeaseError("production work lease has expired")
        return lease

    def acquire(
        self,
        *,
        kind: str,
        incident: int,
        fingerprint: str,
        production_sha: str,
        deployment_run_id: int,
        owner_task: str,
        owner_branch: str = "",
    ) -> ActiveLease:
        if self._open():
            raise LeaseError("a production work lease already exists")
        expires = self.now + dt.timedelta(seconds=self.ttl_seconds)
        document = {
            "schema": SCHEMA,
            "lease_issue": 0,
            "state": "active",
            "kind": kind,
            "incident": incident,
            "incident_fingerprint": fingerprint,
            "production_sha": production_sha,
            "deployment_run_id": deployment_run_id,
            "repair_sha": "",
            "owner_task": owner_task,
            "owner_branch": owner_branch,
            "owner_pr": 0,
            "head_sha": "",
            "phase": "claimed",
            "workflow_runs": {},
            "heartbeat_at": timestamp(self.now),
            "expires_at": timestamp(expires),
            "generation": 1,
            "handoff_reason": "",
            "health_evidence": "",
        }
        validate_lease(document)
        self.store.ensure_label(
            LEASE_LABEL,
            "b60205",
            "Machine-managed exclusive lease for automated delivery and repair",
        )
        created = self.store.create_issue(
            f"[production-work-lease] {fingerprint[:12]}",
            render_body(document),
            [LEASE_LABEL],
        )
        number = positive_int(created.get("number"), "created issue number")
        document["lease_issue"] = number
        self.store.update_issue(number, render_body(document))
        try:
            active = self.current()
        except LeaseError:
            self.store.comment(
                number,
                "Lease acquisition failed closed because ownership was not unique.",
            )
            self.store.update_issue(number, render_body(document), state="closed")
            raise
        if active.issue.get("number") != number:
            self.store.update_issue(number, render_body(document), state="closed")
            raise LeaseError("another owner won production work lease acquisition")
        return active

    def verify(self, expected: dict[str, Any]) -> ActiveLease:
        active = self.current()
        document = active.document
        if document["state"] != "active" or document["phase"] == "failed":
            raise LeaseError("production work lease is not active")
        for field, value in expected.items():
            if value in (None, ""):
                continue
            if document.get(field) != value:
                raise LeaseError(
                    f"lease {field} mismatch expected={value} "
                    f"actual={document.get(field)}"
                )
        return active

    def _owned(self, owner_task: str, *, include_expired: bool = False) -> ActiveLease:
        active = self.current(include_expired=include_expired)
        if active.document["owner_task"] != owner_task:
            raise LeaseError("lease belongs to another task")
        return active

    def _update(
        self,
        active: ActiveLease,
        updates: dict[str, Any],
        *,
        heartbeat: bool = True,
    ) -> ActiveLease:
        document = dict(active.document)
        document["workflow_runs"] = dict(active.document["workflow_runs"])
        document.update(updates)
        document["generation"] = active.document["generation"] + 1
        if heartbeat:
            document["heartbeat_at"] = timestamp(self.now)
            document["expires_at"] = timestamp(
                self.now + dt.timedelta(seconds=self.ttl_seconds)
            )
        validate_lease(document)
        number = positive_int(active.issue["number"], "issue.number")
        current_issue = self.store.list_open_by_label(LEASE_LABEL)
        matching = [item for item in current_issue if item.get("number") == number]
        if len(matching) != 1 or matching[0].get("body") != active.issue.get("body"):
            raise LeaseError("lease changed before compare-and-update")
        updated = self.store.update_issue(number, render_body(document))
        latest = self.current(include_expired=True)
        if latest.issue.get("number") != number or latest.document != document:
            raise LeaseError("lease changed while updating")
        return latest

    def register(
        self, owner_task: str, owner_branch: str, head_sha: str
    ) -> ActiveLease:
        active = self._owned(owner_task)
        return self._update(
            active,
            {
                "owner_branch": owner_branch,
                "head_sha": head_sha,
                "phase": "coding",
            },
        )

    def bind_pr(
        self, owner_task: str, owner_pr: int, owner_branch: str, head_sha: str
    ) -> ActiveLease:
        active = self._owned(owner_task)
        return self._update(
            active,
            {
                "owner_pr": owner_pr,
                "owner_branch": owner_branch,
                "head_sha": head_sha,
                "phase": "review",
            },
        )

    def heartbeat(self, owner_task: str) -> ActiveLease:
        return self._update(self._owned(owner_task), {})

    def transition(
        self,
        owner_task: str,
        phase: str,
        *,
        repair_sha: str = "",
        owner_pr: int | None = None,
        owner_branch: str | None = None,
        head_sha: str | None = None,
        workflow_runs: dict[str, int] | None = None,
    ) -> ActiveLease:
        active = self._owned(owner_task)
        updates: dict[str, Any] = {"phase": phase}
        if repair_sha:
            updates["repair_sha"] = repair_sha
        if owner_pr is not None:
            updates["owner_pr"] = owner_pr
        if owner_branch is not None:
            updates["owner_branch"] = owner_branch
        if head_sha is not None:
            updates["head_sha"] = head_sha
        if workflow_runs:
            runs = dict(active.document["workflow_runs"])
            runs.update(workflow_runs)
            updates["workflow_runs"] = runs
        return self._update(active, updates)

    def mark_failed(self, owner_task: str, reason: str) -> ActiveLease:
        if not reason or len(reason) > 500:
            raise LeaseError("failure reason is malformed")
        active = self._owned(owner_task)
        return self._update(
            active,
            {"state": "failed", "phase": "failed", "handoff_reason": reason},
        )

    def handoff(
        self, previous_owner: str, new_owner: str, reason: str, confirmed: bool
    ) -> ActiveLease:
        if not confirmed:
            raise LeaseError("expired handoff requires confirmed absence of active work")
        active = self._owned(previous_owner, include_expired=True)
        if active.document["state"] != "active":
            raise LeaseError("failed or released leases require human resolution")
        if parse_timestamp(active.document["expires_at"], "expires_at") > self.now:
            raise LeaseError("lease heartbeat has not expired")
        if not reason or len(reason) > 500:
            raise LeaseError("handoff reason is malformed")
        self.store.comment(
            active.issue["number"],
            f"Explicit handoff from `{previous_owner}` to `{new_owner}`: {reason}",
        )
        return self._update(
            active,
            {
                "owner_task": new_owner,
                "owner_branch": "",
                "owner_pr": 0,
                "head_sha": "",
                "phase": "claimed",
                "handoff_reason": reason,
            },
        )

    def release(
        self, owner_task: str, health_evidence: str, confirmed_healthy: bool
    ) -> ActiveLease:
        if not confirmed_healthy:
            raise LeaseError("lease release requires sustained health evidence")
        if not health_evidence or len(health_evidence) > 500:
            raise LeaseError("health evidence is malformed")
        active = self._owned(owner_task)
        if active.document["phase"] != "validation":
            raise LeaseError("lease can be released only after validation")
        updated = self._update(
            active,
            {"state": "released", "health_evidence": health_evidence},
        )
        self.store.comment(
            updated.issue["number"],
            f"Lease released after sustained health proof: {health_evidence}",
        )
        closed = self.store.update_issue(
            updated.issue["number"], render_body(updated.document), state="closed"
        )
        return ActiveLease(closed, updated.document)


class GhIssueStore:
    def __init__(self, repository: str):
        if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
            raise LeaseError("repository must be owner/name")
        self.repository = repository

    def _api(
        self,
        endpoint: str,
        *,
        method: str = "GET",
        payload: dict[str, Any] | None = None,
        check: bool = True,
    ) -> Any:
        command = ["gh", "api"]
        if method != "GET":
            command += ["--method", method]
        command.append(endpoint)
        if payload is not None:
            command += ["--input", "-"]
        result = subprocess.run(
            command,
            input=None if payload is None else json.dumps(payload),
            text=True,
            capture_output=True,
            check=False,
        )
        if check and result.returncode != 0:
            detail = result.stderr.strip().splitlines()[-1:] or ["GitHub API error"]
            raise LeaseError(detail[0])
        if result.returncode != 0:
            return None
        if not result.stdout.strip():
            return {}
        try:
            return json.loads(result.stdout)
        except json.JSONDecodeError as error:
            raise LeaseError("GitHub API returned invalid JSON") from error

    def ensure_label(self, name: str, color: str, description: str) -> None:
        encoded = urllib.parse.quote(name, safe="")
        existing = self._api(
            f"repos/{self.repository}/labels/{encoded}", check=False
        )
        if existing is None:
            self._api(
                f"repos/{self.repository}/labels",
                method="POST",
                payload={"name": name, "color": color, "description": description},
            )
            return
        if (
            existing.get("name") != name
            or existing.get("color", "").lower() != color.lower()
        ):
            raise LeaseError(f"existing label {name} differs from lease policy")

    def list_open_by_label(self, label: str) -> list[dict[str, Any]]:
        encoded = urllib.parse.quote(label, safe="")
        result = self._api(
            f"repos/{self.repository}/issues?state=open&labels={encoded}&per_page=100"
        )
        if not isinstance(result, list):
            raise LeaseError("GitHub issue query did not return a list")
        return result

    def create_issue(
        self, title: str, body: str, labels: list[str]
    ) -> dict[str, Any]:
        result = self._api(
            f"repos/{self.repository}/issues",
            method="POST",
            payload={"title": title, "body": body, "labels": labels},
        )
        if not isinstance(result, dict):
            raise LeaseError("GitHub issue creation response is malformed")
        return result

    def update_issue(
        self, number: int, body: str, state: str | None = None
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {"body": body}
        if state is not None:
            payload["state"] = state
        result = self._api(
            f"repos/{self.repository}/issues/{number}",
            method="PATCH",
            payload=payload,
        )
        if not isinstance(result, dict):
            raise LeaseError("GitHub issue update response is malformed")
        return result

    def comment(self, number: int, body: str) -> None:
        self._api(
            f"repos/{self.repository}/issues/{number}/comments",
            method="POST",
            payload={"body": body},
        )


def add_expected_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--kind", choices=("delivery", "repair"))
    parser.add_argument("--incident", type=int)
    parser.add_argument("--fingerprint")
    parser.add_argument("--production-sha")
    parser.add_argument("--deployment-run-id", type=int)
    parser.add_argument("--owner-task")
    parser.add_argument("--owner-branch")
    parser.add_argument("--owner-pr", type=int)
    parser.add_argument("--head-sha")
    parser.add_argument("--repair-sha")


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser()
    root.add_argument("--repository", default="vasilyevstan/betstan")
    root.add_argument("--ttl-seconds", type=int, default=3600)
    commands = root.add_subparsers(dest="command", required=True)

    acquire = commands.add_parser("acquire")
    acquire.add_argument("--kind", required=True, choices=("delivery", "repair"))
    acquire.add_argument("--incident", required=True, type=int)
    acquire.add_argument("--fingerprint", required=True)
    acquire.add_argument("--production-sha", required=True)
    acquire.add_argument("--deployment-run-id", required=True, type=int)
    acquire.add_argument("--owner-task", required=True)
    acquire.add_argument("--initial-branch", default="")

    verify = commands.add_parser("verify")
    add_expected_arguments(verify)

    register = commands.add_parser("register")
    register.add_argument("--owner-task", required=True)
    register.add_argument("--owner-branch", required=True)
    register.add_argument("--head-sha", required=True)

    bind = commands.add_parser("bind-pr")
    bind.add_argument("--owner-task", required=True)
    bind.add_argument("--owner-pr", required=True, type=int)
    bind.add_argument("--owner-branch", required=True)
    bind.add_argument("--head-sha", required=True)

    heartbeat = commands.add_parser("heartbeat")
    heartbeat.add_argument("--owner-task", required=True)

    transition = commands.add_parser("transition")
    transition.add_argument("--owner-task", required=True)
    transition.add_argument("--phase", required=True, choices=sorted(PHASES - {"failed"}))
    transition.add_argument("--repair-sha", default="")
    transition.add_argument("--owner-pr", type=int)
    transition.add_argument("--owner-branch")
    transition.add_argument("--head-sha")
    transition.add_argument("--workflow-run", action="append", default=[])

    failed = commands.add_parser("mark-failed")
    failed.add_argument("--owner-task", required=True)
    failed.add_argument("--reason", required=True)

    handoff = commands.add_parser("handoff-expired")
    handoff.add_argument("--previous-owner", required=True)
    handoff.add_argument("--new-owner", required=True)
    handoff.add_argument("--reason", required=True)
    handoff.add_argument("--confirmed-no-active-work", action="store_true")

    release = commands.add_parser("release")
    release.add_argument("--owner-task", required=True)
    release.add_argument("--health-evidence", required=True)
    release.add_argument("--confirmed-healthy", action="store_true")

    commands.add_parser("inspect")
    return root


def expected_from_args(args: argparse.Namespace) -> dict[str, Any]:
    mapping = {
        "kind": args.kind,
        "incident": args.incident,
        "incident_fingerprint": args.fingerprint,
        "production_sha": args.production_sha,
        "deployment_run_id": args.deployment_run_id,
        "owner_task": args.owner_task,
        "owner_branch": args.owner_branch,
        "owner_pr": args.owner_pr,
        "head_sha": args.head_sha,
        "repair_sha": args.repair_sha,
    }
    return {key: value for key, value in mapping.items() if value not in (None, "")}


def parse_workflow_runs(values: list[str]) -> dict[str, int]:
    result: dict[str, int] = {}
    for value in values:
        key, separator, raw_id = value.partition("=")
        if not separator or not RUN_KEY.fullmatch(key) or key in result:
            raise LeaseError(f"invalid workflow run binding: {value}")
        result[key] = positive_int(raw_id, f"workflow run {key}")
    return result


def print_lease(active: ActiveLease) -> None:
    print(json.dumps(active.document, sort_keys=True))


def main() -> int:
    args = parser().parse_args()
    manager = LeaseManager(
        GhIssueStore(args.repository), ttl_seconds=args.ttl_seconds
    )
    try:
        if args.command == "acquire":
            active = manager.acquire(
                kind=args.kind,
                incident=args.incident,
                fingerprint=args.fingerprint,
                production_sha=args.production_sha,
                deployment_run_id=args.deployment_run_id,
                owner_task=args.owner_task,
                owner_branch=args.initial_branch,
            )
        elif args.command == "verify":
            active = manager.verify(expected_from_args(args))
        elif args.command == "register":
            active = manager.register(args.owner_task, args.owner_branch, args.head_sha)
        elif args.command == "bind-pr":
            active = manager.bind_pr(
                args.owner_task, args.owner_pr, args.owner_branch, args.head_sha
            )
        elif args.command == "heartbeat":
            active = manager.heartbeat(args.owner_task)
        elif args.command == "transition":
            active = manager.transition(
                args.owner_task,
                args.phase,
                repair_sha=args.repair_sha,
                owner_pr=args.owner_pr,
                owner_branch=args.owner_branch,
                head_sha=args.head_sha,
                workflow_runs=parse_workflow_runs(args.workflow_run),
            )
        elif args.command == "mark-failed":
            active = manager.mark_failed(args.owner_task, args.reason)
        elif args.command == "handoff-expired":
            active = manager.handoff(
                args.previous_owner,
                args.new_owner,
                args.reason,
                args.confirmed_no_active_work,
            )
        elif args.command == "release":
            active = manager.release(
                args.owner_task, args.health_evidence, args.confirmed_healthy
            )
        elif args.command == "inspect":
            active = manager.current(include_expired=True)
        else:
            raise LeaseError("unsupported command")
    except LeaseError as error:
        print(f"production_work_lease=FAIL reason={error}", file=sys.stderr)
        return 1
    print_lease(active)
    print(
        f"production_work_lease=PASS action={args.command} "
        f"issue={active.document['lease_issue']} phase={active.document['phase']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
