import request from "supertest";
import { app } from "../../app";

const createUser = async () => {
  await request(app)
    .post("/api/auth/new")
    .send({ email: "test@test.com", password: "password" })
    .expect(201);
};

it("returns 200 on successful login", async () => {
  await createUser();

  const response = await request(app)
    .post("/api/auth/login")
    .send({ email: "test@test.com", password: "password" })
    .expect(200);

  expect(response.get("Set-Cookie")).toBeDefined();
});

it("returns 400 with an invalid email", async () => {
  await request(app)
    .post("/api/auth/login")
    .send({ email: "not-an-email", password: "password" })
    .expect(400);
});

it("returns 400 with missing password", async () => {
  await request(app)
    .post("/api/auth/login")
    .send({ email: "test@test.com" })
    .expect(400);
});

it("returns 400 when email does not exist", async () => {
  await request(app)
    .post("/api/auth/login")
    .send({ email: "nonexistent@test.com", password: "password" })
    .expect(400);
});

it("returns 400 with wrong password", async () => {
  await createUser();

  await request(app)
    .post("/api/auth/login")
    .send({ email: "test@test.com", password: "wrongpassword" })
    .expect(400);
});

it("sets a cookie after successful login", async () => {
  await createUser();

  const response = await request(app)
    .post("/api/auth/login")
    .send({ email: "test@test.com", password: "password" })
    .expect(200);

  expect(response.get("Set-Cookie")).toBeDefined();
});
