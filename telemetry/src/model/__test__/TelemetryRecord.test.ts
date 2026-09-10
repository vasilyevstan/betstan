import { TelemetryRecordModel } from "../TelemetryRecord";
import { MongoMetricRecorder } from "../../service/Recorder";

it("has only the exact persisted fields and 30-day occurredAt TTL index", () => {
  expect(Object.keys(TelemetryRecordModel.schema.paths).sort()).toEqual([
    "_id",
    "metric",
    "occurredAt",
  ]);
  expect(TelemetryRecordModel.schema.get("strict")).toBe("throw");
  expect(TelemetryRecordModel.schema.get("versionKey")).toBe(false);
  expect(TelemetryRecordModel.schema.indexes()).toEqual([
    [
      { occurredAt: 1 },
      { expireAfterSeconds: 2592000, background: true },
    ],
  ]);
});

it("records with setOnInsert and preserves the first duplicate occurrence", async () => {
  const recorder = new MongoMetricRecorder();
  const first = new Date("2026-09-09T10:00:00.000Z");
  const later = new Date("2026-09-10T10:00:00.000Z");
  const spy = jest.spyOn(TelemetryRecordModel, "updateOne");

  await recorder.record({
    _id: "same-id",
    metric: "USER_CREATED",
    occurredAt: first,
  });
  await recorder.record({
    _id: "same-id",
    metric: "USER_LOGGED_IN",
    occurredAt: later,
  });

  expect(spy).toHaveBeenNthCalledWith(
    1,
    { _id: "same-id" },
    {
      $setOnInsert: {
        _id: "same-id",
        metric: "USER_CREATED",
        occurredAt: first,
      },
    },
    { upsert: true }
  );
  expect(await TelemetryRecordModel.findById("same-id").lean()).toEqual({
    _id: "same-id",
    metric: "USER_CREATED",
    occurredAt: first,
  });
});
