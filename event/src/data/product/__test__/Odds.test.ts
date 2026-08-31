import Odds from "../Odds";

describe("Odds", () => {
  it("uses an explicit finite value when provided", () => {
    const odds = new Odds("Home", 1.85);

    expect(odds.name).toEqual("Home");
    expect(odds.value).toEqual(1.85);
    expect(odds.id).toEqual(expect.any(String));
  });

  it("falls back to the legacy random-arbitrary value when no explicit value is provided", () => {
    const odds = new Odds("Home");

    expect(odds.value).toEqual(expect.any(Number));
    expect(odds.value).toBeGreaterThanOrEqual(1.01);
    expect(odds.value).toBeLessThanOrEqual(5);
  });

  it("falls back to the legacy random-arbitrary value for a non-finite explicit value (defensive compatibility)", () => {
    const odds = new Odds("Home", Number.NaN);

    expect(Number.isFinite(odds.value)).toBe(true);
    expect(odds.value).toBeGreaterThanOrEqual(1.01);
    expect(odds.value).toBeLessThanOrEqual(5);
  });
});
