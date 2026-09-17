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

A live quote identity is `marketId + marketVersion + quoteVersion`, and it
owns exactly one validity window. Each material transition that advances
`quoteValidUntil` advances the quote version even if the calculated odds round
to the same values. Newly opened replacement markets begin at quote version 1,
while non-material markers such as the first-minute settlement marker preserve
the existing identity and expiry. This projection rule is engine-versioned;
matches already in progress continue replaying their persisted transitions.

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

Production acceptance keeps two different timing claims separate. It places a
multi-event live slip while the countdown quotes are stable until kickoff, then
places an in-play selection against one moving event clock with bounded
stale-quote retries. It never weakens Moderation or depends on overlapping
authority windows from independent accelerated matches. Each attempt writes
its quote identity, expiry, immutable submission time, and any decline details
to the protected activation artifact before the journey requires a successful
placement.

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

## Release state and evidence

Deployment, activation, scheduling, and observed play are distinct facts:

| State | What it proves |
| --- | --- |
| Deployed dark | The candidate images are deployed and validated without enabling new automatic kickoffs |
| Temporary activation lease | A bounded acceptance window is open; this is not permanent enablement |
| Permanent enablement | Activation has committed after acceptance; this does not prove a match has already started |
| Current public schedule | The ordinary public Event projection exposes upcoming fixtures and kickoff times |
| Observed automatic public kickoff | A scheduled public fixture is observed advancing through the ordinary countdown and live path |

Offline, acceptance-scoped synthetic fixtures prove the isolated browser,
quote, moderation, and settlement journey. They do not prove ordinary public
activity, even when they complete successfully or contribute to Telemetry
counts. A green Telemetry summary is likewise not kickoff evidence.

The recently finished card can remain visible until the next event enters
its countdown; a reconnect after kickoff also reconciles it against the new
live event. Retaining a completed card alone is not evidence of a stalled
scheduler. Public visibility and acceptance-only visibility remain separate.

This page describes behavior, not a timestamped production-status inventory.
Current enablement, schedule, and observed kickoff claims require their own
exact release and public-read evidence. Historical acceptance does not prove
that an ordinary public kickoff happened today. See [[Release Orchestration]]
for the release and rollback contract.

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

The pending release also defines one fixed cleanup of the Backoffice event
projection. It can delete only `gaming_backoffice.events` rows with a valid,
explicitly zoned kickoff strictly before `2026-09-01T00:00:00Z`. Rows exactly
at or after that instant remain. The boundary is not configurable or rolling,
and the operation does not cascade into any other service database. It has not
been run in production.

The cleanup operator exposes dry-run, apply, and verify only. It uses bounded
batches against the fixed database; apply requires the operation-specific
confirmation and an exact source SHA. It fails closed when it observes any
malformed or missing kickoff, unsafe publication marker, invalid or duplicate
candidate event ID, invalid or conflicting journal, target drift, changed
marker, or candidate outside the journal. A prepared operation can resume only
for its recorded source and exact target set. Once applied, later release
candidates may reverify the same fixed journal, but cannot expand it.

The journal contains only fixed operation metadata, sanitized event
identity/time pairs, their count and digest, the applying source, state, and
state timestamps; it does not copy event documents or connection data.
Verification requires that fixed journal to be applied, with no remaining
candidates, journal targets, malformed times, or reason codes. The compatible
Backoffice listener permanently ACK-skips only valid pre-cutoff `NEW_EVENT`
replays; malformed or missing kickoff data retains legacy handling as described
in [[Application Processes]].

Once the cleanup is applied, a Backoffice image without that permanent
listener guard is no longer rollback-compatible: a queued or delayed valid
pre-cutoff delivery could otherwise recreate a deleted projection. Both
ordinary and maintenance-fenced rollback bind the exact target's compatibility
before workload mutation and fail closed when the journal cannot be read or
classified. This gate is independent of the existing pending-publication
replay-or-drain compatibility gate; both decisions must pass. See
[[Release Orchestration]] for journal state classification and retained-hold
recovery.

There is no cleanup-command rollback mode. Rollback and interrupted-release
recovery continue to rely on the protected pre-mutation baseline, write fence,
database lock, and bounded recovery controls; no ad hoc reverse operation is
introduced.

Artifacts generated by the pending cleanup release use `live-betting-v5` and
require both `event_reschedule_complete` and
`backoffice_pre_september_cleanup_complete`. Compatibility is exact rather
than schema-label-only: the verifier continues to accept the literal
historical meanings of `live-betting-v1` through `v4`, while an unknown
`live-betting-v6` generation is rejected. This version contract does not
assert that a `v5` production run has occurred.

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

### Bounded one-time fixture maintenance

The protected live-data rollout includes fixed-identity provisioning, not a
public rescheduling API or a general scheduler. It creates only reviewed
offline targets, preserves historical fixtures and their betting dependencies,
and does not move an existing fixture's kickoff in place. A source-bound
journal and pre-mutation baseline preserve the exact before/after state.
Unknown, conflicting, or progressed target state blocks mutation or rollback
rather than being overwritten.

The historical destructive fixture cleanup remains uninvoked by the rollout
and bound to its original target; it is not routine retention or authority to
remove later fixtures. Historical evidence generations retain their original
identity and meaning rather than being relabelled for a new release.

A failed data phase remains failed even when it produces a sanitized diagnostic
report. Missing or contradictory evidence cannot become success provenance or
a deployment handoff. Exact fixture inventories, artifacts, and recovery
procedures belong in protected evidence, not this public page.

Rollback depends on a retained, compatible baseline and current readiness,
not an old list of source SHAs or run IDs. New kickoffs remain disabled during
rollback while already-started matches and submitted live bets require
compatible completion. See [[Release Orchestration]].
