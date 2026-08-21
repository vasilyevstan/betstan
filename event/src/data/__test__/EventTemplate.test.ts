import EventTemplate from "../EventTemplate";

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
