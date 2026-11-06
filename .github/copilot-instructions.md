# BetStan repository instructions

TypeScript microservices betting platform. Read the current tree; never trust stale conversation state or branch names.

Policy: [CONTRIBUTING](../CONTRIBUTING.md) · [branch skill](skills/betstan-branch-governance/SKILL.md) · [agents](agents/README.md) · [PR template](pull_request_template.md) · [learnings](../LEARNINGS.md) · [security](../docs/copilot-security-guardrails.md) · [release](../docs/wiki/Release-Orchestration.md)

## Rules

- Never commit or push directly to protected `dev` or `master`; changes reach `dev` by PR, `master` only from up-to-date `dev`.
- One accountable owner (optionally [`betstan-delivery-coordinator`](agents/betstan-delivery-coordinator.agent.md)), proportionate verification; independently verify changed trust/state boundaries. No mandatory agent chain or review-of-review. Reuse accepted evidence; targeted checks while correcting, one full validation of the final SHA.
- Exact-SHA CI is required; skipped, stale, pending, neutral or unrelated checks are not success.
- Handle eligible CLI-owned approvals promptly via canonical helpers; human-origin work needs approval bound to its exact head SHA.
- Record documentation impact for every change; update `docs/wiki/` when public behavior or guidance changes.
- Preserve unrelated work. Never expose credentials, private records or session paths.
- Never mutate production, data or protected environments outside authorized exact-SHA controls.
- Stay backward compatible unless an explicit migration and rollback contract says otherwise.
- Prove required feature commits are ancestors of the exact `master` released; production mutations stay serialized.

## Pull requests

- Use the template; conditional fields say `not applicable`.
- Add public-safe labels: `PR_SESSION_TAG=<slug> PR_FEATURE_TAG=<slug> ./infra/azure/agents/pr-context-labels-stan.sh <pr>`. They are informational only.
- Only Copilot CLI may add `copilot-cli-managed`, only to a PR it created and owns; the label alone proves nothing and bypasses no gate.
