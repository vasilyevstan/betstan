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
| Center stage | Events, authentication, My Bets, or Backoffice route |
| Right sidebar | Independent live and pre-match slips |

The sidebars are sticky when space permits. On smaller screens the center
content appears first and the supporting panels stack below it. This preserves
the primary task while keeping statistics and both slips available without
creating separate mobile-only behavior.

Primary routes are:

| Route | Screen |
| --- | --- |
| `/` | Upcoming, countdown, live, and recently finished events |
| `/bets` | User betting history and settlement state |
| `/backoffice` | Public event simulation controls |
| `/signup` | Account creation |
| `/login` | Login |
| `/logout` | Session logout |

The header keeps **Events**, **My Bets**, **Backoffice**, authentication, UI
variant, and theme controls discoverable. Backoffice remains visibly labelled
and usable for anonymous visitors as well as signed-in users.

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
between Events, My Bets, Backoffice, login, and signup therefore preserves
valid `ui` and `theme` values. The switchers update one choice without
discarding the other or unrelated accepted query state.

Examples:

```text
/?ui=v1&theme=dark
/bets?ui=v2&theme=light
/backoffice?ui=v3&theme=dark
```

The URL makes a visual state reproducible for testing and review without
creating separate deployments.

## Event-page hierarchy

The center stage presents match states in betting priority:

1. next-live and countdown context;
2. active live or recently completed live match;
3. upcoming pre-match events.

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
