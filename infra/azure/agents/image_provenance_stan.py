#!/usr/bin/env python3
import argparse
import re
from pathlib import Path


EXPECTED_REPOSITORIES = {
    "auth": "stanvasilyev/gaming_auth",
    "bet": "stanvasilyev/gaming_bet",
    "backoffice": "stanvasilyev/gaming_backoffice",
    "client": "stanvasilyev/gaming_client",
    "event": "stanvasilyev/gaming_event",
    "gamemaster": "stanvasilyev/gaming_gamemaster",
    "moderation": "stanvasilyev/gaming_moderation",
    "resulting": "stanvasilyev/gaming_resulting",
    "slip": "stanvasilyev/gaming_slip",
}
EXPECTED_KEYS = {
    "service",
    "repository",
    "image_sha",
    "digest",
    "image_ref",
    "build_run_id",
    "build_run_attempt",
}
SHA_PATTERN = re.compile(r"^[0-9a-f]{40}$")
DIGEST_PATTERN = re.compile(r"^sha256:[0-9a-f]{64}$")
RUN_ID_PATTERN = re.compile(r"^[1-9][0-9]*$")


class ProvenanceError(ValueError):
    pass


def parse_record(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        key, separator, value = line.partition("=")
        if not separator or not key or not value:
            raise ProvenanceError(f"{path}:{line_number}: expected key=value")
        if key in values:
            raise ProvenanceError(f"{path}:{line_number}: duplicate key {key}")
        values[key] = value

    missing = EXPECTED_KEYS - values.keys()
    extra = values.keys() - EXPECTED_KEYS
    if missing or extra:
        raise ProvenanceError(
            f"{path}: invalid keys missing={sorted(missing)} extra={sorted(extra)}"
        )
    return values


def validate_records(
    directory: Path, image_sha: str, build_run_id: str, build_run_attempt: str
) -> list[tuple[str, str, str, str]]:
    if not SHA_PATTERN.fullmatch(image_sha):
        raise ProvenanceError("image SHA must be a full lowercase 40-character SHA")
    if not RUN_ID_PATTERN.fullmatch(build_run_id):
        raise ProvenanceError("build run ID must be a positive integer")
    if build_run_attempt != "1":
        raise ProvenanceError("only first-attempt production builds are deployable")

    paths = sorted(directory.rglob("*.env"))
    if len(paths) != len(EXPECTED_REPOSITORIES):
        raise ProvenanceError(
            f"expected {len(EXPECTED_REPOSITORIES)} records, found {len(paths)}"
        )

    records: dict[str, tuple[str, str, str, str]] = {}
    for path in paths:
        values = parse_record(path)
        service = values["service"]
        if service not in EXPECTED_REPOSITORIES:
            raise ProvenanceError(f"{path}: unexpected service {service}")
        if service in records:
            raise ProvenanceError(f"{path}: duplicate service {service}")

        repository = EXPECTED_REPOSITORIES[service]
        digest = values["digest"]
        expected_ref = f"{repository}:{image_sha}@{digest}"
        expected_values = {
            "repository": repository,
            "image_sha": image_sha,
            "image_ref": expected_ref,
            "build_run_id": build_run_id,
            "build_run_attempt": build_run_attempt,
        }
        for key, expected in expected_values.items():
            if values[key] != expected:
                raise ProvenanceError(
                    f"{path}: {key}={values[key]!r}, expected {expected!r}"
                )
        if not DIGEST_PATTERN.fullmatch(digest):
            raise ProvenanceError(f"{path}: invalid OCI digest {digest!r}")

        records[service] = (service, repository, expected_ref, digest)

    missing_services = EXPECTED_REPOSITORIES.keys() - records.keys()
    if missing_services:
        raise ProvenanceError(f"missing services: {sorted(missing_services)}")

    return [records[service] for service in EXPECTED_REPOSITORIES]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--directory", required=True, type=Path)
    parser.add_argument("--image-sha", required=True)
    parser.add_argument("--build-run-id", required=True)
    parser.add_argument("--build-run-attempt", required=True)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    rows = validate_records(
        args.directory,
        args.image_sha,
        args.build_run_id,
        args.build_run_attempt,
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        "".join("\t".join(row) + "\n" for row in rows),
        encoding="utf-8",
    )
    print(f"image_provenance=PASS count={len(rows)}")


if __name__ == "__main__":
    main()
