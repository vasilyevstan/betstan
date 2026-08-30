import request from "supertest";
import { app } from "../../app";
import { User, UserRole } from "../../model/User";
import { buildSessionCookie } from "../../test/session";

async function loginAsAdmin() {
  const user = await User.create({
    email: "admin-user",
    identifierNormalized: "admin-user",
    password: "password",
    role: UserRole.ADMIN,
  });
  const response = await request(app)
    .post("/api/auth/login")
    .send({ email: user.email, password: "password" })
    .expect(200);

  return {
    cookie: response.get("Set-Cookie")!,
    user,
  };
}

it("rejects a missing session", async () => {
  await request(app).get("/api/auth/admin/verify").expect(401);
});

it("rejects an authenticated non-admin user", async () => {
  const signup = await request(app)
    .post("/api/auth/new")
    .send({ email: "standard-user", password: "password" })
    .expect(201);

  await request(app)
    .get("/api/auth/admin/verify")
    .set("Cookie", signup.get("Set-Cookie")!)
    .expect(403);
});

it("accepts a signed token whose persisted user remains an administrator", async () => {
  const { cookie } = await loginAsAdmin();

  await request(app)
    .get("/api/auth/admin/verify")
    .set("Cookie", cookie)
    .expect(204);
});

it("revokes an existing admin token after the persisted role is demoted", async () => {
  const { cookie, user } = await loginAsAdmin();
  await User.updateOne({ _id: user._id }, { $set: { role: UserRole.USER } });

  await request(app)
    .get("/api/auth/admin/verify")
    .set("Cookie", cookie)
    .expect(401);
});

it("revokes an existing admin token after the user is deleted", async () => {
  const { cookie, user } = await loginAsAdmin();
  await User.deleteOne({ _id: user._id });

  await request(app)
    .get("/api/auth/admin/verify")
    .set("Cookie", cookie)
    .expect(401);
});

it("rejects an expired legacy administrator token without exp", async () => {
  const user = await User.create({
    email: "expired-admin",
    identifierNormalized: "expired-admin",
    password: "password",
    role: UserRole.ADMIN,
  });

  await request(app)
    .get("/api/auth/admin/verify")
    .set(
      "Cookie",
      buildSessionCookie({
        id: user.id,
        email: user.email,
        role: UserRole.ADMIN,
        timestamp: new Date(Date.now() - 13 * 60 * 60 * 1000),
      })
    )
    .expect(401);
});
