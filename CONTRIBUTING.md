# Contributing to BetStan

## Branch flow

`master` is the production branch. Never commit or push directly to it.

Use this flow:

1. Make normal changes on a feature, fix, or operations branch and integrate them into `dev`.
2. Validate the complete `dev` branch.
3. Promote production only with an up-to-date pull request from `dev` to `master`.
4. Require the trusted, base-scoped `branch-policy/master` and `pr-quality-gates/master` statuses on both the promotion head and current merge snapshot to pass.
5. Before merging a promotion, obtain explicit approval for the exact head SHA and every production-capable workflow the diff will trigger.
6. After a squash promotion, immediately merge the new `master` commit back into `dev`.

Never push directly to `dev`; integrate focused feature, fix, or operations branches through pull requests. Pull requests into `master` from any branch other than `dev` are forbidden.

## Production safety

Merging to `master` runs validation, then queues the first-attempt image build for approval through the master-only `production-emergency` environment. Production never deploys automatically. After the build succeeds, dispatch `production-deploy` from `master` with the exact full SHA and build run ID; the same environment requires a second approval. The workflow validates all nine build artifacts and deploys immutable tag-plus-digest image references. Rerun builds are not deployable, and retired workflow identities remain disabled.

Do not rewrite or force-push `master` or `dev`. Preserve unrelated tracked, staged, and untracked work.

## Trusted-check bootstrap

Do not require a new check before its trusted publisher exists on protected `master`, the repository's default branch. Roll out check changes in two phases:

1. Merge the trusted workflow and publisher into `dev` under the currently enforced checks.
2. Trigger a fresh PR snapshot (or dispatch `branch-policy.yml` with its PR number), verify the new statuses come from the expected workflow IDs, and only then replace branch-protection contexts or disable the retired workflow identity.

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
