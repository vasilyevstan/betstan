"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { runInNewContext } = require("node:vm");
const source = readFileSync(path.join(__dirname, "../scripts/mongo-replica-set.js"), "utf8");

const config = {
  _id: "betstan",
  members: [{ _id: 0, host: "gaming-shared-mongo-srv:27017", votes: 1, priority: 1 }],
};

function run(action, responses) {
  const commands = [];
  const output = [];
  runInNewContext(source, {
    process: { env: { BETSTAN_MONGO_REPLICA_ACTION: action } },
    db: {
      getSiblingDB(name) {
        assert.equal(name, "admin");
        return {
          runCommand(command) {
            commands.push(JSON.parse(JSON.stringify(command)));
            const response = responses.shift();
            if (response instanceof Error) throw response;
            assert.ok(response, "unexpected Mongo command");
            return response;
          },
        };
      },
    },
    print(value) { output.push(JSON.parse(value)); },
  });
  assert.equal(responses.length, 0);
  return { commands, result: output[0] };
}

test("inspects standalone storage without mutating it", () => {
  const { commands, result } = run("status", [{ ok: 0, code: 76 }]);
  assert.deepEqual(commands, [{ replSetGetConfig: 1 }]);
  assert.equal(result.state, "standalone");
});

test("initializes only the uninitialized reviewed topology", () => {
  const { commands, result } = run("initialize", [{ ok: 0, code: 94 }, { ok: 1 }]);
  assert.deepEqual(commands[1], {
    replSetInitiate: { _id: "betstan", members: [{ _id: 0, host: "gaming-shared-mongo-srv:27017" }] },
  });
  assert.equal(result.state, "configured");
});

test("replays initialization without reconfiguring an existing primary", () => {
  const { commands, result } = run("initialize", [
    { ok: 1, config },
    { ok: 1, setName: "betstan", isWritablePrimary: true },
  ]);
  assert.equal(commands.length, 2);
  assert.equal(result.state, "ready");
});

test("does not mistake a configured secondary for a writable primary", () => {
  const { result } = run("status", [
    { ok: 1, config },
    { ok: 1, setName: "betstan", isWritablePrimary: false },
  ]);
  assert.equal(result.state, "configured");
});

test("rejects unknown configuration, command errors and premature initialization", () => {
  assert.throws(() => run("initialize", [{ ok: 0, code: 76 }]), /must start/);
  assert.throws(() => run("status", [{ ok: 0, code: 13 }]), /Cannot read/);
  assert.throws(() => run("status", [Object.assign(new Error("unavailable"), { code: 91 })]), /unavailable/);
  assert.throws(() => run("status", [{ ok: 1, config: { ...config, _id: "other" } }]), /differs/);
  assert.throws(() => run("status", [{
    ok: 1, config: { ...config, members: [...config.members, { _id: 1, host: "other:27017" }] },
  }]), /differs/);
  assert.throws(() => run("initialize", [{ ok: 0, code: 94 }, { ok: 0 }]), /not confirmed/);
});
