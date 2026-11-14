/* global db, print */
"use strict";

const replicaSetName = "betstan";
const memberHost = "gaming-shared-mongo-srv:27017";
const action = process.env.BETSTAN_MONGO_REPLICA_ACTION;
if (action !== "status" && action !== "initialize") {
  throw new Error("Unsupported Mongo replica-set action");
}

const admin = db.getSiblingDB("admin");
let configuration;
let state;
try {
  const result = admin.runCommand({ replSetGetConfig: 1 });
  if (result.ok !== 1) throw Object.assign(new Error("Cannot read replica-set configuration"), result);
  configuration = result.config;
} catch (error) {
  if (error.code === 76) state = "standalone";
  else if (error.code === 94) state = "uninitialized";
  else throw error;
}

if (configuration) {
  if (
    configuration._id !== replicaSetName
    || !Array.isArray(configuration.members)
    || configuration.members.length !== 1
    || configuration.members[0]._id !== 0
    || configuration.members[0].host !== memberHost
    || configuration.members[0].arbiterOnly === true
    || configuration.members[0].hidden === true
    || configuration.members[0].votes === 0
    || configuration.members[0].priority === 0
  ) {
    throw new Error("Mongo replica-set configuration differs from the reviewed single-member topology");
  }
  const hello = admin.runCommand({ hello: 1 });
  if (hello.ok !== 1 || hello.setName !== replicaSetName) {
    throw new Error("Mongo replica-set identity could not be verified");
  }
  state = hello.isWritablePrimary === true ? "ready" : "configured";
}

if (action === "initialize") {
  if (state === "standalone") {
    throw new Error("Mongo must start with the reviewed replica-set arguments before initialization");
  }
  if (state === "uninitialized") {
    const result = admin.runCommand({
      replSetInitiate: {
        _id: replicaSetName,
        members: [{ _id: 0, host: memberHost }],
      },
    });
    if (result.ok !== 1) throw new Error("Mongo replica-set initialization was not confirmed");
    state = "configured";
  }
}

print(JSON.stringify({ schema: "betstan.mongo-topology.v1", state, replicaSet: replicaSetName }));
