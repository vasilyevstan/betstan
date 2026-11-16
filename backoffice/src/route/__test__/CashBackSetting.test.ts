import request from "supertest";
import { app } from "../../app";
import { CashBackSetting, GLOBAL_CASH_BACK_SETTING_ID } from "../../model/CashBackSetting";

const path = "/api/backoffice/cash-back-setting";
const put = (body: unknown) => request(app).put(path).send(body as object);
const stored = () => CashBackSetting.findById(GLOBAL_CASH_BACK_SETTING_ID).lean();

it("reports cash-back enabled at revision 0 when the setting was never written", async () => {
  const response = await request(app).get(path).expect(200);
  expect(response.body).toEqual({ enabled: true, revision: 0 });
  expect(response.headers["cache-control"]).toEqual("no-store");
  expect(await CashBackSetting.countDocuments()).toBe(0);
});

it("switches cash-back off and back on, incrementing the revision each time", async () => {
  const off = await put({ enabled: false, expectedEnabled: true }).expect(200);
  expect(off.body).toEqual({ enabled: false, revision: 1, updatedAt: expect.any(String) });
  expect(new Date(off.body.updatedAt).toISOString()).toBe(off.body.updatedAt);
  expect((await request(app).get(path).expect(200)).body).toEqual(off.body);

  const on = await put({ enabled: true, expectedEnabled: false }).expect(200);
  expect(on.body).toEqual({ enabled: true, revision: 2, updatedAt: expect.any(String) });
  expect(Date.parse(on.body.updatedAt)).toBeGreaterThanOrEqual(Date.parse(off.body.updatedAt));
  expect((await request(app).get(path).expect(200)).body).toEqual(on.body);
  expect(await CashBackSetting.countDocuments()).toBe(1);
});

it("treats a request for the current state as an idempotent no-op without a revision bump", async () => {
  expect((await put({ enabled: true, expectedEnabled: true }).expect(200)).body)
    .toEqual({ enabled: true, revision: 0, unchanged: true });
  expect(await stored()).toBeNull();

  const off = await put({ enabled: false, expectedEnabled: true }).expect(200);
  const before = await stored();
  // Exact repeat (upsert loses on the singleton _id) and a stale-but-satisfied request.
  for (const body of [{ enabled: false, expectedEnabled: true }, { enabled: false, expectedEnabled: false }]) {
    expect((await put(body).expect(200)).body).toEqual({ ...off.body, unchanged: true });
  }
  expect(await stored()).toEqual(before);
});

it("rejects a stale expected state with 409 and leaves the setting untouched", async () => {
  await put({ enabled: false, expectedEnabled: false }).expect(409);
  expect(await stored()).toBeNull();

  await put({ enabled: false, expectedEnabled: true }).expect(200);
  const before = await stored();
  const response = await put({ enabled: true, expectedEnabled: true }).expect(409);
  expect(response.body).toEqual({ message: "Cash-back setting changed. Refresh before trying again." });
  expect(await stored()).toEqual(before);
});

it("requires strict booleans", async () => {
  for (const body of [
    {}, { enabled: false }, { expectedEnabled: true },
    { enabled: "false", expectedEnabled: true }, { enabled: false, expectedEnabled: "true" },
    { enabled: 0, expectedEnabled: 1 }, { enabled: null, expectedEnabled: true }, [false, true],
  ]) {
    const response = await put(body).expect(400);
    expect(typeof response.body.message).toBe("string");
  }
  expect(await CashBackSetting.countDocuments()).toBe(0);
});

it("lets exactly one of concurrent identical first writes change the setting", async () => {
  const responses = await Promise.all(
    Array.from({ length: 8 }, () => put({ enabled: false, expectedEnabled: true }))
  );
  expect(responses.every(response => response.status === 200)).toBe(true);
  expect(responses.filter(response => !response.body.unchanged)).toHaveLength(1);
  expect(responses.every(response => response.body.enabled === false && response.body.revision === 1)).toBe(true);
  expect(await stored()).toMatchObject({ enabled: false, revision: 1 });
});

it("fails closed on a malformed stored setting and lets it be switched back on", async () => {
  await CashBackSetting.collection.insertOne({ _id: GLOBAL_CASH_BACK_SETTING_ID, enabled: "yes" } as never);
  expect((await request(app).get(path).expect(200)).body).toEqual({ enabled: false, revision: 0 });
  expect((await put({ enabled: true, expectedEnabled: false }).expect(200)).body)
    .toEqual({ enabled: true, revision: 1, updatedAt: expect.any(String) });
});
