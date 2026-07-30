import request from "supertest";
import { app } from "../../app";
import { User } from "../../model/User";

const createUser = async (identifier = "test@test.com") => {
  await request(app)
    .post("/api/auth/new")
    .send({ email: identifier, password: "password" })
    .expect(201);
};

it("logs in with a non-email username regardless of case", async () => {
  await createUser("Stan_1");

  const response = await request(app)
    .post("/api/auth/login")
    .send({ email: "stan_1", password: "password" })
    .expect(200);

  expect(response.body).toEqual({
    id: expect.any(String),
    email: "Stan_1",
  });
  expect(response.body.password).toBeUndefined();
  expect(response.body.identifierNormalized).toBeUndefined();
  expect(response.get("Set-Cookie")).toBeDefined();
});

it("continues to log in a legacy email record", async () => {
  await User.create({
    email: "Legacy@Test.com",
    password: "password",
    timestamp: new Date().toISOString(),
    lastLogin: new Date().toISOString(),
  });

  await request(app)
    .post("/api/auth/login")
    .send({ email: "Legacy@Test.com", password: "password" })
    .expect(200);
});

it.each([
  ["an object identifier", { $gt: "" }],
  ["an array identifier", ["testuser"]],
  ["an identifier containing spaces", "test user"],
])("returns 400 with %s", async (_description, email) => {
  await request(app)
    .post("/api/auth/login")
    .send({ email, password: "password" })
    .expect(400);
});

it("returns 400 with a missing password", async () => {
  await request(app)
    .post("/api/auth/login")
    .send({ email: "testuser" })
    .expect(400);
});

it("returns 400 when the username does not exist", async () => {
  await request(app)
    .post("/api/auth/login")
    .send({ email: "missing-user", password: "password" })
    .expect(400);
});

it("returns 400 with the wrong password", async () => {
  await createUser("testuser");

  await request(app)
    .post("/api/auth/login")
    .send({ email: "testuser", password: "wrongpassword" })
    .expect(400);
});
