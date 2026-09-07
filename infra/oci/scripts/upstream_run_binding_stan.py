#!/usr/bin/env python3
"""Validate protected upstream run bindings.

A protected operation may depend on an exact upstream run (for example the
capacity acquisition or GHCR build that must precede an infrastructure
finalization). Protected authority is one-use, so those dependencies must be
proven before any authority is issued and before any cloud access, and the
identical rules must apply whether the operation is dispatched through the CLI
or executed directly by GitHub Actions.

This module is the single implementation of those rules. The dispatcher and the
workflow both call it with bindings taken from the same policy definition, so
the two paths cannot drift.
"""

import argparse
import json
import re
import subprocess
import sys

FULL_SHA = re.compile(r"^[0-9a-f]{40}$")
POSITIVE_INTEGER = re.compile(r"^[1-9][0-9]*$")
REPOSITORY = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
ALLOWED_BINDING_KEYS = {
    "input",
    "workflow",
    "titleTemplates",
    "artifactTemplate",
}


def fail(message):
    print(f"upstream binding rejected: {message}", file=sys.stderr)
    raise SystemExit(1)


def gh_api(path):
    result = subprocess.run(
        ["gh", "api", path],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        fail(f"unable to read {path}")
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        fail(f"malformed response for {path}")


def substitute(template, subject_sha, run_id):
    return template.replace("{subject_sha}", subject_sha).replace(
        "{run_id}", run_id
    )


def validate_binding_shape(binding):
    if not isinstance(binding, dict):
        fail("binding must be an object")
    unexpected = set(binding) - ALLOWED_BINDING_KEYS
    if unexpected:
        fail(f"binding has unsupported keys: {sorted(unexpected)}")
    for key in ("input", "workflow", "titleTemplates", "artifactTemplate"):
        if key not in binding:
            fail(f"binding is missing {key}")
    if not isinstance(binding["input"], str) or not binding["input"]:
        fail("binding input must be a non-empty string")
    if not isinstance(binding["workflow"], str) or not binding[
        "workflow"
    ].endswith(".yml"):
        fail("binding workflow must be a .yml workflow file name")
    titles = binding["titleTemplates"]
    if not isinstance(titles, dict) or not titles:
        fail("binding must declare at least one permitted event title")
    artifact = binding["artifactTemplate"]
    if not isinstance(artifact, str) or not artifact:
        fail("binding must declare an artifact template")
    for event, template in titles.items():
        if not isinstance(event, str) or not event:
            fail("binding event names must be non-empty strings")
        if template is None:
            # A null title is only acceptable when the artifact itself binds
            # both the subject SHA and the exact run, which is a stronger
            # identity than a title that embeds an unpredictable upstream ID.
            if "{subject_sha}" not in artifact or "{run_id}" not in artifact:
                fail(
                    f"event {event} has no stable title, so its artifact "
                    "template must bind both subject SHA and run ID"
                )
            continue
        if not isinstance(template, str) or not template:
            fail(f"binding title for {event} must be a non-empty string or null")


def validate_binding(repository, binding, subject_sha, run_id):
    validate_binding_shape(binding)
    if not REPOSITORY.fullmatch(repository):
        fail("repository must be owner/name")
    if not FULL_SHA.fullmatch(subject_sha):
        fail("subject SHA must be a full lowercase commit SHA")
    if not POSITIVE_INTEGER.fullmatch(run_id):
        fail(f"{binding['input']} must be a positive run ID")

    workflow = gh_api(
        f"repos/{repository}/actions/workflows/{binding['workflow']}"
    )
    workflow_id = workflow.get("id")
    if not isinstance(workflow_id, int):
        fail(f"unable to resolve workflow ID for {binding['workflow']}")

    # The base run endpoint reports the CURRENT attempt. Reading only
    # /attempts/1 is tautological: a rerun still exposes a first attempt, so a
    # rerun upstream would pass. Reject anything whose current attempt is not 1.
    base = gh_api(f"repos/{repository}/actions/runs/{run_id}")
    if base.get("run_attempt") != 1:
        fail(
            f"{binding['input']} run {run_id} has been rerun "
            f"(current attempt {base.get('run_attempt')})"
        )

    expected_path = f".github/workflows/{binding['workflow']}"
    checks = {
        "workflow_id": (base.get("workflow_id"), workflow_id),
        "path": (base.get("path"), expected_path),
        "repository": (
            (base.get("head_repository") or {}).get("full_name"),
            repository,
        ),
        "head_branch": (base.get("head_branch"), "master"),
        "head_sha": (base.get("head_sha"), subject_sha),
        "status": (base.get("status"), "completed"),
        "conclusion": (base.get("conclusion"), "success"),
    }
    for label, (observed, expected) in checks.items():
        if observed != expected:
            fail(
                f"{binding['input']} run {run_id} {label} is {observed!r}, "
                f"expected {expected!r}"
            )

    event = base.get("event")
    titles = binding["titleTemplates"]
    if event not in titles:
        fail(
            f"{binding['input']} run {run_id} event {event!r} is not permitted; "
            f"permitted events are {sorted(titles)}"
        )
    template = titles[event]
    if template is not None:
        expected_title = substitute(template, subject_sha, run_id)
        if base.get("display_title") != expected_title:
            fail(
                f"{binding['input']} run {run_id} title "
                f"{base.get('display_title')!r} is not {expected_title!r}"
            )

    # Bind attempt 1 explicitly and confirm it is the same immutable run.
    attempt = gh_api(f"repos/{repository}/actions/runs/{run_id}/attempts/1")
    if attempt.get("run_attempt") != 1:
        fail(f"{binding['input']} first attempt is not attempt 1")
    for label in ("head_sha", "workflow_id", "conclusion", "event"):
        if attempt.get(label) != base.get(label):
            fail(
                f"{binding['input']} first attempt {label} differs from the run"
            )

    artifact_name = substitute(
        binding["artifactTemplate"], subject_sha, run_id
    )
    payload = gh_api(
        f"repos/{repository}/actions/runs/{run_id}/artifacts?per_page=100"
    )
    matches = [
        item
        for item in payload.get("artifacts", [])
        if item.get("name") == artifact_name
    ]
    if len(matches) != 1:
        fail(
            f"{binding['input']} expects exactly one {artifact_name} artifact, "
            f"found {len(matches)}"
        )
    artifact = matches[0]
    if artifact.get("expired") is not False:
        fail(f"{binding['input']} artifact {artifact_name} is expired")
    if not isinstance(artifact.get("size_in_bytes"), int) or artifact[
        "size_in_bytes"
    ] <= 0:
        fail(f"{binding['input']} artifact {artifact_name} is empty")
    return artifact_name


def command_validate(args):
    binding = json.loads(args.binding)
    name = validate_binding(
        args.repository, binding, args.subject_sha, args.run_id
    )
    print(f"upstream_binding={binding['input']} run={args.run_id} artifact={name}")


def command_validate_all(args):
    policy = json.loads(args.policy_json)
    inputs = json.loads(args.dispatch_inputs)
    bindings = policy.get("upstreamRunBindings") or []
    if not isinstance(bindings, list):
        fail("upstreamRunBindings must be a list")
    for binding in bindings:
        validate_binding_shape(binding)
        name = binding["input"]
        if name not in inputs:
            fail(f"dispatch inputs are missing bound value {name}")
        validate_binding(
            args.repository, binding, args.subject_sha, str(inputs[name])
        )
        print(f"upstream_binding={name} run={inputs[name]} status=OK")
    print(f"upstream_bindings_validated={len(bindings)}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    one = sub.add_parser("validate")
    one.add_argument("--repository", required=True)
    one.add_argument("--binding", required=True)
    one.add_argument("--subject-sha", required=True)
    one.add_argument("--run-id", required=True)
    one.set_defaults(func=command_validate)

    every = sub.add_parser("validate-all")
    every.add_argument("--repository", required=True)
    every.add_argument("--policy-json", required=True)
    every.add_argument("--subject-sha", required=True)
    every.add_argument("--dispatch-inputs", required=True)
    every.set_defaults(func=command_validate_all)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
