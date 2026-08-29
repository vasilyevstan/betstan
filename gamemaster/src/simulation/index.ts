import { assertSimulationInvariants } from "./invariants";
import { projectTransitions } from "./markets";
import { generateTimeline } from "./timeline";
import {
  ENGINE_VERSION,
  SimulateMatchInput,
  SimulationResult,
} from "./types";

export function simulateMatch(input: SimulateMatchInput): SimulationResult {
  const timeline = generateTimeline(input);
  const transitions = projectTransitions(timeline);
  const last = transitions[transitions.length - 1];
  if (!last) {
    throw new Error("simulation produced no transitions");
  }
  const result: SimulationResult = {
    engineVersion: ENGINE_VERSION,
    timeline,
    transitions,
    finalScore: {
      home: last.homeScore,
      away: last.awayScore,
    },
  };
  assertSimulationInvariants(result);
  return result;
}

export * from "./config";
export {
  createNamedRng,
  samplePoisson,
} from "./rng";
export { generateTimeline } from "./timeline";
export { projectTransitions, buildPreKickoffMarkets } from "./markets";
export { assertSimulationInvariants } from "./invariants";
export * from "./types";
