import request from "supertest";
import { app } from "../../app";
import { User, UserRole } from "../../model/User";
import { buildSessionCookie } from "../../test/session";

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
  expect(response.body.currentUser.role).toEqual("USER");
});

it("normalizes a legacy role-free session to USER", async () => {
  const user = await User.create({
    email: "legacy-session",
    identifierNormalized: "legacy-session",
    password: "password",
  });
  await User.collection.updateOne(
    { _id: user._id },
    { $unset: { role: "" } }
  );

  const response = await request(app)
    .get("/api/auth/currentuser")
    .set(
      "Cookie",
      buildSessionCookie({
        id: user.id,
        email: user.email,
        timestamp: new Date(),
      })
    )
    .expect(200);

  expect(response.body.currentUser.role).toEqual("USER");
});

it("clears an existing session when the persisted role changes", async () => {
  const user = await User.create({
    email: "demoted-session",
    identifierNormalized: "demoted-session",
    password: "password",
    role: UserRole.ADMIN,
  });
  const cookie = buildSessionCookie({
    id: user.id,
    email: user.email,
    role: UserRole.ADMIN,
    timestamp: new Date(),
  });
  await User.updateOne({ _id: user._id }, { $set: { role: UserRole.USER } });

  const response = await request(app)
    .get("/api/auth/currentuser")
    .set("Cookie", cookie)
    .expect(200);

  expect(response.body.currentUser).toBeNull();
});

it("expires legacy tokens without exp from their signed timestamp", async () => {
  const user = await User.create({
    email: "expired-session",
    identifierNormalized: "expired-session",
    password: "password",
    role: UserRole.USER,
  });

  const response = await request(app)
    .get("/api/auth/currentuser")
    .set(
      "Cookie",
      buildSessionCookie({
        id: user.id,
        email: user.email,
        role: UserRole.USER,
        timestamp: new Date(Date.now() - 13 * 60 * 60 * 1000),
      })
    )
    .expect(200);

  expect(response.body.currentUser).toBeNull();
});
