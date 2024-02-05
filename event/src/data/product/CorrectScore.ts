import { faker } from "@faker-js/faker";
import Product from "./Product";
import Odds from "./Odds";
import { ProductType } from "./ProductType";

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

  constructor(home: string, away: string) {
    super();

    this.odds = initCSOptions();
  }
}

export default CorrectScore;
