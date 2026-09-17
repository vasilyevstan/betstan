# User Interface

BetStan's React client provides one product across three visual variants and
two color themes. Variant and theme changes alter presentation, not betting
identity, service authority, route behavior, or accessibility expectations.

See [[Application Processes]] for the workflows behind the screens and
[[UI UX Consistency]] for the complete review and acceptance contract.

## Application shell

At wide desktop sizes the shell has three regions:

| Region | Purpose |
| --- | --- |
| Left sidebar | Statistics and leaderboard |
| Center stage | Events, authentication, My Bets, Backoffice, or Telemetry route |
| Right sidebar | Independent live and pre-match slips |

The sidebars are sticky when space permits. On smaller screens the center
content appears first and the supporting panels stack below it. This preserves
the primary task while keeping statistics and both slips available without
creating separate mobile-only behavior.

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

The header keeps **Events**, **My Bets**, **Backoffice**, **Telemetry**,
authentication, UI variant, and theme controls discoverable. Backoffice and
Telemetry remain visibly labelled and usable for anonymous visitors as well as
signed-in users.

My Bets provides independent status and bet-type filters. **All types**,
**Pre-match**, and **Live** can be combined with status, date, text search, and
sort order; older records without an explicit kind retain the compatible
pre-match interpretation.

## UI variants

The `ui` query parameter selects a supported variant:

- `?ui=v1` - the default, glass-like card treatment with rounded surfaces and
  teal emphasis;
- `?ui=v2` - a denser, compact operational treatment with tighter corners,
  bordered market rows, and labelled picture navigation;
- `?ui=v3` - an editorial treatment with a centered event stage, timeline
  accent, larger radii, and violet emphasis.

Unsupported or missing values fall back to `v1`. All variants use the same
React routes, event/slip data, semantic controls, selected-state keys, and
click payloads. A visual experiment therefore cannot reinterpret a wager.

## Dark and light themes

The `theme` query parameter accepts `dark` or `light`; dark is the default.
The Client applies the choice to the document through Bootstrap's
`data-bs-theme` attribute and to the application shell.

The CSS layer uses semantic design tokens for base, soft and elevated
surfaces; borders; primary and secondary text; accent; positive, warning, and
danger states; radii; and elevation. Light mode overrides those tokens rather
than maintaining a second markup tree. Variant-specific light overrides then
retain each variant's identity and contrast.

Header artwork is theme-aware, including separate light/dark wordmarks where
needed. Theme changes preserve the active route and the selected UI variant.

## Preserving presentation choices

Header links rebuild their query strings from the current location. Moving
between Events, My Bets, Backoffice, Telemetry, login, and signup therefore
preserves valid `ui` and `theme` values. The switchers update one choice without
discarding the other or unrelated accepted query state.

Examples:

```text
/?ui=v1&theme=dark
/bets?ui=v2&theme=light
/backoffice?ui=v3&theme=dark
/telemetry?ui=v1&theme=light
```

The URL makes a visual state reproducible for testing and review without
creating separate deployments.

## Telemetry dashboard

The public `/telemetry` page is headed **Telemetry and service health**. It
groups its eight graphs under **Activity**. The overview shows the current UTC
day and previous 13 UTC days for main-page visits, Backoffice-page visits,
slips created, bets placed, results settled, Gamecenter events emitted,
users created, and user logins.

In overview mode, each card contains a dependency-free graph and all fourteen
exact date/value pairs. Hovering a daily or hourly bar shows an immediate,
theme-matched tooltip containing only the exact count, without rounding or
abbreviation. Daily date/value entries are native buttons usable by keyboard
and touch; focusing one also shows its count tooltip. **Escape** dismisses the
tooltip, and exact values remain readable without hover.

Clicking a daily bar or activating its date/value button changes only that
card to the selected day's **24 hourly UTC counts**, from **00:00** through
**23:00**. Other cards keep their current views. All hour/count pairs remain
visible; hourly bars are read-only, with no further drill-down, minute view,
or local-time conversion. **Back to 14 days** appears at the top right only
in detail mode, including loading and error states. It restores the accepted
overview without fetching it again. Keyboard activation moves focus to Back;
returning restores the date button, or the card heading if that date has
left the overview.

The overview loads on page entry; hourly data loads on selection or explicit
**Retry**. The page does not poll. **Refresh** updates the overview, service
health, and every detail selected when pressed, including loading or expired
selections. Selected days and any last successful data remain visible while
requests run. Successful updates survive failures elsewhere, and partial
failure is reported rather than announced as a complete refresh.

A temporary detail failure offers **Retry** and **Back to 14 days**, retaining
that detail's last successful data and timestamp when available. A day that
has left the server's current 14-day window stays selected with an
unavailable-day notice and any last successful detail; it offers Back but
no futile Retry. This also covers opening an expired day from an older
overview. Failures never become fabricated zero counts or expose internal
error details. Unmatched Telemetry API requests return a generic JSON `404`
error without echoing the requested URL. A successful all-zero response
remains a valid snapshot.

**Overview and service health generated at** identifies the overview's
timestamp; **Hourly data generated at** below each detail graph identifies
that detail's own timestamp. Today's detail is labelled **In progress** using
response-date context, not a live clock or polling promise. Counts cover the
full selected UTC calendar day using stored observation times; a generated
timestamp marks computation start, not a cutoff or transactional snapshot.
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
the same ranges. All dates, values, labels, and statuses remain visible and
wrap without horizontal page or card scrolling.

## Event-page hierarchy

The center stage presents match states in betting priority:

1. next-live context when no event is active or counting down;
2. all server-authoritative active-live events;
3. all kickoff-soon countdown events;
4. the recently completed live match;
5. upcoming pre-match events.

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
internal neutral-side value and spans extra grid width where available. It
falls back to a balanced two-column selection grid on narrow screens.

### Betting slips

Live and pre-match drafts can both be open. They use separate labelled slips,
distinct visual accents and subtly different surfaces, independent wagers, and
independent pending/error state. The live slip uses a restrained warm tint
derived from the current theme; the pre-match slip retains the normal
accent/surface treatment. The UI never merges them into one combined
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

Backoffice event cards show the scheduled kickoff alongside the event name,
score controls, result state, and visibility. Its create form states the
server-defined 15-minute kickoff lead time.

## Design principles

### Identity before decoration

Visual variants may change color, density, border, and composition. They must
not change route access, selection identity, event identity, accessible names,
or the meaning of a status.

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
