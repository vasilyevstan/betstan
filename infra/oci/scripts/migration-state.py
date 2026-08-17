#!/usr/bin/env python3
"""Create, compare, and resource-version mutate migration ConfigMaps."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def assignments(values: list[str]) -> dict[str, str]:
    result: dict[str, str] = {}
    for value in values:
        key, separator, item = value.partition("=")
        if not separator or not key:
            raise SystemExit(f"invalid assignment: {value}")
        result[key] = item
    return result


def load(path: str) -> dict:
    with Path(path).open(encoding="utf-8") as stream:
        document = json.load(stream)
    if not isinstance(document, dict) or not isinstance(document.get("data"), dict):
        raise SystemExit(f"{path}: ConfigMap data is missing")
    return document


def main() -> int:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="action", required=True)

    create = subparsers.add_parser("create")
    create.add_argument("--name", required=True)
    create.add_argument("--namespace", required=True)
    create.add_argument("--set", action="append", default=[])

    compare = subparsers.add_parser("compare")
    compare.add_argument("left")
    compare.add_argument("right")

    value = subparsers.add_parser("value")
    value.add_argument("file")
    value.add_argument("key")

    mutate = subparsers.add_parser("mutate")
    mutate.add_argument("file")
    mutate.add_argument("--expect", action="append", default=[])
    mutate.add_argument("--set", action="append", default=[])

    mirror = subparsers.add_parser("mirror")
    mirror.add_argument("source")
    mirror.add_argument("target")
    mirror.add_argument("--expect-target", action="append", default=[])

    summary = subparsers.add_parser("summary")
    summary.add_argument("file")

    args = parser.parse_args()
    if args.action == "create":
        document = {
            "apiVersion": "v1",
            "kind": "ConfigMap",
            "metadata": {"name": args.name, "namespace": args.namespace},
            "data": assignments(args.set),
        }
        json.dump(document, sys.stdout, sort_keys=True)
        return 0

    if args.action == "compare":
        left = load(args.left)["data"]
        right = load(args.right)["data"]
        if left != right:
            raise SystemExit("mirrored ConfigMap data differs")
        return 0

    if args.action == "value":
        data = load(args.file)["data"]
        if args.key not in data:
            raise SystemExit(f"missing ConfigMap key: {args.key}")
        print(data[args.key])
        return 0

    if args.action == "mutate":
        document = load(args.file)
        data = document["data"]
        for key, expected in assignments(args.expect).items():
            if data.get(key) != expected:
                raise SystemExit(f"compare-and-swap mismatch for {key}")
        data.update(assignments(args.set))
        metadata = document.setdefault("metadata", {})
        metadata.pop("managedFields", None)
        document.pop("status", None)
        json.dump(document, sys.stdout, sort_keys=True)
        return 0

    if args.action == "mirror":
        source = load(args.source)
        target = load(args.target)
        for key, expected in assignments(args.expect_target).items():
            if target["data"].get(key) != expected:
                raise SystemExit(f"mirror target mismatch for {key}")
        target["data"] = source["data"]
        metadata = target.setdefault("metadata", {})
        metadata.pop("managedFields", None)
        target.pop("status", None)
        json.dump(target, sys.stdout, sort_keys=True)
        return 0

    data = load(args.file)["data"]
    allowed = (
        "schema-version",
        "journal-id",
        "original-source-sha",
        "migration-id",
        "owner-run-id",
        "owner-run-attempt",
        "fencing-token",
        "sequence",
        "phase",
        "heartbeat-epoch",
        "destructive-boundary",
        "recovery-required",
        "azure-cluster-fingerprint",
        "oci-cluster-fingerprint",
        "azure-baseline-sha256",
        "oci-baseline-sha256",
        "database-count",
        "logical-parity",
        "signature-manifest-sha256",
        "target-signature-manifest-sha256",
        "transfer-manifest-sha256",
    )
    for key in allowed:
        if key in data:
            print(f"{key}={data[key]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
