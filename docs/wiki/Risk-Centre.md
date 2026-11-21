# Risk Centre

## Purpose and availability

Risk Centre is the bet-acceptance module inside **Moderation**, not a new
service. Its public editor opens at `/backoffice/risk-centre`, beside
**Market designer**. Backoffice proxies bounded management requests to
Moderation; it does not own another copy of the policy database.

This is a nominal Stanbucks simulation. Anonymous visitors can view and
change global rules, just as they can use the existing Backoffice controls.
Rule history does not claim authenticated attribution. Betting itself still
requires the authenticated owner, and public policy responses do not expose
player records or identifiers.

The transaction-dependent gateway requires the exact deployment capability
`RISK_CENTRE_ENABLED=true` and transaction-capable MongoDB. An unavailable
capability is shown explicitly. Basic admission controls do not require
historical accounting reconciliation; readiness for exposure, loss and
activity controls is shown only when working with those controls. The switch is not
an editable public rule. Source implementation is not proof of live
activation; see [[Infrastructure]] and [[Release Orchestration]].

## Rules and defaults

Rules use supported types and trusted placement fields, not executable
scripts or arbitrary financial formulas.

| Family | Purpose |
| --- | --- |
| Availability | Restrict admission by supported bet kind, structure, event, product, market or template |
| Timing | Acceptance delay and stricter supported timing/evidence cutoffs |
| Stake and price | Minimum/maximum wager, accepted odds, return and net-win exposure |
| Structure | Single/accumulator/Builder restrictions, legs, events and Builder selections |
| Activity | Submission counts, turnover and repeated-selection restrictions |
| Open exposure | Open principal, gross return and conservative operator-liability ceilings |
| Customer loss | Signed realised loss plus remaining and pending principal within each configured window |
| Integrity | Always-on identity, quote, market, mixed-kind and settlement-capability checks; enforced on every bet and not editable, so the editor does not list them |

Every matching restriction applies: the lowest ceiling, highest floor and
longest delay win. A narrower rule cannot relax a global rule. Conflicting or
unsupported policy values fail validation rather than being ignored. For
example, to require 5 Stanbucks pre-match but only 1 Stanbuck live, turn the
All events minimum stake off (or set it to 1 or less), then add a Pre-match
rule of 5 and a Live rule of 1.

Price and stake rules apply to the complete ticket: accumulators use the
combined price, not each leg. A rule scoped to Bet Builder also applies to a
ticket that combines a Builder with other selections, together with any
accumulator-scoped rules. History and exposure totals still classify such a
ticket as an accumulator; scope those totals by template to include Builder
legs in combined tickets.

New optional restrictions start off or unbounded, and acceptance delay
starts at zero. Existing hard safeguards cannot be turned off or widened beyond
their supported capabilities. An absent optional override uses its explicit,
versioned shipped default; a corrupt policy or missing required authority
never substitutes permissive defaults.

Wallet/balance/deposit/withdrawal controls, KYC/AML, external self-exclusion,
licensing/geolocation, device fraud and unsupported bet products are
unavailable. They are not simulated successful checks or claims of regulated
customer protection.

Existing pre-match closure at kickoff and rejection of resulted events are
always enforced; the Pre-match and Live sections state these checks. Live bets
always require an in-play event, an open market and an unchanged price. A positive pre-match cutoff closes
earlier; it never permits a pre-match bet after kickoff. There is no current
configurable post-event grace period. Match simulation duration belongs to
Gamemaster (`LIVE_MATCH_DURATION_MS`), not bet admission.

Zero configured acceptance delay does not promise an instantaneous response:
transport and missing-event-evidence retries can keep a bet pending. The
editor does not mislabel those retries as an active delay rule.

## Events and black-swan stress

The **Rules** and **Events** tabs separate policy editing from event review.
Switching tabs preserves an unsaved rule draft. Events lists all online,
unresulted upcoming and in-play events, without the public event page's time
horizon. Offline, finished and unresolved-visibility events are excluded.
Lifecycle-active source pauses remain visible so their choices can be managed.
Use **Previous events**, **Next events** and **Refresh events** to navigate
the catalogue; it is not a truncated list of the nearest matches.

Each event shows a conservative **loss bound**, not a black-swan probability
or a cross-ticket hedge calculation. Each open ticket contributes once per
event:

```text
max(0, original-principal return bound - original stake)
+ remaining principal while pending
```

Partial closure does not proportionally reduce the full standalone return
bound. A ticket involving several events appears under each relevant event;
do not sum overlapping event totals. Public reports contain aggregate amounts
and current market offers, not raw tickets, player IDs or receipt details.
Financial reads use a read-only MongoDB snapshot and do not increment the
admission serialization document.

Expand an event to test one new single, initially **1 Stanbuck**. The test
reserves its gross payout, including pending principal. Every matching,
enabled, non-customer **Operator exposure limit** is checked against its
whole applicable book, not just this event. The tightest headroom produces
**Lower odds** or **Consider turning off** guidance. **Within exposure
ceiling** describes only this test, not permission to accept the bet.
Per-customer limits are not book budgets. Without a configured applicable
ceiling, there is no odds recommendation; incomplete accounting is
**Unavailable**, never zero. Reports reserve no capacity, and admission
continues to enforce all applicable rules independently.

The same view switches an individual choice off or on. An off switch is a
normal **Block bets** rule with an exact event/origin/market/outcome identity;
it also matches that choice inside Builders and accumulators. Live identities
survive quote and market revisions without merging distinct score selections
that share `NONE`. Turning on removes only that choice's managed rule:
broader blocks and source pauses still apply. Pending and accepted bets keep
their original policy and price. Choices can remain visible to players while
new receipts containing them are declined.

**Manage odds** opens the existing custom-market editor. Standard and live
prices remain owned by their pricing models; analysis never automatically
reprices or removes a selection. Rule conflicts and uncertain switches use
the same revision and operation-recovery protocol as the Rules tab.

Backoffice exposes `GET /api/backoffice/risk-centre/events` and
`GET /api/backoffice/risk-centre/events/:eventId?stakeMinor=100` through its
fixed Moderation authority. Pages default to 20 events, at most 25; event
details support at most 1,000 choices. Test stakes are 1 to 1,000,000,000,000
minor units. Accounting retains the existing 10,000-position read budget,
checked before baseline/live deduplication can hide truncation. Exceeded
budgets report unavailable evidence, never partial totals. Choice rules
share the existing 128-rule/48-KiB policy limits.

## Saving and restoring

The editor shows readable rule names and saved values in the rule list.
Money is entered in Stanbucks and time in seconds; transport and enforcement
retain integer minor units and milliseconds. Choose a rule, enter its value,
select pre-match/live and bet type, then use the button that names the
outcome. Selecting a new rule opens its form directly. Specific event/product/market/template IDs and the full saved
settings/default comparison remain available under expandable details.

The unrelated unavailable-integrations panel is omitted. This does not
enable those integrations or remove any backend safeguard.

Rules are listed in three sections by where they apply: **All events**,
**Pre-match** and **Live**. Each section has its own **+ Add rule** list, so a
new rule starts with that bet kind. Within a section, rules are indented under
Bet acceptance, Betting activity, and Exposure and loss. These are categories,
not an override hierarchy. The editor names other saved rules of the same type
that also apply, because the stricter limit wins. Rule titles and saved
settings share consistent left alignment. Time windows and customer scope use
readable labels rather than raw enum values or booleans. Always-on integrity
checks are not listed because they cannot be changed.

Each rule shows its saved status: green **ON** (checked on new bets, with its
scope), red **OFF** (no effect on bets) or **Not saved**. Text accompanies
color. There is no separate
enabled checkbox. The buttons state the result:

| Saved status | Without edits | With edits |
| --- | --- | --- |
| Off or new | Turn on | Save and turn on; Save as off |
| On | Turn off | Save changes; Save and turn off |

Enter performs only the primary save and never turns a rule off. When required
history is not ready, turning on is unavailable with the reason shown, and the
rule can still be saved as off. The confirmation names the rule, its value and
whether it is on. A rule saved as off has no effect: for example, a minimum
stake of 5 that was saved off still accepts a 1-Stanbuck bet until it is
turned on.

Every save activates one complete validated revision for subsequent durable
receipts. It is not a draft/publish workflow. Stale revisions conflict instead
of overwriting another visitor's changes. Stable operation identity lets an
uncertain response be reconciled or retried without creating another edit.

**Restore default** creates a revision from the shipped defaults. A custom
rule without a factory counterpart is removed instead. Neither operation
clears usage, exposure, accounting history or a pending bet's pinned policy.
Software upgrades do not silently replace existing active defaults.

**Revision history** lists recent revisions newest first. Expanding a
revision shows what it changed compared with the previous one: rules added or
removed, turned on or off, changed values (`old → new`) and changed scope. The
complete rule set of that revision stays available under a nested disclosure.

## All-events switches

**Betting** closes or opens all betting. Closing it saves an enabled **Block
bets** rule with no scope (`betting:all`), so every new pre-match and live bet
is declined as **Declined: Block bets** at moderation, after its normal delay.
Bets received before closing keep the policy they were received under and
finish normally. Opening it removes that rule. If another unscoped Block bets
rule is on, the switch shows **Closed by a Block bets rule** and that rule must
be changed in the list instead. The switch needs rule editing to be available
in the deployment.

**Accounts** stops or allows **New registrations** and **Customer sign-in**.
Auth owns both settings and enforces them on `POST /api/auth/new` and
`POST /api/auth/login`; Backoffice forwards `GET
/api/backoffice/access-controls` and `PUT
/api/backoffice/access-controls/{registration|login}` with
`{enabled, expectedEnabled}` to Auth's cluster-internal endpoint, and a stale
change returns a conflict. Stopping sign-in:

- refuses new customer sign-ins with "Sign-in is paused";
- also refuses registration, because a new account is signed in straight
  away;
- keeps administrators able to sign in, so release acceptance and recovery
  keep working (the reusable acceptance account must already exist as an
  administrator);
- does not end existing sessions; they expire normally, within 12 hours.

These are separate Auth settings, not policy revisions.

**Cash back** turns cash back off or on for every event. While it is off,
Backoffice refuses new cash-back quotes and reservations; requests already
being processed can finish, and per-event switches still apply when it is on.
The switch is a separate Backoffice setting, not a policy revision. A stale
change returns a conflict and shows the current value.

**Markets** lists built-in 1X2, Correct Score and every registered live market
type alongside **all saved templates**, including clearly marked archived
templates. Same-name templates remain distinct from built-ins. Registered
types are not a promise that every simulation engine or event offers them.
Turning a market off saves an enabled **Block bets** rule, so new bets on it
are declined as **Declined: Block bets** while the market stays visible.
The restriction also covers selections inside Builders and accumulators.
Turning on removes only that market's managed rule; other blocks and event
availability still apply. It never unarchives a template. A changed managed
rule must be reviewed in Rules rather than overwritten by its switch.
Built-ins remain available when the separate template catalogue cannot load.
If a switched-off market's template is later deleted, its rule stays active
and is listed as **Market: Deleted market** until it is removed.

Template switches retain `templateIds`. Built-in switches use a DENY-only,
global `marketTypes` selector: `PRE_MATCH:1X2`, `PRE_MATCH:CS`, or a registered
`LIVE:<type>`. Native product IDs vary by event. Moderation obtains their types
from Event's separate `standardMarkets` catalogue metadata, including Standard
selections inside Builders; it never trusts a submitted name or market type.
Live enforcement uses the trusted mirror's current type inside the contended
admission transaction. Missing required classification is unavailable evidence,
not permission to accept. Events reports reflect these global blocks.
The existing 32-ID, 128-rule and 48-KiB policy bounds remain unchanged.

## Acceptance and recovery

The first durable Moderation receipt binds the immutable placement and active
policy revision. Its due time is fixed from that receipt, not from a
redelivery or process restart. Policy changes affect new receipts, not those
already pending.

At final admission, Moderation rechecks current trusted safety, accounting
and time-window membership. A delay never renews a quote, changes an accepted
price, removes a selection or converts pre-match to live. A bet either
confirms as submitted or is rejected as a whole; row reasons explain the
failure rather than authorizing partial acceptance.

For risk-policy declines, Slip and My Bets name the rule types recorded in
that decision, for example **Declined: Minimum stake**. A decline for the
whole ticket, such as a stake or price rule, is shown once on the slip. A
reason about one selection, such as a changed quote, a closed or suspended
market, or an event that started or resulted, is shown on that row. The rule title is not
inferred from today's policy; changing a limit does not relabel an old bet.
Older records without recognized reason codes retain the generic risk-policy
explanation. Per-selection metadata stays with its affected selection when
declined selections return to a draft; a new submission clears the previous
attempt's explanation.

Receipts, scheduling, reservations, terminal decisions and publication
obligations are durable. Duplicate delivery consumes no new allowance.
Missing evidence can wait within a bounded evidence deadline and then reject;
a database outage can delay durable finalization, but never becomes approval.
Confirmed publication is replayable after broker or process failure.

Policy pinning does not create a distributed freeze of Event or Gamemaster.
Bounded source verification and local mirror revisions define the available
evidence; a remote source read is not atomic with a local MongoDB transaction.

## Accounting and conservative bounds

Monetary admission uses exact bounded arithmetic and Resulting-owned
confirmed settlement/cash-back movements. It does not infer returns from a
row status or trust display calculations. Unsupported historical precision or
incomplete history is unavailable, not zero exposure or permission to round
old wagers silently.

For supported positions with remaining principal `S_i` and return `P_i(s)`
in scenario `s`, informational observed net liability is:

```text
max(0, max_s sum_i(P_i(s) - S_i))
```

An accepted hedge can close independently and make that figure rise.
Admission therefore cannot spend unsafe hedge credit. For a proven exclusive
outcome domain, the closure-safe bound is:

```text
max_s sum_i max(0, P_i(s) - S_i)
```

Otherwise it uses trustworthy standalone maximum net-return bounds.
The current release has no source-attested cross-ticket outcome domain, so
it enforces the standalone path; exact cross-ticket netting is unavailable,
not a smaller spendable balance.
Accumulators and Builders remain complete tickets/composite exposures;
matching labels or event IDs are not proof of correlation. Pending bets
reserve standalone exposure and never supply hedge credits. Overlapping
scopes each contain the complete applicable ticket, but their totals are not
added together as a global book.

For each customer-loss window:

```text
realised = sum(confirmed closed principal - confirmed returns)
budget use = max(0, realised + outstanding principal + pending principal)
```

Realised loss stays signed, so confirmed wins offset losses within that
window. Immutable economic time determines membership, not broker arrival.
Expired win credits stop funding new admission even when no new message
arrives. Open and pending principal carries across window boundaries.

Settlement and cash-back do **not** ask Moderation for permission. Resulting
records its monetary movement with its canonical state transition and
publishes asynchronously. Until complete evidence arrives, Moderation keeps
conservative coverage. Duplicate or reordered delivery cannot credit a return
twice; partial cash-back releases only its confirmed portion.

Financial limits require complete relevant open-position/history evidence.
Reconciliation uses source-owned replay/export and durable deduplication, not
live reads of another service's database. Resetting policy cannot manufacture
readiness. Concurrent admissions contend on persisted scope state inside
transactions; one process or an in-memory mutex is not the concurrency proof.

Readiness is specific to the control. Complete open-position evidence can
permit an exposure ceiling even when older customer-loss windows are
unavailable. The server reports eligible loss windows; the editor does not
infer them from the browser clock. Every Save and admission rechecks the
applicable requirements.

Activity controls have separate readiness. Submission and turnover windows
must lie entirely within uninterrupted durable Moderation intake coverage;
a repeat cooldown cannot exceed that covered duration. Importing a Resulting
position never invents a submission time or turnover receipt. Feature-off
admission invalidates continuity, and restoring defaults does not repair it.
The editor uses server-reported eligible windows and cooldown duration rather
than calculating completeness from the browser clock.

The private Resulting snapshot transport separates immutable position facts
from monetary movements. Bounded, ordered pages form a hash chain, and the
final source handoff binds the complete manifest and held maintenance
generation. Its original-principal maximum-return bound stays conservative
after partial closure; scaling a rounded bound down with floor arithmetic
would be unsafe. Unknown history certifies no past loss window and never
creates a credit at import time.

Capture and final handoff require the existing physical writer fence, a valid
shared-Mongo lease, fully drained source queues and an unchanged canonical
source digest. Moderation must additionally reconcile its own receipts and
live overlap before committing readiness. Export alone does not enable a rule,
and the old overlap-only movement export is not a complete-book certificate.

Reconciliation currently supports at most 10,000 merged positions and 10,000
movements, with 16 MiB snapshot and pending-inbox budgets. Admission bounds
its applicable book/window scan at 10,000 entries. Exceeding these technical
budgets reports unavailable evidence; it never truncates usage into apparent
spare capacity or limits the number of cash-back operations on a ticket.
Large inline histories spill to Resulting's durable movement history and
remain recoverable through the paged snapshot.

## Visit telemetry

The editor and Market Templates have independent page-entry counters:

- `RISK_CENTRE_PAGE_VISIT` for `/backoffice/risk-centre`;
- `MARKET_TEMPLATE_PAGE_VISIT` for `/backoffice/markets`.

Direct entry and leaving/returning count. Rerenders, theme/query changes,
case/trailing-slash aliases, event-specific editors and previews do not add
Template visits. Existing broad Backoffice visits remain independent, so
these counts overlap and are not additive unique visitors.

Page reports use allowlisted keys with no visitor identity. The default
Telemetry summary retains its eight-metric contract; `?metricsVersion=2`
adds the two new counters. A verified older response can be labelled
compatible, with unavailable new metrics rather than fabricated zeroes.
Malformed responses and genuine service failures remain errors.

## Rollout and rollback

Choice blocking extends policy scopes with `selectionIds`; it does not change
persisted accounting facts, placement fingerprints or settlement contracts.
Older Moderation readers reject this scope, even on a disabled active rule.
Deploy the capable reader before emitting choice rules. The client requires
the server's `selectionBlocking` capability and ready transaction storage.
The canonical deployment and production k3s overlay retain one Moderation
replica with `Recreate`; preserve that no-mixed-reader assumption, or design
an explicit compatibility cutover before changing rollout strategy or scale.
Event and Backoffice report routes must also be available for the Events view.

Built-in switches similarly add `marketTypes`, without changing shared quotes,
accounting facts or either placement fingerprint. Deploy capable Event metadata
and Moderation readers before exposing these switches. The canonical ingress
write fence and single-reader rollout enforce reader-before-writer ordering;
do not remove them. The client uses the server's built-in catalogue and does not
invent switches when that metadata is absent. An older editor cannot strip
`marketTypes` from a managed rule and turn its restriction into an all-bets deny.

Before reverting to a pre-choice Moderation binary, remove **all** active
choice-scoped rules, including disabled ones, and resolve receipts pinned to
enabled choice rules under the capable reader. A feature-off flag does not
make those receipts compatible. Keep the capable reader or forward-fix when
that drain cannot be proven; never drop receipts, rewrite pinned policies or
edit stored accounting facts as a rollback shortcut.

Before downgrading to a pre-built-in-switch reader, remove **all** active
`marketTypes` rules, including disabled ones, and drain receipts pinned to
enabled native rules under the capable reader. Keep that reader or forward-fix
if the drain cannot be proven. Never rewrite policies or pending receipts.

Compatible shared contracts/readers and authoritative accounting come before
transaction-dependent writers and financial-rule activation. Establish
replica-set transaction support and history readiness before enabling the
gateway. A disabled deployment switch is not permission to lose previously
pinned receipts, accounting or publication obligations.

On an existing standalone database, first deploy the compatible reader and
accounting generation with the risk gateway disabled, using the protected
Mongo conversion. Only after transaction support is proven may a separately
authorized, fenced source snapshot and receiver import establish readiness.
Do not put transactional import into a pre-deployment data stage that still
uses the old standalone topology. Writer fencing stays held through the
source handoff and receiver's atomic completion; an exported file alone is
not permission to resume or activate.

After activation, rollback must retain compatible readers and recovery, or
use an evidence-backed drain/forward fix. Never discard pending work, reset
accounting, or revert to an accepting binary that ignores reservations.
Production data and deployment changes remain separately authorized,
exact-source operations.
