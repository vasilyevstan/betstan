# BetStan repository instructions

BetStan is a TypeScript microservices betting platform. Read the current tree
before acting; do not rely on stale conversation state or branch names.

## Start here

- Contributor and branch rules: [`../CONTRIBUTING.md`](../CONTRIBUTING.md)
- Durable engineering lessons: [`../LEARNINGS.md`](../LEARNINGS.md)
- Reusable agent workflow: [`agents/README.md`](agents/README.md)
- Pull-request evidence: [`pull_request_template.md`](pull_request_template.md)
- Branch procedure: [`skills/betstan-branch-governance/SKILL.md`](skills/betstan-branch-governance/SKILL.md)
- Security guardrails: [`../docs/copilot-security-guardrails.md`](../docs/copilot-security-guardrails.md)
- Release orchestration: [`../docs/wiki/Release-Orchestration.md`](../docs/wiki/Release-Orchestration.md)

## Non-negotiable rules

- Never commit or push directly to protected `dev` or `master`.
- Use the fixed quality chain: architect, three-model simplifier synthesis,
  developer, public-wiki editor, critic, test engineer, then final validator.
- Treat the public-wiki assessment as mandatory. Relevant product,
  architecture, operations, UI, quality, release, or agent changes update
  canonical `docs/wiki/` sources before final validation.
- Keep corrections in the originating agent context; do not create duplicate
  agents or status-only handoffs.
- Preserve unrelated tracked, staged, and untracked work.
- Never expose credentials, tokens, private records, or session artifacts.
- Never mutate production, data, protected environments, or release state
  outside the authorized exact-SHA workflow and specialist gates.
- Treat skipped, stale, pending, neutral, branch-name-only, or unrelated checks
  as non-success.
- Keep changes backward compatible unless an explicit migration and rollback
  contract says otherwise.
- Multiple sessions may contribute to one release. Prove each required feature
  commit is an ancestor of the exact current `master`; additional protected
  commits are allowed, while production mutations remain serialized.

## Pull requests

Every PR uses the repository template and records core evidence. Conditional
release, data, feature-flag, and rollback fields remain present and say
`not applicable` when they do not apply.

Choose one public-safe `session:<slug>` label for the bounded development
session and one stable `feature:<slug>` label for the product or engineering
feature. Keep the pair on implementation, promotion, and ancestry-sync PRs;
aggregate PRs may carry multiple pairs. After creating each PR, run
`PR_SESSION_TAG=<slug> PR_FEATURE_TAG=<slug>
./infra/azure/agents/pr-context-labels-stan.sh <pr>`. Never use a private
session UUID, local path, credential, user identity, or production identifier.
These labels are informational only: do not branch checks, approval, merge,
release, or rollback decisions on their presence or value.

Only Copilot CLI may apply `copilot-cli-managed` to a PR it created and owns.
That label selects the no-personal-prompt path but never bypasses technical
gates. Every other PR requires approval bound to its exact current head SHA.
