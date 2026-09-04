# BetStan Wiki

BetStan is a real-time sports-betting simulation platform. It supports
scheduled pre-match betting, accelerated live football, independent live and
pre-match slips, moderation, settlement, bet history, and operational event
management.

## Product and system design

- [[Product Overview]] - capabilities, users, lifecycle, and product
  boundaries.
- [[Application Processes]] - account and session behavior, event and odds
  generation, slips, moderation, settlement, and Backoffice workflows.
- [[Architecture]] - service responsibilities, data ownership, and the
  high-level component diagram.
- [[Message Flows]] - event publication, wager placement, live updates, and
  settlement sequences.
- [[Security]] - trust boundaries, application and delivery controls, and the
  public-documentation boundary.

## Engineering and operations

- [[Infrastructure]] - current hosting model, runtime components, persistence,
  networking, and observability.
- [[Quality Gates]] - tests, CI checks, specialist reviews, and production
  acceptance.
- [[Release Orchestration]] - branch, build, deployment, activation, and
  rollback structure.
- [[Agents]] - the reusable agent team, role boundaries, and handoff model.
- [[Engineering Learnings]] - reusable lessons that are safe to share
  publicly.

## Feature and UX guidance

- [[Live Betting Production]]
- [[User Interface]]
- [[UI UX Consistency]]

## Documentation source and disclosure rule

The reviewed source for every page lives under `docs/wiki/`. Update that source
through the normal branch flow, then publish byte-identical content to the
GitHub Wiki.

This is a public handbook. It explains product behavior, architecture,
guarantees, and engineering practices, but excludes credentials, private
approval records, sensitive infrastructure identifiers, unpublished
endpoints, and step-by-step control-bypass or emergency-recovery procedures.
