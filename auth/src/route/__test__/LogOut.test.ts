import request from "supertest";
import { app } from "../../app";

it("clears the cookie on logout", async () => {
  await request(app)
    .post("/api/auth/new")
    .send({ email: "test@test.com", password: "password" })
    .expect(201);

  const loginResponse = await request(app)
    .post("/api/auth/login")
    .send({ email: "test@test.com", password: "password" })
    .expect(200);

  expect(loginResponse.get("Set-Cookie")).toBeDefined();

  const logoutResponse = await request(app)
    .post("/api/auth/logout")
    .set("Cookie", loginResponse.get("Set-Cookie")!)
    .send({})
    .expect(200);

  expect(logoutResponse.body).toEqual({});
});

it("returns 200 even without a session", async () => {
  await request(app).post("/api/auth/logout").send({}).expect(200);
});
