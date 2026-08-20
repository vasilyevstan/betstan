import { normalizeProfile, resolveSimulationConfig } from "./config";
import { createNamedRng, NamedRng, samplePoisson } from "./rng";
import {
  CompetingSide,
  ENGINE_VERSION,
  EventPhase,
  LiveIncidentType,
  SimIncident,
  SimTimeline,
  SimTimelineEntry,
  SimulateMatchInput,
} from "./types";

interface EntryDraft extends Omit<SimTimelineEntry, "order"> {
  draftOrder: number;
}

interface MatchFactors {
  attack: number;
  discipline: number;
  homeAttackShare: number;
  homeDisciplineShare: number;
}

const EPSILON_FOOTBALL_MINUTE = 0.001;

export function incidentPriority(type: LiveIncidentType): number {
  switch (type) {
    case LiveIncidentType.KICK_OFF:
      return 0;
    case LiveIncidentType.ADDED_TIME_ANNOUNCED:
      return 5;
    case LiveIncidentType.PENALTY_AWARDED:
      return 10;
    case LiveIncidentType.PENALTY_SCORED:
    case LiveIncidentType.PENALTY_MISSED:
      return 11;
    case LiveIncidentType.GOAL:
      return 12;
    case LiveIncidentType.HALF_TIME:
    case LiveIncidentType.FULL_TIME:
      return 100;
    case LiveIncidentType.SECOND_HALF_KICK_OFF:
      return 101;
    default:
      return 20;
  }
}

export function sortTimelineEntries(entries: SimTimelineEntry[]): SimTimelineEntry[] {
  const penaltyOrder = new Map<string, number>();
  entries.forEach((entry) => {
    if (
      entry.incident.type === LiveIncidentType.PENALTY_AWARDED
      && entry.incident.penaltyId
    ) {
      penaltyOrder.set(entry.incident.penaltyId, entry.order);
    }
  });
  const penaltyStage = (entry: SimTimelineEntry): number => {
    switch (entry.incident.type) {
      case LiveIncidentType.PENALTY_AWARDED:
        return 0;
      case LiveIncidentType.PENALTY_SCORED:
      case LiveIncidentType.PENALTY_MISSED:
        return 1;
      case LiveIncidentType.GOAL:
        return 2;
      default:
        return 3;
    }
  };
  return [...entries].sort((left, right) =>
    left.offsetMs - right.offsetMs
    || (left.incident.penaltyId && right.incident.penaltyId
      ? (penaltyOrder.get(left.incident.penaltyId) ?? left.order)
        - (penaltyOrder.get(right.incident.penaltyId) ?? right.order)
        || penaltyStage(left) - penaltyStage(right)
      : 0)
    || incidentPriority(left.incident.type) - incidentPriority(right.incident.type)
    || left.order - right.order
  );
}

function eventCount(lambda: number, cap: number, rng: NamedRng): number {
  return Math.min(cap, samplePoisson(lambda, rng.uniform()));
}

function side(rng: NamedRng, homeShare: number): CompetingSide {
  return rng.uniform() < homeShare ? "HOME" : "AWAY";
}

function profileFactors(input: SimulateMatchInput): MatchFactors {
  const profileRng = createNamedRng(input.seed, "profiles");
  const generatedFactor = () => 0.85 + profileRng.uniform() * 0.3;
  const home = normalizeProfile({
    attack: input.homeProfile?.attack ?? generatedFactor(),
    discipline: input.homeProfile?.discipline ?? generatedFactor(),
  });
  const away = normalizeProfile({
    attack: input.awayProfile?.attack ?? generatedFactor(),
    discipline: input.awayProfile?.discipline ?? generatedFactor(),
  });
  const homeAttackWeight = home.attack * 1.05;
  const awayAttackWeight = away.attack;
  return {
    attack: (home.attack + away.attack) / 2,
    discipline: (home.discipline + away.discipline) / 2,
    homeAttackShare: homeAttackWeight / (homeAttackWeight + awayAttackWeight),
    homeDisciplineShare: home.discipline / (home.discipline + away.discipline),
  };
}

function offsetForFootballMinute(
  firstHalf: boolean,
  footballMinute: number,
  stoppage: number,
  halfDurationMs: number
): number {
  const halfStart = firstHalf ? 0 : halfDurationMs;
  const halfEnd = halfStart + halfDurationMs;
  const announcementOffset = Math.round(
    halfStart + (45 / (45 + stoppage)) * halfDurationMs
  );
  const rounded = Math.round(
    halfStart + (footballMinute / (45 + stoppage)) * halfDurationMs
  );
  if (footballMinute <= 45) {
    return Math.max(halfStart + 1, Math.min(announcementOffset - 1, rounded));
  }
  return Math.max(
    announcementOffset,
    Math.min(halfEnd - 1, rounded)
  );
}

function halfMoment(
  halfRng: NamedRng,
  minuteRng: NamedRng,
  firstStoppage: number,
  secondStoppage: number,
  halfDurationMs: number,
  reservedFootballMinutes = 0
): { offsetMs: number; firstHalf: boolean; footballMinute: number } {
  const firstHalf = halfRng.uniform() < 0.5;
  const stoppage = firstHalf ? firstStoppage : secondStoppage;
  const latestFootballMinute =
    45 + stoppage - reservedFootballMinutes - EPSILON_FOOTBALL_MINUTE;
  const footballMinute = Math.max(
    EPSILON_FOOTBALL_MINUTE,
    Math.min(
      latestFootballMinute,
      minuteRng.uniform() * latestFootballMinute
    )
  );
  return {
    offsetMs: offsetForFootballMinute(
      firstHalf,
      footballMinute,
      stoppage,
      halfDurationMs
    ),
    firstHalf,
    footballMinute,
  };
}

function clock(
  firstHalf: boolean,
  footballMinute: number,
  stoppage: number
): Pick<SimTimelineEntry, "phase" | "minute" | "addedTime"> {
  if (footballMinute <= 45) {
    return {
      phase: firstHalf ? EventPhase.FIRST_HALF : EventPhase.SECOND_HALF,
      minute: (firstHalf ? 0 : 45) + Math.max(1, Math.ceil(footballMinute)),
    };
  }
  return {
    phase: firstHalf
      ? EventPhase.FIRST_HALF_STOPPAGE
      : EventPhase.SECOND_HALF_STOPPAGE,
    minute: firstHalf ? 45 : 90,
    addedTime: Math.min(stoppage, Math.max(1, Math.ceil(footballMinute - 45))),
  };
}

function withIncident(
  drafts: EntryDraft[],
  offsetMs: number,
  phase: EventPhase,
  minute: number,
  incident: SimIncident,
  addedTime?: number
): void {
  drafts.push({
    offsetMs,
    phase,
    minute,
    addedTime,
    incident,
    draftOrder: drafts.length,
  });
}

function addStandardIncidents(
  drafts: EntryDraft[],
  seed: string | number,
  stream: string,
  type: LiveIncidentType,
  count: number,
  homeShare: number,
  firstStoppage: number,
  secondStoppage: number,
  halfDurationMs: number
): void {
  const halfRng = createNamedRng(seed, `${stream}.half`);
  const minuteRng = createNamedRng(seed, `${stream}.minute`);
  const sideRng = createNamedRng(seed, `${stream}.side`);
  for (let index = 1; index <= count; index += 1) {
    const moment = halfMoment(
      halfRng,
      minuteRng,
      firstStoppage,
      secondStoppage,
      halfDurationMs
    );
    const eventClock = clock(
      moment.firstHalf,
      moment.footballMinute,
      moment.firstHalf ? firstStoppage : secondStoppage
    );
    withIncident(
      drafts,
      moment.offsetMs,
      eventClock.phase,
      eventClock.minute,
      { id: `${stream}-${index}`, type, side: side(sideRng, homeShare) },
      eventClock.addedTime
    );
  }
}

export function generateTimeline(input: SimulateMatchInput): SimTimeline {
  if (!input.eventId) {
    throw new RangeError("eventId is required");
  }
  const config = resolveSimulationConfig(input.config);
  const factors = profileFactors(input);
  const halfDurationMs = config.durationMs / 2;
  const firstStoppage = createNamedRng(input.seed, "stoppage.first").integer(
    config.stoppage.first.min,
    config.stoppage.first.max
  );
  const secondStoppage = createNamedRng(input.seed, "stoppage.second").integer(
    config.stoppage.second.min,
    config.stoppage.second.max
  );
  const drafts: EntryDraft[] = [];

  withIncident(drafts, 0, EventPhase.FIRST_HALF, 0, {
    id: "kick-off",
    type: LiveIncidentType.KICK_OFF,
  });
  withIncident(
    drafts,
    Math.round((45 / (45 + firstStoppage)) * halfDurationMs),
    EventPhase.FIRST_HALF_STOPPAGE,
    45,
    { id: "first-added-time", type: LiveIncidentType.ADDED_TIME_ANNOUNCED },
    firstStoppage
  );
  withIncident(drafts, halfDurationMs, EventPhase.HALF_TIME, 45, {
    id: "half-time",
    type: LiveIncidentType.HALF_TIME,
  });
  withIncident(drafts, halfDurationMs, EventPhase.SECOND_HALF, 46, {
    id: "second-half-kick-off",
    type: LiveIncidentType.SECOND_HALF_KICK_OFF,
  });
  withIncident(
    drafts,
    Math.round(
      halfDurationMs + (45 / (45 + secondStoppage)) * halfDurationMs
    ),
    EventPhase.SECOND_HALF_STOPPAGE,
    90,
    { id: "second-added-time", type: LiveIncidentType.ADDED_TIME_ANNOUNCED },
    secondStoppage
  );
  withIncident(
    drafts,
    config.durationMs,
    EventPhase.FULL_TIME,
    90,
    { id: "full-time", type: LiveIncidentType.FULL_TIME },
    secondStoppage
  );

  const scaled = config.rateScale;
  const openGoalCount = eventCount(
    config.rates.goals * scaled * factors.attack,
    config.caps.goals,
    createNamedRng(input.seed, "goals.count")
  );
  const penaltyCount = eventCount(
    config.rates.penaltyAwards * scaled * factors.attack,
    config.caps.penaltyAwards,
    createNamedRng(input.seed, "penalties.count")
  );

  const penaltyHalfRng = createNamedRng(input.seed, "penalties.half");
  const penaltyMinuteRng = createNamedRng(input.seed, "penalties.minute");
  const penaltySideRng = createNamedRng(input.seed, "penalties.side");
  const penaltyResultRng = createNamedRng(input.seed, "penalties.result");
  const penaltyDelayMinutes = config.penaltyOutcomeDelaySeconds / 60;
  let penaltyGoals = 0;
  for (let index = 1; index <= penaltyCount; index += 1) {
    const penaltyId = `penalty-${index}`;
    const moment = halfMoment(
      penaltyHalfRng,
      penaltyMinuteRng,
      firstStoppage,
      secondStoppage,
      halfDurationMs,
      penaltyDelayMinutes
    );
    const eventClock = clock(
      moment.firstHalf,
      moment.footballMinute,
      moment.firstHalf ? firstStoppage : secondStoppage
    );
    const awardedId = `${penaltyId}-awarded`;
    const awardSide = side(penaltySideRng, factors.homeAttackShare);
    withIncident(
      drafts,
      moment.offsetMs,
      eventClock.phase,
      eventClock.minute,
      {
        id: awardedId,
        type: LiveIncidentType.PENALTY_AWARDED,
        side: awardSide,
        penaltyId,
      },
      eventClock.addedTime
    );
    const scored = penaltyResultRng.uniform() < config.rates.penaltyScoreProbability
      && openGoalCount + penaltyGoals < config.caps.goals;
    const outcomeId = `${penaltyId}-${scored ? "scored" : "missed"}`;
    const outcomeFootballMinute =
      moment.footballMinute + penaltyDelayMinutes;
    const outcomeClock = clock(
      moment.firstHalf,
      outcomeFootballMinute,
      moment.firstHalf ? firstStoppage : secondStoppage
    );
    const outcomeOffsetMs = offsetForFootballMinute(
      moment.firstHalf,
      outcomeFootballMinute,
      moment.firstHalf ? firstStoppage : secondStoppage,
      halfDurationMs
    );
    withIncident(
      drafts,
      outcomeOffsetMs,
      outcomeClock.phase,
      outcomeClock.minute,
      {
        id: outcomeId,
        type: scored
          ? LiveIncidentType.PENALTY_SCORED
          : LiveIncidentType.PENALTY_MISSED,
        side: awardSide,
        penaltyId,
        linkedIncidentId: awardedId,
      },
      outcomeClock.addedTime
    );
    if (scored) {
      penaltyGoals += 1;
      withIncident(
        drafts,
        outcomeOffsetMs,
        outcomeClock.phase,
        outcomeClock.minute,
        {
          id: `${penaltyId}-goal`,
          type: LiveIncidentType.GOAL,
          side: awardSide,
          penaltyId,
          linkedIncidentId: outcomeId,
        },
        outcomeClock.addedTime
      );
    }
  }

  addStandardIncidents(
    drafts,
    input.seed,
    "goals",
    LiveIncidentType.GOAL,
    openGoalCount,
    factors.homeAttackShare,
    firstStoppage,
    secondStoppage,
    halfDurationMs
  );
  addStandardIncidents(
    drafts,
    input.seed,
    "yellows",
    LiveIncidentType.YELLOW_CARD,
    eventCount(
      config.rates.yellows * scaled * factors.discipline,
      config.caps.yellows,
      createNamedRng(input.seed, "yellows.count")
    ),
    factors.homeDisciplineShare,
    firstStoppage,
    secondStoppage,
    halfDurationMs
  );
  addStandardIncidents(
    drafts,
    input.seed,
    "reds",
    LiveIncidentType.RED_CARD,
    eventCount(
      config.rates.reds * scaled * factors.discipline,
      config.caps.reds,
      createNamedRng(input.seed, "reds.count")
    ),
    factors.homeDisciplineShare,
    firstStoppage,
    secondStoppage,
    halfDurationMs
  );
  addStandardIncidents(
    drafts,
    input.seed,
    "corners",
    LiveIncidentType.CORNER,
    eventCount(
      config.rates.corners * scaled * factors.attack,
      config.caps.corners,
      createNamedRng(input.seed, "corners.count")
    ),
    factors.homeAttackShare,
    firstStoppage,
    secondStoppage,
    halfDurationMs
  );
  addStandardIncidents(
    drafts,
    input.seed,
    "free-kicks",
    LiveIncidentType.FREE_KICK,
    eventCount(
      config.rates.freeKicks * scaled * factors.discipline,
      config.caps.freeKicks,
      createNamedRng(input.seed, "free-kicks.count")
    ),
    factors.homeDisciplineShare,
    firstStoppage,
    secondStoppage,
    halfDurationMs
  );

  const entries = sortTimelineEntries(
    drafts.map(({ draftOrder: _draftOrder, ...entry }) => ({
      ...entry,
      order: _draftOrder,
    }))
  ).map((entry, order) => ({ ...entry, order }));

  return {
    engineVersion: ENGINE_VERSION,
    eventId: input.eventId,
    seed: input.seed,
    durationMs: config.durationMs,
    stoppage: { first: firstStoppage, second: secondStoppage },
    config,
    pricing: {
      attackFactor: factors.attack,
      disciplineFactor: factors.discipline,
      homeAttackShare: factors.homeAttackShare,
      homeDisciplineShare: factors.homeDisciplineShare,
    },
    entries,
  };
}
