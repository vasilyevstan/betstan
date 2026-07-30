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

Direct pushes to `dev` are allowed, but focused pull requests are preferred for reviewable changes. Pull requests into `master` from any branch other than `dev` are forbidden.

## Production safety

Merging to `master` can build and deploy production. Manual `production-build` and `production-deploy` dispatches or reruns are emergency operations: they require an exact full SHA from protected `master` and approval through the `production-emergency` environment. The retired workflow identities remain disabled so historical runs cannot be rerun.

Do not rewrite or force-push `master` or `dev`. Preserve unrelated tracked, staged, and untracked work.

## Trusted-check bootstrap

Do not require a new check before its trusted workflow exists on `dev`, the repository's default branch. Roll out check changes in two phases:

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
