import {
  EventPhase,
  LiveIncidentType,
  LiveMarketStatus,
  LiveMarketType,
  LiveSettlementReason,
  NextMarketType,
  SimTimeline,
  SimulationResult,
  SimulationTransition,
  TeamSide,
} from "./types";

const MARKET_TYPES: LiveMarketType[] = [
  LiveMarketType.HALF_TIME_RESULT,
  LiveMarketType.NEXT_YELLOW_CARD,
  LiveMarketType.NEXT_RED_CARD,
  LiveMarketType.NEXT_CORNER,
  LiveMarketType.NEXT_PENALTY,
];

/**
 * The two pre-kickoff live-slip markets. These are intentionally validated
 * separately from the generic `MARKET_TYPES` in-match lifecycle checks
 * below (`assertMarkets`'s per-incident status-expectation branches) --
 * their lifecycle (settle/close atomically at kick-off, first-minute-goal
 * settles once after simulated minute 1, both pinned at marketVersion 1
 * forever) does not follow the generic next-market/half-time pattern. See
 * `assertPreKickoffMarkets`.
 */
const PRE_KICKOFF_MARKET_TYPES: LiveMarketType[] = [
  LiveMarketType.KICKOFF_TEAM,
  LiveMarketType.FIRST_MINUTE_GOAL,
];

const SNAPSHOT_MARKET_TYPES: LiveMarketType[] = [
  ...MARKET_TYPES,
  ...PRE_KICKOFF_MARKET_TYPES,
];

const NEXT_MARKET_TYPES: NextMarketType[] = [
  LiveMarketType.NEXT_YELLOW_CARD,
  LiveMarketType.NEXT_RED_CARD,
  LiveMarketType.NEXT_CORNER,
  LiveMarketType.NEXT_PENALTY,
];

const STRUCTURAL_TYPES = new Set<LiveIncidentType>([
  LiveIncidentType.KICK_OFF,
  LiveIncidentType.ADDED_TIME_ANNOUNCED,
  LiveIncidentType.HALF_TIME,
  LiveIncidentType.SECOND_HALF_KICK_OFF,
  LiveIncidentType.FULL_TIME,
]);

const NEXT_MARKET_CAPS: Record<NextMarketType, keyof SimTimeline["config"]["caps"]> = {
  [LiveMarketType.NEXT_YELLOW_CARD]: "yellows",
  [LiveMarketType.NEXT_RED_CARD]: "reds",
  [LiveMarketType.NEXT_CORNER]: "corners",
  [LiveMarketType.NEXT_PENALTY]: "penaltyAwards",
};

function fail(message: string): never {
  throw new Error(`simulation invariant: ${message}`);
}

function only(
  transitions: SimulationTransition[],
  type: LiveIncidentType
): SimulationTransition {
  const found = transitions.filter((transition) => transition.incident.type === type);
  if (found.length !== 1) {
    return fail(`expected one ${type}`);
  }
  return found[0];
}

function sameOdds(
  left: SimulationTransition["markets"][number],
  right: SimulationTransition["markets"][number]
): boolean {
  return left.selections.every(
    (selection, index) => selection.odds === right.selections[index]?.odds
  );
}

function nextMarketForIncident(
  type: LiveIncidentType
): NextMarketType | undefined {
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

function assertClock(
  transition: SimulationTransition,
  timeline: SimTimeline
): void {
  const { phase, minute, addedTime, incident, offsetMs } = transition;
  if (!Number.isInteger(offsetMs)) {
    fail(`non-integer offset at sequence ${transition.sequence}`);
  }
  const firstHalf = phase === EventPhase.FIRST_HALF
    || phase === EventPhase.FIRST_HALF_STOPPAGE
    || phase === EventPhase.HALF_TIME;
  const stoppage = firstHalf ? timeline.stoppage.first : timeline.stoppage.second;
  if (!Number.isInteger(minute) || minute < 0 || minute > 90) {
    fail(`invalid minute at sequence ${transition.sequence}`);
  }
  if (addedTime !== undefined) {
    if (!Number.isInteger(addedTime) || addedTime < 1 || addedTime > stoppage) {
      fail(`invalid added time at sequence ${transition.sequence}`);
    }
  }
  if (phase === EventPhase.FIRST_HALF && (minute < 0 || minute > 45)) {
    fail(`invalid first-half minute at sequence ${transition.sequence}`);
  }
  if (phase === EventPhase.FIRST_HALF_STOPPAGE && (minute !== 45 || !addedTime)) {
    fail(`invalid first-half stoppage at sequence ${transition.sequence}`);
  }
  if (phase === EventPhase.HALF_TIME && minute !== 45) {
    fail(`invalid half-time minute`);
  }
  if (phase === EventPhase.SECOND_HALF && (minute < 46 || minute > 90)) {
    fail(`invalid second-half minute at sequence ${transition.sequence}`);
  }
  if (phase === EventPhase.SECOND_HALF_STOPPAGE && (minute !== 90 || !addedTime)) {
    fail(`invalid second-half stoppage at sequence ${transition.sequence}`);
  }
  if (phase === EventPhase.FULL_TIME && minute !== 90) {
    fail("invalid full-time minute");
  }
  const stoppagePhase = phase === EventPhase.FIRST_HALF_STOPPAGE
    || phase === EventPhase.SECOND_HALF_STOPPAGE;
  if (!stoppagePhase && phase !== EventPhase.FULL_TIME && addedTime !== undefined) {
    fail(`added time outside stoppage at sequence ${transition.sequence}`);
  }
  if (stoppagePhase && addedTime === undefined) {
    fail(`stoppage without added time at sequence ${transition.sequence}`);
  }
  if (
    incident.type === LiveIncidentType.ADDED_TIME_ANNOUNCED
    && (
      addedTime === undefined
      || !stoppagePhase
    )
  ) {
    fail("added-time announcement outside stoppage");
  }
}

function assertPenalties(transitions: SimulationTransition[]): void {
  const awards = transitions.filter(
    (transition) => transition.incident.type === LiveIncidentType.PENALTY_AWARDED
  );
  const allOutcomes = transitions.filter(
    (transition) =>
      transition.incident.type === LiveIncidentType.PENALTY_SCORED
      || transition.incident.type === LiveIncidentType.PENALTY_MISSED
  );
  if (
    allOutcomes.length !== awards.length
    || allOutcomes.some(
      (outcome) =>
        !awards.some(
          (award) =>
            award.incident.penaltyId === outcome.incident.penaltyId
        )
    )
  ) {
    fail("penalty outcomes do not match awards");
  }
  awards.forEach((award) => {
    const { penaltyId, id, side } = award.incident;
    if (!penaltyId || !side) {
      fail(`invalid penalty award at sequence ${award.sequence}`);
    }
    const outcomes = transitions.filter((transition) =>
      transition.incident.penaltyId === penaltyId
      && (transition.incident.type === LiveIncidentType.PENALTY_SCORED
        || transition.incident.type === LiveIncidentType.PENALTY_MISSED)
    );
    if (outcomes.length !== 1) {
      fail(`penalty ${penaltyId} must have one outcome`);
    }
    const outcome = outcomes[0];
    const awardInFirstHalf =
      award.phase === EventPhase.FIRST_HALF
      || award.phase === EventPhase.FIRST_HALF_STOPPAGE;
    const outcomeInFirstHalf =
      outcome.phase === EventPhase.FIRST_HALF
      || outcome.phase === EventPhase.FIRST_HALF_STOPPAGE;
    if (
      outcome.offsetMs <= award.offsetMs
      || outcomeInFirstHalf !== awardInFirstHalf
      || outcome.incident.linkedIncidentId !== id
      || outcome.incident.side !== side
      || outcome.sequence <= award.sequence
    ) {
      fail(`penalty ${penaltyId} outcome is not linked and ordered`);
    }
    const goals = transitions.filter(
      (transition) =>
        transition.incident.type === LiveIncidentType.GOAL
        && transition.incident.penaltyId === penaltyId
    );
    if (outcome.incident.type === LiveIncidentType.PENALTY_SCORED) {
      if (
        goals.length !== 1
        || goals[0].offsetMs !== outcome.offsetMs
        || goals[0].incident.linkedIncidentId !== outcome.incident.id
        || goals[0].incident.side !== side
        || goals[0].sequence <= outcome.sequence
      ) {
        fail(`scored penalty ${penaltyId} must have a linked goal`);
      }
    } else if (goals.length !== 0) {
      fail(`missed penalty ${penaltyId} has a goal`);
    }
  });
}

function assertMarkets(
  timeline: SimTimeline,
  transitions: SimulationTransition[]
): void {
  const settlements = new Set<string>();
  let fullTimeNone = 0;
  let halfTimeSettlements = 0;
  const nextMarketCounts = new Map<NextMarketType, number>(
    NEXT_MARKET_TYPES.map((type) => [type, 0])
  );

  transitions.forEach((transition, index) => {
    const triggeredMarket = nextMarketForIncident(transition.incident.type);
    if (triggeredMarket) {
      nextMarketCounts.set(
        triggeredMarket,
        (nextMarketCounts.get(triggeredMarket) ?? 0) + 1
      );
    }

    if (transition.markets.length !== SNAPSHOT_MARKET_TYPES.length) {
      fail(`expected ${SNAPSHOT_MARKET_TYPES.length} markets at sequence ${transition.sequence}`);
    }
    const current = new Map(
      transition.markets.map((market) => [market.marketType, market])
    );
    if (
      current.size !== SNAPSHOT_MARKET_TYPES.length
      || SNAPSHOT_MARKET_TYPES.some((type) => !current.has(type))
    ) {
      fail(`market types are incomplete at sequence ${transition.sequence}`);
    }
    transition.markets.forEach((market) => {
      if (market.marketId !== `${timeline.eventId}:${market.marketType}`) {
        fail(`invalid market identity at sequence ${transition.sequence}`);
      }
      const expectedSelectionCount = PRE_KICKOFF_MARKET_TYPES.includes(market.marketType)
        ? 2
        : 3;
      if (
        market.selections.length !== expectedSelectionCount
        || new Set(market.selections.map((selection) => selection.selectionId)).size
          !== expectedSelectionCount
      ) {
        fail(`invalid selections at sequence ${transition.sequence}`);
      }
      market.selections.forEach((selection) => {
        if (
          selection.selectionId
          !== `${market.marketId}:${market.marketVersion}:${selection.side}`
        ) {
          fail(`invalid selection identity at sequence ${transition.sequence}`);
        }
        if (
          !Number.isFinite(selection.odds)
          || selection.odds < timeline.config.minOdds
          || selection.odds > timeline.config.maxOdds
        ) {
          fail(`invalid odds at sequence ${transition.sequence}`);
        }
      });
      if (market.marketVersion < 1 || market.quoteVersion < 1) {
        fail(`invalid market version at sequence ${transition.sequence}`);
      }
    });

    if (index === 0) {
      transition.markets.forEach((market) => {
        if (market.marketVersion !== 1 || market.quoteVersion !== 1) {
          fail("kick-off market versions must start at one");
        }
      });
    } else {
      const previous = new Map(
        transitions[index - 1].markets.map((market) => [market.marketType, market])
      );
      transition.markets.forEach((market) => {
        const prior = previous.get(market.marketType);
        if (!prior) {
          fail("market disappeared");
        }
        if (market.marketVersion === prior.marketVersion) {
          const oddsChanged = !sameOdds(market, prior);
          if (oddsChanged && market.quoteVersion !== prior.quoteVersion + 1) {
            fail(`quote did not advance after repricing ${market.marketType}`);
          }
          if (!oddsChanged && market.quoteVersion !== prior.quoteVersion) {
            fail(`quote advanced without changed odds ${market.marketType}`);
          }
        } else if (
          market.marketVersion === prior.marketVersion + 1
          && market.quoteVersion === 1
          && (
            market.status === LiveMarketStatus.OPEN
            || market.status === LiveMarketStatus.CLOSED
          )
        ) {
          const expectedKey = `${prior.marketId}:${prior.marketVersion}`;
          if (!transition.settlements.some(
            (settlement) => `${settlement.marketId}:${settlement.marketVersion}` === expectedKey
          )) {
            fail(`new market version without settlement ${market.marketType}`);
          }
        } else {
          fail(`invalid market version change ${market.marketType}`);
        }
      });
    }

    transition.settlements.forEach((settlement) => {
      const identity = `${settlement.marketId}:${settlement.marketVersion}`;
      if (settlements.has(identity)) {
        fail(`duplicate settlement ${identity}`);
      }
      settlements.add(identity);
      if (settlement.settlementSequence !== transition.sequence) {
        fail(`settlement sequence mismatch ${identity}`);
      }
      if (
        settlement.winningSelection
        !== `${settlement.marketId}:${settlement.marketVersion}:${settlement.winningSide}`
      ) {
        fail(`invalid winning selection ${identity}`);
      }
      if (settlement.settlementReason === LiveSettlementReason.FULL_TIME_NONE) {
        if (settlement.winningSide !== TeamSide.NONE) {
          fail(`full-time settlement must be none ${identity}`);
        }
        fullTimeNone += 1;
      }
      if (settlement.settlementReason === LiveSettlementReason.HALF_TIME) {
        halfTimeSettlements += 1;
      }
    });

    if (transition.incident.type === LiveIncidentType.HALF_TIME) {
      if (transition.bettingStatus !== "SUSPENDED") {
        fail("betting must be suspended at half-time");
      }
      MARKET_TYPES.forEach((type) => {
        const market = current.get(type);
        const expected = type === LiveMarketType.HALF_TIME_RESULT
          ? LiveMarketStatus.SETTLED
          : (
              (nextMarketCounts.get(type as NextMarketType) ?? 0)
                >= timeline.config.caps[NEXT_MARKET_CAPS[type as NextMarketType]]
            )
            ? LiveMarketStatus.CLOSED
            : LiveMarketStatus.SUSPENDED;
        if (market?.status !== expected) {
          fail(`invalid half-time market status ${type}`);
        }
      });
    } else if (
      transition.incident.type === LiveIncidentType.SECOND_HALF_KICK_OFF
    ) {
      if (transition.bettingStatus !== "OPEN") {
        fail("betting must reopen at second-half kick-off");
      }
      MARKET_TYPES.forEach((type) => {
        const market = current.get(type);
        const expected = type === LiveMarketType.HALF_TIME_RESULT
          ? LiveMarketStatus.SETTLED
          : (
              (nextMarketCounts.get(type as NextMarketType) ?? 0)
                >= timeline.config.caps[NEXT_MARKET_CAPS[type as NextMarketType]]
            )
            ? LiveMarketStatus.CLOSED
            : LiveMarketStatus.OPEN;
        if (market?.status !== expected) {
          fail(`invalid second-half market status ${type}`);
        }
      });
    } else if (transition.incident.type === LiveIncidentType.FULL_TIME) {
      if (
        transition.bettingStatus !== "CLOSED"
        || transition.markets.some(
          (market) =>
            market.status !== LiveMarketStatus.SETTLED
            && market.status !== LiveMarketStatus.CLOSED
        )
      ) {
        fail("markets must be settled or closed and betting closed at full-time");
      }
      MARKET_TYPES.forEach((type) => {
        const market = current.get(type);
        const expected = type === LiveMarketType.HALF_TIME_RESULT
          ? LiveMarketStatus.SETTLED
          : (
              (nextMarketCounts.get(type as NextMarketType) ?? 0)
                >= timeline.config.caps[NEXT_MARKET_CAPS[type as NextMarketType]]
            )
            ? LiveMarketStatus.CLOSED
            : LiveMarketStatus.SETTLED;
        if (market?.status !== expected) {
          fail(`invalid full-time market status ${type}`);
        }
      });
    } else {
      if (transition.bettingStatus !== "OPEN") {
        fail(`betting unexpectedly closed at sequence ${transition.sequence}`);
      }
      const firstHalf =
        transition.phase === EventPhase.FIRST_HALF
        || transition.phase === EventPhase.FIRST_HALF_STOPPAGE;
      MARKET_TYPES.forEach((type) => {
        const expected =
          type === LiveMarketType.HALF_TIME_RESULT
            ? firstHalf
              ? LiveMarketStatus.OPEN
              : LiveMarketStatus.SETTLED
            : (
                (nextMarketCounts.get(type as NextMarketType) ?? 0)
                  >= timeline.config.caps[NEXT_MARKET_CAPS[type as NextMarketType]]
              )
              ? LiveMarketStatus.CLOSED
              : LiveMarketStatus.OPEN;
        if (current.get(type)?.status !== expected) {
          fail(`invalid open-play market status ${type}`);
        }
      });
    }
  });

  const expectedFullTimeNone = NEXT_MARKET_TYPES.filter(
    (type) =>
      (nextMarketCounts.get(type) ?? 0) < timeline.config.caps[NEXT_MARKET_CAPS[type]]
  ).length;
  if (fullTimeNone !== expectedFullTimeNone) {
    fail(`expected ${expectedFullTimeNone} full-time none settlements`);
  }
  if (halfTimeSettlements !== 1) {
    fail("expected one half-time settlement");
  }
  const halfTime = transitions.find(
    (transition) => transition.incident.type === LiveIncidentType.HALF_TIME
  );
  const halfTimeSettlement = halfTime?.settlements.find(
    (settlement) =>
      settlement.settlementReason === LiveSettlementReason.HALF_TIME
  );
  const expectedHalfTimeWinner =
    (halfTime?.homeScore ?? 0) === (halfTime?.awayScore ?? 0)
      ? TeamSide.DRAW
      : (halfTime?.homeScore ?? 0) > (halfTime?.awayScore ?? 0)
        ? TeamSide.HOME
        : TeamSide.AWAY;
  if (halfTimeSettlement?.winningSide !== expectedHalfTimeWinner) {
    fail("half-time settlement does not match the score");
  }
}

/**
 * Validates the two pre-kickoff live-slip markets' dedicated lifecycle,
 * independent of the generic `MARKET_TYPES` in-match checks above:
 * kickoff-team and first-minute-goal must both be created at the kick-off
 * transition (marketVersion 1), close atomically there (kickoff-team goes
 * straight to SETTLED, first-minute-goal to CLOSED), stay pinned at
 * marketVersion 1 for their entire lifecycle, and first-minute-goal must
 * settle exactly once -- at the FIRST_MINUTE_ELAPSED transition -- with a
 * winning side that matches whether any goal fell strictly before that
 * transition's offset (the first simulated minute, [0:00, 1:00)).
 */
function assertPreKickoffMarkets(
  transitions: SimulationTransition[]
): void {
  const kickOff = transitions[0];
  if (!kickOff || kickOff.incident.type !== LiveIncidentType.KICK_OFF) {
    fail("first transition must be kick-off");
  }

  const firstMinuteElapsed = transitions.find(
    (transition) => transition.incident.type === LiveIncidentType.FIRST_MINUTE_ELAPSED
  );
  if (!firstMinuteElapsed) {
    fail("missing first-minute-elapsed transition");
  }
  if (firstMinuteElapsed.sequence <= kickOff.sequence) {
    fail("first-minute-elapsed must occur after kick-off");
  }

  const kickOffMarket = kickOff.markets.find(
    (market) => market.marketType === LiveMarketType.KICKOFF_TEAM
  );
  const firstMinuteMarketAtKickOff = kickOff.markets.find(
    (market) => market.marketType === LiveMarketType.FIRST_MINUTE_GOAL
  );
  if (
    !kickOffMarket
    || kickOffMarket.marketVersion !== 1
    || kickOffMarket.status !== LiveMarketStatus.SETTLED
    || !firstMinuteMarketAtKickOff
    || firstMinuteMarketAtKickOff.marketVersion !== 1
    || firstMinuteMarketAtKickOff.status !== LiveMarketStatus.CLOSED
  ) {
    fail("kickoff-team and first-minute-goal must close atomically at kick-off");
  }

  const kickOffSettlements = transitions.flatMap((transition) =>
    transition.settlements.filter(
      (settlement) => settlement.settlementReason === LiveSettlementReason.KICK_OFF
    )
  );
  if (
    kickOffSettlements.length !== 1
    || kickOffSettlements[0].marketId !== kickOffMarket.marketId
    || kickOffSettlements[0].marketVersion !== 1
    || kickOffSettlements[0].settlementSequence !== kickOff.sequence
    || kickOffSettlements[0].winningSide !== kickOff.incident.side
  ) {
    fail("kickoff-team must settle exactly once at kick-off, matching the kick-off incident's side");
  }

  let firstMinuteGoalScored = false;
  transitions.forEach((transition) => {
    if (
      transition.incident.type === LiveIncidentType.GOAL
      && transition.offsetMs < firstMinuteElapsed.offsetMs
    ) {
      firstMinuteGoalScored = true;
    }
  });

  transitions.forEach((transition) => {
    const kickoffTeam = transition.markets.find(
      (market) => market.marketType === LiveMarketType.KICKOFF_TEAM
    );
    const firstMinuteGoal = transition.markets.find(
      (market) => market.marketType === LiveMarketType.FIRST_MINUTE_GOAL
    );
    if (
      !kickoffTeam
      || kickoffTeam.marketVersion !== 1
      || kickoffTeam.status !== LiveMarketStatus.SETTLED
    ) {
      fail(`kickoff-team market must stay settled at sequence ${transition.sequence}`);
    }
    if (!firstMinuteGoal || firstMinuteGoal.marketVersion !== 1) {
      fail(`first-minute-goal market missing or re-versioned at sequence ${transition.sequence}`);
    }
    const expectedStatus =
      transition.sequence < firstMinuteElapsed.sequence
        ? LiveMarketStatus.CLOSED
        : LiveMarketStatus.SETTLED;
    if (firstMinuteGoal.status !== expectedStatus) {
      fail(`first-minute-goal market has unexpected status at sequence ${transition.sequence}`);
    }
  });

  const firstMinuteSettlements = transitions.flatMap((transition) =>
    transition.settlements.filter(
      (settlement) => settlement.settlementReason === LiveSettlementReason.FIRST_MINUTE_GOAL
    )
  );
  const expectedWinner = firstMinuteGoalScored ? TeamSide.YES : TeamSide.NO;
  if (
    firstMinuteSettlements.length !== 1
    || firstMinuteSettlements[0].marketId !== firstMinuteMarketAtKickOff.marketId
    || firstMinuteSettlements[0].marketVersion !== 1
    || firstMinuteSettlements[0].settlementSequence !== firstMinuteElapsed.sequence
    || firstMinuteSettlements[0].winningSide !== expectedWinner
  ) {
    fail("first-minute-goal must settle exactly once, matching the goal-in-window computation");
  }
}

export function assertSimulationInvariants(result: SimulationResult): void {
  const { timeline, transitions } = result;
  if (timeline.engineVersion !== 1 || result.engineVersion !== 1) {
    fail("unsupported engine version");
  }
  if (timeline.entries.length !== transitions.length || transitions.length === 0) {
    fail("timeline and transition counts differ");
  }

  const halfDuration = timeline.durationMs / 2;
  const kickOff = only(transitions, LiveIncidentType.KICK_OFF);
  const halfTime = only(transitions, LiveIncidentType.HALF_TIME);
  const secondKickOff = only(transitions, LiveIncidentType.SECOND_HALF_KICK_OFF);
  const fullTime = only(transitions, LiveIncidentType.FULL_TIME);
  const addedTimeAnnouncements = transitions.filter(
    (transition) =>
      transition.incident.type === LiveIncidentType.ADDED_TIME_ANNOUNCED
  );
  if (
    timeline.durationMs % 2 !== 0
    || kickOff.offsetMs !== 0
    || halfTime.offsetMs !== halfDuration
    || secondKickOff.offsetMs !== halfDuration
    || fullTime.offsetMs !== timeline.durationMs
    || halfTime.sequence + 1 !== secondKickOff.sequence
  ) {
    fail("structural anchors or tie ordering are invalid");
  }
  if (
    addedTimeAnnouncements.length !== 2
    || addedTimeAnnouncements[0].phase !== EventPhase.FIRST_HALF_STOPPAGE
    || addedTimeAnnouncements[1].phase !== EventPhase.SECOND_HALF_STOPPAGE
  ) {
    fail("added-time announcements are invalid");
  }

  let homeScore = 0;
  let awayScore = 0;
  let lastMinute = 0;
  transitions.forEach((transition, index) => {
    if (
      transition.sequence !== index + 1
      || transition.offsetMs < (transitions[index - 1]?.offsetMs ?? 0)
      || timeline.entries[index]?.incident.id !== transition.incident.id
    ) {
      fail(`transition ordering mismatch at sequence ${transition.sequence}`);
    }
    assertClock(transition, timeline);
    if (transition.minute < lastMinute) {
      fail(`minute regressed at sequence ${transition.sequence}`);
    }
    lastMinute = transition.minute;
    if (!STRUCTURAL_TYPES.has(transition.incident.type) && (
      transition.offsetMs === 0
      || transition.offsetMs === halfDuration
      || transition.offsetMs === timeline.durationMs
    )) {
      fail(`boundary incident at sequence ${transition.sequence}`);
    }
    if (transition.incident.type === LiveIncidentType.GOAL) {
      if (transition.incident.side === "HOME") {
        homeScore += 1;
      } else if (transition.incident.side === "AWAY") {
        awayScore += 1;
      } else {
        fail(`goal without a side at sequence ${transition.sequence}`);
      }
    }
    if (
      transition.homeScore !== homeScore
      || transition.awayScore !== awayScore
      || transition.scores.home !== homeScore
      || transition.scores.away !== awayScore
    ) {
      fail(`score mismatch at sequence ${transition.sequence}`);
    }
  });

  if (
    result.finalScore.home !== homeScore
    || result.finalScore.away !== awayScore
    || fullTime.homeScore !== homeScore
    || fullTime.awayScore !== awayScore
  ) {
    fail("final score is not goal-derived");
  }

  const phasePosition: Record<EventPhase, number> = {
    PRE_MATCH: 0,
    FIRST_HALF: 1,
    FIRST_HALF_STOPPAGE: 2,
    HALF_TIME: 3,
    SECOND_HALF: 4,
    SECOND_HALF_STOPPAGE: 5,
    FULL_TIME: 6,
  };
  let lastPhase = 0;
  transitions.forEach((transition) => {
    const position = phasePosition[transition.phase];
    if (position < lastPhase) {
      fail(`phase regressed at sequence ${transition.sequence}`);
    }
    lastPhase = position;
  });

  assertPenalties(transitions);
  assertMarkets(timeline, transitions);
  assertPreKickoffMarkets(transitions);

  const counts = {
    goals: transitions.filter((t) => t.incident.type === LiveIncidentType.GOAL).length,
    yellows: transitions.filter((t) => t.incident.type === LiveIncidentType.YELLOW_CARD).length,
    reds: transitions.filter((t) => t.incident.type === LiveIncidentType.RED_CARD).length,
    corners: transitions.filter((t) => t.incident.type === LiveIncidentType.CORNER).length,
    penaltyAwards: transitions.filter((t) => t.incident.type === LiveIncidentType.PENALTY_AWARDED).length,
    freeKicks: transitions.filter((t) => t.incident.type === LiveIncidentType.FREE_KICK).length,
  };
  (Object.keys(counts) as Array<keyof typeof counts>).forEach((key) => {
    if (counts[key] > timeline.config.caps[key]) {
      fail(`cap exceeded for ${key}`);
    }
  });
}
