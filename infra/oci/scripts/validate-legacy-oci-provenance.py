#!/usr/bin/env python3

import re
import sys
from pathlib import Path


SERVICES = (
    "auth",
    "bet",
    "backoffice",
    "client",
    "event",
    "gamemaster",
    "moderation",
    "resulting",
    "slip",
)
DIGEST_PATTERN = re.compile(r"sha256:[0-9a-f]{64}")
REPOSITORY_PATTERN = re.compile(r"[a-z0-9.-]+\.ocir\.io/[a-z0-9._/-]+")


def die(message):
    raise SystemExit(message)


def read_env(path):
    if not path.is_file() or path.is_symlink():
        die(f"historical provenance is missing or unsafe: {path.name}")
    values = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        if not raw or "=" not in raw:
            die(f"historical provenance is malformed: {path.name}")
        key, value = raw.split("=", 1)
        if key in values or not re.fullmatch(r"[a-z][a-z0-9_]*", key):
            die(f"historical provenance keys are invalid: {path.name}")
        values[key] = value
    return values


def validate(directory, source_sha, build_run_id):
    chain = read_env(directory / "build-chain.txt")
    chain_keys = {
        "source_sha",
        "upstream_workflow",
        "upstream_run_id",
        "upstream_run_attempt",
        "build_run_id",
        "build_run_attempt",
        "image_mode",
        "platform",
    }
    if chain.get("image_mode") == "reuse":
        chain_keys |= {"reuse_source_sha", "reuse_build_run_id"}
    elif chain.get("image_mode") != "build":
        die("historical build chain has an invalid image mode")
    if set(chain) != chain_keys:
        die("historical build chain key set is invalid")
    if not (
        chain["source_sha"] == source_sha
        and chain["upstream_workflow"] == "production-build"
        and re.fullmatch(r"[1-9][0-9]*", chain["upstream_run_id"])
        and chain["upstream_run_attempt"] == "1"
        and chain["build_run_id"] == build_run_id
        and chain["build_run_attempt"] == "1"
        and chain["platform"] == "linux/arm64"
    ):
        die("historical build chain does not match the selected run")
    if chain["image_mode"] == "reuse" and not (
        re.fullmatch(r"[0-9a-f]{40}", chain["reuse_source_sha"])
        and re.fullmatch(r"[1-9][0-9]*", chain["reuse_build_run_id"])
    ):
        die("historical reuse chain is invalid")

    service_keys = {
        "service",
        "repository",
        "source_sha",
        "tag",
        "digest",
        "platform_digest",
        "image_ref",
        "platform",
        "build_run_id",
        "build_run_attempt",
    }
    if chain["image_mode"] == "reuse":
        service_keys |= {"reuse_source_sha", "reuse_build_run_id"}
    for service in SERVICES:
        values = read_env(directory / f"{service}.env")
        if set(values) != service_keys:
            die(f"historical service key set is invalid: {service}")
        repository = values["repository"]
        digest = values["digest"]
        platform_digest = values["platform_digest"]
        if not (
            values["service"] == service
            and REPOSITORY_PATTERN.fullmatch(repository)
            and values["source_sha"] == source_sha
            and values["tag"] == f"{repository}:oci-{service}-{source_sha}"
            and DIGEST_PATTERN.fullmatch(digest)
            and DIGEST_PATTERN.fullmatch(platform_digest)
            and values["image_ref"] == f"{repository}@{digest}"
            and values["platform"] == "linux/arm64"
            and values["build_run_id"] == build_run_id
            and values["build_run_attempt"] == "1"
        ):
            die(f"historical service provenance is invalid: {service}")
        if chain["image_mode"] == "reuse" and not (
            values["reuse_source_sha"] == chain["reuse_source_sha"]
            and values["reuse_build_run_id"] == chain["reuse_build_run_id"]
        ):
            die(f"historical reuse provenance differs: {service}")
    return chain["upstream_run_id"]


def main():
    if len(sys.argv) != 4:
        die(
            "usage: validate-legacy-oci-provenance.py "
            "<provenance-dir> <source-sha> <build-run-id>"
        )
    directory = Path(sys.argv[1])
    source_sha = sys.argv[2]
    build_run_id = sys.argv[3]
    if (
        not directory.is_dir()
        or directory.is_symlink()
        or not re.fullmatch(r"[0-9a-f]{40}", source_sha)
        or not re.fullmatch(r"[1-9][0-9]*", build_run_id)
    ):
        die("historical provenance inputs are invalid")
    upstream_run_id = validate(directory, source_sha, build_run_id)
    print(f"TRUSTED_UPSTREAM_RUN_ID={upstream_run_id}")


if __name__ == "__main__":
    main()
