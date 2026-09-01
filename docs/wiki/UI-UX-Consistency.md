# UI/UX Consistency

BetStan treats product-wide consistency as usability evidence, not decoration.
A page can be locally functional and still be defective when its hierarchy,
spacing, controls, states, or interaction behavior conflict with stable
patterns elsewhere in the product.

## When the specialist is required

Every change that alters what a user sees or how a user interacts requires
`betstan-ux-ui-expert`, including:

- layout, typography, copy, color, icon, card, control, or navigation changes;
- loading, empty, error, disabled, stale, suspended, live, terminal, and
  retained-result presentation;
- responsive, theme, or UI-variant behavior;
- focus, keyboard, touch, form, live-update, and state-transition behavior;
- user-visible data formatting, terminology, ordering, or plausibility.

The agent is a mandatory conditional specialist: it applies to every
user-facing slice but does not become a universal quality gate for backend,
infrastructure, or documentation-only work.

## One two-phase work unit

Register one specialist `work_id`, owner, and agent context for the complete
slice.

1. **Baseline specification:** before implementation by the registered path
   owner, name the stable reference grammar, required information hierarchy,
   states, responsive behavior, accessibility constraints, intentional
   semantic differences, and acceptance evidence.
2. **Immutable-result audit:** after implementation, review the exact committed
   head against the same baseline and issue `UX_REVIEW_PASSED`,
   `UX_CHANGES_REQUIRED`, or `UX_CLARIFICATION_NEEDED`.

Do not create a second UX agent, handoff-only reviewer, or extra universal
quality gate for the post-implementation phase.

## Establishing the reference baseline

Use references in this order:

1. Accepted product semantics and information that affects a betting decision.
2. Shared application shell, navigation, global variables, and repeated
   components.
3. Stable patterns repeated across `/`, `/bets`, `/login`, `/signup`, and
   `/backoffice`.
4. The closest sibling component with the same purpose and state model.
5. Supplied screenshots or design examples.

A single screenshot and the newest page are evidence, not a design system. If
stable references conflict, report the conflict and request the smallest
product decision instead of silently choosing whichever example is convenient.

## Consistency matrix

The UX result names its references and compares every applicable dimension:

| Dimension | What to compare |
|---|---|
| Hierarchy and type | heading levels, emphasis, label/value relationships, number and odds prominence |
| Space and width | spacing rhythm, alignment, container width, dense and sparse use of the stage |
| Surfaces | cards, backgrounds, borders, radii, elevation, separators |
| Controls | height, label wrapping, odds baseline, icon placement, touch target, disabled treatment |
| Semantic status | color meaning, non-color cues, live/stale/suspended/terminal distinction |
| Copy | product terminology, capitalization, error clarity, internal identifier leakage |
| States | loading, empty, error, disabled, stale, suspended, live, terminal, retained |
| Responsive behavior | desktop, tablet, mobile, nested containers, long content, overflow |
| Variants and themes | v1/v2/v3 and light/dark behavior |
| Interaction | DOM/reading/keyboard order, focus, touch, local-state retention, live-update movement |

For each material difference, record the reference, observed divergence, user
impact, classification, required action, evidence, and confidence.

## State and coverage selection

Review the smallest representative set that covers the changed behavior. It
may include:

- sparse, dense, empty, loading, error, and long-content layouts;
- one, two, and three desktop cards plus tablet and mobile collapse;
- multiple simultaneous live matches and recently finished retention;
- normal, hover, focus, selected, disabled, stale, suspended, and terminal
  controls;
- v1, v2, v3 and light/dark only where the changed primitive is shared;
- anonymous, ordinary-user, and backoffice visibility where authorization
  changes presentation.

Do not demand a full Cartesian test matrix when the same shared primitive and
evidence prove several cells. Do not omit a materially different state merely
because the happy path looks consistent.

## Classifying differences

| Classification | Meaning | Required outcome |
|---|---|---|
| Blocking usability defect | betting information is hidden/misleading, accessibility fails, interaction is unstable, or content collides/clips/overflows | fix before acceptance |
| Required consistency fix | the slice diverges from a stable product pattern without a semantic reason | fix before `UX_REVIEW_PASSED` |
| Intentional product exception | product meaning requires a different treatment and the rationale is documented | accept and retain the rationale |
| Optional polish | improvement is useful but not required for coherent, accessible behavior | record separately; do not block the smallest complete change |

Consistency does not mean every route must look identical. A readable-width
authentication form may intentionally be narrower than an event board.
Different treatment is valid when product semantics require it and the reason
is explicit.

## Evidence policy

The specialist may identify a design inconsistency from source, stable
references, and supplied screenshots. It must state confidence and any dynamic
or responsive behavior that remains unverified.

Rendered evidence is required for precise claims about pixel geometry,
collision, clipping, overflow, touch-target size, focus order, layout shift, or
dynamic interaction. Ask `betstan-test-engineer` for the smallest existing
browser, accessibility, interaction, or computed-layout check that resolves
the claim.

A user-facing change does not automatically require a new screenshot baseline,
image-diff dependency, or full responsive Playwright matrix. Reuse existing
evidence when it proves the contract.

## Live-betting examples

The compact live-betting work established reusable examples:

- one sparse card occupying only a dense-grid third is an accidental content
  island, not intentional whitespace;
- sibling odds controls with different button heights or odds baselines are
  inconsistent even when every value remains clickable;
- a fixed ten-option score board needs balanced rows rather than an orphaned
  final option;
- terminal markets may disappear from the actionable board when product
  semantics require it, while suspended or stale non-terminal markets remain
  visible and labelled;
- technically valid but duplicated, contradictory, or implausible score/odds
  presentation is a usability defect;
- cross-card baseline drift: a sibling card's market heading, control bounds,
  or odds baseline must not shift when another card's content length (for
  example a long team name) changes;
- event identity versus selection semantics: a compact semantic selection
  token (for example `1`/`X`/`2`) expresses the betting outcome while full
  event/team identity stays in the card header and accessible name; duplicating
  identity inside the control that causes wrapping is a defect, not
  compaction;
- markets sharing one route/card family use one shared centered heading
  treatment;
- stable board order: a fixed-size selectable board uses a stable domain
  order rather than a volatile value such as current odds, and any
  presentation sort preserves each option's original ID/name/value tuple
  instead of reconnecting a value to a selection by array position;
- coupled markets sharing one pricing model (for example 1X2 and Correct
  Score) are cross-checked for numeric plausibility against each other;
- role-gated navigation: a role-gated global entry (for example Backoffice)
  needs visible discoverable text, not only an icon, for the correct role in
  every affected UI variant, and stays absent for every non-privileged state;
- phantom sparse-grid tracks: a compact market grid collapses empty tracks
  with `auto-fit` rather than reserving them with `auto-fill`, so occupied
  tracks equal visible market cards;
- equal-height market groups: market cards sharing one row stretch to equal
  height and top alignment without fixed pixel heights or nested scrolling;
- readable status words: a status badge wraps only between words, never
  inside one;
- a single upper-section countdown/live/finished card uses full event-stage
  width and stays within a bounded height budget relative to the comparable
  pre-match row; an intentionally expanded historical disclosure is the one
  allowed exception.

Product-specific live rules remain in [[Live Betting Production]].

## Pull request evidence

The pull request records:

- affected routes, components, states, variants, themes, and viewport classes;
- named reference screens, components, and tokens;
- intentional exceptions and rationale;
- baseline and final UX status, bound to the exact head SHA;
- evidence used, unverified ambiguity, and remaining optional polish.

UX evidence informs critic, test, and final validation. It is not architecture,
quality, merge, deployment, activation, or rollback authority. See
[[Release Orchestration]].
