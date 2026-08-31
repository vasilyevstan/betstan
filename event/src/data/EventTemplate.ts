import { faker } from "@faker-js/faker";
import Product from "./product/Product";
import Product1X2 from "./product/Product1X2";
import CorrectScore from "./product/CorrectScore";
import { buildPreMatchPricing } from "./product/preMatchPricing";

class EventTemplate {
  eventId = faker.string.uuid();
  name: string;
  time: Date;
  home: string;
  away: string;
  products: Product[] = [];

  constructor(
    eventId?: string,
    homeTeam?: string,
    awayTeam?: string,
    time?: string
  ) {
    const home = homeTeam ? homeTeam : faker.location.city();
    const away = awayTeam ? awayTeam : faker.location.city();
    this.eventId = eventId ? eventId : faker.string.uuid();
    this.home = home;
    this.away = away;
    this.name = `${home} - ${away}`;
    this.time = time ? new Date(time) : faker.date.soon();
    // Priced exactly once so the 1X2 and Correct Score products for this event are always
    // derived from the same coherent score distribution (see `preMatchPricing.ts`).
    const pricing = buildPreMatchPricing();
    this.products.push(new Product1X2(home, away, pricing.oneCrossTwoOdds));
    this.products.push(new CorrectScore(home, away, pricing.correctScoreOdds));
  }
}

export default EventTemplate;
