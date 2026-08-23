import request from "supertest";
import jwt from "jsonwebtoken";
import { app } from "../../app";
import { User, UserRole } from "../../model/User";

const createUser = async (identifier = "test@test.com") => {
  await request(app)
    .post("/api/auth/new")
    .send({ email: identifier, password: "password" })
    .expect(201);
};

const sessionPayload = (setCookie: string[]) => {
  const encodedSession = /^session=([^;]+)/.exec(setCookie[0])?.[1];
  if (!encodedSession) {
    throw new Error("Session cookie was not set");
  }

  const session = JSON.parse(
    Buffer.from(decodeURIComponent(encodedSession), "base64").toString("utf8")
  );
  return jwt.verify(session.jwt, process.env.JWT_KEY!) as jwt.JwtPayload;
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
    role: "USER",
  });
  expect(response.body.password).toBeUndefined();
  expect(response.body.identifierNormalized).toBeUndefined();
  expect(response.get("Set-Cookie")).toBeDefined();
  const payload = sessionPayload(response.get("Set-Cookie")!);
  expect(payload.role).toEqual("USER");
  expect(Number(payload.exp) - Number(payload.iat)).toEqual(12 * 60 * 60);
});

it("signs the persisted administrator role after login", async () => {
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

  expect(response.body.role).toEqual("ADMIN");
  expect(sessionPayload(response.get("Set-Cookie")!).role).toEqual("ADMIN");
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

it("normalizes a legacy user without a role to USER", async () => {
  const user = await User.create({
    email: "legacy-role-user",
    identifierNormalized: "legacy-role-user",
    password: "password",
  });
  await User.collection.updateOne(
    { _id: user._id },
    { $unset: { role: "" } }
  );

  const response = await request(app)
    .post("/api/auth/login")
    .send({ email: "legacy-role-user", password: "password" })
    .expect(200);

  expect(response.body.role).toEqual("USER");
  expect((await User.collection.findOne({ _id: user._id }))?.role).toEqual(
    "USER"
  );
});

it.each(["Pelé@example.com", '"quoted local"@example.com'])(
  "continues to log in a legacy %s email record",
  async (email) => {
    await User.create({
      email,
      password: "password",
      timestamp: new Date().toISOString(),
      lastLogin: new Date().toISOString(),
    });

    await request(app)
      .post("/api/auth/login")
      .send({ email, password: "password" })
      .expect(200);
  }
);

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
