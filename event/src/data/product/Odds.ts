import { faker } from "@faker-js/faker";

const ODDS_MIN_VALUE = 1.01;
const ODDS_MAX_VALUE = 5;

function getRandomArbitrary() {
  const min = ODDS_MIN_VALUE;
  const max = ODDS_MAX_VALUE;
  var num = Math.random() * (max - min) + min;
  return Math.round((num + Number.EPSILON) * 100) / 100;
}

class Odds {
  id = faker.string.uuid();
  name: string;
  value: number;

  /**
   * `value` is optional and, when provided, must be a finite number -- used by coherently-priced
   * products (see `preMatchPricing.ts`) that already know the exact price to assign. Any caller
   * that omits it (or passes something non-finite) keeps the legacy random-arbitrary fallback,
   * so existing call sites are unaffected.
   */
  constructor(name: string, value?: number) {
    this.name = name;
    this.value = typeof value === "number" && Number.isFinite(value) ? value : getRandomArbitrary();
  }
}

export default Odds;
