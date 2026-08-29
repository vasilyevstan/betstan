import {
  EventPhase,
  LiveIncidentType,
  LiveMarketStatus,
  LiveMarketType,
  LiveSettlementReason,
  buildPreKickoffMarkets,
  projectTransitions,
  resolveSimulationConfig,
  SimTimeline,
  SimTimelineEntry,
} from "..";

const EVENT_ID = "pre-kickoff-event";
const DURATION = 60000;
// Matches how `timeline.ts` places the FIRST_MINUTE_ELAPSED marker in a real
// simulation: the offset marking the end of simulated minute 1.
const FIRST_MINUTE_CUTOFF_MS = 6667;

function entry(
  order: number,
  offsetMs: number,
  type: LiveIncidentType,
  phase: EventPhase,
  minute: number,
  side?: "HOME" | "AWAY"
): SimTimelineEntry {
  return {
    order,
    offsetMs,
    phase,
    minute,
    incident: {
      id: `${type}-${order}`,
      type,
      side,
    },
  };
}

/**
 * Builds a minimal, well-formed timeline with a kickoff (given side), an
 * optional goal at `goalOffsetMs` (attributed to `goalSide`), the
 * FIRST_MINUTE_ELAPSED marker, and a full match shell through full-time --
 * everything `projectTransitions` needs to run the complete pre-kickoff
 * market lifecycle deterministically, without depending on RNG/seed search.
 */
function preKickoffTimeline(
  kickoffSide: "HOME" | "AWAY",
  goal?: { offsetMs: number; side: "HOME" | "AWAY" }
): SimTimeline {
  const entries: SimTimelineEntry[] = [
    entry(0, 0, LiveIncidentType.KICK_OFF, EventPhase.FIRST_HALF, 0, kickoffSide),
    entry(
      1,
      FIRST_MINUTE_CUTOFF_MS,
      LiveIncidentType.FIRST_MINUTE_ELAPSED,
      EventPhase.FIRST_HALF,
      1
    ),
    entry(2, 30000, LiveIncidentType.HALF_TIME, EventPhase.HALF_TIME, 45),
    entry(
      3,
      30000,
      LiveIncidentType.SECOND_HALF_KICK_OFF,
      EventPhase.SECOND_HALF,
      46
    ),
    entry(4, DURATION, LiveIncidentType.FULL_TIME, EventPhase.FULL_TIME, 90),
  ];

  if (goal) {
    entries.push(
      entry(5, goal.offsetMs, LiveIncidentType.GOAL, EventPhase.FIRST_HALF, 1, goal.side)
    );
  }

  return {
    engineVersion: 1,
    eventId: EVENT_ID,
    seed: "manual",
    durationMs: DURATION,
    stoppage: { first: 1, second: 2 },
    config: resolveSimulationConfig({ durationMs: DURATION }),
    entries,
  };
}

const marketAt = (
  transitions: ReturnType<typeof projectTransitions>,
  incidentType: LiveIncidentType,
  marketType: LiveMarketType
) =>
  transitions
    .find((transition) => transition.incident.type === incidentType)
    ?.markets.find((market) => market.marketType === marketType);

const settlementAt = (
  transitions: ReturnType<typeof projectTransitions>,
  incidentType: LiveIncidentType,
  marketType: LiveMarketType
) =>
  transitions
    .find((transition) => transition.incident.type === incidentType)
    ?.settlements.find(
      (settlement) => settlement.marketId === `${EVENT_ID}:${marketType}`
    );

describe("pre-kickoff live markets", () => {
  it("publishes the standalone pre-kickoff snapshot as two OPEN markets pinned at version 1", () => {
    const timeline = preKickoffTimeline("HOME");
    const snapshot = buildPreKickoffMarkets(timeline);

    expect(snapshot).toHaveLength(2);
    expect(snapshot.map((market) => market.marketType).sort()).toEqual(
      [LiveMarketType.FIRST_MINUTE_GOAL, LiveMarketType.KICKOFF_TEAM].sort()
    );

    for (const market of snapshot) {
      expect(market.marketVersion).toBe(1);
      expect(market.quoteVersion).toBe(1);
      expect(market.status).toBe(LiveMarketStatus.OPEN);
      expect(market.marketId).toBe(`${EVENT_ID}:${market.marketType}`);
    }

    const kickoffTeam = snapshot.find(
      (market) => market.marketType === LiveMarketType.KICKOFF_TEAM
    )!;
    expect(kickoffTeam.selections.map((selection) => selection.side).sort()).toEqual(
      ["AWAY", "HOME"]
    );
    expect(
      kickoffTeam.selections.every(
        (selection) => selection.selectionId === `${kickoffTeam.marketId}:1:${selection.side}`
      )
    ).toBe(true);

    const firstMinuteGoal = snapshot.find(
      (market) => market.marketType === LiveMarketType.FIRST_MINUTE_GOAL
    )!;
    expect(firstMinuteGoal.selections.map((selection) => selection.side).sort()).toEqual(
      ["NO", "YES"]
    );
  });

  it("closes both pre-kickoff markets atomically at kickoff and settles kickoff team immediately", () => {
    const transitions = projectTransitions(preKickoffTimeline("HOME"));
    const kickoffTeam = marketAt(transitions, LiveIncidentType.KICK_OFF, LiveMarketType.KICKOFF_TEAM)!;
    const firstMinuteGoal = marketAt(transitions, LiveIncidentType.KICK_OFF, LiveMarketType.FIRST_MINUTE_GOAL)!;

    // Both markets leave OPEN status in the very same (kickoff) transition:
    // neither is ever observably OPEN in the published transition list.
    expect(kickoffTeam.status).toBe(LiveMarketStatus.SETTLED);
    expect(kickoffTeam.marketVersion).toBe(1);
    expect(firstMinuteGoal.status).toBe(LiveMarketStatus.CLOSED);
    expect(firstMinuteGoal.marketVersion).toBe(1);

    const kickoffSettlement = settlementAt(
      transitions,
      LiveIncidentType.KICK_OFF,
      LiveMarketType.KICKOFF_TEAM
    )!;
    expect(kickoffSettlement).toMatchObject({
      marketVersion: 1,
      settlementReason: LiveSettlementReason.KICK_OFF,
      winningSide: "HOME",
      winningSelection: `${EVENT_ID}:${LiveMarketType.KICKOFF_TEAM}:1:HOME`,
    });

    // First-minute-goal is not settled yet at kickoff.
    expect(
      settlementAt(transitions, LiveIncidentType.KICK_OFF, LiveMarketType.FIRST_MINUTE_GOAL)
    ).toBeUndefined();
  });

  it.each([
    ["HOME" as const],
    ["AWAY" as const],
  ])("settles the kickoff team market to %s exactly once", (side) => {
    const transitions = projectTransitions(preKickoffTimeline(side));
    const settlements = transitions.flatMap((transition) => transition.settlements)
      .filter((settlement) => settlement.marketId === `${EVENT_ID}:${LiveMarketType.KICKOFF_TEAM}`);

    expect(settlements).toHaveLength(1);
    expect(settlements[0]).toMatchObject({
      winningSide: side,
      settlementReason: LiveSettlementReason.KICK_OFF,
    });
  });

  it("settles first-minute-goal YES exactly once when a goal occurs strictly inside the first simulated minute", () => {
    const transitions = projectTransitions(
      preKickoffTimeline("HOME", { offsetMs: FIRST_MINUTE_CUTOFF_MS - 1, side: "AWAY" })
    );

    const firstMinuteGoalAfterElapsed = marketAt(
      transitions,
      LiveIncidentType.FIRST_MINUTE_ELAPSED,
      LiveMarketType.FIRST_MINUTE_GOAL
    )!;
    expect(firstMinuteGoalAfterElapsed.status).toBe(LiveMarketStatus.SETTLED);
    expect(firstMinuteGoalAfterElapsed.marketVersion).toBe(1);

    const settlements = transitions.flatMap((transition) => transition.settlements)
      .filter((settlement) => settlement.marketId === `${EVENT_ID}:${LiveMarketType.FIRST_MINUTE_GOAL}`);
    expect(settlements).toHaveLength(1);
    expect(settlements[0]).toMatchObject({
      winningSide: "YES",
      settlementReason: LiveSettlementReason.FIRST_MINUTE_GOAL,
      winningSelection: `${EVENT_ID}:${LiveMarketType.FIRST_MINUTE_GOAL}:1:YES`,
    });
  });

  it("settles first-minute-goal NO exactly once when no goal occurs inside the first simulated minute", () => {
    const transitions = projectTransitions(preKickoffTimeline("AWAY"));

    const firstMinuteGoalAfterElapsed = marketAt(
      transitions,
      LiveIncidentType.FIRST_MINUTE_ELAPSED,
      LiveMarketType.FIRST_MINUTE_GOAL
    )!;
    expect(firstMinuteGoalAfterElapsed.status).toBe(LiveMarketStatus.SETTLED);

    const settlements = transitions.flatMap((transition) => transition.settlements)
      .filter((settlement) => settlement.marketId === `${EVENT_ID}:${LiveMarketType.FIRST_MINUTE_GOAL}`);
    expect(settlements).toHaveLength(1);
    expect(settlements[0]).toMatchObject({
      winningSide: "NO",
      settlementReason: LiveSettlementReason.FIRST_MINUTE_GOAL,
    });
  });

  it("excludes a goal landing exactly on the first-minute boundary (half-open interval [0:00, 1:00))", () => {
    const transitions = projectTransitions(
      preKickoffTimeline("HOME", { offsetMs: FIRST_MINUTE_CUTOFF_MS, side: "HOME" })
    );

    const settlement = settlementAt(
      transitions,
      LiveIncidentType.FIRST_MINUTE_ELAPSED,
      LiveMarketType.FIRST_MINUTE_GOAL
    )!;
    expect(settlement.winningSide).toBe("NO");
  });

  it("settles first-minute-goal only once even if a later goal occurs after the market is already settled", () => {
    // A goal well after minute 1 (e.g. in added time before half-time) must
    // not cause a second first-minute-goal settlement or reopen it.
    const transitions = projectTransitions(
      preKickoffTimeline("HOME", { offsetMs: 20000, side: "HOME" })
    );

    const settlements = transitions.flatMap((transition) => transition.settlements)
      .filter((settlement) => settlement.marketId === `${EVENT_ID}:${LiveMarketType.FIRST_MINUTE_GOAL}`);
    expect(settlements).toHaveLength(1);
    expect(settlements[0].winningSide).toBe("NO");

    const goalTransition = transitions.find(
      (transition) => transition.incident.type === LiveIncidentType.GOAL
    )!;
    const marketDuringLaterGoal = goalTransition.markets.find(
      (market) => market.marketType === LiveMarketType.FIRST_MINUTE_GOAL
    )!;
    expect(marketDuringLaterGoal.status).toBe(LiveMarketStatus.SETTLED);
    expect(marketDuringLaterGoal.marketVersion).toBe(1);
  });

  it("keeps the pre-kickoff snapshot's selection identities matching the eventual settlement identity", () => {
    const timeline = preKickoffTimeline("AWAY");
    const snapshot = buildPreKickoffMarkets(timeline);
    const transitions = projectTransitions(timeline);
    const kickoffSettlement = settlementAt(
      transitions,
      LiveIncidentType.KICK_OFF,
      LiveMarketType.KICKOFF_TEAM
    )!;

    const preKickoffKickoffTeam = snapshot.find(
      (market) => market.marketType === LiveMarketType.KICKOFF_TEAM
    )!;
    const preKickoffWinningSelection = preKickoffKickoffTeam.selections.find(
      (selection) => selection.side === "AWAY"
    )!;

    expect(kickoffSettlement.marketId).toBe(preKickoffKickoffTeam.marketId);
    expect(kickoffSettlement.marketVersion).toBe(preKickoffKickoffTeam.marketVersion);
    expect(kickoffSettlement.winningSelection).toBe(preKickoffWinningSelection.selectionId);
  });
});
