import request from "supertest";
import { app } from "../../app";

it("returns 201 on successful signup", async () => {
  const response = await request(app)
    .post("/api/auth/new")
    .send({ email: "test@test.com", password: "password" })
    .expect(201);

  expect(response.body.email).toEqual("test@test.com");
});

it("returns 400 with an invalid email", async () => {
  await request(app)
    .post("/api/auth/new")
    .send({ email: "not-an-email", password: "password" })
    .expect(400);
});

it("returns 400 with a password that is too short", async () => {
  await request(app)
    .post("/api/auth/new")
    .send({ email: "test@test.com", password: "ab" })
    .expect(400);
});

it("returns 400 with a password that is too long", async () => {
  await request(app)
    .post("/api/auth/new")
    .send({ email: "test@test.com", password: "a".repeat(21) })
    .expect(400);
});

it("returns 400 with missing email or password", async () => {
  await request(app).post("/api/auth/new").send({ email: "test@test.com" }).expect(400);
  await request(app).post("/api/auth/new").send({ password: "password" }).expect(400);
});

it("disallows duplicate emails", async () => {
  await request(app)
    .post("/api/auth/new")
    .send({ email: "test@test.com", password: "password" })
    .expect(201);

  await request(app)
    .post("/api/auth/new")
    .send({ email: "test@test.com", password: "password" })
    .expect(400);
});

it("sets a cookie after successful signup", async () => {
  const response = await request(app)
    .post("/api/auth/new")
    .send({ email: "test@test.com", password: "password" })
    .expect(201);

  expect(response.get("Set-Cookie")).toBeDefined();
});
