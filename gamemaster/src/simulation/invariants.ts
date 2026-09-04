import {
  BettingStatus,
  ENGINE_VERSION,
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

const PRE_KICKOFF_MARKET_TYPES: LiveMarketType[] = [
  LiveMarketType.KICKOFF_TEAM,
  LiveMarketType.FIRST_MINUTE_GOAL,
];

const STRUCTURAL_TYPES = new Set<LiveIncidentType>([
  LiveIncidentType.KICK_OFF,
  LiveIncidentType.ADDED_TIME_ANNOUNCED,
  LiveIncidentType.HALF_TIME,
  LiveIncidentType.SECOND_HALF_KICK_OFF,
  LiveIncidentType.FULL_TIME,
]);

function fail(message: string): never {
  throw new Error(`simulation invariant: ${message}`);
}

function only(
  transitions: SimulationTransition[],
  type: LiveIncidentType
): SimulationTransition {
  const found = transitions.filter(
    (transition) => transition.incident.type === type
  );
  if (found.length !== 1) {
    return fail(`expected one ${type}`);
  }
  return found[0];
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
    case LiveIncidentType.THROW_IN:
      return LiveMarketType.NEXT_THROW_IN;
    case LiveIncidentType.FREE_KICK:
      return LiveMarketType.NEXT_FREE_KICK;
    case LiveIncidentType.GOAL_KICK:
      return LiveMarketType.NEXT_GOAL_KICK;
    default:
      return undefined;
  }
}

function isActionable(status: LiveMarketStatus): boolean {
  return status === LiveMarketStatus.OPEN
    || status === LiveMarketStatus.SUSPENDED;
}

function sameOdds(
  left: SimulationTransition["markets"][number],
  right: SimulationTransition["markets"][number]
): boolean {
  return left.selections.length === right.selections.length
    && left.selections.every(
      (selection, index) => selection.odds === right.selections[index]?.odds
    );
}

function expectedSelectionCount(marketType: LiveMarketType): number {
  if (marketType === LiveMarketType.SECOND_HALF_SCORE) {
    return 10;
  }
  if (PRE_KICKOFF_MARKET_TYPES.includes(marketType)) {
    return 2;
  }
  return 3;
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
    fail("invalid half-time minute");
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
    && (addedTime === undefined || !stoppagePhase)
  ) {
    fail("added-time announcement outside stoppage");
  }
}

function assertPenalties(transitions: SimulationTransition[]): void {
  const awards = transitions.filter(
    (transition) => transition.incident.type === LiveIncidentType.PENALTY_AWARDED
  );
  const outcomes = transitions.filter(
    (transition) =>
      transition.incident.type === LiveIncidentType.PENALTY_SCORED
      || transition.incident.type === LiveIncidentType.PENALTY_MISSED
  );
  if (outcomes.length !== awards.length) {
    fail("penalty outcomes do not match awards");
  }

  awards.forEach((award) => {
    const matching = outcomes.filter(
      (outcome) => outcome.incident.penaltyId === award.incident.penaltyId
    );
    if (
      !award.incident.penaltyId
      || !award.incident.side
      || matching.length !== 1
      || matching[0].offsetMs <= award.offsetMs
      || matching[0].incident.linkedIncidentId !== award.incident.id
      || matching[0].incident.side !== award.incident.side
    ) {
      fail(`penalty linkage is invalid at sequence ${award.sequence}`);
    }

    const linkedGoals = transitions.filter(
      (transition) =>
        transition.incident.type === LiveIncidentType.GOAL
        && transition.incident.penaltyId === award.incident.penaltyId
    );
    if (matching[0].incident.type === LiveIncidentType.PENALTY_SCORED) {
      if (
        linkedGoals.length !== 1
        || linkedGoals[0].offsetMs !== matching[0].offsetMs
        || linkedGoals[0].incident.linkedIncidentId !== matching[0].incident.id
      ) {
        fail(`scored penalty linkage is invalid at sequence ${award.sequence}`);
      }
    } else if (linkedGoals.length !== 0) {
      fail(`missed penalty has a linked goal at sequence ${award.sequence}`);
    }
  });
}

function assertMarketLifecycle(
  timeline: SimTimeline,
  transitions: SimulationTransition[]
): void {
  const previousMarkets = new Map<
    LiveMarketType,
    SimulationTransition["markets"][number]
  >();
  const observedSelections = new Map<string, Set<string>>();
  const settledVersions = new Set<string>();
  let halfTimeSettlementCount = 0;
  let secondHalfScoreSettlementCount = 0;

  transitions.forEach((transition) => {
    const marketTypes = transition.markets.map((market) => market.marketType);
    if (new Set(marketTypes).size !== marketTypes.length) {
      fail(`duplicate market type at sequence ${transition.sequence}`);
    }

    const actionable = transition.markets.filter((market) =>
      isActionable(market.status)
    );
    if (actionable.length > 6) {
      fail(`more than six actionable markets at sequence ${transition.sequence}`);
    }
    if (
      transition.incident.type === LiveIncidentType.KICK_OFF
      && actionable.length !== 6
    ) {
      fail("kick-off must expose exactly six actionable markets");
    }

    const settlementsAtSequence = new Set(
      transition.settlements.map(
        (settlement) => `${settlement.marketId}:${settlement.marketVersion}`
      )
    );

    transition.markets.forEach((market) => {
      if (market.marketId !== `${timeline.eventId}:${market.marketType}`) {
        fail(`invalid market identity at sequence ${transition.sequence}`);
      }
      if (market.marketVersion < 1 || market.quoteVersion < 1) {
        fail(`invalid market version at sequence ${transition.sequence}`);
      }

      const selectionCount = expectedSelectionCount(market.marketType);
      const selectionIds = market.selections.map(
        (selection) => selection.selectionId
      );
      if (
        selectionIds.length !== selectionCount
        || new Set(selectionIds).size !== selectionCount
      ) {
        fail(`invalid selections at sequence ${transition.sequence}`);
      }
      market.selections.forEach((selection) => {
        if (
          !selection.selectionId.startsWith(
            `${market.marketId}:${market.marketVersion}:`
          )
          || !Number.isFinite(selection.odds)
          || selection.odds < timeline.config.minOdds
          || selection.odds > timeline.config.maxOdds
        ) {
          fail(`invalid selection at sequence ${transition.sequence}`);
        }
        if (
          market.marketType === LiveMarketType.SECOND_HALF_SCORE
          && !selection.label
        ) {
          fail("second-half score selection is missing a label");
        }
      });

      const versionIdentity = `${market.marketId}:${market.marketVersion}`;
      observedSelections.set(versionIdentity, new Set(selectionIds));

      const previous = previousMarkets.get(market.marketType);
      if (previous) {
        if (market.marketVersion === previous.marketVersion) {
          const oddsChanged = !sameOdds(market, previous);
          if (
            market.quoteVersion
            !== previous.quoteVersion + (oddsChanged ? 1 : 0)
          ) {
            fail(`invalid quote version for ${market.marketType}`);
          }
        } else if (
          market.marketVersion !== previous.marketVersion + 1
          || market.quoteVersion !== 1
          || !(
            settledVersions.has(
              `${previous.marketId}:${previous.marketVersion}`
            )
            || settlementsAtSequence.has(
              `${previous.marketId}:${previous.marketVersion}`
            )
          )
        ) {
          fail(`market version reused without prior settlement ${market.marketType}`);
        }
      }
      previousMarkets.set(market.marketType, market);
    });

    transition.settlements.forEach((settlement) => {
      const identity = `${settlement.marketId}:${settlement.marketVersion}`;
      if (settledVersions.has(identity)) {
        fail(`duplicate settlement ${identity}`);
      }
      if (settlement.settlementSequence !== transition.sequence) {
        fail(`settlement sequence mismatch ${identity}`);
      }
      if (
        settlement.winningSelection
        && !observedSelections.get(identity)?.has(settlement.winningSelection)
      ) {
        fail(`winning selection was never authoritative ${identity}`);
      }
      if (settlement.settlementReason === LiveSettlementReason.INCIDENT) {
        const expectedType = nextMarketForIncident(transition.incident.type);
        if (!expectedType || settlement.marketId !== `${timeline.eventId}:${expectedType}`) {
          fail(`incident settled the wrong market ${identity}`);
        }
      }
      if (settlement.settlementReason === LiveSettlementReason.FULL_TIME_NONE) {
        if (settlement.winningSide !== TeamSide.NONE) {
          fail(`full-time none settlement has a team winner ${identity}`);
        }
      }
      if (settlement.settlementReason === LiveSettlementReason.HALF_TIME) {
        halfTimeSettlementCount += 1;
      }
      if (
        settlement.settlementReason
        === LiveSettlementReason.SECOND_HALF_SCORE
      ) {
        secondHalfScoreSettlementCount += 1;
      }
      settledVersions.add(identity);
    });

    const byType = new Map(
      transition.markets.map((market) => [market.marketType, market])
    );
    if (transition.incident.type === LiveIncidentType.HALF_TIME) {
      if (
        transition.bettingStatus !== BettingStatus.SUSPENDED
        || byType.get(LiveMarketType.HALF_TIME_RESULT)?.status
          !== LiveMarketStatus.SETTLED
        || byType.get(LiveMarketType.SECOND_HALF_SCORE)?.status
          !== LiveMarketStatus.SUSPENDED
        || actionable.some(
          (market) => market.status !== LiveMarketStatus.SUSPENDED
        )
      ) {
        fail("half-time market suspension is invalid");
      }
    } else if (
      transition.incident.type === LiveIncidentType.SECOND_HALF_KICK_OFF
    ) {
      if (
        transition.bettingStatus !== BettingStatus.OPEN
        || byType.get(LiveMarketType.SECOND_HALF_SCORE)?.status
          !== LiveMarketStatus.CLOSED
        || actionable.some((market) => market.status !== LiveMarketStatus.OPEN)
      ) {
        fail("second-half market reopening is invalid");
      }
    } else if (transition.incident.type === LiveIncidentType.FULL_TIME) {
      if (
        transition.bettingStatus !== BettingStatus.CLOSED
        || actionable.length !== 0
        || byType.get(LiveMarketType.SECOND_HALF_SCORE)?.status
          !== LiveMarketStatus.SETTLED
      ) {
        fail("full-time market closure is invalid");
      }
    } else if (transition.bettingStatus !== BettingStatus.OPEN) {
      fail(`betting unexpectedly suspended at sequence ${transition.sequence}`);
    }
  });

  if (halfTimeSettlementCount !== 1) {
    fail("expected one half-time settlement");
  }
  if (secondHalfScoreSettlementCount !== 1) {
    fail("expected one second-half score settlement");
  }

  const halfTime = only(transitions, LiveIncidentType.HALF_TIME);
  const fullTime = only(transitions, LiveIncidentType.FULL_TIME);
  const expectedHalfTimeWinner = halfTime.homeScore === halfTime.awayScore
    ? TeamSide.DRAW
    : halfTime.homeScore > halfTime.awayScore
      ? TeamSide.HOME
      : TeamSide.AWAY;
  const halfTimeSettlement = halfTime.settlements.find(
    (settlement) => settlement.settlementReason === LiveSettlementReason.HALF_TIME
  );
  if (halfTimeSettlement?.winningSide !== expectedHalfTimeWinner) {
    fail("half-time settlement does not match the score");
  }

  const secondHalfHome = fullTime.homeScore - halfTime.homeScore;
  const secondHalfAway = fullTime.awayScore - halfTime.awayScore;
  const exactKey = `SCORE_${secondHalfHome}_${secondHalfAway}`;
  const expectedKey = secondHalfHome <= 2 && secondHalfAway <= 2
    ? exactKey
    : "OTHER";
  const secondHalfSettlement = fullTime.settlements.find(
    (settlement) =>
      settlement.settlementReason === LiveSettlementReason.SECOND_HALF_SCORE
  );
  if (
    secondHalfSettlement?.winningSelection
    !== `${timeline.eventId}:${LiveMarketType.SECOND_HALF_SCORE}:1:${expectedKey}`
  ) {
    fail("second-half score settlement does not match second-half goals");
  }
}

function assertPreKickoffMarkets(
  transitions: SimulationTransition[]
): void {
  const kickOff = transitions[0];
  if (!kickOff || kickOff.incident.type !== LiveIncidentType.KICK_OFF) {
    fail("first transition must be kick-off");
  }
  const firstMinuteElapsed = only(
    transitions,
    LiveIncidentType.FIRST_MINUTE_ELAPSED
  );
  const kickOffMarket = kickOff.markets.find(
    (market) => market.marketType === LiveMarketType.KICKOFF_TEAM
  );
  const firstMinuteMarket = kickOff.markets.find(
    (market) => market.marketType === LiveMarketType.FIRST_MINUTE_GOAL
  );
  if (
    kickOffMarket?.marketVersion !== 1
    || kickOffMarket.status !== LiveMarketStatus.SETTLED
    || firstMinuteMarket?.marketVersion !== 1
    || firstMinuteMarket.status !== LiveMarketStatus.CLOSED
  ) {
    fail("pre-kickoff markets do not close atomically at kick-off");
  }

  const kickoffSettlements = transitions.flatMap((transition) =>
    transition.settlements.filter(
      (settlement) => settlement.settlementReason === LiveSettlementReason.KICK_OFF
    )
  );
  if (
    kickoffSettlements.length !== 1
    || kickoffSettlements[0].winningSide !== kickOff.incident.side
  ) {
    fail("kickoff-team settlement is invalid");
  }

  const firstMinuteGoalScored = transitions.some(
    (transition) =>
      transition.incident.type === LiveIncidentType.GOAL
      && transition.offsetMs < firstMinuteElapsed.offsetMs
  );
  const firstMinuteSettlements = transitions.flatMap((transition) =>
    transition.settlements.filter(
      (settlement) =>
        settlement.settlementReason === LiveSettlementReason.FIRST_MINUTE_GOAL
    )
  );
  if (
    firstMinuteSettlements.length !== 1
    || firstMinuteSettlements[0].settlementSequence
      !== firstMinuteElapsed.sequence
    || firstMinuteSettlements[0].winningSide
      !== (firstMinuteGoalScored ? TeamSide.YES : TeamSide.NO)
  ) {
    fail("first-minute-goal settlement is invalid");
  }
}

export function assertSimulationInvariants(result: SimulationResult): void {
  const { timeline, transitions } = result;
  if (
    timeline.engineVersion !== ENGINE_VERSION
    || result.engineVersion !== ENGINE_VERSION
  ) {
    fail("unsupported engine version");
  }
  if (
    timeline.entries.length !== transitions.length
    || transitions.length === 0
  ) {
    fail("timeline and transition counts differ");
  }

  const halfDuration = timeline.durationMs / 2;
  const kickOff = only(transitions, LiveIncidentType.KICK_OFF);
  const halfTime = only(transitions, LiveIncidentType.HALF_TIME);
  const secondKickOff = only(
    transitions,
    LiveIncidentType.SECOND_HALF_KICK_OFF
  );
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
    if (
      !STRUCTURAL_TYPES.has(transition.incident.type)
      && (
        transition.offsetMs === 0
        || transition.offsetMs === halfDuration
        || transition.offsetMs === timeline.durationMs
      )
    ) {
      fail(`boundary incident at sequence ${transition.sequence}`);
    }
    if (transition.incident.type === LiveIncidentType.GOAL) {
      if (transition.incident.side === TeamSide.HOME) {
        homeScore += 1;
      } else if (transition.incident.side === TeamSide.AWAY) {
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
  assertMarketLifecycle(timeline, transitions);
  assertPreKickoffMarkets(transitions);

  const counts = {
    goals: transitions.filter(
      (transition) => transition.incident.type === LiveIncidentType.GOAL
    ).length,
    yellows: transitions.filter(
      (transition) => transition.incident.type === LiveIncidentType.YELLOW_CARD
    ).length,
    reds: transitions.filter(
      (transition) => transition.incident.type === LiveIncidentType.RED_CARD
    ).length,
    corners: transitions.filter(
      (transition) => transition.incident.type === LiveIncidentType.CORNER
    ).length,
    penaltyAwards: transitions.filter(
      (transition) =>
        transition.incident.type === LiveIncidentType.PENALTY_AWARDED
    ).length,
    freeKicks: transitions.filter(
      (transition) => transition.incident.type === LiveIncidentType.FREE_KICK
    ).length,
    throwIns: transitions.filter(
      (transition) => transition.incident.type === LiveIncidentType.THROW_IN
    ).length,
    goalKicks: transitions.filter(
      (transition) => transition.incident.type === LiveIncidentType.GOAL_KICK
    ).length,
  };
  (Object.keys(counts) as Array<keyof typeof counts>).forEach((key) => {
    if (counts[key] > timeline.config.caps[key]) {
      fail(`cap exceeded for ${key}`);
    }
  });
}
