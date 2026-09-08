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
import datetime as dt
import io
import json
import re
import stat
import subprocess
import sys
import zipfile

FULL_SHA = re.compile(r"^[0-9a-f]{40}$")
POSITIVE_INTEGER = re.compile(r"^[1-9][0-9]*$")
REPOSITORY = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
ALLOWED_BINDING_KEYS = {
    "input",
    "workflow",
    "titleTemplates",
    "artifactTemplate",
    "artifactContent",
    "afterInput",
}
ARTIFACT_CONTENT_KEYS = {"fileName", "format", "equals"}
ARTIFACT_VALUE_TOKEN = re.compile(
    r"^\{(subject_sha|run_id|input:[A-Za-z0-9_]+)\}$"
)
MAX_ARTIFACT_ARCHIVE_BYTES = 50 * 1024 * 1024
MAX_ARTIFACT_EVIDENCE_BYTES = 1024 * 1024


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


def gh_api_pages(path):
    result = subprocess.run(
        ["gh", "api", path, "--paginate", "--slurp"],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        fail(f"unable to read all pages of {path}")
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError:
        fail(f"malformed paginated response for {path}")
    if isinstance(payload, dict):
        return [payload]
    if not isinstance(payload, list) or not all(
        isinstance(page, dict) for page in payload
    ):
        fail(f"unexpected paginated response for {path}")
    return payload


def gh_api_bytes(path):
    result = subprocess.run(
        ["gh", "api", path],
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        fail(f"unable to download {path}")
    if not result.stdout:
        fail(f"empty download for {path}")
    if len(result.stdout) > MAX_ARTIFACT_ARCHIVE_BYTES:
        fail(f"download for {path} exceeds the evidence size limit")
    return result.stdout


def parse_timestamp(value, label):
    if not isinstance(value, str) or not value:
        fail(f"{label} is missing")
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        fail(f"{label} is malformed")
    if parsed.tzinfo is None:
        fail(f"{label} has no timezone")
    return parsed


def substitute(template, subject_sha, run_id):
    return template.replace("{subject_sha}", subject_sha).replace(
        "{run_id}", run_id
    )


def resolve_artifact_value(value, subject_sha, run_id, dispatch_inputs):
    if not isinstance(value, str):
        return value
    token = ARTIFACT_VALUE_TOKEN.fullmatch(value)
    if token is None:
        return value
    name = token.group(1)
    if name == "subject_sha":
        return subject_sha
    if name == "run_id":
        return run_id
    input_name = name.split(":", 1)[1]
    if input_name not in dispatch_inputs:
        fail(f"artifact content references missing input {input_name}")
    return dispatch_inputs[input_name]


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
    after_input = binding.get("afterInput")
    if after_input is not None and (
        not isinstance(after_input, str)
        or not after_input
        or after_input == binding["input"]
    ):
        fail("binding afterInput must name a different non-empty input")
    artifact_content = binding.get("artifactContent")
    if artifact_content is not None:
        if (
            not isinstance(artifact_content, dict)
            or set(artifact_content) != ARTIFACT_CONTENT_KEYS
        ):
            fail("binding artifactContent has an invalid schema")
        file_name = artifact_content["fileName"]
        if (
            not isinstance(file_name, str)
            or not file_name
            or "/" in file_name
            or "\\" in file_name
            or file_name in {".", ".."}
        ):
            fail("binding artifactContent fileName is invalid")
        if artifact_content["format"] not in {"json", "env"}:
            fail("binding artifactContent format is unsupported")
        equals = artifact_content["equals"]
        if not isinstance(equals, dict) or not equals:
            fail("binding artifactContent equals must be a non-empty object")
        for key, value in equals.items():
            if (
                not isinstance(key, str)
                or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key)
                or type(value) not in {str, int, bool}
            ):
                fail("binding artifactContent equality is invalid")
            if isinstance(value, str) and (
                ("{" in value or "}" in value)
                and ARTIFACT_VALUE_TOKEN.fullmatch(value) is None
            ):
                fail("binding artifactContent contains an invalid token")


def load_artifact_content(
    repository,
    binding,
    artifact,
    subject_sha,
    run_id,
    dispatch_inputs,
):
    content_contract = binding.get("artifactContent")
    if content_contract is None:
        return
    artifact_id = artifact.get("id")
    if type(artifact_id) is not int or artifact_id < 1:
        fail(f"{binding['input']} artifact has an invalid ID")
    archive = gh_api_bytes(
        f"repos/{repository}/actions/artifacts/{artifact_id}/zip"
    )
    try:
        with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
            infos = bundle.infolist()
            names = [info.filename for info in infos]
            if len(names) != len(set(names)):
                fail(f"{binding['input']} artifact contains duplicate paths")
            matches = []
            for info in infos:
                mode = (info.external_attr >> 16) & 0o170000
                if mode == stat.S_IFLNK:
                    fail(f"{binding['input']} artifact contains a symlink")
                path_parts = info.filename.replace("\\", "/").split("/")
                if (
                    info.filename.startswith("/")
                    or any(part == ".." for part in path_parts)
                ):
                    fail(f"{binding['input']} artifact contains an unsafe path")
                if not info.is_dir() and path_parts[-1] == content_contract[
                    "fileName"
                ]:
                    matches.append(info)
            if len(matches) != 1:
                fail(
                    f"{binding['input']} artifact expects exactly one "
                    f"{content_contract['fileName']}"
                )
            evidence_info = matches[0]
            if (
                evidence_info.file_size < 1
                or evidence_info.file_size > MAX_ARTIFACT_EVIDENCE_BYTES
            ):
                fail(f"{binding['input']} artifact evidence size is invalid")
            raw = bundle.read(evidence_info)
    except zipfile.BadZipFile:
        fail(f"{binding['input']} artifact is not a valid ZIP archive")
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        fail(f"{binding['input']} artifact evidence is not UTF-8")

    if content_contract["format"] == "json":
        try:
            observed = json.loads(text)
        except json.JSONDecodeError:
            fail(f"{binding['input']} artifact evidence is malformed JSON")
        if not isinstance(observed, dict):
            fail(f"{binding['input']} artifact JSON evidence is not an object")
    else:
        observed = {}
        for line in text.splitlines():
            if not line:
                continue
            if "=" not in line:
                fail(f"{binding['input']} artifact env evidence is malformed")
            key, value = line.split("=", 1)
            if (
                not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key)
                or key in observed
                or any(ord(character) < 0x20 for character in value)
            ):
                fail(f"{binding['input']} artifact env evidence is unsafe")
            observed[key] = value

    for key, expected_template in content_contract["equals"].items():
        expected = resolve_artifact_value(
            expected_template,
            subject_sha,
            run_id,
            dispatch_inputs,
        )
        if observed.get(key) != expected:
            fail(
                f"{binding['input']} artifact field {key} is "
                f"{observed.get(key)!r}, expected {expected!r}"
            )


def validate_binding(
    repository,
    binding,
    subject_sha,
    run_id,
    dispatch_inputs=None,
):
    validate_binding_shape(binding)
    if dispatch_inputs is None:
        dispatch_inputs = {}
    if not REPOSITORY.fullmatch(repository):
        fail("repository must be owner/name")
    if not FULL_SHA.fullmatch(subject_sha):
        fail("subject SHA must be a full lowercase commit SHA")
    if not POSITIVE_INTEGER.fullmatch(run_id):
        fail(f"{binding['input']} must be a positive run ID")

    workflow = gh_api(
        f"repos/{repository}/actions/workflows/{binding['workflow']}"
    )
    if not isinstance(workflow, dict):
        fail(f"workflow metadata for {binding['workflow']} is not an object")
    workflow_id = workflow.get("id")
    if not isinstance(workflow_id, int):
        fail(f"unable to resolve workflow ID for {binding['workflow']}")

    # The base run endpoint reports the CURRENT attempt. Reading only
    # /attempts/1 is tautological: a rerun still exposes a first attempt, so a
    # rerun upstream would pass. Reject anything whose current attempt is not 1.
    base = gh_api(f"repos/{repository}/actions/runs/{run_id}")
    if not isinstance(base, dict):
        fail(f"{binding['input']} run response is not an object")
    if base.get("id") != int(run_id):
        fail(f"{binding['input']} run endpoint returned a different run ID")
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
    if not isinstance(attempt, dict):
        fail(f"{binding['input']} first attempt response is not an object")
    if attempt.get("run_attempt") != 1:
        fail(f"{binding['input']} first attempt is not attempt 1")
    attempt_checks = {
        "id": (attempt.get("id"), base.get("id")),
        "workflow_id": (
            attempt.get("workflow_id"),
            base.get("workflow_id"),
        ),
        "path": (attempt.get("path"), base.get("path")),
        "repository": (
            (attempt.get("head_repository") or {}).get("full_name"),
            (base.get("head_repository") or {}).get("full_name"),
        ),
        "head_branch": (
            attempt.get("head_branch"),
            base.get("head_branch"),
        ),
        "head_sha": (attempt.get("head_sha"), base.get("head_sha")),
        "status": (attempt.get("status"), base.get("status")),
        "conclusion": (
            attempt.get("conclusion"),
            base.get("conclusion"),
        ),
        "event": (attempt.get("event"), base.get("event")),
        "display_title": (
            attempt.get("display_title"),
            base.get("display_title"),
        ),
    }
    for label, (observed, expected) in attempt_checks.items():
        if observed != expected:
            fail(
                f"{binding['input']} first attempt {label} differs from the run"
            )

    artifact_name = substitute(
        binding["artifactTemplate"], subject_sha, run_id
    )
    pages = gh_api_pages(
        f"repos/{repository}/actions/runs/{run_id}/artifacts?per_page=100"
    )
    total_counts = {page.get("total_count") for page in pages}
    if (
        len(total_counts) != 1
        or not all(type(count) is int and count >= 0 for count in total_counts)
    ):
        fail(f"{binding['input']} artifact inventory has an invalid total count")
    artifacts = []
    for page in pages:
        page_artifacts = page.get("artifacts")
        if not isinstance(page_artifacts, list) or not all(
            isinstance(item, dict) for item in page_artifacts
        ):
            fail(f"{binding['input']} artifact inventory has an invalid page")
        artifacts.extend(page_artifacts)
    if len(artifacts) != next(iter(total_counts)):
        fail(f"{binding['input']} artifact inventory is incomplete")
    matches = [
        item
        for item in artifacts
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
    if type(artifact.get("size_in_bytes")) is not int or artifact[
        "size_in_bytes"
    ] <= 0:
        fail(f"{binding['input']} artifact {artifact_name} is empty")
    if artifact["size_in_bytes"] > MAX_ARTIFACT_ARCHIVE_BYTES:
        fail(f"{binding['input']} artifact {artifact_name} is too large")
    load_artifact_content(
        repository,
        binding,
        artifact,
        subject_sha,
        run_id,
        dispatch_inputs,
    )
    return {
        "artifactName": artifact_name,
        "createdAt": base.get("created_at"),
        "completedAt": base.get("updated_at"),
    }


def command_validate(args):
    binding = json.loads(args.binding)
    dispatch_inputs = json.loads(args.dispatch_inputs)
    if not isinstance(dispatch_inputs, dict):
        fail("dispatch inputs must be an object")
    facts = validate_binding(
        args.repository,
        binding,
        args.subject_sha,
        args.run_id,
        dispatch_inputs,
    )
    print(
        f"upstream_binding={binding['input']} run={args.run_id} "
        f"artifact={facts['artifactName']}"
    )


def resolve_bindings(args):
    """Resolve bindings from an explicit policy or from the shared manifest.

    Fail closed when the requested operation key is absent, null, or an
    unexpectedly empty list, so a typo or a pruned manifest entry can never be
    read as "this operation has no prerequisites".
    """
    if args.manifest:
        if not args.operation:
            fail("--manifest requires --operation")
        try:
            with open(args.manifest, encoding="utf-8") as handle:
                manifest = json.load(handle)
        except OSError as error:
            fail(f"unable to read binding manifest: {error}")
        except json.JSONDecodeError:
            fail("binding manifest is not valid JSON")
        if not isinstance(manifest, dict):
            fail("binding manifest must be an object")
        if args.operation not in manifest:
            fail(f"binding manifest has no entry for {args.operation}")
        bindings = manifest[args.operation]
        if bindings is None:
            fail(f"binding manifest entry for {args.operation} is null")
        if not isinstance(bindings, list):
            fail(f"binding manifest entry for {args.operation} must be a list")
        if not bindings:
            fail(f"binding manifest entry for {args.operation} is empty")
        return bindings
    policy = json.loads(args.policy_json)
    if not isinstance(policy, dict):
        fail("policy must be an object")
    if "upstreamRunBindings" not in policy:
        fail("policy does not declare upstreamRunBindings")
    bindings = policy["upstreamRunBindings"]
    if bindings is None:
        fail("policy upstreamRunBindings is null")
    if not isinstance(bindings, list):
        fail("upstreamRunBindings must be a list")
    return bindings


def command_validate_all(args):
    inputs = json.loads(args.dispatch_inputs)
    if not isinstance(inputs, dict):
        fail("dispatch inputs must be an object")
    bindings = resolve_bindings(args)
    for binding in bindings:
        validate_binding_shape(binding)
    binding_names = [binding["input"] for binding in bindings]
    if len(binding_names) != len(set(binding_names)):
        fail("upstream bindings contain a duplicate input")
    chronology_inputs = set()
    for binding in bindings:
        after_input = binding.get("afterInput")
        if after_input is not None:
            if after_input not in binding_names:
                fail(
                    f"binding {binding['input']} depends on unknown input "
                    f"{after_input}"
                )
            chronology_inputs.update((binding["input"], after_input))
    validated = {}
    for binding in bindings:
        name = binding["input"]
        if name not in inputs:
            fail(f"dispatch inputs are missing bound value {name}")
        if inputs[name] in (None, ""):
            fail(f"dispatch input {name} is empty")
        facts = validate_binding(
            args.repository,
            binding,
            args.subject_sha,
            str(inputs[name]),
            inputs,
        )
        if name in chronology_inputs:
            facts["createdAt"] = parse_timestamp(
                facts["createdAt"],
                f"{name} run creation time",
            )
            facts["completedAt"] = parse_timestamp(
                facts["completedAt"],
                f"{name} run completion time",
            )
            if facts["completedAt"] < facts["createdAt"]:
                fail(f"{name} run completion predates creation")
        after_input = binding.get("afterInput")
        if after_input is not None:
            if after_input not in validated:
                fail(
                    f"binding {name} depends on unvalidated input {after_input}"
                )
            if validated[after_input]["completedAt"] > facts["createdAt"]:
                fail(
                    f"binding {name} began before {after_input} completed"
                )
        validated[name] = facts
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
    one.add_argument("--dispatch-inputs", default="{}")
    one.set_defaults(func=command_validate)

    every = sub.add_parser("validate-all")
    every.add_argument("--repository", required=True)
    every.add_argument("--policy-json", default="")
    every.add_argument("--manifest", default="")
    every.add_argument("--operation", default="")
    every.add_argument("--subject-sha", required=True)
    every.add_argument("--dispatch-inputs", required=True)
    every.set_defaults(func=command_validate_all)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
