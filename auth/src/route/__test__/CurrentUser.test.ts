import request from "supertest";
import { app } from "../../app";

it("returns null if not authenticated", async () => {
  const response = await request(app)
    .get("/api/auth/currentuser")
    .send()
    .expect(200);

  expect(response.body.currentUser).toBeNull();
});

it("returns current user info when authenticated", async () => {
  const signupResponse = await request(app)
    .post("/api/auth/new")
    .send({ email: "test@test.com", password: "password" })
    .expect(201);

  const cookie = signupResponse.get("Set-Cookie")!;

  const response = await request(app)
    .get("/api/auth/currentuser")
    .set("Cookie", cookie)
    .send()
    .expect(200);

  expect(response.body.currentUser).not.toBeNull();
  expect(response.body.currentUser.email).toEqual("test@test.com");
});
