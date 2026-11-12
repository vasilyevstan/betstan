import EventTemplate from "../EventTemplate";
import { ProductType } from "../product/ProductType";
import { priceScoreCombination } from "@betstan/common";
import { Event } from "../../model/Event";

it("uses explicit constructor values when provided", () => {
  const eventTemplate = new EventTemplate(
    "event-id",
    "Team A",
    "Team B",
    "2030-01-01T12:00:00.000Z"
  );

  expect(eventTemplate.eventId).toEqual("event-id");
  expect(eventTemplate.home).toEqual("Team A");
  expect(eventTemplate.away).toEqual("Team B");
  expect(eventTemplate.name).toEqual("Team A - Team B");
  expect(eventTemplate.time.toISOString()).toEqual("2030-01-01T12:00:00.000Z");
  expect(eventTemplate.products).toHaveLength(2);
});

it("generates fallback ids, teams, and times when constructor values are omitted", () => {
  const eventTemplate = new EventTemplate();

  expect(eventTemplate.eventId).toEqual(expect.any(String));
  expect(eventTemplate.home).toEqual(expect.any(String));
  expect(eventTemplate.away).toEqual(expect.any(String));
  expect(eventTemplate.name).toContain(" - ");
  expect(eventTemplate.time).toBeInstanceOf(Date);
  expect(eventTemplate.products).toHaveLength(2);
});

describe("coherent pre-match pricing (once per template)", () => {
  it("prices the 1X2 product with the existing {id,name,value} odds shape and finite, sensible values", () => {
    const eventTemplate = new EventTemplate("event-id", "Team A", "Team B");
    const oneCrossTwo = eventTemplate.products.find((product) => product.type === ProductType.ONE_CROSS_TWO);

    expect(oneCrossTwo).toBeDefined();
    expect(oneCrossTwo?.odds).toHaveLength(3);
    oneCrossTwo?.odds.forEach((odd) => {
      expect(odd).toEqual(expect.objectContaining({
        id: expect.any(String),
        name: expect.any(String),
        value: expect.any(Number),
      }));
      expect(Number.isFinite(odd.value)).toBe(true);
      expect(odd.value).toBeGreaterThanOrEqual(1.01);
    });

    expect(oneCrossTwo?.odds.map((odd) => odd.name)).toEqual(["Team A", "draw", "Team B"]);
  });

  it("prices the Correct Score product with ~10 distinct, plausible low-score options and no implausible outcome", () => {
    const eventTemplate = new EventTemplate("event-id", "Team A", "Team B");
    const correctScore = eventTemplate.products.find((product) => product.type === ProductType.CORRECT_SCORE);

    expect(correctScore).toBeDefined();
    expect(correctScore?.odds).toHaveLength(10);

    const names = correctScore?.odds.map((odd) => odd.name) ?? [];
    expect(new Set(names).size).toBe(names.length);

    correctScore?.odds.forEach((odd) => {
      expect(odd).toEqual(expect.objectContaining({
        id: expect.any(String),
        name: expect.any(String),
        value: expect.any(Number),
      }));
      expect(Number.isFinite(odd.value)).toBe(true);
      expect(odd.value).toBeGreaterThanOrEqual(1.01);

      const [homeGoalsText, awayGoalsText] = odd.name.split(" - ");
      expect(Number(homeGoalsText)).toBeLessThan(7);
      expect(Number(awayGoalsText)).toBeLessThan(7);
    });
  });

  it("generates independently-priced products across separate templates (each event gets its own coherent distribution)", () => {
    const first = new EventTemplate("event-1", "Team A", "Team B");
    const second = new EventTemplate("event-2", "Team C", "Team D");

    const firstOneCrossTwo = first.products.find((product) => product.type === ProductType.ONE_CROSS_TWO);
    const secondOneCrossTwo = second.products.find((product) => product.type === ProductType.ONE_CROSS_TWO);

    expect(firstOneCrossTwo?.odds.every((odd) => Number.isFinite(odd.value))).toBe(true);
    expect(secondOneCrossTwo?.odds.every((odd) => Number.isFinite(odd.value))).toBe(true);
  });
});

describe("retained market pricing", () => {
  const previousFlag = process.env.EXTENSIBLE_MARKETS_ENABLED;
  afterEach(() => {
    if (previousFlag === undefined) delete process.env.EXTENSIBLE_MARKETS_ENABLED;
    else process.env.EXTENSIBLE_MARKETS_ENABLED = previousFlag;
  });

  it("keeps the legacy generation unchanged while new writers are disabled", () => {
    delete process.env.EXTENSIBLE_MARKETS_ENABLED;
    const template = new EventTemplate();
    expect(template.pricingModel).toBeUndefined();
    expect(template.pricingPersistenceFields()).toEqual({});
  });

  it("retains the exact model and typed rules used to price every standard selection", async () => {
    process.env.EXTENSIBLE_MARKETS_ENABLED = "true";
    const template = new EventTemplate("retained-event", "Home", "Away", "2030-01-01T12:00:00.000Z");
    const rules = template.pricingRules!;
    expect(rules).toHaveLength(13);
    for (const product of template.products) {
      for (const odd of product.odds) {
        const selected = rules.find(rule => rule.productId === product.id && rule.oddsId === odd.id);
        expect(selected).toBeDefined();
        expect(priceScoreCombination(template.pricingModel, [selected!.rule])).toBe(odd.value);
      }
    }
    await Event.create({
      eventId: template.eventId, name: template.name, time: template.time,
      home: template.home, away: template.away, products: template.products,
      ...template.pricingPersistenceFields(),
    });
    const stored = await Event.findOne({ eventId: template.eventId })
      .select("+pricingModel +pricingRules +pricingModelCreatedAt +marketModelPublicationPending").lean();
    expect(stored?.pricingModel).toEqual(template.pricingModel);
    expect(stored?.pricingRules).toEqual(rules);
    expect(stored?.marketModelPublicationPending).toBe(true);
    expect(stored?.pricingModelCreatedAt).toBe(template.pricingModelCreatedAt);
    const catalog = await Event.findOne({ eventId: template.eventId }).lean();
    expect(catalog?.pricingModel).toBeUndefined();
    expect(catalog?.pricingRules).toBeUndefined();
  });
});
