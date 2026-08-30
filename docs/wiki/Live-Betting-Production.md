# Live Betting Production

BetStan simulates a persisted, restart-safe football match over ten real
minutes. Gamemaster owns the deterministic timeline, incidents, score, market
versions, quote revisions, and final result. Event owns the public read model
and SSE snapshots. Slip keeps independent live and pre-match boards.
Moderation revalidates phase and quote authority, Resulting settles market
versions, and Bet exposes labelled history.

## User-visible behavior

- Live events appear above upcoming events in a compact full-row card.
- Before kickoff, two countdown products are enabled.
- After kickoff, five in-play products plus both non-selectable countdown
  products remain visible, for seven market cards. `KICKOFF_TEAM` settles at
  kickoff; `FIRST_MINUTE_GOAL` is closed until `FIRST_MINUTE_ELAPSED`, then
  settles.
- Live and pre-match selections never mix in one slip. Both boards may stay
  open and retain independent wagers and submission state.
- Live incidents include goals, cards, corners, free kicks, penalties,
  half-time, stoppage time, second-half kickoff, and full-time. Not every
  incident type appears in every match.
- Goals are the only score source. Remaining next-event markets settle
  explicitly to `NONE` at full-time.

## Production release

Live betting was permanently activated on 2026-08-30 from exact master
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

## Compatibility and rollback

Ordinary legacy rows without live market evidence normalize to `PRE_MATCH`;
compatibility backfills infer `LIVE` when row-level live identifiers prove it.
A missing event phase defaults only for a truly scheduled pre-match record.
Resulted or positive-sequence/cursor records retain their existing authority
instead of being relabelled. Additive schemas remain readable by the recorded
fallback application.

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
