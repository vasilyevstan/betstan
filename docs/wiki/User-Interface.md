# User Interface

BetStan's React client presents every route in one Match Desk visual system
with three density layouts and two color themes. Layout and theme changes alter
presentation, not betting identity, service authority, route behavior, or
accessibility expectations.

See [[Application Processes]] for the workflows behind the screens and
[[UI UX Consistency]] for the complete review and acceptance contract.

## Application shell

The routed center task is first in DOM, reading, and keyboard order. A visible
**Skip to main content** link moves focus to that stable main region. At
viewport widths of 1400 CSS pixels and above, the shell presents three
regions:

| Region | Purpose |
| --- | --- |
| Left sidebar | Statistics and leaderboard |
| Center stage | Events, authentication, My Bets, Backoffice, or Telemetry route |
| Right sidebar | Independent live and pre-match slips |

Only the Statistics and slips regions are sticky in this three-region desk.
At 1399 pixels and below, the center task occupies the first full row and both
supporting regions follow it without sticky positioning. The supporting
regions may share the next row when space permits and stack at narrower
widths. The semantic order remains center task, Statistics, then slips even
when the wide layout places Statistics visually to the left.

The public Telemetry route is intentionally full width. It does not mount the
leaderboard or slip sidebars, so those supporting surfaces do not issue hidden
requests or add keyboard stops while the operational dashboard is open.

Primary routes are:

| Route | Screen |
| --- | --- |
| `/` | Upcoming, countdown, live, and recently finished events |
| `/bets` | User betting history and settlement state |
| `/backoffice` | Public event simulation controls |
| `/telemetry` | Fourteen-day activity graphs and current service health |
| `/signup` | Account creation |
| `/login` | Login |
| `/logout` | Session logout |

The header keeps visibly labelled **Events**, **Backoffice**, **Telemetry**,
authentication, **Layout**, and **Theme** choices discoverable. Signed-in
users also receive **My bets**. Backoffice and Telemetry remain visibly
labelled and usable for anonymous visitors as well as signed-in users. Header
navigation and presentation choices preserve the current query parameters. The
browser tab uses a dedicated 48 x 48 square SVG emblem derived from the
existing header wordmark, while install and touch icons remain unchanged.

My Bets opens with **All statuses**, **All types**, **All dates**, and
**Newest first**. The compact toolbar keeps **Search bets**, the matching count,
**Refresh bets**, and **Filters** discoverable. Status, bet type, date, and sort
controls sit inside the Filters disclosure; the active filter context remains
visible when it is closed. Search includes selections inside collapsed cards.
The list initially shows 20 matching cards; **Load more** reveals another 20.
Older records without an explicit kind retain the compatible pre-match
interpretation.

Each compact card identifies the first event and selection, placement time,
bet type, status, selection count, original wager, and remaining or historical
stake. Accumulators indicate how many additional selections they contain.
The first named event's start time must also stay visible inline as **Event
time** for a single or **Shown event time** for an accumulator, separate from
placement time and not a computed earliest kickoff or a time for all selections.
**Bet details** reveals every selection's event/time, market, pick, accepted
odds, and outcome, plus accepted total odds and relevant financial context.
The **Bet details** control shares a naturally wrapping row with position
metadata where space permits; opened details stay inline and readable without
replacing the recognizable card summary.

## Cash back in My Bets - deployment-gated

Availability depends on a verified, enabled deployed generation; see
[[Release Orchestration]]. Cash-back stays inline in the existing My Bets card,
not in a separate wallet screen or modal. The same controls serve singles and
accumulators across the three variants and both themes.

### Review and explicit confirmation

Use the inline **Full remainder** or **Partial stake** controls, type the
partial amount when applicable, then choose **Get cash-back offer**.
A partial uses whole-cent nominal Stanbucks input and must leave at least
`0.01`. Zero, negative, over-precise, or excessive amounts produce visible
errors; the client neither rounds/clamps the input nor switches it to full.
A confirmed label alone does not guarantee availability: the server checks
every original selection and its cutoff.

The offer emphasizes three values: **Stake to close**, **Quoted nominal
return**, and **Remaining stake after cash back**. The **Original selections,
wager and odds** disclosure contains the original selections, accepted odds,
original wager, accepted total odds, and possible return on the remainder.
The browser does not price the cash-back itself. **Confirm full cash back** or
**Confirm partial cash back** is a separate action on the displayed offer.
Editing the amount, an authoritative revision change, or expiry makes that
offer unconfirmable; **Get new offer** creates a new identity and requires
review again. The entered amount is preserved, not silently substituted.

The countdown is informational and never restarts on a poll or render.
An unsubmitted expired offer becomes a short expiry message and **Get new
offer** action. Its old values are hidden by default inside **Expired offer
details**, with no confirmation action; opening the details does not renew it.
**Getting an offer**, unavailable reasons, and **Confirmation pending** remain
distinct from success. `202` never produces an optimistic success message.
Once confirmation is pending or uncertain, the card prevents another closure
and offers **Check confirmation status**, even after the displayed expiry.
Only the durable receipt produces **Cash back recorded. See the receipt in
cash-back history.** as quiet inline feedback; pending and failure messages
retain their distinct treatment. A rejection or unsupported legacy precision
is shown explicitly; neither is a network-error fallback.

### Exposure and permanent history

Full closure displays **CASH BACK**, has its own status filter, and shows zero
remaining and active exposure. Rows in Bet details say **Exposure closed by
cash back**, not pending result or an invented win/loss. Later refreshes cannot
replace the closed rows or winner metadata.

A partial stays under `CONFIRMED` with **PARTIAL CASH BACK** until further
closure or normal settlement. The summary retains original wager and remaining
stake; Bet details retains accepted odds, possible remainder return, cumulative
closed principal, and cumulative recorded nominal return. After normal
settlement,
**Remainder stake that settled** is historical principal, while
**Active exposure** is zero. The partial badge and receipts remain available.
All copy describes nominal Stanbucks, not money paid, wallet credit, or balance.

**Cash-back history** remains discoverable on fully closed and normally
settled cards, not only while a new offer is available. Opening it reads a
bounded page of up to 20 immutable accepted receipts, newest first; **Load
earlier receipts** follows the opaque cursor. One disclosure groups subdued,
wrapping newest-first, loaded-count, and earlier/end metadata without a
duplicate body title or explanatory paragraph. Loading, empty, failure, and
**Retry history page** states are explicit. Retained receipts and counts are
not pagination authority: earlier/end metadata waits for a successful page,
remaining hidden during unresolved opening/refresh or after a page error.
Newer receipts can refresh the open first page without rewinding exposure or
automatically opening or closing history. A loaded page or **End of
available history** is not a new completeness attestation.

### Pending recovery, ownership, and layout

The browser saves owner-scoped request identity/content and explicit
confirmation before sending HTTP. Browser storage is therefore required for
lost-response recovery across reloads and tabs. It is not a cache of
authoritative quotes, receipts, or credentials. If storage cannot preserve
retry data, the UI reports the problem rather than starting an untracked
operation; the server's durable outcome remains authoritative.

A lost initial response retries the identical request. An uncertain
confirmation retains the same consent and identity until the server resolves
it, including when the saved confirmation must be resent after browser
expiry. Focus and same-owner tab updates trigger reconciliation, not automatic
consent to another tab's quote. Permission failure clears the rendered account
state and stops stale work; returning to the same account can recover its
pending requests. Another account never adopts them.

**Cash-back recovery outside this view** keeps existing offer requests and
confirmations reachable when a bet is filtered out or lies beyond the visible
cards, including the initial 20. **Retry same offer request** reconciles a lost
initial response or `QUOTE_PENDING` with the same request identity, even after
the bet settles; **Check confirmation status** retains the submitted consent.
These are recovery actions, not new admission on terminal bets. Completing
request recovery uses the existing feedback without changing the filters.
Expiry never turns submitted consent into a fresh offer; recovery stays
separate from any paused local draft.

Refresh and status/history failures remain visible while previously loaded
cards and input are retained where appropriate. Filters, sorting, Bet details,
and sibling forms are preserved. Per-account, per-bet mode and typed-amount
drafts survive filtering, reordering, refresh, and detail toggles while My Bets
is mounted; switching accounts clears those local drafts. If an update removes
the focused control, including when recovery completes, focus moves to
completion feedback instead of disappearing; the filters remain unchanged.
If expiry hides or removes the focused confirmation, summary, or mode control,
focus moves to the separate new-offer action or status feedback without
automatically requesting or confirming an offer.

Native labelled controls have visible focus and at least 44-by-44 CSS-pixel
targets. Cash-back mode, amount, request/retry, and closed disclosure controls
share available width without a reserved history column. Groups wrap when
needed; opened history and expired-offer details use the full width inline.
The compact ordered receipt list groups full/partial type with the full
decision date/time, alongside aligned **Closed principal** and **Recorded
nominal return** columns that reflow without truncating values or Stanbucks
units. Concise help retains nominal precision, minimum partial remainder,
server-checked availability, explicit confirmation, and server acceptance.
Offer values reflow, and narrow selection rows retain their labels. Status
text, pressed states, and error messages do not rely on color alone.
This presentation change leaves APIs and stored receipts unchanged; reverting
the layout does not reverse accepted cash-back decisions. See
[[Application Processes]] for eligibility/pricing and [[Architecture]] for
server authority and availability limits.

## UI variants

The existing `ui` query parameter selects a user-facing density layout:

- `?ui=v1` - **Standard**, the default spacing and composition;
- `?ui=v2` - **Compact**, with tighter gaps, padding, and corners;
- `?ui=v3` - **Spacious**, with more breathing room and larger corners.

Unsupported or missing values fall back to `v1`. All variants use the same
React routes, event/slip data, semantic controls, selected-state keys, and
click payloads. They also share one brand, palette, surface hierarchy, and
state grammar: the variants change density and composition, not product
identity.

## Dark and light themes

The `theme` query parameter accepts `dark` or `light`; dark is the default.
The Client applies the choice to the document through Bootstrap's
`data-bs-theme` attribute and to the application shell.

Both themes use the same semantic roles for base, soft, and elevated surfaces;
keylines; primary and secondary text; pitch-teal accent; focus; and positive,
warning, danger, and informational states. Light mode changes role values
rather than creating a second markup tree or a separate variant identity.

Header artwork uses the corresponding light or dark wordmark. Theme changes
preserve the active route and selected layout.

## Match Desk visual grammar

Routes share opaque ink/slate surfaces, restrained pitch-teal emphasis, and
semantic keylines or state rails. Live, pre-match, warning, failure, success,
and informational states retain text or another non-color cue alongside their
color role. Changing numeric readouts use tabular numerals where alignment
matters. Data cards remain grounded in the desk: they do not use glass effects,
violet variant brands, or hover lift as alternate route identities.

Primary route and task level-one headings use one self-hosted Barlow Condensed
700 Latin face. Body text, controls, dense identities, lower-level headings,
and tabular data retain the system font stack. The bundled face is distributed
under the SIL Open Font License 1.1 and requires no third-party font request.

Where a current or selected state has a check cue, one CSS-drawn mark uses the
control's current text color and is hidden from assistive technology. Labels,
`aria-current` or `aria-pressed`, visible focus, fixed geometry, and non-color
state treatment remain independent of that decoration. These shared refinements
preserve all three densities, both themes, responsive behavior, and the
existing semantic rails.

## Preserving presentation choices

Header links rebuild their query strings from the current location. Moving
between Events, My Bets, Backoffice, Telemetry, login, signup, and logout
therefore preserves valid `ui` and `theme` values. The layout and theme choices
update one value without discarding the other or unrelated accepted query
state. Successful logout returns to Events with that query intact; its safe
failure navigation does the same.

Examples:

```text
/?ui=v1&theme=dark
/bets?ui=v2&theme=light
/backoffice?ui=v3&theme=dark
/telemetry?ui=v1&theme=light
```

The URL makes a visual state reproducible for testing and review without
creating separate deployments.

## Compatibility, rollout, and rollback

The Match Desk redesign is a client presentation change. Existing routes,
`ui=v1|v2|v3` links, themes, selection identities, APIs, authorization,
schemas, and stored data remain compatible. The heading face and state mark
ship in the client artifact. They follow the normal client integration and
rollout path and require no data migration or coordinated backend activation.
Rolling the client presentation back restores the earlier layout, typography,
copy, and state-cue rendering; it does not reverse a logout, placed selection,
Backoffice mutation, or other action already accepted by its owning service.
This describes repository behavior, not a claim that the redesign is already
deployed.

## Telemetry dashboard

The public `/telemetry` page is headed **Telemetry and service health**. It
groups its eight graphs under **Activity**. The overview shows the current UTC
day and previous 13 UTC days for main-page visits, Backoffice-page visits,
slips created, bets placed, results settled, Gamecenter events emitted,
users created, and user logins.

In overview mode, each card contains a dependency-free graph and all fourteen
exact date/value pairs. All eight cards use an immediate, theme-matched,
two-line tooltip: **UTC date or time first, exact count second**. Daily
tooltips show `YYYY-MM-DD UTC`, identifying the accepted UTC calendar day,
including today's in-progress day, not a claim that the day is complete.
Hourly tooltips show `HH:mm UTC`, the accepted hour bucket's UTC start.
Both labels identify UTC aggregation buckets, not individual event times,
the current clock, snapshot-generation time, or local time. Counts are never
rounded or abbreviated. Calendar dates are absent from hourly tooltips' text,
accessible names, descriptions, and titles. Machine-readable metadata retains
the actual daily date or hourly UTC instant and exact count. The selected-day
heading supplies hourly date context outside the tooltip; daily date/value
lists, button names, and snapshot timestamps also retain their dates.
Hovering a bar or focusing a native daily date/value button shows the same
bucket-and-count content. Daily buttons remain usable by keyboard and touch;
**Escape** dismisses the tooltip, and exact values remain readable without
hover.

This label-only client correction is compatible with existing API responses
and stored observations. It follows the existing client rollout and rollback
path described above.

Clicking a daily bar or activating its date/value button changes only that
card to the selected day's **24 hourly UTC counts**, from **00:00** through
**23:00**. Other cards keep their current views. All hour/count pairs remain
reachable; hourly bars are read-only, with no further drill-down, minute view,
or local-time conversion. **Back to 14 days** appears at the top right only
in detail mode, including loading and error states. It restores the accepted
overview without fetching it again. Keyboard activation moves focus to Back;
returning restores the date button, or the card heading if that date has
left the overview.

The overview loads on page entry; hourly data loads on selection or explicit
**Retry**. The page does not poll. **Refresh** updates the overview, service
health, and every detail selected when pressed, including loading or expired
selections. Selected days and any last successful data are retained while
requests run. Successful updates survive failures elsewhere, and partial
failure is reported rather than announced as a complete refresh.

A temporary detail failure offers **Retry** and **Back to 14 days**, retaining
that detail's last successful data and timestamp when available. Retained
values and their timestamp are explicitly marked stale during failures. A day
that has left the server's current 14-day window stays selected with an
unavailable-day notice and any last successful detail; it offers Back but
no futile Retry. This also covers opening an expired day from an older
overview. Failures never become fabricated zero counts or expose internal
error details. Unmatched Telemetry API requests return a generic JSON `404`
error without echoing the requested URL. A successful all-zero response
remains a valid snapshot.

**Overview and service health generated at** identifies the overview's
timestamp, also used for daily-card freshness. **Hourly data generated at**
identifies each detail's own accepted snapshot. Initial hourly loading or
error states have no accepted hourly timestamp or values: they do not borrow
overview freshness or fabricate zero counts. Today's detail is labelled
**In progress** using response-date context, not a live clock or polling
promise. Counts cover the full selected UTC calendar day using stored
observation times; a generated timestamp marks computation start, not a cutoff
or transactional snapshot.
Late observations can change historical counts, so separately fetched hourly
totals and daily values need not match, and refresh need not produce a newer
timestamp. These are observed operational counts, not accounting-grade
records. The 14-day display window and records' eligibility for TTL deletion
after 30 days are unchanged.

The service-health section lists Authentication, Backoffice, Betting, Client,
Events, Game master, Moderation, Resulting, Slip, and Telemetry in a fixed
order. Health is expressed with both text and color: **Healthy**, **Degraded**,
or **Unavailable**. It remains a coarse point-in-time snapshot, not deep
readiness or an authority for product decisions.

Hourly detail is additive; older clients keep the unchanged daily dashboard.
A rollout should make backend support available before the new client. An
older backend's missing hourly route (`404`) produces a local detail error
without losing the overview. Rolling back the client removes drill-down
without changing stored observations or requiring a data migration; a backend
rollback must account for clients still requesting hourly data.

Activity graphs use two columns on wide desktop layouts and one column on
tablet and mobile layouts. Service health uses five, two, then one column over
the same ranges. At a given card width and text setting, daily and selected
hourly views keep a stable card and plot footprint, including loading, error,
retained-data, and expiry states. Hourly values retain all 24 exact UTC
hour/count pairs, including zeros and complete counts, in chronological order.
They form equal-width columns across responsive rows; the column count adapts
to available width and readability rather than forming a one-to-one axis for
the SVG bars. Hourly cells remain read-only; daily entries remain native buttons
with targets at least 44 by 44 CSS pixels, as do Back and Retry.

A contained, keyboard-scrollable values/status area accommodates overflow
when needed, including on desktop. Every exact value, complete freshness
timestamp, notice, and Retry control remains reachable, but all content need
not be visible simultaneously. Dates, values, labels, and statuses wrap without
horizontal page or card scrolling.

## Event-page hierarchy

The center stage presents match states in betting priority:

1. next-live context when no event is active or counting down;
2. all server-authoritative active-live events;
3. all kickoff-soon countdown events;
4. the recently completed live match;
5. upcoming pre-match events.

The Events surface, including loading, empty, and wildcard-route states, has
one **Events** level-one heading and no decorative eyebrow or kicker.
Match-state sections use level two, event identity uses level three, and market
or event subsections continue the hierarchy without turning kickoff metadata
into headings.

Active-live and countdown cards share one **Live now** section. Active-live
cards form the first group and countdown cards the second. Within each group,
cards sort by the kickoff displayed by the card: `live.kickoffAt` when present,
otherwise `event.time`. Valid kickoff values precede unavailable values, and
`eventId` breaks equal or unavailable-time ties deterministically.

One ordered array drives DOM, reading, keyboard, and visual order in every UI
variant. The **Recently finished** and **Pre-match** sections are unchanged.
This is a client-only presentation rule with no data migration or
service-contract impact; rollback restores the prior ordering without changing
event or wager identity.

A single prominent live/countdown card uses the available stage width. At
desktop widths its identity, products, live markets, score, progress, and
timeline regions use parallel columns where that reduces unnecessary vertical
growth. The DOM remains one event article in logical reading order.

Pre-match events form a responsive three-, two-, then one-card grid. Card
headers and product decks use flexible layout so long team names do not push
1X2 or Correct Score controls out of alignment with sibling cards.

The kickoff timer uses a stable, horizontally balanced shape and tabular
digits. During the final minute its numeric value changes to the semantic
danger color, while its accessible timer label continues to expose the exact
remaining time.

## Betting controls

### Pre-match products

- 1X2 uses compact visible labels `1`, `X`, and `2`.
- Full team/outcome identity remains in accessible names and the underlying
  selection data.
- Correct Score retains stable numeric scoreline order.
- Both product headings share the same centered treatment.
- Odds IDs and selection IDs remain unchanged by presentation.
- A selected option exposes pressed semantics and a visible checkmark as well
  as its semantic keyline; selection never depends on color alone.
- A failed add-to-slip request produces fixed, sanitized feedback beside the
  affected product. The message is
  **Selection could not be added to your slip. Please try again.** Technical
  exception details are not displayed.

### Live markets

Each market card exposes the name, status, quote metadata, selections, and
prices. The live area renders at most six non-terminal products from the
authoritative deterministic rotation. Open, suspended, stale, and unavailable
states remain visible rather than disappearing without explanation; settled
and closed versions leave the actionable grid but remain in the server
snapshot for audit and settlement replay. Sparse market groups use only
occupied grid tracks, and cards sharing a row stretch to consistent bounds.

Next-event cards use concise football labels, including **Next Corner Kick**,
**Next Free Kick**, **Next Throw-In**, and **Next Goal Kick**. The ten-option
**Second Half Score** market uses readable score labels instead of the shared
internal neutral-side value. Like every live product, its card occupies one
normal product-grid slot at desktop, tablet, and mobile widths; its ten
selections use a balanced two-column grid inside that card.

### Betting slips

Live and pre-match drafts can both be open. They use separate labelled slips,
the same `var(--surface-soft)` background, independent wagers, and independent
pending/error state. Semantic rails and borders distinguish them: warm for
live and accent for pre-match. The UI never merges them into one combined
placement.

## Live movement and timeline presentation

Live updates arrive over SSE and update the score, clock, phase, incidents, and
market quotes in place. Layout must remain stable enough that a countdown tick
or price change does not move a control unexpectedly under a pointer or
keyboard focus.

The active card shows recent incidents. A completed card shows chronological
key moments and a native collapsed disclosure for the full available
timeline. New verified histories are labelled **Full timeline**; legacy or
unverified histories are labelled **Available timeline** so the UI does not
claim completeness it cannot prove.

## State design

Every data-driven surface should represent its real state:

| State | Expected treatment |
| --- | --- |
| Loading | Stable placeholder or explicit progress without false empty copy |
| Empty | Explain that no items currently exist |
| Error | Visible, actionable failure feedback |
| Pending | Prevent duplicate submission and show in-progress operation |
| Disabled | Explain unavailable action or market state |
| Stale | Identify that a quote or view must be refreshed |
| Success | Confirm the accepted action without hiding the resulting state |

Backoffice controls, slip placement, authentication, live markets, event
catalogs, and betting history follow the same principle.

Shared request handling preserves structured server validation messages. When
a request fails without a structured public message, forms show the generic
message **Request failed. Please try again.** rather than a network, host, or
exception detail.

Logout has distinct pending, completed, and failure states. A failure warns
that the session may still be active and offers **Retry log out** plus
**Return to Events**; neither path claims success before the server accepts the
request.

## Backoffice event controls

The `/backoffice` center panel uses full-width event cards within the shared
Match Desk shell. Anonymous, ordinary, legacy roleless, and administrator
visitors retain the same catalog and controls in all three layouts and both
themes.

**Create new event** stays expanded and states the server-defined 15-minute
kickoff lead time. Each displayed card gives event identity the full card
width, then presents adjacent **Final result** and **Visibility** task groups
when space permits; the groups stack without changing their semantic order in
a narrow card. The equal-column geometry remains: **Home score** and **Away
score** are equal peers, the two wide task groups have equal width, and their
full-width actions align as peer controls. **Save final result** requires both
scores as whole numbers from `0` to `99`. Recorded scores remain visible but
disabled, as does result submission: final results cannot be changed once
recorded.

**Final result: Not recorded / Recorded** and **Visibility: Online / Offline**
are independent, human-readable states, not inferred live-match phases.
Unknown or missing values receive **Unknown** or **Unavailable** labels.
Visibility remains actionable after a result is recorded; **Take offline**
and **Make online** name the explicit target rather than an ambiguous toggle.

**Search events** matches trimmed, case-insensitive substrings of event or
team names, not IDs. Separate **Final result** and **Visibility** filters
default to **All**, retaining the complete catalog in its existing API order.
Active search and filters combine without reordering matches. **Showing N of
M events** appears only after a successful load; loading, load failure, an
empty catalog, and no matching events have distinct feedback. **Clear
filters** stays visible and resets only search and the two filters.

Local search, filtering, and clearing send no requests and preserve creation
inputs, score drafts (including hidden events), and action feedback. Filters
survive normal refreshes while the page is mounted, but accepted actions still
trigger the existing catalog GET, which reseeds score inputs and can reset
other unsaved score drafts. Draft preservation does not extend across server
refreshes.

One shared busy state disables all mutation controls while an action is
pending; local discovery remains available. Complete errors and action
messages stay in a global feedback area outside the filtered list. A `202`
publication-retrying warning remains distinct from downstream completion.
If an action refresh removes the focused card, focus moves to the Events
heading only when it was lost and the user has not moved elsewhere; local
filtering does not trigger that fallback.

The task-deck composition changes no mutation behavior. Search, filtering,
draft retention, one shared mutation-busy state, result locking, explicit
visibility targets, refresh behavior, and feedback remain as described above.

## Design principles

### Identity before decoration

Density layouts may change spacing, corner size, and composition. They do not
introduce a separate brand or semantic palette and must not change route
access, selection identity, event identity, accessible names, or the meaning
of a status.

### Information hierarchy follows the user task

Live score and availability precede secondary metadata. Selection outcome and
price are the strongest elements inside a betting control. Status and failure
copy remain adjacent to the affected surface.

### Consistency is measured across components

Equal button heights inside one card are not enough. Reviews compare sibling
event headings, product baselines, odds baselines, market-card bounds, live
card footprint, and navigation treatment across realistic content lengths.

### Stable order protects interaction

Controls should not reorder because their price changed. Domain order is used
where one exists, and presentation transforms always preserve the complete
ID/name/value tuple.

### Responsive behavior is content-safe

Layouts progressively move from parallel regions to stacking. They do not
hide markets, clip team names, break status words, or introduce nested
scrolling to meet a visual target.

### Accessibility is part of the component contract

- Native links, buttons, forms, headings, labels, and disclosure controls are
  preferred.
- Keyboard order follows DOM order.
- Visible compact labels keep full context in accessible names.
- Controls retain practical touch targets and visible focus behavior.
- Color is not the only indicator of live/pre-match, success, warning, or
  error state.
- Light and dark themes must both retain readable contrast.
- Reduced-motion preference removes effective transitions, animations, and
  smooth scrolling while preserving focus outlines and state cues.

### Public access and navigation must agree

If a route is public, navigation cannot hide it behind a role gate or
icon-only treatment that conceals its purpose. If a capability is restricted,
the UI and API must express the same boundary.

### Rendered evidence validates geometry

Unit tests validate state and semantics. Browser tests validate breakpoints,
overflow, touch targets, cross-card alignment, live-layout movement, themes,
variants, and visible navigation using computed geometry. Screenshots support
human review but do not replace assertions.

## Related pages

- [[Product Overview]]
- [[Application Processes]]
- [[Live Betting Production]]
- [[UI UX Consistency]]
- [[Quality Gates]]
