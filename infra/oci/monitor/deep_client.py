#!/usr/bin/env python3
"""Fetch one bounded OIDC-authenticated deep production observation."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

from contracts import ContractError, SHA


MAX_TOKEN_BYTES = 16384
MAX_DEEP_BYTES = 262144
DIAGNOSTIC_HOST = re.compile(
    r"^(?:[0-9]{1,3}\.){3}[0-9]{1,3}\.nip\.io$"
)


def _read_bounded(response, maximum: int) -> bytes:
    payload = response.read(maximum + 1)
    if len(payload) > maximum:
        raise ContractError("response exceeded its size limit")
    return payload


def validate_endpoint(value: str) -> str:
    parsed = urllib.parse.urlparse(value)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or not DIAGNOSTIC_HOST.fullmatch(parsed.hostname)
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or parsed.path not in {"", "/"}
    ):
        raise ContractError("diagnostic URL is outside the reviewed host contract")
    return value.rstrip("/")


def request_oidc_token(audience: str) -> str:
    request_url = os.environ.get("ACTIONS_ID_TOKEN_REQUEST_URL", "")
    request_token = os.environ.get("ACTIONS_ID_TOKEN_REQUEST_TOKEN", "")
    if not request_url.startswith("https://") or not request_token:
        raise ContractError("GitHub OIDC request context is unavailable")
    separator = "&" if "?" in request_url else "?"
    url = f"{request_url}{separator}{urllib.parse.urlencode({'audience': audience})}"
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/json",
            "Authorization": f"Bearer {request_token}",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            payload = json.loads(_read_bounded(response, MAX_TOKEN_BYTES))
    except (OSError, ValueError) as error:
        raise ContractError("GitHub OIDC token request failed") from error
    value = payload.get("value") if isinstance(payload, dict) else None
    if not isinstance(value, str) or not value or len(value) > MAX_TOKEN_BYTES:
        raise ContractError("GitHub OIDC token response is malformed")
    return value


def fetch_deep(endpoint: str, audience: str, source_sha: str) -> dict:
    if not SHA.fullmatch(source_sha):
        raise ContractError("workflow source SHA is malformed")
    token = request_oidc_token(audience)
    request = urllib.request.Request(
        f"{validate_endpoint(endpoint)}/__betstan/monitor/v1/observation",
        headers={
            "Accept": "application/json",
            "Authorization": f"Bearer {token}",
            "User-Agent": "betstan-production-monitor/1",
            "X-Betstan-Workflow-Sha": source_sha,
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            if response.status != 200:
                raise ContractError("deep-health exporter returned a failure")
            payload = json.loads(_read_bounded(response, MAX_DEEP_BYTES))
    except (OSError, ValueError) as error:
        raise ContractError("deep-health exporter request failed") from error
    if not isinstance(payload, dict):
        raise ContractError("deep-health exporter response is malformed")
    return payload


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--endpoint", required=True)
    parser.add_argument("--audience", required=True)
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    try:
        payload = fetch_deep(args.endpoint, args.audience, args.source_sha)
        Path(args.output).write_text(
            json.dumps(payload, sort_keys=True, separators=(",", ":")) + "\n",
            encoding="utf-8",
        )
    except ContractError as error:
        print(f"production_deep_health=UNKNOWN reason={error}", file=sys.stderr)
        return 2
    print("production_deep_health=PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
