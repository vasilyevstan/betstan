import Odds from "./Odds";
import { ProductType } from "./ProductType";

abstract class Product {
  abstract id: string;
  abstract type: ProductType;
  abstract name: string;
  abstract odds: Odds[];
}

export default Product;
