import request from "supertest";
import { app } from "../../app";
import { User, UserRole } from "../../model/User";
import { buildSessionCookie } from "../../test/session";

const createPlayer = async (email = "profile-player") => {
  const user = await User.create({ email, password: "password" });
  const cookie = buildSessionCookie({
    id: user.id, email: user.email, role: UserRole.USER, timestamp: new Date(),
  });
  return { user, cookie };
};

it.each(["profile-player", "player@example.com"])(
  "initializes new profile names from the login %s without changing the signup contract",
  async (email) => {
    const signup = await request(app).post("/api/auth/new")
      .send({ email, password: "password", displayName: "Ignored" }).expect(201);
    expect(signup.body).toEqual({ id: expect.any(String), email, role: "USER" });
    const response = await request(app).get("/api/auth/currentuser")
      .set("Cookie", signup.get("Set-Cookie")!).expect(200);
    expect(response.body.currentUser.displayName).toBe(email);
    expect((await User.findById(signup.body.id))?.displayName).toBe(email);
    expect(response.headers["cache-control"]).toBe("no-store");
  }
);

it("falls back to the full persisted login for a legacy profile", async () => {
  const { user, cookie } = await createPlayer("Legacy.Player@example.com");
  const response = await request(app).get("/api/auth/currentuser")
    .set("Cookie", cookie).expect(200);
  expect(response.body.currentUser.displayName).toBe(user.email);
  expect((await User.findById(user.id))?.displayName).toBeUndefined();
});

it("persists a trimmed Unicode name without changing credentials or another account", async () => {
  const { user, cookie } = await createPlayer();
  const other = await createPlayer("another-player");
  const originalPassword = user.password;
  const response = await request(app).patch("/api/auth/profile")
    .set("Cookie", cookie).send({ displayName: "  Zoë Player  " }).expect(200);
  expect(response.body).toEqual({ displayName: "Zoë Player" });
  expect(response.headers["cache-control"]).toBe("no-store");
  const stored = await User.findById(user.id);
  expect(stored?.email).toBe(user.email);
  expect(stored?.password).toBe(originalPassword);
  expect(stored?.role).toBe(UserRole.USER);
  expect((await User.findById(other.user.id))?.displayName).toBeUndefined();

  const current = await request(app).get("/api/auth/currentuser")
    .set("Cookie", cookie).expect(200);
  expect(current.body.currentUser.displayName).toBe("Zoë Player");
  expect(current.text).not.toContain(originalPassword);
  expect(current.body.currentUser).not.toHaveProperty("identifierNormalized");

  const login = await request(app).post("/api/auth/login")
    .send({ email: user.email, password: "password" }).expect(200);
  const reloaded = await request(app).get("/api/auth/currentuser")
    .set("Cookie", login.get("Set-Cookie")!).expect(200);
  expect(reloaded.body.currentUser.displayName).toBe("Zoë Player");
});

it.each([
  "", "   ", "a".repeat(255), "Two\nlines", "\tPlayer", "Player\u0000", "Two\u2028lines",
  null, 123, ["Player"], { $set: "Player" },
])("rejects an invalid display name %p", async (displayName) => {
  const { user, cookie } = await createPlayer();
  await request(app).patch("/api/auth/profile").set("Cookie", cookie)
    .send({ displayName }).expect(400);
  expect((await User.findById(user.id))?.displayName).toBeUndefined();
});

it("accepts a maximum-length name and does not require names to be unique", async () => {
  for (const email of ["first-player", "second-player"]) {
    const { cookie } = await createPlayer(email);
    await request(app).patch("/api/auth/profile").set("Cookie", cookie)
      .send({ displayName: "N".repeat(254) }).expect(200);
  }
});

it.each([
  { role: "ADMIN" }, { email: "new-login" }, { password: "new-password" },
  { userId: "another-player" }, { unknown: true },
])("rejects additional profile fields %p", async (extra) => {
  const { user, cookie } = await createPlayer();
  await request(app).patch("/api/auth/profile").set("Cookie", cookie)
    .send({ displayName: "New name", ...extra }).expect(400);
  expect((await User.findById(user.id))?.displayName).toBeUndefined();
});

it("rejects query owner selectors and missing fields", async () => {
  const { cookie } = await createPlayer();
  await request(app).patch("/api/auth/profile?userId=another-player")
    .set("Cookie", cookie).send({ displayName: "New name" }).expect(400);
  await request(app).patch("/api/auth/profile").set("Cookie", cookie)
    .send({}).expect(400);
});

it("rejects anonymous profile updates", async () => {
  const response = await request(app).patch("/api/auth/profile")
    .send({ displayName: "New name" }).expect(401);
  expect(response.headers["cache-control"]).toBe("no-store");
});

it.each(["expired", "deleted", "role-changed", "future"])(
  "rejects a %s session before writing the name",
  async (state) => {
    const { user } = await createPlayer();
    const timestamp = new Date(Date.now() + (state === "expired" ? -13 * 3600000
      : state === "future" ? 6 * 60000 : 0));
    const cookie = buildSessionCookie({
      id: user.id, email: user.email, role: UserRole.USER, timestamp,
    });
    if (state === "deleted") await User.deleteOne({ _id: user._id });
    if (state === "role-changed") await User.updateOne({ _id: user._id }, { role: UserRole.ADMIN });
    await request(app).patch("/api/auth/profile").set("Cookie", cookie)
      .send({ displayName: "New name" }).expect(401);
    expect((await User.findById(user.id))?.displayName).toBeUndefined();
  }
);

it("lets a role-free legacy session edit its own role-free account", async () => {
  const { user } = await createPlayer();
  await User.collection.updateOne({ _id: user._id }, { $unset: { role: "" } });
  const cookie = buildSessionCookie({
    id: user.id, email: user.email, timestamp: new Date(),
  });
  await request(app).patch("/api/auth/profile").set("Cookie", cookie)
    .send({ displayName: "Legacy player" }).expect(200);
  expect((await User.findById(user.id))?.displayName).toBe("Legacy player");
});
