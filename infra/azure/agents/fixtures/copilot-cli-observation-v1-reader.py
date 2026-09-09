"""Frozen test-only v1 observation payload reader; not production authority.

Source: infra/azure/agents/copilot_cli_authority_stan.py
Commit: 1054d07e845129d76fc183e551dcd917a34c5397
The constants, validation helpers, and post-load body of
read_transition_observation are preserved from that source. Only the function
name and arguments replace the private-file loading preamble: this probe starts
with a decoded JSON payload. Filesystem validation and authority mutation are
deliberately excluded. The dispatcher test pins these fixture bytes by SHA-256;
do not refresh that pin to follow the current reader.
"""

import re


TRANSITION_OBSERVATION_SCHEMA = "betstan.live-data-transition-observation.v1"
LIVE_DATA_PATH = ".github/workflows/oci-live-data-rollout.yml"
FULL_SHA = re.compile(r"^[0-9a-f]{40}$")


def fail(message):
    raise SystemExit(message)


def require_exact_integer(value, label, *, minimum=0):
    if type(value) is not int or value < minimum:
        fail(f"{label} must be an integer no smaller than {minimum}")
    return value


def require_digest(value, label):
    if not isinstance(value, str) or re.fullmatch(r"[0-9a-f]{64}", value) is None:
        fail(f"{label} digest is invalid")


def validate_candidates(candidates):
    if not isinstance(candidates, list) or not 1 <= len(candidates) <= 100:
        fail("prepared candidates must be a nonempty bounded set")
    ids = []
    for candidate in candidates:
        if not isinstance(candidate, dict) or set(candidate) != {
            "runId",
            "headSha",
            "historicalWorkflowBlobSha",
            "evidenceSha256",
        }:
            fail("prepared candidate schema is invalid")
        ids.append(
            require_exact_integer(candidate["runId"], "candidate ID", minimum=1)
        )
        for name in ("headSha", "historicalWorkflowBlobSha"):
            if (
                not isinstance(candidate[name], str)
                or not FULL_SHA.fullmatch(candidate[name])
            ):
                fail(f"prepared candidate {name} is invalid")
        require_digest(candidate["evidenceSha256"], "candidate evidence")
    if ids != sorted(set(ids)):
        fail("prepared candidates are not sorted and unique")


def validate_observation(
    observation,
    repository,
    current_master,
    workflow_id,
    state,
):
    if not isinstance(observation, dict) or set(observation) != {
        "schemaVersion",
        "repository",
        "controlSha",
        "inventorySha256",
        "candidates",
        "workflows",
        "blockers",
    }:
        fail("transition observation schema is invalid")
    if (
        observation["schemaVersion"] != TRANSITION_OBSERVATION_SCHEMA
        or observation["repository"] != repository
        or observation["controlSha"] != current_master
        or observation["blockers"] != []
    ):
        fail("transition observation does not prove exclusive current control")
    validate_candidates(observation["candidates"])
    require_digest(observation["inventorySha256"], "inventory policy")
    expected_workflow = {
        "id": int(workflow_id),
        "path": LIVE_DATA_PATH,
        "state": state,
    }
    if observation["workflows"] != [expected_workflow] * len(
        observation["candidates"]
    ):
        fail("transition observed workflow identity/state mismatch")
    return observation
