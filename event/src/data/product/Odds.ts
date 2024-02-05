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

  constructor(name: string) {
    this.name = name;
    this.value = getRandomArbitrary();
  }
}

export default Odds;
