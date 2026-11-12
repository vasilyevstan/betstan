import { faker } from "@faker-js/faker";
import { ScorePricingModel } from "@betstan/common";
import Product from "./product/Product";
import Product1X2 from "./product/Product1X2";
import CorrectScore from "./product/CorrectScore";
import { buildPreMatchPricing } from "./product/preMatchPricing";
import { buildRetainedPreMatchPricing, RetainedSelectionRule } from "./product/retainedPreMatchPricing";

class EventTemplate {
  eventId = faker.string.uuid();
  name: string;
  time: Date;
  home: string;
  away: string;
  products: Product[] = [];
  pricingModel?: ScorePricingModel;
  pricingModelCreatedAt?: string;
  pricingRules?: RetainedSelectionRule[];

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
    const retained = process.env.EXTENSIBLE_MARKETS_ENABLED === "true"
      ? buildRetainedPreMatchPricing() : undefined;
    const pricing = retained ?? buildPreMatchPricing();
    const oneCrossTwo = new Product1X2(home, away, pricing.oneCrossTwoOdds);
    const correctScore = new CorrectScore(home, away, pricing.correctScoreOdds);
    this.products.push(oneCrossTwo, correctScore);
    if (retained) {
      this.pricingModel = retained.pricingModel;
      this.pricingModelCreatedAt = new Date().toISOString();
      this.pricingRules = [
        ...oneCrossTwo.odds.map((odd, index) => ({
          productId: oneCrossTwo.id, oddsId: odd.id, rule: retained.rules.oneCrossTwo[index],
        })),
        ...correctScore.odds.map((odd, index) => ({
          productId: correctScore.id, oddsId: odd.id, rule: retained.rules.correctScore[index],
        })),
      ];
    }
  }

  pricingPersistenceFields() {
    if (!this.pricingModel) return {};
    return {
      pricingModel: this.pricingModel,
      pricingModelCreatedAt: this.pricingModelCreatedAt,
      pricingRules: this.pricingRules,
      marketModelPublicationPending: true,
    };
  }
}

export default EventTemplate;
