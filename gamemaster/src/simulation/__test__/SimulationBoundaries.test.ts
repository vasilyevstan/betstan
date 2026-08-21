import { createNamedRng, samplePoisson } from "..";

describe("simulation boundary branches", () => {
  it("rejects invalid RNG integer bounds and uniform samples", () => {
    const rng = createNamedRng("seed", "bounds");

    expect(() => rng.integer(2, 1)).toThrow("integer bounds are invalid");
    expect(() => rng.integer(1.5, 2)).toThrow("integer bounds are invalid");
    expect(() => samplePoisson(1, -0.1)).toThrow("uniform must be in [0, 1)");
    expect(() => samplePoisson(1, 1)).toThrow("uniform must be in [0, 1)");
  });

  it("throws when projected transitions are empty", () => {
    jest.resetModules();

    try {
      jest.isolateModules(() => {
        jest.doMock("../timeline", () => ({
          generateTimeline: jest.fn(() => ({
            engineVersion: 1,
            eventId: "empty-event",
            seed: "empty-seed",
            durationMs: 1,
            stoppage: { first: 0, second: 0 },
            config: {},
            entries: [],
          })),
        }));
        jest.doMock("../markets", () => ({
          projectTransitions: jest.fn(() => []),
        }));
        jest.doMock("../invariants", () => ({
          assertSimulationInvariants: jest.fn(),
        }));

        const { simulateMatch } = require("..");
        expect(() =>
          simulateMatch({ eventId: "empty-event", seed: "empty-seed" })
        ).toThrow("simulation produced no transitions");
      });
    } finally {
      jest.resetModules();
      jest.dontMock("../timeline");
      jest.dontMock("../markets");
      jest.dontMock("../invariants");
    }
  });
});
