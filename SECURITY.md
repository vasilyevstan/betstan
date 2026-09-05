# Security Policy

## Supported versions

Security fixes are developed on the current `dev` branch and released from
the current `master` branch. Older commits, images, and historical deployments
are not supported independently.

| Version | Supported |
| --- | --- |
| Current `master` production release | Yes |
| Current `dev` integration line | Yes |
| Older commits or releases | No |

## Reporting a vulnerability

Report suspected vulnerabilities through
[GitHub private vulnerability reporting](https://github.com/vasilyevstan/betstan/security/advisories/new).
Do not open a public issue with exploit details, credentials, private data, or
unredacted production evidence.

If private reporting is unavailable, open a public issue titled
`Security contact requested` without technical details so a private channel
can be arranged.

Include, when available:

- the affected service, route, workflow, or commit;
- the security impact and required preconditions;
- minimal reproduction steps using synthetic data;
- sanitized logs, requests, or screenshots; and
- any suggested mitigation.

Reports are triaged through the private advisory. Fix timing depends on impact,
reproducibility, and release safety. Please coordinate disclosure until a fix
is available or the maintainers confirm that publication is safe.

## Scope

Useful reports include:

- authentication, session, authorization, or data-isolation failures;
- injection, remote-code-execution, secret-exposure, or supply-chain issues;
- ways to bypass betting-integrity, idempotency, or settlement controls;
- exploitable CI/CD, deployment, container, or infrastructure weaknesses; and
- public Backoffice behavior that bypasses its documented validation,
  idempotency, or serialization boundaries.

Backoffice access itself is intentionally public and is not a vulnerability.
BetStan is a simulation and does not process real-money wagers or real match
feeds.

## Safe research

Use synthetic accounts and data. Do not disrupt production, access another
user's data, perform denial-of-service or social-engineering tests, or attempt
to obtain secrets. Stop testing and report immediately if sensitive data is
encountered.

Good-faith research that follows this policy will be handled constructively.
See the [security architecture](https://github.com/vasilyevstan/betstan/wiki/Security)
for the product's trust boundaries and controls.
