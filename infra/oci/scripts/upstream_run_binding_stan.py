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
import base64
import binascii
import concurrent.futures
import contextlib
import contextvars
import copy
import datetime as dt
import hashlib
import importlib.util
import io
import ipaddress
import json
import math
import os
import re
import selectors
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time
import zipfile
from pathlib import Path

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
    "expectedHeadShaInput",
    "expectedConclusion",
    "artifactValidatorProfile",
    "runProfile",
}
ARTIFACT_VALIDATOR_PROFILES = {"oci-release-disk-checkpoint-v1"}
RUN_PROFILES = {
    "oci-failed-deploy-retained-hold-v1",
    "oci-failed-deploy-released-runtime-v1",
    "oci-failed-activation-cleanup-v1",
    "oci-failed-activation-released-resume-v1",
    "oci-successful-held-handoff-v1",
}
CURRENT_SERVICES = {
    "auth", "bet", "backoffice", "client", "event", "gamemaster",
    "moderation", "resulting", "slip", "telemetry",
}
RECOVERY_APPLICATION_SERVICES = CURRENT_SERVICES - {"telemetry"}
APPLICATION_REPOSITORY = "ghcr.io/vasilyevstan/betstan-images"
ARTIFACT_CONTENT_KEYS = {"fileName", "format", "equals"}
ARTIFACT_VALUE_TOKEN = re.compile(
    r"^\{(subject_sha|run_id|input:[A-Za-z0-9_]+)\}$"
)
MAX_ARTIFACT_ARCHIVE_BYTES = 50 * 1024 * 1024
MAX_ARTIFACT_EVIDENCE_BYTES = 1024 * 1024
ARTIFACT_DOWNLOAD_ATTEMPTS = 3
ARTIFACT_DOWNLOAD_TIMEOUT_SECONDS = 120
ARTIFACT_DOWNLOAD_BACKOFF_SECONDS = (1, 2)
BYTE_CONTEXT = contextvars.ContextVar("binding_immutable_bytes", default=None)
NATIVE_CONTEXT = contextvars.ContextVar("binding_native_reads", default=None)
BINDING_CONTEXT = contextvars.ContextVar("binding_input", default=None)
_CURRENT_READER_SHA_CONTEXT = contextvars.ContextVar(
    "binding_current_reader_sha", default=None,
)
HISTORY_WORKER = threading.local()
_AUTHORITY_IMPORT_LOCK = threading.RLock()
HANDOFF_STAGE_CEILINGS = {
    "packaging": 120, "admission": 180, "queue": 120, "approval": 240,
    "native-validation": 180, "startup-snapshot": 240, "receiver-renewal": 120,
}
HANDOFF_V4_STAGE_CEILINGS = {
    "packaging": 120, "admission": 600, "queue": 120, "approval": 1200,
    "native-validation": 480, "startup-snapshot": 360, "receiver-renewal": 120,
}
HANDOFF_RESERVE_SECONDS = 600
HANDOFF_V4_EXECUTION_SECONDS = sum(HANDOFF_V4_STAGE_CEILINGS.values())
HANDOFF_V4_LEASE_SECONDS = HANDOFF_V4_EXECUTION_SECONDS + HANDOFF_RESERVE_SECONDS
HELD_HANDOFF_AUTHORITY_VERSIONS = {
    "live-betting-data-resume-v3", "live-betting-data-resume-v4",
}
HANDOFF_V4_LEASE_EXPRESSION = (
    "${{ inputs.held_handoff_run_id != '0' && "
    "inputs.held_handoff_run_id != '' && '3600' || '1800' }}"
)
EXPIRED_HANDOFF_TREE = "03381913c7ba16a9c9faf8699740e892564a6628"
EXPIRED_HANDOFF_CLOSURE = {
    ".github/workflows/oci-production-deploy.yml":
        "b0cf0e993396032f526bbf3304989b3de57a4e0a",
    "infra/oci/scripts/live-data-maintenance-stan.sh":
        "7de9fee1d1f08323b04ef44ce8f58066f88e12ae",
    "infra/oci/scripts/shared-mongo-operation-lock-stan.sh":
        "6b00d8f38ae2adf7c700c1da1509134631298a31",
    "infra/azure/agents/shared-mongo-operation-lock-stan.sh":
        "1bcf7a3a922ad80b83a9170bfaaef3dcf1b2dc63",
}
FAILED_HELD_CONTINUATION_PROFILE = (
    "oci-failed-continue-held-handoff-no-domain-mutation-v1"
)
FAILED_HELD_CONTINUATION_RUN_ID = 39018383213
FAILED_HELD_CONTINUATION_HELD_RUN_ID = 38635983420
FAILED_HELD_CONTINUATION_HELD_SOURCE = (
    "7b6c9767e55d356ef1d119fa423d6a876c2e28d0"
)
FAILED_HELD_CONTINUATION_CONTROL = "ab32b31e363254abb5ab4b1d48408a1609fe63a9"
FAILED_HELD_CONTINUATION_TREE = "74a38702e349d111b9a48356203cc32e210fbdcd"
FAILED_HELD_CONTINUATION_CREATED_AT = "2026-10-17T08:42:38Z"
FAILED_HELD_CONTINUATION_UPDATED_AT = "2026-10-17T10:35:57Z"
FAILED_HELD_CONTINUATION_WORKFLOW_ID = 339733789
FAILED_HELD_CONTINUATION_REPOSITORY_ID = 753130566
FAILED_HELD_CONTINUATION_REPOSITORY_NODE_ID = "R_kgDOLOPcRg"
FAILED_HELD_CONTINUATION_POLICY_SHA256 = (
    "45ce069efd5532836b079c8059f9a17e439e312bd82aadf0188c286b62865cc8"
)
FAILED_HELD_CONTINUATION_INPUT_SHA256 = (
    "0f2c2591b12405a9f0e8937018cd8776150bd26243a81cb0af86a74e47c231aa"
)
FAILED_HELD_CONTINUATION_LINEAGE_SHA256 = (
    "7798863f33dfc0ade4893c8f3cbc6fe9edb1b0b02bb49134ee70f54da0167d9c"
)
FAILED_HELD_CONTINUATION_CURRENT_WORKFLOW_BLOB = (
    "92038ee7bd21ddc2b888242f2ee91a7bd5571aba"
)
FAILED_HELD_CONTINUATION_INPUT_NAMES = (
    "approved_sha",
    "resume_source_sha",
    "build_run_id",
    "infrastructure_run_id",
    "checkpoint_source_sha",
    "disk_checkpoint_run_id",
    "phase",
    "prerequisite_run_id",
    "baseline_recovery_run_id",
    "baseline_recovery_source_sha",
    "failed_deploy_run_id",
    "failed_activation_run_id",
    "failed_activation_user_id",
    "confirmation",
    "held_handoff_run_id",
    "held_handoff_source_sha",
)
FAILED_HELD_CONTINUATION_ACTIONS = (
    "actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09",
    "actions/download-artifact@37930b1c2abaa49bbe596cd826c3c89aef350131",
    "actions/upload-artifact@b7c566a772e6b6bfb58ed0dc250532a479d7789f",
    "oracle-actions/configure-kubectl-oke@77a733d79446dabe7bf0e58eb56197d33ce4dc58",
)
FAILED_HELD_CONTINUATION_CLOSURE = (
    (
        ".github/workflows/oci-live-data-rollout.yml",
        "1855c6443f0e32e2ab306ab23c159ad9d19312bf",
    ),
    (
        "infra/azure/agents/copilot-cli-protected-operation-policy-stan.sh",
        "d5afe224080abecda336f1b3d190c83674835ebf",
    ),
    (
        "infra/azure/agents/copilot_cli_authority_stan.py",
        "3393e632c7f26ca2f98fd56a230985766db4ec91",
    ),
    (
        "infra/azure/agents/live-betting-readiness-lib.sh",
        "4d2cbbe86590b47b3af9509a2d477cc5c4fa3b64",
    ),
    (
        "infra/azure/agents/production-run-exclusivity-stan.sh",
        "c662964a633690da8e3ce460a07f78484db3a7a8",
    ),
    (
        "infra/azure/agents/shared-mongo-operation-lock-stan.sh",
        "1bcf7a3a922ad80b83a9170bfaaef3dcf1b2dc63",
    ),
    (
        "infra/oci/agents/live-betting-readiness-stan.sh",
        "d5829645475d8907e0d4d172749785b8095ca1b9",
    ),
    (
        "infra/oci/scripts/authorize-github-runner.sh",
        "0a56854ca4e284e291beb471a61f4381afdc7b5a",
    ),
    (
        "infra/oci/scripts/baseline-capture-stan.sh",
        "f5d0a97080637880173e817807c38443c35af748",
    ),
    (
        "infra/oci/scripts/cleanup-live-acceptance-slips-stan.sh",
        "6f3486bb980dc8f791c2f139c4e3f4aaa097f0ab",
    ),
    (
        "infra/oci/scripts/configure-k3s-access.sh",
        "a95bd1cc58ee8fe72b8a429a4d32c09f6ceecea3",
    ),
    (
        "infra/oci/scripts/install-cli.sh",
        "d939372bd9e3e6268e5f935685c554c742549e11",
    ),
    (
        "infra/oci/scripts/k3s-node-disk-recovery-stan.sh",
        "e4c7798fe66b05735bb906932a266db4a2523f87",
    ),
    (
        "infra/oci/scripts/k3s_disk_recovery_stan.py",
        "a1f21fe3f3b538ec6965b353c08bbac8738a8b19",
    ),
    (
        "infra/oci/scripts/lib.sh",
        "caabac06cc16147e12ac536112d3aa5f14d54a34",
    ),
    (
        "infra/oci/scripts/live-betting-data-rollout-stan.sh",
        "6019ae3d3105170396ddcc2e4f5e703e62ac7488",
    ),
    (
        "infra/oci/scripts/live-data-maintenance-stan.sh",
        "7de9fee1d1f08323b04ef44ce8f58066f88e12ae",
    ),
    (
        "infra/oci/scripts/revoke-github-runner.sh",
        "7d4e33b0824c46af88c5d5cdfb7998e9a5cb0641",
    ),
    (
        "infra/oci/scripts/upstream_run_binding_stan.py",
        "95d5e216e3908abd6968497e9f2db4f5e3426580",
    ),
    (
        "infra/oci/scripts/validate-partial-recovery-authority-stan.sh",
        "bf089777892d70d13b4bcf880d7e5311e26c00b9",
    ),
    (
        "infra/oci/scripts/validate-rollback-baseline-stan.sh",
        "15db4c58cdf7849b0bf0193a54315b54ec411d55",
    ),
    (
        "infra/oci/scripts/verify-images.sh",
        "77ff8ecdcf9b8f86ed5be3550a3cd9f91c57a514",
    ),
    (
        "infra/oci/scripts/verify-live-betting-data-evidence-stan.sh",
        "87ba39e6cabf84ce62aa75cf4e342b3b510850d4",
    ),
)
FAILED_HELD_CONTINUATION_STEPS = (
    (1, "Set up job", "success", "2026-10-17T10:21:18Z", "2026-10-17T10:21:20Z"),
    (2, "Initialize isolated OCI data paths", "success", "2026-10-17T10:21:20Z", "2026-10-17T10:21:20Z"),
    (3, "Checkout approved current master commit", "success", "2026-10-17T10:21:20Z", "2026-10-17T10:21:22Z"),
    (4, "Validate exact SHA phase and trusted upstream runs", "success", "2026-10-17T10:21:22Z", "2026-10-17T10:24:07Z"),
    (5, "Reject competing production activity", "success", "2026-10-17T10:24:07Z", "2026-10-17T10:25:00Z"),
    (6, "Download exact OCI image provenance", "success", "2026-10-17T10:25:00Z", "2026-10-17T10:25:00Z"),
    (7, "Download exact OCI infrastructure provenance", "success", "2026-10-17T10:25:00Z", "2026-10-17T10:25:01Z"),
    (8, "Download exact release disk checkpoint", "success", "2026-10-17T10:25:01Z", "2026-10-17T10:25:02Z"),
    (9, "Download prerequisite data evidence", "success", "2026-10-17T10:25:02Z", "2026-10-17T10:25:03Z"),
    (10, "Download failed deploy protected baseline", "skipped", "2026-10-17T10:25:03Z", "2026-10-17T10:25:03Z"),
    (11, "Download explicitly selected recovery baseline authority", "skipped", "2026-10-17T10:25:03Z", "2026-10-17T10:25:03Z"),
    (12, "Bind historical recovery source through its exact artifact", "skipped", "2026-10-17T10:25:03Z", "2026-10-17T10:25:03Z"),
    (13, "Verify immutable release and phase provenance", "success", "2026-10-17T10:25:03Z", "2026-10-17T10:28:20Z"),
    (14, "Install pinned OCI CLI", "success", "2026-10-17T10:28:20Z", "2026-10-17T10:28:44Z"),
    (15, "Verify OKE identity", "skipped", "2026-10-17T10:28:44Z", "2026-10-17T10:28:44Z"),
    (16, "Verify k3s identity", "success", "2026-10-17T10:28:44Z", "2026-10-17T10:28:45Z"),
    (17, "Reconcile expired and authorize current runner IPv4", "skipped", "2026-10-17T10:28:45Z", "2026-10-17T10:28:45Z"),
    (18, "Configure kubectl from exact cluster OCID", "skipped", "2026-10-17T10:28:45Z", "2026-10-17T10:28:45Z"),
    (19, "Open ephemeral OCI Bastion access to k3s", "success", "2026-10-17T10:28:45Z", "2026-10-17T10:33:36Z"),
    (20, "Verify exact failed-deploy resume state", "success", "2026-10-17T10:33:36Z", "2026-10-17T10:34:11Z"),
    (21, "Capture and validate pre-mutation rollback baseline", "success", "2026-10-17T10:34:11Z", "2026-10-17T10:34:11Z"),
    (22, "Verify reader-qualified released activation state", "skipped", "2026-10-17T10:34:11Z", "2026-10-17T10:34:11Z"),
    (23, "Revalidate exact release disk checkpoint before lock mutation", "success", "2026-10-17T10:34:11Z", "2026-10-17T10:34:14Z"),
    (24, "Acquire database operation lock", "failure", "2026-10-17T10:34:14Z", "2026-10-17T10:35:26Z"),
    (25, "Enter or re-establish live data maintenance", "skipped", "2026-10-17T10:35:26Z", "2026-10-17T10:35:26Z"),
    (26, "Demote and verify exact retained live-acceptance account", "skipped", "2026-10-17T10:35:26Z", "2026-10-17T10:35:26Z"),
    (27, "Delete exact orphaned live-acceptance slips", "skipped", "2026-10-17T10:35:26Z", "2026-10-17T10:35:26Z"),
    (28, "Execute exact-digest live data phase", "skipped", "2026-10-17T10:35:26Z", "2026-10-17T10:35:26Z"),
    (29, "Restore runtime or verify final deploy handoff", "skipped", "2026-10-17T10:35:26Z", "2026-10-17T10:35:26Z"),
    (30, "Capture post-phase runtime baseline", "skipped", "2026-10-17T10:35:26Z", "2026-10-17T10:35:26Z"),
    (31, "Require executed data-step evidence", "skipped", "2026-10-17T10:35:26Z", "2026-10-17T10:35:26Z"),
    (32, "Upload exact sanitized data evidence", "success", "2026-10-17T10:35:26Z", "2026-10-17T10:35:27Z"),
    (33, "Upload protected rollout baselines", "success", "2026-10-17T10:35:27Z", "2026-10-17T10:35:28Z"),
    (34, "Restore runtime or retain hold if final handoff packaging failed", "skipped", "2026-10-17T10:35:28Z", "2026-10-17T10:35:28Z"),
    (35, "Release database operation lock unless handed to deploy", "skipped", "2026-10-17T10:35:28Z", "2026-10-17T10:35:28Z"),
    (36, "Revoke exact runner rule", "skipped", "2026-10-17T10:35:28Z", "2026-10-17T10:35:28Z"),
    (37, "Close ephemeral OCI Bastion access", "success", "2026-10-17T10:35:28Z", "2026-10-17T10:35:40Z"),
    (38, "Remove isolated OCI client state", "success", "2026-10-17T10:35:40Z", "2026-10-17T10:35:55Z"),
    (76, "Post Checkout approved current master commit", "success", "2026-10-17T10:35:55Z", "2026-10-17T10:35:55Z"),
    (77, "Complete job", "success", "2026-10-17T10:35:55Z", "2026-10-17T10:35:55Z"),
)
FAILED_HELD_CONTINUATION_ARTIFACTS = (
    (
        12098621291,
        "MDg6QXJ0aWZhY3QxMjA5ODYyMTI5MQ==",
        "oci-live-data-baselines-39018383213-1",
        11677,
        "fc564f016b2cdf6232c7b01ea2ea58c278905f24b0fd9869483762d5c5a8d6c2",
        "2026-10-17T10:35:28Z",
        "2026-10-17T10:35:28Z",
        "2026-11-16T10:35:27Z",
    ),
    (
        12097894204,
        "MDg6QXJ0aWZhY3QxMjA5Nzg5NDIwNA==",
        "oci-live-data-rollout-39018383213-1",
        1301,
        "6b725d166f3663fe65bcccd451d7c3d4f92234414eb448e5595d54f97d22e01b",
        "2026-10-17T10:35:27Z",
        "2026-10-17T10:35:27Z",
        "2026-11-16T10:35:26Z",
    ),
)
FAILED_HELD_CONTINUATION_BASELINE_MEMBERS = (
    ("betstan/betstan/artifacts/oci-data-baseline-before/SHA256SUMS", "cfc3ffabb3d124b7f2481f6a2baa6016d04cc652edd6667fd0067c496c9adbea"),
    ("betstan/betstan/artifacts/oci-data-baseline-before/baseline-provenance.env", "e73836cf9c6ae9d71b0cbf6ecaa997d53514e12398339418ed17ea2acd958ae5"),
    ("betstan/betstan/artifacts/oci-data-baseline-before/deployments.tsv", "02fd54cd8f41f551660d8d887ee430269c38976c54ed4166d8ea3f4acaa91455"),
    ("betstan/betstan/artifacts/oci-data-baseline-before/images.tsv", "b87ed96c3ce8c9e7f7c222d58de29e58424da29215e5b2f9fb3e7caa2356c43b"),
    ("betstan/betstan/artifacts/oci-data-baseline-before/live-images.tsv", "88c9b61467eb249f5cff3b757537cd0dac5e671dfb9c971c1167204c3e8afaed"),
    ("betstan/betstan/artifacts/oci-data-baseline-before/migration-backup-references.tsv", "77a7f8a3c8236cedcb01f985876b85a155c5423f8f5404d8b6302ef1d44161ee"),
    ("betstan/betstan/artifacts/oci-data-baseline-before/migration-journal.json", "4f7dd24ab7c55ab6587c8a88f6a57030ce91133605b683ec601bd6311c2589c9"),
    ("betstan/betstan/artifacts/oci-data-baseline-before/migration-lock.json", "b4fa456e1270539e95ee5ace1c162a5128d926dda39aa576ac9b6082a157c77e"),
    ("betstan/betstan/artifacts/oci-data-baseline-before/pod-images.tsv", "1c576a1405d675b442d19d2455183d4b05752e8d96208ea764b44ee1adb519e4"),
    ("betstan/betstan/artifacts/oci-data-baseline-before/public-http.tsv", "50d53c1b595dd747bdc38d981bc0022f43e4ada484b2808b6b6a40ca1b27011d"),
    ("betstan/betstan/artifacts/oci-data-baseline-before/queues.tsv", "72f5237567b7ad59098f4289b3dd6f7f7fcb9dd65ce0dd90e58451edd76dfe22"),
    ("betstan/betstan/artifacts/oci-data-baseline-before/sse.tsv", "88e2120e4df6bf562a6715005cd953ca675e9439fac52a80a3854dc979a16ce4"),
    ("betstan/betstan/artifacts/oci-data-baseline-before/telemetry-pre-run.env", "13a305704ca02cd725e3ed1f1acc168479085872ba702b4d10bac54324be2390"),
    ("betstan/betstan/artifacts/oci-data-baseline-before/trusted-deploy-provenance.txt", "49b1bc8b6acce7a3d36a9404e4533ec2113b7bf6a7ec1df1809f2348482dc4ba"),
    ("_temp/pre-runtime-lock.json", "4abf8aa57f2580cf3cd46941813e426c73148ddd88cc140616bee0c39d278e7e"),
)
FAILED_HELD_CONTINUATION_ROLLOUT_MEMBERS = (
    ("held-handoff-history.json", "4bb01bec81d822777d3a22c3176e35ca35f237bc731a2e43e2a4c53068d9092f"),
    ("resume-authority.env", "b01110bf539809099cd5b2902de91c41239dc220485c9fd4edb7930aece545bc"),
)
FAILED_HELD_CONTINUATION_LOG_MEMBERS = (
    ("0_rollout.txt", "2272fdd95c15465f91eb93de94920146b71dff6457aa563508e899e78555c89d"),
    ("rollout/system.txt", "a7cb468c620e6e0178566937ad229e7f62590f0e4a252eb9e8dacc1114ebf7b2"),
)
FAILED_HELD_CONTINUATION_LOCK_SOURCE_SHA256 = (
    "46ef900dc73520f0c17981eb29a8b0570b9880e6718a93a93dbed891e9a96059"
)
FAILED_HELD_CONTINUATION_LOCK_OUTSIDE_SHA256 = (
    "48427d6ddc8f8289b909ebde12d26af3b3985988e37a61cebe43c8d6a3d66d4c"
)
FAILED_HELD_CONTINUATION_CLEANUP_OUTSIDE_SHA256 = (
    "e0a94dcbaabcf5b8e50a59d12dc3c879fbbe5bee1de90b1ec197ce49bff8ddc8"
)
FAILED_HELD_CONTINUATION_DENIAL = (
    "gh: Resource not accessible by integration (HTTP 403)"
)
FAILED_HELD_CONTINUATION_PROTECTED_READ = (
    '[ "$(gh api "repos/$REPO/environments/oci-migration/variables/'
    'OCI_RUNTIME_MODE" --jq .value)" = "$OCI_RUNTIME_MODE" ]'
)
FAILED_CLEAN_READER_CONTINUATION_PROFILE = (
    "oci-failed-continue-held-handoff-clean-reader-v1"
)
FAILED_CLEAN_READER_CONTINUATION_RUN_ID = 39114852871
FAILED_CLEAN_READER_CONTINUATION_HELD_RUN_ID = 38635983420
FAILED_CLEAN_READER_CONTINUATION_HELD_SOURCE = (
    "7b6c9767e55d356ef1d119fa423d6a876c2e28d0"
)
FAILED_CLEAN_READER_CONTINUATION_CONTROL = (
    "610d2dddb59806cf27a892430fd326a8f60a37eb"
)
FAILED_CLEAN_READER_CONTINUATION_TREE = (
    "d7b4d3959f105ff65f85af099107a733478b4d1a"
)
FAILED_CLEAN_READER_CONTINUATION_CREATED_AT = "2026-10-18T09:19:04Z"
FAILED_CLEAN_READER_CONTINUATION_UPDATED_AT = "2026-10-18T10:52:21Z"
FAILED_CLEAN_READER_CONTINUATION_CURRENT_VERIFIER_BLOB = (
    "b258c4f35ba34492cb26b080d41928cdc1e74cf1"
)
FAILED_CLEAN_READER_CONTINUATION_WORKFLOW_ID = 339733789
FAILED_CLEAN_READER_CONTINUATION_REPOSITORY_ID = 753130566
FAILED_CLEAN_READER_CONTINUATION_REPOSITORY_NODE_ID = "R_kgDOLOPcRg"
FAILED_CLEAN_READER_CONTINUATION_POLICY_SHA256 = (
    "45ce069efd5532836b079c8059f9a17e439e312bd82aadf0188c286b62865cc8"
)
FAILED_CLEAN_READER_CONTINUATION_INPUT_SHA256 = (
    "47e9584cb320e13956ce58b11608ea923017f502934c3a1bcc47436e61b2882e"
)
FAILED_CLEAN_READER_CONTINUATION_LINEAGE_SHA256 = (
    "7798863f33dfc0ade4893c8f3cbc6fe9edb1b0b02bb49134ee70f54da0167d9c"
)
FAILED_CLEAN_READER_CONTINUATION_INPUT_NAMES = (
    FAILED_HELD_CONTINUATION_INPUT_NAMES
)
FAILED_CLEAN_READER_CONTINUATION_ACTIONS = FAILED_HELD_CONTINUATION_ACTIONS
FAILED_CLEAN_READER_CONTINUATION_CLOSURE = (
    (
        ".github/workflows/oci-live-data-rollout.yml",
        "92038ee7bd21ddc2b888242f2ee91a7bd5571aba",
    ),
    (
        "infra/azure/agents/copilot-cli-protected-operation-policy-stan.sh",
        "d5afe224080abecda336f1b3d190c83674835ebf",
    ),
    (
        "infra/azure/agents/copilot_cli_authority_stan.py",
        "3393e632c7f26ca2f98fd56a230985766db4ec91",
    ),
    (
        "infra/azure/agents/live-betting-readiness-lib.sh",
        "4d2cbbe86590b47b3af9509a2d477cc5c4fa3b64",
    ),
    (
        "infra/azure/agents/production-run-exclusivity-stan.sh",
        "c662964a633690da8e3ce460a07f78484db3a7a8",
    ),
    (
        "infra/azure/agents/shared-mongo-operation-lock-stan.sh",
        "1bcf7a3a922ad80b83a9170bfaaef3dcf1b2dc63",
    ),
    (
        "infra/oci/agents/live-betting-readiness-stan.sh",
        "d5829645475d8907e0d4d172749785b8095ca1b9",
    ),
    (
        "infra/oci/scripts/authorize-github-runner.sh",
        "0a56854ca4e284e291beb471a61f4381afdc7b5a",
    ),
    (
        "infra/oci/scripts/baseline-capture-stan.sh",
        "f5d0a97080637880173e817807c38443c35af748",
    ),
    (
        "infra/oci/scripts/cleanup-live-acceptance-slips-stan.sh",
        "6f3486bb980dc8f791c2f139c4e3f4aaa097f0ab",
    ),
    (
        "infra/oci/scripts/configure-k3s-access.sh",
        "a95bd1cc58ee8fe72b8a429a4d32c09f6ceecea3",
    ),
    (
        "infra/oci/scripts/install-cli.sh",
        "d939372bd9e3e6268e5f935685c554c742549e11",
    ),
    (
        "infra/oci/scripts/k3s-node-disk-recovery-stan.sh",
        "e4c7798fe66b05735bb906932a266db4a2523f87",
    ),
    (
        "infra/oci/scripts/k3s_disk_recovery_stan.py",
        "a1f21fe3f3b538ec6965b353c08bbac8738a8b19",
    ),
    (
        "infra/oci/scripts/lib.sh",
        "caabac06cc16147e12ac536112d3aa5f14d54a34",
    ),
    (
        "infra/oci/scripts/live-betting-data-rollout-stan.sh",
        "6019ae3d3105170396ddcc2e4f5e703e62ac7488",
    ),
    (
        "infra/oci/scripts/live-data-maintenance-stan.sh",
        "7de9fee1d1f08323b04ef44ce8f58066f88e12ae",
    ),
    (
        "infra/oci/scripts/revoke-github-runner.sh",
        "7d4e33b0824c46af88c5d5cdfb7998e9a5cb0641",
    ),
    (
        "infra/oci/scripts/upstream_run_binding_stan.py",
        "3968ca2f1b64727f92e51590e12b39109588cf46",
    ),
    (
        "infra/oci/scripts/validate-partial-recovery-authority-stan.sh",
        "bf089777892d70d13b4bcf880d7e5311e26c00b9",
    ),
    (
        "infra/oci/scripts/validate-rollback-baseline-stan.sh",
        "15db4c58cdf7849b0bf0193a54315b54ec411d55",
    ),
    (
        "infra/oci/scripts/verify-images.sh",
        "77ff8ecdcf9b8f86ed5be3550a3cd9f91c57a514",
    ),
    (
        "infra/oci/scripts/verify-live-betting-data-evidence-stan.sh",
        "87ba39e6cabf84ce62aa75cf4e342b3b510850d4",
    ),
)
FAILED_CLEAN_READER_CONTINUATION_STEPS = (
    (1, "Set up job", "success", "2026-10-18T10:49:37Z", "2026-10-18T10:49:38Z"),
    (2, "Initialize isolated OCI data paths", "success", "2026-10-18T10:49:39Z", "2026-10-18T10:49:39Z"),
    (3, "Checkout approved current master commit", "success", "2026-10-18T10:49:39Z", "2026-10-18T10:49:40Z"),
    (4, "Validate exact SHA phase and trusted upstream runs", "failure", "2026-10-18T10:49:40Z", "2026-10-18T10:52:18Z"),
    (5, "Reject competing production activity", "skipped", "2026-10-18T10:52:18Z", "2026-10-18T10:52:18Z"),
    (6, "Download exact OCI image provenance", "skipped", "2026-10-18T10:52:18Z", "2026-10-18T10:52:18Z"),
    (7, "Download exact OCI infrastructure provenance", "skipped", "2026-10-18T10:52:18Z", "2026-10-18T10:52:18Z"),
    (8, "Download exact release disk checkpoint", "skipped", "2026-10-18T10:52:18Z", "2026-10-18T10:52:18Z"),
    (9, "Download prerequisite data evidence", "skipped", "2026-10-18T10:52:18Z", "2026-10-18T10:52:18Z"),
    (10, "Download failed deploy protected baseline", "skipped", "2026-10-18T10:52:18Z", "2026-10-18T10:52:18Z"),
    (11, "Download explicitly selected recovery baseline authority", "skipped", "2026-10-18T10:52:18Z", "2026-10-18T10:52:18Z"),
    (12, "Bind historical recovery source through its exact artifact", "skipped", "2026-10-18T10:52:18Z", "2026-10-18T10:52:18Z"),
    (13, "Verify immutable release and phase provenance", "skipped", "2026-10-18T10:52:18Z", "2026-10-18T10:52:18Z"),
    (14, "Install pinned OCI CLI", "skipped", "2026-10-18T10:52:18Z", "2026-10-18T10:52:18Z"),
    (15, "Verify OKE identity", "skipped", "2026-10-18T10:52:18Z", "2026-10-18T10:52:18Z"),
    (16, "Verify k3s identity", "skipped", "2026-10-18T10:52:18Z", "2026-10-18T10:52:18Z"),
    (17, "Reconcile expired and authorize current runner IPv4", "skipped", "2026-10-18T10:52:18Z", "2026-10-18T10:52:18Z"),
    (18, "Configure kubectl from exact cluster OCID", "skipped", "2026-10-18T10:52:18Z", "2026-10-18T10:52:18Z"),
    (19, "Open ephemeral OCI Bastion access to k3s", "skipped", "2026-10-18T10:52:18Z", "2026-10-18T10:52:18Z"),
    (20, "Verify exact failed-deploy resume state", "skipped", "2026-10-18T10:52:18Z", "2026-10-18T10:52:18Z"),
    (21, "Capture and validate pre-mutation rollback baseline", "skipped", "2026-10-18T10:52:18Z", "2026-10-18T10:52:18Z"),
    (22, "Verify reader-qualified released activation state", "skipped", "2026-10-18T10:52:18Z", "2026-10-18T10:52:18Z"),
    (23, "Revalidate exact release disk checkpoint before lock mutation", "skipped", "2026-10-18T10:52:18Z", "2026-10-18T10:52:18Z"),
    (24, "Acquire database operation lock", "skipped", "2026-10-18T10:52:18Z", "2026-10-18T10:52:18Z"),
    (25, "Enter or re-establish live data maintenance", "skipped", "2026-10-18T10:52:18Z", "2026-10-18T10:52:18Z"),
    (26, "Demote and verify exact retained live-acceptance account", "skipped", "2026-10-18T10:52:18Z", "2026-10-18T10:52:18Z"),
    (27, "Delete exact orphaned live-acceptance slips", "skipped", "2026-10-18T10:52:18Z", "2026-10-18T10:52:18Z"),
    (28, "Execute exact-digest live data phase", "skipped", "2026-10-18T10:52:18Z", "2026-10-18T10:52:18Z"),
    (29, "Restore runtime or verify final deploy handoff", "skipped", "2026-10-18T10:52:18Z", "2026-10-18T10:52:18Z"),
    (30, "Capture post-phase runtime baseline", "skipped", "2026-10-18T10:52:18Z", "2026-10-18T10:52:18Z"),
    (31, "Require executed data-step evidence", "skipped", "2026-10-18T10:52:18Z", "2026-10-18T10:52:18Z"),
    (32, "Upload exact sanitized data evidence", "success", "2026-10-18T10:52:18Z", "2026-10-18T10:52:18Z"),
    (33, "Upload protected rollout baselines", "success", "2026-10-18T10:52:18Z", "2026-10-18T10:52:18Z"),
    (34, "Restore runtime or retain hold if final handoff packaging failed", "skipped", "2026-10-18T10:52:18Z", "2026-10-18T10:52:18Z"),
    (35, "Release database operation lock unless handed to deploy", "skipped", "2026-10-18T10:52:18Z", "2026-10-18T10:52:18Z"),
    (36, "Revoke exact runner rule", "skipped", "2026-10-18T10:52:18Z", "2026-10-18T10:52:18Z"),
    (37, "Close ephemeral OCI Bastion access", "skipped", "2026-10-18T10:52:18Z", "2026-10-18T10:52:18Z"),
    (38, "Remove isolated OCI client state", "success", "2026-10-18T10:52:18Z", "2026-10-18T10:52:18Z"),
    (76, "Post Checkout approved current master commit", "success", "2026-10-18T10:52:18Z", "2026-10-18T10:52:18Z"),
    (77, "Complete job", "success", "2026-10-18T10:52:18Z", "2026-10-18T10:52:18Z"),
)
FAILED_CLEAN_READER_CONTINUATION_LOG_MEMBERS = (
    ("0_rollout.txt", "7c7f780144596c26ab81cc9c19e26f6c1c5813b433819184391f1ab512ea9c4f"),
    ("rollout/system.txt", "86e3e4ac46d817b28839803acfdd02b518b5ca98768653c5c28f2b85be2208d3"),
)
FAILED_CLEAN_READER_CONTINUATION_FAILURE_LINES_SHA256 = (
    "4c2db9fb6f7965babe21145f399c0106394b8103455bd5867d37bdccebbd87d7"
)
FAILED_CLEAN_READER_CONTINUATION_FAILURE_DIAGNOSTICS_SHA256 = (
    "2652cfb872afad6abe722fd24607fb22125d47e4024b48881b4805321776bf83"
)
FAILED_CLEAN_READER_CONTINUATION_UPLOAD_DIAGNOSTICS = (
    (
        "Upload exact sanitized data evidence",
        "9651ebc58bec6d5b2c80473e0c6945c04a79516098db69f251b75e0030ffdb4c",
        "e47a85c0ce061bf03a14985d091a0c49265fdd27b58f452b3a39ee29aa4965ce",
    ),
    (
        "Upload protected rollout baselines",
        "9651ebc58bec6d5b2c80473e0c6945c04a79516098db69f251b75e0030ffdb4c",
        "e47a85c0ce061bf03a14985d091a0c49265fdd27b58f452b3a39ee29aa4965ce",
    ),
)
FAILED_PRE_CAS_CONTINUATION_PROFILE = (
    "oci-failed-continue-held-handoff-pre-cas-no-domain-mutation-v1"
)
FAILED_PRE_CAS_CONTINUATION_RUN_ID = 39229920454
FAILED_PRE_CAS_CONTINUATION_HELD_RUN_ID = 38635983420
FAILED_PRE_CAS_CONTINUATION_HELD_SOURCE = (
    "7b6c9767e55d356ef1d119fa423d6a876c2e28d0"
)
FAILED_PRE_CAS_CONTINUATION_CONTROL = (
    "78049ccbeee16811920c36a6076fcf436435ba9f"
)
FAILED_PRE_CAS_CONTINUATION_TREE = (
    "07d5cba05d7e2451eaf09a5397f0037dff2bb7b6"
)
FAILED_PRE_CAS_CONTINUATION_CREATED_AT = "2026-10-19T09:25:15Z"
FAILED_PRE_CAS_CONTINUATION_UPDATED_AT = "2026-10-19T10:47:03Z"
FAILED_PRE_CAS_CONTINUATION_WORKFLOW_ID = 339733789
FAILED_PRE_CAS_CONTINUATION_REPOSITORY_ID = 753130566
FAILED_PRE_CAS_CONTINUATION_REPOSITORY_NODE_ID = "R_kgDOLOPcRg"
FAILED_PRE_CAS_CONTINUATION_POLICY_SHA256 = (
    "45ce069efd5532836b079c8059f9a17e439e312bd82aadf0188c286b62865cc8"
)
FAILED_PRE_CAS_CONTINUATION_INPUT_SHA256 = (
    "1147abd39fff821a85698c9df7197d0ce35e82d5237f17fbcc2afed5c216e557"
)
FAILED_PRE_CAS_CONTINUATION_LINEAGE_SHA256 = (
    "7798863f33dfc0ade4893c8f3cbc6fe9edb1b0b02bb49134ee70f54da0167d9c"
)
FAILED_PRE_CAS_CONTINUATION_INPUT_NAMES = (
    FAILED_HELD_CONTINUATION_INPUT_NAMES
)
FAILED_PRE_CAS_CONTINUATION_ACTIONS = FAILED_HELD_CONTINUATION_ACTIONS
FAILED_PRE_CAS_CONTINUATION_CLOSURE = (
    (
        ".github/workflows/oci-live-data-rollout.yml",
        "92038ee7bd21ddc2b888242f2ee91a7bd5571aba",
    ),
    (
        "infra/azure/agents/copilot-cli-protected-operation-policy-stan.sh",
        "d5afe224080abecda336f1b3d190c83674835ebf",
    ),
    (
        "infra/azure/agents/copilot_cli_authority_stan.py",
        "3393e632c7f26ca2f98fd56a230985766db4ec91",
    ),
    (
        "infra/azure/agents/live-betting-readiness-lib.sh",
        "4d2cbbe86590b47b3af9509a2d477cc5c4fa3b64",
    ),
    (
        "infra/azure/agents/production-run-exclusivity-stan.sh",
        "c662964a633690da8e3ce460a07f78484db3a7a8",
    ),
    (
        "infra/azure/agents/shared-mongo-operation-lock-stan.sh",
        "1bcf7a3a922ad80b83a9170bfaaef3dcf1b2dc63",
    ),
    (
        "infra/oci/agents/live-betting-readiness-stan.sh",
        "d5829645475d8907e0d4d172749785b8095ca1b9",
    ),
    (
        "infra/oci/scripts/authorize-github-runner.sh",
        "0a56854ca4e284e291beb471a61f4381afdc7b5a",
    ),
    (
        "infra/oci/scripts/baseline-capture-stan.sh",
        "f5d0a97080637880173e817807c38443c35af748",
    ),
    (
        "infra/oci/scripts/cleanup-live-acceptance-slips-stan.sh",
        "6f3486bb980dc8f791c2f139c4e3f4aaa097f0ab",
    ),
    (
        "infra/oci/scripts/configure-k3s-access.sh",
        "a95bd1cc58ee8fe72b8a429a4d32c09f6ceecea3",
    ),
    (
        "infra/oci/scripts/install-cli.sh",
        "d939372bd9e3e6268e5f935685c554c742549e11",
    ),
    (
        "infra/oci/scripts/k3s-node-disk-recovery-stan.sh",
        "e4c7798fe66b05735bb906932a266db4a2523f87",
    ),
    (
        "infra/oci/scripts/k3s_disk_recovery_stan.py",
        "a1f21fe3f3b538ec6965b353c08bbac8738a8b19",
    ),
    (
        "infra/oci/scripts/lib.sh",
        "caabac06cc16147e12ac536112d3aa5f14d54a34",
    ),
    (
        "infra/oci/scripts/live-betting-data-rollout-stan.sh",
        "6019ae3d3105170396ddcc2e4f5e703e62ac7488",
    ),
    (
        "infra/oci/scripts/live-data-maintenance-stan.sh",
        "7de9fee1d1f08323b04ef44ce8f58066f88e12ae",
    ),
    (
        "infra/oci/scripts/revoke-github-runner.sh",
        "7d4e33b0824c46af88c5d5cdfb7998e9a5cb0641",
    ),
    (
        "infra/oci/scripts/upstream_run_binding_stan.py",
        "89306585135dce75fdfb5904a41e0fdb77050ca2",
    ),
    (
        "infra/oci/scripts/validate-partial-recovery-authority-stan.sh",
        "bf089777892d70d13b4bcf880d7e5311e26c00b9",
    ),
    (
        "infra/oci/scripts/validate-rollback-baseline-stan.sh",
        "15db4c58cdf7849b0bf0193a54315b54ec411d55",
    ),
    (
        "infra/oci/scripts/verify-images.sh",
        "77ff8ecdcf9b8f86ed5be3550a3cd9f91c57a514",
    ),
    (
        "infra/oci/scripts/verify-live-betting-data-evidence-stan.sh",
        "b258c4f35ba34492cb26b080d41928cdc1e74cf1",
    ),
)
FAILED_PRE_CAS_CONTINUATION_STEPS = (
    (1, "Set up job", "success", "2026-10-19T10:30:19Z", "2026-10-19T10:30:21Z"),
    (2, "Initialize isolated OCI data paths", "success", "2026-10-19T10:30:21Z", "2026-10-19T10:30:21Z"),
    (3, "Checkout approved current master commit", "success", "2026-10-19T10:30:21Z", "2026-10-19T10:30:23Z"),
    (4, "Validate exact SHA phase and trusted upstream runs", "success", "2026-10-19T10:30:23Z", "2026-10-19T10:33:57Z"),
    (5, "Reject competing production activity", "success", "2026-10-19T10:33:57Z", "2026-10-19T10:34:59Z"),
    (6, "Download exact OCI image provenance", "success", "2026-10-19T10:34:59Z", "2026-10-19T10:34:59Z"),
    (7, "Download exact OCI infrastructure provenance", "success", "2026-10-19T10:34:59Z", "2026-10-19T10:35:00Z"),
    (8, "Download exact release disk checkpoint", "success", "2026-10-19T10:35:00Z", "2026-10-19T10:35:01Z"),
    (9, "Download prerequisite data evidence", "success", "2026-10-19T10:35:01Z", "2026-10-19T10:35:02Z"),
    (10, "Download failed deploy protected baseline", "skipped", "2026-10-19T10:35:02Z", "2026-10-19T10:35:02Z"),
    (11, "Download explicitly selected recovery baseline authority", "skipped", "2026-10-19T10:35:02Z", "2026-10-19T10:35:02Z"),
    (12, "Bind historical recovery source through its exact artifact", "skipped", "2026-10-19T10:35:02Z", "2026-10-19T10:35:02Z"),
    (13, "Verify immutable release and phase provenance", "success", "2026-10-19T10:35:02Z", "2026-10-19T10:39:10Z"),
    (14, "Install pinned OCI CLI", "success", "2026-10-19T10:39:10Z", "2026-10-19T10:39:45Z"),
    (15, "Verify OKE identity", "skipped", "2026-10-19T10:39:45Z", "2026-10-19T10:39:45Z"),
    (16, "Verify k3s identity", "success", "2026-10-19T10:39:45Z", "2026-10-19T10:39:47Z"),
    (17, "Reconcile expired and authorize current runner IPv4", "skipped", "2026-10-19T10:39:47Z", "2026-10-19T10:39:47Z"),
    (18, "Configure kubectl from exact cluster OCID", "skipped", "2026-10-19T10:39:47Z", "2026-10-19T10:39:47Z"),
    (19, "Open ephemeral OCI Bastion access to k3s", "success", "2026-10-19T10:39:47Z", "2026-10-19T10:41:04Z"),
    (20, "Verify exact failed-deploy resume state", "success", "2026-10-19T10:41:04Z", "2026-10-19T10:41:43Z"),
    (21, "Capture and validate pre-mutation rollback baseline", "success", "2026-10-19T10:41:43Z", "2026-10-19T10:41:43Z"),
    (22, "Verify reader-qualified released activation state", "skipped", "2026-10-19T10:41:43Z", "2026-10-19T10:41:43Z"),
    (23, "Revalidate exact release disk checkpoint before lock mutation", "success", "2026-10-19T10:41:43Z", "2026-10-19T10:41:46Z"),
    (24, "Acquire database operation lock", "failure", "2026-10-19T10:41:46Z", "2026-10-19T10:46:31Z"),
    (25, "Enter or re-establish live data maintenance", "skipped", "2026-10-19T10:46:31Z", "2026-10-19T10:46:31Z"),
    (26, "Demote and verify exact retained live-acceptance account", "skipped", "2026-10-19T10:46:31Z", "2026-10-19T10:46:31Z"),
    (27, "Delete exact orphaned live-acceptance slips", "skipped", "2026-10-19T10:46:31Z", "2026-10-19T10:46:31Z"),
    (28, "Execute exact-digest live data phase", "skipped", "2026-10-19T10:46:31Z", "2026-10-19T10:46:31Z"),
    (29, "Restore runtime or verify final deploy handoff", "skipped", "2026-10-19T10:46:31Z", "2026-10-19T10:46:31Z"),
    (30, "Capture post-phase runtime baseline", "skipped", "2026-10-19T10:46:31Z", "2026-10-19T10:46:31Z"),
    (31, "Require executed data-step evidence", "skipped", "2026-10-19T10:46:31Z", "2026-10-19T10:46:31Z"),
    (32, "Upload exact sanitized data evidence", "success", "2026-10-19T10:46:31Z", "2026-10-19T10:46:32Z"),
    (33, "Upload protected rollout baselines", "success", "2026-10-19T10:46:32Z", "2026-10-19T10:46:33Z"),
    (34, "Restore runtime or retain hold if final handoff packaging failed", "skipped", "2026-10-19T10:46:33Z", "2026-10-19T10:46:33Z"),
    (35, "Release database operation lock unless handed to deploy", "skipped", "2026-10-19T10:46:33Z", "2026-10-19T10:46:33Z"),
    (36, "Revoke exact runner rule", "skipped", "2026-10-19T10:46:33Z", "2026-10-19T10:46:33Z"),
    (37, "Close ephemeral OCI Bastion access", "success", "2026-10-19T10:46:33Z", "2026-10-19T10:46:54Z"),
    (38, "Remove isolated OCI client state", "success", "2026-10-19T10:46:54Z", "2026-10-19T10:46:59Z"),
    (76, "Post Checkout approved current master commit", "success", "2026-10-19T10:46:59Z", "2026-10-19T10:47:00Z"),
    (77, "Complete job", "success", "2026-10-19T10:47:00Z", "2026-10-19T10:47:00Z"),
)
FAILED_PRE_CAS_CONTINUATION_TRANSITIVE_ARTIFACTS = (
    (
        37576331905,
        ((
            11462663207,
            "MDg6QXJ0aWZhY3QxMTQ2MjY2MzIwNw==",
            "oci-image-provenance-1bf86112ba2458161e6039091b1aa6289fdfce1d-37576331905-1",
            6675,
            "4e394004af1cc0ea92172814ee44be1c2ec73c9e71e494479776e9c6b7fe2832",
            "2026-10-07T05:36:56Z",
            "2026-10-07T05:36:56Z",
            "2026-11-06T05:36:55Z",
            "1bf86112ba2458161e6039091b1aa6289fdfce1d",
        ),),
    ),
    (
        37582984293,
        (
            (
                11465527938,
                "MDg6QXJ0aWZhY3QxMTQ2NTUyNzkzOA==",
                "oci-release-disk-checkpoint-1bf86112ba2458161e6039091b1aa6289fdfce1d-37582984293-1",
                3166,
                "b46fa7541c1935f470983d8c94a1224054796690b99a9f5cfb185433ac3e99de",
                "2026-10-07T06:59:44Z",
                "2026-10-07T06:59:44Z",
                "2026-11-06T06:59:44Z",
                "1bf86112ba2458161e6039091b1aa6289fdfce1d",
            ),
            (
                11465198380,
                "MDg6QXJ0aWZhY3QxMTQ2NTE5ODM4MA==",
                "oci-infrastructure-provenance-37582984293-1",
                3069,
                "635826680d7cf55841e259a4b3a7e55ac243e3c3b5a69000ce01e9240e673717",
                "2026-10-07T06:59:43Z",
                "2026-10-07T06:59:43Z",
                "2026-11-06T06:59:43Z",
                "1bf86112ba2458161e6039091b1aa6289fdfce1d",
            ),
        ),
    ),
    (
        37593753327,
        (
            (
                11469759638,
                "MDg6QXJ0aWZhY3QxMTQ2OTc1OTYzOA==",
                "oci-live-data-rollout-37593753327-1",
                14281,
                "70c4ba9801f868c2a30932fd5d96361117197b6513be5f352d1373e55c6c03a8",
                "2026-10-07T08:50:21Z",
                "2026-10-07T08:50:21Z",
                "2026-11-06T08:50:20Z",
                "1bf86112ba2458161e6039091b1aa6289fdfce1d",
            ),
            (
                11469674713,
                "MDg6QXJ0aWZhY3QxMTQ2OTY3NDcxMw==",
                "oci-live-data-baselines-37593753327-1",
                10314,
                "be5716515ac48be4345e92631fb78938e5380a26825ef6e82d3853ef30a12d73",
                "2026-10-07T08:50:22Z",
                "2026-10-07T08:50:22Z",
                "2026-11-06T08:50:21Z",
                "1bf86112ba2458161e6039091b1aa6289fdfce1d",
            ),
        ),
    ),
    (
        38365002118,
        (
            (
                11798043958,
                "MDg6QXJ0aWZhY3QxMTc5ODA0Mzk1OA==",
                "oci-live-data-baselines-38365002118-1",
                10463,
                "c4f1718b1ada6acdd1361f18ff0481c6e541afac25704aa511bef4d81140a4e4",
                "2026-10-13T08:38:37Z",
                "2026-10-13T08:38:37Z",
                "2026-11-12T08:38:36Z",
                "391604c0fb35daa30ac72b92724d147d57d41371",
            ),
            (
                11798004049,
                "MDg6QXJ0aWZhY3QxMTc5ODAwNDA0OQ==",
                "oci-live-data-rollout-38365002118-1",
                14361,
                "bff8e2317e9438660d5b3ed737e88a1bc9a8e375130415f4441ae0c2a89b2797",
                "2026-10-13T08:38:36Z",
                "2026-10-13T08:38:36Z",
                "2026-11-12T08:38:35Z",
                "391604c0fb35daa30ac72b92724d147d57d41371",
            ),
        ),
    ),
    (
        38635983420,
        (
            (
                11931877422,
                "MDg6QXJ0aWZhY3QxMTkzMTg3NzQyMg==",
                "oci-live-data-baselines-38635983420-1",
                10463,
                "8fcec00a475e47fff19f36622eb76631fe53e31a60645712bf4ad735ba46cb66",
                "2026-10-14T22:06:58Z",
                "2026-10-14T22:06:58Z",
                "2026-11-13T22:06:57Z",
                "7b6c9767e55d356ef1d119fa423d6a876c2e28d0",
            ),
            (
                11931683273,
                "MDg6QXJ0aWZhY3QxMTkzMTY4MzI3Mw==",
                "oci-live-data-rollout-38635983420-1",
                16096,
                "b287b181dbbeed9dbc20bcc5a23829133d63063b956587cde6b8b142539025d7",
                "2026-10-14T22:06:57Z",
                "2026-10-14T22:06:57Z",
                "2026-11-13T22:06:56Z",
                "7b6c9767e55d356ef1d119fa423d6a876c2e28d0",
            ),
        ),
    ),
    (
        39018383213,
        (
            (
                12098621291,
                "MDg6QXJ0aWZhY3QxMjA5ODYyMTI5MQ==",
                "oci-live-data-baselines-39018383213-1",
                11677,
                "fc564f016b2cdf6232c7b01ea2ea58c278905f24b0fd9869483762d5c5a8d6c2",
                "2026-10-17T10:35:28Z",
                "2026-10-17T10:35:28Z",
                "2026-11-16T10:35:27Z",
                "ab32b31e363254abb5ab4b1d48408a1609fe63a9",
            ),
            (
                12097894204,
                "MDg6QXJ0aWZhY3QxMjA5Nzg5NDIwNA==",
                "oci-live-data-rollout-39018383213-1",
                1301,
                "6b725d166f3663fe65bcccd451d7c3d4f92234414eb448e5595d54f97d22e01b",
                "2026-10-17T10:35:27Z",
                "2026-10-17T10:35:27Z",
                "2026-11-16T10:35:26Z",
                "ab32b31e363254abb5ab4b1d48408a1609fe63a9",
            ),
        ),
    ),
    (39114852871, ()),
    (
        39229920454,
        (
            (
                12180488201,
                "MDg6QXJ0aWZhY3QxMjE4MDQ4ODIwMQ==",
                "oci-live-data-baselines-39229920454-1",
                11677,
                "4c28341e6684246722fbdec6a9d3611ee2c3b28dce267d99e9ff72c2b3ac985d",
                "2026-10-19T10:46:33Z",
                "2026-10-19T10:46:33Z",
                "2026-11-18T10:46:32Z",
                "78049ccbeee16811920c36a6076fcf436435ba9f",
            ),
            (
                12180348439,
                "MDg6QXJ0aWZhY3QxMjE4MDM0ODQzOQ==",
                "oci-live-data-rollout-39229920454-1",
                1299,
                "6849f1eddea54770a0abc31cc5717e956e0173b544cb56af91687236f8f637d3",
                "2026-10-19T10:46:32Z",
                "2026-10-19T10:46:32Z",
                "2026-11-18T10:46:31Z",
                "78049ccbeee16811920c36a6076fcf436435ba9f",
            ),
        ),
    ),
)
FAILED_PRE_CAS_CONTINUATION_BASELINE_MEMBERS = (
    FAILED_HELD_CONTINUATION_BASELINE_MEMBERS
)
FAILED_PRE_CAS_CONTINUATION_ROLLOUT_MEMBERS = (
    (
        "held-handoff-history.json",
        "07c4c3e6e7486449cfe1267e012c7cc84d6fc6c4f46a30300a2d9784a65e680c",
    ),
    (
        "resume-authority.env",
        "7a36f1efe1d608b6f00b3aa822aa5b596ce27935bec0aef8b2e8599742a879fa",
    ),
)
FAILED_PRE_CAS_CONTINUATION_LOG_MEMBERS = (
    ("0_rollout.txt", "d7d5a1d780df1d1aec425b82f7394e21ca543d385cb91001ec56a6674abad64a"),
    ("rollout/system.txt", "a71d1ea81c13c918b64150f2763ee91bdacc804fdf014d5a7604b3635c339fff"),
)
FAILED_PRE_CAS_CONTINUATION_LOCK_SOURCE_SHA256 = (
    "a710d990342b1a48ecccfe716eac594eadaa8f7fd489991cd8eb878c9e3f0b6f"
)
FAILED_PRE_CAS_CONTINUATION_LOCK_OUTSIDE_SHA256 = (
    "af763d746f5b0662fdcecd637cc0807fdc6b08562b34c454f38beee7e896dc1e"
)
FAILED_PRE_CAS_CONTINUATION_BASTION_SOURCE_SHA256 = (
    "a5ac02ec830c76daa3ea661931d4cf499fc1e9b07ed1dd9898b23a3d9b2e0fc4"
)
FAILED_PRE_CAS_CONTINUATION_BASTION_OUTSIDE_SHA256 = (
    "44aabf29a926f23ba34efffe225ccc2f8f8492d2a604d83c20dddce96ba36b83"
)
FAILED_PRE_CAS_CONTINUATION_CLIENT_SOURCE_SHA256 = (
    "d2cbc9a64652f7af0d67fdab775b1ac25826d910faefbc8b9e193af5c23da7c2"
)
FAILED_PRE_CAS_CONTINUATION_CLIENT_OUTSIDE_SHA256 = (
    "f628a8a7d0388cd9bed44beee4411da2903047d89e88ae876fd8e3252fd09b6b"
)
FAILED_PRE_CAS_CONTINUATION_FAILURE = (
    "local held authority differs from its fresh authenticated root"
)
LIVE_V6_KEYS = {
    "schema_version",
    "source_sha",
    "build_run_id",
    "infrastructure_run_id",
    "checkpoint_source_sha",
    "disk_checkpoint_run_id",
    "disk_checkpoint_sha256",
    "disk_checkpoint_disposition",
    "baseline_sha256",
    "baseline_recovery_run_id",
    "baseline_recovery_source_sha",
    "workflow_run_id",
    "workflow_run_attempt",
    "phase",
    "status",
    "backfill_complete",
    "index_ready",
    "event_reschedule_complete",
    "backoffice_pre_september_cleanup_complete",
    "maintenance_fence_enforced",
    "writers_quiesced",
    "runtime_held_for_deploy",
    "operation_lock_enforced",
    "operation_lock_handoff",
    "completed_at",
}
LIVE_V6_SCHEMA_KEYS = {
    "schema_version",
    "source_sha",
    "build_run_id",
    "infrastructure_run_id",
    "checkpoint_source_sha",
    "disk_checkpoint_run_id",
    "disk_checkpoint_sha256",
    "disk_checkpoint_disposition",
    "baseline_sha256",
    "baseline_recovery_run_id",
    "baseline_recovery_source_sha",
    "data_run_id",
    "data_run_attempt",
    "backfill_complete",
    "index_ready",
    "event_reschedule_complete",
    "backoffice_pre_september_cleanup_complete",
    "maintenance_fence_enforced",
    "writers_quiesced",
    "runtime_held_for_deploy",
    "operation_lock_enforced",
    "operation_lock_handoff",
}
BASELINE_PROVENANCE_KEYS = {
    "baseline_source_sha",
    "baseline_deploy_workflow",
    "baseline_deploy_run_id",
    "baseline_deploy_run_attempt",
    "baseline_build_workflow",
    "baseline_build_run_id",
    "baseline_build_run_attempt",
    "baseline_recovery_run_id",
    "baseline_recovery_run_attempt",
    "baseline_transition_provenance_file",
    "baseline_capture_run_id",
    "baseline_capture_run_attempt",
    "namespace",
    "public_url",
    "redirect_url",
    "diagnostic_url",
    "http_attempts",
    "http_retry_seconds",
    "alias_probe_mode",
    "sse_path",
    "sse_requirement",
    "sse_required",
    "database_restore",
    "registry_provider",
    "registry_host",
    "registry_repository",
    "registry_public_anonymous",
}
DEPLOYMENT_PROVENANCE_KEYS = {
    "source_sha",
    "source_ref",
    "run_attempt",
    "runtime_mode",
    "runtime_fingerprint",
    "image_provenance_sha256",
    "rendered_manifest_sha256",
    "rabbitmq_baseline_sha256",
    "public_host",
    "canonical_host",
    "redirect_host",
    "diagnostic_host",
    "deployment_workflow",
    "deployment_run_id",
    "deployment_run_attempt",
    "registry_provider",
    "registry_host",
    "registry_repository",
    "registry_public_anonymous",
    "build_run_id",
    "data_run_id",
    "data_run_attempt",
    "data_evidence_sha256",
    "infrastructure_run_id",
    "infrastructure_run_attempt",
    "infrastructure_provenance_sha256",
    "checkpoint_source_sha",
    "disk_checkpoint_run_id",
    "disk_checkpoint_sha256",
    "disk_checkpoint_disposition",
}
DEPLOYMENT_RECOVERY_INTENT_KEYS = {
    "schema_version",
    "source_sha",
    "source_ref",
    "deployment_workflow",
    "deployment_run_id",
    "deployment_run_attempt",
    "runtime_mode",
    "build_run_id",
    "candidate_images_sha256",
    "data_run_id",
    "data_run_attempt",
    "data_evidence_sha256",
    "infrastructure_run_id",
    "infrastructure_run_attempt",
    "infrastructure_provenance_sha256",
    "checkpoint_source_sha",
    "disk_checkpoint_run_id",
    "disk_checkpoint_sha256",
    "disk_checkpoint_disposition",
    "baseline_sha256",
    "baseline_capture_run_id",
    "baseline_recovery_run_id",
    "baseline_recovery_source_sha",
}
DEPLOYMENT_FAILURE_LINEAGE_KEYS = {
    "schema_version",
    "source_sha",
    "deployment_run_id",
    "deployment_run_attempt",
    "intent_sha256",
    "workflow_result",
    "lock_release_outcome",
    "fence_release_outcome",
    "rehold_outcome",
}
ACTIVATION_PROVENANCE_KEYS = {
    "source_sha",
    "build_run_id",
    "infrastructure_run_id",
    "deployment_run_id",
    "checkpoint_source_sha",
    "disk_checkpoint_run_id",
    "disk_checkpoint_sha256",
    "disk_checkpoint_disposition",
    "live_acceptance_user_id",
    "activation_run_id",
    "activation_run_attempt",
    "activate_control_sha256",
    "acceptance_sha256",
    "accepted_sha256",
    "commit_control_sha256",
    "failure_disable_sha256",
    "final_disable_sha256",
    "final_control_file",
    "final_control_sha256",
    "live_kickoffs_enabled",
    "activation_state",
    "activation_lease_until_epoch",
    "workflow_result",
    "workflow_phase",
    "accepted_outcome",
    "accepted_evidence_upload_outcome",
    "commit_preflight_outcome",
    "commit_outcome",
    "failure_disable_outcome",
    "final_disable_outcome",
    "post_commit_status",
    "revoke_runner_outcome",
    "close_bastion_outcome",
}
LIVE_RESUME_AUTHORITY_V2_KEYS = {
    "schema_version",
    "applied_data_run_id",
    "applied_source_sha",
    "failed_deploy_run_id",
    "resume_maintenance_mode",
    "failed_deploy_job_conclusion",
    "public_validate_job_conclusion",
    "lock_release_step_conclusion",
    "fence_release_step_conclusion",
    "rehold_step_conclusion",
    "failed_activation_run_id",
    "current_source_sha",
    "baseline_sha256",
    "runtime_images_sha256",
    "checkpoint_source_sha",
    "disk_checkpoint_run_id",
    "disk_checkpoint_sha256",
    "disk_checkpoint_disposition",
    "application_change_scope",
    "status",
}
LIVE_RESUME_AUTHORITY_V3_KEYS = LIVE_RESUME_AUTHORITY_V2_KEYS | {
    "held_handoff_run_id", "held_handoff_source_sha", "held_handoff_evidence_sha256",
}
HELD_HANDOFF_CONFIRMATION = "CONTINUE SUCCESSFUL HELD LIVE DATA EXACT SHA"
HELD_HANDOFF_DEFAULTS = {
    "held_handoff_run_id": "0",
    "held_handoff_source_sha": "none",
}


def fail(message):
    print(f"upstream binding rejected: {message}", file=sys.stderr)
    raise SystemExit(1)


def _load_shared_authority(module_name, unavailable):
    with _AUTHORITY_IMPORT_LOCK:
        previous_bytecode = sys.dont_write_bytecode
        try:
            sys.dont_write_bytecode = True
            specification = importlib.util.spec_from_file_location(
                module_name,
                Path(__file__).resolve().parents[2]
                / "azure/agents/copilot_cli_authority_stan.py",
            )
            if specification is None or specification.loader is None:
                fail(unavailable)
            authority = importlib.util.module_from_spec(specification)
            specification.loader.exec_module(authority)
        except (OSError, ImportError, SyntaxError):
            fail(unavailable)
        finally:
            sys.dont_write_bytecode = previous_bytecode
    return authority


def live_data_native_inputs(inputs, expected_names):
    if not isinstance(inputs, dict):
        fail("live data native inputs must be an object")
    values = dict(inputs)
    expected = set(expected_names)
    held_fields = set(HELD_HANDOFF_DEFAULTS)
    if held_fields & expected:
        if not held_fields <= expected:
            fail("live data held-handoff input contract is incomplete")
        if (
            type(values.get("held_handoff_run_id")) is not str
            or POSITIVE_INTEGER.fullmatch(values["held_handoff_run_id"]) is None
            or type(values.get("held_handoff_source_sha")) is not str
            or FULL_SHA.fullmatch(values["held_handoff_source_sha"]) is None
            or values.get("confirmation") != HELD_HANDOFF_CONFIRMATION
        ):
            fail("live data held-handoff native inputs are invalid")
    elif held_fields & values.keys():
        if any(type(values.get(key)) is not str or values[key] != value
               for key, value in HELD_HANDOFF_DEFAULTS.items()):
            fail("legacy live data inputs require exact neutral held-handoff defaults")
        for key in held_fields:
            del values[key]
    if set(values) != expected or any(type(value) is not str for value in values.values()):
        fail("live data native input key set or types are invalid")
    return values


def provenance_read_authority():
    authority = _load_shared_authority(
        "provenance_read_authority",
        "shared provenance-read source validator is unavailable",
    )
    if not callable(getattr(authority, "validate_provenance_read_observation", None)):
        fail("shared provenance-read source validator is unavailable")
    return authority


def collect_provenance_read_observation(repository, run_id, observation=None):
    """Collect the leaf native proof without qualifying recovery history."""
    authority = provenance_read_authority()
    endpoint = f"repos/{repository}/actions/runs/{run_id}"
    path = ".github/workflows/oci-live-data-rollout.yml"
    if observation is None:
        latest = gh_api(endpoint)
        job_pages = gh_api_pages(endpoint + "/attempts/1/jobs?per_page=100")
        if (
            len(job_pages) != 1 or not isinstance(job_pages[0], dict)
            or type(job_pages[0].get("total_count")) is not int
            or job_pages[0]["total_count"] != 1
            or not isinstance(job_pages[0].get("jobs"), list)
            or len(job_pages[0]["jobs"]) != 1
        ):
            fail("provenance-read assigned-job inventory is incomplete or extended")
        approvals = gh_api(endpoint + "/approvals?per_page=100")
        pending = gh_api(endpoint + "/pending_deployments?per_page=100")
        if (
            not isinstance(approvals, list) or len(approvals) != 1 or pending != []
        ):
            fail("provenance-read approval or pending-deployment inventory is incomplete")
        inventory = artifact_inventory(repository, run_id, "provenance-read")
        observation = {
            "schemaVersion": authority.PREFLIGHT_READ_EVIDENCE_SCHEMA,
            "run": latest,
            "attempts": [{"run": gh_api(endpoint + "/attempts/1"), "jobs": job_pages[0]}],
            "workflow": gh_api(f"repos/{repository}/actions/workflows/oci-live-data-rollout.yml"),
            "historicalWorkflow": None, "compare": None, "pending": pending,
            "approvals": approvals,
            "artifacts": {"total_count": len(inventory), "artifacts": inventory},
            "closure": {},
        }
    source_sha = observation["run"].get("head_sha")
    if not isinstance(source_sha, str) or FULL_SHA.fullmatch(source_sha) is None:
        fail("provenance-read native historical source is invalid")
    historical = {
        name: gh_api(f"repos/{repository}/contents/{name}?ref={source_sha}")
        for name in authority.PROVENANCE_READ_BLOBS
    }
    dispatch = failed_deploy_native_inputs(
        repository, run_id, source_sha, "provenance-read", resume_dispatch=True,
    )
    capture_id = require_dispatch_run(dispatch, "prerequisite_run_id")
    capture_endpoint = f"repos/{repository}/actions/runs/{capture_id}"
    capture_inventory = artifact_inventory(repository, capture_id, "provenance-read capture")
    failed_inventory = observation["artifacts"].get("artifacts")

    def archived(items, name):
        if not isinstance(items, list):
            fail("provenance-read artifact inventory is malformed")
        selected = [item for item in items if isinstance(item, dict) and item.get("name") == name]
        if len(selected) != 1 or type(selected[0].get("id")) is not int or selected[0]["id"] < 1:
            fail("provenance-read exact artifact is absent or ambiguous")
        artifact_id = selected[0]["id"]
        return {
            "artifactId": artifact_id,
            "bytes": base64.b64encode(gh_api_bytes(
                f"repos/{repository}/actions/artifacts/{artifact_id}/zip",
            )).decode("ascii"),
        }

    previous = observation["closure"]
    current = {
        name: previous[name] for name in ("currentControl", "current")
        if name in previous
    }
    if current:
        current["currentAuthority"] = gh_api(
            f"repos/{repository}/contents/infra/azure/agents/copilot_cli_authority_stan.py"
            f"?ref={current['currentControl']}"
        )
    observation["historicalWorkflow"] = historical[path]
    observation["closure"] = {
        **current, "historicalControl": source_sha,
        "historicalCommit": gh_api(f"repos/{repository}/git/commits/{source_sha}"),
        "historical": historical, "actions": list(authority.PROVENANCE_READ_ACTIONS),
        "dispatchInputs": dispatch,
        "archive": archived(failed_inventory, f"oci-live-data-baselines-{run_id}-1"),
        "capture": {
            "run": gh_api(capture_endpoint), "attempt": gh_api(capture_endpoint + "/attempts/1"),
            "workflow": gh_api(f"repos/{repository}/actions/workflows/oci-live-data-rollout.yml"),
            "artifacts": {"total_count": len(capture_inventory), "artifacts": capture_inventory},
            "dataArchive": archived(capture_inventory, f"oci-live-data-rollout-{capture_id}-1"),
            "baselineArchive": archived(capture_inventory, f"oci-live-data-baselines-{capture_id}-1"),
        },
    }
    return observation


class NativeReadCommand:
    def __init__(self, binding_count):
        if type(binding_count) is not int or binding_count < 0:
            raise ValueError("native binding count is invalid")
        self.limit = min(16, 4 * binding_count)
        self.active = 0
        self.lock = threading.Lock()
        self.cancelled = threading.Event()
        self.interruption = None
        self.handlers = {}
        self.history_proofs = None

    def __enter__(self):
        self.token = NATIVE_CONTEXT.set(self)
        if threading.current_thread() is threading.main_thread():
            for signum in (signal.SIGINT, signal.SIGTERM):
                self.handlers[signum] = signal.getsignal(signum)
                signal.signal(signum, self.interrupt)
        return self

    def __exit__(self, error_type, error, traceback):
        for signum, handler in self.handlers.items():
            signal.signal(signum, handler)
        NATIVE_CONTEXT.reset(self.token)
        if self.active:
            if error is None:
                raise RuntimeError("native command left active child reservations")
            print("native command cleanup left active child reservations", file=sys.stderr)
        if self.interruption is not None:
            raise self.interruption

    def interrupt(self, signum, frame):
        # Raising here could interrupt Popen before its child is registered.
        if self.interruption is None:
            self.interruption = (
                KeyboardInterrupt() if signum == signal.SIGINT else SystemExit(128 + signum)
            )

    def check_cancelled(self):
        if self.interruption is not None:
            self.cancelled.set()
        if self.cancelled.is_set():
            if self.interruption is not None and threading.current_thread() is threading.main_thread():
                raise self.interruption
            raise concurrent.futures.CancelledError("native read command was interrupted")

    def acquire(self):
        with self.lock:
            if self.active >= self.limit:
                return False
            self.active += 1
            return True

    def release(self):
        with self.lock:
            if self.active < 1:
                raise RuntimeError("native child reservation was already released")
            self.active -= 1


def history_worker_context():
    work = getattr(HISTORY_WORKER, "work", None)
    if work is not None and (
        NATIVE_CONTEXT.get() is not work.command.native
        or BYTE_CONTEXT.get() is not work.byte_context
        or BINDING_CONTEXT.get() != work.binding
        or work.command.native.history_proofs is not work.command
    ):
        raise RuntimeError("held-handoff proof lost its authenticated command context")
    return work


class HistoryProofWork:
    def __init__(self, collection, function, arguments):
        self.collection = collection
        self.command = collection.command
        self.ordinal = collection.ordinal
        self.binding = BINDING_CONTEXT.get()
        self.byte_context = BYTE_CONTEXT.get()
        self.context = contextvars.copy_context()
        self.function = function
        self.arguments = arguments
        self.future = None
        self.worker = None
        self.started = False
        self.terminal = False
        self.retired = False
        self.quiesced = False
        self.released = False
        self.proof_error = None
        self.submission_error = None
        self.proof_terminal = threading.Event()
        self.finalized = threading.Event()

    def execute(self):
        with self.command.lock:
            if self.retired or self.started:
                raise RuntimeError("held-handoff proof cannot claim retired or started work")
            self.started = True
            self.worker = threading.current_thread()
        previous = getattr(HISTORY_WORKER, "work", None)
        try:
            if previous is not None:
                raise RuntimeError("held-handoff proof cannot execute descendants")
            HISTORY_WORKER.work = self
            return self.context.run(self.prove)
        except BaseException as error:
            with self.command.lock:
                self.proof_error = error
            self.collection.remember(self.ordinal, error)
            raise
        finally:
            if previous is None:
                if hasattr(HISTORY_WORKER, "work"):
                    del HISTORY_WORKER.work
            else:
                HISTORY_WORKER.work = previous
            with self.command.lock:
                self.terminal = True
            self.proof_terminal.set()

    def prove(self):
        history_worker_context()
        result = self.function(*self.arguments)
        history_worker_context()
        return result


class HistoryProofCommand:
    def __init__(self, native):
        self.native = native
        self.lock = threading.Lock()
        self.submission = threading.Lock()
        self.poisoned = threading.Event()
        self.active = 0
        self.pending = set()

    def __enter__(self):
        if (
            history_worker_context() is not None
            or NATIVE_CONTEXT.get() is not self.native
            or self.native.history_proofs is not None
        ):
            raise RuntimeError("held-handoff proof pool requires its own native command")
        self.executor = concurrent.futures.ThreadPoolExecutor(
            max_workers=4, thread_name_prefix="held-history-proof",
        )
        self.native.history_proofs = self
        return self

    def __exit__(self, error_type, error, traceback):
        try:
            self.executor.shutdown(wait=True)
            if self.active or self.pending:
                if error is None:
                    raise RuntimeError("held-handoff proof command left owned work")
                print("held-handoff proof cleanup left owned work", file=sys.stderr)
        finally:
            self.native.history_proofs = None

    def check_context(self):
        if (
            history_worker_context() is not None
            or NATIVE_CONTEXT.get() is not self.native
            or self.native.history_proofs is not self
            or BYTE_CONTEXT.get() is None
            or not isinstance(BINDING_CONTEXT.get(), str)
            or not BINDING_CONTEXT.get()
        ):
            raise RuntimeError("held-handoff proof requires its authenticated binding context")

    def try_submit(self, collection, function, arguments):
        if not self.submission.acquire(blocking=False):
            return False
        submission_error = None
        try:
            with self.lock:
                if collection.failed or self.poisoned.is_set() or self.active >= 4:
                    return False
                work = HistoryProofWork(collection, function, arguments)
                collection.pending.append(work)
                self.pending.add(work)
                self.active += 1
            try:
                future = self.executor.submit(work.execute)
            except BaseException as error:
                submission_error = error
                with self.lock:
                    work.submission_error = error
                    self.poisoned.set()
                collection.remember(work.ordinal, error, priority=0)
            else:
                with self.lock:
                    work.future = future
                future.add_done_callback(lambda completed: self.complete(work, completed))
        finally:
            self.submission.release()
        if submission_error is not None:
            self.quiesce(work)
            raise submission_error
        return True

    def complete(self, work, future):
        try:
            error = (
                concurrent.futures.CancelledError("held-handoff proof was cancelled")
                if future.cancelled() else future.exception()
            )
            if error is not None:
                work.collection.remember(work.ordinal, error)
            self.release(work, error)
        except BaseException as error:
            work.collection.remember(work.ordinal, error, priority=0)
            raise
        finally:
            work.finalized.set()

    def release(self, work, future_error=None):
        with self.lock:
            if work.released:
                return
            if work.submission_error is not None:
                if not work.quiesced:
                    raise RuntimeError("ambiguous held-handoff proof is not quiescent")
            elif work.future is None or not work.future.done():
                raise RuntimeError("held-handoff proof Future is not terminal")
            elif not work.started:
                if future_error is None:
                    raise RuntimeError("held-handoff proof completed without execution")
                work.retired = True
            if not work.terminal and not work.retired:
                raise RuntimeError("held-handoff proof cleanup is incomplete")
            if self.active < 1:
                raise RuntimeError("held-handoff proof reservation was already released")
            work.released = True
            self.active -= 1
            self.pending.remove(work)

    def quiesce(self, ambiguous):
        with self.lock:
            acknowledged = [work for work in self.pending if work.future is not None]
        for work in acknowledged:
            try:
                work.future.result()
            except BaseException as error:
                work.collection.remember(work.ordinal, error)
            work.finalized.wait()
        self.executor.shutdown(wait=True, cancel_futures=True)
        with self.lock:
            if not ambiguous.started:
                ambiguous.retired = True
            worker = ambiguous.worker
        # Thread.start can raise after starting a worker the executor never registered.
        if worker is not None:
            ambiguous.proof_terminal.wait()
            worker.join()
        with self.lock:
            if ambiguous.started and not ambiguous.terminal:
                raise RuntimeError("ambiguous held-handoff proof cleanup is incomplete")
            ambiguous.quiesced = True
        self.release(ambiguous)
        ambiguous.finalized.set()


class HistoryProofCollection:
    def __init__(self, command):
        self.command = command
        self.lock = command.lock if command is not None else threading.Lock()
        self.ordinal = -1
        self.failed = False
        self.failure = None
        self.pending = []

    def __enter__(self):
        if history_worker_context() is not None:
            raise RuntimeError("held-handoff proof workers cannot collect history")
        return self

    def __exit__(self, error_type, error, traceback):
        if error is not None:
            self.remember(self.ordinal, error, priority=0)
        self.join()
        return False

    def remember(self, ordinal, error, priority=1):
        with self.lock:
            self.failed = True
            if self.failure is None or (ordinal, priority) < self.failure[:2]:
                self.failure = (ordinal, priority, error)

    def before_row(self):
        self.ordinal += 1
        if self.command is not None:
            self.command.native.check_cancelled()
        self.check_failure()

    def check_failure(self):
        with self.lock:
            failed = self.failed
        if failed:
            self.join()

    def run(self, function, *arguments, offload=True):
        if self.command is not None:
            self.command.check_context()
        self.check_failure()
        if (
            offload and self.command is not None
            and self.command.try_submit(self, function, arguments)
        ):
            return
        self.check_failure()
        try:
            function(*arguments)
        except BaseException as error:
            self.remember(self.ordinal, error)
            raise

    def join(self):
        if history_worker_context() is not None:
            raise RuntimeError("held-handoff proof workers cannot wait on history")
        for work in self.pending:
            if work.future is not None:
                try:
                    work.future.result()
                except BaseException as error:
                    self.remember(work.ordinal, error)
            work.finalized.wait()
        self.pending.clear()
        with self.lock:
            failure = self.failure
        if failure is not None:
            raise failure[2]


def native_window(requests):
    history_worker_context()
    started = time.monotonic()
    current = NATIVE_CONTEXT.get()
    scope = contextlib.nullcontext(current) if current is not None else NativeReadCommand(1)
    with scope as native:
        if requests and native.limit == 0:
            raise RuntimeError("native reads require a nonempty binding budget")
        outcomes = [None] * len(requests)
        active = {}
        next_request = 0
        failed = False
        with selectors.DefaultSelector() as ready:
            try:
                while active or next_request < len(requests) and not failed:
                    native.check_cancelled()
                    while not failed and next_request < len(requests) and len(active) < 4:
                        command, timeout = requests[next_request]
                        if timeout is not None and time.monotonic() - started >= timeout:
                            outcomes[next_request] = subprocess.TimeoutExpired(command, timeout)
                            failed = True
                            break
                        if not native.acquire():
                            break
                        try:
                            process = subprocess.Popen(
                                command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0,
                            )
                        except BaseException as error:
                            native.release()
                            if not isinstance(error, OSError):
                                raise
                            outcomes[next_request] = error
                            failed = True
                            break
                        child = {
                            "process": process, "command": command, "timeout": timeout,
                            "stdout": bytearray(), "stderr": bytearray(),
                            "streams": {"stdout", "stderr"}, "timed_out": False,
                        }
                        active[next_request] = child
                        for name in ("stdout", "stderr"):
                            pipe = getattr(process, name)
                            os.set_blocking(pipe.fileno(), False)
                            ready.register(pipe, selectors.EVENT_READ, (next_request, name))
                        next_request += 1
                    if not active:
                        if failed or next_request == len(requests):
                            break
                        native.cancelled.wait(0.01)
                        continue
                    for key, _ in ready.select(0.01):
                        index, name = key.data
                        try:
                            chunk = os.read(key.fd, 65536)
                        except BlockingIOError:
                            continue
                        if chunk:
                            active[index][name].extend(chunk)
                        else:
                            ready.unregister(key.fileobj)
                            active[index]["streams"].remove(name)
                    now = time.monotonic()
                    for index, child in list(active.items()):
                        process = child["process"]
                        returncode = process.poll()
                        if (
                            child["timeout"] is not None
                            and now - started >= child["timeout"]
                            and not child["timed_out"]
                        ):
                            child["timed_out"] = True
                            failed = True
                            if returncode is None:
                                process.kill()
                        if returncode is not None and returncode != 0:
                            failed = True
                        if returncode is None or child["streams"]:
                            continue
                        stdout, stderr = bytes(child["stdout"]), bytes(child["stderr"])
                        if child["timed_out"]:
                            outcomes[index] = subprocess.TimeoutExpired(
                                child["command"], child["timeout"], output=stdout, stderr=stderr,
                            )
                        else:
                            outcomes[index] = subprocess.CompletedProcess(
                                child["command"], returncode, stdout, stderr,
                            )
                        process.stdout.close()
                        process.stderr.close()
                        native.release()
                        del active[index]
            finally:
                original = sys.exc_info()[1]
                cleanup_errors = []
                for child in active.values():
                    process = child["process"]
                    if process.poll() is None:
                        try:
                            process.kill()
                        except ProcessLookupError:
                            pass
                        except OSError as error:
                            cleanup_errors.append(error)
                for child in active.values():
                    process = child["process"]
                    try:
                        process.communicate()
                    except OSError as error:
                        cleanup_errors.append(error)
                    finally:
                        for pipe in (process.stdout, process.stderr):
                            if not pipe.closed:
                                pipe.close()
                        if process.poll() is not None:
                            native.release()
                        else:
                            cleanup_errors.append(RuntimeError("native child was not reaped"))
                if cleanup_errors:
                    if original is None:
                        raise cleanup_errors[0]
                    print("native child cleanup failed", file=sys.stderr)
        return outcomes


def _native_text(raw):
    if isinstance(raw, str):
        return raw
    with io.TextIOWrapper(io.BytesIO(raw)) as stream:
        return stream.read()


def _native_run(command, *, capture_output=True, text=False, check=False, timeout=None):
    if capture_output is not True or check is not False:
        raise ValueError("native reads require captured, explicitly checked outcomes")
    outcome = native_window([(command, timeout)])[0]
    if isinstance(outcome, BaseException):
        raise outcome
    if outcome is None:
        raise RuntimeError("native singleton read did not complete")
    if text:
        return subprocess.CompletedProcess(
            outcome.args, outcome.returncode,
            _native_text(outcome.stdout), _native_text(outcome.stderr),
        )
    return outcome


def _native_json(outcome, path, paginated=False):
    if isinstance(outcome, BaseException):
        raise outcome
    if outcome is None:
        fail(f"native read collection is incomplete for {path}")
    stdout = _native_text(outcome.stdout)
    _native_text(outcome.stderr)
    if outcome.returncode != 0:
        fail(f"unable to read {'all pages of ' if paginated else ''}{path}")
    try:
        payload = json.loads(stdout)
    except json.JSONDecodeError:
        fail(f"malformed {'paginated response' if paginated else 'response'} for {path}")
    if not paginated:
        return payload
    if isinstance(payload, dict):
        return [payload]
    if not isinstance(payload, list) or not all(isinstance(page, dict) for page in payload):
        fail(f"unexpected paginated response for {path}")
    return payload


def native_api_batch(requests):
    outcomes = native_window([
        (["gh", "api", path] + (["--paginate", "--slurp"] if paginated else []), None)
        for path, paginated in requests
    ])
    return [
        _native_json(outcome, path, paginated)
        for (path, paginated), outcome in zip(requests, outcomes)
    ]


def gh_api(path):
    result = _native_run(
        ["gh", "api", path],
        capture_output=True,
        text=True,
        check=False,
    )
    return _native_json(result, path)


def gh_api_pages(path):
    result = _native_run(
        ["gh", "api", path, "--paginate", "--slurp"],
        capture_output=True,
        text=True,
        check=False,
    )
    return _native_json(result, path, True)


def _classify_artifact_download_failure(returncode, stderr):
    if returncode < 0:
        return "cancelled", None, False
    if returncode != 1:
        return "command", None, False
    diagnostic = (stderr or b"").decode("utf-8", errors="replace").strip()
    matches = re.findall(
        r"(?m)^(?:gh: HTTP ([1-5][0-9]{2})|"
        r"gh: [^\r\n]+ \(HTTP ([1-5][0-9]{2})\)|"
        r"HTTP ([1-5][0-9]{2}): [^\r\n]+)$",
        diagnostic,
    )
    statuses = {int(value) for match in matches for value in match if value}
    if len(statuses) > 1:
        return "ambiguous", None, False
    status = statuses.pop() if statuses else None
    if status is not None and status not in {500, 502, 503, 504}:
        return "http", status, False
    if (
        len(diagnostic.splitlines()) > 1
        or len(re.findall(r"\bHTTP [1-5][0-9]{2}\b", diagnostic))
        != (1 if status is not None else 0)
        or re.search(
            r"\b(?:unauthorized|forbidden|permission denied|not found|"
            r"authentication|credentials|not authorized|access denied)\b",
            diagnostic,
            re.IGNORECASE,
        )
    ):
        return "ambiguous", status, False
    if status is not None:
        return "http", status, True
    address = (
        r"(?:[0-9.]+|\[[0-9A-Fa-f:.]+(?:%[A-Za-z0-9_.-]+)?\])"
        r":[0-9]{1,5}"
    )
    network = re.fullmatch(
        r'(?:gh: )?(?:(?:Get|Head) "[^"\r\n]+": )?'
        r"(?:net/http: TLS handshake timeout|"
        r"context deadline exceeded"
        r"(?: \(Client\.Timeout exceeded while awaiting headers\))?|"
        rf"(?:(?P<operation>read|write|dial) tcp "
        rf"(?P<addresses>{address}(?:->{address})?): )?(?:read: )?"
        r"(?:i/o timeout|connection reset by peer))",
        diagnostic,
    )
    if network:
        if network.group("addresses") is not None:
            addresses = network.group("addresses").split("->")
            if len(addresses) != (1 if network.group("operation") == "dial" else 2):
                return "unknown", None, False
            for endpoint in addresses:
                host, port = endpoint.rsplit(":", 1)
                try:
                    ipaddress.ip_address(host[1:-1] if host.startswith("[") else host)
                except ValueError:
                    return "unknown", None, False
                if not 1 <= int(port) <= 65535:
                    return "unknown", None, False
        return "network", None, True
    return "unknown", None, False


def _artifact_download_diagnostic(stderr):
    try:
        text = (stderr or b"").decode("utf-8").strip()
    except UnicodeDecodeError:
        return "unclassified"
    prefix = r'(?:gh: )?(?:(?:Get|Head) "[^"\r\n]+": )?'
    signatures = (
        (r"net/http: TLS handshake timeout", "tls-handshake-timeout"),
        (
            r"context deadline exceeded(?: \(Client\.Timeout exceeded while awaiting headers\))?",
            "deadline-exceeded",
        ),
        (r"i/o timeout", "io-timeout"),
    )
    matches = [
        code for signature, code in signatures
        if re.fullmatch(prefix + signature, text)
    ]
    return matches[0] if len(matches) == 1 else "unclassified"


def gh_api_bytes(path):
    cache = BYTE_CONTEXT.get()
    if cache is not None and re.fullmatch(
        r"repos/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/actions/runs/[1-9][0-9]*/attempts/1/logs",
        path,
    ):
        return cache.read(
            ("native-attempt-one-zip", path), lambda: download_api_bytes(path),
            share=False, reuse=False,
        )
    return download_api_bytes(path)


def command_owner_is_ancestor(owner):
    if not isinstance(owner, str) or POSITIVE_INTEGER.fullmatch(owner) is None:
        return False
    parent = os.getppid()
    for _ in range(3):
        if parent == int(owner):
            return True
        result = subprocess.run(
            ["ps", "-o", "ppid=", "-p", str(parent)],
            capture_output=True, text=True, check=False,
        )
        if result.returncode or not result.stdout.strip().isdigit():
            return False
        parent = int(result.stdout.strip())
    return False


class ImmutableBindingBytes:
    def __init__(self, context):
        self.context = context
        self.entries = {}
        self.locks = {}
        self.lock = threading.Lock()
        self.workspace = None
        owner = os.environ.get("BETSTAN_APPROVAL_BYTES_OWNER", "")
        if owner:
            if POSITIVE_INTEGER.fullmatch(owner) is None:
                fail("approval byte workspace owner is invalid")
            try:
                info = os.fstat(9)
                if (
                    not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid()
                    or stat.S_IMODE(info.st_mode) != 0o700
                ):
                    fail("approval byte workspace is not a private owned directory")
                self.workspace = 9
                if self._read_file("owner", 64) != owner.encode():
                    fail("approval byte workspace belongs to another command")
                if not command_owner_is_ancestor(owner):
                    fail("approval byte workspace owner is not this command")
            except OSError:
                fail("approval byte workspace is unavailable")

    def _read_file(self, name, limit):
        descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=self.workspace)
        with os.fdopen(descriptor, "rb") as handle:
            info = os.fstat(handle.fileno())
            if (
                not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1
                or not 0 < info.st_size <= limit
            ):
                fail("approval byte workspace entry is unsafe")
            raw = handle.read(limit + 1)
            if len(raw) != info.st_size:
                fail("approval byte workspace entry changed while reading")
            return raw

    def _write_file(self, name, raw):
        descriptor = os.open(
            name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o600, dir_fd=self.workspace,
        )
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(raw)

    def read(
        self, identity, loader, *, expected_sha256=None, expected_blob=None,
        share=True, reuse=True,
    ):
        if type(share) is not bool or type(reuse) is not bool:
            fail("immutable binding byte reuse mode is invalid")
        key = hashlib.sha256(json.dumps(
            [self.context, identity], sort_keys=True, separators=(",", ":"),
        ).encode()).hexdigest()
        with self.lock:
            entry_lock = self.locks.setdefault(key, threading.Lock())
        with entry_lock:
            entry = self.entries.get(key) if reuse else None
            try:
                if entry is None and reuse and self.workspace is not None and share:
                    try:
                        raw = self._read_file(key + ".bin", MAX_ARTIFACT_ARCHIVE_BYTES)
                    except FileNotFoundError:
                        try:
                            os.stat(key + ".sha256", dir_fd=self.workspace, follow_symlinks=False)
                        except FileNotFoundError:
                            pass
                        else:
                            fail("approval byte workspace is incomplete")
                    else:
                        digest = self._read_file(key + ".sha256", 64).decode("ascii")
                        entry = (raw, digest)
                if entry is None:
                    raw = loader()
                    if not isinstance(raw, bytes) or not 0 < len(raw) <= MAX_ARTIFACT_ARCHIVE_BYTES:
                        fail("immutable binding bytes have an invalid size")
                    entry = (raw, hashlib.sha256(raw).hexdigest())
                    self._verify(entry, expected_sha256, expected_blob)
                    if reuse and self.workspace is not None and share:
                        self._write_file(key + ".bin", raw)
                        self._write_file(key + ".sha256", entry[1].encode())
                self._verify(entry, expected_sha256, expected_blob)
                if reuse:
                    self.entries[key] = entry
                return entry[0]
            except (OSError, UnicodeError):
                fail("approval byte workspace is incomplete or unsafe")

    @staticmethod
    def _verify(entry, expected_sha256, expected_blob):
        raw, recorded = entry
        actual = hashlib.sha256(raw).hexdigest()
        if recorded != actual or expected_sha256 is not None and actual != expected_sha256:
            fail("immutable binding byte checksum differs")
        if expected_blob is not None and hashlib.sha1(
            f"blob {len(raw)}\0".encode() + raw
        ).hexdigest() != expected_blob:
            fail("immutable binding source blob differs")


def artifact_archive(repository, artifact, label):
    artifact_id = artifact.get("id")
    if type(artifact_id) is not int or artifact_id < 1:
        fail(f"{label} artifact has an invalid ID")
    digest = artifact.get("digest")
    if digest is not None and (
        not isinstance(digest, str) or re.fullmatch(r"sha256:[0-9a-f]{64}", digest) is None
    ):
        fail(f"{label} artifact has an invalid archive digest")
    loader = lambda: gh_api_bytes(
        f"repos/{repository}/actions/artifacts/{artifact_id}/zip"
    )
    cache = BYTE_CONTEXT.get()
    if cache is not None:
        return cache.read(
            ("artifact-zip", repository, artifact), loader,
            expected_sha256=digest[7:] if digest else None,
            share=digest is not None,
        )
    raw = loader()
    if digest is not None and hashlib.sha256(raw).hexdigest() != digest[7:]:
        fail(f"{label} artifact archive digest differs")
    return raw


def download_api_bytes(path):
    if re.fullmatch(r"repos/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/actions/artifacts/[1-9][0-9]*/zip", path):
        request_kind = "artifact-zip"
    elif re.fullmatch(r"repos/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/actions/jobs/[1-9][0-9]*/logs", path):
        request_kind = "job-log"
    elif re.fullmatch(r"repos/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/actions/runs/[1-9][0-9]*/attempts/1/logs", path):
        request_kind = "attempt-log-zip"
    else:
        request_kind = "unrecognized"
    for attempt in range(1, ARTIFACT_DOWNLOAD_ATTEMPTS + 1):
        captured_stderr = None
        try:
            result = _native_run(
                ["gh", "api", path],
                capture_output=True,
                check=False,
                timeout=ARTIFACT_DOWNLOAD_TIMEOUT_SECONDS,
            )
        except subprocess.TimeoutExpired:
            classification, status, retryable = "timeout", None, True
        except OSError:
            classification, status, retryable = "local-execution", None, False
        else:
            if result.returncode == 0:
                if not result.stdout:
                    classification = "empty-body"
                elif len(result.stdout) > MAX_ARTIFACT_ARCHIVE_BYTES:
                    classification = "oversized-body"
                else:
                    return result.stdout
                status, retryable = None, False
            else:
                captured_stderr = result.stderr
                classification, status, retryable = (
                    _classify_artifact_download_failure(
                        result.returncode, result.stderr
                    )
                )
        disposition = (
            "retry" if attempt < ARTIFACT_DOWNLOAD_ATTEMPTS else "exhausted"
        ) if retryable else "not-retryable"
        diagnostic = (
            _artifact_download_diagnostic(captured_stderr)
            if classification == "network" else "unclassified"
        )
        message = f"artifact download classification={classification}"
        if status is not None:
            message += f" status={status}"
        message += (
            f" attempt={attempt}/{ARTIFACT_DOWNLOAD_ATTEMPTS}"
            f" disposition={disposition}"
            f" request_kind={request_kind} diagnostic={diagnostic}"
        )
        if disposition != "retry":
            fail(message)
        print(message, file=sys.stderr)
        time.sleep(ARTIFACT_DOWNLOAD_BACKOFF_SECONDS[attempt - 1])


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
            equality_values = (
                (binding.get("artifactContent") or {}).get("equals") or {}
            ).values()
            content_binds_identity = (
                "{subject_sha}" in equality_values
                and "{run_id}" in equality_values
            )
            if (
                ("{subject_sha}" not in artifact or "{run_id}" not in artifact)
                and not content_binds_identity
                and binding.get("artifactValidatorProfile") is None
            ):
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
    expected_head_input = binding.get("expectedHeadShaInput")
    if expected_head_input is not None and (
        not isinstance(expected_head_input, str)
        or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", expected_head_input)
    ):
        fail("binding expectedHeadShaInput must name a dispatch input")
    expected_conclusion = binding.get("expectedConclusion", "success")
    if expected_conclusion not in {"success", "failure"}:
        fail("binding expectedConclusion is unsupported")
    artifact_profile = binding.get("artifactValidatorProfile")
    if artifact_profile is not None and artifact_profile not in ARTIFACT_VALIDATOR_PROFILES:
        fail("binding artifactValidatorProfile is unsupported")
    run_profile = binding.get("runProfile")
    if run_profile is not None and run_profile not in RUN_PROFILES:
        fail("binding runProfile is unsupported")
    held_profile = run_profile == "oci-successful-held-handoff-v1"
    if held_profile:
        if (
            expected_conclusion != "success"
            or binding["input"] != "held_handoff_run_id"
            or binding.get("expectedHeadShaInput") != "held_handoff_source_sha"
            or binding["workflow"] != "oci-live-data-rollout.yml"
        ):
            fail("successful held-handoff profile has a substituted binding")
    elif (expected_conclusion == "failure") != (run_profile is not None):
        fail("failure conclusions are permitted only with a fixed recovery runProfile")
    if run_profile is not None and not held_profile:
        expected_workflow = (
            "oci-live-betting-activate.yml"
            if run_profile in {
                "oci-failed-activation-cleanup-v1",
                "oci-failed-activation-released-resume-v1",
            }
            else "oci-production-deploy.yml"
        )
        if binding["workflow"] != expected_workflow:
            fail("binding runProfile does not match its fixed workflow")
    if run_profile == "oci-failed-activation-released-resume-v1" and (
        binding["input"] != "failed_activation_run_id"
        or expected_head_input != "resume_source_sha"
        or binding["artifactTemplate"] != "oci-live-activation-recovery-{run_id}-1"
        or titles != {"workflow_dispatch": "oci-live-activate {subject_sha}"}
    ):
        fail("released activation profile has a substituted binding")
    if artifact_profile is not None and binding["workflow"] != "oci-infrastructure.yml":
        fail("release checkpoint validation is fixed to oci-infrastructure.yml")
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
    archive = artifact_archive(repository, artifact, binding["input"])
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


def artifact_inventory(repository, run_id, label):
    pages = gh_api_pages(
        f"repos/{repository}/actions/runs/{run_id}/artifacts?per_page=100"
    )
    return artifacts_from_pages(pages, label)


def artifacts_from_pages(pages, label):
    total_counts = {page.get("total_count") for page in pages}
    if (
        len(total_counts) != 1
        or not all(type(count) is int and count >= 0 for count in total_counts)
    ):
        fail(f"{label} artifact inventory has an invalid total count")
    artifacts = []
    for page in pages:
        page_artifacts = page.get("artifacts")
        if not isinstance(page_artifacts, list) or not all(
            isinstance(item, dict) for item in page_artifacts
        ):
            fail(f"{label} artifact inventory has an invalid page")
        artifacts.extend(page_artifacts)
    if len(artifacts) != next(iter(total_counts)):
        fail(f"{label} artifact inventory is incomplete")
    return artifacts


def exact_artifact(repository, run_id, name, label):
    matches = [
        item for item in artifact_inventory(repository, run_id, label)
        if item.get("name") == name
    ]
    if len(matches) != 1:
        fail(f"{label} expects exactly one {name} artifact, found {len(matches)}")
    artifact = matches[0]
    if artifact.get("expired") is not False:
        fail(f"{label} artifact {name} is expired")
    size = artifact.get("size_in_bytes")
    if type(size) is not int or size <= 0 or size > MAX_ARTIFACT_ARCHIVE_BYTES:
        fail(f"{label} artifact {name} has an invalid size")
    return artifact


def artifact_files(
    repository,
    artifact,
    label,
    *,
    allowed_empty_suffixes=frozenset(),
):
    artifact_id = artifact.get("id")
    if type(artifact_id) is not int or artifact_id < 1:
        fail(f"{label} artifact has an invalid ID")
    archive = artifact_archive(repository, artifact, label)
    return zip_files(archive, label, allowed_empty_suffixes=allowed_empty_suffixes)


def zip_files(
    archive, label, *, allowed_empty_suffixes=frozenset(), require_original_names=False,
):
    try:
        with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
            infos = bundle.infolist()
            files = {}
            total_size = 0
            for info in infos:
                if require_original_names and info.orig_filename != info.filename:
                    fail(f"{label} native log archive contains a modified entry name")
                mode = (info.external_attr >> 16) & 0o170000
                if mode == stat.S_IFLNK:
                    fail(f"{label} artifact contains a symlink")
                if "\\" in info.filename:
                    fail(f"{label} artifact contains a non-canonical path")
                normalized = (
                    info.filename[:-1]
                    if info.is_dir() and info.filename.endswith("/")
                    else info.filename
                )
                parts = normalized.split("/")
                if (
                    normalized.startswith("/")
                    or any(part in {"", ".", ".."} for part in parts)
                ):
                    fail(f"{label} artifact contains an unsafe path")
                if info.is_dir():
                    continue
                if mode not in {0, stat.S_IFREG}:
                    fail(f"{label} artifact contains a non-regular file")
                if info.flag_bits & 0x1:
                    fail(f"{label} artifact contains encrypted content")
                if normalized in files:
                    fail(f"{label} artifact contains duplicate paths")
                empty_allowed = any(
                    normalized == suffix
                    or normalized.endswith(f"/{suffix}")
                    for suffix in allowed_empty_suffixes
                )
                if (
                    (info.file_size < 1 and not empty_allowed)
                    or info.file_size > MAX_ARTIFACT_EVIDENCE_BYTES
                ):
                    fail(f"{label} artifact evidence size is invalid")
                total_size += info.file_size
                if total_size > MAX_ARTIFACT_ARCHIVE_BYTES:
                    fail(f"{label} artifact expanded content is oversized")
                files[normalized] = bundle.read(info)
            if not files:
                fail(f"{label} artifact contains no evidence files")
            return files
    except zipfile.BadZipFile:
        fail(f"{label} artifact is not a valid ZIP archive")


def unique_artifact_file(files, file_name, label):
    matches = [
        (path, raw)
        for path, raw in files.items()
        if path.rsplit("/", 1)[-1] == file_name
    ]
    if len(matches) != 1:
        fail(f"{label} artifact expects exactly one {file_name}")
    return matches[0]


def artifact_member(repository, artifact, file_name, label):
    _, raw = unique_artifact_file(
        artifact_files(repository, artifact, label),
        file_name,
        label,
    )
    return raw


def parse_env(raw, label, expected_keys=None):
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        fail(f"{label} is not UTF-8")
    values = {}
    for line in text.splitlines():
        if not line or "=" not in line:
            fail(f"{label} is malformed")
        key, value = line.split("=", 1)
        if (
            not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key)
            or key in values
            or any(ord(character) < 0x20 for character in value)
        ):
            fail(f"{label} is unsafe")
        values[key] = value
    if expected_keys is not None and set(values) != expected_keys:
        fail(f"{label} has an unexpected key set")
    return values


def validate_checksum_manifest(files, label):
    manifest_path, raw_manifest = unique_artifact_file(
        files, "SHA256SUMS", label
    )
    try:
        lines = raw_manifest.decode("utf-8").splitlines()
    except UnicodeDecodeError:
        fail(f"{label} checksum manifest is not UTF-8")
    prefix = manifest_path.rsplit("/", 1)[0] + "/" if "/" in manifest_path else ""
    manifest = {}
    for line in lines:
        match = re.fullmatch(r"([0-9a-f]{64})  ([A-Za-z0-9._/-]+)", line)
        if match is None:
            fail(f"{label} checksum manifest is malformed")
        relative = match.group(2)
        if (
            relative.startswith("/")
            or "\\" in relative
            or any(part in {"", ".", ".."} for part in relative.split("/"))
            or relative in manifest
            or relative == "SHA256SUMS"
        ):
            fail(f"{label} checksum manifest contains an unsafe path")
        manifest[relative] = match.group(1)
    expected_paths = {prefix + relative for relative in manifest}
    if set(files) != expected_paths | {manifest_path}:
        fail(f"{label} checksum manifest does not bind the exact artifact")
    for relative, digest in manifest.items():
        if hashlib.sha256(files[prefix + relative]).hexdigest() != digest:
            fail(f"{label} checksum mismatch for {relative}")
    return hashlib.sha256(raw_manifest).hexdigest()


def candidate_images_checksum(raw):
    try:
        lines = raw.decode("utf-8").splitlines()
    except UnicodeDecodeError:
        fail("current build candidate image evidence is not UTF-8")
    rows = []
    digest = re.compile(r"^sha256:[0-9a-f]{64}$")
    for line in lines:
        fields = line.split("\t")
        if len(fields) != 5:
            fail("current build candidate image evidence has an invalid schema")
        service, repository, image_ref, manifest, platform = fields
        if (
            service not in CURRENT_SERVICES
            or repository != APPLICATION_REPOSITORY
            or image_ref != f"{repository}@{manifest}"
            or digest.fullmatch(manifest) is None
            or digest.fullmatch(platform) is None
        ):
            fail("current build candidate image evidence is invalid")
        rows.append(
            {
                "service": service,
                "imageRef": image_ref,
                "manifestDigest": manifest,
                "platformDigest": platform,
            }
        )
    if len(rows) != 10 or {item["service"] for item in rows} != CURRENT_SERVICES:
        fail("current build candidate image evidence is incomplete")
    canonical = json.dumps(
        sorted(rows, key=lambda item: item["service"]),
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    return hashlib.sha256(canonical).hexdigest()


def require_dispatch_sha(dispatch_inputs, name):
    value = dispatch_inputs.get(name)
    if not isinstance(value, str) or FULL_SHA.fullmatch(value) is None:
        fail(f"dispatch input {name} is not a full SHA")
    return value


def require_dispatch_run(dispatch_inputs, name):
    value = str(dispatch_inputs.get(name, ""))
    if POSITIVE_INTEGER.fullmatch(value) is None:
        fail(f"dispatch input {name} is not a positive run ID")
    return value


def parse_checkpoint_artifact(
    repository,
    dispatch_inputs,
    runtime_mode,
    label="release checkpoint",
):
    if runtime_mode not in {"k3s", "oke"}:
        fail("authoritative OCI runtime mode is required for checkpoint lineage")
    source_sha = require_dispatch_sha(dispatch_inputs, "checkpoint_source_sha")
    checkpoint_run = require_dispatch_run(dispatch_inputs, "disk_checkpoint_run_id")
    build_run = require_dispatch_run(dispatch_inputs, "build_run_id")
    infrastructure_run = require_dispatch_run(
        dispatch_inputs, "infrastructure_run_id"
    )
    artifact = exact_artifact(
        repository,
        checkpoint_run,
        f"oci-release-disk-checkpoint-{source_sha}-{checkpoint_run}-1",
        label,
    )
    files = artifact_files(repository, artifact, label)
    checkpoint_path, raw = unique_artifact_file(files, "checkpoint.json", label)
    if set(files) != {checkpoint_path}:
        fail(f"{label} artifact contains unexpected files")
    try:
        checkpoint_text = raw.decode("utf-8")
        checkpoint = json.loads(checkpoint_text)
    except (UnicodeDecodeError, json.JSONDecodeError):
        fail(f"{label} artifact is malformed JSON")
    if not isinstance(checkpoint, dict):
        fail(f"{label} artifact is not an object")
    helper = Path(__file__).with_name("k3s_disk_recovery_stan.py")
    command = [
        sys.executable,
        str(helper),
        "validate-release-checkpoint",
        "--checkpoint-json",
        checkpoint_text,
        "--source-sha",
        source_sha,
        "--producer-run-id",
        checkpoint_run,
        "--runtime-mode",
        runtime_mode,
        "--infrastructure-run-id",
        infrastructure_run,
        "--ghcr-build-run-id",
        build_run,
    ]
    if runtime_mode == "k3s":
        build_artifact = exact_artifact(
            repository,
            build_run,
            f"oci-image-provenance-{source_sha}-{build_run}-1",
            f"{label} build",
        )
        candidate_hash = candidate_images_checksum(
            artifact_member(
                repository,
                build_artifact,
                "images.tsv",
                f"{label} build",
            )
        )
        command.extend(("--expected-candidate-images-sha256", candidate_hash))
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        fail(f"repository-fixed validator rejected {label}")
    return checkpoint


def parse_live_v6_artifact(repository, run_id, label, *, include_files=False):
    artifact = exact_artifact(
        repository,
        run_id,
        f"oci-live-data-rollout-{run_id}-1",
        label,
    )
    files = artifact_files(repository, artifact, label)
    manifest_sha256 = validate_checksum_manifest(files, label)
    _, raw = unique_artifact_file(files, "provenance.env", label)
    values = parse_env(raw, f"{label} provenance", LIVE_V6_KEYS)
    if (
        values["schema_version"] != "live-betting-v6"
        or values["workflow_run_id"] != run_id
        or values["workflow_run_attempt"] != "1"
        or values["status"] != "PASS"
        or FULL_SHA.fullmatch(values["source_sha"]) is None
        or FULL_SHA.fullmatch(values["checkpoint_source_sha"]) is None
        or POSITIVE_INTEGER.fullmatch(values["build_run_id"]) is None
        or POSITIVE_INTEGER.fullmatch(values["infrastructure_run_id"]) is None
        or POSITIVE_INTEGER.fullmatch(values["disk_checkpoint_run_id"]) is None
        or re.fullmatch(r"[0-9a-f]{64}", values["disk_checkpoint_sha256"]) is None
        or values["disk_checkpoint_disposition"]
        not in {"READY_NO_RECLAIM", "READY_RECLAIMED", "NOT_APPLICABLE"}
        or re.fullmatch(r"[0-9a-f]{64}", values["baseline_sha256"]) is None
        or values["baseline_recovery_run_id"] != "0"
        and POSITIVE_INTEGER.fullmatch(values["baseline_recovery_run_id"]) is None
        or values["baseline_recovery_run_id"] == "0"
        and values["baseline_recovery_source_sha"] != "none"
        or values["baseline_recovery_run_id"] != "0"
        and FULL_SHA.fullmatch(values["baseline_recovery_source_sha"]) is None
        or not re.fullmatch(
            r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z",
            values["completed_at"],
        )
    ):
        fail(f"{label} is not complete live-betting-v6 evidence")
    if include_files:
        return values, manifest_sha256, files
    return values, manifest_sha256


def validate_live_v6_lineage(
    values,
    checkpoint,
    dispatch_inputs,
    expected_run,
    expected_source,
    expected_phase,
    label,
):
    baseline_recovery_run = str(
        dispatch_inputs.get("baseline_recovery_run_id", "")
    )
    baseline_recovery_source = str(
        dispatch_inputs.get(
            "baseline_recovery_source_sha",
            "none" if baseline_recovery_run == "0" else "",
        )
    )
    expected = {
        "source_sha": expected_source,
        "build_run_id": require_dispatch_run(dispatch_inputs, "build_run_id"),
        "infrastructure_run_id": require_dispatch_run(
            dispatch_inputs, "infrastructure_run_id"
        ),
        "checkpoint_source_sha": require_dispatch_sha(
            dispatch_inputs, "checkpoint_source_sha"
        ),
        "disk_checkpoint_run_id": require_dispatch_run(
            dispatch_inputs, "disk_checkpoint_run_id"
        ),
        "disk_checkpoint_sha256": checkpoint.get("contentChecksumSha256"),
        "disk_checkpoint_disposition": checkpoint.get("disposition"),
        "workflow_run_id": expected_run,
        "workflow_run_attempt": "1",
        "phase": expected_phase,
        "baseline_recovery_run_id": baseline_recovery_run,
        "baseline_recovery_source_sha": baseline_recovery_source,
    }
    for key, expected_value in expected.items():
        if values.get(key) != expected_value:
            fail(f"{label} field {key} does not match the exact lineage")
    if (
        checkpoint.get("sourceSha") != expected["checkpoint_source_sha"]
        or checkpoint.get("ghcrBuildRunId") != expected["build_run_id"]
        or checkpoint.get("infrastructureRunId")
        != expected["infrastructure_run_id"]
    ):
        fail(f"{label} checkpoint build or infrastructure lineage differs")
    control_expected = {
        "dry-run": {
            "maintenance_fence_enforced": "false",
            "writers_quiesced": "false",
            "runtime_held_for_deploy": "false",
            "operation_lock_enforced": "true",
            "operation_lock_handoff": "false",
        },
        "apply-backfills": {
            "backfill_complete": "true",
            "event_reschedule_complete": "true",
            "maintenance_fence_enforced": "true",
            "writers_quiesced": "true",
            "runtime_held_for_deploy": "false",
            "operation_lock_enforced": "true",
            "operation_lock_handoff": "false",
        },
        "apply-slip-index": {
            "backfill_complete": "true",
            "index_ready": "true",
            "event_reschedule_complete": "true",
            "backoffice_pre_september_cleanup_complete": "true",
            "maintenance_fence_enforced": "true",
            "writers_quiesced": "true",
            "runtime_held_for_deploy": "true",
            "operation_lock_enforced": "true",
            "operation_lock_handoff": "true",
        },
    }[expected_phase]
    for key, expected_value in control_expected.items():
        if values.get(key) != expected_value:
            fail(f"{label} field {key} does not match the complete v6 state")


def parse_infrastructure_provenance(
    repository,
    source_sha,
    infrastructure_run,
    build_run,
    label,
):
    artifact = exact_artifact(
        repository,
        infrastructure_run,
        f"oci-infrastructure-provenance-{infrastructure_run}-1",
        label,
    )
    files = artifact_files(repository, artifact, label)
    _, raw = unique_artifact_file(files, "provenance.env", label)
    values = parse_env(raw, f"{label} provenance")
    expected = {
        "source_sha": source_sha,
        "infrastructure_run_id": infrastructure_run,
        "infrastructure_run_attempt": "1",
        "infrastructure_finalized": "true",
        "ghcr_build_run_id": build_run,
    }
    for key, expected_value in expected.items():
        if values.get(key) != expected_value:
            fail(f"{label} field {key} differs from the exact lineage")
    return values, hashlib.sha256(raw).hexdigest()


def exact_basename_set(files):
    return {path.rsplit("/", 1)[-1] for path in files}


def parse_deployment_artifact(
    repository,
    deployment_run,
    subject_sha,
    dispatch_inputs,
    checkpoint,
    predecessor,
    predecessor_manifest_sha256,
    runtime_mode,
    label,
):
    artifact = exact_artifact(
        repository,
        deployment_run,
        f"oci-deploy-provenance-{deployment_run}-1",
        label,
    )
    files = artifact_files(repository, artifact, label)
    expected_files = {
        "provenance.txt",
        "images.tsv",
        "rabbitmq-baseline.txt",
        "live-schema.env",
    }
    if exact_basename_set(files) != expected_files or len(files) != len(expected_files):
        fail(f"{label} artifact has an unexpected file set")
    _, provenance_raw = unique_artifact_file(files, "provenance.txt", label)
    provenance = parse_env(
        provenance_raw,
        f"{label} provenance",
        DEPLOYMENT_PROVENANCE_KEYS,
    )
    _, images_raw = unique_artifact_file(files, "images.tsv", label)
    _, rabbit_raw = unique_artifact_file(files, "rabbitmq-baseline.txt", label)
    _, schema_raw = unique_artifact_file(files, "live-schema.env", label)
    schema = parse_env(schema_raw, f"{label} live schema", LIVE_V6_SCHEMA_KEYS)
    checkpoint_source = require_dispatch_sha(
        dispatch_inputs, "checkpoint_source_sha"
    )
    build_run = require_dispatch_run(dispatch_inputs, "build_run_id")
    infrastructure_run = require_dispatch_run(
        dispatch_inputs, "infrastructure_run_id"
    )
    data_run = predecessor["workflow_run_id"]
    expected = {
        "source_sha": subject_sha,
        "source_ref": "refs/heads/master",
        "run_attempt": "1",
        "runtime_mode": runtime_mode,
        "deployment_workflow": "oci-production-deploy",
        "deployment_run_id": deployment_run,
        "deployment_run_attempt": "1",
        "registry_provider": "ghcr",
        "registry_host": "ghcr.io",
        "registry_repository": APPLICATION_REPOSITORY,
        "registry_public_anonymous": "true",
        "build_run_id": build_run,
        "data_run_id": data_run,
        "data_run_attempt": "1",
        "data_evidence_sha256": predecessor_manifest_sha256,
        "infrastructure_run_id": infrastructure_run,
        "infrastructure_run_attempt": "1",
        "checkpoint_source_sha": checkpoint_source,
        "disk_checkpoint_run_id": checkpoint["producerRunId"],
        "disk_checkpoint_sha256": checkpoint["contentChecksumSha256"],
        "disk_checkpoint_disposition": checkpoint["disposition"],
    }
    for key, expected_value in expected.items():
        if provenance.get(key) != expected_value:
            fail(f"{label} field {key} differs from the exact lineage")
    if (
        hashlib.sha256(images_raw).hexdigest()
        != provenance["image_provenance_sha256"]
        or hashlib.sha256(rabbit_raw).hexdigest()
        != provenance["rabbitmq_baseline_sha256"]
    ):
        fail(f"{label} embedded evidence checksum differs")
    build_artifact = exact_artifact(
        repository,
        build_run,
        f"oci-image-provenance-{checkpoint_source}-{build_run}-1",
        f"{label} build",
    )
    build_images_raw = artifact_member(
        repository,
        build_artifact,
        "images.tsv",
        f"{label} build",
    )
    if candidate_images_checksum(images_raw) != candidate_images_checksum(
        build_images_raw
    ):
        fail(f"{label} candidate images differ from the original build")
    _, infrastructure_sha256 = parse_infrastructure_provenance(
        repository,
        checkpoint_source,
        infrastructure_run,
        build_run,
        f"{label} infrastructure",
    )
    if provenance["infrastructure_provenance_sha256"] != infrastructure_sha256:
        fail(f"{label} infrastructure checksum differs")
    schema_expected = {
        "source_sha": predecessor["source_sha"],
        "build_run_id": build_run,
        "infrastructure_run_id": infrastructure_run,
        "checkpoint_source_sha": checkpoint_source,
        "disk_checkpoint_run_id": checkpoint["producerRunId"],
        "disk_checkpoint_sha256": checkpoint["contentChecksumSha256"],
        "disk_checkpoint_disposition": checkpoint["disposition"],
        "baseline_sha256": predecessor["baseline_sha256"],
        "baseline_recovery_run_id": predecessor["baseline_recovery_run_id"],
        "baseline_recovery_source_sha":
            predecessor["baseline_recovery_source_sha"],
        "data_run_id": data_run,
        "data_run_attempt": "1",
        "schema_version": "live-betting-v6",
    }
    for key, expected_value in schema_expected.items():
        if schema.get(key) != expected_value:
            fail(f"{label} live schema field {key} differs")
    for key in (
        "backfill_complete",
        "index_ready",
        "event_reschedule_complete",
        "backoffice_pre_september_cleanup_complete",
        "maintenance_fence_enforced",
        "writers_quiesced",
        "runtime_held_for_deploy",
        "operation_lock_enforced",
        "operation_lock_handoff",
    ):
        if schema.get(key) != "true":
            fail(f"{label} live schema field {key} is not complete")
    return provenance


def parse_deployment_recovery_artifact(
    repository,
    deployment_run,
    subject_sha,
    dispatch_inputs,
    checkpoint,
    predecessor,
    predecessor_manifest_sha256,
    baseline_manifest_sha256,
    runtime_mode,
    lock_outcome,
    fence_outcome,
    rehold_outcome,
    label,
    *,
    baseline_capture_run_id=None,
):
    artifact = exact_artifact(
        repository,
        deployment_run,
        f"oci-deploy-recovery-authority-{deployment_run}-1",
        label,
    )
    files = artifact_files(repository, artifact, label)
    validate_checksum_manifest(files, label)
    expected_files = {
        "deployment-intent.env",
        "deployment-intent.sha256",
        "failure-lineage.env",
        "images.tsv",
        "SHA256SUMS",
    }
    if exact_basename_set(files) != expected_files or len(files) != len(expected_files):
        fail(f"{label} artifact has an unexpected file set")
    _, intent_raw = unique_artifact_file(
        files, "deployment-intent.env", label
    )
    intent = parse_env(
        intent_raw,
        f"{label} intent",
        DEPLOYMENT_RECOVERY_INTENT_KEYS,
    )
    _, seal_raw = unique_artifact_file(
        files, "deployment-intent.sha256", label
    )
    intent_sha256 = hashlib.sha256(intent_raw).hexdigest()
    if seal_raw != f"{intent_sha256}  deployment-intent.env\n".encode():
        fail(f"{label} pre-mutation intent seal differs")
    _, failure_raw = unique_artifact_file(files, "failure-lineage.env", label)
    failure = parse_env(
        failure_raw,
        f"{label} failure lineage",
        DEPLOYMENT_FAILURE_LINEAGE_KEYS,
    )
    _, images_raw = unique_artifact_file(files, "images.tsv", label)

    checkpoint_source = require_dispatch_sha(
        dispatch_inputs, "checkpoint_source_sha"
    )
    build_run = require_dispatch_run(dispatch_inputs, "build_run_id")
    infrastructure_run = require_dispatch_run(
        dispatch_inputs, "infrastructure_run_id"
    )
    predecessor_run = predecessor["workflow_run_id"]
    expected_intent = {
        "schema_version": "oci-deployment-recovery-authority-v1",
        "source_sha": subject_sha,
        "source_ref": "refs/heads/master",
        "deployment_workflow": "oci-production-deploy",
        "deployment_run_id": deployment_run,
        "deployment_run_attempt": "1",
        "runtime_mode": runtime_mode,
        "build_run_id": build_run,
        "candidate_images_sha256": hashlib.sha256(images_raw).hexdigest(),
        "data_run_id": predecessor_run,
        "data_run_attempt": "1",
        "data_evidence_sha256": predecessor_manifest_sha256,
        "infrastructure_run_id": infrastructure_run,
        "infrastructure_run_attempt": "1",
        "checkpoint_source_sha": checkpoint_source,
        "disk_checkpoint_run_id": checkpoint["producerRunId"],
        "disk_checkpoint_sha256": checkpoint["contentChecksumSha256"],
        "disk_checkpoint_disposition": checkpoint["disposition"],
        "baseline_sha256": baseline_manifest_sha256,
        "baseline_capture_run_id": baseline_capture_run_id or predecessor_run,
        "baseline_recovery_run_id": predecessor["baseline_recovery_run_id"],
        "baseline_recovery_source_sha":
            predecessor["baseline_recovery_source_sha"],
    }
    for key, expected_value in expected_intent.items():
        if intent.get(key) != expected_value:
            fail(f"{label} intent field {key} differs from the exact lineage")

    build_artifact = exact_artifact(
        repository,
        build_run,
        f"oci-image-provenance-{checkpoint_source}-{build_run}-1",
        f"{label} build",
    )
    build_images_raw = artifact_member(
        repository,
        build_artifact,
        "images.tsv",
        f"{label} build",
    )
    if candidate_images_checksum(images_raw) != candidate_images_checksum(
        build_images_raw
    ):
        fail(f"{label} candidate images differ from the original build")
    _, infrastructure_sha256 = parse_infrastructure_provenance(
        repository,
        checkpoint_source,
        infrastructure_run,
        build_run,
        f"{label} infrastructure",
    )
    if intent["infrastructure_provenance_sha256"] != infrastructure_sha256:
        fail(f"{label} infrastructure checksum differs")

    expected_failure = {
        "schema_version": "oci-deployment-failure-lineage-v1",
        "source_sha": subject_sha,
        "deployment_run_id": deployment_run,
        "deployment_run_attempt": "1",
        "intent_sha256": intent_sha256,
        "workflow_result": "failure",
        "lock_release_outcome": lock_outcome,
        "fence_release_outcome": fence_outcome,
        "rehold_outcome": rehold_outcome,
    }
    for key, expected_value in expected_failure.items():
        if failure.get(key) != expected_value:
            fail(f"{label} failure field {key} differs from the exact run")


def validate_descendant_scope(checkpoint_sha, subject_sha):
    if checkpoint_sha == subject_sha:
        return
    ancestor = subprocess.run(
        ["git", "merge-base", "--is-ancestor", checkpoint_sha, subject_sha],
        capture_output=True,
        check=False,
    )
    if ancestor.returncode != 0:
        fail("checkpoint source is not an ancestor of the current subject")
    changed = subprocess.run(
        ["git", "diff", "--name-only", "-z", checkpoint_sha, subject_sha],
        capture_output=True,
        check=False,
    )
    if changed.returncode != 0:
        fail("unable to prove checkpoint descendant path scope")
    try:
        paths = [
            item.decode("utf-8")
            for item in changed.stdout.split(b"\0")
            if item
        ]
    except UnicodeDecodeError:
        fail("checkpoint descendant path is not UTF-8")
    if not paths or not all(
        path.startswith(".github/")
        or path.startswith("infra/")
        or path.lower().endswith(".md")
        for path in paths
    ):
        fail("checkpoint descendant contains an application or unsupported path")


def jobs_for_run(repository, run_id, label):
    pages = gh_api_pages(
        f"repos/{repository}/actions/runs/{run_id}/attempts/1/jobs?per_page=100"
    )
    return jobs_from_pages(pages, label)


def jobs_from_pages(pages, label):
    total_counts = {page.get("total_count") for page in pages}
    if (
        len(total_counts) != 1
        or not all(type(count) is int and count >= 0 for count in total_counts)
    ):
        fail(f"{label} job inventory has an invalid total count")
    jobs = []
    for page in pages:
        values = page.get("jobs")
        if not isinstance(values, list) or not all(isinstance(item, dict) for item in values):
            fail(f"{label} job inventory has an invalid page")
        jobs.extend(values)
    if len(jobs) != next(iter(total_counts)):
        fail(f"{label} job inventory is incomplete")
    return jobs


def exact_job(jobs, name, label):
    matches = [job for job in jobs if job.get("name") == name]
    if len(matches) != 1:
        fail(f"{label} expects exactly one {name} job")
    if not isinstance(matches[0].get("steps"), list):
        fail(f"{label} job {name} has no step evidence")
    return matches[0]


def step_conclusion(job, name, label):
    matches = [step for step in job["steps"] if step.get("name") == name]
    if len(matches) != 1:
        fail(f"{label} expects exactly one {name} step")
    conclusion = matches[0].get("conclusion")
    if conclusion not in {"success", "failure", "skipped", "cancelled"}:
        fail(f"{label} step {name} has an invalid conclusion")
    return conclusion


def validate_failed_deploy_artifacts(
    repository,
    run_id,
    subject_sha,
    artifact,
    dispatch_inputs,
    runtime_mode,
    profile,
    lock_outcome,
    fence_outcome,
    rehold_outcome,
    label,
    *,
    pre_runtime=False,
    seen=None,
    include_capture=False,
):
    checkpoint = parse_checkpoint_artifact(
        repository, dispatch_inputs, runtime_mode, f"{label} checkpoint"
    )
    predecessor_run = require_dispatch_run(dispatch_inputs, "prerequisite_run_id")
    predecessor, predecessor_manifest_sha256, predecessor_files = parse_live_v6_artifact(
        repository, predecessor_run, f"{label} predecessor", include_files=True
    )
    validate_live_v6_lineage(
        predecessor,
        checkpoint,
        dispatch_inputs,
        predecessor_run,
        subject_sha,
        "apply-slip-index",
        f"{label} predecessor",
    )

    root_run, root_source = predecessor_run, subject_sha
    capture = {"baseline_capture_run_id": root_run}
    predecessor_authority = parse_resume_authority(
        predecessor_files, predecessor, f"{label} predecessor"
    )
    if predecessor_authority is not None and (
        predecessor_authority["resume_maintenance_mode"] == "pre-runtime-hold"
    ):
        capture = validate_pre_runtime_resume_chain(
            repository, predecessor_run, runtime_mode, seen=seen, include_capture=True,
        )
        root_run, root_source = capture["applied_data_run_id"], capture["applied_source_sha"]
    elif (
        not pre_runtime
        and profile == "oci-failed-deploy-released-runtime-v1"
        and predecessor_authority is not None
        and predecessor_authority["schema_version"] == "live-betting-data-resume-v2"
        and predecessor_authority["resume_maintenance_mode"] == "retained-hold"
    ):
        lineage_seen = set() if seen is None else set(seen)
        if predecessor_run in lineage_seen or len(lineage_seen) >= 20:
            fail("resume authority is cyclic or exceeds the lineage bound")
        lineage_seen.add(predecessor_run)
        failed_run = predecessor_authority["failed_deploy_run_id"]
        failed = fixed_run_metadata(
            repository, failed_run, "oci-production-deploy.yml", "failure",
            f"{label} retained failure",
        )
        failed_source = failed["head_sha"]
        if failed.get("display_title") != f"oci-deploy {failed_source}":
            fail(f"{label} retained failure title differs")
        validate_descendant_scope(failed_source, subject_sha)
        retained_profile = "oci-failed-deploy-retained-hold-v1"
        outcomes = validate_failed_deploy_jobs(
            repository, failed_run, retained_profile, f"{label} retained failure"
        )
        if tuple(predecessor_authority[key] for key in (
            "failed_deploy_job_conclusion", "public_validate_job_conclusion",
            "lock_release_step_conclusion", "fence_release_step_conclusion",
            "rehold_step_conclusion",
        )) != ("failure", "skipped", *outcomes):
            fail(f"{label} retained authority differs from native failure outcomes")
        native = failed_deploy_native_inputs(
            repository, failed_run, failed_source, f"{label} retained failure",
            expected_step_conclusion="success",
        )
        if native["confirmation"] != "DEPLOY OCI EXACT SHA":
            fail(f"{label} retained failure native confirmation differs")
        expected_request = {key: native[key] for key in (
            "build_run_id", "infrastructure_run_id", "checkpoint_source_sha",
            "disk_checkpoint_run_id", "baseline_recovery_run_id",
            "baseline_recovery_source_sha",
        )}
        if any(value != predecessor[key] for key, value in expected_request.items()):
            fail(f"{label} retained failure substituted the original release tuple")
        expected_request.update({
            "approved_sha": subject_sha, "resume_source_sha": failed_source,
            "prerequisite_run_id": native["data_run_id"],
            "failed_deploy_run_id": failed_run, "phase": "apply-slip-index",
            "failed_activation_run_id": "0", "failed_activation_user_id": "0",
            "confirmation": "RESUME APPLIED LIVE DATA EXACT SHA",
        })
        request = failed_deploy_native_inputs(
            repository, predecessor_run, subject_sha, f"{label} retained resume",
            resume_dispatch=True,
        )
        if request != expected_request:
            fail(f"{label} retained resume substituted its native predecessor or failure")
        capture = validate_pre_runtime_resume_chain(
            repository, native["data_run_id"], runtime_mode, seen=lineage_seen,
            include_capture=True,
        )
        root_run, root_source = capture["applied_data_run_id"], capture["applied_source_sha"]
        if (root_run, root_source) != (
            predecessor_authority["applied_data_run_id"],
            predecessor_authority["applied_source_sha"],
        ):
            fail(f"{label} retained resume substituted its original applied authority")
        validate_descendant_scope(root_source, failed_source)
        root = require_fixed_run(
            repository, root_run, "oci-live-data-rollout.yml", "success",
            root_source, f"oci-live-data apply-slip-index {root_source}",
            f"{label} original data",
        )
        root_evidence, _ = parse_live_v6_artifact(
            repository, root_run, f"{label} original data"
        )
        validate_live_v6_lineage(
            root_evidence, checkpoint, dispatch_inputs, root_run, root_source,
            "apply-slip-index", f"{label} original data",
        )
        expected_baseline_sha = capture.get("baseline_sha256", root_evidence["baseline_sha256"])
        if expected_baseline_sha != predecessor["baseline_sha256"]:
            fail(f"{label} retained resume substituted its original baseline")
        prior = require_fixed_run(
            repository, native["data_run_id"], "oci-live-data-rollout.yml", "success",
            failed_source, f"oci-live-data apply-slip-index {failed_source}",
            f"{label} earlier data",
        )
        baseline_artifact = exact_artifact(
            repository, failed_run, f"oci-production-baseline-{failed_run}-1",
            f"{label} retained failure",
        )
        validate_failed_deploy_artifacts(
            repository, failed_run, failed_source, baseline_artifact,
            dict(native, prerequisite_run_id=native["data_run_id"]), runtime_mode,
            retained_profile, *outcomes, f"{label} retained failure", seen=lineage_seen,
        )
        current = require_fixed_run(
            repository, predecessor_run, "oci-live-data-rollout.yml", "success",
            subject_sha, f"oci-live-data apply-slip-index {subject_sha}",
            f"{label} retained resume",
        )
        for earlier, later in ((root, prior), (prior, failed), (failed, current)):
            if earlier is root and root_run == native["data_run_id"]:
                continue
            if parse_timestamp(earlier.get("updated_at"), label) > parse_timestamp(
                later.get("created_at"), label
            ):
                fail(f"{label} retained resume chronology differs")
    if pre_runtime:
        native = failed_deploy_native_inputs(repository, run_id, subject_sha, label)
        expected_native = {
            "approved_sha": subject_sha,
            "build_run_id": predecessor["build_run_id"],
            "infrastructure_run_id": predecessor["infrastructure_run_id"],
            "data_run_id": predecessor_run,
            "checkpoint_source_sha": predecessor["checkpoint_source_sha"],
            "disk_checkpoint_run_id": predecessor["disk_checkpoint_run_id"],
            "baseline_recovery_run_id": predecessor["baseline_recovery_run_id"],
            "baseline_recovery_source_sha": predecessor["baseline_recovery_source_sha"],
            "confirmation": "DEPLOY OCI EXACT SHA",
        }
        if native != expected_native:
            fail(f"{label} native failed dispatch differs from the original data tuple")
        dependency_completions = []
        for dependency, workflow, event in (
            ("build_run_id", "oci-production-build.yml", "workflow_run"),
            ("infrastructure_run_id", "oci-infrastructure.yml", "workflow_dispatch"),
            ("disk_checkpoint_run_id", "oci-infrastructure.yml", "workflow_dispatch"),
        ):
            metadata = fixed_run_metadata(
                repository, native[dependency], workflow, "success", label, event
            )
            if metadata["head_sha"] != native["checkpoint_source_sha"]:
                fail(f"{label} original release dependency source differs")
            dependency_completions.append(parse_timestamp(metadata.get("updated_at"), label))
        parse_infrastructure_provenance(
            repository, native["checkpoint_source_sha"],
            native["infrastructure_run_id"], native["build_run_id"], label
        )
        prior = require_fixed_run(
            repository, predecessor_run, "oci-live-data-rollout.yml", "success",
            subject_sha, f"oci-live-data apply-slip-index {subject_sha}", label,
        )
        if any(
            completion > parse_timestamp(prior.get("created_at"), label)
            for completion in dependency_completions
        ):
            fail(f"{label} original release dependency postdates its data run")
        failed = require_fixed_run(
            repository, run_id, "oci-production-deploy.yml", "failure",
            subject_sha, f"oci-deploy {subject_sha}", label,
        )
        if parse_timestamp(prior.get("updated_at"), label) > parse_timestamp(
            failed.get("created_at"), label
        ):
            fail(f"{label} failed deployment predates its data handoff")
        if predecessor_authority is not None and (
            predecessor_authority["resume_maintenance_mode"] != "pre-runtime-hold"
        ):
            fail("pre-runtime hold cannot substitute a post-runtime recovery lineage")
        baseline_run = capture["baseline_capture_run_id"]
        artifact = exact_artifact(
            repository, baseline_run, f"oci-live-data-baselines-{baseline_run}-1", label
        )
        baseline_files = original_before_baseline(
            artifact_files(repository, artifact, label), label
        )
    else:
        baseline_files = artifact_files(repository, artifact, f"{label} baseline")
    baseline_manifest_sha256 = validate_checksum_manifest(
        baseline_files, f"{label} baseline"
    )
    _, baseline_raw = unique_artifact_file(
        baseline_files, "baseline-provenance.env", f"{label} baseline"
    )
    baseline = parse_env(
        baseline_raw,
        f"{label} baseline provenance",
        BASELINE_PROVENANCE_KEYS,
    )
    if (
        baseline["baseline_capture_run_id"] != capture["baseline_capture_run_id"]
        or baseline["baseline_capture_run_attempt"] != "1"
        or baseline["registry_provider"] != "ghcr"
        or baseline["registry_host"] != "ghcr.io"
        or baseline["registry_repository"] != APPLICATION_REPOSITORY
        or baseline["registry_public_anonymous"] != "true"
        or baseline_manifest_sha256 != predecessor["baseline_sha256"]
        or any(
            baseline[key] != capture[result_key]
            for key, result_key in (
                ("baseline_source_sha", "baseline_capture_source_sha"),
                ("baseline_deploy_run_id", "baseline_capture_deploy_run_id"),
            )
            if result_key in capture
        )
    ):
        fail(f"{label} rollback baseline does not match its predecessor capture")
    if pre_runtime:
        return {
            "resume_maintenance_mode": "pre-runtime-hold",
            "baseline_run_id": capture["baseline_capture_run_id"],
            "baseline_artifact_name":
                f"oci-live-data-baselines-{capture['baseline_capture_run_id']}-1",
            **{key: capture[key] for key in (
                "baseline_capture_run_id", "baseline_capture_source_sha",
                "baseline_capture_deploy_run_id", "baseline_sha256",
            ) if key in capture},
            "applied_data_run_id": root_run,
            "applied_source_sha": root_source,
            "_baseline_files": baseline_files,
        }
    if profile == "oci-failed-deploy-retained-hold-v1":
        parse_deployment_recovery_artifact(
            repository,
            run_id,
            subject_sha,
            dispatch_inputs,
            checkpoint,
            predecessor,
            predecessor_manifest_sha256,
            baseline_manifest_sha256,
            runtime_mode,
            lock_outcome,
            fence_outcome,
            rehold_outcome,
            f"{label} recovery authority",
            baseline_capture_run_id=capture["baseline_capture_run_id"],
        )
    else:
        parse_deployment_artifact(
            repository,
            run_id,
            subject_sha,
            dispatch_inputs,
            checkpoint,
            predecessor,
            predecessor_manifest_sha256,
            runtime_mode,
            f"{label} deployment",
        )
    if include_capture:
        return {
            "applied_data_run_id": root_run, "applied_source_sha": root_source,
            "baseline_capture_run_id": baseline["baseline_capture_run_id"],
            "baseline_capture_source_sha": baseline["baseline_source_sha"],
            "baseline_capture_deploy_run_id": baseline["baseline_deploy_run_id"],
            "baseline_sha256": baseline_manifest_sha256,
        }
    return checkpoint, predecessor


def activation_file_checksum(files, relative, expected, label):
    matches = [
        raw
        for path, raw in files.items()
        if path == relative or path.endswith("/" + relative)
    ]
    if expected == "none":
        if matches:
            fail(f"{label} unexpectedly contains {relative}")
        return
    if re.fullmatch(r"[0-9a-f]{64}", expected) is None or len(matches) != 1:
        fail(f"{label} checksum binding for {relative} is invalid")
    if hashlib.sha256(matches[0]).hexdigest() != expected:
        fail(f"{label} checksum differs for {relative}")


def require_fixed_run(
    repository,
    run_id,
    workflow,
    conclusion,
    head_sha,
    title,
    label,
):
    metadata = fixed_run_metadata(
        repository, run_id, workflow, conclusion, label
    )
    if metadata.get("head_sha") != head_sha:
        fail(f"{label} source SHA differs from its artifact lineage")
    if metadata.get("display_title") != title:
        fail(f"{label} title differs from its fixed workflow title")
    return metadata


def parse_resume_authority(files, predecessor, label):
    matches = [
        raw
        for path, raw in files.items()
        if path == "resume-authority.env"
        or path.endswith("/resume-authority.env")
    ]
    if not matches:
        return None
    if len(matches) != 1:
        fail(f"{label} has duplicate resume authority")
    authority = parse_env(matches[0], f"{label} resume authority")
    version = authority.get("schema_version")
    required_keys = (
        LIVE_RESUME_AUTHORITY_V3_KEYS if version in HELD_HANDOFF_AUTHORITY_VERSIONS
        else LIVE_RESUME_AUTHORITY_V2_KEYS
    )
    if set(authority) != required_keys or version not in (
        HELD_HANDOFF_AUTHORITY_VERSIONS | {"live-betting-data-resume-v2"}
    ):
        fail(f"{label} resume authority version or key set is invalid")
    expected = {
        "schema_version": version,
        "current_source_sha": predecessor["source_sha"],
        "baseline_sha256": predecessor["baseline_sha256"],
        "checkpoint_source_sha": predecessor["checkpoint_source_sha"],
        "disk_checkpoint_run_id": predecessor["disk_checkpoint_run_id"],
        "disk_checkpoint_sha256": predecessor["disk_checkpoint_sha256"],
        "disk_checkpoint_disposition":
            predecessor["disk_checkpoint_disposition"],
        "application_change_scope": "github-infra-docs-only",
        "status": "PASS",
        "failed_activation_run_id": "0",
    }
    for key, expected_value in expected.items():
        if authority.get(key) != expected_value:
            fail(f"{label} resume authority substituted {key}")
    for key in {"applied_data_run_id", "failed_deploy_run_id"}:
        if POSITIVE_INTEGER.fullmatch(authority[key]) is None:
            fail(f"{label} resume authority has an invalid {key}")
    if FULL_SHA.fullmatch(authority["applied_source_sha"]) is None:
        fail(f"{label} resume authority applied source is invalid")
    if version in HELD_HANDOFF_AUTHORITY_VERSIONS:
        if (
            POSITIVE_INTEGER.fullmatch(authority["held_handoff_run_id"]) is None
            or FULL_SHA.fullmatch(authority["held_handoff_source_sha"]) is None
            or re.fullmatch(r"[0-9a-f]{64}", authority["held_handoff_evidence_sha256"]) is None
            or authority["held_handoff_run_id"] in {
                authority["applied_data_run_id"], authority["failed_deploy_run_id"],
                predecessor["workflow_run_id"],
            }
            or authority["resume_maintenance_mode"] != "pre-runtime-hold"
        ):
            fail(f"{label} held-handoff authority roles are invalid")
        unique_artifact_file(files, "held-handoff-history.json", label)
        unique_artifact_file(files, "held-handoff-transfer.json", label)
    if re.fullmatch(r"[0-9a-f]{64}", authority["runtime_images_sha256"]) is None:
        fail(f"{label} resume authority runtime images checksum is invalid")
    _, resume_images = unique_artifact_file(
        files, "resume-images.tsv", f"{label} resume images"
    )
    if (
        hashlib.sha256(resume_images).hexdigest()
        != authority["runtime_images_sha256"]
    ):
        fail(f"{label} resume authority runtime images were substituted")
    outcome = (
        authority["failed_deploy_job_conclusion"],
        authority["public_validate_job_conclusion"],
        authority["lock_release_step_conclusion"],
        authority["fence_release_step_conclusion"],
        authority["rehold_step_conclusion"],
    )
    mode = authority["resume_maintenance_mode"]
    if mode == "pre-runtime-hold":
        if outcome != ("failure", "skipped", "skipped", "skipped", "skipped"):
            fail(f"{label} pre-runtime resume authority outcome is invalid")
    elif mode == "released-runtime":
        if outcome != ("success", "failure", "success", "success", "skipped"):
            fail(f"{label} released resume authority outcome is invalid")
    elif mode == "retained-hold":
        if (
            outcome[0:2] != ("failure", "skipped")
            or outcome[2:4] not in {
                ("skipped", "skipped"),
                ("failure", "skipped"),
                ("success", "failure"),
            }
            or outcome[4] != "success"
        ):
            fail(f"{label} retained resume authority outcome is invalid")
    else:
        fail(f"{label} resume authority maintenance mode is invalid")
    return authority


def original_before_baseline(files, label):
    manifests = [
        path for path in files
        if path.endswith("/oci-data-baseline-before/SHA256SUMS")
        or path == "oci-data-baseline-before/SHA256SUMS"
    ]
    if len(manifests) != 1:
        fail(f"{label} must contain one original before baseline")
    prefix = manifests[0].removesuffix("SHA256SUMS")
    selected = {
        path.removeprefix(prefix): raw
        for path, raw in files.items() if path.startswith(prefix)
    }
    validate_checksum_manifest(selected, label)
    return selected


def native_step_log_lines(raw, step, label):
    start = parse_timestamp(step.get("started_at"), label)
    end = parse_timestamp(step.get("completed_at"), label)
    if end < start:
        fail(f"{label} native step chronology is invalid")
    lines = []
    timestamp = None
    for line in raw.splitlines():
        match = re.fullmatch(r"(\d{4}-\d\d-\d\dT\S+Z) (.*)", line)
        if match:
            timestamp = re.sub(r"(\.\d{6})\d+(?=Z$)", r"\1", match[1])
        if timestamp and start <= parse_timestamp(timestamp, label) < end + dt.timedelta(seconds=1):
            lines.append(re.sub(r"\x1b\[[0-9;]*m", "", match[2] if match else line))
    return lines


def failed_deploy_native_inputs(
    repository, run_id, source_sha, label, *, resume_dispatch=False,
    expected_step_conclusion="failure", prove_expired_handoff=False,
    native_jobs=None, native_log_files=None,
):
    """Read only runner-generated environment in the exact failed step log.

    Raw logs stay in captured process memory: never persist or echo them.
    """
    if (
        type(expected_step_conclusion) is not str
        or expected_step_conclusion not in {"failure", "success"}
        or type(prove_expired_handoff) is not bool
        or prove_expired_handoff and (
            resume_dispatch or expected_step_conclusion != "success"
        )
        or (native_jobs is None) != (native_log_files is None)
    ):
        fail(f"{label} native deployment step expectation is invalid")
    jobs = (
        jobs_for_run(repository, run_id, label)
        if native_jobs is None else native_jobs
    )
    if not isinstance(jobs, list) or not all(isinstance(job, dict) for job in jobs):
        fail(f"{label} native job inventory is malformed")
    deploy = exact_job(jobs, "rollout" if resume_dispatch else "deploy", label)
    job_id = deploy.get("id")
    if type(job_id) is not int or job_id < 1 or deploy.get("run_id") != int(run_id):
        fail(f"{label} native job identity is invalid")
    step_name = (
        "Validate exact SHA phase and trusted upstream runs" if resume_dispatch
        else "Verify immutable image and infrastructure provenance"
    )
    step = [
        item for item in deploy["steps"]
        if item.get("name") == step_name
    ]
    if len(step) != 1:
        fail(f"{label} native provenance step is ambiguous")
    if step[0].get("conclusion") != (
        "success" if resume_dispatch else expected_step_conclusion
    ):
        fail(f"{label} native input step outcome differs")
    files = (
        zip_files(
            gh_api_bytes(f"repos/{repository}/actions/runs/{run_id}/attempts/1/logs"),
            label, require_original_names=True,
        )
        if native_log_files is None else native_log_files
    )
    if (
        not isinstance(files, dict)
        or not all(isinstance(name, str) and isinstance(raw, bytes)
                   for name, raw in files.items())
    ):
        fail(f"{label} native log inventory is malformed")
    matches = [
        raw for name, raw in files.items()
        if re.fullmatch(r"-?[0-9]+_" + re.escape(deploy["name"]) + r"\.txt", name)
    ]
    if len(matches) != 1:
        fail(f"{label} native full-job log is absent or ambiguous")
    try:
        raw = matches[0].decode("utf-8")
    except UnicodeDecodeError:
        fail(f"{label} native log encoding is invalid")
    lines = native_step_log_lines(raw, step[0], label)
    blocks = []
    current = None
    in_step_group = False
    for line in lines:
        line = re.sub(r"\x1b\[[0-9;]*m", "", line)
        if line.startswith("##[group]"):
            if current is not None:
                fail(f"{label} native environment group is incomplete")
            in_step_group = line == "##[group]Run set -euo pipefail"
        elif line == "##[endgroup]":
            if in_step_group and current is not None:
                blocks.append("\n".join(current))
                current = None
            in_step_group = False
        elif in_step_group and line in {"env:", "  env:"}:
            if current is not None:
                fail(f"{label} native environment is ambiguous")
            current = []
        elif in_step_group and current is not None:
            current.append(line)
    if len(blocks) != 1 or current is not None:
        fail(f"{label} native failed-step environment is absent or ambiguous")
    text = blocks[0]
    matches = list(re.finditer(r"(?m)^  DISPATCH_INPUTS: ", text))
    if len(matches) != 1:
        fail(f"{label} native dispatch inputs are absent or duplicated")
    def unique_pairs(pairs):
        values = {}
        for key, value in pairs:
            if key in values:
                fail(f"{label} native dispatch input is duplicated")
            values[key] = value
        return values
    try:
        inputs, _ = json.JSONDecoder(object_pairs_hook=unique_pairs).raw_decode(
            text[matches[0].end():]
        )
    except (ValueError, TypeError):
        fail(f"{label} native dispatch input is malformed")
    mapping = {
        "approved_sha": "SOURCE_SHA", "build_run_id": "BUILD_RUN_ID",
        "infrastructure_run_id": "INFRASTRUCTURE_RUN_ID",
        "data_run_id": "DATA_RUN_ID", "checkpoint_source_sha": "CHECKPOINT_SOURCE_SHA",
        "disk_checkpoint_run_id": "DISK_CHECKPOINT_RUN_ID",
        "baseline_recovery_run_id": "BASELINE_RECOVERY_RUN_ID",
        "baseline_recovery_source_sha": "BASELINE_RECOVERY_SOURCE_SHA",
        "confirmation": "CONFIRMATION",
    }
    if resume_dispatch:
        del mapping["data_run_id"]
        mapping.update({
            "resume_source_sha": "RESUME_SOURCE_SHA", "phase": "PHASE",
            "prerequisite_run_id": "PREREQUISITE_RUN_ID",
            "failed_deploy_run_id": "FAILED_DEPLOY_RUN_ID",
            "failed_activation_run_id": "FAILED_ACTIVATION_RUN_ID",
            "failed_activation_user_id": "FAILED_ACTIVATION_USER_ID",
        })
        if isinstance(inputs, dict) and inputs.get("confirmation") == HELD_HANDOFF_CONFIRMATION:
            mapping.update({key: key.upper() for key in HELD_HANDOFF_DEFAULTS})
        normalized = live_data_native_inputs(inputs, mapping)
        mapping.update({key: key.upper() for key in HELD_HANDOFF_DEFAULTS if key in inputs})
    else:
        normalized = inputs
    if not isinstance(inputs, dict) or set(inputs) != set(mapping):
        fail(f"{label} native dispatch input key set is invalid")
    for key, env_key in mapping.items():
        values = re.findall(rf"(?m)^  {env_key}: ([^\r\n]*)$", text)
        if len(values) != 1 or values[0] != inputs[key]:
            fail(f"{label} native environment disagrees with dispatch input {key}")
    if inputs["approved_sha"] != source_sha:
        fail(f"{label} native dispatch source is substituted")
    for key in (
        "build_run_id", "infrastructure_run_id", "disk_checkpoint_run_id",
        "prerequisite_run_id" if resume_dispatch else "data_run_id",
    ):
        require_dispatch_run(inputs, key)
    require_dispatch_sha(inputs, "checkpoint_source_sha")
    if prove_expired_handoff:
        handoff = [
            item for item in deploy["steps"]
            if item.get("name") == "Verify transferred database lock and maintenance fence"
        ]
        if len(handoff) != 1 or handoff[0].get("conclusion") != "failure":
            fail(f"{label} native expired-handoff step is ambiguous")
        execution = []
        in_group = False
        for line in native_step_log_lines(raw, handoff[0], label):
            if line.startswith("##[group]"):
                in_group = True
            elif line == "##[endgroup]":
                in_group = False
            elif not in_group and line.startswith((
                "live_data_maintenance=", "shared_mongo_lock=",
            )):
                execution.append(line)
        if execution != [
            "live_data_maintenance=verify-held status=PASS http_mutation_fence=true writers_quiesced=true",
            "shared_mongo_lock=verify status=FAIL reason=active database operation lock has expired",
        ]:
            fail(f"{label} native execution does not prove a read-only expired own handoff")
    return normalized


def expired_handoff_native_inputs(repository, run_id, runtime_mode, label):
    jobs = jobs_for_run(repository, run_id, label)
    deploy = exact_job(jobs, "deploy", label)
    handoff = [
        step for step in deploy["steps"]
        if step.get("name") == "Verify transferred database lock and maintenance fence"
    ]
    if not any(step.get("conclusion") == "failure" for step in handoff):
        return None
    if len(handoff) != 1:
        fail(f"{label} expired-handoff native failure boundary is ambiguous")
    metadata = fixed_run_metadata(
        repository, run_id, "oci-production-deploy.yml", "failure", label,
    )
    source = metadata["head_sha"]
    if metadata.get("display_title") != f"oci-deploy {source}":
        fail(f"{label} expired-handoff native title differs")
    commit = gh_api(f"repos/{repository}/git/commits/{source}")
    if (
        not isinstance(commit, dict) or commit.get("sha") != source
        or not isinstance(commit.get("tree"), dict)
        or commit["tree"].get("sha") != EXPIRED_HANDOFF_TREE
    ):
        fail(f"{label} expired-handoff historical executable tree differs")
    for path, blob in EXPIRED_HANDOFF_CLOSURE.items():
        observed = gh_api(f"repos/{repository}/contents/{path}?ref={source}")
        if not isinstance(observed, dict) or observed.get("sha") != blob:
            fail(f"{label} expired-handoff historical executable closure differs")
    names = (
        "Set up job",
        "Initialize isolated OCI paths",
        "Checkout approved master commit",
        "Validate exact SHA and trusted upstream runs",
        "Download exact OCI image provenance",
        "Download exact OCI infrastructure provenance",
        "Download exact live data readiness evidence",
        "Download exact release disk checkpoint",
        "Download exact pre-mutation rollback baseline",
        "Verify immutable image and infrastructure provenance",
        "Install pinned OCI CLI",
        "Verify OKE identity",
        "Verify k3s identity",
        "Reconcile expired and authorize current runner IPv4",
        "Configure kubectl from exact cluster OCID",
        "Open ephemeral OCI Bastion access to k3s",
        "Verify transferred database lock and maintenance fence",
        "Validate executable pre-deploy rollback baseline",
        "Upload protected OCI rollback baseline",
        "Revalidate held release disk checkpoint before lock renewal",
        "Write checksum-bound deployment recovery intent",
        "Renew exact transferred database lock",
        "Deploy immutable images sequentially",
        "Bind schema evidence to deployment provenance",
        "Run protected OCI cluster validation loop",
        "Revalidate held release disk checkpoint after protected health",
        "Release transferred lock after protected validation",
        "Release live data maintenance fence",
        "Re-enter maintenance after an incomplete deployment",
        "Finalize deployment recovery authority",
        "Upload deployment recovery authority",
        "Upload sanitized live readiness evidence",
        "Capture sanitized deployment diagnostics",
        "Upload sanitized diagnostics on failure",
        "Upload exact deployment provenance",
        "Revoke exact runner rule",
        "Close ephemeral OCI Bastion access",
        "Remove isolated OCI client state",
        "Post Checkout approved master commit",
        "Complete job",
    )
    successful = {
        "Set up job", "Initialize isolated OCI paths", "Checkout approved master commit",
        "Validate exact SHA and trusted upstream runs", "Download exact OCI image provenance",
        "Download exact OCI infrastructure provenance", "Download exact live data readiness evidence",
        "Download exact release disk checkpoint", "Download exact pre-mutation rollback baseline",
        "Verify immutable image and infrastructure provenance", "Install pinned OCI CLI",
        "Upload sanitized live readiness evidence", "Remove isolated OCI client state",
        "Post Checkout approved master commit", "Complete job",
    }
    if runtime_mode == "k3s":
        successful.update({
            "Verify k3s identity", "Open ephemeral OCI Bastion access to k3s",
            "Close ephemeral OCI Bastion access",
        })
    elif runtime_mode == "oke":
        successful.update({
            "Verify OKE identity", "Reconcile expired and authorize current runner IPv4",
            "Configure kubectl from exact cluster OCID", "Revoke exact runner rule",
        })
    else:
        fail(f"{label} expired-handoff runtime mode is unsupported")
    public = exact_job(jobs, "public-validate", label)
    created = parse_timestamp(metadata.get("created_at"), label)
    updated = parse_timestamp(metadata.get("updated_at"), label)
    started = parse_timestamp(deploy.get("started_at"), label)
    completed = parse_timestamp(deploy.get("completed_at"), label)
    if (
        len(jobs) != 2
        or any(type(job.get("id")) is not int or job["id"] < 1
               or job.get("run_id") != int(run_id) for job in jobs)
        or deploy.get("status") != "completed" or deploy.get("conclusion") != "failure"
        or public.get("status") != "completed" or public.get("conclusion") != "skipped"
        or public["steps"] != []
        or not created <= started <= completed <= updated
        or not completed <= parse_timestamp(public.get("started_at"), label)
            <= parse_timestamp(public.get("completed_at"), label) <= updated
        or [item.get("name") for item in deploy["steps"]] != list(names)
        or [item.get("number") for item in deploy["steps"]] != [*range(1, 39), 76, 77]
    ):
        fail(f"{label} expired-handoff native job inventory or chronology differs")
    previous_end = started
    for step in deploy["steps"]:
        expected = (
            "failure" if step["name"] == "Verify transferred database lock and maintenance fence"
            else "success" if step["name"] in successful else "skipped"
        )
        step_started = parse_timestamp(step.get("started_at"), label)
        step_completed = parse_timestamp(step.get("completed_at"), label)
        if (
            type(step.get("number")) is not int or step.get("status") != "completed"
            or step.get("conclusion") != expected
            or not previous_end <= step_started <= step_completed <= completed
        ):
            fail(f"{label} expired-handoff ordered native step outcome differs")
        previous_end = step_completed
    if artifact_inventory(repository, run_id, label):
        fail(f"{label} read-only expired receiver must have zero artifacts")
    native = failed_deploy_native_inputs(
        repository, run_id, source, label,
        expected_step_conclusion="success", prove_expired_handoff=True,
    )
    if native["confirmation"] != "DEPLOY OCI EXACT SHA":
        fail(f"{label} expired receiver native confirmation differs")
    return native, metadata


def held_source_bytes(repository, source_sha, path, label):
    result = subprocess.run(
        ["git", "rev-parse", f"{source_sha}:{path}"],
        capture_output=True, text=True, check=False,
    )
    blob = result.stdout.strip()
    if result.returncode or FULL_SHA.fullmatch(blob) is None:
        fail(f"{label} executed source closure is unavailable")
    def load():
        result = subprocess.run(
            ["git", "cat-file", "blob", blob], capture_output=True, check=False,
        )
        if result.returncode:
            fail(f"{label} executed source bytes are unavailable")
        return result.stdout
    cache = BYTE_CONTEXT.get()
    if cache is not None:
        raw = cache.read(
            ("source-blob", repository, source_sha, path, blob), load, expected_blob=blob,
        )
    else:
        raw = load()
        ImmutableBindingBytes._verify((raw, hashlib.sha256(raw).hexdigest()), None, blob)
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        fail(f"{label} executed source is not UTF-8")


def held_raw_ancestry(authority, repository, row, subject_sha, label):
    history_worker_context()
    try:
        carrier = authority.RawCommitAncestry
        helper_digest = hashlib.sha256(Path(authority.__file__).read_bytes()).hexdigest()
        reader_digest = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    except (AttributeError, OSError):
        fail(f"{label} raw ancestry shared source validator is unavailable")
    if not isinstance(carrier, type):
        fail(f"{label} raw ancestry shared source validator is incompatible")

    def read_git(arguments, source=subprocess.DEVNULL):
        with subprocess.Popen(
            ["git", "--no-replace-objects", *arguments],
            stdin=source, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        ) as process:
            raw = process.stdout.read(MAX_ARTIFACT_ARCHIVE_BYTES + 1)
            if len(raw) > MAX_ARTIFACT_ARCHIVE_BYTES:
                process.kill()
                process.wait()
                fail(f"{label} raw ancestry exceeds the bounded byte ceiling")
            if process.wait():
                fail(f"{label} raw ancestry Git source is unavailable")
            return raw

    def load():
        try:
            if read_git(["rev-parse", "--is-shallow-repository"]).strip() != b"false":
                fail(f"{label} raw ancestry requires complete Git history")
            commits = read_git(["rev-list", subject_sha])
            with tempfile.TemporaryFile() as source:
                source.write(commits)
                source.seek(0)
                return read_git(["cat-file", "--batch"], source)
        except OSError:
            fail(f"{label} raw ancestry Git source is unavailable")

    cache = BYTE_CONTEXT.get()
    if cache is None:
        raw = load()
    else:
        raw = cache.read(
            (
                "raw-commit-closure", repository, str(row["id"]), row["run_attempt"],
                row["head_sha"], subject_sha, reader_digest, helper_digest,
            ),
            load,
        )
    return carrier(row["head_sha"], subject_sha, raw)


def held_handoff_source_version(workflow, label):
    leases = re.findall(
        r"(?m)^      SHARED_MONGO_HANDOFF_LOCK_LEASE_SECONDS: (.+)$", workflow,
    )
    if leases == ['"1800"']:
        return "live-betting-data-resume-v3"
    if (
        leases == [HANDOFF_V4_LEASE_EXPRESSION]
        and '[ "$HELD_HANDOFF_RUN_ID" = "0" ] || resume_schema=live-betting-data-resume-v4'
        in workflow
    ):
        return "live-betting-data-resume-v4"
    fail(f"{label} source does not bind its fixed handoff profile to the continuation branch")


def current_held_source(repository, source_sha, label, *, native_sources=None):
    commit = gh_api(f"repos/{repository}/git/commits/{source_sha}")
    local = subprocess.run(
        ["git", "rev-parse", f"{source_sha}^{{tree}}"],
        capture_output=True, text=True, check=False,
    )
    if (
        local.returncode or not isinstance(commit, dict)
        or commit.get("sha") != source_sha
        or FULL_SHA.fullmatch(local.stdout.strip()) is None
        or (commit.get("tree") or {}).get("sha") != local.stdout.strip()
    ):
        fail(f"{label} executed source tree differs")
    paths = {
        ".github/workflows/oci-live-data-rollout.yml",
        "infra/oci/scripts/live-betting-data-rollout-stan.sh",
        "infra/oci/scripts/live-data-maintenance-stan.sh",
        "infra/oci/scripts/shared-mongo-operation-lock-stan.sh",
        "infra/azure/agents/shared-mongo-operation-lock-stan.sh",
        "infra/oci/scripts/upstream_run_binding_stan.py",
        "infra/oci/scripts/baseline-capture-stan.sh",
        "infra/oci/scripts/validate-rollback-baseline-stan.sh",
        "infra/oci/scripts/k3s-node-disk-recovery-stan.sh",
        "infra/azure/agents/copilot-cli-protected-operation-policy-stan.sh",
    }
    sources = {path: held_source_bytes(repository, source_sha, path, label) for path in sorted(paths)}
    workflow = sources[".github/workflows/oci-live-data-rollout.yml"]
    producer = sources["infra/oci/scripts/live-betting-data-rollout-stan.sh"]
    held_handoff_source_version(workflow, label)
    if native_sources is not None:
        for observed, raw in zip(native_sources, (workflow.encode(), producer.encode())):
            if (
                not isinstance(observed, dict) or observed.get("type") != "file"
                or observed.get("sha") != hashlib.sha1(f"blob {len(raw)}\0".encode() + raw).hexdigest()
            ):
                fail(f"{label} native executed source blob differs from its authenticated tree")
    if (
        re.findall(r"(?m)^  ([a-z][a-z-]*):$", workflow.partition("\njobs:\n")[2]) != ["rollout"]
        or set(re.findall(r"(?m)^\s+uses: ([^\s#]+)", workflow)) != {
            "actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09",
            "actions/download-artifact@37930b1c2abaa49bbe596cd826c3c89aef350131",
            "oracle-actions/configure-kubectl-oke@77a733d79446dabe7bf0e58eb56197d33ce4dc58",
            "actions/upload-artifact@b7c566a772e6b6bfb58ed0dc250532a479d7789f",
        }
        or any(token not in producer for token in (
            'destination = root / "resume-images.tsv"',
            'hashlib.sha256(images).hexdigest() != expected[0]',
            'with destination.open("xb") as output:',
        ))
    ):
        fail(f"{label} does not implement the complete held producer contract")
    return workflow


def native_handoff_renewal(repository, run_id, job, label, *, lease_seconds=1800):
    if type(lease_seconds) is not int or lease_seconds not in {1800, HANDOFF_V4_LEASE_SECONDS}:
        fail(f"{label} native handoff profile is unsupported")
    steps = [
        step for step in job["steps"]
        if step.get("name") == "Restore runtime or verify final deploy handoff"
    ]
    if len(steps) != 1 or steps[0].get("conclusion") != "success":
        fail(f"{label} final handoff renewal step is absent")
    files = zip_files(
        gh_api_bytes(f"repos/{repository}/actions/runs/{run_id}/attempts/1/logs"),
        label, require_original_names=True,
    )
    logs = [raw for path, raw in files.items() if re.fullmatch(r"-?[0-9]+_rollout\.txt", path)]
    if len(logs) != 1:
        fail(f"{label} native renewal log is absent or ambiguous")
    try:
        lines = native_step_log_lines(logs[0].decode("utf-8"), steps[0], label)
    except UnicodeDecodeError:
        fail(f"{label} native renewal log is not UTF-8")
    output, grouped = [], False
    for line in lines:
        if line.startswith("##[group]"):
            grouped = True
        elif line == "##[endgroup]":
            grouped = False
        elif not grouped and line.startswith(("shared_mongo_lock=", "live_data_maintenance=")):
            output.append(line)
    if len(output) != 3 or output[0] != (
        "live_data_maintenance=verify-held status=PASS http_mutation_fence=true writers_quiesced=true"
    ):
        fail(f"{label} native final renewal did not preserve the held fence")
    verified = re.fullmatch(
        r"shared_mongo_lock=verify status=PASS lease_until_epoch=([1-9][0-9]*) "
        r"fencing_generation=([0-9]+)", output[1],
    )
    renewed = re.fullmatch(
        r"shared_mongo_lock=renew status=PASS lease_until_epoch=([1-9][0-9]*) "
        r"fencing_generation=([1-9][0-9]*)", output[2],
    )
    if verified is None or renewed is None or int(renewed[2]) != int(verified[2]) + 1:
        fail(f"{label} native final renewal is not a confirmed owner-bound transition")
    renewal_epoch = int(renewed[1]) - lease_seconds
    if not (
        parse_timestamp(steps[0]["started_at"], label).timestamp() - 1
        <= renewal_epoch
        <= parse_timestamp(steps[0]["completed_at"], label).timestamp()
    ):
        fail(f"{label} final native physical deadline is outside its authenticated step")
    return int(renewed[1]), int(renewed[2])


def handoff_remaining_guard(deadline, now, boundary):
    stages = HANDOFF_STAGE_CEILINGS
    if (
        set(stages) != {
            "packaging", "admission", "queue", "approval", "native-validation",
            "startup-snapshot", "receiver-renewal",
        }
        or any(type(value) is not int or value <= 0 for value in stages.values())
        or sum(stages.values()) > 1200 or HANDOFF_RESERVE_SECONDS != 600
        or sum(stages.values()) + HANDOFF_RESERVE_SECONDS > 1800
    ):
        fail("handoff timing has no supported positive whole-path ceiling")
    native = sum(stages[key] for key in ("native-validation", "startup-snapshot", "receiver-renewal"))
    tails = {
        "dispatch": stages["admission"] + stages["queue"] + stages["approval"] + native,
        "materialization": stages["queue"] + stages["approval"] + native,
        "approval-1": stages["approval"] + native,
        "approval-2": (stages["approval"] * 2 + 2) // 3 + native,
        "approval-3": (stages["approval"] + 2) // 3 + native,
        "native-validation": native,
        "startup-snapshot": stages["startup-snapshot"] + stages["receiver-renewal"],
        "receiver-renewal": stages["receiver-renewal"],
    }
    if boundary not in tails or type(deadline) is not int or deadline <= 0:
        fail("handoff timing boundary or authentic physical deadline is unsupported")
    tail = tails[boundary]
    remaining = deadline - now
    if remaining <= tail + HANDOFF_RESERVE_SECONDS:
        fail("authentic physical handoff deadline cannot cover the unfinished path plus reserve")
    return tail


def handoff_remaining_guard_v4(deadline, now, phase, elapsed):
    stages = HANDOFF_V4_STAGE_CEILINGS
    futures = {
        "admission": ("queue", "approval", "native-validation", "startup-snapshot", "receiver-renewal"),
        "approval": ("queue", "native-validation", "startup-snapshot", "receiver-renewal"),
        "native-validation": ("startup-snapshot", "receiver-renewal"),
        "startup-snapshot": ("receiver-renewal",),
        "receiver-renewal": (),
    }
    completed = ["packaging", "admission", "approval", "native-validation", "startup-snapshot", "receiver-renewal"]
    if (
        set(stages) != set(HANDOFF_STAGE_CEILINGS)
        or any(type(value) is not int or value <= 0 for value in stages.values())
        or sum(stages.values()) != HANDOFF_V4_EXECUTION_SECONDS
        or HANDOFF_V4_EXECUTION_SECONDS != 3000 or HANDOFF_RESERVE_SECONDS != 600
        or HANDOFF_V4_LEASE_SECONDS != HANDOFF_V4_EXECUTION_SECONDS + HANDOFF_RESERVE_SECONDS
        or HANDOFF_V4_LEASE_SECONDS != 3600
        or type(phase) is not str or phase not in futures
        or type(deadline) is not int or deadline <= 0
        or type(now) not in (int, float) or not math.isfinite(now)
    ):
        fail("v4 handoff timing profile, phase or physical deadline is unsupported")
    if not isinstance(elapsed, dict) or set(elapsed) != set(completed[:completed.index(phase) + 1]):
        fail("v4 handoff timing has incomplete or inconsistent authenticated phase evidence")
    for stage, duration in elapsed.items():
        if (
            type(duration) not in (int, float) or not math.isfinite(duration)
            or duration < 0 or duration > stages[stage]
        ):
            fail(f"receiver handoff {stage} elapsed stage exceeds its strict source ceiling")
    residual = stages[phase] - elapsed[phase]
    if residual <= 0:
        fail("v4 handoff current allocation is exhausted while work remains")
    tail = residual + sum(stages[stage] for stage in futures[phase])
    if deadline - now <= tail + HANDOFF_RESERVE_SECONDS:
        fail("authentic physical handoff deadline cannot cover the unfinished path plus reserve")
    return tail


def receiver_handoff_run(repository, source, boundary, receiver_run, label):
    if POSITIVE_INTEGER.fullmatch(receiver_run) is None:
        fail("receiver timing run ID is malformed")
    if boundary in ("dispatch", "materialization"):
        expected_workflow_state = "active"
    elif boundary in (
        "approval-1", "approval-2", "approval-3", "native-validation",
        "startup-snapshot", "receiver-renewal",
    ):
        expected_workflow_state = "disabled_manually"
    else:
        fail("receiver timing workflow boundary is unsupported")
    endpoint = f"repos/{repository}/actions/runs/{receiver_run}"
    latest, first = gh_api(endpoint), gh_api(endpoint + "/attempts/1")
    workflow = gh_api(f"repos/{repository}/actions/workflows/oci-production-deploy.yml")
    if (
        not isinstance(workflow, dict) or type(workflow.get("id")) is not int or workflow["id"] < 1
        or workflow.get("path") != ".github/workflows/oci-production-deploy.yml"
        or workflow.get("state") != expected_workflow_state
    ):
        fail("receiver timing workflow identity or lifecycle state changed")
    for run in (latest, first):
        if (
            not isinstance(run, dict) or type(run.get("id")) is not int
            or run["id"] != int(receiver_run) or type(run.get("run_attempt")) is not int
            or run["run_attempt"] != 1 or run.get("head_sha") != source
            or run.get("workflow_id") != workflow["id"] or run.get("path") != workflow["path"]
            or run.get("event") != "workflow_dispatch" or run.get("head_branch") != "master"
            or (run.get("head_repository") or {}).get("full_name") != repository
            or run.get("display_title") != f"oci-deploy {source}"
            or run.get("status") not in {"queued", "waiting", "requested", "pending", "in_progress"}
            or run.get("conclusion") is not None
        ):
            fail("receiver timing identity, first attempt or mutable state differs")
    if any(latest.get(key) != first.get(key) for key in ("created_at", "status", "conclusion")):
        fail("receiver timing first-attempt observations drifted")
    return first


def validate_receiver_handoff_timing_v4(
    repository, source, producer, deadline, generation, boundary, receiver_run,
):
    label = "receiver v4 handoff timing"
    renewal = deadline - HANDOFF_V4_LEASE_SECONDS
    observed_at = time.time()
    packaged = parse_timestamp(producer.get("updated_at"), label).timestamp()
    elapsed = {"packaging": packaged - renewal}
    phase, phase_started = "admission", packaged
    if boundary != "dispatch" and not receiver_run:
        fail("receiver timing boundary has no exact native receiving run")
    if receiver_run:
        first = receiver_handoff_run(repository, source, boundary, receiver_run, label)
        created = parse_timestamp(first.get("created_at"), label).timestamp()
        elapsed["admission"] = created - packaged
        phase, phase_started = "approval", created
        prestart = boundary in ("dispatch", "materialization", "approval-1", "approval-2", "approval-3")
        if prestart:
            if first["status"] == "in_progress":
                fail("receiver timing cannot infer an executing job's phase from a pre-start observation")
        else:
            if first["status"] != "in_progress":
                fail("receiver timing native deploy job is not executing")
            current_jobs = jobs_for_run(repository, receiver_run, label)
            receiving = exact_job(current_jobs, "deploy", label)
            if (
                type(receiving.get("run_id")) is not int or receiving["run_id"] != int(receiver_run)
                or receiving.get("status") != "in_progress" or receiving.get("conclusion") is not None
            ):
                fail("receiver timing native deploy job is not executing")
            started = parse_timestamp(receiving.get("started_at"), label).timestamp()
            # Pre-start work consumes approval; queue is an additional future allowance until job start.
            elapsed["approval"] = started - created
            validation = [
                step for step in receiving["steps"]
                if step.get("name") == "Validate exact SHA and trusted upstream runs"
            ]
            handoff = [
                step for step in receiving["steps"]
                if step.get("name") == "Verify transferred database lock and maintenance fence"
            ]
            if len(validation) != 1 or len(handoff) != 1:
                fail("receiver timing native phase inventory is ambiguous")
            validation, handoff = validation[0], handoff[0]
            phase, phase_started = "native-validation", started
            if validation.get("status") in {"queued", "in_progress"} and validation.get("conclusion") is None:
                if (
                    handoff.get("status") != "queued" or handoff.get("conclusion") is not None
                    or handoff.get("started_at") is not None
                    or validation.get("completed_at") is not None
                    or validation["status"] == "queued" and validation.get("started_at") is not None
                ):
                    fail("receiver timing native validation and startup states are inconsistent")
                if validation.get("started_at") is not None:
                    validation_started = parse_timestamp(validation["started_at"], label).timestamp()
                    if not started <= validation_started <= observed_at:
                        fail("receiver timing native validation chronology is invalid")
                elif validation["status"] == "in_progress":
                    fail("receiver timing executing native validation has no start timestamp")
            elif validation.get("status") == "completed" and validation.get("conclusion") == "success":
                validation_started = parse_timestamp(validation.get("started_at"), label).timestamp()
                validated_at = parse_timestamp(validation.get("completed_at"), label).timestamp()
                if not started <= validation_started <= validated_at <= observed_at:
                    fail("receiver timing completed native validation chronology is invalid")
                elapsed["native-validation"] = validated_at - started
                phase, phase_started = "startup-snapshot", validated_at
                if handoff.get("started_at") is None:
                    if handoff.get("status") != "queued" or handoff.get("conclusion") is not None:
                        fail("receiver timing startup phase is inconsistent")
                else:
                    if (
                        handoff.get("status") not in {"in_progress", "completed"}
                        or (handoff["status"] == "in_progress" and handoff.get("conclusion") is not None)
                        or (handoff["status"] == "completed" and handoff.get("conclusion") != "success")
                    ):
                        fail("receiver timing verification phase is inconsistent")
                    verify_started = parse_timestamp(handoff["started_at"], label).timestamp()
                    if not validated_at <= verify_started <= observed_at:
                        fail("receiver timing verification chronology is invalid")
                    if handoff["status"] == "completed":
                        verified_at = parse_timestamp(handoff.get("completed_at"), label).timestamp()
                        if not verify_started <= verified_at <= observed_at:
                            fail("receiver timing completed verification chronology is invalid")
                    elif handoff.get("completed_at") is not None:
                        fail("receiver timing executing verification has a completion timestamp")
                    elapsed["startup-snapshot"] = verify_started - validated_at
                    phase, phase_started = "receiver-renewal", verify_started
            else:
                fail("receiver timing native validation has an unsupported outcome")
    now = time.time()
    if now < observed_at:
        fail("receiver timing clock moved backward during its native observation")
    elapsed[phase] = now - phase_started
    tail = handoff_remaining_guard_v4(deadline, now, phase, elapsed)
    if now - renewal > HANDOFF_V4_EXECUTION_SECONDS:
        fail("receiver handoff whole renewal-to-renewal ceiling was exhausted")
    return {
        "profile": "live-betting-data-resume-v4",
        "lease_seconds": HANDOFF_V4_LEASE_SECONDS, "execution_seconds": HANDOFF_V4_EXECUTION_SECONDS,
        "reserve_seconds": HANDOFF_RESERVE_SECONDS,
        "deadline": deadline, "generation": generation, "boundary": boundary, "phase": phase,
        "unfinished_seconds": tail, "remaining_seconds": int(deadline - now),
        "elapsed_seconds": int(now - renewal),
        "stage_elapsed_seconds": {key: int(value) for key, value in elapsed.items()},
        **({"renewal_stage_deadline": phase_started + HANDOFF_V4_STAGE_CEILINGS["receiver-renewal"]}
           if phase == "receiver-renewal" else {}),
    }


def validate_receiver_handoff_timing(repository, data_run, source, boundary, receiver_run=""):
    label = "receiver handoff timing"
    producer = require_fixed_run(
        repository, data_run, "oci-live-data-rollout.yml", "success", source,
        f"oci-live-data apply-slip-index {source}", label,
    )
    evidence, _, files = parse_live_v6_artifact(repository, data_run, label, include_files=True)
    authority = parse_resume_authority(files, evidence, label)
    if authority is None or authority["schema_version"] == "live-betting-data-resume-v2":
        return None
    if evidence["source_sha"] != source or evidence["workflow_run_id"] != data_run:
        fail("receiver handoff timing producer differs from its authenticated package")
    workflow = current_held_source(repository, source, label)
    if held_handoff_source_version(workflow, label) != authority["schema_version"]:
        fail("receiver handoff source and resume authority profiles differ")
    v4 = authority["schema_version"] == "live-betting-data-resume-v4"
    lease_seconds = HANDOFF_V4_LEASE_SECONDS if v4 else 1800
    jobs = jobs_for_run(repository, data_run, label)
    job = exact_job(jobs, "rollout", label)
    if (
        len(jobs) != 1 or type(job.get("run_id")) is not int or job["run_id"] != int(data_run)
        or job.get("status") != "completed" or job.get("conclusion") != "success"
    ):
        fail("receiver handoff timing requires its whole-success physical producer")
    deadline, generation = native_handoff_renewal(
        repository, data_run, job, label, lease_seconds=lease_seconds,
    )
    if v4:
        return validate_receiver_handoff_timing_v4(
            repository, source, producer, deadline, generation, boundary, receiver_run,
        )
    renewal = deadline - 1800
    now = time.time()
    packaged = parse_timestamp(producer.get("updated_at"), label).timestamp()
    elapsed = {"packaging": packaged - renewal}
    if boundary != "dispatch" and not receiver_run:
        fail("receiver timing boundary has no exact native receiving run")
    if receiver_run:
        first = receiver_handoff_run(repository, source, boundary, receiver_run, label)
        created = parse_timestamp(first.get("created_at"), label).timestamp()
        elapsed["admission"] = created - packaged
        if boundary.startswith("approval-") or boundary == "materialization":
            elapsed["queue-and-approval"] = now - created
        else:
            current_jobs = jobs_for_run(repository, receiver_run, label)
            receiving = exact_job(current_jobs, "deploy", label)
            if receiving.get("run_id") != int(receiver_run) or receiving.get("status") != "in_progress":
                fail("receiver timing native deploy job is not executing")
            started = parse_timestamp(receiving.get("started_at"), label).timestamp()
            elapsed["queue-and-approval"] = started - created
            if boundary == "native-validation":
                elapsed["native-validation"] = now - started
            else:
                validation = [
                    step for step in receiving["steps"]
                    if step.get("name") == "Validate exact SHA and trusted upstream runs"
                ]
                if len(validation) != 1 or validation[0].get("conclusion") != "success":
                    fail("receiver timing native validation did not complete")
                validated_at = parse_timestamp(validation[0].get("completed_at"), label).timestamp()
                elapsed["native-validation"] = validated_at - started
                handoff = [
                    step for step in receiving["steps"]
                    if step.get("name") == "Verify transferred database lock and maintenance fence"
                ]
                if len(handoff) != 1:
                    fail("receiver timing verification boundary is ambiguous")
                verify_started = parse_timestamp(handoff[0].get("started_at"), label).timestamp()
                elapsed["startup-snapshot"] = verify_started - validated_at
                if boundary == "receiver-renewal":
                    elapsed["receiver-renewal"] = now - verify_started
    else:
        elapsed["admission"] = now - packaged
    now = time.time()
    if not receiver_run:
        elapsed["admission"] = now - packaged
    elif boundary.startswith("approval-") or boundary == "materialization":
        elapsed["queue-and-approval"] = now - created
    elif boundary == "native-validation":
        elapsed["native-validation"] = now - started
    else:
        elapsed["receiver-renewal"] = now - verify_started
    for stage, duration in elapsed.items():
        ceiling = (
            HANDOFF_STAGE_CEILINGS["queue"] + HANDOFF_STAGE_CEILINGS["approval"]
            if stage == "queue-and-approval" else HANDOFF_STAGE_CEILINGS[stage]
        )
        if duration < 0 or duration > ceiling:
            fail(f"receiver handoff {stage} elapsed stage exceeds its strict source ceiling")
    tail = handoff_remaining_guard(deadline, now, boundary)
    if now - renewal > 1200:
        fail("receiver handoff whole renewal-to-renewal ceiling was exhausted")
    return {
        "profile": authority["schema_version"], "lease_seconds": 1800,
        "execution_seconds": 1200, "reserve_seconds": HANDOFF_RESERVE_SECONDS,
        "deadline": deadline, "generation": generation, "boundary": boundary,
        "unfinished_seconds": tail, "remaining_seconds": int(deadline - now),
        "elapsed_seconds": int(now - renewal),
        "stage_elapsed_seconds": {key: int(value) for key, value in elapsed.items()},
    }


def validate_held_handoff_native(
    repository, run_id, source_sha, dispatch_inputs, runtime_mode, label,
):
    historical_pins = (
        (".github/workflows/oci-live-data-rollout.yml", "27a98e345050fefb799c706fde03d8f79e14ed6c"),
        ("infra/oci/scripts/live-betting-data-rollout-stan.sh", "1752489383424fa4bd55bbc7d36e4cac95e14d31"),
    )
    observed = [
        gh_api(f"repos/{repository}/contents/{path}?ref={source_sha}")
        for path, _ in historical_pins
    ]
    if all(isinstance(row, dict) and row.get("sha") == pin
           for row, (_, pin) in zip(observed, historical_pins)):
        return validate_historical_held_handoff_native(
            repository, run_id, source_sha, dispatch_inputs, runtime_mode, label,
        )
    workflow = current_held_source(repository, source_sha, label, native_sources=observed)
    metadata = require_fixed_run(
        repository, run_id, "oci-live-data-rollout.yml", "success", source_sha,
        f"oci-live-data apply-slip-index {source_sha}", label,
    )
    if runtime_mode not in {"k3s", "oke"}:
        fail(f"{label} held-handoff runtime mode is unsupported")
    jobs = jobs_for_run(repository, run_id, label)
    job = exact_job(jobs, "rollout", label)
    names = re.findall(r"(?m)^      - name: (.+)$", workflow)
    expected_names = [
        "Set up job", *names, "Post Checkout approved current master commit", "Complete job",
    ]
    if (
        len(names) != len(set(names)) or len(jobs) != 1
        or type(job.get("id")) is not int or job["id"] < 1
        or type(job.get("run_id")) is not int or job["run_id"] != int(run_id)
        or job.get("status") != "completed" or job.get("conclusion") != "success"
        or [step.get("name") for step in job["steps"]] != expected_names
    ):
        fail(f"{label} complete held producer native inventory differs")
    skipped = {
        "Download failed deploy protected baseline", "Verify reader-qualified released activation state",
        "Demote and verify exact retained live-acceptance account",
        "Delete exact orphaned live-acceptance slips", "Capture post-phase runtime baseline",
        "Restore runtime or retain hold if final handoff packaging failed",
        "Release database operation lock unless handed to deploy",
    }
    if str(dispatch_inputs.get("baseline_recovery_run_id")) == "0":
        skipped.update({
            "Download explicitly selected recovery baseline authority",
            "Bind historical recovery source through its exact artifact",
        })
    skipped.update({
        "Verify OKE identity", "Reconcile expired and authorize current runner IPv4",
        "Configure kubectl from exact cluster OCID", "Revoke exact runner rule",
    } if runtime_mode == "k3s" else {
        "Verify k3s identity", "Open ephemeral OCI Bastion access to k3s",
        "Revalidate exact release disk checkpoint before lock mutation", "Close ephemeral OCI Bastion access",
    })
    start = parse_timestamp(job.get("started_at"), label)
    end = parse_timestamp(job.get("completed_at"), label)
    previous = start
    if not parse_timestamp(metadata.get("created_at"), label) <= start <= end <= parse_timestamp(
        metadata.get("updated_at"), label,
    ):
        fail(f"{label} complete held producer job chronology differs")
    numbers = [*range(1, len(names) + 2), 2 * (len(names) + 1), 2 * (len(names) + 1) + 1]
    for step, number in zip(job["steps"], numbers):
        expected = "skipped" if step["name"] in skipped else "success"
        if (
            type(step.get("number")) is not int or step["number"] != number
            or step.get("status") != "completed" or step.get("conclusion") != expected
        ):
            fail(f"{label} complete held producer step outcome differs")
        if expected == "success":
            began = parse_timestamp(step.get("started_at"), label)
            completed = parse_timestamp(step.get("completed_at"), label)
            if not previous <= began <= completed <= end:
                fail(f"{label} complete held producer steps run backward")
            previous = completed
    native = failed_deploy_native_inputs(
        repository, run_id, source_sha, label, resume_dispatch=True,
    )
    common = {
        key: dispatch_inputs.get(key) for key in (
            "resume_source_sha", "build_run_id", "infrastructure_run_id",
            "checkpoint_source_sha", "disk_checkpoint_run_id", "prerequisite_run_id",
            "baseline_recovery_run_id", "baseline_recovery_source_sha", "failed_deploy_run_id",
        )
    }
    if (
        any(native.get(key) != value for key, value in common.items())
        or native.get("approved_sha") != source_sha or native.get("phase") != "apply-slip-index"
        or native.get("failed_activation_run_id") != "0"
        or native.get("failed_activation_user_id") != "0"
        or native.get("confirmation") not in {
            "RESUME APPLIED LIVE DATA EXACT SHA", HELD_HANDOFF_CONFIRMATION,
        }
    ):
        fail(f"{label} complete held producer substituted its original root tuple")
    resume_schema = (
        held_handoff_source_version(workflow, label)
        if native["confirmation"] == HELD_HANDOFF_CONFIRMATION
        else "live-betting-data-resume-v2"
    )
    lease_seconds = HANDOFF_V4_LEASE_SECONDS if resume_schema == "live-betting-data-resume-v4" else 1800
    deadline, generation = native_handoff_renewal(
        repository, run_id, job, label, lease_seconds=lease_seconds,
    )
    return {
        **metadata, "_held_complete": True, "_held_native_inputs": native,
        "_handoff_deadline": deadline, "_handoff_generation": generation,
        "_handoff_lease_seconds": lease_seconds, "_handoff_resume_schema": resume_schema,
    }


def validate_historical_held_handoff_native(
    repository, run_id, source_sha, dispatch_inputs, runtime_mode, label,
):
    metadata = require_fixed_run(
        repository, run_id, "oci-live-data-rollout.yml", "success", source_sha,
        f"oci-live-data apply-slip-index {source_sha}", label,
    )
    if runtime_mode not in {"k3s", "oke"}:
        fail(f"{label} held-handoff runtime mode is unsupported")
    for path, expected_blob in (
        (".github/workflows/oci-live-data-rollout.yml",
         "27a98e345050fefb799c706fde03d8f79e14ed6c"),
        ("infra/oci/scripts/live-betting-data-rollout-stan.sh",
         "1752489383424fa4bd55bbc7d36e4cac95e14d31"),
    ):
        observed = gh_api(f"repos/{repository}/contents/{path}?ref={source_sha}")
        if not isinstance(observed, dict) or observed.get("sha") != expected_blob:
            fail(f"{label} does not have the known historical held-handoff producer")
    names = (
        "Initialize isolated OCI data paths",
        "Checkout approved current master commit",
        "Validate exact SHA phase and trusted upstream runs",
        "Reject competing production activity",
        "Download exact OCI image provenance",
        "Download exact OCI infrastructure provenance",
        "Download exact release disk checkpoint",
        "Download prerequisite data evidence",
        "Download failed deploy protected baseline",
        "Download explicitly selected recovery baseline authority",
        "Bind historical recovery source through its exact artifact",
        "Verify immutable release and phase provenance",
        "Install pinned OCI CLI",
        "Verify OKE identity",
        "Verify k3s identity",
        "Reconcile expired and authorize current runner IPv4",
        "Configure kubectl from exact cluster OCID",
        "Open ephemeral OCI Bastion access to k3s",
        "Verify exact failed-deploy resume state",
        "Capture and validate pre-mutation rollback baseline",
        "Revalidate exact release disk checkpoint before lock mutation",
        "Acquire database operation lock",
        "Enter or re-establish live data maintenance",
        "Demote and verify exact retained live-acceptance account",
        "Delete exact orphaned live-acceptance slips",
        "Execute exact-digest live data phase",
        "Restore runtime or verify final deploy handoff",
        "Capture post-phase runtime baseline",
        "Require executed data-step evidence",
        "Upload exact sanitized data evidence",
        "Upload protected rollout baselines",
        "Restore runtime or retain hold if final handoff packaging failed",
        "Release database operation lock unless handed to deploy",
        "Revoke exact runner rule",
        "Close ephemeral OCI Bastion access",
        "Remove isolated OCI client state",
    )
    expected_names = [
        "Set up job", *names, "Post Checkout approved current master commit", "Complete job",
    ]
    jobs = jobs_for_run(repository, run_id, label)
    if len(jobs) != 1:
        fail(f"{label} held-handoff job inventory is not exact")
    job = exact_job(jobs, "rollout", label)
    if (
        type(job.get("id")) is not int or job["id"] < 1
        or job.get("run_id") != int(run_id)
        or job.get("status") != "completed"
        or job.get("conclusion") != "success"
    ):
        fail(f"{label} held-handoff job did not complete successfully")
    created = parse_timestamp(metadata.get("created_at"), label)
    started = parse_timestamp(job.get("started_at"), label)
    completed = parse_timestamp(job.get("completed_at"), label)
    if not created <= started <= completed <= parse_timestamp(metadata.get("updated_at"), label):
        fail(f"{label} held-handoff job chronology is invalid")
    if [step.get("name") for step in job["steps"]] != expected_names:
        fail(f"{label} held-handoff step inventory is not exact")
    skipped = {
        "Download failed deploy protected baseline",
        "Demote and verify exact retained live-acceptance account",
        "Delete exact orphaned live-acceptance slips",
        "Capture post-phase runtime baseline",
        "Restore runtime or retain hold if final handoff packaging failed",
        "Release database operation lock unless handed to deploy",
    }
    if str(dispatch_inputs.get("baseline_recovery_run_id")) == "0":
        skipped.update({
            "Download explicitly selected recovery baseline authority",
            "Bind historical recovery source through its exact artifact",
        })
    skipped.update({
        "Verify OKE identity", "Reconcile expired and authorize current runner IPv4",
        "Configure kubectl from exact cluster OCID", "Revoke exact runner rule",
    } if runtime_mode == "k3s" else {
        "Verify k3s identity", "Open ephemeral OCI Bastion access to k3s",
        "Revalidate exact release disk checkpoint before lock mutation",
        "Close ephemeral OCI Bastion access",
    })
    for number, step in zip((*range(1, 38), 74, 75), job["steps"]):
        if (
            type(step.get("number")) is not int or step["number"] != number
            or step.get("status") != "completed"
            or step.get("conclusion") != ("skipped" if step["name"] in skipped else "success")
        ):
            fail(f"{label} held-handoff step outcome is invalid")
        if step["name"] in names and step["name"] not in skipped:
            step_started = parse_timestamp(step.get("started_at"), label)
            step_completed = parse_timestamp(step.get("completed_at"), label)
            if not started <= step_started <= step_completed <= completed:
                fail(f"{label} held-handoff step chronology is invalid")
    native = failed_deploy_native_inputs(
        repository, run_id, source_sha, label, resume_dispatch=True,
    )
    expected = {
        key: dispatch_inputs.get(key) for key in (
            "resume_source_sha", "build_run_id", "infrastructure_run_id",
            "checkpoint_source_sha", "disk_checkpoint_run_id", "prerequisite_run_id",
            "baseline_recovery_run_id", "baseline_recovery_source_sha", "failed_deploy_run_id",
        )
    }
    expected.update({
        "approved_sha": source_sha, "phase": "apply-slip-index",
        "failed_activation_run_id": "0", "failed_activation_user_id": "0",
        "confirmation": "RESUME APPLIED LIVE DATA EXACT SHA",
    })
    if native != expected:
        fail(f"{label} held handoff substituted the original root dispatch tuple")
    return metadata


def native_cli_handoff_approval(repository, run_id, operation, label):
    endpoint = f"repos/{repository}/actions/runs/{run_id}"
    if gh_api(endpoint + "/pending_deployments") != []:
        fail(f"{label} consumed physical producer still has a pending gate")
    reviews = gh_api(endpoint + "/approvals")
    if not isinstance(reviews, list) or len(reviews) != 1 or not isinstance(reviews[0], dict):
        fail(f"{label} consumed owner approval history is incomplete or extended")
    review = reviews[0]
    environments, user = review.get("environments"), review.get("user")
    if (
        review.get("state") != "approved"
        or review.get("comment") != f"Copilot CLI exact-run approval: {operation}"
        or not isinstance(user, dict) or type(user.get("id")) is not int or user["id"] < 1
        or not isinstance(user.get("login"), str) or not user["login"]
        or not isinstance(environments, list) or len(environments) != 1
        or not isinstance(environments[0], dict) or environments[0].get("name") != "oci-migration"
        or type(environments[0].get("id")) is not int or environments[0]["id"] < 1
    ):
        fail(f"{label} consumed owner has no exact native CLI approval receipt")
    return environments[0]["id"]


def held_handoff_authority(repository, held, subject_sha, dispatch_inputs, successor_run_id, label):
    authority = provenance_read_authority()
    native = held.get("_held_native_inputs")
    if native is None:
        native = failed_deploy_native_inputs(
            repository, str(held["id"]), held["head_sha"], label, resume_dispatch=True,
        )
    operation = (
        "oci-live-data-continue-held-handoff" if native["confirmation"] == HELD_HANDOFF_CONFIRMATION
        else "oci-live-data-resume-deploy"
    )
    environment_id = native_cli_handoff_approval(repository, str(held["id"]), operation, label)
    successor = None
    if successor_run_id:
        successor = gh_api(f"repos/{repository}/actions/runs/{successor_run_id}")
        if not isinstance(successor, dict) or (
            type(successor.get("id")) is not int or successor["id"] != int(successor_run_id)
            or successor.get("head_sha") != subject_sha
            or type(successor.get("run_attempt")) is not int or successor["run_attempt"] != 1
            or successor.get("path") != ".github/workflows/oci-live-data-rollout.yml"
            or successor.get("event") != "workflow_dispatch" or successor.get("head_branch") != "master"
            or (successor.get("head_repository") or {}).get("full_name") != repository
        ):
            fail(f"{label} successor is not the exact native first attempt")
        portable = successor.get("status") == "completed" and successor.get("conclusion") == "success"
        executing = (
            successor.get("status") == "in_progress"
            and os.environ.get("GITHUB_ACTIONS") == "true"
            and os.environ.get("GITHUB_RUN_ID") == successor_run_id
            and os.environ.get("GITHUB_REPOSITORY") == repository
            and os.environ.get("GITHUB_SHA") == subject_sha
        )
        if portable or executing:
            native_cli_handoff_approval(
                repository, successor_run_id, "oci-live-data-continue-held-handoff", label,
            )
            if portable and failed_deploy_native_inputs(
                repository, successor_run_id, subject_sha, label, resume_dispatch=True,
            ) != dispatch_inputs:
                fail(f"{label} completed successor substituted its native dispatch tuple")
            if executing:
                job = exact_job(jobs_for_run(repository, successor_run_id, label), "rollout", label)
                admissions = [
                    step for step in job["steps"]
                    if step.get("name") == "Validate exact SHA phase and trusted upstream runs"
                ]
                if (
                    job.get("run_id") != int(successor_run_id) or len(admissions) != 1
                    or admissions[0].get("status") not in {"in_progress", "completed"}
                    or admissions[0].get("status") == "completed"
                    and admissions[0].get("conclusion") != "success"
                ):
                    fail(f"{label} native successor has not executed its authenticated admission")
            return
    root = Path(__file__).resolve().parents[3]
    directory = authority.ensure_authority_dir(
        os.environ.get("COPILOT_CLI_AUTHORITY_DIR") or str(
            Path(os.environ.get("XDG_STATE_HOME") or Path.home() / ".local/state")
            / "betstan/copilot-cli-authority"),
        root, create=False,
    )
    def policy_at(source, operation):
        policy_source = held_source_bytes(
            repository, source, "infra/azure/agents/copilot-cli-protected-operation-policy-stan.sh", label,
        )
        result = subprocess.run(
            ["bash", "-s", "--", "get", operation], input=policy_source,
            capture_output=True, text=True, check=False,
        )
        if result.returncode:
            fail(f"{label} source-bound authority policy is unavailable")
        try:
            policy = json.loads(result.stdout)
        except ValueError:
            fail(f"{label} source-bound authority policy is malformed")
        return policy
    def verify(record, source, expected_inputs, historical=False):
        policy = policy_at(source, record["operation"])
        workflow = held_source_bytes(
            repository, source, ".github/workflows/oci-live-data-rollout.yml", label,
        ).encode()
        blob = hashlib.sha1(f"blob {len(workflow)}\0".encode() + workflow).hexdigest()
        authority.verify_record(
            record, policy, repository, source, record["workflowId"], blob,
            retirement_only=historical,
        )
        observed = live_data_native_inputs(
            {"approved_sha": record["controlSha"], **record["inputs"]},
            policy["inputNames"],
        )
        if observed != expected_inputs:
            fail(f"{label} owned authority substituted its complete native tuple")
        return policy
    producer = authority.load_record(directory, str(held["id"]))
    if producer["state"] != "consumed" or producer["inflightApproval"] is not None:
        fail(f"{label} physical producer has no consumed owned authority")
    verify(producer, held["head_sha"], native, historical=True)
    authority.validate_run_against_record(held, producer)
    if not any(
        receipt["runId"] == held["id"] and receipt["operation"] == operation
        and receipt["environmentId"] == environment_id
        for receipt in producer["approvals"]
    ):
        fail(f"{label} physical producer consumed receipt differs from native approval")
    owned_successor = None
    if successor is not None:
        owned_successor = authority.load_record(directory, successor_run_id)
        if owned_successor["operation"] != "oci-live-data-continue-held-handoff" or owned_successor["state"] not in {
            "claimed", "issued", "inflight", "consumed",
        }:
            fail(f"{label} successor has no eligible exact owned authority")
        verify(owned_successor, subject_sha, dispatch_inputs)
        authority.validate_run_against_record(successor, owned_successor)
        if authority.parse_utc(owned_successor["expiresAt"], label).timestamp() <= time.time():
            fail(f"{label} successor owned authority has expired")
    historical_issued = {}
    def validate_historical_issued(record):
        if record["state"] != "issued" or record["inflightApproval"] is not None:
            fail(f"{label} competing owned authority is not a historical issued record")
        if ({str(held["id"]), successor_run_id} - {""}) & {str(value) for value in record["inputs"].values()}:
            fail(f"{label} historical issued transport binds the current handoff")
        source = record["controlSha"]
        raw = held_source_bytes(
            repository, source, f".github/workflows/{record['workflow']}", label,
        ).encode()
        authority.verify_record(
            record, policy_at(source, record["operation"]), repository, source,
            record["workflowId"], hashlib.sha1(f"blob {len(raw)}\0".encode() + raw).hexdigest(),
            retirement_only=True,
        )
        cutoff = parse_timestamp(held.get("created_at"), label)
        endpoint = f"repos/{repository}/actions/runs/{record['runId']}"
        keys = (
            "id", "workflow_id", "path", "head_sha", "head_branch", "event", "run_attempt",
            "display_title", "html_url", "status", "conclusion",
            "created_at", "run_started_at", "updated_at",
        )
        terminal = {"success", "failure", "cancelled", "skipped"}
        observations = []
        for _ in range(2):
            latest, first = gh_api(endpoint), gh_api(endpoint + "/attempts/1")
            for run in (latest, first):
                authority.validate_run_against_record(run, record)
                if (
                    any(key not in run for key in keys)
                    or type(run["id"]) is not int or type(run["workflow_id"]) is not int
                    or type(run["run_attempt"]) is not int or run["run_attempt"] != 1
                    or run["html_url"] != record["runUrl"]
                    or run["status"] != "completed" or run["conclusion"] not in terminal
                ):
                    fail(f"{label} historical issued run is not an exact terminal first attempt")
                created, started, ended = (
                    parse_timestamp(run[key], label)
                    for key in ("created_at", "run_started_at", "updated_at")
                )
                if not created <= started <= ended < cutoff:
                    fail(f"{label} issued run did not finish strictly before the held producer")
            if any(type(latest[key]) is not type(first[key]) or latest[key] != first[key] for key in keys):
                fail(f"{label} historical issued first-attempt observations disagree")
            jobs = jobs_for_run(repository, str(record["runId"]), label)
            job_ids = set()
            for job in jobs:
                if (
                    type(job.get("id")) is not int or job["id"] < 1 or job["id"] in job_ids
                    or type(job.get("run_id")) is not int or job["run_id"] != record["runId"]
                    or type(job.get("run_attempt")) is not int or job["run_attempt"] != 1
                    or job.get("head_sha") != source or job.get("head_branch") != "master"
                    or job.get("status") != "completed" or job.get("conclusion") not in terminal
                ):
                    fail(f"{label} historical issued job is not an exact terminal first attempt")
                job_ids.add(job["id"])
                steps = job.get("steps")
                if not isinstance(steps, list) or any(not isinstance(step, dict) for step in steps):
                    fail(f"{label} historical issued job step inventory is malformed")
                job_created = parse_timestamp(job.get("created_at"), label)
                job_ended = parse_timestamp(job.get("completed_at"), label)
                if not created <= job_created <= job_ended <= ended or not job_ended < cutoff:
                    fail(f"{label} historical issued job completion is outside its native window")
                if job.get("started_at") is None:
                    if job["conclusion"] not in {"cancelled", "skipped"} or job["steps"] != []:
                        fail(f"{label} historical issued job has ambiguous execution evidence")
                elif not job_created <= parse_timestamp(job["started_at"], label) <= job_ended:
                    fail(f"{label} historical issued job chronology is inconsistent")
                for step in steps:
                    if (
                        step.get("status") != "completed" or step.get("conclusion") not in terminal
                        or "started_at" not in step or "completed_at" not in step
                    ):
                        fail(f"{label} historical issued job retains incomplete or unknown steps")
                    if step["started_at"] is None and step["completed_at"] is None:
                        if step["conclusion"] not in {"cancelled", "skipped"}:
                            fail(f"{label} historical issued executed step has no native window")
                    elif not (
                        parse_timestamp(job["started_at"], label)
                        <= parse_timestamp(step["started_at"], label)
                        <= parse_timestamp(step["completed_at"], label) <= job_ended
                    ):
                        fail(f"{label} historical issued step contradicts its authenticated job window")
            pending = gh_api(endpoint + "/pending_deployments")
            if pending != []:
                fail(f"{label} historical issued run retains pending deployment authority")
            if authority.load_record(directory, str(record["runId"])) != record:
                fail(f"{label} historical issued authority changed during native qualification")
            observations.append(({key: latest[key] for key in keys},
                                 {key: first[key] for key in keys}, jobs))
        if observations[0] != observations[1]:
            fail(f"{label} historical issued native evidence changed between complete collections")
        historical_issued[record["runId"]] = record

    entries = sorted(directory.glob("*.json"))
    if len(entries) > 1000:
        fail(f"{label} private authority inventory exceeds its complete bound")
    for path in entries:
        if POSITIVE_INTEGER.fullmatch(path.stem):
            record = authority.load_record(directory, path.stem)
            if record["repository"] != repository or record["runId"] in {
                held["id"], int(successor_run_id or "0"),
            }:
                continue
            if record["state"] not in {"consumed", "retired"}:
                validate_historical_issued(record)
        else:
            match = re.fullmatch(r"(?:request-|spent-)([0-9a-f]{64})(?:-dispatch-[0-9a-f]{32})?", path.stem)
            if match is None:
                fail(f"{label} private authority inventory contains an unexplained record")
            intent = authority.load_intent_file(path, match[1])
            if intent["repository"] != repository:
                continue
            if intent["state"] == "bound":
                record = authority.bound_intent_record(directory, intent)
                if record["runId"] in {held["id"], int(successor_run_id or "0")} or record["state"] in {
                    "consumed", "retired",
                }:
                    continue
                if historical_issued.get(record["runId"]) == record:
                    continue
            elif not successor_run_id and intent["state"] in {"prepared", "dispatching"}:
                owner = os.environ.get("BETSTAN_HELD_DISPATCH_OWNER", "")
                if (
                    command_owner_is_ancestor(owner)
                    and (intent["state"] == "prepared" or intent["ownerPid"] == int(owner))
                    and intent["operation"] == "oci-live-data-continue-held-handoff"
                    and intent["controlSha"] == subject_sha
                    and intent["subjectSha"] == subject_sha and intent["targetSha"] is None
                    and {"approved_sha": subject_sha, **intent["inputs"]} == dispatch_inputs
                    and intent["inputHash"] == authority.canonical_input_hash(intent["inputs"])
                    and intent["dispatchStatus"] is None
                    and authority.parse_utc(intent["expiresAt"], label).timestamp() > time.time()
                ):
                    policy = policy_at(subject_sha, intent["operation"])
                    normalized = authority.validate_request_data({
                        "schemaVersion": authority.REQUEST_SCHEMA, "repository": repository,
                        "operation": intent["operation"], "controlSha": subject_sha,
                        "subjectSha": subject_sha, "targetSha": None, "inputs": dispatch_inputs,
                    }, policy, repository, subject_sha)
                    workflow = gh_api(f"repos/{repository}/actions/workflows/oci-live-data-rollout.yml")
                    raw = held_source_bytes(
                        repository, subject_sha, ".github/workflows/oci-live-data-rollout.yml", label,
                    ).encode()
                    authority.verify_intent(
                        intent, normalized, policy, repository, subject_sha,
                        workflow["id"], hashlib.sha1(f"blob {len(raw)}\0".encode() + raw).hexdigest(),
                    )
                    if intent["state"] == "prepared":
                        if intent["schemaVersion"] != authority.PREPARED_INTENT_SCHEMA:
                            fail(f"{label} prepared successor is not sealed")
                        authority.require_prepared_capture(directory, intent)
                        if intent["preparedSeal"]["policySha256"] != authority.evidence_digest(policy):
                            fail(f"{label} prepared successor policy changed")
                    capture = directory / intent["captureFile"]
                    metadata = capture.lstat()
                    if (
                        stat.S_ISREG(metadata.st_mode) and metadata.st_uid == os.getuid()
                        and stat.S_IMODE(metadata.st_mode) == 0o600 and metadata.st_nlink == 1
                        and metadata.st_size == 0
                    ):
                        continue
            fail(f"{label} unresolved dispatch intent prevents receiver absence")


def _validate_cancelled_unstarted_history(repository, row, subject_sha, authority, label, path):
    expected = {
        "id": row["id"], "workflow_id": row["workflow_id"], "path": path,
        "head_sha": row["head_sha"], "head_branch": "master",
        "event": "workflow_dispatch", "run_attempt": 1,
        "status": "completed", "conclusion": "cancelled",
        "display_title": f"oci-live-data apply-slip-index {row['head_sha']}",
        "html_url": f"https://github.com/{repository}/actions/runs/{row['id']}",
    }
    endpoint = f"repos/{repository}/actions/runs/{row['id']}"
    observations = []
    for _ in range(2):
        latest = gh_api(endpoint)
        first = gh_api(endpoint + "/attempts/1")
        windows = []
        for run in (latest, first):
            if (
                not isinstance(run, dict)
                or any(type(run.get(key)) is not type(value) or run.get(key) != value
                       for key, value in expected.items())
                or not isinstance(run.get("head_repository"), dict)
                or run["head_repository"].get("full_name") != repository
            ):
                fail(f"{label} is not an exact cancelled first attempt")
            window = tuple(parse_timestamp(run.get(key), label) for key in (
                "created_at", "run_started_at", "updated_at",
            ))
            if not window[0] <= window[1] <= window[2]:
                fail(f"{label} endpoint chronology is invalid")
            windows.append(window)
        if windows[0][:2] != windows[1][:2]:
            fail(f"{label} latest and first-attempt start windows disagree")
        if any(
            key not in row or type(row[key]) is not type(latest[key])
            or row[key] != latest[key]
            for key in (*expected, "created_at", "run_started_at", "updated_at")
        ):
            fail(f"{label} native details differ from the complete inventory")
        workflow_metadata, job_pages, pending, approvals, artifact_pages = native_api_batch([
            (f"repos/{repository}/actions/workflows/oci-live-data-rollout.yml", False),
            (endpoint + "/attempts/1/jobs?per_page=100", True),
            (endpoint + "/pending_deployments", False),
            (endpoint + "/approvals", False),
            (endpoint + "/artifacts?per_page=100", True),
        ])
        if (
            not isinstance(workflow_metadata, dict)
            or type(workflow_metadata.get("id")) is not int
            or workflow_metadata["id"] != row["workflow_id"]
            or workflow_metadata.get("path") != path
            or workflow_metadata.get("state") not in {"active", "disabled_manually"}
        ):
            fail(f"{label} workflow identity is invalid")
        jobs = jobs_from_pages(job_pages, label)
        if len(jobs) != 1:
            fail(f"{label} must have exactly one cancelled rollout job")
        job = exact_job(jobs, "rollout", label)
        job_expected = {
            "run_id": row["id"], "run_attempt": 1, "head_sha": row["head_sha"],
            "head_branch": "master", "status": "completed", "conclusion": "cancelled",
        }
        if (
            type(job.get("id")) is not int or job["id"] < 1
            or any(type(job.get(key)) is not type(value) or job.get(key) != value
                   for key, value in job_expected.items())
            or job["steps"] != []
            or "runner_id" not in job or "runner_name" not in job
            or not (job["runner_id"] is None
                    or type(job["runner_id"]) is int and job["runner_id"] == 0)
            or job["runner_name"] not in (None, "")
        ):
            fail(f"{label} has assigned, executed, or ambiguous job evidence")
        job_times = tuple(parse_timestamp(job.get(key), label) for key in (
            "created_at", "started_at", "completed_at",
        ))
        if not all(window[1] <= job_times[0] <= job_times[1] <= job_times[2] <= window[2]
                   for window in windows):
            fail(f"{label} job is outside an authenticated endpoint window")
        artifacts = artifacts_from_pages(artifact_pages, label)
        if pending != [] or approvals != [] or artifacts:
            fail(f"{label} has pending, approved, or artifact evidence")
        historical = gh_api(
            f"repos/{repository}/contents/{path}?ref={row['head_sha']}"
        )
        source_pin = historical.get("sha") if isinstance(historical, dict) else None
        if source_pin not in (
            "c3c9332f4b23b55de6c32ae2183b89478f97884f",
            "472896760221c61ef517d656b0ef102d7344f2c9",
        ):
            fail(f"{label} historical workflow is not the guarded source profile")
        try:
            _, source_blob = authority.validate_historical_unmaterialized_workflow(
                path, historical, blob_sha=source_pin,
            )
        except (AttributeError, SystemExit):
            fail(f"{label} historical workflow is not the guarded source profile")
        compare = None
        if row["head_sha"] != subject_sha:
            compare = held_raw_ancestry(authority, repository, row, subject_sha, label)
            try:
                authority.validate_strict_ancestor_compare(compare, row["head_sha"], subject_sha)
            except (AttributeError, SystemExit):
                fail(f"{label} source is not a proven ancestor of the exact anchor")
        observations.append({
            "latest": {key: latest[key] for key in (*expected, "created_at", "run_started_at", "updated_at")},
            "first": {key: first[key] for key in (*expected, "created_at", "run_started_at", "updated_at")},
            "workflow": {key: workflow_metadata[key] for key in ("id", "path", "state")},
            "job": job, "source_blob": source_blob, "compare": compare,
        })
    if observations[0] != observations[1]:
        fail(f"{label} native no-execution evidence changed between complete collections")


def _validate_unmaterialized_history(
    repository, row, subject_sha, authority, label, identity_keys,
):
    run_endpoint = f"repos/{repository}/actions/runs/{row['id']}"
    native = gh_api(run_endpoint)
    def validate_opening_identity(observed):
        if (
            not isinstance(observed, dict)
            or any(
                key not in observed or type(observed[key]) is not type(row[key])
                or observed[key] != row[key] for key in identity_keys
            )
            or not isinstance(observed.get("head_repository"), dict)
            or observed["head_repository"].get("full_name") != repository
        ):
            fail(f"{label} native details drifted from the complete inventory")
    validate_opening_identity(native)
    workflow_metadata, jobs, pending, approvals, artifacts = native_api_batch([
        (f"repos/{repository}/actions/workflows/{row['workflow_id']}", False),
        (run_endpoint + "/jobs?filter=all&per_page=100", False),
        (run_endpoint + "/pending_deployments", False),
        (run_endpoint + "/approvals", False),
        (run_endpoint + "/artifacts?per_page=100", False),
    ])
    historical = gh_api(
        f"repos/{repository}/contents/{row['path']}?ref={row['head_sha']}"
    )
    compare = held_raw_ancestry(authority, repository, row, subject_sha, label)
    try:
        authority.validate_unmaterialized_run_evidence(
            run=native, workflow=workflow_metadata, jobs=jobs, pending=pending,
            approvals=approvals, artifacts=artifacts,
            compare=compare,
            historical_workflow=historical, repository=repository,
            current_master=subject_sha, now_epoch=int(time.time()),
            minimum_age_seconds=600, expected_run_id=row["id"],
            expected_workflow_id=row["workflow_id"], expected_path=row["path"],
            expected_head_sha=row["head_sha"], require_disabled_workflow=False,
        )
    except SystemExit:
        fail(f"{label} is not an authenticated unmaterialized run")
    validate_opening_identity(gh_api(run_endpoint))


def _failed_held_continuation_profile():
    return {
        "name": FAILED_HELD_CONTINUATION_PROFILE,
        "repository": "vasilyevstan/betstan",
        "repository_id": FAILED_HELD_CONTINUATION_REPOSITORY_ID,
        "repository_node_id": FAILED_HELD_CONTINUATION_REPOSITORY_NODE_ID,
        "run_id": FAILED_HELD_CONTINUATION_RUN_ID,
        "held_run_id": FAILED_HELD_CONTINUATION_HELD_RUN_ID,
        "held_source": FAILED_HELD_CONTINUATION_HELD_SOURCE,
        "control": FAILED_HELD_CONTINUATION_CONTROL,
        "tree": FAILED_HELD_CONTINUATION_TREE,
        "workflow_id": FAILED_HELD_CONTINUATION_WORKFLOW_ID,
        "workflow_blob": dict(FAILED_HELD_CONTINUATION_CLOSURE)[
            ".github/workflows/oci-live-data-rollout.yml"
        ],
        "current_workflow_blob": FAILED_HELD_CONTINUATION_CURRENT_WORKFLOW_BLOB,
        "policy_blob": dict(FAILED_HELD_CONTINUATION_CLOSURE)[
            "infra/azure/agents/copilot-cli-protected-operation-policy-stan.sh"
        ],
        "authority_blob": dict(FAILED_HELD_CONTINUATION_CLOSURE)[
            "infra/azure/agents/copilot_cli_authority_stan.py"
        ],
        "input_names": FAILED_HELD_CONTINUATION_INPUT_NAMES,
        "policy_sha256": FAILED_HELD_CONTINUATION_POLICY_SHA256,
        "input_sha256": FAILED_HELD_CONTINUATION_INPUT_SHA256,
        "lineage_sha256": FAILED_HELD_CONTINUATION_LINEAGE_SHA256,
        "actions": FAILED_HELD_CONTINUATION_ACTIONS,
        "closure": dict(FAILED_HELD_CONTINUATION_CLOSURE),
        "steps": FAILED_HELD_CONTINUATION_STEPS,
        "artifacts": FAILED_HELD_CONTINUATION_ARTIFACTS,
        "baseline_members": dict(FAILED_HELD_CONTINUATION_BASELINE_MEMBERS),
        "rollout_members": dict(FAILED_HELD_CONTINUATION_ROLLOUT_MEMBERS),
        "log_members": dict(FAILED_HELD_CONTINUATION_LOG_MEMBERS),
        "protected_read": FAILED_HELD_CONTINUATION_PROTECTED_READ,
        "denial": FAILED_HELD_CONTINUATION_DENIAL,
        "lock_source_sha256": FAILED_HELD_CONTINUATION_LOCK_SOURCE_SHA256,
        "lock_outside_sha256": FAILED_HELD_CONTINUATION_LOCK_OUTSIDE_SHA256,
        "cleanup_outside_sha256": FAILED_HELD_CONTINUATION_CLEANUP_OUTSIDE_SHA256,
    }


def _failed_held_git(label, *arguments):
    root = Path(__file__).resolve().parents[3]
    environment = {
        name: value for name, value in os.environ.items()
        if not name.startswith("GIT_")
    }
    environment["GIT_NO_REPLACE_OBJECTS"] = "1"
    try:
        result = subprocess.run(
            ["git", "-C", str(root), *arguments],
            capture_output=True, check=False, env=environment, timeout=15,
        )
    except (OSError, subprocess.TimeoutExpired):
        fail(f"{label} immutable Git source is unavailable")
    if result.returncode:
        fail(f"{label} immutable Git source is unavailable")
    return result.stdout


def _failed_held_tree_blobs(value, expected_sha, label):
    if (
        not isinstance(value, dict) or value.get("sha") != expected_sha
        or value.get("truncated") is not False
        or not isinstance(value.get("tree"), list)
    ):
        fail(f"{label} authenticated tree is incomplete")
    blobs = {}
    for entry in value["tree"]:
        if not isinstance(entry, dict) or not isinstance(entry.get("path"), str):
            fail(f"{label} authenticated tree entry is malformed")
        path = entry["path"]
        if path in blobs:
            fail(f"{label} authenticated tree contains a duplicate path")
        if entry.get("type") == "blob":
            if (
                entry.get("mode") not in {"100644", "100755"}
                or not isinstance(entry.get("sha"), str)
                or FULL_SHA.fullmatch(entry["sha"]) is None
            ):
                fail(f"{label} authenticated blob entry is malformed")
            blobs[path] = entry["sha"]
    return blobs


def _failed_held_current_reader(repository, subject_sha, profile):
    label = f"{profile['name']} current reader"
    if (
        repository != profile["repository"]
        or not isinstance(subject_sha, str)
        or FULL_SHA.fullmatch(subject_sha) is None
        or subject_sha == profile["control"]
    ):
        fail(f"{label} repository or current subject is invalid")
    root = Path(__file__).resolve().parents[3]
    validator_path = "infra/oci/scripts/upstream_run_binding_stan.py"
    workflow_path = ".github/workflows/oci-live-data-rollout.yml"
    policy_path = "infra/azure/agents/copilot-cli-protected-operation-policy-stan.sh"
    authority_path = "infra/azure/agents/copilot_cli_authority_stan.py"
    head = _failed_held_git(label, "rev-parse", "HEAD").decode().strip()
    status = _failed_held_git(
        label, "status", "--porcelain=v1", "--untracked-files=all",
    )
    tree_sha = _failed_held_git(
        label, "rev-parse", f"{subject_sha}^{{tree}}",
    ).decode().strip()
    local = {
        path: _failed_held_git(
            label, "rev-parse", f"{subject_sha}:{path}",
        ).decode().strip()
        for path in (workflow_path, policy_path, authority_path, validator_path)
    }
    try:
        validator_raw = (root / validator_path).read_bytes()
    except OSError:
        fail(f"{label} executing validator is unavailable")
    validator_blob = hashlib.sha1(
        f"blob {len(validator_raw)}\0".encode() + validator_raw
    ).hexdigest()
    if (
        Path(__file__).is_symlink() or head != subject_sha or status
        or FULL_SHA.fullmatch(tree_sha) is None
        or local[workflow_path] != profile["current_workflow_blob"]
        or local[policy_path] != profile["policy_blob"]
        or local[authority_path] != profile["authority_blob"]
        or local[validator_path] != validator_blob
    ):
        fail(f"{label} is not the clean exact current-master source")
    reference = gh_api(f"repos/{repository}/git/ref/heads/master")
    commit = gh_api(f"repos/{repository}/git/commits/{subject_sha}")
    tree = gh_api(f"repos/{repository}/git/trees/{tree_sha}?recursive=1")
    if (
        not isinstance(reference, dict)
        or reference.get("ref") != "refs/heads/master"
        or not isinstance(reference.get("object"), dict)
        or reference["object"].get("type") != "commit"
        or reference["object"].get("sha") != subject_sha
        or not isinstance(commit, dict) or commit.get("sha") != subject_sha
        or not isinstance(commit.get("tree"), dict)
        or commit["tree"].get("sha") != tree_sha
    ):
        fail(f"{label} is no longer exact current master")
    native_blobs = _failed_held_tree_blobs(tree, tree_sha, label)
    if any(native_blobs.get(path) != blob for path, blob in local.items()):
        fail(f"{label} authenticated source tree differs from local execution")
    historical_workflow = held_source_bytes(
        repository, profile["control"], workflow_path, label,
    )
    current_workflow = held_source_bytes(
        repository, subject_sha, workflow_path, label,
    )
    historical_lines = historical_workflow.splitlines(keepends=True)
    removed = [
        index for index, line in enumerate(historical_lines)
        if line.strip() == profile["protected_read"]
    ]
    if (
        len(removed) != 1
        or "".join(
            line for index, line in enumerate(historical_lines)
            if index != removed[0]
        ) != current_workflow
    ):
        fail(f"{label} corrected workflow is not the reviewed forward-compatible reader")
    return {
        "control": subject_sha,
        "tree": tree_sha,
        "workflowBlob": local[workflow_path],
        "policyBlob": local[policy_path],
        "authorityBlob": local[authority_path],
        "validatorBlob": validator_blob,
    }


def _collect_failed_held_continuation_observation(repository, profile):
    run_id = str(profile["run_id"])
    endpoint = f"repos/{repository}/actions/runs/{run_id}"
    job_pages = gh_api_pages(endpoint + "/attempts/1/jobs?per_page=100")
    artifact_pages = gh_api_pages(endpoint + "/artifacts?per_page=100")
    artifacts = artifacts_from_pages(
        artifact_pages, f"{profile['name']} artifacts",
    )
    archives = {}
    for artifact_id, _, _, _, _, _, _, _ in profile["artifacts"]:
        matches = [
            artifact for artifact in artifacts
            if artifact.get("id") == artifact_id
        ]
        if len(matches) != 1:
            fail(f"{profile['name']} exact artifact identity is absent or ambiguous")
        archives[str(artifact_id)] = artifact_archive(
            repository, matches[0], profile["name"],
        )
    return {
        "run": gh_api(endpoint),
        "attempt": gh_api(endpoint + "/attempts/1"),
        "workflow": gh_api(
            f"repos/{repository}/actions/workflows/{profile['workflow_id']}"
        ),
        "jobPages": job_pages,
        "pending": gh_api(endpoint + "/pending_deployments?per_page=100"),
        "approvals": gh_api(endpoint + "/approvals?per_page=100"),
        "artifactPages": artifact_pages,
        "commit": gh_api(
            f"repos/{repository}/git/commits/{profile['control']}"
        ),
        "tree": gh_api(
            f"repos/{repository}/git/trees/{profile['tree']}?recursive=1"
        ),
        "attemptLog": gh_api_bytes(endpoint + "/attempts/1/logs"),
        "archives": archives,
    }


def _failed_held_project_run(run):
    if not isinstance(run, dict):
        return None
    repository = run.get("repository")
    head_repository = run.get("head_repository")
    return {
        key: run.get(key) for key in (
            "id", "node_id", "workflow_id", "run_attempt", "path", "event",
            "display_title", "head_branch", "head_sha", "status", "conclusion",
            "created_at", "run_started_at", "updated_at", "html_url",
        )
    } | {
        "repository": {
            key: repository.get(key) if isinstance(repository, dict) else None
            for key in ("id", "node_id", "full_name")
        },
        "head_repository": {
            key: head_repository.get(key) if isinstance(head_repository, dict) else None
            for key in ("id", "node_id", "full_name")
        },
    }


def _failed_held_step_lines(raw, step, label, source_header):
    lines = native_step_log_lines(raw, step, label)
    starts = [
        index for index, line in enumerate(lines)
        if line == source_header
    ]
    if len(starts) != 1:
        fail(f"{label} native shell source group is absent or ambiguous")
    depth = 0
    source_end = None
    for index in range(starts[0], len(lines)):
        line = lines[index]
        if line.startswith("##[group]"):
            depth += 1
        elif line == "##[endgroup]":
            depth -= 1
            if depth == 0:
                source_end = index
                break
    if source_end is None:
        fail(f"{label} native shell source group is incomplete")
    outside, depth = [], 0
    for line in lines:
        if line.startswith("##[group]"):
            depth += 1
        elif line == "##[endgroup]":
            if depth < 1:
                fail(f"{label} native log grouping is inconsistent")
            depth -= 1
        elif depth == 0:
            outside.append(line)
    if depth:
        fail(f"{label} native log grouping is incomplete")
    return lines[starts[0] + 1:source_end], outside


def _failed_held_artifact_proof(
    files, expected_members, historical, held, profile, semantic, label, *,
    baseline,
):
    observed = {
        path: hashlib.sha256(raw).hexdigest()
        for path, raw in files.items()
    }
    if observed != expected_members:
        fail(f"{label} exact member inventory or checksum differs")
    semantic_keys = {
        "rootRunId", "rootSourceSha", "baselineFiles", "imageBytes",
        "checkpoint", "heldEvidenceSha256", "lockHolder",
        "lockFencingGeneration", "lockLeaseUntilEpoch", "lockLeaseSeconds",
        "lockNamespace",
    }
    if (
        not isinstance(semantic, dict) or set(semantic) != semantic_keys
        or not isinstance(semantic["baselineFiles"], dict)
        or not all(
            isinstance(path, str) and isinstance(raw, bytes)
            for path, raw in semantic["baselineFiles"].items()
        )
        or not isinstance(semantic["imageBytes"], bytes)
        or not semantic["imageBytes"]
        or not isinstance(semantic["checkpoint"], dict)
        or set(semantic["checkpoint"]) != {
            "sourceSha", "contentChecksumSha256", "disposition",
        }
        or POSITIVE_INTEGER.fullmatch(semantic["rootRunId"]) is None
        or FULL_SHA.fullmatch(semantic["rootSourceSha"]) is None
        or re.fullmatch(r"[0-9a-f]{64}", semantic["heldEvidenceSha256"]) is None
        or semantic["lockHolder"] != f"live-data-{profile['held_run_id']}-1"
        or POSITIVE_INTEGER.fullmatch(semantic["lockFencingGeneration"]) is None
        or POSITIVE_INTEGER.fullmatch(semantic["lockLeaseUntilEpoch"]) is None
        or semantic["lockLeaseSeconds"] not in {"1800", "3600"}
        or not isinstance(semantic["lockNamespace"], str)
        or not semantic["lockNamespace"]
    ):
        fail(f"{label} authenticated predecessor semantic context differs")
    if baseline:
        prefix = "betstan/betstan/artifacts/oci-data-baseline-before/"
        selected = {
            path.removeprefix(prefix): raw
            for path, raw in files.items() if path.startswith(prefix)
        }
        if set(files) - set(path for path in files if path.startswith(prefix)) != {
            "_temp/pre-runtime-lock.json"
        }:
            fail(f"{label} baseline archive has an unexpected outer member")
        validate_checksum_manifest(selected, label)
        if selected != semantic["baselineFiles"]:
            fail(f"{label} baseline bytes differ from the authenticated held producer")
        provenance = parse_env(
            selected["baseline-provenance.env"], label, BASELINE_PROVENANCE_KEYS,
        )
        if (
            provenance["baseline_capture_run_id"]
                != historical["prerequisite_run_id"]
            or provenance["baseline_capture_run_attempt"] != "1"
            or provenance["baseline_recovery_run_id"]
                != historical["baseline_recovery_run_id"]
            or provenance["baseline_recovery_run_attempt"]
                != ("0" if historical["baseline_recovery_run_id"] == "0" else "1")
            or provenance["registry_provider"] != "ghcr"
            or provenance["registry_host"] != "ghcr.io"
            or provenance["registry_repository"] != APPLICATION_REPOSITORY
            or provenance["registry_public_anonymous"] != "true"
        ):
            fail(f"{label} baseline provenance substituted its release lineage")
        try:
            lock = json.loads(files["_temp/pre-runtime-lock.json"])
        except (ValueError, UnicodeError):
            fail(f"{label} pre-mutation lock snapshot is malformed")
        data = lock.get("data") if isinstance(lock, dict) else None
        metadata = lock.get("metadata") if isinstance(lock, dict) else None
        lock_keys = {
            "state", "holder", "operation-id", "source-sha",
            "acquired-at-epoch", "lease-duration-seconds",
            "lease-until-epoch", "released-at-epoch", "fencing-generation",
        }
        if (
            lock.get("apiVersion") != "v1" or lock.get("kind") != "ConfigMap"
            or not isinstance(metadata, dict)
            or metadata.get("name") != "gaming-mongo-migration-lock"
            or metadata.get("namespace") != semantic["lockNamespace"]
            or not isinstance(metadata.get("uid"), str) or not metadata["uid"]
            or POSITIVE_INTEGER.fullmatch(str(metadata.get("resourceVersion", ""))) is None
            or not isinstance(data, dict) or set(data) != lock_keys
            or data.get("state") != "active"
            or data.get("source-sha") != held["head_sha"]
            or data.get("operation-id") != "live-data-apply-slip-index"
            or data.get("holder") != semantic["lockHolder"]
            or data.get("fencing-generation")
                != semantic["lockFencingGeneration"]
            or data.get("lease-until-epoch") != semantic["lockLeaseUntilEpoch"]
            or data.get("lease-duration-seconds") != semantic["lockLeaseSeconds"]
            or any(
                not isinstance(data.get(key), str)
                or re.fullmatch(r"[0-9]+", data[key]) is None
                for key in (
                    "acquired-at-epoch", "lease-until-epoch",
                    "fencing-generation", "released-at-epoch",
                )
            )
            or int(data["released-at-epoch"]) != 0
            or int(data["acquired-at-epoch"]) >= int(data["lease-until-epoch"])
        ):
            fail(f"{label} pre-mutation lock snapshot is not the held owner's active baseline")
        return {
            "members": observed,
            "baselineManifest": hashlib.sha256(
                selected["SHA256SUMS"]
            ).hexdigest(),
            "captureRun": provenance["baseline_capture_run_id"],
            "lockSource": data["source-sha"],
            "lockState": data["state"],
        }
    try:
        history = json.loads(files["held-handoff-history.json"])
    except (ValueError, UnicodeError):
        fail(f"{label} held history is malformed")
    expected_history_keys = {
        "schema_version", "repository", "held_handoff_run_id",
        "held_handoff_source_sha", "successor_run_id", "successor_source_sha",
        "start_at", "cutoff_at", "workflow_counts",
    }
    if (
        not isinstance(history, dict) or set(history) != expected_history_keys
        or history["schema_version"] != "live-betting-held-handoff-history-v1"
        or history["repository"] != profile["repository"]
        or history["held_handoff_run_id"] != str(profile["held_run_id"])
        or history["held_handoff_source_sha"] != profile["held_source"]
        or history["successor_run_id"] != str(profile["run_id"])
        or history["successor_source_sha"] != profile["control"]
        or history["start_at"] != held.get("created_at")
        or history["cutoff_at"] != profile["steps"][3][3]
        or not isinstance(history["workflow_counts"], dict)
        or not history["workflow_counts"]
        or any(
            not isinstance(name, str) or not name.endswith(".yml")
            or type(count) is not int or count < 0
            for name, count in history["workflow_counts"].items()
        )
    ):
        fail(f"{label} held history substituted its exact owner or successor")
    authority = parse_env(
        files["resume-authority.env"], label, LIVE_RESUME_AUTHORITY_V3_KEYS,
    )
    expected_authority = {
        "schema_version": "live-betting-data-resume-v4",
        "applied_data_run_id": semantic["rootRunId"],
        "applied_source_sha": semantic["rootSourceSha"],
        "failed_deploy_run_id": historical["failed_deploy_run_id"],
        "resume_maintenance_mode": "pre-runtime-hold",
        "failed_deploy_job_conclusion": "failure",
        "public_validate_job_conclusion": "skipped",
        "lock_release_step_conclusion": "skipped",
        "fence_release_step_conclusion": "skipped",
        "rehold_step_conclusion": "skipped",
        "failed_activation_run_id": "0",
        "current_source_sha": profile["control"],
        "baseline_sha256": validate_checksum_manifest(
            semantic["baselineFiles"], label,
        ),
        "runtime_images_sha256": hashlib.sha256(
            semantic["imageBytes"],
        ).hexdigest(),
        "checkpoint_source_sha": historical["checkpoint_source_sha"],
        "disk_checkpoint_run_id": historical["disk_checkpoint_run_id"],
        "disk_checkpoint_sha256":
            semantic["checkpoint"]["contentChecksumSha256"],
        "disk_checkpoint_disposition": semantic["checkpoint"]["disposition"],
        "application_change_scope": "github-infra-docs-only",
        "status": "PASS",
        "held_handoff_run_id": str(profile["held_run_id"]),
        "held_handoff_source_sha": profile["held_source"],
        "held_handoff_evidence_sha256": semantic["heldEvidenceSha256"],
    }
    if (
        semantic["checkpoint"]["sourceSha"] != historical["checkpoint_source_sha"]
        or authority != expected_authority
    ):
        fail(f"{label} resume authority substituted its no-mutation held lineage")
    return {
        "members": observed,
        "history": history,
        "authority": {
            key: authority[key] for key in sorted(expected_authority)
        },
    }


def _validate_failed_held_continuation_observation(
    repository, row, held, subject_sha, dispatch_inputs, cutoff,
    active_inventory, profile, current_reader, observation, semantic,
):
    label = profile["name"]
    current_reader_sha = _CURRENT_READER_SHA_CONTEXT.get()
    if current_reader_sha is None:
        current_reader_sha = subject_sha
    observation_keys = {
        "run", "attempt", "workflow", "jobPages", "pending", "approvals",
        "artifactPages", "commit", "tree", "attemptLog", "archives",
    }
    if (
        history_worker_context() is not None
        or repository != profile["repository"]
        or type(row.get("id")) is not int or row["id"] != profile["run_id"]
        or type(held.get("id")) is not int
        or held["id"] != profile["held_run_id"]
        or held.get("head_sha") != profile["held_source"]
        or not isinstance(dispatch_inputs, dict)
        or not isinstance(observation, dict)
        or set(observation) != observation_keys
        or not isinstance(observation["jobPages"], list)
        or not isinstance(observation["artifactPages"], list)
        or not isinstance(observation["attemptLog"], bytes)
        or not 0 < len(observation["attemptLog"]) <= MAX_ARTIFACT_ARCHIVE_BYTES
        or not isinstance(observation["archives"], dict)
        or set(observation["archives"]) != {
            str(item[0]) for item in profile["artifacts"]
        }
    ):
        fail(f"{label} exact run, outer owner, or proof context differs")
    if (
        not isinstance(current_reader, dict)
        or set(current_reader) != {
            "control", "tree", "workflowBlob", "policyBlob",
            "authorityBlob", "validatorBlob",
        }
        or current_reader["control"] != current_reader_sha
        or not isinstance(current_reader["tree"], str)
        or FULL_SHA.fullmatch(current_reader["tree"]) is None
        or current_reader["workflowBlob"] != profile["current_workflow_blob"]
        or current_reader["policyBlob"] != profile["policy_blob"]
        or current_reader["authorityBlob"] != profile["authority_blob"]
        or not isinstance(current_reader["validatorBlob"], str)
        or FULL_SHA.fullmatch(current_reader["validatorBlob"]) is None
    ):
        fail(f"{label} current exact-reader proof differs")
    expected_run = {
        "id": profile["run_id"],
        "node_id": "WFR_kwLOLOPcRs8AAAAJFa1HbQ",
        "workflow_id": profile["workflow_id"],
        "run_attempt": 1,
        "path": ".github/workflows/oci-live-data-rollout.yml",
        "event": "workflow_dispatch",
        "display_title": f"oci-live-data apply-slip-index {profile['control']}",
        "head_branch": "master",
        "head_sha": profile["control"],
        "status": "completed",
        "conclusion": "failure",
        "created_at": FAILED_HELD_CONTINUATION_CREATED_AT,
        "run_started_at": FAILED_HELD_CONTINUATION_CREATED_AT,
        "updated_at": FAILED_HELD_CONTINUATION_UPDATED_AT,
        "html_url": (
            f"https://github.com/{repository}/actions/runs/{profile['run_id']}"
        ),
        "repository": {
            "id": profile["repository_id"],
            "node_id": profile["repository_node_id"],
            "full_name": repository,
        },
        "head_repository": {
            "id": profile["repository_id"],
            "node_id": profile["repository_node_id"],
            "full_name": repository,
        },
    }
    latest = _failed_held_project_run(observation.get("run"))
    first = _failed_held_project_run(observation.get("attempt"))
    if latest != expected_run or first != expected_run:
        fail(f"{label} is not the exact terminal first attempt")
    row_keys = (
        "id", "workflow_id", "path", "head_sha", "head_branch", "event",
        "run_attempt", "status", "conclusion", "display_title",
        "created_at", "run_started_at", "updated_at", "html_url",
    )
    if (
        any(
            key not in row or type(row[key]) is not type(expected_run[key])
            or row[key] != expected_run[key]
            for key in row_keys
        )
        or not isinstance(row.get("head_repository"), dict)
        or row["head_repository"].get("id") != profile["repository_id"]
        or row["head_repository"].get("node_id") != profile["repository_node_id"]
        or row["head_repository"].get("full_name") != repository
    ):
        fail(f"{label} complete history row differs from native identity")
    if (
        cutoff is not None
        and parse_timestamp(expected_run["updated_at"], label) >= cutoff
    ):
        fail(f"{label} terminalized after the immutable successor cutoff")
    workflow = observation.get("workflow")
    if (
        not isinstance(workflow, dict)
        or workflow.get("id") != profile["workflow_id"]
        or workflow.get("node_id") != "W_kwDOLOPcRs4UP-0d"
        or workflow.get("name") != "oci-live-data-rollout"
        or workflow.get("path") != ".github/workflows/oci-live-data-rollout.yml"
        or workflow.get("state") not in {"active", "disabled_manually"}
    ):
        fail(f"{label} workflow identity is invalid")
    jobs = jobs_from_pages(observation.get("jobPages"), label)
    if len(jobs) != 1:
        fail(f"{label} must have exactly one rollout job")
    job = exact_job(jobs, "rollout", label)
    expected_job = {
        "id": 117355071855,
        "node_id": "CR_kwDOLOPcRs8AAAAbUuhJbw",
        "run_id": profile["run_id"],
        "run_attempt": 1,
        "head_sha": profile["control"],
        "head_branch": "master",
        "name": "rollout",
        "status": "completed",
        "conclusion": "failure",
        "created_at": "2026-10-17T08:42:39Z",
        "started_at": "2026-10-17T10:21:17Z",
        "completed_at": "2026-10-17T10:35:57Z",
        "runner_id": 1000033152,
        "runner_name": "GitHub Actions 1000033152",
    }
    if any(job.get(key) != value for key, value in expected_job.items()):
        fail(f"{label} rollout job identity or terminal state differs")
    observed_steps = tuple(
        (
            step.get("number"), step.get("name"), step.get("conclusion"),
            step.get("started_at"), step.get("completed_at"),
        )
        for step in job["steps"]
    )
    if (
        observed_steps != profile["steps"]
        or any(step.get("status") != "completed" for step in job["steps"])
    ):
        fail(f"{label} exact ordered step outcomes differ")
    created = parse_timestamp(expected_run["created_at"], label)
    started = parse_timestamp(expected_job["started_at"], label)
    completed = parse_timestamp(expected_job["completed_at"], label)
    updated = parse_timestamp(expected_run["updated_at"], label)
    previous = started
    if not created <= parse_timestamp(expected_job["created_at"], label) <= started <= completed <= updated:
        fail(f"{label} job chronology differs")
    for step in job["steps"]:
        began = parse_timestamp(step["started_at"], label)
        ended = parse_timestamp(step["completed_at"], label)
        if not previous <= began <= ended <= completed:
            fail(f"{label} ordered step chronology differs")
        previous = ended
    if observation.get("pending") != []:
        fail(f"{label} retains a pending environment gate")
    approvals = observation.get("approvals")
    expected_approval = {
        "state": "approved",
        "comment": (
            "Copilot CLI exact-run approval: "
            "oci-live-data-continue-held-handoff"
        ),
        "submitted_at": None,
        "user": {
            "id": 75614529,
            "node_id": "MDQ6VXNlcjc1NjE0NTI5",
            "login": "vasilyevstan",
            "type": "User",
        },
        "environments": [{
            "id": 19134286823,
            "node_id": "EN_kwDOLOPcRs8AAAAEdH4L5w",
            "name": "oci-migration",
        }],
    }
    if not isinstance(approvals, list) or len(approvals) != 1:
        fail(f"{label} exact approval receipt is incomplete or extended")
    review = approvals[0]
    projected_review = {
        key: review.get(key) for key in ("state", "comment", "submitted_at")
    } | {
        "user": {
            key: (review.get("user") or {}).get(key)
            for key in ("id", "node_id", "login", "type")
        },
        "environments": [
            {
                key: environment.get(key)
                for key in ("id", "node_id", "name")
            }
            for environment in review.get("environments", [])
            if isinstance(environment, dict)
        ] if isinstance(review.get("environments"), list) else None,
    }
    if projected_review != expected_approval:
        fail(f"{label} exact approval receipt differs")
    commit = observation.get("commit")
    if (
        not isinstance(commit, dict) or commit.get("sha") != profile["control"]
        or not isinstance(commit.get("tree"), dict)
        or commit["tree"].get("sha") != profile["tree"]
    ):
        fail(f"{label} historical control or corrected tree differs")
    blobs = _failed_held_tree_blobs(observation.get("tree"), profile["tree"], label)
    if any(blobs.get(path) != blob for path, blob in profile["closure"].items()):
        fail(f"{label} authenticated semantic source closure differs")
    for path, blob in profile["closure"].items():
        local = _failed_held_git(
            label, "rev-parse", f"{profile['control']}:{path}",
        ).decode().strip()
        if local != blob:
            fail(f"{label} local historical semantic source closure differs")
    workflow_source = held_source_bytes(
        repository, profile["control"],
        ".github/workflows/oci-live-data-rollout.yml", label,
    )
    actions = tuple(sorted(set(re.findall(
        r"(?m)^[ \t]+uses: ([^\s#]+)", workflow_source,
    ))))
    if actions != tuple(sorted(profile["actions"])):
        fail(f"{label} historical immutable action pins differ")
    policy_source = held_source_bytes(
        repository, profile["control"],
        "infra/azure/agents/copilot-cli-protected-operation-policy-stan.sh",
        label,
    )
    try:
        policy_result = subprocess.run(
            ["bash", "-s", "--", "get", "oci-live-data-continue-held-handoff"],
            input=policy_source, capture_output=True, text=True,
            check=False, timeout=15,
        )
    except (OSError, subprocess.TimeoutExpired):
        fail(f"{label} historical operation policy is unavailable")
    try:
        policy = json.loads(policy_result.stdout)
    except (ValueError, UnicodeError):
        fail(f"{label} historical operation policy is malformed")
    policy_digest = hashlib.sha256(json.dumps(
        policy, ensure_ascii=True, sort_keys=True, separators=(",", ":"),
    ).encode()).hexdigest()
    if (
        policy_result.returncode
        or policy_digest != profile["policy_sha256"]
        or tuple(policy.get("inputNames", ())) != profile["input_names"]
        or policy.get("operation") != "oci-live-data-continue-held-handoff"
        or policy.get("environment") != "oci-migration"
        or policy.get("event") != "workflow_dispatch"
        or policy.get("approvalWorkflowState") != "disabled_manually"
        or policy.get("subjectInput") != "approved_sha"
        or policy.get("subjectRelation") != "current"
        or policy.get("targetInput") is not None
        or policy.get("targetRelation") != "none"
    ):
        fail(f"{label} historical operation policy differs")
    log_files = zip_files(
        observation.get("attemptLog"), label, require_original_names=True,
    )
    log_members = {
        path: hashlib.sha256(raw).hexdigest()
        for path, raw in log_files.items()
    }
    if log_members != profile["log_members"]:
        fail(f"{label} bounded first-attempt log inventory differs")
    historical = failed_deploy_native_inputs(
        repository, str(profile["run_id"]), profile["control"], label,
        resume_dispatch=True, native_jobs=jobs, native_log_files=log_files,
    )
    authority = provenance_read_authority()
    fresh = live_data_native_inputs(dispatch_inputs, profile["input_names"])
    historical_ordered = {
        name: historical[name] for name in profile["input_names"]
    }
    fresh_ordered = {
        name: fresh[name] for name in profile["input_names"]
    }
    if (
        historical_ordered["approved_sha"] != profile["control"]
        or fresh_ordered["approved_sha"] != subject_sha
        or {
            name for name in profile["input_names"]
            if historical_ordered[name] != fresh_ordered[name]
        } != {"approved_sha"}
        or fresh_ordered["held_handoff_run_id"] != str(profile["held_run_id"])
        or fresh_ordered["held_handoff_source_sha"] != profile["held_source"]
        or historical_ordered["phase"] != "apply-slip-index"
        or fresh_ordered["phase"] != "apply-slip-index"
    ):
        fail(f"{label} historical and fresh continuation requests do not share one lineage")
    normalized = []
    for control, inputs in (
        (profile["control"], historical_ordered),
        (subject_sha, fresh_ordered),
    ):
        request = {
            "schemaVersion": authority.REQUEST_SCHEMA,
            "repository": repository,
            "operation": "oci-live-data-continue-held-handoff",
            "controlSha": control, "subjectSha": control,
            "targetSha": None, "inputs": inputs,
        }
        try:
            value = authority.validate_request_data(
                request, policy, repository, control,
            )
        except (AttributeError, KeyError, TypeError, ValueError):
            fail(f"{label} shared policy/input/hash validation is incompatible")
        if (
            value.get("dispatchInputs") != inputs
            or value.get("inputHash") != authority.canonical_input_hash(inputs)
        ):
            fail(f"{label} shared policy/input/hash validation differs")
        normalized.append(value)
    if normalized[0]["inputHash"] != profile["input_sha256"]:
        fail(f"{label} historical canonical transport input hash differs")
    lineage = [
        [name, "{subject_sha}" if name == "approved_sha" else historical_ordered[name]]
        for name in profile["input_names"]
    ]
    lineage_digest = hashlib.sha256(json.dumps(
        lineage, ensure_ascii=True, separators=(",", ":"),
    ).encode()).hexdigest()
    if lineage_digest != profile["lineage_sha256"]:
        fail(f"{label} canonical continuation lineage digest differs")
    lock_step = job["steps"][23]
    cleanup_step = job["steps"][36]
    try:
        job_log = log_files["0_rollout.txt"].decode("utf-8")
    except UnicodeDecodeError:
        fail(f"{label} rollout log is not UTF-8")
    lock_source, lock_outside = _failed_held_step_lines(
        job_log, lock_step, label, "##[group]Run set -euo pipefail",
    )
    cleanup_source, cleanup_outside = _failed_held_step_lines(
        job_log, cleanup_step, label,
        "##[group]Run ./infra/oci/scripts/configure-k3s-access.sh cleanup",
    )
    if (
        hashlib.sha256("\n".join(lock_source).encode()).hexdigest()
            != profile["lock_source_sha256"]
        or hashlib.sha256("\n".join(lock_outside).encode()).hexdigest()
            != profile["lock_outside_sha256"]
        or hashlib.sha256("\n".join(cleanup_outside).encode()).hexdigest()
            != profile["cleanup_outside_sha256"]
    ):
        fail(f"{label} normalized failure or cleanup log differs")
    protected = [
        index for index, line in enumerate(lock_source)
        if line.strip() == profile["protected_read"]
    ]
    workflow_read = [
        index for index, line in enumerate(lock_source)
        if "repos/$REPO/actions/workflows/oci-live-data-rollout.yml" in line
    ]
    nested_reader = [
        index for index, line in enumerate(lock_source)
        if line.strip().startswith(
            "./infra/oci/scripts/upstream_run_binding_stan.py validate-all"
        )
    ]
    transfer = [
        index for index, line in enumerate(lock_source)
        if line.strip() == "record_transfer release unconfirmed"
    ]
    if (
        len(protected) != 1 or len(workflow_read) != 1
        or len(nested_reader) != 1 or len(transfer) != 1
        or not protected[0] < workflow_read[0] < nested_reader[0] < transfer[0]
        or lock_outside.count(profile["denial"]) != 1
        or "##[error]Process completed with exit code 1." not in lock_outside
        or lock_outside.index("##[error]Process completed with exit code 1.")
            != lock_outside.index(profile["denial"]) + 1
        or cleanup_outside.count("k3s_access_cleanup=PASS") != 1
        or cleanup_outside[-1] != "k3s_access_cleanup=PASS"
        or any("unresolved" in line.lower() for line in cleanup_outside)
    ):
        fail(f"{label} protected REST denial or temporary access cleanup differs")
    entire_outside, depth = [], 0
    for line in job_log.splitlines():
        match = re.fullmatch(r"\d{4}-\d\d-\d\dT\S+Z (.*)", line)
        value = re.sub(r"\x1b\[[0-9;]*m", "", match[1] if match else line)
        if value.startswith("##[group]"):
            depth += 1
        elif value == "##[endgroup]":
            if depth < 1:
                fail(f"{label} complete native log grouping is inconsistent")
            depth -= 1
        elif depth == 0:
            entire_outside.append(value)
    if depth:
        fail(f"{label} complete native log grouping is incomplete")
    forbidden = (
        r"shared_mongo_lock=(?:acquire|acquire-released|release|renew) .*status=PASS",
        r"retained_lock_transfer=",
        r"live_data_maintenance=(?:enter|hold|restore) .*status=PASS",
        r"record_transfer",
        r"live_data_rollout=(?:apply|mutate|deploy|rehold)",
    )
    if any(
        re.search(pattern, line)
        for pattern in forbidden for line in entire_outside
    ):
        fail(f"{label} native log contains a persistent domain transition")
    artifacts = artifacts_from_pages(observation.get("artifactPages"), label)
    if len(artifacts) != 2:
        fail(f"{label} exact artifact inventory differs")
    artifact_proofs = {}
    expected_artifacts = {item[0]: item for item in profile["artifacts"]}
    for artifact in artifacts:
        artifact_id = artifact.get("id")
        if artifact_id not in expected_artifacts:
            fail(f"{label} contains an unexpected artifact")
        (
            _, node_id, name, size, digest, created_at, updated_at, expires_at,
        ) = expected_artifacts[artifact_id]
        owner = artifact.get("workflow_run")
        if (
            artifact.get("node_id") != node_id
            or artifact.get("name") != name
            or artifact.get("size_in_bytes") != size
            or artifact.get("digest") != f"sha256:{digest}"
            or artifact.get("expired") is not False
            or artifact.get("created_at") != created_at
            or artifact.get("updated_at") != updated_at
            or artifact.get("expires_at") != expires_at
            or parse_timestamp(expires_at, label).timestamp() <= time.time()
            or not isinstance(owner, dict)
            or owner.get("id") != profile["run_id"]
            or owner.get("repository_id") != profile["repository_id"]
            or owner.get("head_repository_id") != profile["repository_id"]
            or owner.get("head_branch") != "master"
            or owner.get("head_sha") != profile["control"]
        ):
            fail(f"{label} artifact metadata is unowned, expired, or substituted")
        raw = observation.get("archives", {}).get(str(artifact_id))
        if not isinstance(raw, bytes) or hashlib.sha256(raw).hexdigest() != digest:
            fail(f"{label} exact artifact archive digest differs")
        files = zip_files(raw, label, require_original_names=True)
        artifact_proofs[name] = _failed_held_artifact_proof(
            files,
            profile["baseline_members"] if name.startswith(
                "oci-live-data-baselines-"
            ) else profile["rollout_members"],
            historical_ordered, held, profile, semantic, label,
            baseline=name.startswith("oci-live-data-baselines-"),
        )
    return {
        "profile": profile["name"],
        "currentReader": current_reader,
        "run": latest,
        "workflow": {
            key: workflow.get(key)
            for key in ("id", "node_id", "name", "path", "state")
        },
        "job": {
            **expected_job,
            "steps": list(profile["steps"]),
        },
        "approval": projected_review,
        "tree": profile["tree"],
        "closure": profile["closure"],
        "actions": list(profile["actions"]),
        "policySha256": policy_digest,
        "historicalInputHash": normalized[0]["inputHash"],
        "freshInputHash": normalized[1]["inputHash"],
        "lineageSha256": lineage_digest,
        "logMembers": log_members,
        "artifactProofs": artifact_proofs,
    }


def validate_failed_held_continuation_history(
    repository, row, held, subject_sha, dispatch_inputs, cutoff, active_inventory,
    semantic,
):
    profile = _failed_held_continuation_profile()
    if row.get("id") != profile["run_id"]:
        fail(f"{profile['name']} cannot classify another run")
    current_reader_sha = _CURRENT_READER_SHA_CONTEXT.get()
    if current_reader_sha is None:
        current_reader_sha = subject_sha
    validate_descendant_scope(profile["control"], subject_sha)
    if current_reader_sha != subject_sha:
        validate_descendant_scope(profile["control"], current_reader_sha)
    proofs = []
    for _ in range(2):
        current_reader = _failed_held_current_reader(
            repository, current_reader_sha, profile,
        )
        observation = _collect_failed_held_continuation_observation(
            repository, profile,
        )
        proofs.append(_validate_failed_held_continuation_observation(
            repository, row, held, subject_sha, dispatch_inputs, cutoff,
            active_inventory, profile, current_reader, observation, semantic,
        ))
    canonical = [
        json.dumps(
            proof, ensure_ascii=True, sort_keys=True, separators=(",", ":"),
        )
        for proof in proofs
    ]
    if canonical[0] != canonical[1]:
        fail(f"{profile['name']} native proof changed between complete collections")


def _failed_clean_reader_continuation_profile():
    closure = dict(FAILED_CLEAN_READER_CONTINUATION_CLOSURE)
    return {
        "name": FAILED_CLEAN_READER_CONTINUATION_PROFILE,
        "repository": "vasilyevstan/betstan",
        "repository_id": FAILED_CLEAN_READER_CONTINUATION_REPOSITORY_ID,
        "repository_node_id":
            FAILED_CLEAN_READER_CONTINUATION_REPOSITORY_NODE_ID,
        "run_id": FAILED_CLEAN_READER_CONTINUATION_RUN_ID,
        "held_run_id": FAILED_CLEAN_READER_CONTINUATION_HELD_RUN_ID,
        "held_source": FAILED_CLEAN_READER_CONTINUATION_HELD_SOURCE,
        "control": FAILED_CLEAN_READER_CONTINUATION_CONTROL,
        "tree": FAILED_CLEAN_READER_CONTINUATION_TREE,
        "workflow_id": FAILED_CLEAN_READER_CONTINUATION_WORKFLOW_ID,
        "workflow_blob": closure[".github/workflows/oci-live-data-rollout.yml"],
        "policy_blob": closure[
            "infra/azure/agents/"
            "copilot-cli-protected-operation-policy-stan.sh"
        ],
        "authority_blob": closure[
            "infra/azure/agents/copilot_cli_authority_stan.py"
        ],
        "validator_blob": closure[
            "infra/oci/scripts/upstream_run_binding_stan.py"
        ],
        "verifier_blob": closure[
            "infra/oci/scripts/verify-live-betting-data-evidence-stan.sh"
        ],
        "current_verifier_blob":
            FAILED_CLEAN_READER_CONTINUATION_CURRENT_VERIFIER_BLOB,
        "input_names": FAILED_CLEAN_READER_CONTINUATION_INPUT_NAMES,
        "policy_sha256": FAILED_CLEAN_READER_CONTINUATION_POLICY_SHA256,
        "input_sha256": FAILED_CLEAN_READER_CONTINUATION_INPUT_SHA256,
        "lineage_sha256": FAILED_CLEAN_READER_CONTINUATION_LINEAGE_SHA256,
        "actions": FAILED_CLEAN_READER_CONTINUATION_ACTIONS,
        "closure": closure,
        "steps": FAILED_CLEAN_READER_CONTINUATION_STEPS,
        "log_members": dict(FAILED_CLEAN_READER_CONTINUATION_LOG_MEMBERS),
        "failure_lines_sha256":
            FAILED_CLEAN_READER_CONTINUATION_FAILURE_LINES_SHA256,
        "failure_diagnostics_sha256":
            FAILED_CLEAN_READER_CONTINUATION_FAILURE_DIAGNOSTICS_SHA256,
        "upload_diagnostics": {
            name: {
                "lines": lines_digest,
                "no_files": no_files_digest,
            }
            for name, lines_digest, no_files_digest
            in FAILED_CLEAN_READER_CONTINUATION_UPLOAD_DIAGNOSTICS
        },
        "run": {
            "id": FAILED_CLEAN_READER_CONTINUATION_RUN_ID,
            "node_id": "WFR_kwLOLOPcRs8AAAAJG21KBw",
            "workflow_id": FAILED_CLEAN_READER_CONTINUATION_WORKFLOW_ID,
            "run_attempt": 1,
            "path": ".github/workflows/oci-live-data-rollout.yml",
            "event": "workflow_dispatch",
            "display_title": (
                "oci-live-data apply-slip-index "
                + FAILED_CLEAN_READER_CONTINUATION_CONTROL
            ),
            "head_branch": "master",
            "head_sha": FAILED_CLEAN_READER_CONTINUATION_CONTROL,
            "status": "completed",
            "conclusion": "failure",
            "created_at": FAILED_CLEAN_READER_CONTINUATION_CREATED_AT,
            "run_started_at": FAILED_CLEAN_READER_CONTINUATION_CREATED_AT,
            "updated_at": FAILED_CLEAN_READER_CONTINUATION_UPDATED_AT,
            "html_url": (
                "https://github.com/vasilyevstan/betstan/actions/runs/"
                + str(FAILED_CLEAN_READER_CONTINUATION_RUN_ID)
            ),
            "repository": {
                "id": FAILED_CLEAN_READER_CONTINUATION_REPOSITORY_ID,
                "node_id":
                    FAILED_CLEAN_READER_CONTINUATION_REPOSITORY_NODE_ID,
                "full_name": "vasilyevstan/betstan",
            },
            "head_repository": {
                "id": FAILED_CLEAN_READER_CONTINUATION_REPOSITORY_ID,
                "node_id":
                    FAILED_CLEAN_READER_CONTINUATION_REPOSITORY_NODE_ID,
                "full_name": "vasilyevstan/betstan",
            },
        },
        "workflow": {
            "id": FAILED_CLEAN_READER_CONTINUATION_WORKFLOW_ID,
            "node_id": "W_kwDOLOPcRs4UP-0d",
            "name": "oci-live-data-rollout",
            "path": ".github/workflows/oci-live-data-rollout.yml",
            "state": "disabled_manually",
        },
        "job": {
            "id": 117638458356,
            "node_id": "CR_kwDOLOPcRs8AAAAbY8xr9A",
            "run_id": FAILED_CLEAN_READER_CONTINUATION_RUN_ID,
            "run_attempt": 1,
            "head_sha": FAILED_CLEAN_READER_CONTINUATION_CONTROL,
            "head_branch": "master",
            "name": "rollout",
            "status": "completed",
            "conclusion": "failure",
            "created_at": "2026-10-18T09:19:06Z",
            "started_at": "2026-10-18T10:49:36Z",
            "completed_at": "2026-10-18T10:52:21Z",
            "runner_id": 1000033517,
            "runner_name": "GitHub Actions 1000033517",
        },
        "approval": {
            "state": "approved",
            "comment": (
                "Copilot CLI exact-run approval: "
                "oci-live-data-continue-held-handoff"
            ),
            "submitted_at": None,
            "user": {
                "id": 75614529,
                "node_id": "MDQ6VXNlcjc1NjE0NTI5",
                "login": "vasilyevstan",
                "type": "User",
            },
            "environments": [{
                "id": 19134286823,
                "node_id": "EN_kwDOLOPcRs8AAAAEdH4L5w",
                "name": "oci-migration",
            }],
        },
    }


def _failed_clean_reader_current_reader(repository, subject_sha, profile):
    label = f"{profile['name']} current reader"
    if (
        repository != profile["repository"]
        or not isinstance(subject_sha, str)
        or FULL_SHA.fullmatch(subject_sha) is None
        or subject_sha == profile["control"]
    ):
        fail(f"{label} repository or current subject is invalid")
    root = Path(__file__).resolve().parents[3]
    workflow_path = ".github/workflows/oci-live-data-rollout.yml"
    policy_path = (
        "infra/azure/agents/copilot-cli-protected-operation-policy-stan.sh"
    )
    authority_path = "infra/azure/agents/copilot_cli_authority_stan.py"
    validator_path = "infra/oci/scripts/upstream_run_binding_stan.py"
    verifier_path = (
        "infra/oci/scripts/verify-live-betting-data-evidence-stan.sh"
    )
    paths = (
        workflow_path, policy_path, authority_path, validator_path,
        verifier_path,
    )
    head = _failed_held_git(label, "rev-parse", "HEAD").decode().strip()
    status = _failed_held_git(
        label, "status", "--porcelain=v1", "--untracked-files=all",
    )
    tree_sha = _failed_held_git(
        label, "rev-parse", f"{subject_sha}^{{tree}}",
    ).decode().strip()
    local = {
        path: _failed_held_git(
            label, "rev-parse", f"{subject_sha}:{path}",
        ).decode().strip()
        for path in paths
    }
    try:
        validator_raw = (root / validator_path).read_bytes()
        verifier_raw = (root / verifier_path).read_bytes()
    except OSError:
        fail(f"{label} executing source is unavailable")

    def blob_sha(raw):
        return hashlib.sha1(
            f"blob {len(raw)}\0".encode() + raw
        ).hexdigest()

    if (
        Path(__file__).is_symlink() or (root / verifier_path).is_symlink()
        or head != subject_sha or status
        or FULL_SHA.fullmatch(tree_sha) is None
        or local[workflow_path] != profile["workflow_blob"]
        or local[policy_path] != profile["policy_blob"]
        or local[authority_path] != profile["authority_blob"]
        or local[validator_path] != blob_sha(validator_raw)
        or local[verifier_path] != blob_sha(verifier_raw)
        or local[verifier_path] != profile["current_verifier_blob"]
    ):
        fail(f"{label} is not the clean exact current-master source")
    reference = gh_api(f"repos/{repository}/git/ref/heads/master")
    commit = gh_api(f"repos/{repository}/git/commits/{subject_sha}")
    tree = gh_api(f"repos/{repository}/git/trees/{tree_sha}?recursive=1")
    if (
        not isinstance(reference, dict)
        or reference.get("ref") != "refs/heads/master"
        or not isinstance(reference.get("object"), dict)
        or reference["object"].get("type") != "commit"
        or reference["object"].get("sha") != subject_sha
        or not isinstance(commit, dict) or commit.get("sha") != subject_sha
        or not isinstance(commit.get("tree"), dict)
        or commit["tree"].get("sha") != tree_sha
    ):
        fail(f"{label} is no longer exact current master")
    native_blobs = _failed_held_tree_blobs(tree, tree_sha, label)
    if any(native_blobs.get(path) != blob for path, blob in local.items()):
        fail(f"{label} authenticated source tree differs from local execution")
    historical_verifier = held_source_bytes(
        repository, profile["control"], verifier_path, label,
    )
    current_verifier = held_source_bytes(
        repository, subject_sha, verifier_path, label,
    )
    historical_lines = historical_verifier.splitlines(keepends=True)
    markers = [
        index for index, line in enumerate(historical_lines)
        if line == "import sys\n"
    ]
    if len(markers) != 1:
        fail(f"{label} historical verifier import is ambiguous")
    expected_verifier = "".join(
        historical_lines[:markers[0] + 1]
        + ["sys.dont_write_bytecode = True\n"]
        + historical_lines[markers[0] + 1:]
    )
    if current_verifier != expected_verifier:
        fail(f"{label} verifier is not the reviewed bytecode-safe correction")
    return {
        "control": subject_sha,
        "tree": tree_sha,
        "workflowBlob": local[workflow_path],
        "policyBlob": local[policy_path],
        "authorityBlob": local[authority_path],
        "validatorBlob": local[validator_path],
        "verifierBlob": local[verifier_path],
    }


def _collect_failed_clean_reader_continuation_observation(
    repository, profile,
):
    run_id = str(profile["run_id"])
    endpoint = f"repos/{repository}/actions/runs/{run_id}"
    return {
        "run": gh_api(endpoint),
        "attempt": gh_api(endpoint + "/attempts/1"),
        "workflow": gh_api(
            f"repos/{repository}/actions/workflows/{profile['workflow_id']}"
        ),
        "jobPages": gh_api_pages(
            endpoint + "/attempts/1/jobs?per_page=100"
        ),
        "pending": gh_api(
            endpoint + "/pending_deployments?per_page=100"
        ),
        "approvals": gh_api(endpoint + "/approvals?per_page=100"),
        "artifactPages": gh_api_pages(endpoint + "/artifacts?per_page=100"),
        "commit": gh_api(
            f"repos/{repository}/git/commits/{profile['control']}"
        ),
        "tree": gh_api(
            f"repos/{repository}/git/trees/{profile['tree']}?recursive=1"
        ),
        "attemptLog": gh_api_bytes(endpoint + "/attempts/1/logs"),
    }


def _failed_clean_reader_native_inputs(job, log_files, profile, label):
    steps = [
        step for step in job.get("steps", [])
        if step.get("name")
        == "Validate exact SHA phase and trusted upstream runs"
    ]
    if len(steps) != 1 or steps[0].get("conclusion") != "failure":
        fail(f"{label} native failed input step differs")
    matches = [
        raw for name, raw in log_files.items()
        if re.fullmatch(r"-?[0-9]+_rollout\.txt", name)
    ]
    if len(matches) != 1:
        fail(f"{label} native full-job log is absent or ambiguous")
    try:
        job_log = matches[0].decode("utf-8")
    except UnicodeDecodeError:
        fail(f"{label} native log encoding is invalid")
    lines = native_step_log_lines(job_log, steps[0], label)
    blocks = []
    current = None
    in_step_group = False
    for line in lines:
        line = re.sub(r"\x1b\[[0-9;]*m", "", line)
        if line.startswith("##[group]"):
            if current is not None:
                fail(f"{label} native environment group is incomplete")
            in_step_group = line == "##[group]Run set -euo pipefail"
        elif line == "##[endgroup]":
            if in_step_group and current is not None:
                blocks.append("\n".join(current))
                current = None
            in_step_group = False
        elif in_step_group and line in {"env:", "  env:"}:
            if current is not None:
                fail(f"{label} native environment is ambiguous")
            current = []
        elif in_step_group and current is not None:
            current.append(line)
    if len(blocks) != 1 or current is not None:
        fail(f"{label} native failed-step environment is absent or ambiguous")
    text = blocks[0]
    matches = list(re.finditer(r"(?m)^  DISPATCH_INPUTS: ", text))
    if len(matches) != 1:
        fail(f"{label} native dispatch inputs are absent or duplicated")

    def unique_pairs(pairs):
        values = {}
        for key, value in pairs:
            if key in values:
                fail(f"{label} native dispatch input is duplicated")
            values[key] = value
        return values

    try:
        inputs, _ = json.JSONDecoder(
            object_pairs_hook=unique_pairs,
        ).raw_decode(text[matches[0].end():])
    except (ValueError, TypeError):
        fail(f"{label} native dispatch input is malformed")
    inputs = live_data_native_inputs(inputs, profile["input_names"])
    mapping = {
        "approved_sha": "SOURCE_SHA",
        "resume_source_sha": "RESUME_SOURCE_SHA",
        "build_run_id": "BUILD_RUN_ID",
        "infrastructure_run_id": "INFRASTRUCTURE_RUN_ID",
        "checkpoint_source_sha": "CHECKPOINT_SOURCE_SHA",
        "disk_checkpoint_run_id": "DISK_CHECKPOINT_RUN_ID",
        "phase": "PHASE",
        "prerequisite_run_id": "PREREQUISITE_RUN_ID",
        "baseline_recovery_run_id": "BASELINE_RECOVERY_RUN_ID",
        "baseline_recovery_source_sha": "BASELINE_RECOVERY_SOURCE_SHA",
        "failed_deploy_run_id": "FAILED_DEPLOY_RUN_ID",
        "failed_activation_run_id": "FAILED_ACTIVATION_RUN_ID",
        "failed_activation_user_id": "FAILED_ACTIVATION_USER_ID",
        "confirmation": "CONFIRMATION",
        "held_handoff_run_id": "HELD_HANDOFF_RUN_ID",
        "held_handoff_source_sha": "HELD_HANDOFF_SOURCE_SHA",
    }
    if set(inputs) != set(mapping):
        fail(f"{label} native dispatch input key set is invalid")
    for key, env_key in mapping.items():
        values = re.findall(rf"(?m)^  {env_key}: ([^\r\n]*)$", text)
        if len(values) != 1 or values[0] != inputs[key]:
            fail(f"{label} native environment disagrees with {key}")
    return inputs, job_log, lines


def _validate_failed_clean_reader_continuation_observation(
    repository, row, held, subject_sha, dispatch_inputs, cutoff,
    active_inventory, profile, current_reader, observation,
):
    label = profile["name"]
    current_reader_sha = _CURRENT_READER_SHA_CONTEXT.get()
    if current_reader_sha is None:
        current_reader_sha = subject_sha
    observation_keys = {
        "run", "attempt", "workflow", "jobPages", "pending", "approvals",
        "artifactPages", "commit", "tree", "attemptLog",
    }
    if (
        history_worker_context() is not None
        or repository != profile["repository"]
        or type(row.get("id")) is not int
        or row["id"] != profile["run_id"]
        or type(held.get("id")) is not int
        or held["id"] != profile["held_run_id"]
        or held.get("head_sha") != profile["held_source"]
        or type(active_inventory) is not bool
        or not isinstance(dispatch_inputs, dict)
        or not isinstance(observation, dict)
        or set(observation) != observation_keys
        or not isinstance(observation["jobPages"], list)
        or not isinstance(observation["artifactPages"], list)
        or not isinstance(observation["attemptLog"], bytes)
        or not 0 < len(observation["attemptLog"]) <= MAX_ARTIFACT_ARCHIVE_BYTES
    ):
        fail(f"{label} exact run, outer owner, or proof context differs")
    if (
        not isinstance(current_reader, dict)
        or set(current_reader) != {
            "control", "tree", "workflowBlob", "policyBlob",
            "authorityBlob", "validatorBlob", "verifierBlob",
        }
        or current_reader["control"] != current_reader_sha
        or not isinstance(current_reader["tree"], str)
        or FULL_SHA.fullmatch(current_reader["tree"]) is None
        or current_reader["workflowBlob"] != profile["workflow_blob"]
        or current_reader["policyBlob"] != profile["policy_blob"]
        or current_reader["authorityBlob"] != profile["authority_blob"]
        or not isinstance(current_reader["validatorBlob"], str)
        or FULL_SHA.fullmatch(current_reader["validatorBlob"]) is None
        or current_reader["verifierBlob"]
            != profile["current_verifier_blob"]
    ):
        fail(f"{label} current exact-reader proof differs")
    latest = _failed_held_project_run(observation.get("run"))
    first = _failed_held_project_run(observation.get("attempt"))
    if latest != profile["run"] or first != profile["run"]:
        fail(f"{label} is not the exact terminal first attempt")
    row_keys = (
        "id", "workflow_id", "path", "head_sha", "head_branch", "event",
        "run_attempt", "status", "conclusion", "display_title",
        "created_at", "run_started_at", "updated_at", "html_url",
    )
    if (
        any(
            key not in row or type(row[key]) is not type(profile["run"][key])
            or row[key] != profile["run"][key]
            for key in row_keys
        )
        or not isinstance(row.get("head_repository"), dict)
        or row["head_repository"].get("id") != profile["repository_id"]
        or row["head_repository"].get("node_id")
            != profile["repository_node_id"]
        or row["head_repository"].get("full_name") != repository
    ):
        fail(f"{label} complete history row differs from native identity")
    if (
        parse_timestamp(held.get("updated_at"), label)
        >= parse_timestamp(profile["run"]["created_at"], label)
        or cutoff is not None
        and parse_timestamp(profile["run"]["updated_at"], label) >= cutoff
    ):
        fail(f"{label} held-owner or successor chronology differs")
    workflow = observation.get("workflow")
    projected_workflow = {
        key: workflow.get(key)
        for key in ("id", "node_id", "name", "path", "state")
    } if isinstance(workflow, dict) else None
    if (
        projected_workflow is None
        or any(
            type(projected_workflow[key])
            is not type(profile["workflow"][key])
            or projected_workflow[key] != profile["workflow"][key]
            for key in ("id", "node_id", "name", "path")
        )
        or type(projected_workflow["state"]) is not str
        or projected_workflow["state"] not in ("active", "disabled_manually")
    ):
        fail(f"{label} workflow identity is invalid")
    jobs = jobs_from_pages(observation.get("jobPages"), label)
    if len(jobs) != 1:
        fail(f"{label} must have exactly one rollout job")
    job = exact_job(jobs, "rollout", label)
    if any(job.get(key) != value for key, value in profile["job"].items()):
        fail(f"{label} rollout job identity or terminal state differs")
    observed_steps = tuple(
        (
            step.get("number"), step.get("name"), step.get("conclusion"),
            step.get("started_at"), step.get("completed_at"),
        )
        for step in job["steps"]
    )
    if (
        observed_steps != profile["steps"]
        or any(step.get("status") != "completed" for step in job["steps"])
    ):
        fail(f"{label} exact ordered step outcomes differ")
    created = parse_timestamp(profile["run"]["created_at"], label)
    started = parse_timestamp(profile["job"]["started_at"], label)
    completed = parse_timestamp(profile["job"]["completed_at"], label)
    updated = parse_timestamp(profile["run"]["updated_at"], label)
    previous = started
    if not (
        created
        <= parse_timestamp(profile["job"]["created_at"], label)
        <= started <= completed <= updated
    ):
        fail(f"{label} job chronology differs")
    for step in job["steps"]:
        began = parse_timestamp(step["started_at"], label)
        ended = parse_timestamp(step["completed_at"], label)
        if not previous <= began <= ended <= completed:
            fail(f"{label} ordered step chronology differs")
        previous = ended
    if observation.get("pending") != []:
        fail(f"{label} retains a pending environment gate")
    approvals = observation.get("approvals")
    if not isinstance(approvals, list) or len(approvals) != 1:
        fail(f"{label} exact approval receipt is incomplete or extended")
    review = approvals[0]
    projected_review = {
        key: review.get(key)
        for key in ("state", "comment", "submitted_at")
    } | {
        "user": {
            key: (review.get("user") or {}).get(key)
            for key in ("id", "node_id", "login", "type")
        },
        "environments": [
            {
                key: environment.get(key)
                for key in ("id", "node_id", "name")
            }
            for environment in review.get("environments", [])
            if isinstance(environment, dict)
        ] if isinstance(review.get("environments"), list) else None,
    }
    if projected_review != profile["approval"]:
        fail(f"{label} exact approval receipt differs")
    if artifacts_from_pages(observation.get("artifactPages"), label) != []:
        fail(f"{label} exact native artifact inventory is not empty")
    commit = observation.get("commit")
    if (
        not isinstance(commit, dict) or commit.get("sha") != profile["control"]
        or not isinstance(commit.get("tree"), dict)
        or commit["tree"].get("sha") != profile["tree"]
    ):
        fail(f"{label} historical control or tree differs")
    blobs = _failed_held_tree_blobs(
        observation.get("tree"), profile["tree"], label,
    )
    if any(blobs.get(path) != blob for path, blob in profile["closure"].items()):
        fail(f"{label} authenticated semantic source closure differs")
    for path, blob in profile["closure"].items():
        local = _failed_held_git(
            label, "rev-parse", f"{profile['control']}:{path}",
        ).decode().strip()
        if local != blob:
            fail(f"{label} local historical semantic source closure differs")
    workflow_source = held_source_bytes(
        repository, profile["control"],
        ".github/workflows/oci-live-data-rollout.yml", label,
    )
    actions = tuple(sorted(set(re.findall(
        r"(?m)^[ \t]+uses: ([^\s#]+)", workflow_source,
    ))))
    if actions != tuple(sorted(profile["actions"])):
        fail(f"{label} historical immutable action pins differ")
    policy_source = held_source_bytes(
        repository, profile["control"],
        "infra/azure/agents/copilot-cli-protected-operation-policy-stan.sh",
        label,
    )
    try:
        policy_result = subprocess.run(
            ["bash", "-s", "--", "get",
             "oci-live-data-continue-held-handoff"],
            input=policy_source, capture_output=True, text=True,
            check=False, timeout=15,
        )
    except (OSError, subprocess.TimeoutExpired):
        fail(f"{label} historical operation policy is unavailable")
    try:
        policy = json.loads(policy_result.stdout)
    except (ValueError, UnicodeError):
        fail(f"{label} historical operation policy is malformed")
    policy_digest = hashlib.sha256(json.dumps(
        policy, ensure_ascii=True, sort_keys=True, separators=(",", ":"),
    ).encode()).hexdigest()
    if (
        policy_result.returncode
        or policy_digest != profile["policy_sha256"]
        or tuple(policy.get("inputNames", ())) != profile["input_names"]
        or policy.get("operation")
            != "oci-live-data-continue-held-handoff"
        or policy.get("environment") != "oci-migration"
        or policy.get("event") != "workflow_dispatch"
        or policy.get("approvalWorkflowState") != "disabled_manually"
        or policy.get("subjectInput") != "approved_sha"
        or policy.get("subjectRelation") != "current"
        or policy.get("targetInput") is not None
        or policy.get("targetRelation") != "none"
    ):
        fail(f"{label} historical operation policy differs")
    log_files = zip_files(
        observation.get("attemptLog"), label, require_original_names=True,
    )
    log_members = {
        path: hashlib.sha256(raw).hexdigest()
        for path, raw in log_files.items()
    }
    if log_members != profile["log_members"]:
        fail(f"{label} bounded first-attempt log inventory differs")
    historical, job_log, failure_lines = (
        _failed_clean_reader_native_inputs(
            job, log_files, profile, label,
        )
    )
    authority = provenance_read_authority()
    fresh = live_data_native_inputs(
        dispatch_inputs, profile["input_names"],
    )
    historical_ordered = {
        name: historical[name] for name in profile["input_names"]
    }
    fresh_ordered = {
        name: fresh[name] for name in profile["input_names"]
    }
    if (
        historical_ordered["approved_sha"] != profile["control"]
        or fresh_ordered["approved_sha"] != subject_sha
        or {
            name for name in profile["input_names"]
            if historical_ordered[name] != fresh_ordered[name]
        } != {"approved_sha"}
        or fresh_ordered["held_handoff_run_id"]
            != str(profile["held_run_id"])
        or fresh_ordered["held_handoff_source_sha"]
            != profile["held_source"]
        or historical_ordered["phase"] != "apply-slip-index"
        or fresh_ordered["phase"] != "apply-slip-index"
    ):
        fail(f"{label} historical and fresh requests do not share one lineage")
    normalized = []
    for control, inputs in (
        (profile["control"], historical_ordered),
        (subject_sha, fresh_ordered),
    ):
        request = {
            "schemaVersion": authority.REQUEST_SCHEMA,
            "repository": repository,
            "operation": "oci-live-data-continue-held-handoff",
            "controlSha": control,
            "subjectSha": control,
            "targetSha": None,
            "inputs": inputs,
        }
        try:
            value = authority.validate_request_data(
                request, policy, repository, control,
            )
        except (AttributeError, KeyError, TypeError, ValueError):
            fail(f"{label} shared policy/input/hash validation is incompatible")
        if (
            value.get("dispatchInputs") != inputs
            or value.get("inputHash")
                != authority.canonical_input_hash(inputs)
        ):
            fail(f"{label} shared policy/input/hash validation differs")
        normalized.append(value)
    if normalized[0]["inputHash"] != profile["input_sha256"]:
        fail(f"{label} historical canonical transport input hash differs")
    lineage = [
        [
            name,
            "{subject_sha}"
            if name == "approved_sha" else historical_ordered[name],
        ]
        for name in profile["input_names"]
    ]
    lineage_digest = hashlib.sha256(json.dumps(
        lineage, ensure_ascii=True, separators=(",", ":"),
    ).encode()).hexdigest()
    if lineage_digest != profile["lineage_sha256"]:
        fail(f"{label} canonical continuation lineage digest differs")
    if (
        hashlib.sha256("\n".join(failure_lines).encode()).hexdigest()
        != profile["failure_lines_sha256"]
    ):
        fail(f"{label} normalized clean-reader failure log differs")
    failure_diagnostics = [
        line for line in failure_lines
        if "upstream binding rejected:" in line
    ]
    if (
        len(failure_diagnostics) != 2
        or any(
            "clean exact current-master source" not in line
            for line in failure_diagnostics
        )
        or failure_lines.count(
            "##[error]Process completed with exit code 1."
        ) != 1
        or hashlib.sha256(
            "\n".join(failure_diagnostics).encode()
        ).hexdigest() != profile["failure_diagnostics_sha256"]
    ):
        fail(f"{label} exact clean-reader rejection differs")
    upload_proofs = {}
    for name, expected in profile["upload_diagnostics"].items():
        matches = [step for step in job["steps"] if step.get("name") == name]
        if len(matches) != 1 or matches[0].get("conclusion") != "success":
            fail(f"{label} always-run upload outcome differs")
        lines = native_step_log_lines(job_log, matches[0], label)
        no_files = [
            line for line in lines
            if "No files were found with the provided path" in line
        ]
        proof = {
            "lines": hashlib.sha256("\n".join(lines).encode()).hexdigest(),
            "no_files": hashlib.sha256(
                "\n".join(no_files).encode()
            ).hexdigest(),
        }
        if len(no_files) != 2 or proof != expected:
            fail(f"{label} zero-artifact upload diagnostic differs")
        upload_proofs[name] = proof
    entire_outside = []
    depth = 0
    for line in job_log.splitlines():
        match = re.fullmatch(r"\d{4}-\d\d-\d\dT\S+Z (.*)", line)
        value = re.sub(
            r"\x1b\[[0-9;]*m", "", match[1] if match else line,
        )
        if value.startswith("##[group]"):
            depth += 1
        elif value == "##[endgroup]":
            if depth < 1:
                fail(f"{label} complete native log grouping is inconsistent")
            depth -= 1
        elif depth == 0:
            entire_outside.append(value)
    if depth:
        fail(f"{label} complete native log grouping is incomplete")
    forbidden = (
        r"shared_mongo_lock=(?:acquire|acquire-released|release|renew) "
        r".*status=PASS",
        r"retained_lock_transfer=",
        r"live_data_maintenance=(?:enter|hold|restore) .*status=PASS",
        r"record_transfer",
        r"live_data_rollout=(?:apply|mutate|deploy|rehold)",
        r"partial[-_ ]recovery[-_ ]authority",
        r"cleanup[-_ ]authority",
        r"k3s_access_cleanup=PASS",
        r"oci_runner_(?:authorize|revoke)=PASS",
    )
    if any(
        re.search(pattern, line, re.IGNORECASE)
        for pattern in forbidden for line in entire_outside
    ):
        fail(f"{label} native log contains a production-domain transition")
    return {
        "profile": profile["name"],
        "currentReader": current_reader,
        "run": latest,
        "workflow": projected_workflow,
        "job": {
            **profile["job"],
            "steps": list(profile["steps"]),
        },
        "approval": projected_review,
        "tree": profile["tree"],
        "closure": profile["closure"],
        "actions": list(profile["actions"]),
        "policySha256": policy_digest,
        "historicalInputHash": normalized[0]["inputHash"],
        "freshInputHash": normalized[1]["inputHash"],
        "lineageSha256": lineage_digest,
        "logMembers": log_members,
        "artifactCount": 0,
        "uploadProofs": upload_proofs,
    }


def validate_failed_clean_reader_continuation_history(
    repository, row, held, subject_sha, dispatch_inputs, cutoff,
    active_inventory,
):
    profile = _failed_clean_reader_continuation_profile()
    if row.get("id") != profile["run_id"]:
        fail(f"{profile['name']} cannot classify another run")
    current_reader_sha = _CURRENT_READER_SHA_CONTEXT.get()
    if current_reader_sha is None:
        current_reader_sha = subject_sha
    validate_descendant_scope(profile["control"], subject_sha)
    if current_reader_sha != subject_sha:
        validate_descendant_scope(profile["control"], current_reader_sha)
    proofs = []
    for _ in range(2):
        current_reader = _failed_clean_reader_current_reader(
            repository, current_reader_sha, profile,
        )
        observation = (
            _collect_failed_clean_reader_continuation_observation(
                repository, profile,
            )
        )
        proofs.append(
            _validate_failed_clean_reader_continuation_observation(
                repository, row, held, subject_sha, dispatch_inputs,
                cutoff, active_inventory, profile, current_reader,
                observation,
            )
        )
    canonical = [
        json.dumps(
            proof, ensure_ascii=True, sort_keys=True, separators=(",", ":"),
        )
        for proof in proofs
    ]
    if canonical[0] != canonical[1]:
        fail(f"{profile['name']} native proof changed between complete collections")


def _failed_pre_cas_continuation_profile():
    closure = dict(FAILED_PRE_CAS_CONTINUATION_CLOSURE)
    inventories = tuple(FAILED_PRE_CAS_CONTINUATION_TRANSITIVE_ARTIFACTS)
    artifacts = dict(inventories)[FAILED_PRE_CAS_CONTINUATION_RUN_ID]
    return {
        "name": FAILED_PRE_CAS_CONTINUATION_PROFILE,
        "repository": "vasilyevstan/betstan",
        "repository_id": FAILED_PRE_CAS_CONTINUATION_REPOSITORY_ID,
        "repository_node_id": FAILED_PRE_CAS_CONTINUATION_REPOSITORY_NODE_ID,
        "run_id": FAILED_PRE_CAS_CONTINUATION_RUN_ID,
        "held_run_id": FAILED_PRE_CAS_CONTINUATION_HELD_RUN_ID,
        "held_source": FAILED_PRE_CAS_CONTINUATION_HELD_SOURCE,
        "control": FAILED_PRE_CAS_CONTINUATION_CONTROL,
        "tree": FAILED_PRE_CAS_CONTINUATION_TREE,
        "workflow_id": FAILED_PRE_CAS_CONTINUATION_WORKFLOW_ID,
        "workflow_blob": closure[".github/workflows/oci-live-data-rollout.yml"],
        "policy_blob": closure[
            "infra/azure/agents/"
            "copilot-cli-protected-operation-policy-stan.sh"
        ],
        "authority_blob": closure[
            "infra/azure/agents/copilot_cli_authority_stan.py"
        ],
        "validator_blob": closure[
            "infra/oci/scripts/upstream_run_binding_stan.py"
        ],
        "verifier_blob": closure[
            "infra/oci/scripts/verify-live-betting-data-evidence-stan.sh"
        ],
        "input_names": FAILED_PRE_CAS_CONTINUATION_INPUT_NAMES,
        "policy_sha256": FAILED_PRE_CAS_CONTINUATION_POLICY_SHA256,
        "input_sha256": FAILED_PRE_CAS_CONTINUATION_INPUT_SHA256,
        "lineage_sha256": FAILED_PRE_CAS_CONTINUATION_LINEAGE_SHA256,
        "actions": FAILED_PRE_CAS_CONTINUATION_ACTIONS,
        "closure": closure,
        "steps": FAILED_PRE_CAS_CONTINUATION_STEPS,
        "artifact_inventories": inventories,
        "artifacts": artifacts,
        "baseline_members":
            dict(FAILED_PRE_CAS_CONTINUATION_BASELINE_MEMBERS),
        "rollout_members":
            dict(FAILED_PRE_CAS_CONTINUATION_ROLLOUT_MEMBERS),
        "log_members": dict(FAILED_PRE_CAS_CONTINUATION_LOG_MEMBERS),
        "lock_source_sha256":
            FAILED_PRE_CAS_CONTINUATION_LOCK_SOURCE_SHA256,
        "lock_outside_sha256":
            FAILED_PRE_CAS_CONTINUATION_LOCK_OUTSIDE_SHA256,
        "bastion_source_sha256":
            FAILED_PRE_CAS_CONTINUATION_BASTION_SOURCE_SHA256,
        "bastion_outside_sha256":
            FAILED_PRE_CAS_CONTINUATION_BASTION_OUTSIDE_SHA256,
        "client_source_sha256":
            FAILED_PRE_CAS_CONTINUATION_CLIENT_SOURCE_SHA256,
        "client_outside_sha256":
            FAILED_PRE_CAS_CONTINUATION_CLIENT_OUTSIDE_SHA256,
        "failure": FAILED_PRE_CAS_CONTINUATION_FAILURE,
        "run": {
            "id": FAILED_PRE_CAS_CONTINUATION_RUN_ID,
            "node_id": "WFR_kwLOLOPcRs8AAAAJIkkUxg",
            "workflow_id": FAILED_PRE_CAS_CONTINUATION_WORKFLOW_ID,
            "run_attempt": 1,
            "path": ".github/workflows/oci-live-data-rollout.yml",
            "event": "workflow_dispatch",
            "display_title": (
                "oci-live-data apply-slip-index "
                + FAILED_PRE_CAS_CONTINUATION_CONTROL
            ),
            "head_branch": "master",
            "head_sha": FAILED_PRE_CAS_CONTINUATION_CONTROL,
            "status": "completed",
            "conclusion": "failure",
            "created_at": FAILED_PRE_CAS_CONTINUATION_CREATED_AT,
            "run_started_at": FAILED_PRE_CAS_CONTINUATION_CREATED_AT,
            "updated_at": FAILED_PRE_CAS_CONTINUATION_UPDATED_AT,
            "html_url": (
                "https://github.com/vasilyevstan/betstan/actions/runs/"
                + str(FAILED_PRE_CAS_CONTINUATION_RUN_ID)
            ),
            "repository": {
                "id": FAILED_PRE_CAS_CONTINUATION_REPOSITORY_ID,
                "node_id": FAILED_PRE_CAS_CONTINUATION_REPOSITORY_NODE_ID,
                "full_name": "vasilyevstan/betstan",
            },
            "head_repository": {
                "id": FAILED_PRE_CAS_CONTINUATION_REPOSITORY_ID,
                "node_id": FAILED_PRE_CAS_CONTINUATION_REPOSITORY_NODE_ID,
                "full_name": "vasilyevstan/betstan",
            },
        },
        "workflow": {
            "id": FAILED_PRE_CAS_CONTINUATION_WORKFLOW_ID,
            "node_id": "W_kwDOLOPcRs4UP-0d",
            "name": "oci-live-data-rollout",
            "path": ".github/workflows/oci-live-data-rollout.yml",
            "state": "disabled_manually",
        },
        "job": {
            "id": 117985134067,
            "node_id": "CR_kwDOLOPcRs8AAAAbeHZF8w",
            "run_id": FAILED_PRE_CAS_CONTINUATION_RUN_ID,
            "run_attempt": 1,
            "head_sha": FAILED_PRE_CAS_CONTINUATION_CONTROL,
            "head_branch": "master",
            "name": "rollout",
            "status": "completed",
            "conclusion": "failure",
            "created_at": "2026-10-19T09:25:17Z",
            "started_at": "2026-10-19T10:30:18Z",
            "completed_at": "2026-10-19T10:47:02Z",
            "runner_id": 1000033742,
            "runner_name": "GitHub Actions 1000033742",
        },
        "approval": {
            "state": "approved",
            "comment": (
                "Copilot CLI exact-run approval: "
                "oci-live-data-continue-held-handoff"
            ),
            "submitted_at": None,
            "user": {
                "id": 75614529,
                "node_id": "MDQ6VXNlcjc1NjE0NTI5",
                "login": "vasilyevstan",
                "type": "User",
            },
            "environments": [{
                "id": 19134286823,
                "node_id": "EN_kwDOLOPcRs8AAAAEdH4L5w",
                "name": "oci-migration",
            }],
        },
    }


def _failed_pre_cas_utc_now():
    return dt.datetime.now(dt.timezone.utc)


def _failed_pre_cas_current_reader(repository, subject_sha, profile):
    label = f"{profile['name']} current reader"
    if (
        repository != profile["repository"]
        or not isinstance(subject_sha, str)
        or FULL_SHA.fullmatch(subject_sha) is None
        or subject_sha == profile["control"]
    ):
        fail(f"{label} repository or current subject is invalid")
    root = Path(__file__).resolve().parents[3]
    workflow_path = ".github/workflows/oci-live-data-rollout.yml"
    policy_path = (
        "infra/azure/agents/copilot-cli-protected-operation-policy-stan.sh"
    )
    authority_path = "infra/azure/agents/copilot_cli_authority_stan.py"
    validator_path = "infra/oci/scripts/upstream_run_binding_stan.py"
    verifier_path = (
        "infra/oci/scripts/verify-live-betting-data-evidence-stan.sh"
    )
    paths = (
        workflow_path, policy_path, authority_path, validator_path,
        verifier_path,
    )
    head = _failed_held_git(label, "rev-parse", "HEAD").decode().strip()
    status = _failed_held_git(
        label, "status", "--porcelain=v1", "--untracked-files=all",
    )
    tree_sha = _failed_held_git(
        label, "rev-parse", f"{subject_sha}^{{tree}}",
    ).decode().strip()
    local = {
        path: _failed_held_git(
            label, "rev-parse", f"{subject_sha}:{path}",
        ).decode().strip()
        for path in paths
    }
    try:
        validator_raw = (root / validator_path).read_bytes()
    except OSError:
        fail(f"{label} executing validator is unavailable")
    validator_blob = hashlib.sha1(
        f"blob {len(validator_raw)}\0".encode() + validator_raw
    ).hexdigest()
    if (
        Path(__file__).is_symlink() or head != subject_sha or status
        or FULL_SHA.fullmatch(tree_sha) is None
        or local[workflow_path] != profile["workflow_blob"]
        or local[policy_path] != profile["policy_blob"]
        or local[authority_path] != profile["authority_blob"]
        or local[verifier_path] != profile["verifier_blob"]
        or local[validator_path] != validator_blob
    ):
        fail(f"{label} is not the clean exact current-master source")
    reference = gh_api(f"repos/{repository}/git/ref/heads/master")
    commit = gh_api(f"repos/{repository}/git/commits/{subject_sha}")
    tree = gh_api(f"repos/{repository}/git/trees/{tree_sha}?recursive=1")
    if (
        not isinstance(reference, dict)
        or reference.get("ref") != "refs/heads/master"
        or not isinstance(reference.get("object"), dict)
        or reference["object"].get("type") != "commit"
        or reference["object"].get("sha") != subject_sha
        or not isinstance(commit, dict) or commit.get("sha") != subject_sha
        or not isinstance(commit.get("tree"), dict)
        or commit["tree"].get("sha") != tree_sha
    ):
        fail(f"{label} is no longer exact current master")
    native_blobs = _failed_held_tree_blobs(tree, tree_sha, label)
    if any(native_blobs.get(path) != blob for path, blob in local.items()):
        fail(f"{label} authenticated source tree differs from local execution")
    return {
        "control": subject_sha,
        "tree": tree_sha,
        "workflowBlob": local[workflow_path],
        "policyBlob": local[policy_path],
        "authorityBlob": local[authority_path],
        "validatorBlob": validator_blob,
        "verifierBlob": local[verifier_path],
    }


def _collect_failed_pre_cas_continuation_observation(
    repository, profile,
):
    run_id = str(profile["run_id"])
    endpoint = f"repos/{repository}/actions/runs/{run_id}"
    inventory_pages = {}
    archives = {}
    all_ids = set()
    for artifact_run, expected in profile["artifact_inventories"]:
        pages = gh_api_pages(
            f"repos/{repository}/actions/runs/{artifact_run}"
            "/artifacts?per_page=100"
        )
        inventory_pages[str(artifact_run)] = pages
        artifacts = artifacts_from_pages(
            pages, f"{profile['name']} artifacts {artifact_run}",
        )
        expected_ids = {item[0] for item in expected}
        observed_ids = [item.get("id") for item in artifacts]
        if (
            len(expected_ids) != len(expected)
            or len(observed_ids) != len(set(observed_ids))
            or set(observed_ids) != expected_ids
            or all_ids & expected_ids
        ):
            fail(
                f"{profile['name']} artifact IDs are absent, duplicated or "
                "assigned to another selected run"
            )
        all_ids.update(expected_ids)
        for artifact_id in sorted(expected_ids):
            archives[str(artifact_id)] = download_api_bytes(
                f"repos/{repository}/actions/artifacts/{artifact_id}/zip"
            )
    return {
        "run": gh_api(endpoint),
        "attempt": gh_api(endpoint + "/attempts/1"),
        "workflow": gh_api(
            f"repos/{repository}/actions/workflows/{profile['workflow_id']}"
        ),
        "jobPages": gh_api_pages(
            endpoint + "/attempts/1/jobs?per_page=100"
        ),
        "pending": gh_api(
            endpoint + "/pending_deployments?per_page=100"
        ),
        "approvals": gh_api(endpoint + "/approvals?per_page=100"),
        "artifactInventories": inventory_pages,
        "commit": gh_api(
            f"repos/{repository}/git/commits/{profile['control']}"
        ),
        "tree": gh_api(
            f"repos/{repository}/git/trees/{profile['tree']}?recursive=1"
        ),
        "attemptLog": download_api_bytes(endpoint + "/attempts/1/logs"),
        "archives": archives,
    }


def _failed_pre_cas_artifact_closure(
    repository, held, profile, observation, historical, semantic, label,
):
    inventories = observation.get("artifactInventories")
    archives = observation.get("archives")
    expected_runs = {
        str(run_id) for run_id, _ in profile["artifact_inventories"]
    }
    expected_ids = {
        item[0]
        for _, artifacts in profile["artifact_inventories"]
        for item in artifacts
    }
    if (
        not isinstance(inventories, dict)
        or set(inventories) != expected_runs
        or not isinstance(archives, dict)
        or set(archives) != {str(artifact_id) for artifact_id in expected_ids}
        or len(expected_ids) != sum(
            len(artifacts)
            for _, artifacts in profile["artifact_inventories"]
        )
    ):
        fail(f"{label} transitive artifact proof context differs")
    deadlines = []
    proofs = []
    files_by_id = {}
    for run_id, expected_artifacts in profile["artifact_inventories"]:
        pages = inventories[str(run_id)]
        if not isinstance(pages, list):
            fail(f"{label} artifact inventory pages are malformed")
        artifacts = artifacts_from_pages(
            pages, f"{label} transitive artifacts {run_id}",
        )
        by_id = {}
        for artifact in artifacts:
            artifact_id = artifact.get("id")
            if (
                type(artifact_id) is not int or artifact_id < 1
                or artifact_id in by_id
            ):
                fail(f"{label} artifact inventory contains a duplicate ID")
            by_id[artifact_id] = artifact
        if set(by_id) != {item[0] for item in expected_artifacts}:
            fail(f"{label} exact transitive artifact list differs")
        selected = []
        for expected in expected_artifacts:
            (
                artifact_id, node_id, name, size, digest,
                created_at, updated_at, expires_at, head_sha,
            ) = expected
            artifact = by_id[artifact_id]
            owner = artifact.get("workflow_run")
            if (
                artifact.get("node_id") != node_id
                or artifact.get("name") != name
                or artifact.get("size_in_bytes") != size
                or artifact.get("digest") != f"sha256:{digest}"
                or artifact.get("expired") is not False
                or artifact.get("created_at") != created_at
                or artifact.get("updated_at") != updated_at
                or artifact.get("expires_at") != expires_at
                or not isinstance(owner, dict)
                or owner.get("id") != run_id
                or owner.get("repository_id") != profile["repository_id"]
                or owner.get("head_repository_id")
                    != profile["repository_id"]
                or owner.get("head_branch") != "master"
                or owner.get("head_sha") != head_sha
            ):
                fail(
                    f"{label} transitive artifact descriptor, ownership or "
                    "retention changed"
                )
            created = parse_timestamp(created_at, label)
            updated = parse_timestamp(updated_at, label)
            expires = parse_timestamp(expires_at, label)
            if not created <= updated < expires:
                fail(f"{label} transitive artifact chronology differs")
            deadlines.append(expires)
            raw = archives.get(str(artifact_id))
            if (
                not isinstance(raw, bytes)
                or hashlib.sha256(raw).hexdigest() != digest
            ):
                fail(f"{label} transitive artifact content differs")
            files = zip_files(raw, label, require_original_names=True)
            files_by_id[artifact_id] = files
            members = {
                path: hashlib.sha256(value).hexdigest()
                for path, value in files.items()
            }
            selected.append({
                "id": artifact_id,
                "name": name,
                "digest": digest,
                "expiresAt": expires_at,
                "members": members,
            })
        proofs.append({
            "runId": run_id,
            "totalCount": len(artifacts),
            "artifacts": selected,
        })
    if not deadlines:
        fail(f"{label} transitive artifact closure has no deadline")
    minimum = min(deadlines)
    now = _failed_pre_cas_utc_now()
    if (
        not isinstance(now, dt.datetime)
        or now.tzinfo is None
        or now.utcoffset() != dt.timedelta(0)
        or not now < minimum
    ):
        fail(f"{label} transitive artifact retention deadline has passed")
    current_proofs = {}
    for expected in profile["artifacts"]:
        artifact_id, _, name, *_ = expected
        files = files_by_id[artifact_id]
        current_proofs[name] = _failed_held_artifact_proof(
            files,
            profile["baseline_members"] if name.startswith(
                "oci-live-data-baselines-"
            ) else profile["rollout_members"],
            historical, held, profile, semantic, label,
            baseline=name.startswith("oci-live-data-baselines-"),
        )
    selected_inventories = dict(profile["artifact_inventories"])
    held_baseline_id = next(
        item[0]
        for item in selected_inventories[profile["held_run_id"]]
        if item[2].startswith("oci-live-data-baselines-")
    )
    current_baseline_id = next(
        item[0]
        for item in selected_inventories[profile["run_id"]]
        if item[2].startswith("oci-live-data-baselines-")
    )
    held_baseline = original_before_baseline(
        files_by_id[held_baseline_id], label,
    )
    current_baseline = original_before_baseline(
        files_by_id[current_baseline_id], label,
    )
    if (
        held_baseline != current_baseline
        or current_baseline != semantic["baselineFiles"]
    ):
        fail(f"{label} pre-CAS rollback baseline differs from the held owner")
    return {
        "deadline": minimum.isoformat().replace("+00:00", "Z"),
        "inventories": proofs,
        "currentArtifacts": current_proofs,
        "baselineIdentitySha256": hashlib.sha256(
            current_baseline["SHA256SUMS"],
        ).hexdigest(),
    }


def _validate_failed_pre_cas_continuation_observation(
    repository, row, held, subject_sha, dispatch_inputs, cutoff,
    active_inventory, profile, current_reader, observation, semantic,
):
    label = profile["name"]
    current_reader_sha = _CURRENT_READER_SHA_CONTEXT.get()
    if current_reader_sha is None:
        current_reader_sha = subject_sha
    observation_keys = {
        "run", "attempt", "workflow", "jobPages", "pending", "approvals",
        "artifactInventories", "commit", "tree", "attemptLog", "archives",
    }
    if (
        history_worker_context() is not None
        or repository != profile["repository"]
        or type(row.get("id")) is not int
        or row["id"] != profile["run_id"]
        or type(held.get("id")) is not int
        or held["id"] != profile["held_run_id"]
        or held.get("head_sha") != profile["held_source"]
        or type(active_inventory) is not bool
        or not isinstance(dispatch_inputs, dict)
        or not isinstance(observation, dict)
        or set(observation) != observation_keys
        or not isinstance(observation["jobPages"], list)
        or not isinstance(observation["attemptLog"], bytes)
        or not 0 < len(observation["attemptLog"])
            <= MAX_ARTIFACT_ARCHIVE_BYTES
    ):
        fail(f"{label} exact run, outer owner, or proof context differs")
    if (
        not isinstance(current_reader, dict)
        or set(current_reader) != {
            "control", "tree", "workflowBlob", "policyBlob",
            "authorityBlob", "validatorBlob", "verifierBlob",
        }
        or current_reader["control"] != current_reader_sha
        or not isinstance(current_reader["tree"], str)
        or FULL_SHA.fullmatch(current_reader["tree"]) is None
        or current_reader["workflowBlob"] != profile["workflow_blob"]
        or current_reader["policyBlob"] != profile["policy_blob"]
        or current_reader["authorityBlob"] != profile["authority_blob"]
        or current_reader["verifierBlob"] != profile["verifier_blob"]
        or not isinstance(current_reader["validatorBlob"], str)
        or FULL_SHA.fullmatch(current_reader["validatorBlob"]) is None
    ):
        fail(f"{label} current exact-reader proof differs")
    latest = _failed_held_project_run(observation.get("run"))
    first = _failed_held_project_run(observation.get("attempt"))
    if latest != profile["run"] or first != profile["run"]:
        fail(f"{label} is not the exact terminal first attempt")
    row_keys = (
        "id", "workflow_id", "path", "head_sha", "head_branch", "event",
        "run_attempt", "status", "conclusion", "display_title",
        "created_at", "run_started_at", "updated_at", "html_url",
    )
    if (
        any(
            key not in row or type(row[key]) is not type(profile["run"][key])
            or row[key] != profile["run"][key]
            for key in row_keys
        )
        or not isinstance(row.get("head_repository"), dict)
        or row["head_repository"].get("id") != profile["repository_id"]
        or row["head_repository"].get("node_id")
            != profile["repository_node_id"]
        or row["head_repository"].get("full_name") != repository
    ):
        fail(f"{label} complete history row differs from native identity")
    if (
        parse_timestamp(held.get("updated_at"), label)
        >= parse_timestamp(profile["run"]["created_at"], label)
        or cutoff is not None
        and parse_timestamp(profile["run"]["updated_at"], label) >= cutoff
    ):
        fail(f"{label} held-owner or successor chronology differs")
    workflow = observation.get("workflow")
    projected_workflow = {
        key: workflow.get(key)
        for key in ("id", "node_id", "name", "path", "state")
    } if isinstance(workflow, dict) else None
    if (
        projected_workflow is None
        or any(
            type(projected_workflow[key])
            is not type(profile["workflow"][key])
            or projected_workflow[key] != profile["workflow"][key]
            for key in ("id", "node_id", "name", "path")
        )
        or type(projected_workflow["state"]) is not str
        or projected_workflow["state"] not in (
            "active", "disabled_manually",
        )
    ):
        fail(f"{label} workflow identity is invalid")
    jobs = jobs_from_pages(observation.get("jobPages"), label)
    if len(jobs) != 1:
        fail(f"{label} must have exactly one rollout job")
    job = exact_job(jobs, "rollout", label)
    if any(job.get(key) != value for key, value in profile["job"].items()):
        fail(f"{label} rollout job identity or terminal state differs")
    observed_steps = tuple(
        (
            step.get("number"), step.get("name"), step.get("conclusion"),
            step.get("started_at"), step.get("completed_at"),
        )
        for step in job["steps"]
    )
    if (
        observed_steps != profile["steps"]
        or any(step.get("status") != "completed" for step in job["steps"])
    ):
        fail(f"{label} exact ordered step outcomes differ")
    created = parse_timestamp(profile["run"]["created_at"], label)
    started = parse_timestamp(profile["job"]["started_at"], label)
    completed = parse_timestamp(profile["job"]["completed_at"], label)
    updated = parse_timestamp(profile["run"]["updated_at"], label)
    previous = started
    if not (
        created <= parse_timestamp(profile["job"]["created_at"], label)
        <= started <= completed <= updated
    ):
        fail(f"{label} job chronology differs")
    for step in job["steps"]:
        began = parse_timestamp(step["started_at"], label)
        ended = parse_timestamp(step["completed_at"], label)
        if not previous <= began <= ended <= completed:
            fail(f"{label} ordered step chronology differs")
        previous = ended
    if observation.get("pending") != []:
        fail(f"{label} retains a pending environment gate")
    approvals = observation.get("approvals")
    if not isinstance(approvals, list) or len(approvals) != 1:
        fail(f"{label} exact approval receipt is incomplete or extended")
    review = approvals[0]
    projected_review = {
        key: review.get(key)
        for key in ("state", "comment", "submitted_at")
    } | {
        "user": {
            key: (review.get("user") or {}).get(key)
            for key in ("id", "node_id", "login", "type")
        },
        "environments": [
            {
                key: environment.get(key)
                for key in ("id", "node_id", "name")
            }
            for environment in review.get("environments", [])
            if isinstance(environment, dict)
        ] if isinstance(review.get("environments"), list) else None,
    }
    if projected_review != profile["approval"]:
        fail(f"{label} exact approval receipt differs")
    commit = observation.get("commit")
    if (
        not isinstance(commit, dict) or commit.get("sha") != profile["control"]
        or not isinstance(commit.get("tree"), dict)
        or commit["tree"].get("sha") != profile["tree"]
    ):
        fail(f"{label} historical control or tree differs")
    blobs = _failed_held_tree_blobs(
        observation.get("tree"), profile["tree"], label,
    )
    if any(blobs.get(path) != blob for path, blob in profile["closure"].items()):
        fail(f"{label} authenticated semantic source closure differs")
    for path, blob in profile["closure"].items():
        local = _failed_held_git(
            label, "rev-parse", f"{profile['control']}:{path}",
        ).decode().strip()
        if local != blob:
            fail(f"{label} local historical semantic source closure differs")
    workflow_source = held_source_bytes(
        repository, profile["control"],
        ".github/workflows/oci-live-data-rollout.yml", label,
    )
    actions = tuple(sorted(set(re.findall(
        r"(?m)^[ \t]+uses: ([^\s#]+)", workflow_source,
    ))))
    if actions != tuple(sorted(profile["actions"])):
        fail(f"{label} historical immutable action pins differ")
    policy_source = held_source_bytes(
        repository, profile["control"],
        "infra/azure/agents/copilot-cli-protected-operation-policy-stan.sh",
        label,
    )
    try:
        policy_result = subprocess.run(
            ["bash", "-s", "--", "get",
             "oci-live-data-continue-held-handoff"],
            input=policy_source, capture_output=True, text=True,
            check=False, timeout=15,
        )
    except (OSError, subprocess.TimeoutExpired):
        fail(f"{label} historical operation policy is unavailable")
    try:
        policy = json.loads(policy_result.stdout)
    except (ValueError, UnicodeError):
        fail(f"{label} historical operation policy is malformed")
    policy_digest = hashlib.sha256(json.dumps(
        policy, ensure_ascii=True, sort_keys=True, separators=(",", ":"),
    ).encode()).hexdigest()
    if (
        policy_result.returncode
        or policy_digest != profile["policy_sha256"]
        or tuple(policy.get("inputNames", ())) != profile["input_names"]
        or policy.get("operation")
            != "oci-live-data-continue-held-handoff"
        or policy.get("environment") != "oci-migration"
        or policy.get("event") != "workflow_dispatch"
        or policy.get("approvalWorkflowState") != "disabled_manually"
        or policy.get("subjectInput") != "approved_sha"
        or policy.get("subjectRelation") != "current"
        or policy.get("targetInput") is not None
        or policy.get("targetRelation") != "none"
    ):
        fail(f"{label} historical operation policy differs")
    log_files = zip_files(
        observation.get("attemptLog"), label, require_original_names=True,
    )
    log_members = {
        path: hashlib.sha256(raw).hexdigest()
        for path, raw in log_files.items()
    }
    if log_members != profile["log_members"]:
        fail(f"{label} bounded first-attempt log inventory differs")
    historical = failed_deploy_native_inputs(
        repository, str(profile["run_id"]), profile["control"], label,
        resume_dispatch=True, native_jobs=jobs, native_log_files=log_files,
    )
    authority = provenance_read_authority()
    fresh = live_data_native_inputs(
        dispatch_inputs, profile["input_names"],
    )
    historical_ordered = {
        name: historical[name] for name in profile["input_names"]
    }
    fresh_ordered = {
        name: fresh[name] for name in profile["input_names"]
    }
    if (
        historical_ordered["approved_sha"] != profile["control"]
        or fresh_ordered["approved_sha"] != subject_sha
        or {
            name for name in profile["input_names"]
            if historical_ordered[name] != fresh_ordered[name]
        } != {"approved_sha"}
        or fresh_ordered["held_handoff_run_id"]
            != str(profile["held_run_id"])
        or fresh_ordered["held_handoff_source_sha"]
            != profile["held_source"]
        or historical_ordered["phase"] != "apply-slip-index"
        or fresh_ordered["phase"] != "apply-slip-index"
    ):
        fail(f"{label} historical and fresh requests do not share one lineage")
    normalized = []
    for control, inputs in (
        (profile["control"], historical_ordered),
        (subject_sha, fresh_ordered),
    ):
        request = {
            "schemaVersion": authority.REQUEST_SCHEMA,
            "repository": repository,
            "operation": "oci-live-data-continue-held-handoff",
            "controlSha": control,
            "subjectSha": control,
            "targetSha": None,
            "inputs": inputs,
        }
        try:
            value = authority.validate_request_data(
                request, policy, repository, control,
            )
        except (AttributeError, KeyError, TypeError, ValueError):
            fail(f"{label} shared policy/input/hash validation is incompatible")
        if (
            value.get("dispatchInputs") != inputs
            or value.get("inputHash")
                != authority.canonical_input_hash(inputs)
        ):
            fail(f"{label} shared policy/input/hash validation differs")
        normalized.append(value)
    if normalized[0]["inputHash"] != profile["input_sha256"]:
        fail(f"{label} historical canonical transport input hash differs")
    lineage = [
        [
            name,
            "{subject_sha}"
            if name == "approved_sha" else historical_ordered[name],
        ]
        for name in profile["input_names"]
    ]
    lineage_digest = hashlib.sha256(json.dumps(
        lineage, ensure_ascii=True, separators=(",", ":"),
    ).encode()).hexdigest()
    if lineage_digest != profile["lineage_sha256"]:
        fail(f"{label} canonical continuation lineage digest differs")
    try:
        job_log = next(
            raw.decode("utf-8")
            for name, raw in log_files.items()
            if re.fullmatch(r"-?[0-9]+_rollout\.txt", name)
        )
    except (StopIteration, UnicodeDecodeError):
        fail(f"{label} rollout log is absent or malformed")
    lock_source, lock_outside = _failed_held_step_lines(
        job_log, job["steps"][23], label,
        "##[group]Run set -euo pipefail",
    )
    bastion_source, bastion_outside = _failed_held_step_lines(
        job_log, job["steps"][36], label,
        "##[group]Run ./infra/oci/scripts/configure-k3s-access.sh cleanup",
    )
    client_source, client_outside = _failed_held_step_lines(
        job_log, job["steps"][37], label,
        '##[group]Run rm -rf "$RUNNER_TEMP/oci-home"',
    )
    if (
        hashlib.sha256("\n".join(lock_source).encode()).hexdigest()
            != profile["lock_source_sha256"]
        or hashlib.sha256("\n".join(lock_outside).encode()).hexdigest()
            != profile["lock_outside_sha256"]
        or hashlib.sha256("\n".join(bastion_source).encode()).hexdigest()
            != profile["bastion_source_sha256"]
        or hashlib.sha256("\n".join(bastion_outside).encode()).hexdigest()
            != profile["bastion_outside_sha256"]
        or hashlib.sha256("\n".join(client_source).encode()).hexdigest()
            != profile["client_source_sha256"]
        or hashlib.sha256("\n".join(client_outside).encode()).hexdigest()
            != profile["client_outside_sha256"]
    ):
        fail(f"{label} normalized failure or cleanup log differs")
    if (
        lock_outside.count(profile["failure"]) != 1
        or "##[error]Process completed with exit code 1."
            not in lock_outside
        or lock_outside.index(
            "##[error]Process completed with exit code 1."
        ) != lock_outside.index(profile["failure"]) + 1
        or bastion_outside.count("k3s_access_cleanup=PASS") != 1
        or bastion_outside[-1] != "k3s_access_cleanup=PASS"
        or any(
            "unresolved" in line.lower()
            for line in (*bastion_outside, *client_outside)
        )
    ):
        fail(f"{label} pre-CAS rejection or temporary access cleanup differs")
    entire_outside = []
    depth = 0
    for line in job_log.splitlines():
        match = re.fullmatch(r"\d{4}-\d\d-\d\dT\S+Z (.*)", line)
        value = re.sub(
            r"\x1b\[[0-9;]*m", "", match[1] if match else line,
        )
        if value.startswith("##[group]"):
            depth += 1
        elif value == "##[endgroup]":
            if depth < 1:
                fail(f"{label} complete native log grouping is inconsistent")
            depth -= 1
        elif depth == 0:
            entire_outside.append(value)
    if depth:
        fail(f"{label} complete native log grouping is incomplete")
    forbidden = (
        r"shared_mongo_lock=(?:acquire|acquire-released|release|renew) "
        r".*status=PASS",
        r"retained_lock_transfer=",
        r"record_transfer",
        r"live_data_maintenance=(?:enter|hold|restore) .*status=PASS",
        r"live_data_rollout=(?:apply|mutate|deploy|rehold)",
        r"live[-_ ]acceptance.*(?:demot|delet|mutat|cleanup).*PASS",
        r"(?:activation|deployment|database|slip).*(?:mutat|commit).*PASS",
    )
    if any(
        re.search(pattern, line, re.IGNORECASE)
        for pattern in forbidden for line in entire_outside
    ):
        fail(f"{label} native log contains a persistent domain transition")
    artifact_proof = _failed_pre_cas_artifact_closure(
        repository, held, profile, observation, historical_ordered,
        semantic, label,
    )
    return {
        "profile": profile["name"],
        "currentReader": current_reader,
        "run": latest,
        "workflow": projected_workflow,
        "job": {
            **profile["job"],
            "steps": list(profile["steps"]),
        },
        "approval": projected_review,
        "tree": profile["tree"],
        "closure": profile["closure"],
        "actions": list(profile["actions"]),
        "policySha256": policy_digest,
        "historicalInputHash": normalized[0]["inputHash"],
        "freshInputHash": normalized[1]["inputHash"],
        "lineageSha256": lineage_digest,
        "logMembers": log_members,
        "artifacts": artifact_proof,
    }


def validate_failed_pre_cas_continuation_history(
    repository, row, held, subject_sha, dispatch_inputs, cutoff,
    active_inventory, semantic,
):
    profile = _failed_pre_cas_continuation_profile()
    if row.get("id") != profile["run_id"]:
        fail(f"{profile['name']} cannot classify another run")
    current_reader_sha = _CURRENT_READER_SHA_CONTEXT.get()
    if current_reader_sha is None:
        current_reader_sha = subject_sha
    validate_descendant_scope(profile["control"], subject_sha)
    if current_reader_sha != subject_sha:
        validate_descendant_scope(profile["control"], current_reader_sha)
    proofs = []
    for _ in range(2):
        current_reader = _failed_pre_cas_current_reader(
            repository, current_reader_sha, profile,
        )
        observation = _collect_failed_pre_cas_continuation_observation(
            repository, profile,
        )
        proofs.append(
            _validate_failed_pre_cas_continuation_observation(
                repository, row, held, subject_sha, dispatch_inputs,
                cutoff, active_inventory, profile, current_reader,
                observation, semantic,
            )
        )
    canonical = [
        json.dumps(
            proof, ensure_ascii=True, sort_keys=True, separators=(",", ":"),
        )
        for proof in proofs
    ]
    if canonical[0] != canonical[1]:
        fail(f"{profile['name']} native proof changed between complete collections")


def held_handoff_history(
    repository, held, subject_sha, successor_run_id="", *, dispatch_inputs=None,
    expired_receiver_run_id="", runtime_mode=None, fresh=False,
    failed_continuation_semantic=None,
):
    native = NATIVE_CONTEXT.get()
    with HistoryProofCollection(
        native.history_proofs if native is not None else None,
    ) as proofs:
        return _held_handoff_history(
            repository, held, subject_sha, successor_run_id,
            dispatch_inputs=dispatch_inputs,
            expired_receiver_run_id=expired_receiver_run_id,
            runtime_mode=runtime_mode, fresh=fresh, proofs=proofs,
            failed_continuation_semantic=failed_continuation_semantic,
        )


def _held_handoff_history(
    repository, held, subject_sha, successor_run_id="", *,
    dispatch_inputs=None, expired_receiver_run_id="", runtime_mode=None,
    fresh=False, proofs, failed_continuation_semantic=None,
):
    authority = None
    expired_receiver = None
    active_inventory = fresh
    if expired_receiver_run_id:
        qualified = expired_handoff_native_inputs(
            repository, expired_receiver_run_id, runtime_mode, "expired-handoff history",
        )
        if qualified is None or qualified[0]["data_run_id"] != str(held["id"]):
            fail("expired-handoff history substituted its authenticated physical owner")
        expired_receiver = qualified[1]
        if (
            expired_receiver["head_sha"] != held["head_sha"]
            or parse_timestamp(held.get("updated_at"), "expired handoff")
                > parse_timestamp(expired_receiver.get("created_at"), "expired receiver")
        ):
            fail("expired-handoff history substituted its receiver or chronology")

    def validate_cancelled_unstarted(row):
        nonlocal authority
        label = f"held-handoff cancelled run {row['id']}"
        path = ".github/workflows/oci-live-data-rollout.yml"
        if (
            row.get("path") != path or row.get("status") != "completed"
            or row.get("conclusion") != "cancelled"
            or type(row.get("workflow_id")) is not int or row["workflow_id"] < 1
            or not isinstance(row.get("head_sha"), str)
            or FULL_SHA.fullmatch(row["head_sha"]) is None
        ):
            fail(f"{label} is not a candidate for native no-execution history")
        initialized = authority is not None
        if authority is None:
            authority = _load_shared_authority(
                "held_handoff_authority",
                f"{label} shared source validator is unavailable",
            )
        proofs.run(
            _validate_cancelled_unstarted_history, repository, copy.deepcopy(row),
            subject_sha, authority, label, path, offload=initialized,
        )

    def validate_provenance_read_failure(row):
        nonlocal authority
        label = f"held-handoff provenance-read run {row['id']}"
        if expired_receiver is None:
            fail(f"{label} does not belong to the qualified expired-handoff recovery")
        if authority is None:
            authority = provenance_read_authority()
        identity = {
            "repository": repository, "runId": row["id"], "workflowId": row.get("workflow_id"),
            "workflow": "oci-live-data-rollout.yml", "event": "workflow_dispatch",
            "controlSha": row.get("head_sha"),
            "displayTitle": f"oci-live-data apply-slip-index {row.get('head_sha')}",
        }
        if (
            type(identity["workflowId"]) is not int or identity["workflowId"] < 1
            or not isinstance(identity["controlSha"], str)
            or FULL_SHA.fullmatch(identity["controlSha"]) is None
        ):
            fail(f"{label} cannot bind its native identity")
        observations = []
        for _ in range(2):
            observation = collect_provenance_read_observation(repository, str(row["id"]))
            native = authority.validate_provenance_read_observation(identity, observation)
            for run in (observation["run"], observation["attempts"][0]["run"]):
                if cutoff is not None and parse_timestamp(
                    run.get("updated_at"), label,
                ) >= cutoff:
                    fail(f"{label} terminalized after the immutable successor cutoff")
            latest = observation["run"]
            for key in (
                "id", "workflow_id", "path", "head_sha", "head_branch", "event",
                "run_attempt", "status", "conclusion", "display_title",
                "created_at", "run_started_at", "updated_at", "html_url",
            ):
                if (
                    key not in row or key not in latest
                    or type(row[key]) is not type(latest[key]) or row[key] != latest[key]
                ):
                    fail(f"{label} native detail differs from the complete history inventory")
            if (
                native["prerequisite_run_id"] != str(held["id"])
                or native["resume_source_sha"] != held["head_sha"]
                or native["failed_deploy_run_id"] != str(expired_receiver["id"])
            ):
                fail(f"{label} substitutes the retained holder or expired receiver")
            observations.append(observation)
        if observations[0] != observations[1]:
            fail(f"{label} native proof changed between complete collections")
        validate_descendant_scope(identity["controlSha"], subject_sha)

    policy = subprocess.run(
        ["git", "show", f"{subject_sha}:infra/azure/agents/copilot-cli-protected-operation-policy-stan.sh"],
        capture_output=True, text=True, check=False,
    )
    if policy.returncode:
        fail("held-handoff source-bound policy inventory is unavailable")
    result = subprocess.run(
        ["bash", "-s", "--", "workflows"], input=policy.stdout,
        capture_output=True, text=True, check=False,
    )
    if result.returncode:
        fail("held-handoff protected workflow inventory is unavailable")
    workflows = result.stdout.splitlines()
    if not workflows or len(workflows) != len(set(workflows)) or any(
        re.fullmatch(r"[a-z0-9-]+\.yml", name) is None for name in workflows
    ):
        fail("held-handoff protected workflow inventory is invalid")
    workflows = sorted(set(workflows) - {
        "common-package-publish.yml", "production-build.yml", "oci-production-build.yml",
    })
    lower = parse_timestamp(held.get("created_at"), "held-handoff history")
    cutoff = None
    if successor_run_id:
        if POSITIVE_INTEGER.fullmatch(successor_run_id) is None:
            fail("held-handoff successor run is invalid")
        latest = gh_api(f"repos/{repository}/actions/runs/{successor_run_id}")
        first = gh_api(f"repos/{repository}/actions/runs/{successor_run_id}/attempts/1")
        workflow = gh_api(f"repos/{repository}/actions/workflows/oci-live-data-rollout.yml")
        expected = {
            "id": int(successor_run_id), "run_attempt": 1, "head_sha": subject_sha,
            "path": ".github/workflows/oci-live-data-rollout.yml",
            "workflow_id": workflow.get("id"), "event": "workflow_dispatch",
            "head_branch": "master", "display_title": f"oci-live-data apply-slip-index {subject_sha}",
        }
        for native in (latest, first):
            if not isinstance(native, dict) or any(native.get(k) != v for k, v in expected.items()):
                fail("held-handoff successor native identity differs")
            if (native.get("head_repository") or {}).get("full_name") != repository:
                fail("held-handoff successor repository differs")
        if latest.get("status") != first.get("status") or latest.get("conclusion") != first.get("conclusion"):
            fail("held-handoff successor attempt state differs")
        if first.get("status") == "completed" and first.get("conclusion") != "success":
            fail("held-handoff completed successor is not successful")
        active_inventory = fresh or first.get("status") != "completed"
        if parse_timestamp(held.get("updated_at"), "held handoff") > parse_timestamp(
            first.get("created_at"), "successor",
        ):
            fail("held-handoff successor predates the held handoff")
        if first.get("status") in {"in_progress", "completed"}:
            job = exact_job(jobs_for_run(repository, successor_run_id, "successor"), "rollout", "successor")
            if (
                type(job.get("id")) is not int or job["id"] < 1
                or job.get("run_id") != int(successor_run_id)
                or job.get("status") != first["status"]
            ):
                fail("held-handoff successor cutoff belongs to another job")
            steps = [step for step in job["steps"]
                     if step.get("name") == "Validate exact SHA phase and trusted upstream runs"]
            if len(steps) != 1:
                fail("held-handoff successor cutoff is ambiguous")
            cutoff = parse_timestamp(steps[0].get("started_at"), "successor cutoff")
            if not parse_timestamp(first.get("created_at"), "successor") <= parse_timestamp(
                job.get("started_at"), "successor job",
            ) <= cutoff:
                fail("held-handoff successor cutoff chronology is invalid")
        elif first.get("status") not in {"queued", "waiting", "requested", "pending"}:
            fail("held-handoff successor state is invalid")
    frozen_runs = (
        (
            FAILED_HELD_CONTINUATION_RUN_ID,
            FAILED_HELD_CONTINUATION_HELD_RUN_ID,
            FAILED_HELD_CONTINUATION_HELD_SOURCE,
            FAILED_HELD_CONTINUATION_CONTROL,
            FAILED_HELD_CONTINUATION_CREATED_AT,
            FAILED_HELD_CONTINUATION_UPDATED_AT,
            FAILED_HELD_CONTINUATION_WORKFLOW_ID,
            FAILED_HELD_CONTINUATION_REPOSITORY_ID,
            FAILED_HELD_CONTINUATION_REPOSITORY_NODE_ID,
        ),
        (
            FAILED_CLEAN_READER_CONTINUATION_RUN_ID,
            FAILED_CLEAN_READER_CONTINUATION_HELD_RUN_ID,
            FAILED_CLEAN_READER_CONTINUATION_HELD_SOURCE,
            FAILED_CLEAN_READER_CONTINUATION_CONTROL,
            FAILED_CLEAN_READER_CONTINUATION_CREATED_AT,
            FAILED_CLEAN_READER_CONTINUATION_UPDATED_AT,
            FAILED_CLEAN_READER_CONTINUATION_WORKFLOW_ID,
            FAILED_CLEAN_READER_CONTINUATION_REPOSITORY_ID,
            FAILED_CLEAN_READER_CONTINUATION_REPOSITORY_NODE_ID,
        ),
        (
            FAILED_PRE_CAS_CONTINUATION_RUN_ID,
            FAILED_PRE_CAS_CONTINUATION_HELD_RUN_ID,
            FAILED_PRE_CAS_CONTINUATION_HELD_SOURCE,
            FAILED_PRE_CAS_CONTINUATION_CONTROL,
            FAILED_PRE_CAS_CONTINUATION_CREATED_AT,
            FAILED_PRE_CAS_CONTINUATION_UPDATED_AT,
            FAILED_PRE_CAS_CONTINUATION_WORKFLOW_ID,
            FAILED_PRE_CAS_CONTINUATION_REPOSITORY_ID,
            FAILED_PRE_CAS_CONTINUATION_REPOSITORY_NODE_ID,
        ),
    )
    required_frozen_ids = set()
    known_frozen_rows = {}
    for (
        run_id, owner_id, owner_source, control, created_at, updated_at,
        workflow_id, repository_id, repository_node_id,
    ) in frozen_runs:
        known_frozen_rows[run_id] = ({
            "id": run_id,
            "workflow_id": workflow_id,
            "path": ".github/workflows/oci-live-data-rollout.yml",
            "head_sha": control,
            "head_branch": "master",
            "event": "workflow_dispatch",
            "run_attempt": 1,
            "status": "completed",
            "conclusion": "failure",
            "display_title": f"oci-live-data apply-slip-index {control}",
            "created_at": created_at,
            "run_started_at": created_at,
            "updated_at": updated_at,
            "html_url": (
                f"https://github.com/vasilyevstan/betstan/actions/runs/{run_id}"
            ),
        }, repository_id, repository_node_id)
        frozen_updated = parse_timestamp(
            updated_at, "frozen failed-continuation history",
        )
        if (
            repository == "vasilyevstan/betstan"
            and held.get("id") == owner_id
            and held.get("head_sha") == owner_source
            and (cutoff is None or frozen_updated < cutoff)
        ):
            required_frozen_ids.add(run_id)
    history_requests = []
    for workflow in workflows:
        endpoint = f"repos/{repository}/actions/workflows/{workflow}/runs?per_page=100"
        if cutoff is not None and not active_inventory:
            endpoint += "&created=%3C%3D" + cutoff.strftime("%Y-%m-%dT%H:%M:%SZ")
        history_requests.append((endpoint, True))
    inventories = native_api_batch(history_requests)
    counts = {}
    for workflow, pages in zip(workflows, inventories):
        totals = {page.get("total_count") for page in pages}
        if len(totals) != 1 or any(type(n) is not int or not 0 <= n < 1000 for n in totals):
            fail("held-handoff historical inventory is incomplete or exceeds its bound")
        rows = []
        for page in pages:
            if not isinstance(page.get("workflow_runs"), list):
                fail("held-handoff historical inventory is malformed")
            rows.extend(page["workflow_runs"])
        if len(rows) != next(iter(totals)):
            fail("held-handoff historical inventory is incomplete")
        ids = set()
        for row in rows:
            proofs.before_row()
            if (
                not isinstance(row, dict) or type(row.get("id")) is not int
                or row["id"] < 1 or row["id"] in ids
                or row.get("path") != f".github/workflows/{workflow}"
                or (row.get("head_repository") or {}).get("full_name") != repository
                or type(row.get("head_branch")) is not str or not row["head_branch"]
            ):
                fail("held-handoff historical inventory identity is invalid")
            ids.add(row["id"])
            created = parse_timestamp(row.get("created_at"), "historical run")
            updated = parse_timestamp(row.get("updated_at"), "historical run")
            if updated < created or cutoff is not None and not active_inventory and created > cutoff:
                fail("held-handoff historical interval is inconsistent")
            if row["id"] in {held["id"], int(successor_run_id or "0")}:
                proofs.join()
                if workflow != "oci-live-data-rollout.yml":
                    fail("held-handoff historical owner is bound to another workflow")
                authenticated = held if row["id"] == held["id"] else first
                for key in (
                    "id", "head_sha", "created_at", "updated_at", "workflow_id", "run_attempt",
                    "event", "head_branch", "status", "conclusion", "display_title",
                ):
                    if key in authenticated and (
                        key not in row or type(row[key]) is not type(authenticated[key])
                        or row[key] != authenticated[key]
                    ):
                        fail("held-handoff owner inventory differs from its authenticated native identity")
                continue
            if expired_receiver is not None and row["id"] == expired_receiver["id"]:
                proofs.join()
                if workflow != "oci-production-deploy.yml" or any(
                    row.get(key) != expired_receiver.get(key) for key in (
                        "id", "workflow_id", "path", "head_sha", "head_branch", "event",
                        "run_attempt", "status", "conclusion", "display_title",
                        "created_at", "updated_at",
                    )
                ):
                    fail("expired-handoff historical receiver identity changed")
                continue
            if row["id"] in required_frozen_ids:
                proofs.join()
                if workflow != "oci-live-data-rollout.yml":
                    fail("frozen failed-continuation run belongs to another workflow")
                if row["id"] == FAILED_HELD_CONTINUATION_RUN_ID:
                    validate_failed_held_continuation_history(
                        repository, row, held, subject_sha, dispatch_inputs,
                        cutoff, active_inventory,
                        failed_continuation_semantic,
                    )
                elif row["id"] == FAILED_CLEAN_READER_CONTINUATION_RUN_ID:
                    validate_failed_clean_reader_continuation_history(
                        repository, row, held, subject_sha,
                        dispatch_inputs, cutoff, active_inventory,
                    )
                else:
                    validate_failed_pre_cas_continuation_history(
                        repository, row, held, subject_sha,
                        dispatch_inputs, cutoff, active_inventory,
                        failed_continuation_semantic,
                    )
                continue
            frozen_identity = known_frozen_rows.get(row["id"])
            if frozen_identity is not None:
                expected, repository_id, repository_node_id = frozen_identity
                if updated >= lower:
                    fail("known frozen failed-continuation run is not pre-window history")
                if (
                    any(
                        key not in row or type(row[key]) is not type(value)
                        or row[key] != value
                        for key, value in expected.items()
                    )
                    or not isinstance(row.get("head_repository"), dict)
                    or row["head_repository"].get("id") != repository_id
                    or row["head_repository"].get("node_id") != repository_node_id
                    or row["head_repository"].get("full_name")
                        != "vasilyevstan/betstan"
                ):
                    fail("known frozen failed-continuation run identity changed")
            if row.get("head_branch") != "master":
                proofs.join()
                continue
            if updated >= lower:
                if (
                    workflow == "oci-live-data-rollout.yml"
                    and row.get("status") == "completed" and row.get("conclusion") == "failure"
                ):
                    proofs.join()
                    validate_provenance_read_failure(row)
                else:
                    validate_cancelled_unstarted(row)
                continue
            if row.get("status") != "completed":
                initialized = authority is not None
                if authority is None:
                    authority = _load_shared_authority(
                        "held_handoff_authority",
                        "held-handoff shared unmaterialized validator is unavailable",
                    )
                    if (
                        not isinstance(getattr(authority, "UNMATERIALIZED_WORKFLOWS", None), dict)
                        or not callable(getattr(authority, "validate_unmaterialized_run_evidence", None))
                    ):
                        fail("held-handoff shared unmaterialized validator is unavailable")
                label = f"held-handoff historical run {row['id']} ({workflow})"
                if row["path"] not in authority.UNMATERIALIZED_WORKFLOWS:
                    fail(f"{label} is an unresolved non-allowlisted production run")
                identity_keys = (
                    "id", "workflow_id", "path", "head_sha", "head_branch",
                    "event", "run_attempt", "status", "conclusion", "display_title",
                    "created_at", "run_started_at", "updated_at", "html_url",
                )
                if (
                    any(key not in row for key in identity_keys)
                    or type(row["workflow_id"]) is not int or row["workflow_id"] < 1
                    or not isinstance(row["head_sha"], str)
                    or FULL_SHA.fullmatch(row["head_sha"]) is None
                ):
                    fail(f"{label} inventory cannot bind unmaterialized evidence")
                proofs.run(
                    _validate_unmaterialized_history, repository, copy.deepcopy(row),
                    subject_sha, authority, label, identity_keys, offload=initialized,
                )
        proofs.join()
        if workflow == "oci-live-data-rollout.yml":
            required_ids = {held["id"], *required_frozen_ids}
            if successor_run_id:
                required_ids.add(int(successor_run_id))
            if not required_ids <= ids:
                fail("held-handoff history omitted an independently authenticated run")
        counts[workflow] = sum(
            cutoff is None or parse_timestamp(row.get("created_at"), "historical run") <= cutoff
            for row in rows
        )
    return {
        "schema_version": "live-betting-held-handoff-history-v1",
        "repository": repository, "held_handoff_run_id": str(held["id"]),
        "held_handoff_source_sha": held["head_sha"],
        "successor_run_id": successor_run_id, "successor_source_sha": subject_sha,
        "start_at": held["created_at"],
        "cutoff_at": cutoff.strftime("%Y-%m-%dT%H:%M:%SZ") if cutoff is not None else None,
        "workflow_counts": counts,
    }


def record_held_handoff_transfer(path, snapshot_path, held_run, held_source, run_id, source, stage, state):
    path, snapshot_path = Path(path), Path(snapshot_path)
    raw = snapshot_path.read_bytes()
    snapshot = json.loads(raw)
    expected = {
        "schema_version": "live-betting-held-handoff-transfer-v1",
        "held_handoff_run_id": held_run, "held_handoff_source_sha": held_source,
        "successor_run_id": run_id, "successor_source_sha": source,
        "snapshot_sha256": hashlib.sha256(raw).hexdigest(),
        "lock_uid": snapshot["metadata"]["uid"],
        "observed_resource_version": snapshot["metadata"]["resourceVersion"],
        "observed_fencing_generation": snapshot["data"]["fencing-generation"],
        "observed_lease_until_epoch": snapshot["data"]["lease-until-epoch"],
    }
    if (
        snapshot["data"].get("state") != "active"
        or snapshot["data"].get("holder") != f"live-data-{held_run}-1"
        or snapshot["data"].get("source-sha") != held_source
        or snapshot["data"].get("operation-id") != "live-data-apply-slip-index"
    ):
        fail("held-handoff transfer snapshot substituted the physical owner")
    if path.is_symlink():
        fail("held-handoff transfer evidence cannot be a symbolic link")
    if path.exists():
        record = json.loads(path.read_bytes())
        if any(record.get(key) != value for key, value in expected.items()):
            fail("held-handoff transfer snapshot or owner drifted")
    else:
        record = dict(expected, release_result="not-attempted", acquire_result="not-attempted",
                      verify_result="not-attempted")
    previous = tuple(record.get(f"{name}_result") for name in ("release", "acquire", "verify"))
    transitions = {
        ("release", "unconfirmed"): ("not-attempted", "not-attempted", "not-attempted"),
        ("release", "confirmed"): ("unconfirmed", "not-attempted", "not-attempted"),
        ("acquire", "unconfirmed"): ("confirmed", "not-attempted", "not-attempted"),
        ("acquire", "confirmed"): ("confirmed", "unconfirmed", "not-attempted"),
        ("verify", "unconfirmed"): ("confirmed", "confirmed", "not-attempted"),
        ("verify", "confirmed"): ("confirmed", "confirmed", "unconfirmed"),
    }
    if transitions.get((stage, state)) != previous:
        fail("held-handoff transfer evidence cannot replay or skip a transition")
    record[f"{stage}_result"] = state
    temporary = path.with_name(path.name + ".new")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as handle:
        json.dump(record, handle, sort_keys=True)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)
    descriptor = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def validate_held_handoff_transfer(transfer, authority, current):
    keys = {
        "schema_version", "held_handoff_run_id", "held_handoff_source_sha",
        "successor_run_id", "successor_source_sha", "snapshot_sha256", "lock_uid",
        "observed_resource_version", "observed_fencing_generation", "observed_lease_until_epoch",
        "release_result", "acquire_result", "verify_result",
    }
    if not isinstance(transfer, dict) or set(transfer) != keys:
        fail("held-handoff transfer evidence has an invalid key set")
    expected = {
        "schema_version": "live-betting-held-handoff-transfer-v1",
        "held_handoff_run_id": authority["held_handoff_run_id"],
        "held_handoff_source_sha": authority["held_handoff_source_sha"],
        "successor_run_id": str(current["id"]), "successor_source_sha": current["head_sha"],
        "release_result": "confirmed", "acquire_result": "confirmed", "verify_result": "confirmed",
    }
    if any(transfer[key] != value for key, value in expected.items()):
        fail("held-handoff transfer was not confirmed for the exact owners")
    for key, pattern in (
        ("snapshot_sha256", r"[0-9a-f]{64}"), ("lock_uid", r"[A-Za-z0-9._:-]+"),
        ("observed_resource_version", r"[1-9][0-9]*"),
        ("observed_fencing_generation", r"[1-9][0-9]*"),
        ("observed_lease_until_epoch", r"[1-9][0-9]*"),
    ):
        if type(transfer[key]) is not str or re.fullmatch(pattern, transfer[key]) is None:
            fail("held-handoff transfer snapshot binding is malformed")


def validate_held_transfer_runtime(
    snapshot, current, deployments, pods, baseline_files, resume_authority,
    namespace, held_run, held_source, successor_run, successor_source, deadline="", generation="",
    lease_seconds="1800",
):
    label = "fresh held-handoff physical transfer"
    if type(lease_seconds) is not str or lease_seconds not in {"1800", "3600"}:
        fail(f"{label} authenticated predecessor profile is unsupported")
    if (
        not isinstance(snapshot, dict) or not isinstance(current, dict)
        or current.get("kind") != "ConfigMap" or current.get("apiVersion") != "v1"
        or snapshot.get("kind") != "ConfigMap" or snapshot.get("apiVersion") != "v1"
        or not isinstance(current.get("metadata"), dict) or not isinstance(current.get("data"), dict)
        or any(current["metadata"].get(key) != snapshot.get("metadata", {}).get(key)
               for key in ("name", "namespace", "uid", "resourceVersion"))
        or current["metadata"].get("name") != "gaming-mongo-migration-lock"
        or current["metadata"].get("namespace") != namespace
        or current["data"] != snapshot.get("data")
    ):
        fail(f"{label} exact lock snapshot changed")
    data = current["data"]
    if (
        data.get("holder") != f"live-data-{held_run}-1"
        or data.get("source-sha") != held_source or data.get("state") != "active"
        or data.get("operation-id") != "live-data-apply-slip-index"
        or data.get("lease-duration-seconds") != lease_seconds or data.get("released-at-epoch") != "0"
        or len({held_run, successor_run, resume_authority.get("applied_data_run_id"),
                resume_authority.get("failed_deploy_run_id")}) != 4
        or resume_authority.get("current_source_sha") != successor_source
    ):
        fail(f"{label} lock holder or distinct root/receiver/capture roles differ")
    for value, pattern in (
        (current["metadata"].get("uid"), r"[A-Za-z0-9._:-]+"),
        (current["metadata"].get("resourceVersion"), r"[1-9][0-9]*"),
        *((data.get(key), r"[1-9][0-9]*") for key in (
            "acquired-at-epoch", "lease-until-epoch", "fencing-generation",
        )),
    ):
        if type(value) is not str or re.fullmatch(pattern, value) is None:
            fail(f"{label} lock metadata is malformed")
    if (
        not int(data["acquired-at-epoch"]) <= int(data["lease-until-epoch"]) - int(lease_seconds) <= time.time()
        or deadline and data["lease-until-epoch"] != deadline
        or generation and data["fencing-generation"] != generation
    ):
        fail(f"{label} authentic native lease metadata differs")
    if validate_checksum_manifest(baseline_files, label) != resume_authority.get("baseline_sha256"):
        fail(f"{label} original rollback baseline changed")
    images = parse_tsv(baseline_files.get("images.tsv", b""), 5, label)
    desired = parse_tsv(baseline_files.get("deployments.tsv", b""), 6, label)
    if (
        len(images) != 10 or len(desired) != 10
        or {row[0] for row in images} != CURRENT_SERVICES
        or {row[0] for row in desired} != CURRENT_SERVICES
    ):
        fail(f"{label} original runtime baseline is incomplete")
    images = {row[0]: row for row in images}
    desired = {row[0]: row[3] for row in desired}
    items = deployments.get("items") if isinstance(deployments, dict) else None
    live_pods = pods.get("items") if isinstance(pods, dict) else None
    if (
        not isinstance(items, list) or len(items) != 10
        or {item.get("metadata", {}).get("name") for item in items}
        != {f"gaming-{service}-depl" for service in CURRENT_SERVICES}
        or not isinstance(live_pods, list)
    ):
        fail(f"{label} fresh workload inventory is incomplete")
    supporting = {"auth", "client", "telemetry"}
    for item in items:
        meta, spec, status = item.get("metadata", {}), item.get("spec", {}), item.get("status", {})
        service = meta["name"].removeprefix("gaming-").removesuffix("-depl")
        if POSITIVE_INTEGER.fullmatch(desired[service]) is None:
            fail(f"{label} original supporting replica count is invalid")
        replicas = int(desired[service]) if service in supporting else 0
        containers = [
            container for container in spec.get("template", {}).get("spec", {}).get("containers", [])
            if container.get("name") == f"gaming-{service}"
        ]
        if (
            item.get("kind") != "Deployment" or item.get("apiVersion") != "apps/v1"
            or meta.get("namespace") != namespace or not isinstance(meta.get("uid"), str) or not meta["uid"]
            or type(meta.get("generation")) is not int or meta["generation"] < 1
            or type(status.get("observedGeneration")) is not int
            or status["observedGeneration"] != meta["generation"]
            or type(spec.get("replicas")) is not int or spec["replicas"] != replicas
            or any(type(status.get(key, 0)) is not int or status.get(key, 0) != replicas for key in (
                "replicas", "updatedReplicas", "readyReplicas", "availableReplicas",
            ))
            or len(containers) != 1 or containers[0].get("image") != images[service][2]
        ):
            fail(f"{label} fresh deployment image, generation or quiescence differs")
        if service == "gamemaster":
            env = containers[0].get("env", [])
            flags = [entry for entry in env if entry.get("name") == "LIVE_KICKOFFS_ENABLED"]
            if (
                len(flags) != 1 or flags[0].get("value") != "false" or "valueFrom" in flags[0]
                or any(entry.get("name") == "LIVE_KICKOFFS_LEASE_UNTIL_EPOCH" for entry in env)
            ):
                fail(f"{label} live kickoff state is not dark")
        selected = [
            pod for pod in live_pods
            if pod.get("metadata", {}).get("labels", {}).get("app") == f"gaming-{service}"
        ]
        if len(selected) != replicas:
            fail(f"{label} fresh supporting pod or quiesced-writer inventory differs")
        for pod in selected:
            meta, status = pod.get("metadata", {}), pod.get("status", {})
            containers = [
                container for container in status.get("containerStatuses", [])
                if container.get("name") == f"gaming-{service}"
            ]
            if (
                meta.get("namespace") != namespace or not isinstance(meta.get("uid"), str) or not meta["uid"]
                or meta.get("deletionTimestamp") is not None or status.get("phase") != "Running"
                or len([condition for condition in status.get("conditions", [])
                        if condition.get("type") == "Ready" and condition.get("status") == "True"]) != 1
                or len(containers) != 1 or containers[0].get("ready") is not True
                or not isinstance(containers[0].get("imageID"), str)
                or not any(containers[0]["imageID"].endswith("@" + digest) for digest in images[service][3:5])
            ):
                fail(f"{label} fresh supporting pod identity or residency differs")


def validate_held_handoff_reports(files, evidence):
    with tempfile.TemporaryDirectory(prefix=".held-handoff-evidence-") as temporary:
        directory = Path(temporary)
        for relative, raw in files.items():
            destination = directory / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(raw)
        environment = os.environ.copy()
        environment.update({
            "EVIDENCE_DIR": str(directory), "EXPECTED_PHASE": "apply-slip-index",
            "EXPECTED_RUN_ID": evidence["workflow_run_id"], "EXPECTED_RUN_ATTEMPT": "1",
            "RESUME_BASELINE_DIR": "", "VERIFY_RESUME_APPLIED_RUN": "false", "RESUME_REPOSITORY": "",
            "RESUME_NATIVE_DISPATCH_INPUTS": "", "RESUME_SUCCESSOR_RUN_ID": "",
            **{f"EXPECTED_{key.upper()}": evidence[key] for key in (
                "source_sha", "build_run_id", "infrastructure_run_id",
                "baseline_recovery_run_id", "baseline_recovery_source_sha",
                "checkpoint_source_sha", "disk_checkpoint_run_id",
                "disk_checkpoint_sha256", "disk_checkpoint_disposition",
            )},
        })
        result = subprocess.run(
            [str(Path(__file__).with_name("verify-live-betting-data-evidence-stan.sh"))],
            env=environment, capture_output=True, check=False,
        )
        if result.returncode != 0:
            fail("held-handoff schema, journal, or sanitized reports are invalid")


def complete_held_artifacts(repository, run_id, source_sha, held, files, label):
    inventory = artifact_inventory(repository, run_id, label)
    expected = {
        f"oci-live-data-rollout-{run_id}-1", f"oci-live-data-baselines-{run_id}-1",
    }
    if (
        len(inventory) != 2 or {item.get("name") for item in inventory} != expected
        or any(type(item.get("id")) is not int or item["id"] < 1 for item in inventory)
        or len({item["id"] for item in inventory}) != 2
    ):
        fail(f"{label} complete producer artifact inventory differs")
    for item in inventory:
        owner = item.get("workflow_run")
        if (
            not isinstance(owner, dict) or type(owner.get("id")) is not int
            or owner["id"] != int(run_id) or owner.get("head_sha") != source_sha
            or owner.get("head_branch") != "master" or item.get("expired") is not False
            or not isinstance(item.get("digest"), str)
            or re.fullmatch(r"sha256:[0-9a-f]{64}", item["digest"]) is None
            or type(item.get("size_in_bytes")) is not int
            or not 0 < item["size_in_bytes"] <= MAX_ARTIFACT_ARCHIVE_BYTES
            or parse_timestamp(item.get("expires_at"), label).timestamp() <= time.time()
        ):
            fail(f"{label} complete producer artifact is unowned, expired or unauthenticated")
        created = parse_timestamp(item.get("created_at"), label)
        if not parse_timestamp(held["created_at"], label) <= created <= parse_timestamp(
            held["updated_at"], label,
        ):
            fail(f"{label} complete producer artifact chronology differs")
    rollout = next(item for item in inventory if item["name"].startswith("oci-live-data-rollout-"))
    if artifact_files(repository, rollout, label) != files:
        fail(f"{label} complete producer package changed during validation")
    baseline = next(item for item in inventory if item["name"].startswith("oci-live-data-baselines-"))
    return original_before_baseline(artifact_files(repository, baseline, label), label)


def validate_held_handoff_artifact(
    repository, run_id, source_sha, subject_sha, dispatch_inputs, runtime_mode, label,
    *, successor_run_id="",
):
    if _CURRENT_READER_SHA_CONTEXT.get() is not None:
        return _validate_held_handoff_artifact(
            repository, run_id, source_sha, subject_sha, dispatch_inputs, runtime_mode, label,
            successor_run_id=successor_run_id,
        )
    reader_token = _CURRENT_READER_SHA_CONTEXT.set(subject_sha)
    try:
        return _validate_held_handoff_artifact(
            repository, run_id, source_sha, subject_sha, dispatch_inputs, runtime_mode, label,
            successor_run_id=successor_run_id,
        )
    finally:
        _CURRENT_READER_SHA_CONTEXT.reset(reader_token)


def _validate_held_handoff_artifact(
    repository, run_id, source_sha, subject_sha, dispatch_inputs, runtime_mode, label,
    *, successor_run_id="",
):
    if dispatch_inputs.get("confirmation") != HELD_HANDOFF_CONFIRMATION:
        fail("held-handoff profile is restricted to its fixed continuation operation")
    if run_id in {
        require_dispatch_run(dispatch_inputs, "prerequisite_run_id"),
        require_dispatch_run(dispatch_inputs, "failed_deploy_run_id"),
    }:
        fail("held-handoff physical owner cannot substitute the original root")
    if (
        dispatch_inputs.get("prerequisite_run_id") == dispatch_inputs.get("failed_deploy_run_id")
        or successor_run_id and successor_run_id in {
            run_id, dispatch_inputs.get("prerequisite_run_id"), dispatch_inputs.get("failed_deploy_run_id"),
        }
    ):
        fail("held-handoff root, failed receiver, producer and new capture must be distinct")
    validate_descendant_scope(source_sha, subject_sha)
    held = validate_held_handoff_native(
        repository, run_id, source_sha, dispatch_inputs, runtime_mode, label,
    )
    evidence, manifest_sha, files = parse_live_v6_artifact(
        repository, run_id, label, include_files=True,
    )
    reports = {f"reports/{stage}-{service}.json"
               for stage in ("preflight", "apply", "verify")
               for service in ("event", "gamemaster", "moderation", "resulting", "bet", "slip")}
    reports |= {f"reports/{stage}-slip-index.json" for stage in ("preflight", "apply", "verify", "final")}
    reports |= {"reports/preflight-event-reschedule.json"}
    reports |= {f"reports/{stage}-backoffice-pre-september-cleanup.json"
                for stage in ("preflight", "apply", "verify")}
    package = reports | {
        "SHA256SUMS", "provenance.env", "schema.env", "journal.json", "resume-authority.env",
    }
    complete = held.get("_held_complete") is True
    if complete:
        authority = parse_resume_authority(files, evidence, label)
        if authority is None:
            fail("complete held handoff has no resume authority")
        if authority["schema_version"] != held["_handoff_resume_schema"]:
            fail("complete held handoff source, native branch and authority profiles differ")
        package.add("resume-images.tsv")
        if authority["schema_version"] in HELD_HANDOFF_AUTHORITY_VERSIONS:
            package.update({"held-handoff-history.json", "held-handoff-transfer.json"})
        if set(files) != package:
            fail("complete held handoff does not have its exact checksummed package")
        captured_baseline = complete_held_artifacts(
            repository, run_id, source_sha, held, files, label,
        )
    else:
        if set(files) != package:
            fail("held handoff does not have exactly the known historical packaging omission")
        authority = parse_env(files["resume-authority.env"], label, LIVE_RESUME_AUTHORITY_V2_KEYS)
    root_source = require_dispatch_sha(dispatch_inputs, "resume_source_sha")
    failed_run = require_dispatch_run(dispatch_inputs, "failed_deploy_run_id")
    root, predecessor = None, None
    if complete:
        native = held["_held_native_inputs"]
        if authority["schema_version"] in HELD_HANDOFF_AUTHORITY_VERSIONS:
            if native.get("confirmation") != HELD_HANDOFF_CONFIRMATION:
                fail("complete held handoff substituted its prior physical producer")
            predecessor = validate_held_handoff_artifact(
                repository, native["held_handoff_run_id"], native["held_handoff_source_sha"],
                source_sha, native, runtime_mode, label, successor_run_id=run_id,
            )
            root = dict(predecessor["resume"], _baseline_files=predecessor["baselineFiles"])
        else:
            if native.get("confirmation") != "RESUME APPLIED LIVE DATA EXACT SHA":
                fail("complete held handoff cannot omit its transferred-owner authority")
            root = validate_expired_handoff_resume(
                repository, failed_run, root_source, native, runtime_mode, label,
                successor_run_id=run_id,
            )
    if root is None:
        profile = "oci-failed-deploy-retained-hold-v1"
        outcomes = validate_failed_deploy_jobs(repository, failed_run, profile, label)
        if outcomes != ("skipped", "skipped", "skipped"):
            fail("held handoff does not preserve the original pre-runtime failure")
        root = validate_failed_deploy_artifacts(
            repository, failed_run, root_source, None, dispatch_inputs, runtime_mode,
            profile, *outcomes, label, pre_runtime=True,
        )
    if dispatch_inputs["prerequisite_run_id"] != root["baseline_capture_run_id"]:
        fail("held handoff substituted the failed receiver's authenticated capture")
    if complete and captured_baseline != root["_baseline_files"]:
        fail("complete held handoff replaced the original protected root rollback baseline")
    checkpoint = parse_checkpoint_artifact(repository, dispatch_inputs, runtime_mode, label)
    validate_live_v6_lineage(
        evidence, checkpoint, dispatch_inputs, run_id, source_sha, "apply-slip-index", label,
    )
    expected_authority = {
        "schema_version": authority["schema_version"] if complete else "live-betting-data-resume-v2",
        "applied_data_run_id": root["applied_data_run_id"],
        "applied_source_sha": root["applied_source_sha"], "failed_deploy_run_id": failed_run,
        "resume_maintenance_mode": "pre-runtime-hold", "failed_deploy_job_conclusion": "failure",
        "public_validate_job_conclusion": "skipped", "lock_release_step_conclusion": "skipped",
        "fence_release_step_conclusion": "skipped", "rehold_step_conclusion": "skipped",
        "failed_activation_run_id": "0", "current_source_sha": source_sha,
        "baseline_sha256": validate_checksum_manifest(root["_baseline_files"], label),
        "application_change_scope": "github-infra-docs-only", "status": "PASS",
        **{key: evidence[key] for key in (
            "checkpoint_source_sha", "disk_checkpoint_run_id",
            "disk_checkpoint_sha256", "disk_checkpoint_disposition",
        )},
    }
    build_run = require_dispatch_run(dispatch_inputs, "build_run_id")
    checkpoint_source = require_dispatch_sha(dispatch_inputs, "checkpoint_source_sha")
    build = exact_artifact(
        repository, build_run, f"oci-image-provenance-{checkpoint_source}-{build_run}-1", label,
    )
    image_bytes = artifact_member(repository, build, "images.tsv", label)
    candidate_images_checksum(image_bytes)
    expected_authority["runtime_images_sha256"] = hashlib.sha256(image_bytes).hexdigest()
    if complete:
        if files["resume-images.tsv"] != image_bytes:
            fail("complete held handoff substituted the authenticated original image bytes")
        if authority["schema_version"] in HELD_HANDOFF_AUTHORITY_VERSIONS:
            expected_authority.update({
                key: predecessor["resume"][key] for key in (
                    "held_handoff_run_id", "held_handoff_source_sha", "held_handoff_evidence_sha256",
                )
            })
            try:
                transfer = json.loads(files["held-handoff-transfer.json"])
            except (ValueError, UnicodeError):
                fail("complete held handoff transfer is malformed")
            validate_held_handoff_transfer(transfer, authority, held)
    if authority != expected_authority:
        fail("held-handoff authority substituted its root, checkpoint, or original image bytes")
    validate_held_handoff_reports(files, evidence)
    if complete:
        try:
            held_handoff_authority(
                repository, held, subject_sha, dispatch_inputs, successor_run_id, label,
            )
        except (OSError, KeyError, TypeError, ValueError):
            fail("complete held handoff owned authority is missing, malformed or inconsistent")
    baseline_files = root["_baseline_files"]
    _, baseline_provenance_raw = unique_artifact_file(
        baseline_files, "baseline-provenance.env", label,
    )
    baseline_provenance = parse_env(
        baseline_provenance_raw, label, BASELINE_PROVENANCE_KEYS,
    )
    failed_continuation_semantic = {
        "rootRunId": root["applied_data_run_id"],
        "rootSourceSha": root["applied_source_sha"],
        "baselineFiles": copy.deepcopy(baseline_files),
        "imageBytes": image_bytes,
        "checkpoint": {
            key: checkpoint[key] for key in (
                "sourceSha", "contentChecksumSha256", "disposition",
            )
        },
        "heldEvidenceSha256": manifest_sha,
        "lockHolder": f"live-data-{run_id}-1",
        "lockFencingGeneration": str(held.get("_handoff_generation", "")),
        "lockLeaseUntilEpoch": str(held.get("_handoff_deadline", "")),
        "lockLeaseSeconds": str(held.get("_handoff_lease_seconds", "")),
        "lockNamespace": baseline_provenance["namespace"],
    }
    history = held_handoff_history(
        repository, held, subject_sha, successor_run_id,
        dispatch_inputs=dispatch_inputs,
        failed_continuation_semantic=failed_continuation_semantic,
    )
    # The expired receiver qualifies the ancestor, not the current physical transfer.
    root.pop("no_takeover_handoff_qualification", None)
    return {
        "artifactName": f"oci-live-data-rollout-{run_id}-1",
        "createdAt": held["created_at"], "completedAt": held["updated_at"],
        "baselineFiles": root.pop("_baseline_files"), "heldHistory": history,
        "resume": {
            **root, "held_handoff_run_id": run_id, "held_handoff_source_sha": source_sha,
            "held_handoff_evidence_sha256": manifest_sha,
            "baseline_sha256": authority["baseline_sha256"],
            "failed_deploy_run_id": failed_run,
            "held_handoff_lease_seconds": str(held["_handoff_lease_seconds"] if complete else 1800),
            **({"held_handoff_lease_until_epoch": str(held["_handoff_deadline"])} if complete else {}),
            **({"held_handoff_fencing_generation": str(held["_handoff_generation"])}
               if complete and "_handoff_generation" in held else {}),
            **{key: authority[key] for key in (
                "failed_deploy_job_conclusion", "public_validate_job_conclusion",
                "lock_release_step_conclusion", "fence_release_step_conclusion", "rehold_step_conclusion",
            )},
        },
    }


def validate_pre_runtime_resume_chain(
    repository, run_id, runtime_mode, *, seen=None, include_capture=False,
):
    seen = set() if seen is None else set(seen)
    if run_id in seen or len(seen) >= 20:
        fail("resume authority is cyclic or exceeds the lineage bound")
    seen.add(run_id)
    evidence, _, files = parse_live_v6_artifact(
        repository, run_id, "resume predecessor", include_files=True
    )
    authority = parse_resume_authority(files, evidence, "resume predecessor")
    if authority is None:
        return (
            {"applied_data_run_id": run_id, "applied_source_sha": evidence["source_sha"],
             "baseline_capture_run_id": run_id}
            if include_capture else (run_id, evidence["source_sha"])
        )
    if authority["schema_version"] in HELD_HANDOFF_AUTHORITY_VERSIONS:
        current = require_fixed_run(
            repository, run_id, "oci-live-data-rollout.yml", "success", evidence["source_sha"],
            f"oci-live-data apply-slip-index {evidence['source_sha']}", "held-handoff successor",
        )
        request = failed_deploy_native_inputs(
            repository, run_id, evidence["source_sha"], "held-handoff successor", resume_dispatch=True,
        )
        expected_request = {
            "approved_sha": evidence["source_sha"],
            "failed_deploy_run_id": authority["failed_deploy_run_id"],
            "held_handoff_run_id": authority["held_handoff_run_id"],
            "held_handoff_source_sha": authority["held_handoff_source_sha"],
            "phase": "apply-slip-index", "failed_activation_run_id": "0",
            "failed_activation_user_id": "0", "confirmation": HELD_HANDOFF_CONFIRMATION,
            **{key: evidence[key] for key in (
                "build_run_id", "infrastructure_run_id", "checkpoint_source_sha",
                "disk_checkpoint_run_id", "baseline_recovery_run_id", "baseline_recovery_source_sha",
            )},
        }
        # The failed receiver's capture and controller can differ from the original applied root.
        if (
            set(request) != set(expected_request) | {"resume_source_sha", "prerequisite_run_id"}
            or any(request[key] != value for key, value in expected_request.items())
        ):
            fail("held-handoff successor substituted its native root or previous physical holder")
        if authority["schema_version"] == "live-betting-data-resume-v4":
            workflow = held_source_bytes(
                repository, evidence["source_sha"], ".github/workflows/oci-live-data-rollout.yml",
                "held-handoff successor",
            )
            if held_handoff_source_version(workflow, "held-handoff successor") != authority["schema_version"]:
                fail("held-handoff successor source and resume authority profiles differ")
        result = validate_held_handoff_artifact(
            repository, authority["held_handoff_run_id"], authority["held_handoff_source_sha"],
            evidence["source_sha"], request, runtime_mode, "held-handoff predecessor",
            successor_run_id=run_id,
        )
        for key in (
            "applied_data_run_id", "applied_source_sha", "held_handoff_run_id",
            "held_handoff_source_sha", "held_handoff_evidence_sha256",
            "resume_maintenance_mode", "failed_deploy_job_conclusion", "public_validate_job_conclusion",
            "lock_release_step_conclusion", "fence_release_step_conclusion", "rehold_step_conclusion",
        ):
            if authority[key] != result["resume"][key]:
                fail("held-handoff successor substituted authenticated predecessor evidence")
        _, raw_history = unique_artifact_file(files, "held-handoff-history.json", "held history")
        try:
            history = json.loads(raw_history)
            _, raw_transfer = unique_artifact_file(files, "held-handoff-transfer.json", "held transfer")
            transfer = json.loads(raw_transfer)
        except (ValueError, UnicodeDecodeError):
            fail("held-handoff successor transition evidence is malformed")
        if history != result["heldHistory"]:
            fail("held-handoff successor history differs from its immutable native cutoff")
        validate_held_handoff_transfer(transfer, authority, current)
        if authority["baseline_sha256"] != validate_checksum_manifest(
            result["baselineFiles"], "held-handoff original baseline",
        ):
            fail("held-handoff successor substituted its authenticated original baseline")
        return (
            {"applied_data_run_id": authority["applied_data_run_id"],
             "applied_source_sha": authority["applied_source_sha"],
             "baseline_capture_run_id": result["resume"]["baseline_capture_run_id"],
             **{key: result["resume"][key] for key in (
                 "baseline_capture_source_sha", "baseline_capture_deploy_run_id", "baseline_sha256",
             ) if key in result["resume"]}}
            if include_capture else (
                authority["applied_data_run_id"], authority["applied_source_sha"],
            )
        )
    if authority["resume_maintenance_mode"] != "pre-runtime-hold":
        if not include_capture:
            fail("pre-runtime hold cannot substitute a post-runtime recovery lineage")
        failed_run = authority["failed_deploy_run_id"]
        metadata = fixed_run_metadata(
            repository, failed_run, "oci-production-deploy.yml", "failure",
            "post-runtime resume failed deployment",
        )
        source_sha = metadata["head_sha"]
        if metadata.get("display_title") != f"oci-deploy {source_sha}":
            fail("post-runtime failed deployment title differs")
        validate_descendant_scope(source_sha, evidence["source_sha"])
        retained = authority["resume_maintenance_mode"] == "retained-hold"
        profile = (
            "oci-failed-deploy-retained-hold-v1" if retained
            else "oci-failed-deploy-released-runtime-v1"
        )
        outcomes = validate_failed_deploy_jobs(repository, failed_run, profile, "post-runtime resume")
        if tuple(authority[key] for key in (
            "failed_deploy_job_conclusion", "public_validate_job_conclusion",
            "lock_release_step_conclusion", "fence_release_step_conclusion", "rehold_step_conclusion",
        )) != ("failure" if retained else "success", "skipped" if retained else "failure", *outcomes):
            fail("post-runtime authority differs from its native failure outcomes")
        native = failed_deploy_native_inputs(
            repository, failed_run, source_sha, "post-runtime resume failed deployment",
            expected_step_conclusion="success",
        )
        if native["confirmation"] != "DEPLOY OCI EXACT SHA":
            fail("post-runtime failed deployment confirmation differs")
        request = failed_deploy_native_inputs(
            repository, run_id, evidence["source_sha"], "post-runtime resume request",
            resume_dispatch=True,
        )
        expected_request = {key: native[key] for key in (
            "build_run_id", "infrastructure_run_id", "checkpoint_source_sha",
            "disk_checkpoint_run_id", "baseline_recovery_run_id", "baseline_recovery_source_sha",
        )}
        expected_request.update({
            "approved_sha": evidence["source_sha"], "resume_source_sha": source_sha,
            "prerequisite_run_id": native["data_run_id"], "failed_deploy_run_id": failed_run,
            "phase": "apply-slip-index", "failed_activation_run_id": "0",
            "failed_activation_user_id": "0",
            "confirmation": "RESUME APPLIED LIVE DATA EXACT SHA" if retained else
                "RESUME APPLIED LIVE DATA FROM RELEASED RUNTIME EXACT SHA",
        })
        if request != expected_request:
            fail("post-runtime resume substituted its native predecessor or release tuple")
        artifact = exact_artifact(
            repository, failed_run, f"oci-production-baseline-{failed_run}-1", "post-runtime resume",
        )
        result = validate_failed_deploy_artifacts(
            repository, failed_run, source_sha, artifact, request, runtime_mode,
            profile, *outcomes, "post-runtime resume", seen=seen, include_capture=True,
        )
        prior, _ = parse_live_v6_artifact(repository, native["data_run_id"], "post-runtime predecessor")
        for key in LIVE_V6_KEYS - {"source_sha", "workflow_run_id", "completed_at"}:
            if evidence[key] != prior[key]:
                fail(f"post-runtime resume substituted {key}")
        if any(authority[key] != result[key] for key in ("applied_data_run_id", "applied_source_sha")):
            fail("post-runtime resume substituted its ancestral applied root")
        previous = require_fixed_run(
            repository, native["data_run_id"], "oci-live-data-rollout.yml", "success",
            source_sha, f"oci-live-data apply-slip-index {source_sha}", "post-runtime predecessor",
        )
        current = require_fixed_run(
            repository, run_id, "oci-live-data-rollout.yml", "success",
            evidence["source_sha"], f"oci-live-data apply-slip-index {evidence['source_sha']}",
            "post-runtime resume",
        )
        if (
            parse_timestamp(previous.get("updated_at"), "post-runtime predecessor")
                > parse_timestamp(metadata.get("created_at"), "post-runtime failure")
            or parse_timestamp(metadata.get("updated_at"), "post-runtime failure")
                > parse_timestamp(current.get("created_at"), "post-runtime resume")
        ):
            fail("post-runtime resume chronology differs")
        return result
    failed_run = authority["failed_deploy_run_id"]
    metadata = fixed_run_metadata(
        repository, failed_run, "oci-production-deploy.yml", "failure",
        "resume failed deployment",
    )
    source_sha = metadata["head_sha"]
    validate_descendant_scope(source_sha, evidence["source_sha"])
    profile = "oci-failed-deploy-retained-hold-v1"
    native_qualification = expired_handoff_native_inputs(
        repository, failed_run, runtime_mode, "resume expired receiver",
    )
    if native_qualification is not None:
        native, _ = native_qualification
        request = failed_deploy_native_inputs(
            repository, run_id, evidence["source_sha"], "expired-handoff resume request",
            resume_dispatch=True,
        )
        expected_request = {
            key: native[key] for key in (
                "build_run_id", "infrastructure_run_id", "checkpoint_source_sha",
                "disk_checkpoint_run_id", "baseline_recovery_run_id",
                "baseline_recovery_source_sha",
            )
        }
        expected_request.update({
            "approved_sha": evidence["source_sha"], "resume_source_sha": source_sha,
            "prerequisite_run_id": native["data_run_id"], "failed_deploy_run_id": failed_run,
            "phase": "apply-slip-index", "failed_activation_run_id": "0",
            "failed_activation_user_id": "0", "confirmation": "RESUME APPLIED LIVE DATA EXACT SHA",
        })
        if request != expected_request:
            fail("expired-handoff resume substituted its native receiver or physical owner")
        result = validate_expired_handoff_resume(
            repository, failed_run, source_sha, request, runtime_mode,
            "resume expired receiver", successor_run_id=run_id,
        )
        prior, _ = parse_live_v6_artifact(
            repository, native["data_run_id"], "expired-handoff predecessor",
        )
        for key in LIVE_V6_KEYS - {"source_sha", "workflow_run_id", "completed_at"}:
            if evidence[key] != prior[key]:
                fail(f"expired-handoff resume substituted {key}")
        if any(
            authority[key] != result[key]
            for key in ("applied_data_run_id", "applied_source_sha")
        ):
            fail("expired-handoff resume substituted its ancestral applied root")
        current = require_fixed_run(
            repository, run_id, "oci-live-data-rollout.yml", "success",
            evidence["source_sha"], f"oci-live-data apply-slip-index {evidence['source_sha']}",
            "expired-handoff resume",
        )
        if parse_timestamp(metadata.get("updated_at"), "expired receiver") > parse_timestamp(
            current.get("created_at"), "expired-handoff resume",
        ):
            fail("expired-handoff resume predates its failed receiver")
        return (
            {key: result[key] for key in (
                "applied_data_run_id", "applied_source_sha", "baseline_capture_run_id",
                "baseline_capture_source_sha", "baseline_capture_deploy_run_id",
                "baseline_sha256", "no_takeover_handoff_qualification",
            )}
            if include_capture else (
                result["applied_data_run_id"], result["applied_source_sha"],
            )
        )
    outcomes = validate_failed_deploy_jobs(repository, failed_run, profile, "resume")
    if outcomes != ("skipped", "skipped", "skipped"):
        fail("pre-runtime resume authority relabels another failed-deploy profile")
    native = failed_deploy_native_inputs(repository, failed_run, source_sha, "resume")
    request = failed_deploy_native_inputs(
        repository, run_id, evidence["source_sha"], "resume request", resume_dispatch=True
    )
    expected_request = {
        key: native[key] for key in (
            "build_run_id", "infrastructure_run_id", "checkpoint_source_sha",
            "disk_checkpoint_run_id", "baseline_recovery_run_id",
            "baseline_recovery_source_sha",
        )
    }
    expected_request.update({
        "approved_sha": evidence["source_sha"], "resume_source_sha": source_sha,
        "prerequisite_run_id": native["data_run_id"], "failed_deploy_run_id": failed_run,
        "phase": "apply-slip-index", "failed_activation_run_id": "0",
        "failed_activation_user_id": "0", "confirmation": "RESUME APPLIED LIVE DATA EXACT SHA",
    })
    if request != expected_request:
        fail("pre-runtime resume request substituted its native predecessor or failed deployment")
    dispatch = dict(native, prerequisite_run_id=native["data_run_id"])
    result = validate_failed_deploy_artifacts(
        repository, failed_run, source_sha, None, dispatch, runtime_mode,
        profile, *outcomes, "resume", pre_runtime=True, seen=seen,
    )
    prior, _ = parse_live_v6_artifact(repository, native["data_run_id"], "resume")
    for key in LIVE_V6_KEYS - {
        "source_sha", "workflow_run_id", "completed_at",
    }:
        if evidence[key] != prior[key]:
            fail(f"pre-runtime resume substituted {key}")
    if (
        result["applied_data_run_id"] != authority["applied_data_run_id"]
        or result["applied_source_sha"] != authority["applied_source_sha"]
    ):
        fail("pre-runtime resume substituted its original applied authority")
    current = require_fixed_run(
        repository, run_id, "oci-live-data-rollout.yml", "success",
        evidence["source_sha"], f"oci-live-data apply-slip-index {evidence['source_sha']}",
        "resume",
    )
    if parse_timestamp(metadata.get("updated_at"), "resume") > parse_timestamp(
        current.get("created_at"), "resume"
    ):
        fail("pre-runtime resume predates the failed deployment")
    return (
        {"applied_data_run_id": result["applied_data_run_id"],
         "applied_source_sha": result["applied_source_sha"],
         "baseline_capture_run_id":
             result.get("baseline_capture_run_id", result["applied_data_run_id"]),
         **{key: result[key] for key in (
             "baseline_capture_source_sha", "baseline_capture_deploy_run_id", "baseline_sha256",
         ) if key in result}}
        if include_capture else (
            result["applied_data_run_id"], result["applied_source_sha"],
        )
    )


def released_pre_arm_native_inputs(repository, run_id, source_sha, label):
    """Qualify only the frozen historical read-only arming failure."""
    metadata = require_fixed_run(
        repository, run_id, "oci-live-betting-activate.yml", "failure",
        source_sha, f"oci-live-activate {source_sha}", label,
    )
    commit = gh_api(f"repos/{repository}/git/commits/{source_sha}")
    if (
        not isinstance(commit, dict)
        or commit.get("sha") != source_sha
        or (commit.get("tree") or {}).get("sha")
        != "bda7899f4ce0447ced6d7e119574f11fcdd8c8e4"
    ):
        fail(f"{label} historical executable tree differs")
    workflow = None
    for path, expected_blob in (
        (".github/workflows/oci-live-betting-activate.yml",
         "a0f58534cd782b2c8ebff5c60bbf9588fd3f6bb2"),
        ("infra/oci/scripts/cash-back-acceptance-recovery-stan.js",
         "d899119717f491f6b6cceba2dc0785a0047e944f"),
        ("infra/oci/scripts/revalidate-live-activation-stan.sh",
         "3fe95e7138132e58599f7e7862843f918c5f45d5"),
    ):
        observed = gh_api(f"repos/{repository}/contents/{path}?ref={source_sha}")
        if (
            not isinstance(observed, dict) or observed.get("sha") != expected_blob
            or observed.get("type") != "file" or observed.get("encoding") != "base64"
            or not isinstance(observed.get("content"), str)
            or type(observed.get("size")) is not int
            or not 0 < observed["size"] <= MAX_ARTIFACT_EVIDENCE_BYTES
        ):
            fail(f"{label} historical executable pin differs")
        try:
            blob = base64.b64decode(observed["content"].replace("\n", ""), validate=True)
        except (binascii.Error, ValueError):
            fail(f"{label} historical executable encoding is invalid")
        if (
            len(blob) != observed["size"]
            or hashlib.sha1(f"blob {len(blob)}\0".encode() + blob).hexdigest() != expected_blob
        ):
            fail(f"{label} historical executable content differs")
        if path.endswith(".yml"):
            try:
                workflow = blob.decode("utf-8")
            except UnicodeDecodeError:
                fail(f"{label} historical workflow encoding is invalid")
    names = re.findall(r"(?m)^      - name: (.+)$", workflow)
    expected_names = [
        "Set up job", *names, "Post Install browser acceptance dependencies",
        "Post Checkout exact current master", "Complete job",
    ]
    jobs = jobs_for_run(repository, run_id, label)
    job = exact_job(jobs, "activate-and-validate", label)
    if (
        len(jobs) != 1 or type(job.get("id")) is not int or job["id"] < 1
        or job.get("run_id") != int(run_id) or job.get("status") != "completed"
        or job.get("conclusion") != "failure"
        or [step.get("name") for step in job["steps"]] != expected_names
        or [step.get("number") for step in job["steps"]]
        != [*range(1, len(names) + 2), 93, 94, 95]
    ):
        fail(f"{label} frozen pre-arm job inventory differs")
    arm_name = "Arm owner-bound activation abort"
    boundary = expected_names.index(arm_name)
    successes_after = {
        "Reconcile protected cash-back worker interruption",
        "Capture sanitized failure diagnostics", "Close ephemeral OCI Bastion access",
        "Write final activation provenance", "Prepare activation recovery authority",
        "Upload activation recovery authority", "Upload protected activation evidence",
        "Remove isolated client state", "Post Checkout exact current master",
        "Complete job",
    }
    skipped_before = {
        "Verify OKE identity", "Authorize current OKE runner",
        "Configure kubectl from exact OKE cluster",
    }
    created = parse_timestamp(metadata.get("created_at"), label)
    completed = parse_timestamp(metadata.get("updated_at"), label)
    for index, step in enumerate(job["steps"]):
        expected = (
            "failure" if index == boundary else
            "success" if (index < boundary and step["name"] not in skipped_before)
            or step["name"] in successes_after else "skipped"
        )
        if step.get("status") != "completed" or step.get("conclusion") != expected:
            fail(f"{label} frozen pre-arm step outcome differs")
        start = parse_timestamp(step.get("started_at"), label)
        end = parse_timestamp(step.get("completed_at"), label)
        if not created <= start <= end <= completed:
            fail(f"{label} frozen pre-arm step chronology differs")
    arm = job["steps"][boundary]
    artifacts = artifact_inventory(repository, run_id, label)
    if len(artifacts) != 2 or {item.get("name") for item in artifacts} != {
        f"oci-live-activation-recovery-{run_id}-1",
        f"oci-live-activation-{run_id}-1",
    }:
        fail(f"{label} frozen pre-arm artifact inventory differs")
    start = parse_timestamp(arm["started_at"], label)
    end = parse_timestamp(arm["completed_at"], label)
    files = zip_files(
        gh_api_bytes(f"repos/{repository}/actions/runs/{run_id}/attempts/1/logs"),
        label, require_original_names=True,
    )
    matches = [
        raw for name, raw in files.items()
        if re.fullmatch(r"-?[0-9]+_activate-and-validate\.txt", name)
    ]
    if len(matches) != 1:
        fail(f"{label} native full-job log is absent or ambiguous")
    try:
        raw = matches[0].decode("utf-8")
    except UnicodeDecodeError:
        fail(f"{label} native arm log encoding is invalid")
    interval = []
    timestamp = None
    for line in raw.splitlines():
        match = re.fullmatch(r"(\d{4}-\d\d-\d\dT\S+Z) (.*)", line)
        if match:
            timestamp = parse_timestamp(
                re.sub(r"(\.\d{6})\d+(?=Z$)", r"\1", match[1]), label,
            )
        if timestamp is not None and start <= timestamp < end + dt.timedelta(seconds=1):
            interval.append(re.sub(r"\x1b\[[0-9;]*m", "", match[2] if match else line))
    marker = "##[group]Run node ./infra/oci/scripts/cash-back-acceptance-recovery-stan.js arm"
    if interval.count(marker) != 1:
        fail(f"{label} native arm command group is ambiguous")
    begin = interval.index(marker)
    group_ends = [
        index for index in range(begin + 1, len(interval))
        if interval[index] == "##[endgroup]"
    ]
    if not group_ends:
        fail(f"{label} native arm environment is incomplete")
    group_end = group_ends[0]
    environment = interval[begin + 1:group_end]
    if sum(line in {"env:", "  env:"} for line in environment) != 1 or any(
        line.startswith("##[group]") for line in environment
    ):
        fail(f"{label} native arm environment is ambiguous")
    output_end = next(
        (index for index in range(group_end + 1, len(interval))
         if interval[index].startswith("##[group]")),
        len(interval),
    )
    if interval[group_end + 1:output_end] != [
        "Protected cash-back source revalidation failed (1).",
        "##[error]Process completed with exit code 1.",
    ]:
        fail(f"{label} native failure is not the frozen read-only prefix")
    native = {}
    for key, env_key in (
        ("approved_sha", "SOURCE_SHA"), ("build_run_id", "BUILD_RUN_ID"),
        ("infrastructure_run_id", "INFRASTRUCTURE_RUN_ID"),
        ("deployment_run_id", "DEPLOYMENT_RUN_ID"),
        ("checkpoint_source_sha", "CHECKPOINT_SOURCE_SHA"),
        ("disk_checkpoint_run_id", "DISK_CHECKPOINT_RUN_ID"),
        ("disk_checkpoint_sha256", "DISK_CHECKPOINT_SHA256"),
        ("disk_checkpoint_disposition", "DISK_CHECKPOINT_DISPOSITION"),
        ("confirmation", "CONFIRMATION"),
    ):
        values = [
            line.removeprefix(f"  {env_key}: ") for line in environment
            if line.startswith(f"  {env_key}: ")
        ]
        if len(values) != 1:
            fail(f"{label} native arm binding {key} is absent or duplicated")
        native[key] = values[0]
    if (
        native["approved_sha"] != source_sha
        or native["confirmation"] != "ACTIVATE OCI LIVE BETTING"
        or any(line.startswith((
            "  DEPLOYMENT_PROVENANCE_FILE:", "  LIVE_SCHEMA_EVIDENCE_FILE:",
        )) for line in environment)
    ):
        fail(f"{label} native arm source or frozen environment differs")
    return native, metadata


def validate_released_activation_pre_arm(
    repository, run_id, source_sha, artifact, dispatch_inputs, runtime_mode, label,
):
    if (
        dispatch_inputs.get("failed_activation_user_id") != "0"
        or dispatch_inputs.get("confirmation") !=
        "RESUME APPLIED LIVE DATA FROM RELEASED RUNTIME AND CLEAN FAILED ACTIVATION EXACT SHA"
        or dispatch_inputs.get("failed_activation_run_id") != run_id
    ):
        fail(f"{label} pre-arm qualification requires the exact released operation")
    native, activation_metadata = released_pre_arm_native_inputs(
        repository, run_id, source_sha, label,
    )
    checkpoint = parse_checkpoint_artifact(repository, dispatch_inputs, runtime_mode, label)
    files = artifact_files(repository, artifact, label)
    validate_checksum_manifest(files, label)
    if exact_basename_set(files) != {"provenance.env", "SHA256SUMS"} or len(files) != 2:
        fail(f"{label} frozen pre-arm recovery file set differs")
    _, raw = unique_artifact_file(files, "provenance.env", label)
    activation = parse_env(raw, label, ACTIVATION_PROVENANCE_KEYS)
    expected = {
        "source_sha": source_sha, "activation_run_id": run_id,
        "activation_run_attempt": "1", "workflow_result": "failure",
        "workflow_phase": "activation-incomplete", "activation_state": "unknown",
        "live_kickoffs_enabled": "unknown", "activation_lease_until_epoch": "unknown",
        "live_acceptance_user_id": "none", "final_control_file": "none",
        "post_commit_status": "not-applicable", "revoke_runner_outcome": "skipped",
        "close_bastion_outcome": "success",
        "build_run_id": require_dispatch_run(dispatch_inputs, "build_run_id"),
        "infrastructure_run_id": require_dispatch_run(dispatch_inputs, "infrastructure_run_id"),
        "checkpoint_source_sha": checkpoint["sourceSha"],
        "disk_checkpoint_run_id": checkpoint["producerRunId"],
        "disk_checkpoint_sha256": checkpoint["contentChecksumSha256"],
        "disk_checkpoint_disposition": checkpoint["disposition"],
    }
    expected.update({key: "none" for key in (
        "activate_control_sha256", "acceptance_sha256", "accepted_sha256",
        "commit_control_sha256", "failure_disable_sha256", "final_disable_sha256",
        "final_control_sha256",
    )})
    expected.update({key: "skipped" for key in (
        "accepted_outcome", "accepted_evidence_upload_outcome", "commit_preflight_outcome",
        "commit_outcome", "failure_disable_outcome", "final_disable_outcome",
    )})
    for key, value in expected.items():
        if activation[key] != value:
            fail(f"{label} frozen pre-arm provenance {key} differs")
    for key in (
        "build_run_id", "infrastructure_run_id", "deployment_run_id",
        "checkpoint_source_sha", "disk_checkpoint_run_id",
        "disk_checkpoint_sha256", "disk_checkpoint_disposition",
    ):
        if native[key] != activation[key]:
            fail(f"{label} native arm substituted {key}")
    deployment_run = require_dispatch_run(activation, "deployment_run_id")
    deployment_metadata = require_fixed_run(
        repository, deployment_run, "oci-production-deploy.yml", "success",
        source_sha, f"oci-deploy {source_sha}", label,
    )
    predecessor_run = require_dispatch_run(dispatch_inputs, "prerequisite_run_id")
    predecessor, manifest_sha, predecessor_files = parse_live_v6_artifact(
        repository, predecessor_run, label, include_files=True,
    )
    validate_live_v6_lineage(
        predecessor, checkpoint, dispatch_inputs, predecessor_run, source_sha,
        "apply-slip-index", label,
    )
    predecessor_metadata = require_fixed_run(
        repository, predecessor_run, "oci-live-data-rollout.yml", "success",
        source_sha, f"oci-live-data apply-slip-index {source_sha}", label,
    )
    parse_deployment_artifact(
        repository, deployment_run, source_sha, dispatch_inputs, checkpoint,
        predecessor, manifest_sha, runtime_mode, label,
    )
    deployment_inputs = failed_deploy_native_inputs(
        repository, deployment_run, source_sha, label, expected_step_conclusion="success",
    )
    expected_deployment = {
        key: dispatch_inputs[key] for key in (
            "build_run_id", "infrastructure_run_id", "checkpoint_source_sha",
            "disk_checkpoint_run_id", "baseline_recovery_run_id",
            "baseline_recovery_source_sha",
        )
    }
    expected_deployment.update({
        "approved_sha": source_sha, "data_run_id": predecessor_run,
        "confirmation": "DEPLOY OCI EXACT SHA",
    })
    if deployment_inputs != expected_deployment:
        fail(f"{label} immediate deployment native inputs differ")
    deployment_jobs = jobs_for_run(repository, deployment_run, label)
    if (
        len(deployment_jobs) != 2
        or any(exact_job(deployment_jobs, name, label).get("conclusion") != "success"
               for name in ("deploy", "public-validate"))
    ):
        fail(f"{label} immediate deployment is not wholly successful")
    authority = parse_resume_authority(predecessor_files, predecessor, label)
    failed_run = require_dispatch_run(dispatch_inputs, "failed_deploy_run_id")
    if (
        authority is None or authority["resume_maintenance_mode"] != "released-runtime"
        or authority["failed_deploy_run_id"] != failed_run
    ):
        fail(f"{label} predecessor released authority differs")
    failed_metadata = fixed_run_metadata(
        repository, failed_run, "oci-production-deploy.yml", "failure", label,
    )
    failed_source = failed_metadata["head_sha"]
    if failed_metadata.get("display_title") != f"oci-deploy {failed_source}":
        fail(f"{label} historical failed-deployment title differs")
    validate_descendant_scope(failed_source, source_sha)
    failed_inputs = failed_deploy_native_inputs(
        repository, failed_run, failed_source, label, expected_step_conclusion="success",
    )
    if failed_inputs["confirmation"] != "DEPLOY OCI EXACT SHA":
        fail(f"{label} historical failed-deployment confirmation differs")
    expected_resume = {
        key: failed_inputs[key] for key in (
            "build_run_id", "infrastructure_run_id", "checkpoint_source_sha",
            "disk_checkpoint_run_id", "baseline_recovery_run_id",
            "baseline_recovery_source_sha",
        )
    }
    if any(expected_resume[key] != dispatch_inputs[key] for key in expected_resume):
        fail(f"{label} historical deployment substituted the original release tuple")
    expected_resume.update({
        "approved_sha": source_sha, "resume_source_sha": failed_source,
        "prerequisite_run_id": failed_inputs["data_run_id"],
        "failed_deploy_run_id": failed_run, "phase": "apply-slip-index",
        "failed_activation_run_id": "0", "failed_activation_user_id": "0",
        "confirmation": "RESUME APPLIED LIVE DATA FROM RELEASED RUNTIME EXACT SHA",
    })
    resume_inputs = failed_deploy_native_inputs(
        repository, predecessor_run, source_sha, label, resume_dispatch=True,
    )
    if resume_inputs != expected_resume:
        fail(f"{label} successful predecessor native resume request differs")
    profile = "oci-failed-deploy-released-runtime-v1"
    outcomes = validate_failed_deploy_jobs(repository, failed_run, profile, label)
    historical_dispatch = dict(failed_inputs, prerequisite_run_id=failed_inputs["data_run_id"])
    historical_artifact = exact_artifact(
        repository, failed_run, f"oci-production-baseline-{failed_run}-1", label,
    )
    _, earlier = validate_failed_deploy_artifacts(
        repository, failed_run, failed_source, historical_artifact,
        historical_dispatch, runtime_mode, profile, *outcomes, label,
    )
    baseline_files = artifact_files(repository, historical_artifact, label)
    for key in (
        "build_run_id", "infrastructure_run_id", "checkpoint_source_sha",
        "disk_checkpoint_run_id", "disk_checkpoint_sha256", "disk_checkpoint_disposition",
        "baseline_sha256", "baseline_recovery_run_id", "baseline_recovery_source_sha",
    ):
        if predecessor[key] != earlier[key]:
            fail(f"{label} resumed predecessor substituted {key}")
    _, _, earlier_files = parse_live_v6_artifact(
        repository, earlier["workflow_run_id"], label, include_files=True,
    )
    earlier_authority = parse_resume_authority(earlier_files, earlier, label)
    if (
        earlier_authority is None
        or (authority["applied_data_run_id"], authority["applied_source_sha"])
        != (earlier_authority["applied_data_run_id"], earlier_authority["applied_source_sha"])
        or unique_artifact_file(predecessor_files, "resume-images.tsv", label)[1]
        != unique_artifact_file(earlier_files, "resume-images.tsv", label)[1]
    ):
        fail(f"{label} resumed predecessor substituted its original root or selected bytes")
    for prior, later in (
        (failed_metadata, predecessor_metadata),
        (predecessor_metadata, deployment_metadata),
        (deployment_metadata, activation_metadata),
    ):
        if parse_timestamp(prior.get("updated_at"), label) > parse_timestamp(
            later.get("created_at"), label,
        ):
            fail(f"{label} immediate released-activation chronology differs")
    return {
        "released_activation_qualification": "pre-arm-no-account",
        "resume_maintenance_mode": "released-runtime",
        "activation_deployment_run_id": deployment_run,
        "applied_data_run_id": authority["applied_data_run_id"],
        "applied_source_sha": authority["applied_source_sha"],
        "baseline_run_id": failed_run,
        "baseline_artifact_name": f"oci-production-baseline-{failed_run}-1",
        "_baseline_files": baseline_files,
    }


def validate_expired_handoff_resume(
    repository, run_id, subject_sha, dispatch_inputs, runtime_mode, label, *,
    successor_run_id="",
):
    qualified = expired_handoff_native_inputs(repository, run_id, runtime_mode, label)
    if qualified is None:
        return None
    native, failed = qualified
    predecessor_run = require_dispatch_run(dispatch_inputs, "prerequisite_run_id")
    expected_native = {
        key: dispatch_inputs[key] for key in (
            "build_run_id", "infrastructure_run_id", "checkpoint_source_sha",
            "disk_checkpoint_run_id", "baseline_recovery_run_id",
            "baseline_recovery_source_sha",
        )
    }
    expected_native.update({
        "approved_sha": subject_sha, "data_run_id": predecessor_run,
        "confirmation": "DEPLOY OCI EXACT SHA",
    })
    if (
        native != expected_native or failed["head_sha"] != subject_sha
        or dispatch_inputs.get("confirmation") != "RESUME APPLIED LIVE DATA EXACT SHA"
        or dispatch_inputs.get("failed_deploy_run_id") != run_id
        or dispatch_inputs.get("failed_activation_run_id") != "0"
        or dispatch_inputs.get("failed_activation_user_id") != "0"
        or dispatch_inputs.get("phase") != "apply-slip-index"
    ):
        fail(f"{label} expired receiver substituted its native release tuple")
    checkpoint = parse_checkpoint_artifact(repository, dispatch_inputs, runtime_mode, label)
    predecessor, _, files = parse_live_v6_artifact(
        repository, predecessor_run, label, include_files=True,
    )
    validate_live_v6_lineage(
        predecessor, checkpoint, dispatch_inputs, predecessor_run, subject_sha,
        "apply-slip-index", label,
    )
    held = require_fixed_run(
        repository, predecessor_run, "oci-live-data-rollout.yml", "success", subject_sha,
        f"oci-live-data apply-slip-index {subject_sha}", label,
    )
    request = failed_deploy_native_inputs(
        repository, predecessor_run, subject_sha, label, resume_dispatch=True,
    )
    if (
        request.get("approved_sha") != subject_sha or request.get("phase") != "apply-slip-index"
        or request.get("confirmation") !=
            "RESUME APPLIED LIVE DATA FROM RELEASED RUNTIME AND CLEAN FAILED ACTIVATION EXACT SHA"
        or request.get("failed_activation_user_id") != "0"
        or any(request.get(key) != dispatch_inputs[key] for key in (
            "build_run_id", "infrastructure_run_id", "checkpoint_source_sha",
            "disk_checkpoint_run_id", "baseline_recovery_run_id", "baseline_recovery_source_sha",
        ))
        or parse_resume_authority(files, predecessor, label) is not None
    ):
        fail(f"{label} expired holder does not preserve its released-activation history")
    activation_run = require_dispatch_run(request, "failed_activation_run_id")
    activation_source = require_dispatch_sha(request, "resume_source_sha")
    validate_descendant_scope(activation_source, subject_sha)
    activation_artifact = exact_artifact(
        repository, activation_run, f"oci-live-activation-recovery-{activation_run}-1", label,
    )
    ancestry = validate_released_activation_pre_arm(
        repository, activation_run, activation_source, activation_artifact, request,
        runtime_mode, label,
    )
    activation = require_fixed_run(
        repository, activation_run, "oci-live-betting-activate.yml", "failure",
        activation_source, f"oci-live-activate {activation_source}", label,
    )
    if (
        parse_timestamp(activation.get("updated_at"), label)
            > parse_timestamp(held.get("created_at"), label)
        or parse_timestamp(held.get("updated_at"), label)
            > parse_timestamp(failed.get("created_at"), label)
    ):
        fail(f"{label} expired-handoff predecessor chronology differs")
    validate_held_handoff_reports(files, predecessor)
    artifact_name = f"oci-live-data-baselines-{predecessor_run}-1"
    artifact = exact_artifact(repository, predecessor_run, artifact_name, label)
    baseline_files = original_before_baseline(artifact_files(repository, artifact, label), label)
    baseline_sha = validate_checksum_manifest(baseline_files, label)
    _, raw = unique_artifact_file(baseline_files, "baseline-provenance.env", label)
    baseline = parse_env(raw, label, BASELINE_PROVENANCE_KEYS)
    if (
        baseline_sha != predecessor["baseline_sha256"]
        or baseline["baseline_capture_run_id"] != predecessor_run
        or baseline["baseline_capture_run_attempt"] != "1"
        or baseline["baseline_source_sha"] != activation_source
        or baseline["baseline_deploy_run_id"] != ancestry["activation_deployment_run_id"]
        or baseline["baseline_deploy_run_attempt"] != "1"
        or baseline["registry_provider"] != "ghcr"
        or baseline["registry_host"] != "ghcr.io"
        or baseline["registry_repository"] != APPLICATION_REPOSITORY
        or baseline["registry_public_anonymous"] != "true"
    ):
        fail(f"{label} expired holder substituted its authenticated current capture")
    control = require_dispatch_sha(dispatch_inputs, "approved_sha")
    validate_descendant_scope(subject_sha, control)
    held_handoff_history(
        repository, held, control, successor_run_id,
        expired_receiver_run_id=run_id, runtime_mode=runtime_mode,
    )
    return {
        "resume_maintenance_mode": "pre-runtime-hold",
        "no_takeover_handoff_qualification": "expired-own-handoff",
        "baseline_run_id": predecessor_run, "baseline_artifact_name": artifact_name,
        "baseline_capture_run_id": predecessor_run,
        "baseline_capture_source_sha": baseline["baseline_source_sha"],
        "baseline_capture_deploy_run_id": baseline["baseline_deploy_run_id"],
        "baseline_sha256": baseline_sha,
        "applied_data_run_id": ancestry["applied_data_run_id"],
        "applied_source_sha": ancestry["applied_source_sha"],
        "_baseline_files": baseline_files,
    }


def validate_failed_activation_artifacts(
    repository,
    run_id,
    subject_sha,
    artifact,
    dispatch_inputs,
    runtime_mode,
    label,
):
    checkpoint = parse_checkpoint_artifact(
        repository, dispatch_inputs, runtime_mode, f"{label} checkpoint"
    )
    files = artifact_files(repository, artifact, label)
    validate_checksum_manifest(files, label)
    _, raw = unique_artifact_file(files, "provenance.env", label)
    activation = parse_env(raw, f"{label} provenance", ACTIVATION_PROVENANCE_KEYS)
    expected = {
        "source_sha": subject_sha,
        "build_run_id": require_dispatch_run(dispatch_inputs, "build_run_id"),
        "infrastructure_run_id": require_dispatch_run(
            dispatch_inputs, "infrastructure_run_id"
        ),
        "checkpoint_source_sha": checkpoint["sourceSha"],
        "disk_checkpoint_run_id": checkpoint["producerRunId"],
        "disk_checkpoint_sha256": checkpoint["contentChecksumSha256"],
        "disk_checkpoint_disposition": checkpoint["disposition"],
        "live_acceptance_user_id": str(
            dispatch_inputs.get("failed_activation_user_id", "")
        ),
        "activation_run_id": run_id,
        "activation_run_attempt": "1",
        "workflow_result": "failure",
        "activation_state": "dark",
        "live_kickoffs_enabled": "false",
    }
    for key, expected_value in expected.items():
        if activation.get(key) != expected_value:
            fail(f"{label} field {key} differs from the exact lineage")
    deployment_run = activation["deployment_run_id"]
    if POSITIVE_INTEGER.fullmatch(deployment_run) is None:
        fail(f"{label} deployment run is invalid")
    deployment_artifact = exact_artifact(
        repository,
        deployment_run,
        f"oci-deploy-provenance-{deployment_run}-1",
        f"{label} deployment",
    )
    deployment_files = artifact_files(
        repository, deployment_artifact, f"{label} deployment"
    )
    _, deployment_raw = unique_artifact_file(
        deployment_files, "provenance.txt", f"{label} deployment"
    )
    deployment_provenance = parse_env(
        deployment_raw,
        f"{label} deployment provenance",
        DEPLOYMENT_PROVENANCE_KEYS,
    )
    if deployment_provenance["source_sha"] != subject_sha:
        fail(f"{label} deployment source differs from activation source")
    predecessor_run = deployment_provenance["data_run_id"]
    if (
        POSITIVE_INTEGER.fullmatch(predecessor_run) is None
        or predecessor_run
        != require_dispatch_run(dispatch_inputs, "prerequisite_run_id")
    ):
        fail(f"{label} deployment substituted its v6 handoff")
    predecessor, predecessor_manifest_sha256, predecessor_files = (
        parse_live_v6_artifact(
            repository,
            predecessor_run,
            f"{label} predecessor",
            include_files=True,
        )
    )
    validate_live_v6_lineage(
        predecessor,
        checkpoint,
        dispatch_inputs,
        predecessor_run,
        subject_sha,
        "apply-slip-index",
        f"{label} predecessor",
    )
    predecessor_metadata = require_fixed_run(
        repository,
        predecessor_run,
        "oci-live-data-rollout.yml",
        "success",
        subject_sha,
        f"oci-live-data apply-slip-index {subject_sha}",
        f"{label} predecessor",
    )
    deployment_metadata = require_fixed_run(
        repository,
        deployment_run,
        "oci-production-deploy.yml",
        "success",
        subject_sha,
        f"oci-deploy {subject_sha}",
        f"{label} deployment",
    )
    parse_deployment_artifact(
        repository,
        deployment_run,
        subject_sha,
        dispatch_inputs,
        checkpoint,
        predecessor,
        predecessor_manifest_sha256,
        runtime_mode,
        f"{label} deployment",
    )
    if activation["deployment_run_id"] != deployment_run:
        fail(f"{label} activation deployment lineage is inconsistent")
    resume_authority = parse_resume_authority(
        predecessor_files, predecessor, f"{label} predecessor"
    )
    failed_deploy_input = str(dispatch_inputs.get("failed_deploy_run_id", ""))
    if failed_deploy_input == "0":
        if resume_authority is not None:
            fail(f"{label} omitted the predecessor failed deployment")
    elif resume_authority is not None and (
        resume_authority["resume_maintenance_mode"] == "pre-runtime-hold"
    ):
        if resume_authority["failed_deploy_run_id"] != failed_deploy_input:
            fail(f"{label} failed deployment lineage is inconsistent")
        validate_pre_runtime_resume_chain(repository, predecessor_run, runtime_mode)
    else:
        if (
            POSITIVE_INTEGER.fullmatch(failed_deploy_input) is None
            or resume_authority is None
            or resume_authority["failed_deploy_run_id"]
            != failed_deploy_input
        ):
            fail(f"{label} failed deployment lineage is inconsistent")
        applied_run = resume_authority["applied_data_run_id"]
        applied_source = resume_authority["applied_source_sha"]
        applied, applied_manifest_sha256 = parse_live_v6_artifact(
            repository, applied_run, f"{label} applied predecessor"
        )
        applied_metadata = require_fixed_run(
            repository,
            applied_run,
            "oci-live-data-rollout.yml",
            "success",
            applied_source,
            f"oci-live-data apply-slip-index {applied_source}",
            f"{label} applied predecessor",
        )
        historical_dispatch = dict(dispatch_inputs)
        historical_dispatch.update({
            "checkpoint_source_sha": applied["checkpoint_source_sha"],
            "disk_checkpoint_run_id": applied["disk_checkpoint_run_id"],
            "build_run_id": applied["build_run_id"],
            "infrastructure_run_id": applied["infrastructure_run_id"],
            "prerequisite_run_id": applied_run,
            "baseline_recovery_run_id": applied["baseline_recovery_run_id"],
            "baseline_recovery_source_sha":
                applied["baseline_recovery_source_sha"],
        })
        validate_live_v6_lineage(
            applied,
            checkpoint,
            historical_dispatch,
            applied_run,
            applied_source,
            "apply-slip-index",
            f"{label} applied predecessor",
        )
        for key in {
            "build_run_id",
            "infrastructure_run_id",
            "checkpoint_source_sha",
            "disk_checkpoint_run_id",
            "disk_checkpoint_sha256",
            "disk_checkpoint_disposition",
            "baseline_sha256",
            "baseline_recovery_run_id",
            "baseline_recovery_source_sha",
        }:
            if predecessor[key] != applied[key]:
                fail(f"{label} resumed predecessor substituted {key}")
        failed_metadata = fixed_run_metadata(
            repository,
            failed_deploy_input,
            "oci-production-deploy.yml",
            "failure",
            f"{label} failed deployment",
        )
        if (
            failed_metadata.get("head_sha") != applied_source
            or failed_metadata.get("display_title")
            != f"oci-deploy {applied_source}"
        ):
            fail(f"{label} failed deployment source lineage is invalid")
        failed_baseline = exact_artifact(
            repository,
            failed_deploy_input,
            f"oci-production-baseline-{failed_deploy_input}-1",
            f"{label} failed deployment",
        )
        failed_profile = (
            "oci-failed-deploy-retained-hold-v1"
            if resume_authority["resume_maintenance_mode"] == "retained-hold"
            else "oci-failed-deploy-released-runtime-v1"
        )
        lock_outcome, fence_outcome, rehold_outcome = (
            validate_failed_deploy_jobs(
                repository,
                failed_deploy_input,
                failed_profile,
                f"{label} failed deployment",
            )
        )
        validate_failed_deploy_artifacts(
            repository,
            failed_deploy_input,
            applied_source,
            failed_baseline,
            historical_dispatch,
            runtime_mode,
            failed_profile,
            lock_outcome,
            fence_outcome,
            rehold_outcome,
            f"{label} failed deployment",
        )
        if not (
            parse_timestamp(
                applied_metadata.get("updated_at"),
                f"{label} applied predecessor completion",
            )
            <= parse_timestamp(
                failed_metadata.get("created_at"),
                f"{label} failed deployment creation",
            )
            <= parse_timestamp(
                predecessor_metadata.get("created_at"),
                f"{label} predecessor creation",
            )
        ):
            fail(f"{label} failed-deployment recovery chronology is invalid")
    activation_metadata = gh_api(
        f"repos/{repository}/actions/runs/{run_id}"
    )
    if not (
        parse_timestamp(
            predecessor_metadata.get("updated_at"),
            f"{label} predecessor completion",
        )
        <= parse_timestamp(
            deployment_metadata.get("created_at"),
            f"{label} deployment creation",
        )
        <= parse_timestamp(
            activation_metadata.get("created_at"),
            f"{label} activation creation",
        )
    ):
        fail(f"{label} activation recovery chronology is invalid")
    checksum_files = {
        "activate_control_sha256": "activate/control.env",
        "acceptance_sha256": "acceptance/evidence.json",
        "accepted_sha256": "accepted.env",
        "commit_control_sha256": "commit/control.env",
        "failure_disable_sha256": "failure-disable/control.env",
        "final_disable_sha256": "final-failure-disable/control.env",
    }
    for key, relative in checksum_files.items():
        activation_file_checksum(files, relative, activation[key], label)
    final_file = activation["final_control_file"]
    if final_file == "none":
        if activation["final_control_sha256"] != "none":
            fail(f"{label} final control checksum has no file")
    else:
        prefix = "artifacts/live-control/"
        if not final_file.startswith(prefix):
            fail(f"{label} final control path is invalid")
        activation_file_checksum(
            files,
            final_file.removeprefix(prefix),
            activation["final_control_sha256"],
            label,
        )
    expected_relatives = {"provenance.env", "SHA256SUMS"}
    for key, relative in checksum_files.items():
        if activation[key] != "none":
            expected_relatives.add(relative)
    if final_file != "none":
        expected_relatives.add(final_file.removeprefix("artifacts/live-control/"))
    observed_relatives = set()
    for path in files:
        matches = [
            relative
            for relative in expected_relatives
            if path == relative or path.endswith("/" + relative)
        ]
        if len(matches) != 1 or matches[0] in observed_relatives:
            fail(f"{label} artifact has an unexpected file set")
        observed_relatives.add(matches[0])
    if observed_relatives != expected_relatives:
        fail(f"{label} artifact is incomplete")


def validate_failed_deploy_jobs(repository, run_id, profile, label):
    jobs = jobs_for_run(repository, run_id, label)
    deploy = exact_job(jobs, "deploy", label)
    public = exact_job(jobs, "public-validate", label)
    lock = step_conclusion(
        deploy, "Release transferred lock after protected validation", label
    )
    fence = step_conclusion(
        deploy, "Release live data maintenance fence", label
    )
    reenter = step_conclusion(
        deploy, "Re-enter maintenance after an incomplete deployment", label
    )
    if profile == "oci-failed-deploy-retained-hold-v1" and reenter == "skipped":
        metadata = fixed_run_metadata(
            repository, run_id, "oci-production-deploy.yml", "failure", label
        )
        source_sha = metadata["head_sha"]
        path = ".github/workflows/oci-production-deploy.yml"
        blob = subprocess.run(
            ["git", "show", f"{source_sha}:{path}"],
            capture_output=True, check=False,
        )
        if blob.returncode != 0:
            fail(f"{label} trusted failed workflow blob is unavailable")
        blob_sha = hashlib.sha1(
            f"blob {len(blob.stdout)}\0".encode() + blob.stdout
        ).hexdigest()
        if gh_api(f"repos/{repository}/contents/{path}?ref={source_sha}").get("sha") != blob_sha:
            fail(f"{label} native failed workflow blob differs")
        try:
            workflow = blob.stdout.decode("utf-8")
        except UnicodeDecodeError:
            fail(f"{label} trusted workflow is not UTF-8")
        if re.findall(r"(?m)^  ([a-z][a-z-]*):$", workflow.partition("\njobs:\n")[2]) != [
            "deploy", "public-validate"
        ]:
            fail(f"{label} trusted workflow job inventory changed")
        names = re.findall(
            r"(?m)^      - name: (.+)$",
            workflow.split("\n  public-validate:\n")[0],
        )
        boundary = "Verify immutable image and infrastructure provenance"
        if len(names) != len(set(names)) or names.count(boundary) != 1:
            fail(f"{label} trusted workflow step inventory is ambiguous")
        index = names.index(boundary)
        required_admissions = {
            "Initialize isolated OCI paths", "Checkout approved master commit",
            "Validate exact SHA and trusted upstream runs",
            "Download exact OCI image provenance",
            "Download exact OCI infrastructure provenance",
            "Download exact live data readiness evidence",
            "Download exact release disk checkpoint",
            "Download exact pre-mutation rollback baseline",
        }
        if set(names[:index]) != required_admissions:
            fail(f"{label} trusted pre-runtime admission inventory changed")
        expected = {
            name: "success" if offset < index else
            "failure" if offset == index else "skipped"
            for offset, name in enumerate(names)
        }
        expected.update({
            "Set up job": "success",
            "Post Checkout approved master commit": "success",
            "Complete job": "success",
            "Remove isolated OCI client state": "success",
            "Upload sanitized live readiness evidence": "success",
        })
        actual_names = [item.get("name") for item in deploy["steps"]]
        numbers = [item.get("number") for item in deploy["steps"]]
        if (
            len(jobs) != 2 or deploy.get("conclusion") != "failure"
            or deploy.get("status") != "completed"
            or public.get("conclusion") != "skipped"
            or public.get("status") != "completed" or public["steps"]
            or len(actual_names) != len(set(actual_names))
            or set(actual_names) != set(expected)
            or [name for name in actual_names if name in names] != names
            or not all(type(number) is int and number > 0 for number in numbers)
            or numbers != sorted(set(numbers))
        ):
            fail(f"{label} pre-runtime job/step inventory differs")
        for step in deploy["steps"]:
            if step.get("status") != "completed" or step["conclusion"] != expected[step["name"]]:
                fail(f"{label} pre-runtime step outcome differs")
        if artifact_inventory(repository, run_id, label):
            fail(f"{label} pre-runtime failed run must have zero artifacts")
        return lock, fence, reenter
    if profile == "oci-failed-deploy-retained-hold-v1":
        recovery_intent = step_conclusion(
            deploy,
            "Write checksum-bound deployment recovery intent",
            label,
        )
        recovery_finalize = step_conclusion(
            deploy,
            "Finalize deployment recovery authority",
            label,
        )
        recovery_upload = step_conclusion(
            deploy,
            "Upload deployment recovery authority",
            label,
        )
        if (
            deploy.get("conclusion") != "failure"
            or public.get("conclusion") != "skipped"
            or reenter != "success"
            or recovery_intent != "success"
            or recovery_finalize != "success"
            or recovery_upload != "success"
            or (lock, fence) not in {
                ("skipped", "skipped"),
                ("failure", "skipped"),
                ("success", "failure"),
            }
        ):
            fail("failed deployment does not match the retained-hold profile")
    elif (
        profile == "oci-failed-deploy-released-runtime-v1"
        and (
            deploy.get("conclusion") != "success"
            or public.get("conclusion") != "failure"
            or lock != "success"
            or fence != "success"
            or reenter != "skipped"
        )
    ):
        fail("failed deployment does not match the released-runtime profile")
    else:
        if profile != "oci-failed-deploy-released-runtime-v1":
            fail("failed deployment profile is invalid")
    return lock, fence, reenter


def validate_run_profile(
    repository,
    run_id,
    subject_sha,
    profile,
    label,
    artifact,
    dispatch_inputs,
    runtime_mode,
):
    if profile is None:
        return
    if profile in {
        "oci-failed-deploy-retained-hold-v1",
        "oci-failed-deploy-released-runtime-v1",
    }:
        lock, fence, reenter = validate_failed_deploy_jobs(
            repository, run_id, profile, label
        )
        validate_failed_deploy_artifacts(
            repository,
            run_id,
            subject_sha,
            artifact,
            dispatch_inputs,
            runtime_mode,
            profile,
            lock,
            fence,
            reenter,
            label,
        )
        return
    jobs = jobs_for_run(repository, run_id, label)
    activation = exact_job(jobs, "activate-and-validate", label)
    if (
        activation.get("conclusion") != "failure"
        or step_conclusion(
            activation, "Resolve reusable validation account", label
        ) != "success"
        or step_conclusion(
            activation, "Revoke and clean reusable validation account", label
        ) != "failure"
        or step_conclusion(
            activation, "Enforce dark mode unless activation committed", label
        ) != "success"
        or step_conclusion(
            activation, "Write final activation provenance", label
        ) != "success"
        or step_conclusion(
            activation, "Upload protected activation evidence", label
        ) != "success"
        or step_conclusion(
            activation, "Upload activation recovery authority", label
        ) != "success"
    ):
        fail("failed activation does not match the cleanup recovery profile")
    validate_failed_activation_artifacts(
        repository,
        run_id,
        subject_sha,
        artifact,
        dispatch_inputs,
        runtime_mode,
        label,
    )


def fixed_run_metadata(
    repository,
    run_id,
    workflow,
    conclusion,
    label,
    event="workflow_dispatch",
):
    workflow_metadata = gh_api(
        f"repos/{repository}/actions/workflows/{workflow}"
    )
    if not isinstance(workflow_metadata, dict) or type(
        workflow_metadata.get("id")
    ) is not int:
        fail(f"{label} workflow metadata is invalid")
    workflow_id = workflow_metadata["id"]
    base = gh_api(f"repos/{repository}/actions/runs/{run_id}")
    attempt = gh_api(
        f"repos/{repository}/actions/runs/{run_id}/attempts/1"
    )
    if not isinstance(base, dict) or not isinstance(attempt, dict):
        fail(f"{label} run metadata is invalid")
    expected_path = f".github/workflows/{workflow}"
    checks = {
        "id": (base.get("id"), int(run_id)),
        "workflow_id": (base.get("workflow_id"), workflow_id),
        "path": (base.get("path"), expected_path),
        "repository": (
            (base.get("head_repository") or {}).get("full_name"),
            repository,
        ),
        "head_branch": (base.get("head_branch"), "master"),
        "status": (base.get("status"), "completed"),
        "conclusion": (base.get("conclusion"), conclusion),
        "run_attempt": (base.get("run_attempt"), 1),
        "event": (base.get("event"), event),
    }
    for field, (observed, expected) in checks.items():
        if observed != expected:
            fail(
                f"{label} run {run_id} {field} is {observed!r}, "
                f"expected {expected!r}"
            )
    for field in {
        "id",
        "workflow_id",
        "path",
        "head_branch",
        "head_sha",
        "status",
        "conclusion",
        "run_attempt",
        "event",
        "display_title",
    }:
        if attempt.get(field) != base.get(field):
            fail(f"{label} first attempt {field} differs from the run")
    if (
        (attempt.get("head_repository") or {}).get("full_name")
        != repository
    ):
        fail(f"{label} first attempt repository differs from the run")
    head_sha = base.get("head_sha")
    if not isinstance(head_sha, str) or FULL_SHA.fullmatch(head_sha) is None:
        fail(f"{label} control SHA is invalid")
    return base


def validate_recovery_image_rows(raw, label):
    try:
        lines = raw.decode("utf-8").splitlines()
    except UnicodeDecodeError:
        fail(f"{label} images are not UTF-8")
    rows = {}
    digest = re.compile(r"^sha256:[0-9a-f]{64}$")
    for line in lines:
        fields = line.split("\t")
        if len(fields) != 5:
            fail(f"{label} images have an invalid schema")
        service, repository, image_ref, manifest, platform = fields
        if (
            service in rows
            or service not in RECOVERY_APPLICATION_SERVICES
            or repository != APPLICATION_REPOSITORY
            or image_ref != f"{repository}@{manifest}"
            or digest.fullmatch(manifest) is None
            or digest.fullmatch(platform) is None
        ):
            fail(f"{label} images are invalid")
        rows[service] = {
            "image_ref": image_ref,
            "manifest": manifest,
            "platform": platform,
        }
    if set(rows) != RECOVERY_APPLICATION_SERVICES:
        fail(f"{label} images do not contain the exact application services")
    return rows


def artifact_sibling_files(files, required_names, label):
    locations = {}
    for name in required_names:
        path, raw = unique_artifact_file(files, name, label)
        locations[name] = (path, raw)
    prefixes = {
        path.rsplit("/", 1)[0] if "/" in path else ""
        for path, _ in locations.values()
    }
    if len(prefixes) != 1:
        fail(f"{label} artifact has inconsistent evidence roots")
    return {name: raw for name, (_, raw) in locations.items()}


def validate_production_upstream_run(
    repository, run_id, source_sha, label
):
    metadata = fixed_run_metadata(
        repository,
        run_id,
        "production-build.yml",
        "success",
        label,
        "push",
    )
    if metadata.get("head_sha") != source_sha:
        fail(f"{label} source differs from the image build")


def validate_legacy_build_artifact(
    repository, run_id, source_sha, label
):
    metadata = fixed_run_metadata(
        repository,
        run_id,
        "oci-production-build.yml",
        "success",
        label,
        "workflow_run",
    )
    if metadata.get("head_sha") != source_sha:
        fail(f"{label} source differs")
    artifact = exact_artifact(
        repository,
        run_id,
        f"oci-image-provenance-{source_sha}-{run_id}-1",
        label,
    )
    files = artifact_files(repository, artifact, label)
    names = {"build-chain.txt"} | {
        f"{service}.env" for service in RECOVERY_APPLICATION_SERVICES
    }
    evidence = artifact_sibling_files(files, names, label)
    with tempfile.TemporaryDirectory(
        prefix=".upstream-binding-legacy-build-",
    ) as temporary:
        root = Path(temporary)
        for name, raw in evidence.items():
            (root / name).write_bytes(raw)
        helper = Path(__file__).with_name(
            "validate-legacy-oci-provenance.py"
        )
        result = subprocess.run(
            [sys.executable, str(helper), str(root), source_sha, run_id],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            fail(f"repository-fixed validator rejected {label}")
        match = re.fullmatch(
            r"TRUSTED_UPSTREAM_RUN_ID=([1-9][0-9]*)\n?",
            result.stdout,
        )
        if match is None:
            fail(f"{label} upstream build result is invalid")
    services = {}
    for service in RECOVERY_APPLICATION_SERVICES:
        values = parse_env(
            evidence[f"{service}.env"], f"{label} {service}"
        )
        services[service] = {
            "repository": values["repository"],
            "manifest": values["digest"],
            "platform": values["platform_digest"],
        }
    upstream_run = match.group(1)
    if (
        metadata.get("display_title")
        != f"oci-build {source_sha} upstream-{upstream_run}"
    ):
        fail(f"{label} title differs from its upstream build")
    validate_production_upstream_run(
        repository, upstream_run, source_sha, f"{label} upstream"
    )
    return services, upstream_run


def validate_current_build_artifact(
    repository, run_id, source_sha, label
):
    metadata = fixed_run_metadata(
        repository,
        run_id,
        "oci-production-build.yml",
        "success",
        label,
        "workflow_run",
    )
    if metadata.get("head_sha") != source_sha:
        fail(f"{label} source differs")
    artifact = exact_artifact(
        repository,
        run_id,
        f"oci-image-provenance-{source_sha}-{run_id}-1",
        label,
    )
    files = artifact_files(repository, artifact, label)
    names = {"build-chain.txt"} | {
        f"{service}.env" for service in RECOVERY_APPLICATION_SERVICES
    }
    evidence = artifact_sibling_files(files, names, label)
    chain = parse_env(evidence["build-chain.txt"], f"{label} build chain")
    chain_keys = {
        "source_sha",
        "upstream_workflow",
        "upstream_run_id",
        "upstream_run_attempt",
        "build_run_id",
        "build_run_attempt",
        "build_trigger_workflow",
        "build_trigger_run_id",
        "repair_mode",
        "image_mode",
        "platform",
        "registry_provider",
        "registry_host",
        "registry_repository",
        "registry_public",
        "anonymous_pull",
    }
    if chain.get("image_mode") == "reuse":
        chain_keys |= {"reuse_source_sha", "reuse_build_run_id"}
    if (
        set(chain) != chain_keys
        or chain["source_sha"] != source_sha
        or chain["upstream_workflow"] != "production-build"
        or POSITIVE_INTEGER.fullmatch(chain["upstream_run_id"]) is None
        or chain["upstream_run_attempt"] != "1"
        or chain["build_run_id"] != run_id
        or chain["build_run_attempt"] != "1"
        or chain["image_mode"] not in {"build", "reuse"}
        or chain["platform"] != "linux/arm64"
        or chain["registry_provider"] != "ghcr"
        or chain["registry_host"] != "ghcr.io"
        or chain["registry_repository"] != APPLICATION_REPOSITORY
        or chain["registry_public"] != "true"
        or chain["anonymous_pull"] != "pass"
    ):
        fail(f"{label} build chain is invalid")
    with tempfile.TemporaryDirectory(
        prefix=".upstream-binding-current-build-",
    ) as temporary:
        root = Path(temporary)
        for name, raw in evidence.items():
            (root / name).write_bytes(raw)
        output = root / "validated-images.tsv"
        helper = Path(__file__).with_name("verify-images.sh")
        environment = os.environ.copy()
        environment.update({
            "PROVENANCE_DIR": str(root),
            "SOURCE_SHA": source_sha,
            "OUTPUT_FILE": str(output),
            "VERIFY_REMOTE": "0",
            "BOOT_IMAGES": "0",
            "EXPECTED_BUILD_RUN_ID": run_id,
            "EXPECTED_BUILD_RUN_ATTEMPT": "1",
            "EXPECTED_UPSTREAM_RUN_ID": chain["upstream_run_id"],
            "GENERATION_PROFILE": "compatible",
        })
        result = subprocess.run(
            [str(helper)],
            capture_output=True,
            text=True,
            check=False,
            env=environment,
        )
        if result.returncode != 0:
            fail(f"repository-fixed validator rejected {label}")
        images = validate_recovery_image_rows(
            b"\n".join(
                line
                for line in output.read_bytes().splitlines()
                if not line.startswith(b"telemetry\t")
            )
            + b"\n",
            label,
        )
    validate_production_upstream_run(
        repository,
        chain["upstream_run_id"],
        source_sha,
        f"{label} upstream",
    )
    if (
        metadata.get("display_title")
        != f"oci-build {source_sha} upstream-{chain['upstream_run_id']}"
    ):
        fail(f"{label} title differs from its upstream build")
    return images


def validate_infrastructure_artifact(
    repository,
    run_id,
    expected_hash,
    runtime_mode,
    runtime_fingerprint,
    endpoints,
    label,
):
    metadata = fixed_run_metadata(
        repository,
        run_id,
        "oci-infrastructure.yml",
        "success",
        label,
    )
    artifact = exact_artifact(
        repository,
        run_id,
        f"oci-infrastructure-provenance-{run_id}-1",
        label,
    )
    raw = artifact_member(repository, artifact, "provenance.env", label)
    if hashlib.sha256(raw).hexdigest() != expected_hash:
        fail(f"{label} provenance checksum differs")
    values = parse_env(raw, f"{label} provenance")
    source_sha = values.get("source_sha")
    fingerprint_key = (
        "cluster_fingerprint"
        if runtime_mode == "oke"
        else "instance_fingerprint"
    )
    expected = {
        "source_sha": metadata.get("head_sha"),
        "infrastructure_run_id": run_id,
        "infrastructure_run_attempt": "1",
        "runtime_mode": runtime_mode,
        fingerprint_key: runtime_fingerprint,
        **endpoints,
    }
    for key, expected_value in expected.items():
        if values.get(key) != expected_value:
            fail(f"{label} substituted {key}")
    allowed_titles = {
        f"oci-infrastructure finalize {runtime_mode} {source_sha}",
        f"oci-infrastructure finalize {source_sha}",
    }
    if metadata.get("display_title") not in allowed_titles:
        fail(f"{label} title differs from its finalized source")
    return source_sha


def validate_cache_plan_artifact(
    repository,
    run_id,
    source_sha,
    plan_raw,
    rabbit_raw,
    expected_origin,
    label,
):
    artifact = exact_artifact(
        repository,
        run_id,
        f"ghcr-cache-recovery-plan-{source_sha}-{run_id}-1",
        label,
    )
    files = artifact_files(repository, artifact, label)
    expected = {
        "transition-plan.tsv",
        "rabbitmq-baseline.txt",
        "transition-plan-evidence.env",
    }
    if (
        {path.rsplit("/", 1)[-1] for path in files} != expected
        or len(files) != len(expected)
    ):
        fail(f"{label} artifact has an unexpected file set")
    siblings = artifact_sibling_files(files, expected, label)
    if (
        siblings["transition-plan.tsv"] != plan_raw
        or siblings["rabbitmq-baseline.txt"] != rabbit_raw
    ):
        fail(f"{label} plan payload differs")
    evidence = parse_env(
        siblings["transition-plan-evidence.env"],
        f"{label} evidence",
        {
            "schema",
            "source_sha",
            "plan_origin_recovery_run_id",
            "plan_carrier_recovery_run_id",
            "plan_carrier_recovery_run_attempt",
            "images_sha256",
            "infrastructure_provenance_sha256",
            "transition_plan_sha256",
            "rabbitmq_baseline_sha256",
        },
    )
    if (
        evidence["schema"] != "betstan.ghcr-cache-transition-plan.v1"
        or evidence["source_sha"] != source_sha
        or evidence["plan_origin_recovery_run_id"] != expected_origin
        or evidence["plan_carrier_recovery_run_id"] != run_id
        or evidence["plan_carrier_recovery_run_attempt"] != "1"
        or evidence["transition_plan_sha256"]
        != hashlib.sha256(plan_raw).hexdigest()
        or evidence["rabbitmq_baseline_sha256"]
        != hashlib.sha256(rabbit_raw).hexdigest()
    ):
        fail(f"{label} evidence is invalid")
    return evidence


def parse_tsv(raw, width, label, *, allow_empty=False):
    try:
        lines = raw.decode("utf-8").splitlines()
    except UnicodeDecodeError:
        fail(f"{label} is not UTF-8")
    rows = [line.split("\t") for line in lines]
    if (
        (not rows and not allow_empty)
        or any(len(row) != width for row in rows)
    ):
        fail(f"{label} is malformed")
    return rows


def validate_failed_partial_rollback_artifact(
    repository,
    run_id,
    source_sha,
    target_sha,
    restored_images,
    recovery_plan,
    recovered_telemetry,
    label,
):
    failed = fixed_run_metadata(
        repository,
        run_id,
        "oci-production-rollback.yml",
        "failure",
        label,
    )
    if (
        failed.get("head_sha") != source_sha
        or failed.get("display_title") != f"oci-rollback {target_sha}"
    ):
        fail(f"{label} target title differs")
    artifact = exact_artifact(
        repository,
        run_id,
        f"oci-production-rollback-{run_id}-1",
        label,
    )
    files = artifact_files(repository, artifact, label)
    required = {
        "failure-state.env",
        "pre-rollback-state.tsv",
        "partial-state.tsv",
        "rollout-order.tsv",
        "baseline-provenance.env",
        "telemetry-pre-run.env",
    }
    evidence = {
        name: unique_artifact_file(files, name, label)[1]
        for name in required
    }
    failure = parse_env(
        evidence["failure-state.env"], f"{label} failure state"
    )
    failed_service = failure.get("failed_service")
    service_order = [
        "auth",
        "bet",
        "backoffice",
        "client",
        "event",
        "moderation",
        "resulting",
        "slip",
        "gamemaster",
    ]
    if (
        failure.get("status") != "FAIL"
        or failed_service not in set(service_order) | {"post-rollback"}
        or failure.get("rollback_http_mutation_fence")
        not in {"active", "not-required", "legacy-not-recorded"}
    ):
        fail(f"{label} failure state is invalid")
    if failed_service in service_order and (
        failure.get("failed_deployment")
        != f"gaming-{failed_service}-depl"
        or failure.get("failed_step_label") != f"failed-{failed_service}"
    ):
        fail(f"{label} failed service lineage is invalid")
    baseline = parse_env(
        evidence["baseline-provenance.env"], f"{label} baseline"
    )
    if baseline.get("baseline_source_sha") != target_sha:
        fail(f"{label} baseline target differs")

    pre_rows = parse_tsv(
        evidence["pre-rollback-state.tsv"], 5, f"{label} pre-rollback state"
    )
    partial_rows = parse_tsv(
        evidence["partial-state.tsv"], 3, f"{label} partial state"
    )
    if (
        [row[0] for row in pre_rows] != service_order
        or [row[0] for row in partial_rows] != service_order
    ):
        fail(f"{label} service order is invalid")
    pre = {row[0]: row for row in pre_rows}
    partial = {row[0]: row for row in partial_rows}
    image_pattern = re.compile(
        r"^ghcr\.io/vasilyevstan/betstan-images@sha256:[0-9a-f]{64}$"
    )
    for service in service_order:
        if (
            pre[service][1] != f"gaming-{service}-depl"
            or image_pattern.fullmatch(pre[service][2]) is None
            or image_pattern.fullmatch(partial[service][1]) is None
            or pre[service][2] != restored_images[service]["image_ref"]
        ):
            fail(f"{label} {service} pre-rollback image lineage is invalid")
    order = [
        row[0]
        for row in parse_tsv(
            evidence["rollout-order.tsv"], 1, f"{label} rollout order"
        )
    ]
    if (
        len(order) != len(set(order))
        or order != service_order[:len(order)]
        or (
            failed_service in service_order
            and (not order or order[-1] != failed_service)
        )
        or (failed_service == "post-rollback" and order != service_order)
    ):
        fail(f"{label} rollout order is invalid")
    for service in service_order[len(order):]:
        if pre[service][2] != partial[service][1]:
            fail(f"{label} unattempted service changed")
    if (
        failed_service in service_order
        and pre[failed_service][2] == partial[failed_service][1]
    ):
        fail(f"{label} failed service did not change")
    changed_services = [
        service
        for service in reversed(order)
        if pre[service][2] != partial[service][1]
    ]
    if (
        [row[0] for row in recovery_plan] != changed_services
        or any(
            row[2] != pre[row[0]][2]
            or row[3] != partial[row[0]][1]
            for row in recovery_plan
        )
    ):
        fail(f"{label} recovery plan differs from the failed partial state")

    telemetry = parse_env(
        evidence["telemetry-pre-run.env"], f"{label} telemetry"
    )
    if (
        telemetry.get("mode") != "retained"
        or telemetry.get("image") != recovered_telemetry.get("image")
        or telemetry.get("database_initialized")
        != recovered_telemetry.get("database_initialized")
        or telemetry.get("queue_present") != "true"
        or recovered_telemetry.get("queue_present") != "true"
    ):
        fail(f"{label} telemetry lineage differs")
    return failed


def validate_cache_recovery_artifact(
    repository,
    run_id,
    source_sha,
    artifact,
    label,
):
    files = artifact_files(repository, artifact, label)
    validate_checksum_manifest(files, label)
    expected_files = {
        "SHA256SUMS",
        "images.tsv",
        "recovery-evidence.env",
        "transition-plan.tsv",
        "transition-plan-evidence.env",
        "rabbitmq-baseline.txt",
        "rebind-provenance.env",
        "transition-provenance.env",
    } | {f"{service}.env" for service in RECOVERY_APPLICATION_SERVICES}
    relatives = {path.rsplit("/", 1)[-1] for path in files}
    if relatives != expected_files or len(files) != len(expected_files):
        fail(f"{label} artifact has an unexpected file set")

    _, images_raw = unique_artifact_file(files, "images.tsv", label)
    images = validate_recovery_image_rows(images_raw, label)
    image_hash = hashlib.sha256(images_raw).hexdigest()
    _, evidence_raw = unique_artifact_file(
        files, "recovery-evidence.env", label
    )
    evidence = parse_env(
        evidence_raw,
        f"{label} recovery evidence",
        {
            "schema",
            "recovery_origin",
            "registry_provider",
            "registry_repository",
            "anonymous_pull",
            "source_sha",
            "trusted_build_run_id",
            "trusted_upstream_run_id",
            "recovery_run_id",
            "recovery_run_attempt",
            "images_sha256",
        },
    )
    if (
        evidence["schema"] != "betstan.ghcr-cache-recovery.v1"
        or evidence["recovery_origin"] != "containerd-cache"
        or evidence["registry_provider"] != "ghcr"
        or evidence["registry_repository"] != APPLICATION_REPOSITORY
        or evidence["anonymous_pull"] != "pass"
        or evidence["source_sha"] != source_sha
        or evidence["recovery_run_id"] != run_id
        or evidence["recovery_run_attempt"] != "1"
        or evidence["images_sha256"] != image_hash
        or POSITIVE_INTEGER.fullmatch(
            evidence["trusted_build_run_id"]
        ) is None
        or POSITIVE_INTEGER.fullmatch(
            evidence["trusted_upstream_run_id"]
        ) is None
    ):
        fail(f"{label} recovery evidence is invalid")

    service_keys = {
        "schema",
        "registry_provider",
        "registry_host",
        "registry_tag_prefix",
        "registry_tag_schema",
        "service",
        "repository",
        "source_sha",
        "tag",
        "digest",
        "platform_digest",
        "image_ref",
        "platform",
        "build_workflow",
        "build_run_id",
        "build_run_attempt",
        "upstream_workflow",
        "upstream_run_id",
        "upstream_run_attempt",
        "recovery_workflow",
        "recovery_run_id",
        "recovery_run_attempt",
        "recovery_origin",
        "recovery_origin_repository",
        "recovery_origin_manifest_digest",
        "recovery_origin_platform_digest",
    }
    digest = re.compile(r"^sha256:[0-9a-f]{64}$")
    service_provenance = {}
    for service, image in images.items():
        _, raw = unique_artifact_file(files, f"{service}.env", label)
        values = parse_env(raw, f"{label} {service} provenance", service_keys)
        if (
            values["schema"] != "betstan.application-image-provenance.v1"
            or values["registry_provider"] != "ghcr"
            or values["registry_host"] != "ghcr.io"
            or values["registry_tag_prefix"] != "arm64"
            or values["registry_tag_schema"] != "v1"
            or values["service"] != service
            or values["repository"] != APPLICATION_REPOSITORY
            or values["source_sha"] != source_sha
            or values["tag"]
            != f"{APPLICATION_REPOSITORY}:{service}-{source_sha}-arm64"
            or values["digest"] != image["manifest"]
            or values["platform_digest"] != image["platform"]
            or values["image_ref"] != image["image_ref"]
            or values["platform"] != "linux/arm64"
            or values["build_workflow"] != "oci-production-build"
            or values["build_run_id"] != evidence["trusted_build_run_id"]
            or values["build_run_attempt"] != "1"
            or values["upstream_workflow"] != "production-build"
            or values["upstream_run_id"]
            != evidence["trusted_upstream_run_id"]
            or values["upstream_run_attempt"] != "1"
            or values["recovery_workflow"] != "oci-ghcr-cache-recovery"
            or values["recovery_run_id"] != run_id
            or values["recovery_run_attempt"] != "1"
            or values["recovery_origin"] != "containerd-cache"
            or not values["recovery_origin_repository"]
            or digest.fullmatch(
                values["recovery_origin_manifest_digest"]
            ) is None
            or values["recovery_origin_platform_digest"] != image["platform"]
        ):
            fail(f"{label} {service} provenance is invalid")
        service_provenance[service] = values

    transition_keys = {
        "schema",
        "transition_workflow",
        "transition_run_id",
        "transition_run_attempt",
        "source_sha",
        "images_sha256",
        "infrastructure_run_id",
        "infrastructure_run_attempt",
        "infrastructure_provenance_sha256",
        "runtime_mode",
        "runtime_fingerprint",
        "registry_provider",
        "registry_host",
        "registry_repository",
        "registry_public_anonymous",
        "public_host",
        "canonical_host",
        "redirect_host",
        "diagnostic_host",
        "transition_plan_state_sha256",
        "rabbitmq_baseline_sha256",
        "credential_retirement",
        "ocir_repository_retirement",
        "transition_status",
    }
    _, transition_raw = unique_artifact_file(
        files, "transition-provenance.env", label
    )
    transition = parse_env(
        transition_raw, f"{label} transition provenance", transition_keys
    )
    if (
        transition["schema"]
        != "betstan.ghcr-cache-recovery-transition.v1"
        or transition["transition_workflow"] != "oci-ghcr-cache-recovery"
        or transition["transition_run_id"] != run_id
        or transition["transition_run_attempt"] != "1"
        or transition["source_sha"] != source_sha
        or transition["images_sha256"] != image_hash
        or transition["runtime_mode"] != "k3s"
        or transition["registry_provider"] != "ghcr"
        or transition["registry_host"] != "ghcr.io"
        or transition["registry_repository"] != APPLICATION_REPOSITORY
        or transition["registry_public_anonymous"] != "true"
        or transition["credential_retirement"] != "pass"
        or transition["ocir_repository_retirement"] != "pass"
        or transition["transition_status"] != "PASS"
    ):
        fail(f"{label} transition provenance is invalid")
    for key in {
        "infrastructure_provenance_sha256",
        "runtime_fingerprint",
        "transition_plan_state_sha256",
        "rabbitmq_baseline_sha256",
    }:
        if re.fullmatch(r"[0-9a-f]{64}", transition[key]) is None:
            fail(f"{label} transition hash is invalid")
    if (
        POSITIVE_INTEGER.fullmatch(transition["infrastructure_run_id"])
        is None
        or transition["infrastructure_run_attempt"] != "1"
    ):
        fail(f"{label} transition infrastructure lineage is invalid")
    for key in {
        "public_host",
        "canonical_host",
        "redirect_host",
        "diagnostic_host",
    }:
        if re.fullmatch(r"[A-Za-z0-9.-]+", transition[key]) is None:
            fail(f"{label} transition endpoint is invalid")
    if transition["canonical_host"] != transition["public_host"]:
        fail(f"{label} transition canonical endpoint differs")

    _, plan_raw = unique_artifact_file(
        files, "transition-plan.tsv", label
    )
    plan_rows = {}
    try:
        plan_lines = plan_raw.decode("utf-8").splitlines()
    except UnicodeDecodeError:
        fail(f"{label} transition plan is not UTF-8")
    for line in plan_lines:
        fields = line.split("\t")
        if len(fields) != 5:
            fail(f"{label} transition plan is malformed")
        service, old_ref, new_ref, platform, state = fields
        if (
            service in plan_rows
            or service not in RECOVERY_APPLICATION_SERVICES
            or new_ref != images[service]["image_ref"]
            or platform != images[service]["platform"]
            or re.fullmatch(
                r"[A-Za-z0-9./_-]+@sha256:[0-9a-f]{64}",
                old_ref,
            )
            is None
            or state not in {"pending", "already-ghcr"}
        ):
            fail(f"{label} transition plan is invalid")
        plan_rows[service] = fields
    if set(plan_rows) != RECOVERY_APPLICATION_SERVICES:
        fail(f"{label} transition plan service set is incomplete")
    plan_hash = hashlib.sha256(plan_raw).hexdigest()
    _, rabbit_raw = unique_artifact_file(
        files, "rabbitmq-baseline.txt", label
    )
    rabbit_hash = hashlib.sha256(rabbit_raw).hexdigest()
    if (
        transition["transition_plan_state_sha256"] != plan_hash
        or transition["rabbitmq_baseline_sha256"] != rabbit_hash
    ):
        fail(f"{label} transition plan hashes differ")

    _, plan_evidence_raw = unique_artifact_file(
        files, "transition-plan-evidence.env", label
    )
    plan_evidence = parse_env(
        plan_evidence_raw,
        f"{label} transition plan evidence",
        {
            "schema",
            "source_sha",
            "plan_origin_recovery_run_id",
            "plan_carrier_recovery_run_id",
            "plan_carrier_recovery_run_attempt",
            "images_sha256",
            "infrastructure_provenance_sha256",
            "transition_plan_sha256",
            "rabbitmq_baseline_sha256",
        },
    )
    if (
        plan_evidence["schema"]
        != "betstan.ghcr-cache-transition-plan.v1"
        or plan_evidence["source_sha"] != source_sha
        or POSITIVE_INTEGER.fullmatch(
            plan_evidence["plan_origin_recovery_run_id"]
        )
        is None
        or POSITIVE_INTEGER.fullmatch(
            plan_evidence["plan_carrier_recovery_run_id"]
        )
        is None
        or plan_evidence["plan_carrier_recovery_run_id"] != run_id
        or plan_evidence["plan_carrier_recovery_run_attempt"] != "1"
        or plan_evidence["images_sha256"] != image_hash
        or plan_evidence["infrastructure_provenance_sha256"]
        != transition["infrastructure_provenance_sha256"]
        or plan_evidence["transition_plan_sha256"] != plan_hash
        or plan_evidence["rabbitmq_baseline_sha256"] != rabbit_hash
    ):
        fail(f"{label} transition plan evidence is invalid")

    _, rebind_raw = unique_artifact_file(
        files, "rebind-provenance.env", label
    )
    rebind = parse_env(
        rebind_raw,
        f"{label} rebind provenance",
        {
            "schema",
            "transition_workflow",
            "recovery_run_id",
            "recovery_run_attempt",
            "source_sha",
            "images_sha256",
            "infrastructure_run_id",
            "infrastructure_run_attempt",
            "infrastructure_provenance_sha256",
            "runtime_mode",
            "runtime_fingerprint",
            "registry_provider",
            "registry_host",
            "registry_repository",
            "registry_public_anonymous",
            "public_host",
            "canonical_host",
            "redirect_host",
            "diagnostic_host",
            "transition_plan_state_sha256",
            "rabbitmq_baseline_sha256",
            "transition_plan_evidence_sha256",
            "plan_origin_recovery_run_id",
            "credential_retirement",
            "transition_status",
        },
    )
    shared_keys = {
        "source_sha",
        "images_sha256",
        "infrastructure_run_id",
        "infrastructure_run_attempt",
        "infrastructure_provenance_sha256",
        "runtime_mode",
        "runtime_fingerprint",
        "registry_provider",
        "registry_host",
        "registry_repository",
        "registry_public_anonymous",
        "public_host",
        "canonical_host",
        "redirect_host",
        "diagnostic_host",
        "transition_plan_state_sha256",
        "rabbitmq_baseline_sha256",
    }
    if (
        rebind["schema"] != "betstan.ghcr-cache-recovery-rebind.v1"
        or rebind["transition_workflow"] != "oci-ghcr-cache-recovery"
        or rebind["recovery_run_id"] != run_id
        or rebind["recovery_run_attempt"] != "1"
        or any(rebind[key] != transition[key] for key in shared_keys)
        or rebind["transition_plan_evidence_sha256"]
        != hashlib.sha256(plan_evidence_raw).hexdigest()
        or rebind["plan_origin_recovery_run_id"]
        != plan_evidence["plan_origin_recovery_run_id"]
        or rebind["credential_retirement"] != "pending"
        or rebind["transition_status"] != "REBIND_VERIFIED"
    ):
        fail(f"{label} rebind provenance is invalid")

    current_plan_evidence = validate_cache_plan_artifact(
        repository,
        run_id,
        source_sha,
        plan_raw,
        rabbit_raw,
        plan_evidence["plan_origin_recovery_run_id"],
        f"{label} plan carrier",
    )
    if current_plan_evidence != plan_evidence:
        fail(f"{label} plan carrier evidence differs from final evidence")
    origin_run = plan_evidence["plan_origin_recovery_run_id"]
    if origin_run != run_id:
        origin_base = gh_api(f"repos/{repository}/actions/runs/{origin_run}")
        origin_conclusion = (
            origin_base.get("conclusion")
            if isinstance(origin_base, dict)
            else None
        )
        if origin_conclusion not in {"failure", "cancelled"}:
            fail(f"{label} plan origin is not a failed or cancelled run")
        origin_metadata = fixed_run_metadata(
            repository,
            origin_run,
            "oci-ghcr-cache-recovery.yml",
            origin_conclusion,
            f"{label} plan origin",
        )
        if (
            origin_metadata.get("display_title")
            != f"oci-ghcr-cache-recovery {source_sha}"
        ):
            fail(f"{label} plan origin title differs")
        origin_evidence = validate_cache_plan_artifact(
            repository,
            origin_run,
            source_sha,
            plan_raw,
            rabbit_raw,
            origin_run,
            f"{label} plan origin",
        )
        for key in {
            "schema",
            "source_sha",
            "plan_origin_recovery_run_id",
            "images_sha256",
            "infrastructure_provenance_sha256",
            "transition_plan_sha256",
            "rabbitmq_baseline_sha256",
        }:
            if origin_evidence[key] != plan_evidence[key]:
                fail(f"{label} plan origin substituted {key}")

    infrastructure_source = validate_infrastructure_artifact(
        repository,
        transition["infrastructure_run_id"],
        transition["infrastructure_provenance_sha256"],
        transition["runtime_mode"],
        transition["runtime_fingerprint"],
        {
            "public_host": transition["public_host"],
            "canonical_host": transition["canonical_host"],
            "redirect_host": transition["redirect_host"],
            "diagnostic_host": transition["diagnostic_host"],
        },
        f"{label} infrastructure",
    )
    if infrastructure_source != source_sha:
        fail(f"{label} infrastructure source differs")

    build_run = evidence["trusted_build_run_id"]
    legacy_services, upstream_run = validate_legacy_build_artifact(
        repository,
        build_run,
        source_sha,
        f"{label} historical build",
    )
    if upstream_run != evidence["trusted_upstream_run_id"]:
        fail(f"{label} trusted upstream build differs")
    for service, values in service_provenance.items():
        legacy = legacy_services[service]
        if (
            values["recovery_origin_repository"] != legacy["repository"]
            or values["recovery_origin_manifest_digest"]
            != legacy["manifest"]
            or values["recovery_origin_platform_digest"]
            != legacy["platform"]
        ):
            fail(f"{label} {service} recovery origin differs from the build")


def validate_partial_recovery_artifact(
    repository,
    run_id,
    source_sha,
    artifact,
    metadata,
    label,
):
    files = artifact_files(
        repository,
        artifact,
        label,
        allowed_empty_suffixes={"rollback-readiness/failures.txt"},
    )
    manifest_path, _ = unique_artifact_file(
        files, "partial-recovery-SHA256SUMS", label
    )
    prefix = (
        manifest_path.rsplit("/", 1)[0] + "/"
        if "/" in manifest_path
        else ""
    )
    expected_relatives = {
        "images.tsv",
        "partial-recovery-authority.env",
        "partial-recovery-summary.env",
        "recovery-plan.tsv",
        "recovery-rollout-order.tsv",
        "final-state.tsv",
        "rollback-readiness/summary.env",
        "rollback-readiness/workload-state.tsv",
        "rollback-readiness/failures.txt",
        "telemetry-recovery.env",
        "partial-recovery-SHA256SUMS",
    }
    relatives = {
        path[len(prefix):]
        for path in files
        if path.startswith(prefix)
    }
    if (
        len(relatives) != len(files)
        or relatives != expected_relatives
    ):
        fail(f"{label} artifact has an unexpected file set")
    with tempfile.TemporaryDirectory(
        prefix=".upstream-binding-recovery-",
    ) as temporary:
        root = Path(temporary)
        for path, raw in files.items():
            if not path.startswith(prefix):
                fail(f"{label} artifact has inconsistent paths")
            relative = path[len(prefix):]
            destination = root / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(raw)
        helper = Path(__file__).with_name(
            "validate-partial-recovery-authority-stan.sh"
        )
        environment = os.environ.copy()
        environment.update(
            {
                "PARTIAL_RECOVERY_DIR": str(root),
                "EXPECTED_RECOVERY_RUN_ID": run_id,
                "EXPECTED_SOURCE_SHA": source_sha,
            }
        )
        result = subprocess.run(
            [str(helper)],
            capture_output=True,
            text=True,
            check=False,
            env=environment,
        )
        if result.returncode != 0:
            fail(f"repository-fixed validator rejected {label}")
        authority = parse_env(
            (root / "partial-recovery-authority.env").read_bytes(),
            f"{label} authority",
        )
    if (
        authority.get("recovery_run_id") != run_id
        or authority.get("recovery_head_sha") != metadata.get("head_sha")
        or authority.get("restored_source_sha") != source_sha
        or metadata.get("display_title")
        != f"oci-rollback {authority.get('target_sha')}"
    ):
        fail(f"{label} metadata differs from its recovery authority")

    _, images_raw = unique_artifact_file(files, "images.tsv", label)
    recovered_images = validate_recovery_image_rows(images_raw, label)
    build_run = authority.get("restored_build_run_id", "")
    build_images = validate_current_build_artifact(
        repository,
        build_run,
        source_sha,
        f"{label} restored build",
    )
    if build_images != recovered_images:
        fail(f"{label} restored images differ from the selected build")

    infrastructure_source = validate_infrastructure_artifact(
        repository,
        authority["infrastructure_run_id"],
        authority["infrastructure_provenance_sha256"],
        authority["runtime_mode"],
        authority["runtime_fingerprint"],
        {
            "public_host": authority["public_host"],
            "canonical_host": authority["canonical_host"],
            "redirect_host": authority["redirect_host"],
            "diagnostic_host": authority["diagnostic_host"],
        },
        f"{label} infrastructure",
    )
    if infrastructure_source != source_sha:
        fail(f"{label} infrastructure source differs")
    _, recovery_plan_raw = unique_artifact_file(
        files, "recovery-plan.tsv", label
    )
    recovery_plan = parse_tsv(
        recovery_plan_raw, 4, f"{label} recovery plan"
    )
    _, telemetry_raw = unique_artifact_file(
        files, "telemetry-recovery.env", label
    )
    recovered_telemetry = parse_env(
        telemetry_raw, f"{label} recovered telemetry"
    )
    failed_run = authority.get("source_rollback_run_id", "")
    failed = validate_failed_partial_rollback_artifact(
        repository,
        failed_run,
        source_sha,
        authority["target_sha"],
        recovered_images,
        recovery_plan,
        recovered_telemetry,
        f"{label} failed rollback",
    )
    if not (
        parse_timestamp(
            failed.get("updated_at"), f"{label} failed rollback completion"
        )
        <= parse_timestamp(
            metadata.get("created_at"), f"{label} recovery creation"
        )
    ):
        fail(f"{label} failed rollback chronology is invalid")


def validate_baseline_recovery_profile(
    repository,
    dispatch_inputs,
    subject_sha,
):
    run_id = str(dispatch_inputs.get("baseline_recovery_run_id", ""))
    source_sha = dispatch_inputs.get("baseline_recovery_source_sha")
    if not run_id and source_sha is None:
        return
    if run_id == "0":
        if source_sha != "none":
            fail("zero baseline recovery run requires source none")
        return
    if (
        POSITIVE_INTEGER.fullmatch(run_id) is None
        or not isinstance(source_sha, str)
        or FULL_SHA.fullmatch(source_sha) is None
    ):
        fail("baseline recovery run and source are invalid")

    candidates = (
        (
            "oci-ghcr-cache-recovery.yml",
            f"ghcr-cache-recovery-{source_sha}-{run_id}-1",
            f"oci-ghcr-cache-recovery {source_sha}",
            "cache",
        ),
        (
            "oci-production-rollback.yml",
            f"oci-production-rollback-{run_id}-1",
            None,
            "partial",
        ),
    )
    selected = None
    for workflow, artifact_name, title, kind in candidates:
        workflow_metadata = gh_api(
            f"repos/{repository}/actions/workflows/{workflow}"
        )
        if not isinstance(workflow_metadata, dict) or type(
            workflow_metadata.get("id")
        ) is not int:
            fail("baseline recovery workflow metadata is invalid")
        base = gh_api(f"repos/{repository}/actions/runs/{run_id}")
        if base.get("workflow_id") == workflow_metadata["id"]:
            selected = (workflow, artifact_name, title, kind)
            break
    if selected is None:
        fail("baseline recovery run is not a fixed trusted workflow")
    workflow, artifact_name, title, kind = selected
    metadata = fixed_run_metadata(
        repository,
        run_id,
        workflow,
        "success",
        "baseline recovery",
    )
    if title is not None and metadata.get("display_title") != title:
        fail("baseline recovery title differs from its selected source")
    validate_descendant_scope(metadata["head_sha"], subject_sha)
    validate_descendant_scope(source_sha, subject_sha)
    artifact = exact_artifact(
        repository, run_id, artifact_name, "baseline recovery"
    )
    if kind == "cache":
        validate_cache_recovery_artifact(
            repository,
            run_id,
            source_sha,
            artifact,
            "baseline recovery",
        )
    else:
        validate_partial_recovery_artifact(
            repository,
            run_id,
            source_sha,
            artifact,
            metadata,
            "baseline recovery",
        )


def validate_checkpoint_profile(
    repository,
    binding,
    artifact,
    expected_head_sha,
    subject_sha,
    run_id,
    dispatch_inputs,
    runtime_mode,
    display_title,
):
    if runtime_mode not in {"k3s", "oke"}:
        fail("authoritative OCI runtime mode is required for checkpoint validation")
    raw = artifact_member(
        repository, artifact, "checkpoint.json", binding["input"]
    )
    try:
        checkpoint_text = raw.decode("utf-8")
        checkpoint = json.loads(checkpoint_text)
    except (UnicodeDecodeError, json.JSONDecodeError):
        fail("release checkpoint artifact is malformed JSON")
    if not isinstance(checkpoint, dict):
        fail("release checkpoint artifact is not an object")
    helper = Path(__file__).with_name("k3s_disk_recovery_stan.py")
    command = [
        sys.executable,
        str(helper),
        "validate-release-checkpoint",
        "--checkpoint-json",
        checkpoint_text,
        "--source-sha",
        expected_head_sha,
        "--producer-run-id",
        run_id,
        "--runtime-mode",
        runtime_mode,
    ]
    infrastructure_run = require_dispatch_run(
        dispatch_inputs, "infrastructure_run_id"
    )
    build_run = (
        dispatch_inputs.get("build_run_id")
        or dispatch_inputs.get("ghcr_build_run_id")
    )
    if not POSITIVE_INTEGER.fullmatch(str(build_run or "")):
        fail("release checkpoint profile requires its original build run")
    build_run = str(build_run)
    command.extend(("--infrastructure-run-id", infrastructure_run))
    command.extend(("--ghcr-build-run-id", build_run))
    if runtime_mode == "k3s":
        build_name = f"oci-image-provenance-{expected_head_sha}-{build_run}-1"
        build_artifact = exact_artifact(
            repository, str(build_run), build_name, "current build"
        )
        candidate_hash = candidate_images_checksum(
            artifact_member(
                repository, build_artifact, "images.tsv", "current build"
            )
        )
        command.extend(("--expected-candidate-images-sha256", candidate_hash))
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        fail("repository-fixed release checkpoint validator rejected the artifact")
    expected_titles = {
        "READY_NO_RECLAIM": {
            f"oci-infrastructure diagnose-disk k3s {expected_head_sha}",
            f"oci-infrastructure finalize k3s {expected_head_sha}",
        },
        "READY_RECLAIMED": {
            f"oci-infrastructure reclaim-disk k3s {expected_head_sha}"
        },
        "NOT_APPLICABLE": {
            f"oci-infrastructure finalize oke {expected_head_sha}"
        },
    }
    disposition = checkpoint.get("disposition")
    if display_title not in expected_titles.get(disposition, set()):
        fail("release checkpoint disposition does not match the producer title")
    if (
        display_title
        == f"oci-infrastructure finalize k3s {expected_head_sha}"
        and checkpoint.get("infrastructureRunId") != run_id
    ):
        fail("k3s finalize checkpoint does not bind its infrastructure run")
    validate_descendant_scope(expected_head_sha, subject_sha)
    validate_baseline_recovery_profile(
        repository,
        dispatch_inputs,
        subject_sha,
    )


def validate_live_predecessor_profile(
    repository,
    binding,
    expected_head_sha,
    run_id,
    dispatch_inputs,
    runtime_mode,
):
    if binding["workflow"] != "oci-live-data-rollout.yml":
        return
    content = binding.get("artifactContent") or {}
    equality = content.get("equals") or {}
    if equality.get("schema_version") != "live-betting-v6":
        return
    phase = equality.get("phase")
    if phase not in {"dry-run", "apply-backfills", "apply-slip-index"}:
        fail(f"{binding['input']} predecessor phase is unsupported")
    checkpoint = parse_checkpoint_artifact(
        repository,
        dispatch_inputs,
        runtime_mode,
        f"{binding['input']} checkpoint",
    )
    evidence, _, files = parse_live_v6_artifact(
        repository, run_id, binding["input"], include_files=True
    )
    validate_live_v6_lineage(
        evidence,
        checkpoint,
        dispatch_inputs,
        run_id,
        expected_head_sha,
        phase,
        binding["input"],
    )
    authority = parse_resume_authority(files, evidence, binding["input"])
    if authority and authority["resume_maintenance_mode"] == "pre-runtime-hold":
        validate_pre_runtime_resume_chain(repository, run_id, runtime_mode)


def validate_binding(
    repository,
    binding,
    subject_sha,
    run_id,
    dispatch_inputs=None,
    runtime_mode=None,
    successor_run_id="",
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
    expected_head_sha = subject_sha
    expected_head_input = binding.get("expectedHeadShaInput")
    if expected_head_input is not None:
        expected_head_sha = dispatch_inputs.get(expected_head_input)
        if not isinstance(expected_head_sha, str) or not FULL_SHA.fullmatch(
            expected_head_sha
        ):
            fail(
                f"{binding['input']} expected head input "
                f"{expected_head_input} is not a full SHA"
            )
        if expected_head_input in {"resume_source_sha", "held_handoff_source_sha"}:
            validate_descendant_scope(expected_head_sha, subject_sha)
    expected_conclusion = binding.get("expectedConclusion", "success")

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
        "head_sha": (base.get("head_sha"), expected_head_sha),
        "status": (base.get("status"), "completed"),
        "conclusion": (base.get("conclusion"), expected_conclusion),
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
        expected_title = substitute(template, expected_head_sha, run_id)
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
        binding["artifactTemplate"], expected_head_sha, run_id
    )
    profile = binding.get("runProfile")
    if profile == "oci-successful-held-handoff-v1":
        return validate_held_handoff_artifact(
            repository, run_id, expected_head_sha, subject_sha, dispatch_inputs,
            runtime_mode, binding["input"], successor_run_id=successor_run_id,
        )
    if profile == "oci-failed-deploy-retained-hold-v1":
        if dispatch_inputs.get("confirmation") == HELD_HANDOFF_CONFIRMATION:
            if dispatch_inputs.get("failed_deploy_run_id") != run_id:
                fail(f"{binding['input']} held continuation substituted its failed receiver")
            held_result = validate_held_handoff_artifact(
                repository, require_dispatch_run(dispatch_inputs, "held_handoff_run_id"),
                require_dispatch_sha(dispatch_inputs, "held_handoff_source_sha"),
                subject_sha, dispatch_inputs, runtime_mode, binding["input"],
                successor_run_id=successor_run_id,
            )
            return {
                "baselineFiles": held_result["baselineFiles"],
                "artifactName": held_result["resume"]["baseline_artifact_name"],
                "createdAt": base.get("created_at"), "completedAt": base.get("updated_at"),
                "resume": held_result["resume"],
            }
        result = validate_expired_handoff_resume(
            repository, run_id, expected_head_sha, dispatch_inputs, runtime_mode,
            binding["input"], successor_run_id=successor_run_id,
        )
        if result is not None:
            return {
                "baselineFiles": result.pop("_baseline_files"),
                "artifactName": result["baseline_artifact_name"],
                "createdAt": base.get("created_at"),
                "completedAt": base.get("updated_at"),
                "resume": dict(
                    result, failed_deploy_job_conclusion="failure",
                    public_validate_job_conclusion="skipped",
                    lock_release_step_conclusion="skipped",
                    fence_release_step_conclusion="skipped",
                    rehold_step_conclusion="skipped",
                ),
            }
        outcomes = validate_failed_deploy_jobs(repository, run_id, profile, binding["input"])
        if outcomes == ("skipped", "skipped", "skipped"):
            result = validate_failed_deploy_artifacts(
                repository, run_id, expected_head_sha, None, dispatch_inputs,
                runtime_mode, profile, *outcomes, binding["input"], pre_runtime=True,
            )
            return {
                "baselineFiles": result.pop("_baseline_files"),
                "artifactName": result["baseline_artifact_name"],
                "createdAt": base.get("created_at"),
                "completedAt": base.get("updated_at"),
                "resume": dict(result, failed_deploy_job_conclusion="failure",
                    public_validate_job_conclusion="skipped",
                    lock_release_step_conclusion="skipped",
                    fence_release_step_conclusion="skipped",
                    rehold_step_conclusion="skipped"),
            }
    artifact = exact_artifact(
        repository, run_id, artifact_name, binding["input"]
    )
    if profile == "oci-failed-activation-released-resume-v1":
        user = dispatch_inputs.get("failed_activation_user_id")
        if user == "0":
            result = validate_released_activation_pre_arm(
                repository, run_id, expected_head_sha, artifact, dispatch_inputs,
                runtime_mode, binding["input"],
            )
        else:
            if not isinstance(user, str) or re.fullmatch(r"[0-9a-f]{24}", user) is None:
                fail("released activation requires an ObjectId or qualified pre-arm sentinel")
            load_artifact_content(
                repository, binding, artifact, expected_head_sha, run_id, dispatch_inputs,
            )
            validate_run_profile(
                repository, run_id, expected_head_sha, "oci-failed-activation-cleanup-v1",
                binding["input"], artifact, dispatch_inputs, runtime_mode,
            )
            result = {
                "released_activation_qualification": "cleanup-required",
                "resume_maintenance_mode": "released-runtime",
            }
        facts = {
            "artifactName": artifact_name, "createdAt": base.get("created_at"),
            "completedAt": base.get("updated_at"), "resume": result,
        }
        if "_baseline_files" in result:
            facts["baselineFiles"] = result.pop("_baseline_files")
        return facts
    load_artifact_content(
        repository,
        binding,
        artifact,
        expected_head_sha,
        run_id,
        dispatch_inputs,
    )
    validate_live_predecessor_profile(
        repository,
        binding,
        expected_head_sha,
        run_id,
        dispatch_inputs,
        runtime_mode,
    )
    validate_run_profile(
        repository,
        run_id,
        expected_head_sha,
        binding.get("runProfile"),
        binding["input"],
        artifact,
        dispatch_inputs,
        runtime_mode,
    )
    if binding.get("artifactValidatorProfile") == "oci-release-disk-checkpoint-v1":
        validate_checkpoint_profile(
            repository,
            binding,
            artifact,
            expected_head_sha,
            subject_sha,
            run_id,
            dispatch_inputs,
            runtime_mode,
            base.get("display_title"),
        )
    facts = {
        "artifactName": artifact_name,
        "createdAt": base.get("created_at"),
        "completedAt": base.get("updated_at"),
    }
    if profile in {
        "oci-failed-deploy-retained-hold-v1", "oci-failed-deploy-released-runtime-v1",
    }:
        lock, fence, rehold = validate_failed_deploy_jobs(repository, run_id, profile, binding["input"])
        retained = profile == "oci-failed-deploy-retained-hold-v1"
        facts["resume"] = {
            "resume_maintenance_mode": "retained-hold" if retained else "released-runtime",
            "baseline_run_id": run_id,
            "baseline_artifact_name": artifact_name,
            "failed_deploy_job_conclusion": "failure" if retained else "success",
            "public_validate_job_conclusion": "skipped" if retained else "failure",
            "lock_release_step_conclusion": lock,
            "fence_release_step_conclusion": fence,
            "rehold_step_conclusion": rehold,
        }
    return facts


def command_validate(args):
    binding = json.loads(args.binding)
    dispatch_inputs = json.loads(args.dispatch_inputs)
    if not isinstance(dispatch_inputs, dict):
        fail("dispatch inputs must be an object")
    with NativeReadCommand(1) as native:
        reader_token = _CURRENT_READER_SHA_CONTEXT.set(args.subject_sha)
        try:
            facts = validate_binding(
                args.repository,
                binding,
                args.subject_sha,
                args.run_id,
                dispatch_inputs,
                args.runtime_mode,
            )
        finally:
            _CURRENT_READER_SHA_CONTEXT.reset(reader_token)
        native.check_cancelled()
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
    if args.policy_json and not args.manifest:
        policy = json.loads(args.policy_json)
        if isinstance(policy, dict) and policy.get("workflow") == "oci-live-data-rollout.yml":
            if not isinstance(policy.get("inputNames"), list):
                fail("live data policy input contract is missing")
            inputs = live_data_native_inputs(inputs, policy["inputNames"])
        if isinstance(policy, dict) and any(binding.get("runProfile") == "oci-successful-held-handoff-v1"
               for binding in bindings):
            if policy.get("operation") != "oci-live-data-continue-held-handoff":
                fail("successful held-handoff profile is restricted to its fixed operation")
        if isinstance(policy, dict) and any(
            binding.get("runProfile") == "oci-failed-activation-released-resume-v1"
            for binding in bindings
        ):
            if policy.get("operation") != "oci-live-data-resume-activation-released":
                fail("released activation profile is restricted to its fixed operation")
    if any(
        binding.get("runProfile") == "oci-failed-activation-released-resume-v1"
        for binding in bindings if isinstance(binding, dict)
    ) and (
        args.manifest or not args.policy_json
        or not isinstance(policy, dict)
        or policy.get("operation") != "oci-live-data-resume-activation-released"
        or policy.get("workflow") != "oci-live-data-rollout.yml"
    ):
        fail("released activation profile requires its fixed operation policy")
    binding_names = [binding["input"] for binding in bindings]
    if len(binding_names) != len(set(binding_names)):
        fail("upstream bindings contain a duplicate input")
    chronology_inputs = set()
    preceding_inputs = set()
    for binding in bindings:
        after_input = binding.get("afterInput")
        if after_input is not None:
            if after_input not in binding_names:
                fail(
                    f"binding {binding['input']} depends on unknown input "
                    f"{after_input}"
                )
            if after_input not in preceding_inputs:
                fail(
                    f"binding {binding['input']} depends on unvalidated input "
                    f"{after_input}"
                )
            chronology_inputs.update((binding["input"], after_input))
        preceding_inputs.add(binding["input"])
    for binding in bindings:
        name = binding["input"]
        if name not in inputs:
            fail(f"dispatch inputs are missing bound value {name}")
        if inputs[name] in (None, ""):
            fail(f"dispatch input {name} is empty")
        if POSITIVE_INTEGER.fullmatch(str(inputs[name])) is None:
            fail(f"dispatch input {name} must be a positive run ID")
        expected_head = binding.get("expectedHeadShaInput")
        if expected_head is not None and (
            not isinstance(inputs.get(expected_head), str)
            or FULL_SHA.fullmatch(inputs[expected_head]) is None
        ):
            fail(f"dispatch input {expected_head} must be a complete source SHA")
    operation = policy.get("operation", "") if args.policy_json and not args.manifest else args.operation
    with NativeReadCommand(len(bindings)) as native, HistoryProofCommand(native):
        return validate_all_bindings(
            args, inputs, bindings, chronology_inputs, operation, native,
        )


def validate_all_bindings(args, inputs, bindings, chronology_inputs, operation, native):
    validated = {}
    failures = []
    if bindings:
        byte_context = ImmutableBindingBytes({
            "repository": args.repository, "subject": args.subject_sha,
            "inputs": inputs, "bindings": bindings, "runtime": args.runtime_mode,
            "policy": args.policy_json, "operation": getattr(args, "operation", ""),
            "successor": getattr(args, "successor_run_id", ""),
            "manifest": (
                Path(args.manifest).read_text(encoding="utf-8") if args.manifest else ""
            ),
            "validator": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        })
        def read_binding(binding):
            token = BYTE_CONTEXT.set(byte_context)
            native_token = NATIVE_CONTEXT.set(native)
            binding_token = BINDING_CONTEXT.set(binding["input"])
            reader_token = _CURRENT_READER_SHA_CONTEXT.set(args.subject_sha)
            try:
                return validate_binding(
                    args.repository, binding, args.subject_sha,
                    str(inputs[binding["input"]]), inputs, args.runtime_mode,
                    getattr(args, "successor_run_id", ""),
                )
            finally:
                _CURRENT_READER_SHA_CONTEXT.reset(reader_token)
                BINDING_CONTEXT.reset(binding_token)
                NATIVE_CONTEXT.reset(native_token)
                BYTE_CONTEXT.reset(token)
        with concurrent.futures.ThreadPoolExecutor(
            max_workers=min(4, len(bindings))
        ) as pool:
            futures = [
                pool.submit(
                    read_binding,
                    binding,
                )
                for binding in bindings
            ]
            for binding, future in zip(bindings, futures):
                try:
                    validated[binding["input"]] = future.result()
                except BaseException as error:
                    if isinstance(error, KeyboardInterrupt):
                        if native.interruption is None:
                            native.interruption = error
                        native.cancelled.set()
                    failures.append(error)
        native.check_cancelled()
        if failures:
            raise failures[0]
    for binding in bindings:
        name = binding["input"]
        facts = validated[name]
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
            if validated[after_input]["completedAt"] > facts["createdAt"]:
                fail(
                    f"binding {name} began before {after_input} completed"
                )
    timing = None
    if operation in {"oci-production-deploy", "oci-production-deploy-recovered"}:
        if not bindings or "data_run_id" not in validated:
            fail("receiver handoff timing requires its authenticated data binding")
        boundary, receiver = "dispatch", ""
        owner = os.environ.get("BETSTAN_BINDING_COMMAND_OWNER", "")
        if command_owner_is_ancestor(owner):
            boundary = os.environ.get("BETSTAN_BINDING_BOUNDARY", "")
            receiver = os.environ.get("BETSTAN_BOUND_RECEIVER_RUN_ID", "")
            if boundary.startswith("approval-") and (
                byte_context.workspace is None
                or os.environ.get("BETSTAN_APPROVAL_BYTES_OWNER") != owner
            ):
                fail("receiver approval timing requires this command's private byte workspace")
        elif (
            os.environ.get("GITHUB_ACTIONS") == "true"
            and os.environ.get("GITHUB_REPOSITORY") == args.repository
            and os.environ.get("GITHUB_SHA") == args.subject_sha
        ):
            boundary, receiver = "native-validation", os.environ.get("GITHUB_RUN_ID", "")
        token = BYTE_CONTEXT.set(byte_context)
        try:
            timing = validate_receiver_handoff_timing(
                args.repository, str(inputs["data_run_id"]), args.subject_sha, boundary, receiver,
            )
        finally:
            BYTE_CONTEXT.reset(token)
    native.check_cancelled()
    histories = [facts["heldHistory"] for facts in validated.values() if "heldHistory" in facts]
    baselines = [facts["baselineFiles"] for facts in validated.values() if "baselineFiles" in facts]
    if getattr(args, "held_history_file", "") and (
        len(histories) != 1 or histories[0]["cutoff_at"] is None
    ):
        fail("held-handoff history requires an authenticated running successor cutoff")
    if args.baseline_dir:
        if any(files != baselines[0] for files in baselines):
            fail("held-handoff and original root baselines disagree")
        root = Path(args.baseline_dir)
        if baselines and (root.is_symlink() or (root.exists() and any(root.iterdir()))):
            fail("original before baseline output must be empty")
    if args.result_json:
        safe_results = {
            name: facts["resume"] for name, facts in validated.items()
            if "resume" in facts
        }
        with open(args.result_json, "x", encoding="utf-8") as handle:
            json.dump(safe_results, handle, sort_keys=True)
    if getattr(args, "held_history_file", ""):
        output = Path(args.held_history_file)
        output.parent.mkdir(parents=True, exist_ok=True)
        with output.open("x", encoding="utf-8") as handle:
            json.dump(histories[0], handle, sort_keys=True)
    if args.baseline_dir:
        for files in baselines[:1]:
            root = Path(args.baseline_dir)
            root.mkdir(parents=True, exist_ok=True)
            for relative, raw in files.items():
                destination = root / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                with destination.open("xb") as handle:
                    handle.write(raw)
    for binding in bindings:
        name = binding["input"]
        print(f"upstream_binding={name} run={inputs[name]} status=OK")
    if timing is not None:
        print("handoff_timing=" + json.dumps(timing, sort_keys=True, separators=(",", ":")))
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
    one.add_argument("--runtime-mode", default="")
    one.set_defaults(func=command_validate)

    every = sub.add_parser("validate-all")
    every.add_argument("--repository", required=True)
    every.add_argument("--policy-json", default="")
    every.add_argument("--manifest", default="")
    every.add_argument("--operation", default="")
    every.add_argument("--subject-sha", required=True)
    every.add_argument("--dispatch-inputs", required=True)
    every.add_argument("--runtime-mode", default="")
    every.add_argument("--result-json", default="")
    every.add_argument("--baseline-dir", default="")
    every.add_argument("--successor-run-id", default="")
    every.add_argument("--held-history-file", default="")
    every.set_defaults(func=command_validate_all)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
