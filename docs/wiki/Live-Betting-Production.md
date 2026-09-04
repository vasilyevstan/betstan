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
  same responsive one/two/three-card grid. A single upper live/countdown card
  uses the full event-stage width; sparse pre-match sections retain their
  bounded card widths.
- Long team names wrap without moving the odds baseline. The ten-option Correct
  Score board uses five columns when its card can preserve touch targets and
  falls back to two balanced columns in a narrow nested card.
- Before kickoff, two countdown products are enabled.
- After kickoff, at most six non-terminal in-play products remain visible.
  `KICKOFF_TEAM` settles and `FIRST_MINUTE_GOAL` closes at kickoff, so both
  terminal countdown cards are hidden from that moment. The latter is graded
  after `FIRST_MINUTE_ELAPSED`. The in-play set then rotates deterministically
  as next-incident markets settle, while terminal market versions remain in
  the authoritative snapshot for audit and settlement replay.
- Live and pre-match selections never mix in one slip. Both boards may stay
  open and retain independent wagers and submission state.
- Live incidents include goals, yellow and red cards, corner kicks, notable
  free kicks, throw-ins, goal kicks, penalties, half-time, stoppage-time
  announcements, second-half kickoff, and full-time. Not every incident type
  appears in every match.
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
- Backoffice navigation shows visible discoverable text in every UI variant
  for anonymous, ordinary, legacy-roleless, and administrator states. The
  Backoffice catalog and controls are intentionally public in every one of
  those states; responses are marked `Cache-Control: no-store`, inputs are
  bounded, blank scores cannot become an accidental `0-0`, result writes
  distinguish identical retries from conflicting final scores, and
  visibility updates submit an explicit target state. Every mutation persists
  a retry marker with its state change, uses a durable broker confirm, and is
  replayed after restart until confirmed; event creation carries a stable
  request ID so an ambiguous response cannot create a second event.

## Incident generation and live products

Gamemaster creates the complete match timeline from a private seed before
publishing the first transition. Each incident category uses an independent
named random stream, so adding a new category does not perturb existing score,
card, or timing draws. Generation is calibrated over a deterministic corpus,
not by forcing every match to contain every incident.

The ordinary-volume restart events use explicit expected-rate and hard-cap
bounds per simulated match:

| Incident | Expected rate | Hard cap | Team tendency |
|---|---:|---:|---|
| Throw-in | 38 | 60 | Follows attacking share |
| Goal kick | 16 | 30 | Favors the side facing more pressure |
| Notable free kick | 8 | 24 | Follows discipline pressure |

Structural incidents and scoring/card/penalty events retain their existing
deterministic rules. Added-time announcements occur before incidents in their
stoppage window, and the final score is still derived only from goals.

The live products and lifecycle are:

| Product | Selections | Opens | Stops accepting | Settles |
|---|---|---|---|---|
| Kickoff Team | Home, Away | Final ten-minute countdown | Kickoff | Kickoff |
| Goal in First Minute | Yes, No | Final ten-minute countdown | Kickoff | End of simulated minute one |
| Half Time Result | Home, Draw, Away | Kickoff | Half-time | Half-time score |
| Second Half Score | Ten exact score choices | Kickoff | Suspended at half-time; closed at second-half kickoff | Full-time second-half goals |
| Next Yellow Card | Home, Away, None | Assigned rotation slot | Matching incident, cap exhaustion, or full-time | Next yellow card or None |
| Next Corner Kick | Home, Away, None | Assigned rotation slot | Matching incident, cap exhaustion, or full-time | Next corner kick or None |
| Next Free Kick | Home, Away, None | Assigned rotation slot | Matching incident, cap exhaustion, or full-time | Next notable free kick or None |
| Next Throw-In | Home, Away, None | Assigned rotation slot | Matching incident, cap exhaustion, or full-time | Next throw-in or None |
| Next Goal Kick | Home, Away, None | Assigned rotation slot | Matching incident, cap exhaustion, or full-time | Next goal kick or None |
| Next Penalty | Home, Away, None | Assigned rotation slot | Matching incident, cap exhaustion, or full-time | Next penalty award or None |
| Next Red Card | Home, Away, None | Assigned rotation slot | Matching incident, cap exhaustion, or full-time | Next red card or None |

The seven next-incident types have one stable round-robin order. Four occupy
slots during the first half alongside Half Time Result and Second Half Score.
At second-half kickoff, Second Half Score closes and the next-incident pool
may expand to six slots. A market leaves an actionable slot only after an
authoritative settlement or lifecycle closure; its replacement receives the
next market version and deterministic opening quote. Restart replay uses the
persisted transition list, so it cannot choose a different rotation.

Second Half Score represents goals scored after half-time, not the final match
score. Its stable choices are `0 - 0`, `1 - 0`, `0 - 1`, `1 - 1`, `2 - 0`,
`0 - 2`, `2 - 1`, `1 - 2`, `2 - 2`, and `Other`. At full-time Gamemaster
subtracts the retained half-time score from the final score and settles the
exact selection ID. The selections intentionally share the neutral side
classification, so Moderation and Resulting must use exact selection identity
instead of treating a matching side as sufficient.

Event retains up to 256 terminal incidents and Moderation retains up to 256
quote-history entries per market. These bounds exceed the configured
worst-case generated lineage while remaining finite.

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
  becomes `RESULTED`. Every terminal visibility writer and delayed recovery
  path re-evaluates that authority at write time, so a stale pre-read cannot
  overwrite a concurrent administrator `OFFLINE` decision.
  A placeholder remains fail-dark until event metadata and visibility authority are
  initialized, even when pending intent is `ONLINE`. An equal-sequence
  authoritative merge adopts the current status/visibility while keeping
  whichever terminal snapshot has the stronger incident history
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

The public Backoffice image no longer consumes authentication settings, but
its Deployment intentionally retains the legacy authentication-service and
signing-secret bindings. Rollback changes the image without restoring an older
manifest, so those legacy inputs must remain available for the immediately
previous protected Backoffice image to start.

Backoffice mutations also persist pending broker-publication markers. Before
rolling back to a generation that predates their replay worker, the rollback
operator installs the reviewed HTTP write fence, leaves the current worker
running, and waits for the pending marker count to reach zero. Query failure,
malformed output, or a nonzero count blocks image mutation. The drain is
skipped only when exact target-source evidence proves that the rollback image
starts the compatible worker. A partial rollback keeps the fence active for
recovery and records that state in the failed-run artifact. The partial
recovery operator re-establishes the fence, restores the exact pre-run images,
rechecks readiness, and only then releases writes; a successful rollback also
releases the fence after all health gates pass. The older protected image can
read the additive documents, but it cannot replay an undelivered mutation.

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

A one-time obsolete synthetic-event cleanup is part of the protected
live-data rollout. It is not exposed as an HTTP endpoint. The operation is
fixed to one reviewed identity, scans betting, moderation, settlement, and
archive stores for dependencies, and refuses mutation on any mismatch. Apply
runs only while writers are quiesced and the shared database operation lock is
held. It records a canonical Extended JSON snapshot and checksum inside a
Gamemaster archive tombstone before exact optimistic deletes, verifies that
the active projections are gone, and supports a separately confirmed rollback
that restores the exact snapshot and removes the tombstone.

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
