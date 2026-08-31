import { faker } from "@faker-js/faker";
import Product from "./Product";
import Odds from "./Odds";
import { ProductType } from "./ProductType";
import { PricedCorrectScore } from "./preMatchPricing";

function initCSOptions(): Odds[] {
  const options: Odds[] = [];

  for (let i = 0; i < 10; i++) {
    const homeGoals = faker.number.int({ min: 0, max: 10 });
    const awayGoals = faker.number.int({ min: 0, max: 10 });

    const option = new Odds(`${homeGoals} - ${awayGoals}`);

    options.push(option);
  }

  return options;
}

class CorrectScore extends Product {
  type: ProductType.CORRECT_SCORE = ProductType.CORRECT_SCORE;
  name = "Correct Score";
  id = faker.string.uuid();
  odds: Odds[] = [];

  //private options: Odds[];

  /**
   * `pricedScores` is optional: when supplied (see `EventTemplate`, which builds it once via
   * `preMatchPricing.buildPreMatchPricing`), the ~10 exact scores and their prices come from the
   * same coherent, bounded score distribution as the event's 1X2 product -- so the two markets
   * never disagree, and no implausible score (e.g. `7 - 10`) can appear. Callers that omit it (or
   * pass an empty list) keep the legacy independent-random-scoreline fallback, unchanged.
   */
  constructor(home: string, away: string, pricedScores?: PricedCorrectScore[]) {
    super();

    this.odds = pricedScores && pricedScores.length > 0
      ? pricedScores.map((score) => new Odds(`${score.homeGoals} - ${score.awayGoals}`, score.odds))
      : initCSOptions();
  }
}

export default CorrectScore;
