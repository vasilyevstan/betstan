<!--
Record comprehensive rationale and real evidence for every PR. Keep conditional
release, data, feature-flag, and rollback fields present; write `not applicable`
when they do not apply. Headings, title wording and presentation are informational;
missing applicable safety evidence is not. Current executable checks remain in
force until proven cutover.
-->

## Why this change exists

<!-- State the user requirement, defect, incident, or operational need. -->

## Development context

<!--
Use public-safe GitHub labels, never a private session UUID or local path.
Aggregate PRs may list more than one value. These labels are informational:
their presence, absence or wording never establishes approval or source quality.
-->

- Session label(s), for example `session:live-betting-2026-09-04`:
- Feature label(s), for example `feature:live-betting`:

## Exact source and ancestry

- Base branch/SHA:
- Head branch/SHA:
- Promotion or synchronization merge SHA, when applicable:

## Scope and compatibility

- Changed behavior/files:
- Contract, schema, data, or migration effects:
- Explicitly out of scope:
- Backward-compatibility statement:

## User-facing consistency

<!-- Write `not applicable` throughout for changes with no visual or interaction effect. -->

- Affected routes/components, states, variants, themes, and viewport classes:
- Named reference screens/components/tokens:
- Intentional product exceptions and rationale:
- Consistency verification and exact source; specialist result when needed:
- Evidence used and unresolved uncertainty:

## Public wiki

- Documentation impact:
- Canonical `docs/wiki/` pages updated, or exact no-public-change rationale:
- Public-safety review:
- Post-merge byte-identical publication owner/status:

## Validation

<!-- List exact commands/checks and their outcomes. Do not write only "tests passed". -->

- Commands/checks and exact outcomes:
- Independent verification for changed trust/state boundaries, or why not applicable:
- Reused evidence and why it remains applicable:
- Unrun checks and reason:

## Release and rollback

- Production-capable workflows triggered:
- Origin/ownership and applicable exact approval evidence:
- Feature-flag or activation state:
- Deployment/data impact, or explicit `none`:
- Rollback source/build/deploy evidence, or explicit `not applicable`:

## Exceptions and remaining work

<!-- Explain intentional closure, replacement, zero-diff ancestry, or deferred work. -->
