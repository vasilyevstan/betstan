import { createLiveSeed, isPrivateLiveSeed } from "../liveSeed";

it("creates independent 256-bit hexadecimal seeds", () => {
  const first = createLiveSeed();
  const second = createLiveSeed();

  expect(first).toMatch(/^[a-f0-9]{64}$/);
  expect(second).toMatch(/^[a-f0-9]{64}$/);
  expect(second).not.toBe(first);
});

it("rejects public identifiers and weak legacy seeds", () => {
  expect(isPrivateLiveSeed("public-event-id")).toBe(false);
  expect(isPrivateLiveSeed("a".repeat(63))).toBe(false);
  expect(isPrivateLiveSeed("A".repeat(64))).toBe(false);
  expect(isPrivateLiveSeed("a".repeat(64))).toBe(true);
});
