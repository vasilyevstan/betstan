import {
  BettingStatus,
  CompetingSide,
  EventPhase,
  IncidentCaps,
  LiveIncidentType,
  LiveMarketSelection,
  LiveMarketSettlement,
  LiveMarketSnapshot,
  LiveMarketStatus,
  LiveMarketType,
  LiveSettlementReason,
  NextMarketType,
  SimTimeline,
  SimulationTransition,
  TeamSide,
} from "./types";
import { sortTimelineEntries } from "./timeline";

interface MarketState {
  marketType: LiveMarketType;
  marketVersion: number;
  quoteVersion: number;
  status: LiveMarketStatus;
  odds: number[];
}

interface PricingFactors {
  attackFactor: number;
  disciplineFactor: number;
  homeAttackShare: number;
  homeDisciplineShare: number;
}

const NEXT_MARKETS: NextMarketType[] = [
  LiveMarketType.NEXT_YELLOW_CARD,
  LiveMarketType.NEXT_RED_CARD,
  LiveMarketType.NEXT_CORNER,
  LiveMarketType.NEXT_PENALTY,
];

const ALL_MARKETS: LiveMarketType[] = [
  ...NEXT_MARKETS,
  LiveMarketType.HALF_TIME_RESULT,
];

/**
 * The two live-slip products exposed as "live-betting candidates" from
 * T-10 minutes before kickoff up to the atomic kickoff transition: which
 * team kicks off, and whether a goal is scored in the first simulated
 * minute. Both are settled exactly once (kickoff-team at kickoff, first-
 * minute-goal after simulated minute 1) and are intentionally kept out of
 * `ALL_MARKETS`, which drives the generic in-match creation/settlement
 * loops below that do not apply to these two.
 */
const PRE_KICKOFF_MARKETS: LiveMarketType[] = [
  LiveMarketType.KICKOFF_TEAM,
  LiveMarketType.FIRST_MINUTE_GOAL,
];

const SNAPSHOT_MARKETS: LiveMarketType[] = [
  ...ALL_MARKETS,
  ...PRE_KICKOFF_MARKETS,
];

const NEXT_MARKET_CAPS: Record<NextMarketType, keyof IncidentCaps> = {
  [LiveMarketType.NEXT_YELLOW_CARD]: "yellows",
  [LiveMarketType.NEXT_RED_CARD]: "reds",
  [LiveMarketType.NEXT_CORNER]: "corners",
  [LiveMarketType.NEXT_PENALTY]: "penaltyAwards",
};

function marketId(eventId: string, marketType: LiveMarketType): string {
  return `${eventId}:${marketType}`;
}

function sides(marketType: LiveMarketType): TeamSide[] {
  switch (marketType) {
    case LiveMarketType.HALF_TIME_RESULT:
      return ["HOME", "DRAW", "AWAY"];
    case LiveMarketType.KICKOFF_TEAM:
      return ["HOME", "AWAY"];
    case LiveMarketType.FIRST_MINUTE_GOAL:
      return ["YES", "NO"];
    default:
      return ["HOME", "AWAY", "NONE"];
  }
}

function selectionId(
  eventId: string,
  state: Pick<MarketState, "marketType" | "marketVersion">,
  side: TeamSide
): string {
  return `${marketId(eventId, state.marketType)}:${state.marketVersion}:${side}`;
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

function price(probability: number, timeline: SimTimeline): number {
  if (!Number.isFinite(probability)) {
    throw new RangeError("market probability must be finite");
  }
  const adjusted = Math.min(0.98, Math.max(0, probability) * (1 + timeline.config.marketMargin));
  const raw = adjusted === 0 ? timeline.config.maxOdds : 1 / adjusted;
  return rounded(
    Math.max(timeline.config.minOdds, Math.min(timeline.config.maxOdds, raw))
  );
}

function poissonPmf(lambda: number, count: number): number {
  if (count === 0) {
    return Math.exp(-lambda);
  }
  let probability = Math.exp(-lambda);
  for (let index = 1; index <= count; index += 1) {
    probability *= lambda / index;
  }
  return probability;
}

function factors(timeline: SimTimeline): PricingFactors {
  return timeline.pricing ?? {
    attackFactor: 1,
    disciplineFactor: 1,
    homeAttackShare: 0.5,
    homeDisciplineShare: 0.5,
  };
}

function marketRate(
  type: NextMarketType,
  timeline: SimTimeline
): { rate: number; homeShare: number } {
  const pricing = factors(timeline);
  const { rates, rateScale } = timeline.config;
  switch (type) {
    case LiveMarketType.NEXT_YELLOW_CARD:
      return {
        rate: rates.yellows * rateScale * pricing.disciplineFactor,
        homeShare: pricing.homeDisciplineShare,
      };
    case LiveMarketType.NEXT_RED_CARD:
      return {
        rate: rates.reds * rateScale * pricing.disciplineFactor,
        homeShare: pricing.homeDisciplineShare,
      };
    case LiveMarketType.NEXT_CORNER:
      return {
        rate: rates.corners * rateScale * pricing.attackFactor,
        homeShare: pricing.homeAttackShare,
      };
    case LiveMarketType.NEXT_PENALTY:
      return {
        rate: rates.penaltyAwards * rateScale * pricing.attackFactor,
        homeShare: pricing.homeAttackShare,
      };
  }
}

function nextEventOdds(
  type: NextMarketType,
  offsetMs: number,
  timeline: SimTimeline
): number[] {
  const remaining = Math.max(0, timeline.durationMs - offsetMs) / timeline.durationMs;
  const rate = marketRate(type, timeline);
  const eventProbability = 1 - Math.exp(-rate.rate * remaining);
  return [
    price(eventProbability * rate.homeShare, timeline),
    price(eventProbability * (1 - rate.homeShare), timeline),
    price(1 - eventProbability, timeline),
  ];
}

function halfTimeOdds(
  offsetMs: number,
  homeScore: number,
  awayScore: number,
  timeline: SimTimeline
): number[] {
  const remaining = Math.max(0, timeline.durationMs / 2 - offsetMs)
    / (timeline.durationMs / 2);
  const pricing = factors(timeline);
  const goalRate = timeline.config.rates.goals
    * timeline.config.rateScale
    * pricing.attackFactor
    * remaining
    / 2;
  const homeLambda = goalRate * pricing.homeAttackShare;
  const awayLambda = goalRate * (1 - pricing.homeAttackShare);
  const outcomes = { HOME: 0, DRAW: 0, AWAY: 0 };
  const maxHomeGoals = Math.min(
    100,
    Math.ceil(homeLambda + 10 * Math.sqrt(homeLambda) + 10)
  );
  const maxAwayGoals = Math.min(
    100,
    Math.ceil(awayLambda + 10 * Math.sqrt(awayLambda) + 10)
  );
  for (let homeGoals = 0; homeGoals <= maxHomeGoals; homeGoals += 1) {
    const homeProbability = poissonPmf(homeLambda, homeGoals);
    for (let awayGoals = 0; awayGoals <= maxAwayGoals; awayGoals += 1) {
      const probability = homeProbability * poissonPmf(awayLambda, awayGoals);
      if (homeScore + homeGoals > awayScore + awayGoals) {
        outcomes.HOME += probability;
      } else if (homeScore + homeGoals < awayScore + awayGoals) {
        outcomes.AWAY += probability;
      } else {
        outcomes.DRAW += probability;
      }
    }
  }
  const total = outcomes.HOME + outcomes.DRAW + outcomes.AWAY;
  if (!Number.isFinite(total) || total <= 0) {
    throw new RangeError("half-time outcome probabilities are invalid");
  }
  return [
    price(outcomes.HOME / total, timeline),
    price(outcomes.DRAW / total, timeline),
    price(outcomes.AWAY / total, timeline),
  ];
}

/**
 * Kickoff-team is a fair coin: no in-match evidence exists yet at the point
 * it is priced (pre-kickoff), so both sides are priced at the same 50/50
 * probability regardless of offset/scores.
 */
function kickoffTeamOdds(timeline: SimTimeline): number[] {
  return [price(0.5, timeline), price(0.5, timeline)];
}

/**
 * Goal-in-first-minute is priced once, before kickoff, as a fixed prop bet:
 * the Poisson probability of at least one goal in a single simulated
 * football minute, derived from the same goal rate/attack-factor pricing
 * inputs used for in-match markets.
 */
function firstMinuteGoalOdds(timeline: SimTimeline): number[] {
  const pricing = factors(timeline);
  const totalFootballMinutes = 90;
  const perMinuteGoalRate =
    (timeline.config.rates.goals * timeline.config.rateScale * pricing.attackFactor)
    / totalFootballMinutes;
  const probabilityYes = 1 - Math.exp(-perMinuteGoalRate);
  return [
    price(probabilityYes, timeline),
    price(1 - probabilityYes, timeline),
  ];
}

function oddsFor(
  type: LiveMarketType,
  offsetMs: number,
  homeScore: number,
  awayScore: number,
  timeline: SimTimeline
): number[] {
  switch (type) {
    case LiveMarketType.HALF_TIME_RESULT:
      return halfTimeOdds(offsetMs, homeScore, awayScore, timeline);
    case LiveMarketType.KICKOFF_TEAM:
      return kickoffTeamOdds(timeline);
    case LiveMarketType.FIRST_MINUTE_GOAL:
      return firstMinuteGoalOdds(timeline);
    default:
      return nextEventOdds(type, offsetMs, timeline);
  }
}

function createMarket(
  type: LiveMarketType,
  version: number,
  offsetMs: number,
  homeScore: number,
  awayScore: number,
  timeline: SimTimeline
): MarketState {
  return {
    marketType: type,
    marketVersion: version,
    quoteVersion: 1,
    status: LiveMarketStatus.OPEN,
    odds: oddsFor(type, offsetMs, homeScore, awayScore, timeline),
  };
}

function closeMarket(state: MarketState): MarketState {
  return {
    ...state,
    marketVersion: state.marketVersion + 1,
    quoteVersion: 1,
    status: LiveMarketStatus.CLOSED,
  };
}

function hasIncidentCapacityRemaining(
  type: NextMarketType,
  count: number,
  timeline: SimTimeline
): boolean {
  return count < timeline.config.caps[NEXT_MARKET_CAPS[type]];
}

function snapshot(eventId: string, state: MarketState): LiveMarketSnapshot {
  const marketSides = sides(state.marketType);
  const selections: LiveMarketSelection[] = marketSides.map((side, index) => ({
    selectionId: selectionId(eventId, state, side),
    side,
    odds: state.odds[index],
  }));
  return {
    marketId: marketId(eventId, state.marketType),
    marketType: state.marketType,
    marketVersion: state.marketVersion,
    quoteVersion: state.quoteVersion,
    status: state.status,
    selections,
  };
}

/**
 * Builds the two live-slip pre-kickoff markets (kickoff team, goal in first
 * minute) at their standalone, standing quote: version 1, quote version 1,
 * OPEN. Used to publish a synthetic pre-kickoff snapshot independently of
 * `projectTransitions`, for the T-10-to-kickoff countdown window during
 * which no other in-match market exists yet. Both markets are priced as
 * fixed, offset-independent props (see `kickoffTeamOdds`/
 * `firstMinuteGoalOdds`), so this can safely be called at any point before
 * kickoff without needing an elapsed-offset argument. `marketVersion` is
 * never incremented for either market for the rest of their lifecycle
 * (kickoff-team settles, and first-minute-goal closes then settles, always
 * in place at version 1) -- this is what lets settlement match a bet placed
 * against this exact pre-kickoff snapshot.
 */
export function buildPreKickoffMarkets(timeline: SimTimeline): LiveMarketSnapshot[] {
  return PRE_KICKOFF_MARKETS.map((type) =>
    snapshot(timeline.eventId, createMarket(type, 1, 0, 0, 0, timeline))
  );
}

function winningHalfTimeSide(homeScore: number, awayScore: number): TeamSide {
  if (homeScore === awayScore) {
    return "DRAW";
  }
  return homeScore > awayScore ? "HOME" : "AWAY";
}

function trigger(type: LiveIncidentType): NextMarketType | undefined {
  switch (type) {
    case LiveIncidentType.YELLOW_CARD:
      return LiveMarketType.NEXT_YELLOW_CARD;
    case LiveIncidentType.RED_CARD:
      return LiveMarketType.NEXT_RED_CARD;
    case LiveIncidentType.CORNER:
      return LiveMarketType.NEXT_CORNER;
    case LiveIncidentType.PENALTY_AWARDED:
      return LiveMarketType.NEXT_PENALTY;
    default:
      return undefined;
  }
}

function marketSettlement(
  eventId: string,
  state: MarketState,
  sequence: number,
  winningSide: TeamSide,
  settlementReason: LiveSettlementReason
): LiveMarketSettlement {
  return {
    marketId: marketId(eventId, state.marketType),
    marketVersion: state.marketVersion,
    settlementReason,
    settlementSequence: sequence,
    winningSide,
    winningSelection: selectionId(eventId, state, winningSide),
  };
}

function repriceOpenMarkets(
  markets: Map<LiveMarketType, MarketState>,
  skip: Set<LiveMarketType>,
  offsetMs: number,
  homeScore: number,
  awayScore: number,
  timeline: SimTimeline
): void {
  markets.forEach((state, type) => {
    if (state.status !== LiveMarketStatus.OPEN || skip.has(type)) {
      return;
    }
    const odds = oddsFor(type, offsetMs, homeScore, awayScore, timeline);
    if (odds.some((odd, index) => odd !== state.odds[index])) {
      state.odds = odds;
      state.quoteVersion += 1;
    }
  });
}

function isMaterialIncident(type: LiveIncidentType): boolean {
  return type !== LiveIncidentType.KICK_OFF
    && type !== LiveIncidentType.HALF_TIME
    && type !== LiveIncidentType.FULL_TIME
    && type !== LiveIncidentType.FIRST_MINUTE_ELAPSED;
}

export function projectTransitions(timeline: SimTimeline): SimulationTransition[] {
  const markets = new Map<LiveMarketType, MarketState>();
  const transitions: SimulationTransition[] = [];
  const triggeredCounts = new Map<NextMarketType, number>();
  let homeScore = 0;
  let awayScore = 0;
  let bettingStatus: BettingStatus = BettingStatus.OPEN;

  const sortedEntries = sortTimelineEntries(timeline.entries);
  // First-minute-goal settles on whether any goal fell strictly before this
  // cutoff (the offset marking the end of simulated minute 1, i.e. the
  // half-open window [0:00, 1:00)). Computed up front, independent of
  // iteration/tie-break order, so a goal recorded at exactly the same
  // offset as the marker (a theoretical tie) is still correctly excluded.
  const firstMinuteMarker = sortedEntries.find(
    (item) => item.incident.type === LiveIncidentType.FIRST_MINUTE_ELAPSED
  );
  const firstMinuteCutoffMs = firstMinuteMarker ? firstMinuteMarker.offsetMs : 0;
  let firstMinuteGoalScored = false;

  sortedEntries.forEach((entry, index) => {
    const sequence = index + 1;
    const settlements: LiveMarketSettlement[] = [];
    const freshMarkets = new Set<LiveMarketType>();
    const { incident } = entry;

    if (incident.type === LiveIncidentType.GOAL) {
      if (incident.side === "HOME") {
        homeScore += 1;
      } else if (incident.side === "AWAY") {
        awayScore += 1;
      }
      if (entry.offsetMs < firstMinuteCutoffMs) {
        firstMinuteGoalScored = true;
      }
    }

    if (incident.type === LiveIncidentType.KICK_OFF) {
      ALL_MARKETS.forEach((type) => {
        markets.set(
          type,
          createMarket(type, 1, entry.offsetMs, homeScore, awayScore, timeline)
        );
      });

      // Kickoff team and first-minute-goal close atomically at kickoff.
      // Kickoff team settles immediately (the side is already decided in
      // the timeline); first-minute-goal only closes here and settles later
      // at the FIRST_MINUTE_ELAPSED marker. Neither market's marketVersion
      // is ever bumped away from 1 -- both are mutated in place through
      // their status transitions (the same pattern HALF_TIME_RESULT uses
      // for its own settle-in-place), so a bet placed against the pre-
      // kickoff snapshot (also published at version 1) always matches the
      // eventual settlement by (marketId, marketVersion).
      const kickoffTeam = createMarket(
        LiveMarketType.KICKOFF_TEAM,
        1,
        entry.offsetMs,
        homeScore,
        awayScore,
        timeline
      );
      const kickoffSide = incident.side as CompetingSide;
      settlements.push(
        marketSettlement(
          timeline.eventId,
          kickoffTeam,
          sequence,
          kickoffSide,
          LiveSettlementReason.KICK_OFF
        )
      );
      kickoffTeam.status = LiveMarketStatus.SETTLED;
      markets.set(LiveMarketType.KICKOFF_TEAM, kickoffTeam);

      const firstMinuteGoal = createMarket(
        LiveMarketType.FIRST_MINUTE_GOAL,
        1,
        entry.offsetMs,
        homeScore,
        awayScore,
        timeline
      );
      firstMinuteGoal.status = LiveMarketStatus.CLOSED;
      markets.set(LiveMarketType.FIRST_MINUTE_GOAL, firstMinuteGoal);

      bettingStatus = BettingStatus.OPEN;
    }

    if (incident.type === LiveIncidentType.FIRST_MINUTE_ELAPSED) {
      const firstMinuteGoal = markets.get(LiveMarketType.FIRST_MINUTE_GOAL);
      if (firstMinuteGoal && firstMinuteGoal.status === LiveMarketStatus.CLOSED) {
        const winner: TeamSide = firstMinuteGoalScored ? "YES" : "NO";
        settlements.push(
          marketSettlement(
            timeline.eventId,
            firstMinuteGoal,
            sequence,
            winner,
            LiveSettlementReason.FIRST_MINUTE_GOAL
          )
        );
        firstMinuteGoal.status = LiveMarketStatus.SETTLED;
      }
    }

    const triggered = trigger(incident.type);
    if (triggered) {
      const current = markets.get(triggered);
      if (!current) {
        throw new Error(`missing market ${triggered}`);
      }
      const winner = incident.side as CompetingSide;
      settlements.push(
        marketSettlement(
          timeline.eventId,
          current,
          sequence,
          winner,
          LiveSettlementReason.INCIDENT
        )
      );
      const count = (triggeredCounts.get(triggered) ?? 0) + 1;
      triggeredCounts.set(triggered, count);
      markets.set(
        triggered,
        hasIncidentCapacityRemaining(triggered, count, timeline)
          ? createMarket(
              triggered,
              current.marketVersion + 1,
              entry.offsetMs,
              homeScore,
              awayScore,
              timeline
            )
          : closeMarket(current)
      );
      freshMarkets.add(triggered);
    }

    if (incident.type === LiveIncidentType.HALF_TIME) {
      const halfTime = markets.get(LiveMarketType.HALF_TIME_RESULT);
      if (!halfTime) {
        throw new Error("missing half-time market");
      }
      const winner = winningHalfTimeSide(homeScore, awayScore);
      settlements.push(
        marketSettlement(
          timeline.eventId,
          halfTime,
          sequence,
          winner,
          LiveSettlementReason.HALF_TIME
        )
      );
      halfTime.status = LiveMarketStatus.SETTLED;
      NEXT_MARKETS.forEach((type) => {
        const market = markets.get(type);
        if (market?.status === LiveMarketStatus.OPEN) {
          market.status = LiveMarketStatus.SUSPENDED;
        }
      });
      bettingStatus = BettingStatus.SUSPENDED;
    }

    if (incident.type === LiveIncidentType.SECOND_HALF_KICK_OFF) {
      NEXT_MARKETS.forEach((type) => {
        const market = markets.get(type);
        if (market && market.status === LiveMarketStatus.SUSPENDED) {
          market.status = LiveMarketStatus.OPEN;
        }
      });
      bettingStatus = BettingStatus.OPEN;
    }

    if (incident.type === LiveIncidentType.FULL_TIME) {
      NEXT_MARKETS.forEach((type) => {
        const market = markets.get(type);
        if (!market) {
          throw new Error(`missing market ${type}`);
        }
        if (market.status === LiveMarketStatus.CLOSED) {
          return;
        }
        if (market.status !== LiveMarketStatus.OPEN) {
          throw new Error(`unexpected market status for ${type} at full-time`);
        }
        settlements.push(
          marketSettlement(
            timeline.eventId,
            market,
            sequence,
            "NONE",
            LiveSettlementReason.FULL_TIME_NONE
          )
        );
        market.status = LiveMarketStatus.SETTLED;
      });
      bettingStatus = BettingStatus.CLOSED;
    }

    if (isMaterialIncident(incident.type)) {
      repriceOpenMarkets(
        markets,
        freshMarkets,
        entry.offsetMs,
        homeScore,
        awayScore,
        timeline
      );
    }

    transitions.push({
      eventId: timeline.eventId,
      sequence,
      offsetMs: entry.offsetMs,
      minute: entry.minute,
      addedTime: entry.addedTime,
      phase: entry.phase,
      homeScore,
      awayScore,
      scores: { home: homeScore, away: awayScore },
      bettingStatus,
      incident: { ...incident },
      markets: SNAPSHOT_MARKETS.map((type) => {
        const market = markets.get(type);
        if (!market) {
          throw new Error(`missing market ${type}`);
        }
        return snapshot(timeline.eventId, market);
      }),
      settlements,
    });
  });

  return transitions;
}
