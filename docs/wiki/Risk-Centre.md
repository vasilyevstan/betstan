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
capability or incomplete accounting is shown explicitly. The switch is not
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
| Integrity | Visible but locked identity, quote, market, mixed-kind and settlement-capability safeguards |

Every matching restriction applies: the lowest ceiling, highest floor and
longest delay win. A narrower rule cannot relax a global rule. Conflicting or
unsupported policy values fail validation rather than being ignored.

New optional restrictions start disabled or unbounded, and acceptance delay
starts at zero. Existing hard safeguards cannot be disabled or widened beyond
their supported capabilities. An absent optional override uses its explicit,
versioned shipped default; a corrupt policy or missing required authority
never substitutes permissive defaults.

Wallet/balance/deposit/withdrawal controls, KYC/AML, external self-exclusion,
licensing/geolocation, device fraud and unsupported bet products are
unavailable. They are not simulated successful checks or claims of regulated
customer protection.

## Saving and restoring

**Save** activates one complete validated revision for subsequent durable
receipts. It is not a draft/publish workflow. Stale revisions conflict instead
of overwriting another visitor's changes. Stable operation identity lets an
uncertain response be reconciled or retried without creating another edit.

**Restore default** creates a revision from the shipped defaults. A custom
rule without a factory counterpart is removed instead. Neither operation
clears usage, exposure, accounting history or a pending bet's pinned policy.
Software upgrades do not silently replace existing active defaults.

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
