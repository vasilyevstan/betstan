# Live Betting Production

BetStan simulates a persisted, restart-safe football match over ten real
minutes. Gamemaster owns the deterministic timeline, incidents, score, market
versions, quote revisions, and final result. Event owns the public read model
and SSE snapshots. Slip keeps independent live and pre-match boards.
Moderation revalidates phase and quote authority, Resulting settles market
versions, and Bet exposes labelled history.

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

The later compact-presentation release at exact master
`e7ca18a52696b50d27c5d7a18ed00eeeeaa18423` was deployed successfully by run
`33418318240`. Activation `33419673381` then failed at a browser assertion that
still expected the two terminal countdown cards to remain visible after
kickoff; subsequent browser, queue, restart, and permanent-commit gates were
not evaluated. Cleanup completed: production is in dark mode, new live
kickoffs are disabled, the exact synthetic active Slip is gone, the reusable
test account was restored to `USER`, and no activation lease remains. The
failed first attempt is immutable; the corrected five-visible-card assertion
requires a new exact-SHA release chain.

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

Protected rollback authority:

- source `3ce5ddcc031081f1658e91fa658000aa9a9f9ab4`;
- OCI build `33249834065`;
- deployment `33252255145`.

This fallback is executable only while all required immutable artifacts remain
retained. The earliest current artifact expiry is
`2026-09-28T11:28:54Z`, but the build run reaches the workflow's 30-day age
limit earlier at `2026-09-28T11:18:50Z`. Replace or recertify rollback
authority before the earlier cutoff or when a newer release becomes the
accepted fallback.

Disable new kickoffs before rollback. Already-started matches and submitted
live bets must finish on compatible code.
