# Quality Gates

## Quality model

BetStan uses layered evidence. A passing unit test is necessary but not enough
for a cross-service feature, and a successful deployment command is not proof
that production is healthy.

```mermaid
flowchart LR
    Request["Accepted requirement"] --> Architect["Architecture gate"]
    Architect --> Simplifier["Three-model simplifier"]
    Simplifier --> Developer["Implementation owner"]
    Developer --> Wiki["Public-wiki editor"]
    Wiki --> Critic["Validation critic"]
    Critic --> Tests["Test engineer"]
    Tests --> Final["Final validator"]
    Final --> PR["PR and branch checks"]
    PR --> Build["Exact-SHA build"]
    Build --> Deploy["Protected deployment"]
    Deploy --> Accept["Production acceptance"]

    UX["UX/UI specialist"] -. user-facing evidence .-> Developer
    Contract["Contract specialist"] -. boundary evidence .-> Critic
    Security["Auth/security specialist"] -. security evidence .-> Final
    Conductor["Conductor"] -. checkpoints and recovery .-> Architect
    Conductor -.-> Accept
```

The conductor coordinates the chain but does not replace a quality gate or
grant release authority.

## Universal review chain

| Gate | Purpose | Required outcome |
|---|---|---|
| Architect | Define service boundaries, compatibility, dependencies, risks, and acceptance criteria | Bounded implementation contract |
| Simplifier | Challenge unnecessary scope and conflicting abstractions with three independent model families and one synthesis | Smallest complete design |
| Developer | Implement one owned slice with focused tests | Immutable candidate |
| Public-wiki editor | Assess every change and update relevant canonical public documentation | Public-safe documentation included in the candidate |
| Validation critic | Search for concrete correctness, concurrency, compatibility, and regression failures | No unresolved required finding |
| Test engineer | Run the smallest targeted suite, then required regression tiers | Reproducible passing evidence |
| Final validator | Reconcile all requirements, specialist findings, tests, and exact-head evidence | Ready for release review |

## Conditional specialist gates

- `betstan-ux-ui-expert` is mandatory for every user-facing visual or
  interaction change.
- Shared HTTP, message, package, or persistence boundaries require the service
  contract reviewer.
- Authentication, session, identity, and authorization changes require the
  auth/security reviewer.
- CI or coverage changes require the quality-gate reviewer.
- Branch, PR, ancestry, or exact-SHA questions require the branch-governance
  reviewer.
- Infrastructure, deployment, rollback, migration, ingress, and runtime work
  require their matching operator or safety specialist.

See [[Agents]] for the complete catalog.

## Pull-request CI

Pull requests to `dev` or `master` run the production validation workflow. Its
required aggregate gate includes:

| CI area | What it proves |
|---|---|
| Manifest validation | Kubernetes YAML parses successfully |
| Ingress routing guard | Production hosts and API paths retain safe routing |
| Script validation | Deployment and runtime scripts parse and their focused contract tests pass |
| Workflow trigger guard | Production-capable workflows keep their intended triggers and trust boundaries |
| Deployment safety contracts | Readiness, activation, rollback, migration, and recovery invariants remain intact |
| Auth container smoke | A production-built Auth container typechecks, starts, and serves the expected API shape |
| Service coverage | Auth, Backoffice, Bet, Event, Gamemaster, Moderation, Resulting, Slip, and Client meet at least 80% line coverage and 80% branch coverage where branches exist |
| Client production build | The React application builds successfully in CI |

The OCI-specific validation workflow also checks workflow syntax and runs the
complete offline OCI contract suite.

## Application test layers

### Service tests

Backend services use Jest, TypeScript checking, in-memory MongoDB, and mocked
or controlled RabbitMQ channels. Tests cover routes, models, listeners,
publishers, retries, idempotency, compatibility, and concurrency.

### Shared package tests

The Common package must:

- compile independently;
- pass current and legacy AMQP compatibility type checks;
- pass its runtime tests;
- build the exact packed artifact that will be published.

### Client tests

The client uses React tests plus Playwright browser coverage for:

- event, live, countdown, and retained-finished states;
- separate betting boards and bet history;
- responsive desktop/tablet/mobile behavior;
- v1/v2/v3 layout variants and affected themes;
- keyboard and accessible names;
- computed alignment, overflow, touch targets, and stable control ordering;
- public Backoffice discovery and use.

Rendered evidence is required when the claim depends on geometry, clipping,
focus, or dynamic interaction. A screenshot-only assertion is not enough.

## Domain-specific gates

### Messaging and compatibility

- old and new producers/consumers can overlap safely;
- duplicated and reordered messages are harmless;
- pending publication survives restart;
- optional fields preserve historical records;
- selection and settlement identity remain ID-based.

### Live betting

- deterministic corpus tests cover realistic normal and stoppage-time
  distribution;
- simulation restart produces the same authoritative outcome;
- quote, phase, market, and settlement transitions remain monotonic;
- every transition exposes no more than six non-terminal products, rotation
  settles before replacement, and market versions increase before a type
  re-enters;
- products with multiple same-side options moderate and settle by exact
  selection ID, with labels preserved across every service boundary;
- full-time history never makes a false completeness claim;
- live and pre-match slips cannot mix.

### UI/UX

- hierarchy and terminology match stable product patterns;
- sibling-card headings, controls, and odds baselines align;
- ordering is stable and preserves IDs;
- all required states remain visible and understandable;
- layouts avoid overflow and unnecessary vertical growth.

## Release and production gates

Before deployment:

- the promotion is the current reviewed `master` SHA;
- every declared feature/fix commit is an ancestor of that SHA; additional
  protected commits are allowed and validated as part of the aggregate;
- build and registry provenance are complete;
- required data dry-runs, migrations, and indexes are complete;
- any bounded one-off cleanup proves exact identity, zero financial
  dependencies, a verified recovery tombstone, and post-apply absence;
- a matching rollback baseline exists;
- no competing production operation is active.

After deployment:

- workloads run the expected digests;
- health, routing, TLS, APIs, SSE, queues, consumers, and storage pass;
- the browser acceptance journey has no page, console, API, or log errors;
- activation is committed only after its bounded acceptance succeeds.

## Evidence rules

- Evidence belongs to an exact immutable SHA.
- Pull request titles are short, understandable outcomes; merge safety rejects
  single-word, overlong, or ambiguous `chore`/`misc`/`wip` titles.
- A skipped, stale, pending, unrelated, or branch-name-only check is not
  success.
- A rerun cannot replace first-attempt provenance when the contract requires
  attempt one.
- Reviewers do not approve their own implementation.
- Corrections return to the same logical owner and gate.
- Release documentation records scope, exclusions, validation, risk, release
  impact, rollback, and remaining work.

## Documentation quality

The public-wiki gate is mandatory for every change. Canonical wiki pages are
reviewed source files and relevant changes land in the same pull request as
the behavior they describe. Their tests require the expected handbook pages
and navigation, and reject known classes of sensitive public content such as
private authority mechanics, user-specific paths, and globally routable
infrastructure addresses. After merge, publication must be byte-identical to
the canonical repository files.

## Related pages

- [[Agents]]
- [[Security]]
- [[Release Orchestration]]
- [[UI UX Consistency]]
