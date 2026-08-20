import { createHash } from "crypto";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

import {
  assertSimulationInvariants,
  createNamedRng,
  EventPhase,
  getSimulationConfig,
  LiveIncidentType,
  LiveMarketStatus,
  LiveMarketType,
  LiveSettlementReason,
  normalizeProfile,
  projectTransitions,
  resolveSimulationConfig,
  samplePoisson,
  SimTimeline,
  SimTimelineEntry,
  simulateMatch,
} from "..";

const DURATION = 60000;

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function entry(
  order: number,
  offsetMs: number,
  type: LiveIncidentType,
  phase: EventPhase,
  minute: number,
  side?: "HOME" | "AWAY",
  penaltyId?: string,
  linkedIncidentId?: string
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
      penaltyId,
      linkedIncidentId,
    },
  };
}

function marketTimeline(homeGoal = false, awayGoal = false): SimTimeline {
  const entries = [
    entry(0, 0, LiveIncidentType.KICK_OFF, EventPhase.FIRST_HALF, 0),
    entry(1, 1000, LiveIncidentType.YELLOW_CARD, EventPhase.FIRST_HALF, 2, "HOME"),
    entry(2, 2000, LiveIncidentType.RED_CARD, EventPhase.FIRST_HALF, 3, "AWAY"),
    entry(3, 3000, LiveIncidentType.CORNER, EventPhase.FIRST_HALF, 5, "HOME"),
    entry(4, 4000, LiveIncidentType.PENALTY_AWARDED, EventPhase.FIRST_HALF, 6, "HOME", "p1"),
    entry(5, 4000, LiveIncidentType.PENALTY_SCORED, EventPhase.FIRST_HALF, 6, "HOME", "p1", "PENALTY_AWARDED-4"),
    entry(6, 4000, LiveIncidentType.GOAL, EventPhase.FIRST_HALF, 6, "HOME", "p1", "PENALTY_SCORED-5"),
    ...(homeGoal
      ? [entry(7, 30000, LiveIncidentType.GOAL, EventPhase.FIRST_HALF, 45, "HOME")]
      : []),
    ...(awayGoal
      ? [entry(8, 30000, LiveIncidentType.GOAL, EventPhase.FIRST_HALF, 45, "AWAY")]
      : []),
    entry(9, 30000, LiveIncidentType.HALF_TIME, EventPhase.HALF_TIME, 45),
    entry(10, 30000, LiveIncidentType.SECOND_HALF_KICK_OFF, EventPhase.SECOND_HALF, 46),
    entry(11, 40000, LiveIncidentType.YELLOW_CARD, EventPhase.SECOND_HALF, 60, "AWAY"),
    entry(12, DURATION, LiveIncidentType.FULL_TIME, EventPhase.FULL_TIME, 90),
  ];
  return {
    engineVersion: 1,
    eventId: "market-event",
    seed: "manual",
    durationMs: DURATION,
    stoppage: { first: 1, second: 2 },
    config: resolveSimulationConfig({ durationMs: DURATION }),
    entries,
  };
}

describe("simulation random sources", () => {
  it("uses deterministic independent SHA-256 streams and one-uniform Poisson draws", () => {
    const first = createNamedRng("seed", "goals");
    const second = createNamedRng("seed", "goals");
    const values = Array.from({ length: 30 }, () => first.uniform());
    expect(values).toEqual(Array.from({ length: 30 }, () => second.uniform()));
    expect(values.every((value) => value >= 0 && value < 1)).toBe(true);

    const untouched = createNamedRng("seed", "cards");
    const consumed = createNamedRng("seed", "goals");
    Array.from({ length: 50 }, () => consumed.uniform());
    expect(createNamedRng("seed", "cards").uniform()).toBe(untouched.uniform());
    expect(samplePoisson(1, 0)).toBe(0);
    expect(samplePoisson(1, 0.9)).toBe(2);
    expect(samplePoisson(0.1, 0.9999999999999999)).toBeGreaterThan(0);

    const poisson = createNamedRng("poisson", "sample");
    const mean = Array.from({ length: 4000 }, () => samplePoisson(2.5, poisson.uniform()))
      .reduce((total, value) => total + value, 0) / 4000;
    expect(mean).toBeGreaterThan(2.35);
    expect(mean).toBeLessThan(2.65);
  });
});

describe("simulation timeline", () => {
  it("is deterministic, versioned, and has a stable golden digest", () => {
    const first = simulateMatch({ eventId: "determinism", seed: "golden-7" });
    const second = simulateMatch({ eventId: "determinism", seed: "golden-7" });
    const different = simulateMatch({ eventId: "determinism", seed: "golden-8" });
    expect(first).toEqual(second);
    expect(first).not.toEqual(different);
    expect(first.engineVersion).toBe(1);
    expect(digest(first)).toBe("cf34b5884cc5967f297ae82115ed2a4d54d60711a5a7822f8bf67bb196455822");
  });

  it("has exact structural anchors and ordered structural ties", () => {
    const result = simulateMatch({ eventId: "anchors", seed: 19 });
    const structuralTypes: LiveIncidentType[] = [
      LiveIncidentType.KICK_OFF,
      LiveIncidentType.HALF_TIME,
      LiveIncidentType.SECOND_HALF_KICK_OFF,
      LiveIncidentType.FULL_TIME,
    ];
    const structural = result.transitions.filter((transition) =>
      structuralTypes.includes(transition.incident.type)
    );
    expect(structural.map((transition) => transition.offsetMs)).toEqual([
      0,
      300000,
      300000,
      600000,
    ]);
    expect(structural.map((transition) => transition.incident.type)).toEqual([
      LiveIncidentType.KICK_OFF,
      LiveIncidentType.HALF_TIME,
      LiveIncidentType.SECOND_HALF_KICK_OFF,
      LiveIncidentType.FULL_TIME,
    ]);
    const addedTime = result.transitions.filter(
      (transition) =>
        transition.incident.type === LiveIncidentType.ADDED_TIME_ANNOUNCED
    );
    expect(addedTime.map((transition) => transition.phase)).toEqual([
      EventPhase.FIRST_HALF_STOPPAGE,
      EventPhase.SECOND_HALF_STOPPAGE,
    ]);
    expect(
      result.transitions.every((transition) =>
        Number.isInteger(transition.offsetMs)
      )
    ).toBe(true);
    expect(result.transitions.every((transition, index) =>
      transition.sequence === index + 1
      && transition.offsetMs >= (result.transitions[index - 1]?.offsetMs ?? 0)
    )).toBe(true);
  });

  it("satisfies calibration, cap, phase, and rare-event corpus expectations", () => {
    const totals = { goals: 0, yellows: 0, reds: 0, corners: 0, penalties: 0, freeKicks: 0 };
    let firstStoppageIncident = false;
    let secondStoppageIncident = false;
    let missingRed = false;
    let missingPenalty = false;
    let scoredPenalty = false;
    let missedPenalty = false;
    const structural = new Set<LiveIncidentType>([
      LiveIncidentType.KICK_OFF,
      LiveIncidentType.ADDED_TIME_ANNOUNCED,
      LiveIncidentType.HALF_TIME,
      LiveIncidentType.SECOND_HALF_KICK_OFF,
      LiveIncidentType.FULL_TIME,
    ]);
    for (let seed = 0; seed < 200; seed += 1) {
      const result = simulateMatch({ eventId: `corpus-${seed}`, seed });
      assertSimulationInvariants(result);
      const types = result.transitions.map((transition) => transition.incident.type);
      totals.goals += types.filter((type) => type === LiveIncidentType.GOAL).length;
      totals.yellows += types.filter((type) => type === LiveIncidentType.YELLOW_CARD).length;
      totals.reds += types.filter((type) => type === LiveIncidentType.RED_CARD).length;
      totals.corners += types.filter((type) => type === LiveIncidentType.CORNER).length;
      totals.penalties += types.filter((type) => type === LiveIncidentType.PENALTY_AWARDED).length;
      totals.freeKicks += types.filter((type) => type === LiveIncidentType.FREE_KICK).length;
      firstStoppageIncident = firstStoppageIncident || result.transitions.some((transition) =>
        transition.phase === EventPhase.FIRST_HALF_STOPPAGE
        && !structural.has(transition.incident.type)
      );
      secondStoppageIncident = secondStoppageIncident || result.transitions.some((transition) =>
        transition.phase === EventPhase.SECOND_HALF_STOPPAGE
        && !structural.has(transition.incident.type)
      );
      missingRed = missingRed || !types.includes(LiveIncidentType.RED_CARD);
      missingPenalty = missingPenalty || !types.includes(LiveIncidentType.PENALTY_AWARDED);
      scoredPenalty =
        scoredPenalty || types.includes(LiveIncidentType.PENALTY_SCORED);
      missedPenalty =
        missedPenalty || types.includes(LiveIncidentType.PENALTY_MISSED);
    }
    const means = Object.fromEntries(
      Object.entries(totals).map(([key, total]) => [key, total / 200])
    ) as typeof totals;
    expect(means.goals).toBeGreaterThan(2.1);
    expect(means.goals).toBeLessThan(3.1);
    expect(means.yellows).toBeGreaterThan(3.1);
    expect(means.yellows).toBeLessThan(4.6);
    expect(means.reds).toBeGreaterThan(0.04);
    expect(means.reds).toBeLessThan(0.2);
    expect(means.corners).toBeGreaterThan(8.8);
    expect(means.corners).toBeLessThan(12.2);
    expect(means.penalties).toBeGreaterThan(0.12);
    expect(means.penalties).toBeLessThan(0.45);
    expect(means.freeKicks).toBeGreaterThan(6.3);
    expect(means.freeKicks).toBeLessThan(9.7);
    expect(firstStoppageIncident).toBe(true);
    expect(secondStoppageIncident).toBe(true);
    expect(missingRed).toBe(true);
    expect(missingPenalty).toBe(true);
    expect(scoredPenalty).toBe(true);
    expect(missedPenalty).toBe(true);
  });

  it("delays every penalty outcome while keeping it in the awarded half", () => {
    const result = simulateMatch({
      eventId: "penalty-delay",
      seed: "penalty-delay",
      config: {
        rates: { penaltyAwards: 6 },
        caps: { penaltyAwards: 6 },
      },
    });
    const awards = result.transitions.filter(
      (transition) =>
        transition.incident.type === LiveIncidentType.PENALTY_AWARDED
    );
    expect(awards.length).toBeGreaterThan(0);
    awards.forEach((award) => {
      const outcome = result.transitions.find(
        (transition) =>
          transition.incident.penaltyId === award.incident.penaltyId
          && (
            transition.incident.type === LiveIncidentType.PENALTY_SCORED
            || transition.incident.type === LiveIncidentType.PENALTY_MISSED
          )
      )!;
      expect(outcome.offsetMs).toBeGreaterThan(award.offsetMs);
      const halfDuration = result.timeline.durationMs / 2;
      expect(outcome.offsetMs < halfDuration).toBe(
        award.offsetMs < halfDuration
      );
      if (outcome.incident.type === LiveIncidentType.PENALTY_SCORED) {
        const goal = result.transitions.find(
          (transition) =>
            transition.incident.type === LiveIncidentType.GOAL
            && transition.incident.penaltyId === award.incident.penaltyId
        )!;
        expect(goal.offsetMs).toBe(outcome.offsetMs);
      }
    });
  });
});

describe("market projection", () => {
  it("settles triggers, phases, versions, and same-offset goals correctly", () => {
    const transitions = projectTransitions(marketTimeline());
    const byType = (type: LiveIncidentType) =>
      transitions.find((transition) => transition.incident.type === type)!;
    const yellow = byType(LiveIncidentType.YELLOW_CARD);
    const red = byType(LiveIncidentType.RED_CARD);
    const corner = byType(LiveIncidentType.CORNER);
    const award = byType(LiveIncidentType.PENALTY_AWARDED);
    const outcome = byType(LiveIncidentType.PENALTY_SCORED);
    expect(yellow.settlements[0].marketId).toBe("market-event:NEXT_YELLOW_CARD");
    expect(red.settlements[0].marketId).toBe("market-event:NEXT_RED_CARD");
    expect(red.settlements).toHaveLength(1);
    expect(corner.settlements[0].marketId).toBe("market-event:NEXT_CORNER");
    expect(award.settlements[0].marketId).toBe("market-event:NEXT_PENALTY");
    expect(outcome.settlements).toEqual([]);
    expect(yellow.markets.find((market) =>
      market.marketType === LiveMarketType.NEXT_YELLOW_CARD
    )?.marketVersion).toBe(2);
    expect(red.markets.find((market) =>
      market.marketType === LiveMarketType.NEXT_YELLOW_CARD
    )?.marketVersion).toBe(2);
    const secondYellow = transitions
      .filter((transition) => transition.incident.type === LiveIncidentType.YELLOW_CARD)
      .pop()!;
    expect(secondYellow.markets.find((market) =>
      market.marketType === LiveMarketType.NEXT_YELLOW_CARD
    )?.marketVersion).toBe(3);

    const halfTime = byType(LiveIncidentType.HALF_TIME);
    const secondKick = byType(LiveIncidentType.SECOND_HALF_KICK_OFF);
    const beforeHalfTime = transitions[transitions.indexOf(halfTime) - 1];
    expect(halfTime.settlements[0]).toMatchObject({
      settlementReason: LiveSettlementReason.HALF_TIME,
      winningSide: "HOME",
    });
    expect(halfTime.markets.filter((market) =>
      market.marketType !== LiveMarketType.HALF_TIME_RESULT
    ).every((market) => market.status === LiveMarketStatus.SUSPENDED)).toBe(true);
    expect(secondKick.markets.filter((market) =>
      market.marketType !== LiveMarketType.HALF_TIME_RESULT
    ).every((market) => market.status === LiveMarketStatus.OPEN)).toBe(true);
    expect(halfTime.markets.filter((market) =>
      market.marketType !== LiveMarketType.HALF_TIME_RESULT
    ).map((market) => market.quoteVersion)).toEqual(
      beforeHalfTime.markets.filter((market) =>
        market.marketType !== LiveMarketType.HALF_TIME_RESULT
      ).map((market) => market.quoteVersion)
    );
    expect(secondKick.markets.some((market, index) =>
      market.marketType !== LiveMarketType.HALF_TIME_RESULT
      && market.quoteVersion
        > halfTime.markets[index].quoteVersion
    )).toBe(true);

    const fullTime = byType(LiveIncidentType.FULL_TIME);
    expect(fullTime.settlements).toHaveLength(4);
    expect(fullTime.settlements.every((settlement) =>
      settlement.settlementReason === LiveSettlementReason.FULL_TIME_NONE
      && settlement.winningSide === "NONE"
    )).toBe(true);
    const outcomeIndex = transitions.indexOf(outcome);
    expect(outcome.markets.map((market) => market.quoteVersion)).toEqual(
      transitions[outcomeIndex - 1].markets.map((market) => market.quoteVersion)
    );
  });

  it("settles the half-time market to home, draw, and away", () => {
    const winning = (timeline: SimTimeline) => projectTransitions(timeline)
      .find((transition) => transition.incident.type === LiveIncidentType.HALF_TIME)
      ?.settlements[0].winningSide;
    expect(winning(marketTimeline())).toBe("HOME");
    const draw = marketTimeline();
    draw.entries = draw.entries.filter((item) => item.incident.penaltyId !== "p1");
    expect(winning(draw)).toBe("DRAW");
    const away = marketTimeline(false, true);
    away.entries = away.entries.filter((item) => item.incident.penaltyId !== "p1");
    expect(winning(away)).toBe("AWAY");
  });
});

describe("configuration and purity", () => {
  it("uses the limited environment surface and validates overrides and profiles", () => {
    expect(getSimulationConfig().durationMs).toBe(600000);
    expect(getSimulationConfig({
      LIVE_MATCH_DURATION_MS: "70000",
      LIVE_SIM_RATE_SCALE: "3",
    })).toMatchObject({ durationMs: 70000, rateScale: 3 });
    expect(getSimulationConfig({
      LIVE_MATCH_DURATION_MS: "bad",
      LIVE_SIM_RATE_SCALE: "10",
    })).toMatchObject({ durationMs: 600000, rateScale: 4 });
    expect(getSimulationConfig({
      LIVE_MATCH_DURATION_MS: "1",
      LIVE_SIM_RATE_SCALE: "-1",
    })).toMatchObject({ durationMs: 60000, rateScale: 0.25 });
    expect(getSimulationConfig({
      LIVE_MATCH_DURATION_MS: "60001",
    }).durationMs).toBe(60000);
    expect(resolveSimulationConfig({
      rates: { goals: 1000 },
      caps: { goals: 100 },
    })).toMatchObject({
      rates: { goals: 12 },
      caps: { goals: 12 },
    });
    expect(() => resolveSimulationConfig({ durationMs: 59999 })).toThrow(RangeError);
    expect(() => resolveSimulationConfig({ durationMs: 60001 })).toThrow(RangeError);
    expect(() => resolveSimulationConfig({ rates: { corners: -1 } })).toThrow(RangeError);
    expect(() => resolveSimulationConfig({
      stoppage: { first: { min: 0 } },
    })).toThrow(RangeError);
    expect(normalizeProfile({ attack: 99, discipline: 0 })).toEqual({
      attack: 1.3,
      discipline: 0.7,
    });
    expect(() => normalizeProfile({ attack: Number.NaN })).toThrow(RangeError);
    expect(() => samplePoisson(201, 0.5)).toThrow(RangeError);
    const firstProfiles = simulateMatch({
      eventId: "profiles",
      seed: "profile-a",
    }).timeline.pricing;
    const secondProfiles = simulateMatch({
      eventId: "profiles",
      seed: "profile-b",
    }).timeline.pricing;
    expect(firstProfiles).not.toEqual(secondProfiles);
  });

  it("keeps production simulation modules clock, random, timer, and shared-package free", () => {
    const root = join(__dirname, "..");
    const files = readdirSync(root).filter((file) => file.endsWith(".ts"));
    const source = files.map((file) => readFileSync(join(root, file), "utf8")).join("\n");
    expect(source).not.toMatch(/\bDate\b/);
    expect(source).not.toMatch(/Math\.random/);
    expect(source).not.toMatch(/set(?:Interval|Timeout|Immediate)/);
    expect(source).not.toMatch(/from\s+["'][^"']*common/);
  });
});

describe("simulation invariant failures", () => {
  function copyResult() {
    return JSON.parse(JSON.stringify(
      simulateMatch({ eventId: "invalid", seed: 31 })
    )) as ReturnType<typeof simulateMatch>;
  }

  function expectInvalid(change: (result: ReturnType<typeof simulateMatch>) => void): void {
    const result = copyResult();
    change(result);
    expect(() => assertSimulationInvariants(result)).toThrow("simulation invariant");
  }

  it("rejects broken engine, structural, clock, score, phase, and market contracts", () => {
    const structuralTypes: LiveIncidentType[] = [
      LiveIncidentType.KICK_OFF,
      LiveIncidentType.ADDED_TIME_ANNOUNCED,
      LiveIncidentType.HALF_TIME,
      LiveIncidentType.SECOND_HALF_KICK_OFF,
      LiveIncidentType.FULL_TIME,
    ];
    expectInvalid((result) => { result.engineVersion = 2 as 1; });
    expectInvalid((result) => { result.timeline.durationMs += 1; });
    expectInvalid((result) => { result.timeline.entries.pop(); });
    expectInvalid((result) => {
      result.transitions.find((item) => item.incident.type === LiveIncidentType.HALF_TIME)!.offsetMs += 1;
    });
    expectInvalid((result) => { result.transitions[1].sequence = 99; });
    expectInvalid((result) => { result.transitions[0].minute = -1; });
    expectInvalid((result) => {
      result.transitions.find((item) =>
        item.incident.type === LiveIncidentType.ADDED_TIME_ANNOUNCED
      )!.addedTime = 99;
    });
    expectInvalid((result) => {
      const incident = result.transitions.find((item) =>
        !structuralTypes.includes(item.incident.type)
      )!;
      incident.offsetMs = 0;
    });
    expectInvalid((result) => {
      result.transitions[0].homeScore = 1;
      result.transitions[0].scores.home = 1;
    });
    expectInvalid((result) => { result.finalScore.home += 1; });
    expectInvalid((result) => {
      const incident = result.transitions.find((item) =>
        item.phase === EventPhase.SECOND_HALF && item.incident.type !== LiveIncidentType.SECOND_HALF_KICK_OFF
      )!;
      incident.phase = EventPhase.FIRST_HALF;
      incident.minute = 45;
      delete incident.addedTime;
    });
    expectInvalid((result) => { result.transitions[0].markets.pop(); });
    expectInvalid((result) => {
      result.transitions[0].markets[0].selections[0].odds = Number.NaN;
    });
    expectInvalid((result) => {
      result.transitions[0].markets[0].status = LiveMarketStatus.CLOSED;
    });
    expectInvalid((result) => {
      result.transitions[1].incident.type = LiveIncidentType.PENALTY_MISSED;
      result.transitions[1].incident.penaltyId = "orphaned-penalty";
    });
    expectInvalid((result) => {
      result.transitions.find((item) =>
        item.incident.type === LiveIncidentType.HALF_TIME
      )!.bettingStatus = "OPEN";
    });
    expectInvalid((result) => {
      const fullTime = result.transitions.find((item) =>
        item.incident.type === LiveIncidentType.FULL_TIME
      )!;
      fullTime.settlements[0].settlementReason = LiveSettlementReason.INCIDENT;
    });
  });
});
