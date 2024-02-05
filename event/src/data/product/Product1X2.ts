import { faker } from "@faker-js/faker";
import Product from "./Product";
import Odds from "./Odds";
import { ProductType } from "./ProductType";

class Product1X2 extends Product {
  type: ProductType.ONE_CROSS_TWO = ProductType.ONE_CROSS_TWO;
  name = "1X2";
  id = faker.string.uuid();

  odds: Odds[] = [];

  constructor(home: string, away: string) {
    super();

    this.odds.push(new Odds(home));
    this.odds.push(new Odds("draw"));
    this.odds.push(new Odds(away));
  }
}

export default Product1X2;
