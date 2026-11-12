# BetStan

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Registered players choose event outcomes, manage slips and inspect their own
bet history and profile. Public Backoffice operators create and manage events,
market definitions and manually declared results.

## Product Purpose

BetStan is a football betting simulation using nominal Stanbucks. It is not a
real-money wallet. The accepted markets extension lets operators reuse
versioned definitions and generate event-specific odds, while players combine
compatible same-match selections through a correlation-aware Bet Builder.

## Capabilities and Constraints

- Templates contain bounded declarative score rules or explicit manual
  settlement terms, never executable formulas.
- Manual odds generation supports equal-chance assumptions, probabilities and
  relative weights. Generating odds does not establish settlement authority.
- A Builder contains 2-10 modeled selections from one event. Manual and
  operator-priced markets are limited to singles or different-match accumulators.
- Quotes and board replacements require explicit review. Accepted rules and
  prices remain frozen through settlement and history.
- Market authoring is public by product decision. Betting ownership remains
  tied to the authenticated player.
- Source delivery does not imply runtime availability. Compatible readers
  must precede activation; existing bets must remain settleable with writers off.

## Brand Commitments

Preserve the BetStan name and established application identity. The user
requires compact Backoffice event cards, with identity on the left and compact
score/action controls on the right where width permits. Additional market
authoring belongs in an event-focused workspace, not expanded event tiles.

## Evidence on Hand

`docs/wiki/Application-Processes.md` and `docs/wiki/Architecture.md` describe
the application and its service boundaries. The approved market scope is
represented by the source contracts and focused tests. Browser fixtures are
synthetic, not production activity or proof of deployment.
