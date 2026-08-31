import { faker } from "@faker-js/faker";
import Product from "./Product";
import Odds from "./Odds";
import { ProductType } from "./ProductType";
import { PricedOneCrossTwo } from "./preMatchPricing";

class Product1X2 extends Product {
  type: ProductType.ONE_CROSS_TWO = ProductType.ONE_CROSS_TWO;
  name = "1X2";
  id = faker.string.uuid();

  odds: Odds[] = [];

  /**
   * `pricing` is optional: when supplied (see `EventTemplate`, which builds it once via
   * `preMatchPricing.buildPreMatchPricing`), the three prices come from that same coherent score
   * distribution as the event's Correct Score product. Callers that omit it keep each `Odds`'s
   * legacy independent random fallback, unchanged.
   */
  constructor(home: string, away: string, pricing?: PricedOneCrossTwo) {
    super();

    this.odds.push(new Odds(home, pricing?.home));
    this.odds.push(new Odds("draw", pricing?.draw));
    this.odds.push(new Odds(away, pricing?.away));
  }
}

export default Product1X2;
