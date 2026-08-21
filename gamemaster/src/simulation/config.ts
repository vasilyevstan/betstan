import {
  IncidentCaps,
  IncidentRates,
  SimulationConfig,
  SimulationConfigOverride,
  StoppageRange,
  TeamProfile,
} from "./types";

export const DEFAULT_MATCH_DURATION_MS = 600000;
export const MIN_MATCH_DURATION_MS = 60000;
export const MIN_RATE_SCALE = 0.25;
export const MAX_RATE_SCALE = 4;
export const MIN_PROFILE_FACTOR = 0.7;
export const MAX_ATTACK_FACTOR = 1.3;
export const MAX_DISCIPLINE_FACTOR = 1.3;

const DEFAULT_RATES: IncidentRates = {
  goals: 2.37,
  yellows: 3.8,
  reds: 0.11,
  corners: 10.5,
  penaltyAwards: 0.27,
  freeKicks: 8,
  penaltyScoreProbability: 0.76,
};

export const HARD_CAPS: IncidentCaps = {
  goals: 12,
  yellows: 14,
  reds: 4,
  corners: 30,
  penaltyAwards: 6,
  freeKicks: 24,
};

const RATE_LIMITS: IncidentRates = {
  ...HARD_CAPS,
  penaltyScoreProbability: 1,
};

const DEFAULT_CONFIG: SimulationConfig = {
  durationMs: DEFAULT_MATCH_DURATION_MS,
  rateScale: 1,
  rates: DEFAULT_RATES,
  caps: HARD_CAPS,
  stoppage: {
    first: { min: 1, max: 5 },
    second: { min: 2, max: 7 },
  },
  penaltyOutcomeDelaySeconds: 30,
  marketMargin: 0.04,
  minOdds: 1.01,
  maxOdds: 1000,
};

function finite(name: string, value: number): number {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${name} must be finite`);
  }
  return value;
}

function nonNegative(name: string, value: number): number {
  const checked = finite(name, value);
  if (checked < 0) {
    throw new RangeError(`${name} must not be negative`);
  }
  return checked;
}

function integer(name: string, value: number): number {
  const checked = finite(name, value);
  if (!Number.isSafeInteger(checked)) {
    throw new RangeError(`${name} must be a safe integer`);
  }
  return checked;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function resolveRange(
  name: string,
  base: StoppageRange,
  override?: Partial<StoppageRange>
): StoppageRange {
  const min = override?.min === undefined
    ? base.min
    : integer(`${name}.min`, override.min);
  const max = override?.max === undefined
    ? base.max
    : integer(`${name}.max`, override.max);
  if (min < 1 || max < min) {
    throw new RangeError(`${name} must be an ascending positive range`);
  }
  return { min, max };
}

function resolveRates(
  override?: Partial<IncidentRates>
): IncidentRates {
  const rates: IncidentRates = { ...DEFAULT_RATES, ...override };
  (Object.keys(rates) as Array<keyof IncidentRates>).forEach((key) => {
    rates[key] = clamp(
      nonNegative(`rates.${key}`, rates[key]),
      0,
      RATE_LIMITS[key]
    );
  });
  return rates;
}

function resolveCaps(override?: Partial<IncidentCaps>): IncidentCaps {
  const requested: IncidentCaps = { ...HARD_CAPS, ...override };
  const caps = {} as IncidentCaps;
  (Object.keys(HARD_CAPS) as Array<keyof IncidentCaps>).forEach((key) => {
    caps[key] = clamp(integer(`caps.${key}`, requested[key]), 1, HARD_CAPS[key]);
  });
  return caps;
}

export function resolveSimulationConfig(
  override: SimulationConfigOverride = {}
): SimulationConfig {
  const durationMs = override.durationMs === undefined
    ? DEFAULT_CONFIG.durationMs
    : integer("durationMs", override.durationMs);
  if (durationMs < MIN_MATCH_DURATION_MS) {
    throw new RangeError(`durationMs must be at least ${MIN_MATCH_DURATION_MS}`);
  }
  if (durationMs % 2 !== 0) {
    throw new RangeError("durationMs must be an even number of milliseconds");
  }
  const rateScale = clamp(
    finite("rateScale", override.rateScale ?? DEFAULT_CONFIG.rateScale),
    MIN_RATE_SCALE,
    MAX_RATE_SCALE
  );
  const marketMargin = nonNegative(
    "marketMargin",
    override.marketMargin ?? DEFAULT_CONFIG.marketMargin
  );
  const minOdds = finite("minOdds", override.minOdds ?? DEFAULT_CONFIG.minOdds);
  const maxOdds = finite("maxOdds", override.maxOdds ?? DEFAULT_CONFIG.maxOdds);
  if (minOdds < 1 || maxOdds < minOdds) {
    throw new RangeError("odds bounds are invalid");
  }
  const penaltyOutcomeDelaySeconds = integer(
    "penaltyOutcomeDelaySeconds",
    override.penaltyOutcomeDelaySeconds
      ?? DEFAULT_CONFIG.penaltyOutcomeDelaySeconds
  );
  if (
    penaltyOutcomeDelaySeconds < 1
    || penaltyOutcomeDelaySeconds > 300
  ) {
    throw new RangeError(
      "penaltyOutcomeDelaySeconds must be between 1 and 300"
    );
  }

  return {
    durationMs,
    rateScale,
    rates: resolveRates(override.rates),
    caps: resolveCaps(override.caps),
    stoppage: {
      first: resolveRange("stoppage.first", DEFAULT_CONFIG.stoppage.first, override.stoppage?.first),
      second: resolveRange("stoppage.second", DEFAULT_CONFIG.stoppage.second, override.stoppage?.second),
    },
    penaltyOutcomeDelaySeconds,
    marketMargin,
    minOdds,
    maxOdds,
  };
}

export function normalizeProfile(profile: TeamProfile = {}): Required<TeamProfile> {
  return {
    attack: clamp(
      finite("profile.attack", profile.attack ?? 1),
      MIN_PROFILE_FACTOR,
      MAX_ATTACK_FACTOR
    ),
    discipline: clamp(
      finite("profile.discipline", profile.discipline ?? 1),
      MIN_PROFILE_FACTOR,
      MAX_DISCIPLINE_FACTOR
    ),
  };
}

function envNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function getSimulationConfig(
  env: Record<string, string | undefined> = process.env
): SimulationConfig {
  const requestedDurationMs = Math.max(
    MIN_MATCH_DURATION_MS,
    Math.floor(envNumber(env.LIVE_MATCH_DURATION_MS, DEFAULT_MATCH_DURATION_MS))
  );
  const durationMs = requestedDurationMs - (requestedDurationMs % 2);
  const rateScale = clamp(
    envNumber(env.LIVE_SIM_RATE_SCALE, 1),
    MIN_RATE_SCALE,
    MAX_RATE_SCALE
  );
  return resolveSimulationConfig({ durationMs, rateScale });
}
