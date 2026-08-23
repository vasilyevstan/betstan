# Contributing to BetStan

## Branch flow

`master` is the production branch. Never commit or push directly to it.

Use this flow:

1. Make normal changes on a feature, fix, or operations branch and integrate them into `dev`.
2. Validate the complete `dev` branch.
3. Promote production only with an up-to-date pull request from `dev` to `master`.
4. Require the trusted, base-scoped `branch-policy/master` and `pr-quality-gates/master` statuses on both the promotion head and current merge snapshot to pass.
5. Before merging a promotion, bind approval to the exact head SHA and every production-capable workflow the diff will trigger.
6. After a squash promotion, immediately merge the new `master` commit back into `dev`.

Never push directly to `dev`; integrate focused feature, fix, or operations branches through pull requests. Pull requests into `master` from any branch other than `dev` are forbidden.

Copilot CLI-created pull requests carry the `copilot-cli-managed` label. They may use `COPILOT_CLI_AUTO_APPROVE=true` only after the merge-safety script verifies the label, exact refs, trusted required checks, resolved review threads, production workflow inventory, and absence of actionable competing production activity. Unlabelled pull requests and work created outside Copilot CLI require explicit human approval. Automatic mode never skips required checks or immutable-SHA gates.

Protected environment approval for CLI-managed work uses `copilot-cli-run-approval-stan.sh`. It additionally requires current `master`, a single associated labelled `dev` promotion, first-attempt workflow provenance, the exact expected environment, and no competing production workflow. Automatic approval is limited to application build/deploy/activation, exact-title capacity and registry/finalize phases, and the bounded `oci-live-data-rollout` chain. Broad migration, recovery, rollback, stale-master, rerun, unlabelled, and competing runs remain human-gated.

Schema-dependent OCI releases use the reviewer-gated `oci-live-data-rollout` workflow before deployment. Its exact-SHA phases are chained `dry-run` → `apply-backfills` → `apply-slip-index`; `oci-production-deploy` requires the final hash-bound schema evidence and pre-mutation rollback baseline from the same build and infrastructure runs. Mutating phases fence public writes and quiesce legacy data writers. A successful final phase deliberately retains that maintenance state and the shared-Mongo operation lock until the exact deployment passes protected validation, so dispatch the bound deployment immediately; an incomplete deployment re-enters the same fail-closed state for a safe retry.

## Production safety

Merging to `master` runs validation, then queues the first-attempt image build for approval through the master-only `production-emergency` environment. Production never deploys automatically. After the build succeeds, dispatch `production-deploy` from `master` with the exact full SHA and build run ID; the same environment requires a second approval. The workflow validates all nine build artifacts and deploys immutable tag-plus-digest image references. Rerun builds are not deployable, and retired workflow identities remain disabled.

Do not rewrite or force-push `master` or `dev`. Preserve unrelated tracked, staged, and untracked work.

## Trusted-check bootstrap

The trusted publisher currently requires the protected quality workflow to be byte-identical to the default-branch copy. Prefer extending an existing checked-in guard or test entrypoint that `production-build.yml` already invokes; this preserves the trusted workflow identity while still exercising the new validation.

If the workflow file itself must change, first add and independently review a fail-closed, one-use exact-blob authorization mechanism in the trusted publisher without changing the workflow. Promote that policy separately, then authorize and merge only the intended workflow blob, remove the authorization, and verify fresh statuses come from the expected workflow IDs. Do not invent or document an authorization variable before the publisher implements and tests it.

The trusted publisher binds both required status targets to the same current PR head SHA, base SHA, repository, trusted workflow runs, and unique test-merge SHA. Head-only or merge-only evidence is not a promotion gate.

Before proposing a production promotion:

```bash
./infra/azure/agents/pre-commit-infra-check-stan.sh
./infra/azure/agents/pr-merge-safety-stan.sh <pr-number>
```

After an approved promotion:

```bash
PR=<promotion-pr-number> ./infra/azure/agents/post-merge-verification-stan.sh
```
