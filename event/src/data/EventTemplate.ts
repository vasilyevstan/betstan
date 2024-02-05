import { faker } from "@faker-js/faker";
import Product from "./product/Product";
import Product1X2 from "./product/Product1X2";
import CorrectScore from "./product/CorrectScore";

class EventTemplate {
  eventId = faker.string.uuid();
  name: string;
  time: Date;
  products: Product[] = [];

  constructor(eventId?: string, homeTeam?: string, awayTeam?: string) {
    const home = homeTeam ? homeTeam : faker.location.city();
    const away = awayTeam ? awayTeam : faker.location.city();
    this.eventId = eventId ? eventId : faker.string.uuid();
    this.name = `${home} - ${away}`;
    this.time = faker.date.anytime();
    this.products.push(new Product1X2(home, away));
    this.products.push(new CorrectScore(home, away));
  }
}

export default EventTemplate;
