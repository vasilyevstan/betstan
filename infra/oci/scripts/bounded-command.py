#!/usr/bin/env python3
"""Run one external command with a hard deadline and classified retries."""

from __future__ import annotations

import argparse
import os
import signal
import subprocess
import sys
import time

ACTIVE_PROCESS: subprocess.Popen[bytes] | None = None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--timeout-seconds", type=int, required=True)
    parser.add_argument("--attempts", type=int, required=True)
    parser.add_argument("--classification", required=True)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.command[:1] == ["--"]:
        args.command = args.command[1:]
    if args.timeout_seconds < 1 or args.attempts < 1 or not args.command:
        parser.error("positive timeout, attempts, and a command are required")
    return args


def terminate(process: subprocess.Popen[bytes]) -> None:
    try:
        os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=5)
    except (ProcessLookupError, subprocess.TimeoutExpired):
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait()

def handle_termination(signum: int, _frame: object) -> None:
    process = ACTIVE_PROCESS
    if process is not None and process.poll() is None:
        terminate(process)
    raise SystemExit(128 + signum)


def main() -> int:
    global ACTIVE_PROCESS
    args = parse_args()
    signal.signal(signal.SIGINT, handle_termination)
    signal.signal(signal.SIGTERM, handle_termination)
    for attempt in range(1, args.attempts + 1):
        process = subprocess.Popen(
            args.command,
            stdin=None,
            stdout=None,
            stderr=None,
            start_new_session=True,
        )
        ACTIVE_PROCESS = process
        try:
            try:
                return_code = process.wait(timeout=args.timeout_seconds)
            except subprocess.TimeoutExpired:
                terminate(process)
                return_code = 124
        finally:
            if process.poll() is None:
                terminate(process)
            ACTIVE_PROCESS = None

        if return_code == 0:
            return 0
        if attempt == args.attempts:
            print(
                "bounded_command=FAIL "
                f"classification={args.classification} "
                f"attempt={attempt}/{args.attempts} status={return_code}",
                file=sys.stderr,
            )
            return return_code
        print(
            "bounded_command=RETRY "
            f"classification={args.classification} "
            f"attempt={attempt}/{args.attempts} status={return_code}",
            file=sys.stderr,
        )
        time.sleep(min(attempt * 2, 10))
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
