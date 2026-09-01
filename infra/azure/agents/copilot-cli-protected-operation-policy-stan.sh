#!/usr/bin/env bash
set -euo pipefail

# Shared policy for Copilot CLI dispatch and protected-environment approval.
# Keep operation definitions here so dispatch and approval cannot drift.

python3 - "$@" <<'PY'
import json
import sys


def dispatch(
    operation,
    workflow,
    environment,
    title,
    inputs,
    *,
    fixed=None,
    booleans=None,
    allow_empty=None,
    positive=None,
    zero_or_positive=None,
    optional_positive=None,
    full_shas=None,
    object_id_or_literals=None,
    patterns=None,
    templates=None,
    forbidden=None,
    subject_input=None,
    subject_relation="none",
    target_input=None,
    target_relation="none",
    derived_operations=None,
):
    return {
        "operation": operation,
        "workflow": workflow,
        "event": "workflow_dispatch",
        "environment": environment,
        "authority": "dispatch-record",
        "titleTemplate": title,
        "inputNames": inputs,
        "fixedInputs": fixed or {},
        "booleanInputs": booleans or [],
        "allowEmptyInputs": allow_empty or [],
        "positiveIntegerInputs": positive or [],
        "zeroOrPositiveIntegerInputs": zero_or_positive or [],
        "optionalPositiveIntegerInputs": optional_positive or [],
        "fullShaInputs": full_shas or [],
        "objectIdOrLiterals": object_id_or_literals or {},
        "inputPatterns": patterns or {},
        "inputTemplates": templates or {},
        "forbiddenInputValues": forbidden or {},
        "subjectInput": subject_input,
        "subjectRelation": subject_relation,
        "targetInput": target_input,
        "targetRelation": target_relation,
        "upstreamWorkflow": None,
        "upstreamEvent": None,
        "upstreamConclusion": None,
        "upstreamOperations": [],
        "requiresConsumedUpstream": False,
        "derivedOperations": derived_operations or [],
    }


def automatic(
    operation,
    workflow,
    event,
    environment,
    authority,
    title=None,
    *,
    upstream_workflow=None,
    upstream_event=None,
    upstream_conclusion=None,
    upstream_operations=None,
    requires_consumed_upstream=False,
):
    return {
        "operation": operation,
        "workflow": workflow,
        "event": event,
        "environment": environment,
        "authority": authority,
        "titleTemplate": title,
        "inputNames": [],
        "fixedInputs": {},
        "booleanInputs": [],
        "allowEmptyInputs": [],
        "positiveIntegerInputs": [],
        "zeroOrPositiveIntegerInputs": [],
        "optionalPositiveIntegerInputs": [],
        "fullShaInputs": [],
        "objectIdOrLiterals": {},
        "inputPatterns": {},
        "inputTemplates": {},
        "forbiddenInputValues": {},
        "subjectInput": None,
        "subjectRelation": "none",
        "targetInput": None,
        "targetRelation": "none",
        "upstreamWorkflow": upstream_workflow,
        "upstreamEvent": upstream_event,
        "upstreamConclusion": upstream_conclusion,
        "upstreamOperations": upstream_operations or [],
        "requiresConsumedUpstream": requires_consumed_upstream,
        "derivedOperations": [],
    }


PRODUCTION_ROLLBACK_INPUTS = [
    "target_sha",
    "baseline_source_run_id",
    "baseline_source_run_attempt",
    "baseline_artifact_name",
    "confirmation",
]

OCI_DEPLOY_INPUTS = [
    "approved_sha",
    "build_run_id",
    "infrastructure_run_id",
    "data_run_id",
    "baseline_recovery_run_id",
    "baseline_recovery_source_sha",
    "confirmation",
]

OCI_ROLLBACK_INPUTS = [
    "target_sha",
    "baseline_source_run_id",
    "baseline_source_run_attempt",
    "baseline_artifact_name",
    "infrastructure_run_id",
    "partial_rollback_run_id",
    "pre_recovery_build_run_id",
    "allow_legacy_admin_auth",
    "legacy_admin_auth_reason",
    "confirmation",
]

OCI_INFRASTRUCTURE_INPUTS = [
    "approved_sha",
    "confirmation",
    "phase",
    "candidate_build_run_id",
    "obsolete_sha",
    "obsolete_build_run_id",
    "obsolete_generations",
    "deployed_sha",
    "deployed_run_id",
    "fallback_sha",
    "fallback_build_run_id",
    "validation_run_id",
    "ghcr_build_run_id",
    "ghcr_package_validation_run_id",
]

GHCR_INPUTS = [
    "approved_sha",
    "phase",
    "confirmation",
    "candidate_build_run_id",
    "deployed_sha",
    "deployed_build_run_id",
    "deployed_deploy_run_id",
    "deployed_recovery_run_id",
    "last_known_good_sha",
    "last_known_good_build_run_id",
    "last_known_good_deploy_run_id",
    "last_known_good_recovery_run_id",
    "obsolete_generations",
    "validation_run_id",
    "failed_build_run_id",
    "trusted_upstream_run_id",
]

LIVE_DATA_INPUTS = [
    "approved_sha",
    "build_run_id",
    "infrastructure_run_id",
    "phase",
    "prerequisite_run_id",
    "baseline_recovery_run_id",
    "failed_deploy_run_id",
    "failed_activation_run_id",
    "failed_activation_user_id",
    "confirmation",
]

OCI_MIGRATE_INPUTS = [
    "approved_sha",
    "build_run_id",
    "deploy_run_id",
    "infrastructure_run_id",
    "replace_oci_data",
    "recover_closed_oci",
    "recovery_deploy_source_sha",
    "confirmation",
]

GHCR_OPTIONAL = [
    "candidate_build_run_id",
    "deployed_sha",
    "deployed_build_run_id",
    "deployed_deploy_run_id",
    "deployed_recovery_run_id",
    "last_known_good_sha",
    "last_known_good_build_run_id",
    "last_known_good_deploy_run_id",
    "last_known_good_recovery_run_id",
    "obsolete_generations",
    "validation_run_id",
    "failed_build_run_id",
    "trusted_upstream_run_id",
]

GHCR_OPTIONAL_RUN_IDS = [
    "deployed_build_run_id",
    "deployed_deploy_run_id",
    "deployed_recovery_run_id",
    "last_known_good_build_run_id",
    "last_known_good_deploy_run_id",
    "last_known_good_recovery_run_id",
]

POLICIES = {
    "production-build": automatic(
        "production-build",
        "production-build.yml",
        "push",
        "production-emergency",
        "promotion",
    ),
    "production-deploy": dispatch(
        "production-deploy",
        "production-deploy.yml",
        "production-emergency",
        "deploy {subject_sha}",
        ["approved_sha", "build_run_id"],
        positive=["build_run_id"],
        full_shas=["approved_sha"],
        subject_input="approved_sha",
        subject_relation="current",
    ),
    "production-rollback": dispatch(
        "production-rollback",
        "production-rollback.yml",
        "production-emergency",
        "rollback {target_sha}",
        PRODUCTION_ROLLBACK_INPUTS,
        fixed={
            "baseline_source_run_attempt": "1",
            "confirmation": "ROLLBACK PRODUCTION EXACT DIGEST",
        },
        positive=["baseline_source_run_id"],
        full_shas=["target_sha"],
        templates={
            "baseline_artifact_name":
                "production-baseline-{input:baseline_source_run_id}-"
                "{input:baseline_source_run_attempt}",
        },
        target_input="target_sha",
        target_relation="ancestor",
    ),
    "oci-production-build": automatic(
        "oci-production-build",
        "oci-production-build.yml",
        "workflow_run",
        "oci-build",
        "promotion-upstream",
        "oci-build {control_sha} upstream-{upstream_run_id}",
        upstream_workflow="production-build.yml",
        upstream_event="push",
        upstream_conclusion="success",
    ),
    "oci-production-build-repair": automatic(
        "oci-production-build-repair",
        "oci-production-build.yml",
        "workflow_run",
        "oci-build",
        "record-upstream",
        "oci-build {control_sha} repair-{upstream_run_id}",
        upstream_workflow="ghcr-package-management.yml",
        upstream_event="workflow_dispatch",
        upstream_conclusion="success",
        upstream_operations=["ghcr-package-repair-build"],
        requires_consumed_upstream=True,
    ),
    "oci-production-deploy": dispatch(
        "oci-production-deploy",
        "oci-production-deploy.yml",
        "oci-production",
        "oci-deploy {subject_sha}",
        OCI_DEPLOY_INPUTS,
        fixed={
            "baseline_recovery_run_id": "0",
            "baseline_recovery_source_sha": "none",
            "confirmation": "DEPLOY OCI EXACT SHA",
        },
        positive=["build_run_id", "infrastructure_run_id", "data_run_id"],
        full_shas=["approved_sha"],
        subject_input="approved_sha",
        subject_relation="current",
    ),
    "oci-production-deploy-recovered": dispatch(
        "oci-production-deploy-recovered",
        "oci-production-deploy.yml",
        "oci-production",
        "oci-deploy {subject_sha}",
        OCI_DEPLOY_INPUTS,
        fixed={"confirmation": "DEPLOY OCI EXACT SHA"},
        positive=[
            "build_run_id",
            "infrastructure_run_id",
            "data_run_id",
            "baseline_recovery_run_id",
        ],
        full_shas=["approved_sha", "baseline_recovery_source_sha"],
        subject_input="approved_sha",
        subject_relation="current",
        target_input="baseline_recovery_source_sha",
        target_relation="ancestor-or-current",
    ),
    "oci-production-rollback": dispatch(
        "oci-production-rollback",
        "oci-production-rollback.yml",
        "oci-production",
        "oci-rollback {target_sha}",
        OCI_ROLLBACK_INPUTS,
        fixed={
            "baseline_source_run_attempt": "1",
            "partial_rollback_run_id": "0",
            "pre_recovery_build_run_id": "0",
            "allow_legacy_admin_auth": False,
            "legacy_admin_auth_reason": "not-requested",
            "confirmation": "ROLLBACK OCI EXACT DIGEST",
        },
        booleans=["allow_legacy_admin_auth"],
        positive=["baseline_source_run_id", "infrastructure_run_id"],
        full_shas=["target_sha"],
        templates={
            "baseline_artifact_name":
                "oci-production-baseline-{input:baseline_source_run_id}-"
                "{input:baseline_source_run_attempt}",
        },
        target_input="target_sha",
        target_relation="ancestor",
    ),
    "oci-production-rollback-legacy-admin": dispatch(
        "oci-production-rollback-legacy-admin",
        "oci-production-rollback.yml",
        "oci-production",
        "oci-rollback {target_sha}",
        OCI_ROLLBACK_INPUTS,
        fixed={
            "baseline_source_run_attempt": "1",
            "partial_rollback_run_id": "0",
            "pre_recovery_build_run_id": "0",
            "allow_legacy_admin_auth": True,
            "confirmation": "ROLLBACK OCI EXACT DIGEST",
        },
        booleans=["allow_legacy_admin_auth"],
        positive=["baseline_source_run_id", "infrastructure_run_id"],
        full_shas=["target_sha"],
        templates={
            "baseline_artifact_name":
                "oci-production-baseline-{input:baseline_source_run_id}-"
                "{input:baseline_source_run_attempt}",
        },
        forbidden={"legacy_admin_auth_reason": ["not-requested"]},
        target_input="target_sha",
        target_relation="ancestor",
    ),
    "oci-production-rollback-recovery": dispatch(
        "oci-production-rollback-recovery",
        "oci-production-rollback.yml",
        "oci-production",
        "oci-rollback {target_sha}",
        OCI_ROLLBACK_INPUTS,
        fixed={
            "baseline_source_run_attempt": "1",
            "allow_legacy_admin_auth": False,
            "legacy_admin_auth_reason": "not-requested",
            "confirmation": "RECOVER OCI PARTIAL ROLLBACK",
        },
        booleans=["allow_legacy_admin_auth"],
        positive=[
            "baseline_source_run_id",
            "infrastructure_run_id",
            "partial_rollback_run_id",
            "pre_recovery_build_run_id",
        ],
        full_shas=["target_sha"],
        templates={
            "baseline_artifact_name":
                "oci-production-baseline-{input:baseline_source_run_id}-"
                "{input:baseline_source_run_attempt}",
        },
        target_input="target_sha",
        target_relation="ancestor",
    ),
    "oci-live-betting-activate": dispatch(
        "oci-live-betting-activate",
        "oci-live-betting-activate.yml",
        "oci-production",
        "oci-live-activate {subject_sha}",
        [
            "approved_sha",
            "build_run_id",
            "infrastructure_run_id",
            "deployment_run_id",
            "confirmation",
        ],
        fixed={"confirmation": "ACTIVATE OCI LIVE BETTING"},
        positive=["build_run_id", "infrastructure_run_id", "deployment_run_id"],
        full_shas=["approved_sha"],
        subject_input="approved_sha",
        subject_relation="current",
    ),
    "oci-live-betting-disable": dispatch(
        "oci-live-betting-disable",
        "oci-live-betting-disable.yml",
        "oci-production",
        "oci-live-betting-disable {subject_sha}",
        [
            "approved_sha",
            "deployment_run_id",
            "infrastructure_run_id",
            "confirmation",
        ],
        fixed={"confirmation": "DISABLE OCI LIVE BETTING"},
        positive=["deployment_run_id", "infrastructure_run_id"],
        full_shas=["approved_sha"],
        subject_input="approved_sha",
        subject_relation="ancestor-or-current",
    ),
    "oci-capacity-acquire": dispatch(
        "oci-capacity-acquire",
        "oci-capacity-acquire.yml",
        "oci-capacity-acquire",
        "oci-capacity-acquire {subject_sha}",
        ["approved_sha"],
        full_shas=["approved_sha"],
        subject_input="approved_sha",
        subject_relation="current",
    ),
    "oci-infrastructure-prepare": dispatch(
        "oci-infrastructure-prepare",
        "oci-infrastructure.yml",
        "oci-infrastructure",
        "oci-infrastructure prepare {subject_sha}",
        OCI_INFRASTRUCTURE_INPUTS,
        fixed={
            "confirmation": "PROVISION OCI ZERO COST",
            "phase": "prepare",
            "candidate_build_run_id": "",
            "obsolete_sha": "",
            "obsolete_build_run_id": "",
            "obsolete_generations": "",
            "deployed_sha": "",
            "deployed_run_id": "",
            "fallback_sha": "",
            "fallback_build_run_id": "",
            "validation_run_id": "",
            "ghcr_build_run_id": "",
            "ghcr_package_validation_run_id": "",
        },
        allow_empty=OCI_INFRASTRUCTURE_INPUTS[3:],
        full_shas=["approved_sha"],
        subject_input="approved_sha",
        subject_relation="current",
    ),
    "oci-infrastructure-finalize": dispatch(
        "oci-infrastructure-finalize",
        "oci-infrastructure.yml",
        "oci-infrastructure",
        "oci-infrastructure finalize {subject_sha}",
        OCI_INFRASTRUCTURE_INPUTS,
        fixed={
            "confirmation": "PROVISION OCI ZERO COST",
            "phase": "finalize",
            "candidate_build_run_id": "",
            "obsolete_sha": "",
            "obsolete_build_run_id": "",
            "obsolete_generations": "",
            "deployed_sha": "",
            "deployed_run_id": "",
            "fallback_sha": "",
            "fallback_build_run_id": "",
            "validation_run_id": "",
        },
        allow_empty=OCI_INFRASTRUCTURE_INPUTS[3:12],
        positive=["ghcr_build_run_id", "ghcr_package_validation_run_id"],
        full_shas=["approved_sha"],
        subject_input="approved_sha",
        subject_relation="current",
    ),
    "ghcr-package-bootstrap": dispatch(
        "ghcr-package-bootstrap",
        "ghcr-package-management.yml",
        "oci-infrastructure",
        "ghcr-package bootstrap {subject_sha}",
        GHCR_INPUTS,
        fixed={
            "phase": "bootstrap",
            "confirmation": "BOOTSTRAP GHCR PACKAGE SENTINEL",
            **{name: "" for name in GHCR_OPTIONAL},
        },
        allow_empty=GHCR_OPTIONAL,
        full_shas=["approved_sha"],
        subject_input="approved_sha",
        subject_relation="current",
    ),
    "ghcr-package-validate": dispatch(
        "ghcr-package-validate",
        "ghcr-package-management.yml",
        "oci-infrastructure",
        "ghcr-package validate {subject_sha}",
        GHCR_INPUTS,
        fixed={
            "phase": "validate",
            "confirmation": "VALIDATE PUBLIC GHCR PACKAGE",
            "validation_run_id": "",
            "failed_build_run_id": "",
            "trusted_upstream_run_id": "",
        },
        allow_empty=GHCR_OPTIONAL,
        positive=["candidate_build_run_id"],
        optional_positive=GHCR_OPTIONAL_RUN_IDS,
        full_shas=["approved_sha", "deployed_sha", "last_known_good_sha"],
        subject_input="approved_sha",
        subject_relation="current",
    ),
    "ghcr-package-prune": dispatch(
        "ghcr-package-prune",
        "ghcr-package-management.yml",
        "oci-infrastructure",
        "ghcr-package prune {subject_sha}",
        GHCR_INPUTS,
        fixed={
            "phase": "prune",
            "confirmation": "PRUNE OBSOLETE GHCR PACKAGE GENERATIONS",
            "failed_build_run_id": "",
            "trusted_upstream_run_id": "",
        },
        allow_empty=GHCR_OPTIONAL,
        positive=["candidate_build_run_id", "validation_run_id"],
        optional_positive=GHCR_OPTIONAL_RUN_IDS,
        full_shas=["approved_sha", "deployed_sha", "last_known_good_sha"],
        subject_input="approved_sha",
        subject_relation="current",
    ),
    "ghcr-package-repair-build": dispatch(
        "ghcr-package-repair-build",
        "ghcr-package-management.yml",
        "oci-infrastructure",
        "ghcr-package repair-build {subject_sha} "
        "upstream-{input:trusted_upstream_run_id} "
        "failed-{input:failed_build_run_id}",
        GHCR_INPUTS,
        fixed={
            "phase": "repair-build",
            "confirmation": "REPAIR PARTIAL GHCR BUILD",
            "candidate_build_run_id": "",
            "deployed_sha": "",
            "deployed_build_run_id": "",
            "deployed_deploy_run_id": "",
            "deployed_recovery_run_id": "",
            "last_known_good_sha": "",
            "last_known_good_build_run_id": "",
            "last_known_good_deploy_run_id": "",
            "last_known_good_recovery_run_id": "",
            "obsolete_generations": "",
            "validation_run_id": "",
        },
        allow_empty=GHCR_OPTIONAL,
        positive=["failed_build_run_id", "trusted_upstream_run_id"],
        full_shas=["approved_sha"],
        subject_input="approved_sha",
        subject_relation="current",
        derived_operations=["oci-production-build-repair"],
    ),
    "oci-ghcr-cache-recovery": dispatch(
        "oci-ghcr-cache-recovery",
        "oci-ghcr-cache-recovery.yml",
        "oci-production",
        "oci-ghcr-cache-recovery {subject_sha}",
        [
            "baseline_source_sha",
            "trusted_build_run_id",
            "trusted_deploy_run_id",
            "infrastructure_run_id",
            "resume_recovery_run_id",
            "confirmation",
        ],
        fixed={"confirmation": "RECOVER K3S CACHED BASELINE TO GHCR"},
        positive=[
            "trusted_build_run_id",
            "trusted_deploy_run_id",
            "infrastructure_run_id",
        ],
        zero_or_positive=["resume_recovery_run_id"],
        full_shas=["baseline_source_sha"],
        subject_input="baseline_source_sha",
        subject_relation="ancestor-or-current",
    ),
    "oci-live-data-dry-run": dispatch(
        "oci-live-data-dry-run",
        "oci-live-data-rollout.yml",
        "oci-migration",
        "oci-live-data dry-run {subject_sha}",
        LIVE_DATA_INPUTS,
        fixed={
            "phase": "dry-run",
            "prerequisite_run_id": "0",
            "failed_deploy_run_id": "0",
            "failed_activation_run_id": "0",
            "failed_activation_user_id": "0",
            "confirmation": "DRY RUN LIVE DATA EXACT SHA",
        },
        positive=["build_run_id", "infrastructure_run_id"],
        zero_or_positive=["baseline_recovery_run_id"],
        full_shas=["approved_sha"],
        subject_input="approved_sha",
        subject_relation="current",
    ),
    "oci-live-data-apply-backfills": dispatch(
        "oci-live-data-apply-backfills",
        "oci-live-data-rollout.yml",
        "oci-migration",
        "oci-live-data apply-backfills {subject_sha}",
        LIVE_DATA_INPUTS,
        fixed={
            "phase": "apply-backfills",
            "failed_deploy_run_id": "0",
            "failed_activation_run_id": "0",
            "failed_activation_user_id": "0",
            "confirmation": "APPLY LIVE BACKFILLS EXACT SHA",
        },
        positive=["build_run_id", "infrastructure_run_id", "prerequisite_run_id"],
        zero_or_positive=["baseline_recovery_run_id"],
        full_shas=["approved_sha"],
        subject_input="approved_sha",
        subject_relation="current",
    ),
    "oci-live-data-apply-slip-index": dispatch(
        "oci-live-data-apply-slip-index",
        "oci-live-data-rollout.yml",
        "oci-migration",
        "oci-live-data apply-slip-index {subject_sha}",
        LIVE_DATA_INPUTS,
        fixed={
            "phase": "apply-slip-index",
            "failed_deploy_run_id": "0",
            "failed_activation_run_id": "0",
            "failed_activation_user_id": "0",
            "confirmation": "APPLY LIVE SLIP INDEX EXACT SHA",
        },
        positive=["build_run_id", "infrastructure_run_id", "prerequisite_run_id"],
        zero_or_positive=["baseline_recovery_run_id"],
        full_shas=["approved_sha"],
        subject_input="approved_sha",
        subject_relation="current",
    ),
    "oci-live-data-resume-deploy": dispatch(
        "oci-live-data-resume-deploy",
        "oci-live-data-rollout.yml",
        "oci-migration",
        "oci-live-data apply-slip-index {subject_sha}",
        LIVE_DATA_INPUTS,
        fixed={
            "phase": "apply-slip-index",
            "failed_activation_run_id": "0",
            "failed_activation_user_id": "0",
            "confirmation": "RESUME APPLIED LIVE DATA EXACT SHA",
        },
        positive=[
            "build_run_id",
            "infrastructure_run_id",
            "prerequisite_run_id",
            "failed_deploy_run_id",
        ],
        zero_or_positive=["baseline_recovery_run_id"],
        full_shas=["approved_sha"],
        subject_input="approved_sha",
        subject_relation="current",
    ),
    "oci-live-data-resume-deploy-released": dispatch(
        "oci-live-data-resume-deploy-released",
        "oci-live-data-rollout.yml",
        "oci-migration",
        "oci-live-data apply-slip-index {subject_sha}",
        LIVE_DATA_INPUTS,
        fixed={
            "phase": "apply-slip-index",
            "failed_activation_run_id": "0",
            "failed_activation_user_id": "0",
            "confirmation":
                "RESUME APPLIED LIVE DATA FROM RELEASED RUNTIME EXACT SHA",
        },
        positive=[
            "build_run_id",
            "infrastructure_run_id",
            "prerequisite_run_id",
            "failed_deploy_run_id",
        ],
        zero_or_positive=["baseline_recovery_run_id"],
        full_shas=["approved_sha"],
        subject_input="approved_sha",
        subject_relation="current",
    ),
    "oci-live-data-resume-activation": dispatch(
        "oci-live-data-resume-activation",
        "oci-live-data-rollout.yml",
        "oci-migration",
        "oci-live-data apply-slip-index {subject_sha}",
        LIVE_DATA_INPUTS,
        fixed={
            "phase": "apply-slip-index",
            "confirmation":
                "RESUME APPLIED LIVE DATA AND CLEAN FAILED ACTIVATION EXACT SHA",
        },
        positive=[
            "build_run_id",
            "infrastructure_run_id",
            "prerequisite_run_id",
            "failed_deploy_run_id",
            "failed_activation_run_id",
        ],
        zero_or_positive=["baseline_recovery_run_id"],
        full_shas=["approved_sha"],
        object_id_or_literals={"failed_activation_user_id": []},
        subject_input="approved_sha",
        subject_relation="current",
    ),
    "oci-live-data-resume-activation-released": dispatch(
        "oci-live-data-resume-activation-released",
        "oci-live-data-rollout.yml",
        "oci-migration",
        "oci-live-data apply-slip-index {subject_sha}",
        LIVE_DATA_INPUTS,
        fixed={
            "phase": "apply-slip-index",
            "confirmation":
                "RESUME APPLIED LIVE DATA FROM RELEASED RUNTIME AND CLEAN "
                "FAILED ACTIVATION EXACT SHA",
        },
        positive=[
            "build_run_id",
            "infrastructure_run_id",
            "prerequisite_run_id",
            "failed_deploy_run_id",
            "failed_activation_run_id",
        ],
        zero_or_positive=["baseline_recovery_run_id"],
        full_shas=["approved_sha"],
        object_id_or_literals={"failed_activation_user_id": []},
        subject_input="approved_sha",
        subject_relation="current",
    ),
    "oci-migrate": dispatch(
        "oci-migrate",
        "oci-migrate.yml",
        "oci-migration",
        "oci-migrate {subject_sha}",
        OCI_MIGRATE_INPUTS,
        fixed={
            "replace_oci_data": True,
            "recover_closed_oci": False,
            "recovery_deploy_source_sha": "",
            "confirmation": "REPLACE OCI DATA FROM AZURE",
        },
        booleans=["replace_oci_data", "recover_closed_oci"],
        allow_empty=["recovery_deploy_source_sha"],
        positive=["build_run_id", "deploy_run_id", "infrastructure_run_id"],
        full_shas=["approved_sha"],
        subject_input="approved_sha",
        subject_relation="current",
        derived_operations=["oci-migration-recovery-automatic"],
    ),
    "oci-migrate-recover-closed": dispatch(
        "oci-migrate-recover-closed",
        "oci-migrate.yml",
        "oci-migration",
        "oci-migrate {subject_sha}",
        OCI_MIGRATE_INPUTS,
        fixed={
            "replace_oci_data": True,
            "recover_closed_oci": True,
            "confirmation": "RECOVER CLOSED OCI DATA FROM AZURE",
        },
        booleans=["replace_oci_data", "recover_closed_oci"],
        positive=["build_run_id", "deploy_run_id", "infrastructure_run_id"],
        full_shas=["approved_sha", "recovery_deploy_source_sha"],
        subject_input="approved_sha",
        subject_relation="current",
        target_input="recovery_deploy_source_sha",
        target_relation="ancestor",
        derived_operations=["oci-migration-recovery-automatic"],
    ),
    "oci-migration-recovery": dispatch(
        "oci-migration-recovery",
        "oci-migration-recovery.yml",
        "azure-migration-recovery",
        "azure migration recovery {run_id}",
        [
            "source_sha",
            "migration_run_id",
            "migration_run_attempt",
            "migration_id",
            "fencing_generation",
            "confirmation",
        ],
        fixed={
            "migration_run_attempt": "1",
            "confirmation": "STOP AZURE FOR EXACT MIGRATION",
        },
        positive=["migration_run_id", "fencing_generation"],
        full_shas=["source_sha"],
        patterns={
            "migration_id": r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
        },
        templates={
            "migration_id":
                "{input:migration_run_id}-{input:migration_run_attempt}",
        },
        subject_input="source_sha",
        subject_relation="ancestor-or-current",
    ),
    "oci-migration-recovery-automatic": automatic(
        "oci-migration-recovery-automatic",
        "oci-migration-recovery.yml",
        "workflow_run",
        "azure-migration-recovery",
        "record-upstream",
        "azure migration recovery {upstream_run_id}",
        upstream_workflow="oci-migrate.yml",
        upstream_event="workflow_dispatch",
        upstream_conclusion="non-success",
        upstream_operations=["oci-migrate", "oci-migrate-recover-closed"],
        requires_consumed_upstream=True,
    ),
}

DISABLED_BEFORE_APPROVAL_WORKFLOWS = {
    "oci-capacity-acquire.yml",
    "oci-infrastructure.yml",
    "oci-live-betting-activate.yml",
    "oci-live-data-rollout.yml",
    "oci-migration-recovery.yml",
    "oci-production-deploy.yml",
}
for policy in POLICIES.values():
    policy["approvalWorkflowState"] = (
        "disabled_manually"
        if policy["workflow"] in DISABLED_BEFORE_APPROVAL_WORKFLOWS
        else "active"
    )


def fail(message):
    raise SystemExit(message)


required_fields = {
    "operation",
    "workflow",
    "event",
    "environment",
    "authority",
    "approvalWorkflowState",
    "titleTemplate",
    "inputNames",
    "fixedInputs",
    "booleanInputs",
    "allowEmptyInputs",
    "positiveIntegerInputs",
    "zeroOrPositiveIntegerInputs",
    "optionalPositiveIntegerInputs",
    "fullShaInputs",
    "objectIdOrLiterals",
    "inputPatterns",
    "inputTemplates",
    "forbiddenInputValues",
    "subjectInput",
    "subjectRelation",
    "targetInput",
    "targetRelation",
    "upstreamWorkflow",
    "upstreamEvent",
    "upstreamConclusion",
    "upstreamOperations",
    "requiresConsumedUpstream",
    "derivedOperations",
}

for name, policy in POLICIES.items():
    if name != policy["operation"]:
        fail(f"policy key mismatch for {name}")
    if set(policy) != required_fields:
        fail(f"policy field mismatch for {name}")
    if not policy["workflow"].endswith((".yml", ".yaml")):
        fail(f"unsafe workflow name for {name}")
    if policy["event"] == "schedule":
        fail(f"scheduled operation may not be auto-approved: {name}")
    if policy["approvalWorkflowState"] not in {
        "active",
        "disabled_manually",
    }:
        fail(f"invalid approval workflow state for {name}")
    if policy["authority"] == "dispatch-record":
        if policy["event"] != "workflow_dispatch" or not policy["titleTemplate"]:
            fail(f"invalid dispatch policy for {name}")
        if len(policy["inputNames"]) != len(set(policy["inputNames"])):
            fail(f"duplicate input name in {name}")
        known = set(policy["inputNames"])
        referenced = set(policy["fixedInputs"])
        referenced.update(policy["booleanInputs"])
        referenced.update(policy["allowEmptyInputs"])
        referenced.update(policy["positiveIntegerInputs"])
        referenced.update(policy["zeroOrPositiveIntegerInputs"])
        referenced.update(policy["optionalPositiveIntegerInputs"])
        referenced.update(policy["fullShaInputs"])
        referenced.update(policy["objectIdOrLiterals"])
        referenced.update(policy["inputPatterns"])
        referenced.update(policy["inputTemplates"])
        referenced.update(policy["forbiddenInputValues"])
        referenced.update(
            value
            for value in (policy["subjectInput"], policy["targetInput"])
            if value is not None
        )
        if not referenced.issubset(known):
            fail(f"unknown constrained input in {name}")
    elif policy["authority"] not in {
        "promotion",
        "promotion-upstream",
        "record-upstream",
    }:
        fail(f"unsupported authority mode for {name}")


command = sys.argv[1] if len(sys.argv) > 1 else "all"
if command == "get":
    if len(sys.argv) != 3:
        fail("usage: policy get <operation>")
    operation = sys.argv[2]
    if operation not in POLICIES:
        fail(f"unknown protected operation: {operation}")
    print(json.dumps(POLICIES[operation], sort_keys=True, separators=(",", ":")))
elif command == "all":
    print(json.dumps(
        [POLICIES[name] for name in sorted(POLICIES)],
        sort_keys=True,
        separators=(",", ":"),
    ))
elif command == "operations":
    print("\n".join(sorted(POLICIES)))
elif command == "workflows":
    print("\n".join(sorted({policy["workflow"] for policy in POLICIES.values()})))
else:
    fail(f"unknown policy command: {command}")
PY
