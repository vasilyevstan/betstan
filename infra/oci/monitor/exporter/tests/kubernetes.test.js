const test = require("node:test");
const assert = require("node:assert/strict");

const { testExports } = require("../dist/kubernetes.js");

test("parses Kubernetes quantities", () => {
  assert.equal(testExports.quantity("250m"), 0.25);
  assert.equal(testExports.quantity("1Gi"), 1024 ** 3);
  assert.throws(() => testExports.quantity("nonsense"));
});

test("reads one exact ConfigMap record", () => {
  const value = testExports.readConfigMapRecord(
    {
      items: [
        {
          metadata: { name: "betstan-active-release-v1" },
          data: { "record.json": '{"schema":"fixture"}' },
        },
      ],
    },
    "betstan-active-release-v1",
  );
  assert.deepEqual(value, { schema: "fixture" });
  assert.throws(() =>
    testExports.readConfigMapRecord(
      {
        items: [
          {
            metadata: { name: "betstan-active-release-v1" },
            data: { "record.json": "{}", extra: "unsafe" },
          },
        ],
      },
      "betstan-active-release-v1",
    ),
  );
});

test("maps only reviewed gaming workload names", () => {
  assert.equal(testExports.serviceFromName("gaming-client-depl"), "client");
  assert.equal(testExports.serviceFromName("betstan-monitor-exporter"), "platform");
});
