# Archived Azure automation

BetStan production runs on OCI. Azure (AKS) is no longer used, so the
Azure-only operators, retirement tooling, stage lifecycle helpers and
Azure-specific agent definitions were moved here unchanged.

Nothing in this directory is executed by CI, workflows, or active scripts,
and the agent definitions are no longer discoverable as custom agents. Only
the Markdown references remain checked out. The archived shell scripts were
removed from the tree because production recovery treats any non-Markdown
path outside `.github/` and `infra/` as an application change; retrieve one
from commit `2296153` (`git show 2296153:archive/azure/<path>`) and restore it
through a normal reviewed PR if a concrete need ever returns.

The Azure GitHub workflows (`production-deploy.yml`, `production-rollback.yml`,
`oci-migrate.yml`, `oci-migration-recovery.yml`) are disabled on GitHub.
Generic deployment-safety helpers that still live under `infra/azure/agents/`
(PR validation, merge safety, CLI dispatch/approval, locks, guards) remain
active despite their historical path. The unused
`infra/azure/agents/reconcile-nodepool-profile-stan.sh` also stays in place for
now, because the protected quality workflow still syntax-checks it; changing
that workflow needs its own authorization, so it moves here with the next
quality-workflow change.

| Path | Former purpose |
| --- | --- |
| `agents/provisioning-stan.sh`, `provision.sh` | Full AKS provisioning |
| `agents/provision-stage-stan.sh`, `park-stage-stan.sh`, `resume-stage-stan.sh`, `decommission-stage-rg-stan.sh` | Azure stage lifecycle and cost control |
| `agents/cost-ops-stan.sh` | AKS scaling and cost control |
| `agents/troubleshoot-stan.sh`, `health-check-stan.sh`, `mismatch-diagnostic-stan.sh`, `dns-check-stan.sh`, `qa-e2e-stan.sh` | AKS diagnostics and smoke checks |
| `agents/retire-production-stan.sh`, `retire-migration-identities-stan.sh`, `audit-oci-primary-retirement-stan.sh`, `record-azure-retirement-billing-stan.sh`, `azure-retirement-billing-lib-stan.sh` and their tests | Post-migration Azure retirement and billing evidence |
| `LESSONS_LEARNED.md` | Azure-era operational lessons |
| `github-agents/` | Former `betstan-aks-operator`, `betstan-azure-cost-analyst` and `betstan-azure-retirement` agents |
