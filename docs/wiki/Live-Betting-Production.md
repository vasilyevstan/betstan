# Live Betting Production

BetStan simulates a persisted, restart-safe football match over ten real
minutes. Gamemaster owns the deterministic timeline, incidents, score, market
versions, quote revisions, and final result. Event owns the public read model
and SSE snapshots. Slip keeps independent live and pre-match boards.
Moderation revalidates phase and quote authority, Resulting settles market
versions, and Bet exposes labelled history.

The rules below are the live-betting specialization of
[[UI UX Consistency]]. Every visual or interaction change uses that page's
named-reference, cross-state, exception, and exact-head UX review contract.

## User-visible behavior

- Dense live, countdown, recently finished, and pre-match sections share the
  same responsive one/two/three-card grid. A sparse desktop section expands one
  card to a bounded two-thirds row and two cards to a balanced half-width row.
- Long team names wrap without moving the odds baseline. The ten-option Correct
  Score board uses five columns when its card can preserve touch targets and
  falls back to two balanced columns in a narrow nested card.
- Before kickoff, two countdown products are enabled.
- After kickoff, the five active in-play products remain visible.
  `KICKOFF_TEAM` settles and `FIRST_MINUTE_GOAL` closes at kickoff, so both
  terminal countdown cards are hidden from that moment. The latter is graded
  after `FIRST_MINUTE_ELAPSED` with no further visible-card change, while both
  authoritative market states remain in the live snapshot.
- Live and pre-match selections never mix in one slip. Both boards may stay
  open and retain independent wagers and submission state.
- Live incidents include goals, cards, corners, free kicks, penalties,
  half-time, stoppage time, second-half kickoff, and full-time. Not every
  incident type appears in every match.
- Goals are the only score source. Remaining next-event markets settle
  explicitly to `NONE` at full-time.
- A finished card shows a compact chronological `Key moments` list plus a
  native, expandable chronological full timeline; it never presents a
  reversed latest-five tail as the match summary. A verified full history is
  labelled `Full timeline (N)`; absent/legacy/malformed history is labelled
  `Available timeline (N)` and states that earlier incidents may be
  unavailable. A scored penalty and its linked goal render once via an exact
  relation-ID match, never a team/minute heuristic.
- 1X2 shows compact `1`/`X`/`2` tokens while full team identity remains in the
  card header and accessible name; malformed/legacy boards keep their
  original names and order instead of a false `1/X/2` mapping. Correct Score
  uses one stable ascending `(homeGoals, awayGoals)` order; the presentation
  sort never changes an option's ID/name/value tuple or selection identity.
  Both market headings share one centered treatment.
- When exactly one countdown, active-live, or retained-finished event occupies
  the upper section, it uses the full event-stage width with its semantic
  regions arranged side by side, and stays within a bounded height budget
  relative to the comparable pre-match row; only an expanded historical
  timeline may exceed that budget.
- Compact pre-kickoff market grids collapse phantom empty tracks with
  `auto-fit`, stretch cards sharing a row to equal height, and wrap status
  words only between words.
- Backoffice navigation shows visible discoverable text for administrators in
  every UI variant and stays hidden for ordinary users, legacy roleless users,
  and anonymous visitors.

## Timeline completeness and terminal safeguards

- `incidentHistoryComplete`/`incidentsComplete` is an optional, additive
  producer attestation: Gamemaster sets it only on payloads built from its
  authoritative cumulative transition history (including the complete empty
  pre-kickoff list and manual full-time result); Event sets the public flag
  only when the update carries that attestation, includes the cumulative
  incidents array, every raw incident validates, and the normalized list fits
  the full-time floor. The flag stays absent/false for legacy rows,
  single-incident compatibility updates, malformed/truncated input, and
  non-terminal phases; a previously finished row cannot be reconstructed after
  the fact, so honest partial labelling replaces a false completeness claim.
- A result/`FULL_TIME` write decision is atomic against the current live phase
  and explicit/legacy offline intent, so no interleaving can leave a fully
  onboarded, non-retired terminal event `OFFLINE`; the terminal status always
  becomes `RESULTED`. A placeholder remains fail-dark until event metadata and
  visibility authority are initialized, even when pending intent is `ONLINE`.
  An equal-sequence authoritative merge adopts the current status/visibility
  while keeping whichever terminal snapshot has the stronger incident history
  (verified-complete first, otherwise longer).
- An acceptance-scoped retained `OFFLINE` snapshot must not render, clear, or
  leak while current-user authorization is unresolved, and afterward is
  retained only when its event ID is in the administrator's acceptance scope.

## Production release

Live betting was first permanently activated on 2026-08-30 from exact master
`0bf1d01981e454cd6ca661d8e6d99997462c558c`.

| Stage | Run |
|---|---:|
| Production build | `33307059664` |
| OCI/GHCR build | `33307558371` |
| GHCR validation | `33308076137` |
| Capacity | `33308191145` |
| Infrastructure | `33308306279` |
| Data dry-run | `33308673229` |
| Data backfill | `33309055711` |
| Slip index/handoff | `33309897271` |
| Dark deployment | `33310369637` |
| Activation | `33311534616` |

The activation passed the complete browser journey, live and pre-match
settlement, protected-account cleanup, queue checks, REST/SSE compatibility,
and restart checks. Final state is `LIVE_KICKOFFS_ENABLED=true`,
`activation_state=committed`, with no activation lease.

The compact-presentation candidate at exact master
`e7ca18a52696b50d27c5d7a18ed00eeeeaa18423` was deployed by run
`33418318240`. Activation `33419673381` failed at a stale seven-visible-card
browser assertion. Cleanup restored dark mode, disabled kickoffs, removed the
exact synthetic Slip, restored the reusable account to `USER`, and cleared the
lease. That failed first attempt remains immutable.

The corrected compact release is permanently active from exact master
`f4a0b333963b3a458c9b2b48c2aae1f6267f754d`.

| Stage | Run |
|---|---:|
| Production build | `33436391225` |
| OCI/GHCR build | `33437490565` |
| GHCR validation | `33438579478` |
| Capacity | `33438984944` |
| Infrastructure finalize | `33439362885` |
| Data dry-run | `33440517994` |
| Data backfills | `33441373219` |
| Slip index/handoff | `33442790087` |
| Dark deployment | `33443908124` |
| Permanent activation | `33444998653` |

The backfill changed exactly seven eligible legacy Event boards and converged
to zero matches without changing existing Slip or Bet snapshots. Activation
passed the full ten-minute browser journey, independent live and pre-match
slips, quote refresh and stale-quote handling, moderation, settlement, history
labels, SSE ordering, cleanup, queue/restart checks, and permanent commit. Two
synthetic matches completed `1-2` and `2-1`. Final state is
`LIVE_KICKOFFS_ENABLED=true`, `activation_state=committed`, with no activation
lease.

Terminal validation bound all nine running images to immutable GHCR digests,
verified the shared eight-database topology and retained Bound 50 GiB Mongo
PVC, zero RabbitMQ backlog, ingress/TLS/redirects, REST and SSE health, and all
current 1X2 and Correct Score boards. Forty-four deployed-client regressions
and 24 read-only real-production responsive checks passed across v1/v2/v3,
light/dark, and 1600/768/390/320px widths without clipping, overflow,
misalignment, short touch targets, page errors, or API failures.

The next release that lands the live-timeline/market-alignment slice must
extend this acceptance journey with: full bounded timeline
completeness/labelling, penalty-linked deduplication, live-card relative
height and pre-kickoff market alignment, stable Correct Score order, and
visible administrator navigation across UI variants. Record its exact master
SHA and run evidence in a new dated entry above once that release completes.

## Compatibility and rollback

Ordinary legacy rows without live market evidence normalize to `PRE_MATCH`;
compatibility backfills infer `LIVE` when row-level live identifiers prove it.
A missing event phase defaults only for a truly scheduled pre-match record.
Resulted or positive-sequence/cursor records retain their existing authority
instead of being relabelled. Additive schemas remain readable by the recorded
fallback application.

Scheduler events are inserted with `$setOnInsert`, so pricing improvements
apply automatically to new slots but do not rewrite the already persisted
24-hour pool. The corrected release candidate extends the existing event
compatibility backfill to deterministically repair implausible or duplicate
Correct Score boards on non-terminal events and reprice 1X2 from the same
distribution. The operation remains event-database-only and follows the
existing dry-run, apply, and zero-match verification phases.

Existing draft and submitted rows keep their snapshotted event, product,
selection, label, and price. A Correct Score selection ID is retained only when
the repaired board keeps the same label; replacement outcomes receive stable
new IDs so an old draft cannot be visually reinterpreted as a different score.

The immediate pre-deploy rollback baseline captured former production source
`e7ca18a52696b50d27c5d7a18ed00eeeeaa18423` during deployment
`33443908124`; its original OCI build is `33369011703` and deployment is
`33418318240`. Retained independently certified fallbacks are:

- source `0bf1d01981e454cd6ca661d8e6d99997462c558c`, OCI build
  `33307558371`, deployment `33310369637`;
- source `3ce5ddcc031081f1658e91fa658000aa9a9f9ab4`, OCI build
  `33249834065`, deployment `33252255145`.

Rollback is executable only while the selected baseline, image provenance,
and immutable artifacts remain retained and current rollback-readiness checks
pass.

Disable new kickoffs before rollback. Already-started matches and submitted
live bets must finish on compatible code.
