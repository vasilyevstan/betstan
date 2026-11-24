import request from "supertest";
import { app } from "../../app";
import { User, UserRole } from "../../model/User";
import { Password } from "../../service/Password";

const createUser = async (identifier: string, password = "oldpass1") => {
  const response = await request(app)
    .post("/api/auth/new")
    .send({ email: identifier, password })
    .expect(201);
  return response;
};

const login = (identifier: string, password: string) =>
  request(app).post("/api/auth/login").send({ email: identifier, password });

const forgotPassword = (body?: object) =>
  request(app).post("/api/auth/forgot-password").send(body);

const snapshotUsers = async () =>
  JSON.stringify(await User.find().sort({ _id: 1 }).lean());

const storedPassword = async (identifierNormalized: string) =>
  (await User.findOne({ identifierNormalized }))!.password;

describe("POST /api/auth/forgot-password", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("resets the account to abcdef so only that password logs in", async () => {
    await createUser("testuser", "oldpass1");

    const response = await forgotPassword({ email: "testuser" }).expect(200);

    expect(response.body).toEqual({ status: "ok" });
    await login("testuser", "abcdef").expect(200);
    await login("testuser", "oldpass1").expect(400);
  });

  it("stores a salted scrypt hash like any other password, never the text", async () => {
    await createUser("testuser");

    await forgotPassword({ email: "testuser" }).expect(200);

    const stored = await storedPassword("testuser");
    expect(stored).toMatch(/^[a-f0-9]{128}\.[a-f0-9]{16}$/);
    expect(await Password.compare(stored, "abcdef")).toBe(true);
  });

  it("matches the identifier case-insensitively and ignores surrounding spaces", async () => {
    await createUser("Stan_1");

    await forgotPassword({ email: "  sTAN_1 " }).expect(200);

    await login("stan_1", "abcdef").expect(200);
    await login("Stan_1", "oldpass1").expect(400);
  });

  it.each(["Legacy@Test.com", "Pelé@example.com", '"quoted local"@example.com'])(
    "resets a legacy %s record that has no normalized identifier",
    async (email) => {
      const legacy = await User.create({
        email,
        password: "oldpass1",
        timestamp: new Date().toISOString(),
        lastLogin: new Date().toISOString(),
      });

      await forgotPassword({ email }).expect(200);

      await login(email, "abcdef").expect(200);
      await login(email, "oldpass1").expect(400);
      expect((await User.findById(legacy._id))?.identifierNormalized).toBeUndefined();
    }
  );

  it("resolves the account the way login does: normalized identifier before legacy email", async () => {
    await User.create({ email: "Foo", identifierNormalized: "foo", password: "oldpass1" });
    const legacy = await User.create({ email: "foo", password: "legacypass1" });

    await forgotPassword({ email: "foo" }).expect(200);

    await login("foo", "abcdef").expect(200);
    const untouched = (await User.findById(legacy._id))!.password;
    expect(await Password.compare(untouched, "legacypass1")).toBe(true);
    expect(await Password.compare(untouched, "abcdef")).toBe(false);
  });

  it("resets only the named account", async () => {
    await createUser("target-user", "oldpass1");
    await createUser("bystander", "otherpass1");

    await forgotPassword({ email: "target-user" }).expect(200);

    await login("bystander", "otherpass1").expect(200);
    await login("bystander", "abcdef").expect(400);
  });

  it("changes nothing but the password hash", async () => {
    await createUser("testuser");
    const { password: before, ...beforeRest } = (await User.collection.findOne({
      identifierNormalized: "testuser",
    }))!;

    await forgotPassword({ email: "testuser" }).expect(200);

    const { password: after, ...afterRest } = (await User.collection.findOne({
      identifierNormalized: "testuser",
    }))!;
    expect(afterRest).toEqual(beforeRest);
    expect(after).not.toEqual(before);
  });

  it("resets an administrator exactly like any other account", async () => {
    await User.create({
      email: "admin-user",
      identifierNormalized: "admin-user",
      password: "oldpass1",
      role: UserRole.ADMIN,
    });

    await forgotPassword({ email: "ADMIN-user" }).expect(200);

    const response = await login("admin-user", "abcdef").expect(200);
    expect(response.body.role).toEqual("ADMIN");
    await login("admin-user", "oldpass1").expect(400);
    expect((await User.findOne({ identifierNormalized: "admin-user" }))?.role).toEqual(
      UserRole.ADMIN
    );
  });

  it("ignores any password, role or identifier supplied in the body", async () => {
    await createUser("testuser", "oldpass1");

    await forgotPassword({
      email: "testuser",
      password: "hacked123",
      role: "ADMIN",
      identifierNormalized: "someone-else",
    }).expect(200);

    await login("testuser", "abcdef").expect(200);
    await login("testuser", "hacked123").expect(400);
    expect((await User.findOne({ identifierNormalized: "testuser" }))?.role).toEqual("USER");
  });

  it("is idempotent and gives each reset a fresh salt", async () => {
    await createUser("testuser");

    await forgotPassword({ email: "testuser" }).expect(200);
    const first = await storedPassword("testuser");
    await forgotPassword({ email: "testuser" }).expect(200);
    const second = await storedPassword("testuser");

    expect(second).not.toEqual(first);
    expect(await Password.compare(second, "abcdef")).toBe(true);
    await login("testuser", "abcdef").expect(200);
  });

  it("leaves the account usable after concurrent resets", async () => {
    await createUser("testuser");

    const responses = await Promise.all([
      forgotPassword({ email: "testuser" }),
      forgotPassword({ email: "testuser" }),
    ]);

    expect(responses.map(({ status }) => status)).toEqual([200, 200]);
    await login("testuser", "abcdef").expect(200);
  });

  describe("account enumeration", () => {
    it("answers an unknown identifier exactly like a known one and changes nothing", async () => {
      await createUser("known-user", "oldpass1");
      await createUser("other-user", "otherpass1");
      const before = await snapshotUsers();

      const unknown = await forgotPassword({ email: "missing-user" });
      expect(await snapshotUsers()).toEqual(before);
      const known = await forgotPassword({ email: "known-user" });

      expect(unknown.status).toBe(200);
      expect(known.status).toBe(unknown.status);
      expect(known.text).toBe(unknown.text);
      expect(known.body).toEqual(unknown.body);
      const { date: _knownDate, ...knownHeaders } = known.headers;
      const { date: _unknownDate, ...unknownHeaders } = unknown.headers;
      expect(knownHeaders).toEqual(unknownHeaders);
      expect(known.get("Set-Cookie")).toBeUndefined();
      expect(unknown.get("Set-Cookie")).toBeUndefined();
      await login("other-user", "otherpass1").expect(200);
    });

    it("hashes once per request whether or not the account exists", async () => {
      await createUser("known-user");
      const toHash = jest.spyOn(Password, "toHash");

      await forgotPassword({ email: "known-user" }).expect(200);
      await forgotPassword({ email: "missing-user" }).expect(200);

      expect(toHash).toHaveBeenCalledTimes(2);
      expect(toHash).toHaveBeenNthCalledWith(1, "abcdef");
      expect(toHash).toHaveBeenNthCalledWith(2, "abcdef");
    });
  });

  describe("sessions and logging", () => {
    it("sets no cookie and leaves an existing session valid", async () => {
      const signup = await createUser("sessionuser", "oldpass1");
      const sessionCookie = signup.get("Set-Cookie")!;

      const response = await forgotPassword({ email: "sessionuser" })
        .set("Cookie", sessionCookie)
        .expect(200);

      expect(response.get("Set-Cookie")).toBeUndefined();
      const current = await request(app)
        .get("/api/auth/currentuser")
        .set("Cookie", sessionCookie)
        .expect(200);
      expect(current.body.currentUser).toMatchObject({ email: "sessionuser" });
    });

    it("never logs the reset password or one supplied in the body", async () => {
      await createUser("loguser");
      const spies = (["log", "info", "warn", "error"] as const).map((method) =>
        jest.spyOn(console, method).mockImplementation(() => undefined)
      );

      await forgotPassword({ email: "loguser", password: "supplied-secret" }).expect(200);
      await forgotPassword({ email: "missing-user", password: "supplied-secret" }).expect(200);

      for (const spy of spies) {
        expect(JSON.stringify(spy.mock.calls)).not.toMatch(/abcdef|supplied-secret/);
      }
    });
  });

  describe("validation", () => {
    it.each([
      ["a missing body", undefined],
      ["a missing identifier", {}],
      ["a blank identifier", { email: "   " }],
      ["an object identifier", { email: { $gt: "" } }],
      ["an array identifier", { email: ["testuser"] }],
      ["a numeric identifier", { email: 12345 }],
      ["an identifier containing spaces", { email: "test user" }],
      ["an identifier with unsupported punctuation", { email: "stan!" }],
      ["an identifier that is too short", { email: "ab" }],
      ["a username that is too long", { email: `s${"a".repeat(40)}` }],
      ["an email that is too long", { email: `${"a".repeat(250)}@example.com` }],
    ])("returns 400 for %s and changes nothing", async (_description, body) => {
      await createUser("testuser", "oldpass1");
      await createUser("other-user", "otherpass1");
      const before = await snapshotUsers();

      const response = await forgotPassword(body).expect(400);

      expect(response.body.errors.length).toBeGreaterThan(0);
      for (const error of response.body.errors) {
        expect(error.msg).toEqual(expect.any(String));
      }
      expect(response.get("Set-Cookie")).toBeUndefined();
      expect(await snapshotUsers()).toEqual(before);
    });
  });
});
