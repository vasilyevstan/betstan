import request from "supertest";
import { app } from "../../app";
import { User } from "../../model/User";

it("creates an account with a non-email username", async () => {
  const response = await request(app)
    .post("/api/auth/new")
    .send({ email: "stan_1", password: "password" })
    .expect(201);

  expect(response.body).toEqual({
    id: expect.any(String),
    email: "stan_1",
  });
  expect(response.body.password).toBeUndefined();
  expect(response.body.identifierNormalized).toBeUndefined();

  const user = await User.findOne({ email: "stan_1" });
  expect(user?.identifierNormalized).toEqual("stan_1");
});

it.each([
  "test@test.com",
  "Pelé@example.com",
  '"quoted local"@example.com',
])("continues to accept the email %s", async (email) => {
  const response = await request(app)
    .post("/api/auth/new")
    .send({ email, password: "password" })
    .expect(201);

  expect(response.body.email).toEqual(email);
});

it.each([
  ["a username that is too short", "ab"],
  ["a username containing spaces", "stan user"],
  ["a username containing unsupported punctuation", "stan!"],
  ["an object identifier", { $gt: "" }],
  ["an array identifier", ["stan"]],
])("returns 400 with %s", async (_description, email) => {
  await request(app)
    .post("/api/auth/new")
    .send({ email, password: "password" })
    .expect(400);
});

it("returns 400 with a username that is too long", async () => {
  await request(app)
    .post("/api/auth/new")
    .send({ email: `s${"a".repeat(40)}`, password: "password" })
    .expect(400);
});

it("returns 400 with a password that is too short", async () => {
  await request(app)
    .post("/api/auth/new")
    .send({ email: "testuser", password: "ab" })
    .expect(400);
});

it("returns 400 with a password that is too long", async () => {
  await request(app)
    .post("/api/auth/new")
    .send({ email: "testuser", password: "a".repeat(21) })
    .expect(400);
});

it("returns 400 with a missing username or password", async () => {
  await request(app)
    .post("/api/auth/new")
    .send({ email: "testuser" })
    .expect(400);
  await request(app)
    .post("/api/auth/new")
    .send({ password: "password" })
    .expect(400);
});

it("rejects usernames that differ only by case", async () => {
  await request(app)
    .post("/api/auth/new")
    .send({ email: "Stan_1", password: "password" })
    .expect(201);

  await request(app)
    .post("/api/auth/new")
    .send({ email: "stan_1", password: "password" })
    .expect(400);
});

it("enforces username uniqueness for concurrent requests", async () => {
  await User.init();

  const responses = await Promise.all([
    request(app)
      .post("/api/auth/new")
      .send({ email: "concurrent-user", password: "password" }),
    request(app)
      .post("/api/auth/new")
      .send({ email: "concurrent-user", password: "password" }),
  ]);

  expect(responses.map(({ status }) => status).sort()).toEqual([201, 400]);
  expect(
    await User.countDocuments({ identifierNormalized: "concurrent-user" })
  ).toEqual(1);
});

it("sets a cookie after successful signup", async () => {
  const response = await request(app)
    .post("/api/auth/new")
    .send({ email: "testuser", password: "password" })
    .expect(201);

  expect(response.get("Set-Cookie")).toBeDefined();
});
