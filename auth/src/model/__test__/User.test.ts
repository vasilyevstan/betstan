import { User } from "../User";

it("serializes only public user fields", () => {
  const user = User.hydrate({
    email: "Public@Test.com",
    identifierNormalized: "public@test.com",
    password: "hashed-password",
    timestamp: "2026-07-30T12:00:00.000Z",
    lastLogin: "2026-07-30T13:00:00.000Z",
    internalField: "must-not-leak",
  });

  const serialized = user.toJSON();

  expect(serialized).toMatchObject({
    email: "Public@Test.com",
    timestamp: "2026-07-30T12:00:00.000Z",
    lastLogin: "2026-07-30T13:00:00.000Z",
  });
  expect(serialized).toHaveProperty("_id");
  expect(serialized).not.toHaveProperty("password");
  expect(serialized).not.toHaveProperty("identifierNormalized");
  expect(serialized).not.toHaveProperty("__v");
  expect(serialized).not.toHaveProperty("internalField");
});
