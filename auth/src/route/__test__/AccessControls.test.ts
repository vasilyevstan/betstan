import request from "supertest";
import { app } from "../../app";
import { User, UserRole } from "../../model/User";

const path = "/internal/access-controls";
const setSwitch = (name: string, enabled: boolean, expectedEnabled: boolean) =>
  request(app).put(`${path}/${name}`).send({ enabled, expectedEnabled });

it("reports registration and sign-in as open by default", async () => {
  const response = await request(app).get(path).expect(200);
  expect(response.body).toEqual({ registrationEnabled: true, loginEnabled: true, revision: 0 });
  expect(response.get("Cache-Control")).toEqual("no-store");
});

it("closes and reopens each switch independently with compare-and-set", async () => {
  const closed = await setSwitch("registration", false, true).expect(200);
  expect(closed.body).toMatchObject({ registrationEnabled: false, loginEnabled: true, revision: 1 });

  const login = await setSwitch("login", false, true).expect(200);
  expect(login.body).toMatchObject({ registrationEnabled: false, loginEnabled: false, revision: 2 });

  const reopened = await setSwitch("registration", true, false).expect(200);
  expect(reopened.body).toMatchObject({ registrationEnabled: true, loginEnabled: false, revision: 3 });
});

it("treats a repeated request as unchanged and a stale one as a conflict", async () => {
  await setSwitch("login", false, true).expect(200);

  const repeated = await setSwitch("login", false, true).expect(200);
  expect(repeated.body).toMatchObject({ loginEnabled: false, revision: 1, unchanged: true });

  await setSwitch("login", true, true).expect(409);
  expect((await request(app).get(path)).body.loginEnabled).toBe(false);
});

it("lets exactly one of two concurrent first closes write", async () => {
  const results = await Promise.all([setSwitch("login", false, true), setSwitch("login", false, true)]);
  expect(results.map(result => result.status)).toEqual([200, 200]);
  expect(results.filter(result => result.body.unchanged)).toHaveLength(1);
  expect((await request(app).get(path)).body.revision).toBe(1);
});

it.each([
  ["unknown switch", "betting", { enabled: false, expectedEnabled: true }, 404],
  ["prototype key", "constructor", { enabled: false, expectedEnabled: true }, 404],
  ["missing expected value", "login", { enabled: false }, 400],
  ["non-boolean value", "login", { enabled: "false", expectedEnabled: true }, 400],
])("rejects %s", async (_label, name, body, status) => {
  await request(app).put(`${path}/${name}`).send(body).expect(status);
  expect((await request(app).get(path)).body.revision).toBe(0);
});

describe("enforcement", () => {
  it("refuses registration while registration is paused, then allows it again", async () => {
    await setSwitch("registration", false, true).expect(200);
    const refused = await request(app).post("/api/auth/new").send({ email: "newcomer", password: "password" }).expect(400);
    expect(refused.body.errors[0].msg).toEqual("Registration is paused. Try again later.");
    expect(await User.countDocuments()).toBe(0);

    await setSwitch("registration", true, false).expect(200);
    await request(app).post("/api/auth/new").send({ email: "newcomer", password: "password" }).expect(201);
  });

  it("refuses registration while sign-in is paused because sign-up signs the user in", async () => {
    await setSwitch("login", false, true).expect(200);
    const refused = await request(app).post("/api/auth/new").send({ email: "newcomer", password: "password" }).expect(400);
    expect(refused.body.errors[0].msg).toEqual("Sign-in is paused. Try again later.");
    expect(refused.get("Set-Cookie")).toBeUndefined();
  });

  it("refuses customer sign-in while paused but keeps administrators and wrong passwords unchanged", async () => {
    await User.create({ email: "player", identifierNormalized: "player", password: "password" });
    await User.create({ email: "operator", identifierNormalized: "operator", password: "password", role: UserRole.ADMIN });
    await setSwitch("login", false, true).expect(200);

    const refused = await request(app).post("/api/auth/login").send({ email: "player", password: "password" }).expect(400);
    expect(refused.body.errors[0].msg).toEqual("Sign-in is paused. Try again later.");
    expect(refused.get("Set-Cookie")).toBeUndefined();

    const wrong = await request(app).post("/api/auth/login").send({ email: "player", password: "nope" }).expect(400);
    expect(wrong.body.errors[0].msg).toEqual("Invalid credentials");

    await request(app).post("/api/auth/login").send({ email: "operator", password: "password" }).expect(200);

    await setSwitch("login", true, false).expect(200);
    await request(app).post("/api/auth/login").send({ email: "player", password: "password" }).expect(200);
  });
});
