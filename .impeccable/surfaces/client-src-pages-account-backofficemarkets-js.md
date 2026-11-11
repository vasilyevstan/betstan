---
version: 1
slug: "client-src-pages-account-backofficemarkets-js"
primary_target: "client/src/pages/account/BackofficeMarkets.js"
related_targets: ["client/src/pages/account/Backoffice.js","client/src/pages/event/EventMarkets.js","client/src/pages/Slip.js","client/src/pages/account/MyBets.js"]
---

## Direction contract

THESIS: Extend the compact Match Desk with an event-focused Markets workspace. Keep event cards horizontal and move authoring out of the list; no expanded dashboard tiles.

OWN-WORLD: Inherit existing blue action accent, neutral surfaces, system UI text, compact headings, 44px controls and light/dark tokens. No new brand, typography, decorative imagery or animation.

STORY: Operators reuse or version a definition, bind event parameters, inspect generated prices and explicitly publish. Players choose a single or up to ten modeled selections, review one expiring quote and explicitly replace conflicting event selections.

FIRST VIEWPORT: Breadcrumb and event identity above a compact action row. Event market list comes before the focused editor; template authoring is a separate disclosure. The player view places selection mode above grouped outcomes and a plainly labeled quote review. Existing Statistics and Slip regions remain.

FORM: Precisely scoped extension of the accepted Backoffice and betting surfaces, with a focused event route. No concept seed or replacement visual world is required. The signature interaction is preview-to-publish and quote-to-reviewed-slip, never an implicit mutation.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

Constraints: Public Backoffice authoring, owner-bound betting, 2-10 modeled Builder selections, manual-result review, frozen history, clear pending/rejected/suspended/expired states. Preserve existing responsive shell and compact score controls. Ordinary extension: do not create or rewrite a global design system; compare finished source against incumbent tokens. No shipping rasters are introduced.
