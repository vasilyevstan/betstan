import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { verifyGithubOidc } from "./auth";

type JsonObject = Record<string, any>;

const port = Number(process.env.PORT ?? "3000");
const namespace = process.env.OCI_K8S_NAMESPACE ?? "betstan-oci";
const audience = process.env.REPAIR_OIDC_AUDIENCE ?? "betstan-production-repair";
const repository = process.env.GITHUB_REPOSITORY ?? "vasilyevstan/betstan";
const workflowPath =
  process.env.REPAIR_WORKFLOW_PATH ??
  ".github/workflows/oci-production-self-heal.yml";
const subject =
  process.env.REPAIR_OIDC_SUBJECT ??
  `repo:${repository}:environment:oci-production`;
const enabled = process.env.SELF_HEAL_ENABLED === "true";
const allowed = new Set(
  (process.env.SELF_HEAL_SERVICES ?? "client,backoffice")
    .split(",")
    .filter(Boolean),
);
const operationConfigMap = "betstan-production-operation-v1";
const releaseConfigMap = "betstan-active-release-v1";
const operationSchema = "betstan.production-operation.v1";
const environment = "oci-production";
const restartingTransients = [
  "workload-not-ready",
  "service-endpoint-empty",
  "public-api-failed",
  "public-home-failed",
];

function send(response: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(payload.length),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(payload);
}

async function body(request: IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 8192) {
      throw new Error("request-too-large");
    }
    chunks.push(Buffer.from(chunk));
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("request-malformed");
  }
  return parsed;
}

function exactKeys(value: JsonObject, expected: string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((item, index) => item !== wanted[index])
  ) {
    throw new Error("request-fields-invalid");
  }
}

async function kubernetes(
  path: string,
  method: "GET" | "PATCH" | "PUT",
  payload?: JsonObject,
): Promise<JsonObject> {
  const [token, ca] = await Promise.all([
    readFile("/var/run/secrets/kubernetes.io/serviceaccount/token", "utf8"),
    readFile("/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"),
  ]);
  const encoded = payload ? Buffer.from(JSON.stringify(payload)) : undefined;
  return new Promise((resolve, reject) => {
    const call = httpsRequest(
      {
        host: process.env.KUBERNETES_SERVICE_HOST,
        port: Number(process.env.KUBERNETES_SERVICE_PORT_HTTPS ?? "443"),
        path,
        method,
        ca,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token.trim()}`,
          ...(encoded
            ? {
                "content-type":
                  method === "PATCH"
                    ? "application/strategic-merge-patch+json"
                    : "application/json",
                "content-length": String(encoded.length),
              }
            : {}),
        },
        timeout: 5000,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          if ((response.statusCode ?? 500) >= 300) {
            reject(new Error(`Kubernetes API returned ${response.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            reject(new Error("Kubernetes API returned malformed JSON"));
          }
        });
      },
    );
    call.on("timeout", () => call.destroy(new Error("Kubernetes API timed out")));
    call.on("error", reject);
    if (encoded) {
      call.write(encoded);
    }
    call.end();
  });
}

function configRecord(configMap: JsonObject): JsonObject {
  const value = configMap.data?.["record.json"];
  if (typeof value !== "string") {
    throw new Error("state-record-missing");
  }
  const parsed = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("state-record-malformed");
  }
  return parsed;
}

async function writeOperation(
  configMap: JsonObject,
  operation: JsonObject,
): Promise<JsonObject> {
  const resourceVersion = configMap.metadata?.resourceVersion;
  if (typeof resourceVersion !== "string" || resourceVersion.length === 0) {
    throw new Error("operation-resource-version-missing");
  }
  const encodedNamespace = encodeURIComponent(namespace);
  return kubernetes(
    `/api/v1/namespaces/${encodedNamespace}/configmaps/${operationConfigMap}`,
    "PUT",
    {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: {
        name: operationConfigMap,
        namespace,
        resourceVersion,
        labels: {
          "app.kubernetes.io/part-of": "betstan",
          "app.kubernetes.io/managed-by": "production-monitor",
        },
      },
      data: {
        "record.json": JSON.stringify(operation),
      },
    },
  );
}

function textClaim(identity: JsonObject, name: string): string {
  const value = identity[name];
  if (typeof value !== "string" || value.length === 0 || value.length > 500) {
    throw new Error(`oidc-${name}-invalid`);
  }
  return value;
}

function runNumber(identity: JsonObject, name: string): number {
  const value = textClaim(identity, name);
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`oidc-${name}-invalid`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`oidc-${name}-invalid`);
  }
  return parsed;
}

function iso(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function operationDocument(
  previous: JsonObject,
  identity: JsonObject,
  repairId: string,
  targetSha: string,
  phase: "restarting" | "validating",
  now: Date,
): JsonObject {
  const previousGeneration = previous.generation;
  if (!Number.isSafeInteger(previousGeneration) || previousGeneration < 1) {
    throw new Error("operation-generation-invalid");
  }
  if (previous.state === "active") {
    const expires = Date.parse(previous.expires_at);
    if (!Number.isFinite(expires) || expires > now.getTime()) {
      throw new Error("another-production-operation-active");
    }
  } else if (!["succeeded", "failed"].includes(previous.state)) {
    throw new Error("operation-state-invalid");
  }
  const runId = runNumber(identity, "run_id");
  const runAttempt = runNumber(identity, "run_attempt");
  const controlSha = textClaim(identity, "sha");
  if (!/^[0-9a-f]{40}$/.test(controlSha)) {
    throw new Error("oidc-sha-invalid");
  }
  if (runAttempt !== 1) {
    throw new Error("workflow-rerun-forbidden");
  }
  return {
    schema: operationSchema,
    environment,
    generation: previousGeneration + 1,
    operation_id: `self-heal-${runId}-${runAttempt}`,
    repair_id: repairId,
    workflow_path: workflowPath,
    run_id: runId,
    run_attempt: runAttempt,
    control_sha: controlSha,
    target_sha: targetSha,
    phase,
    expected_transient_codes:
      phase === "restarting" ? restartingTransients : [],
    heartbeat_at: iso(now),
    expires_at: iso(
      new Date(now.getTime() + (phase === "restarting" ? 600 : 900) * 1000),
    ),
    state: "active",
  };
}

export function terminalOperation(
  current: JsonObject,
  result: "succeeded" | "failed",
  now: Date,
): JsonObject {
  if (current.state !== "active") {
    throw new Error("operation-already-terminal");
  }
  return {
    ...current,
    generation: current.generation + 1,
    phase: result,
    expected_transient_codes: [],
    heartbeat_at: iso(now),
    expires_at: iso(new Date(now.getTime() + 300_000)),
    state: result,
  };
}

async function authenticatedIdentity(
  request: IncomingMessage,
): Promise<JsonObject> {
  const expectedSha = request.headers["x-betstan-workflow-sha"];
  if (
    typeof expectedSha !== "string" ||
    !/^[0-9a-f]{40}$/.test(expectedSha)
  ) {
    throw new Error("invalid-workflow-sha");
  }
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) {
    throw new Error("missing-oidc-token");
  }
  return verifyGithubOidc(authorization.slice("Bearer ".length), {
    audience,
    repository,
    workflowPath,
    ref: "refs/heads/master",
    subject,
    expectedSha,
    eventNames: ["workflow_dispatch"],
  });
}

function validateCommonRequest(
  requestBody: JsonObject,
): { service: string; repairId: string; targetSha: string } {
  const service = requestBody.service;
  const repairId = requestBody.repair_id;
  const targetSha = requestBody.target_sha;
  if (
    typeof service !== "string" ||
    !allowed.has(service) ||
    typeof repairId !== "string" ||
    !/^[a-z0-9][a-z0-9._:/-]{0,159}$/.test(repairId) ||
    typeof targetSha !== "string" ||
    !/^[0-9a-f]{40}$/.test(targetSha)
  ) {
    throw new Error("request-outside-policy");
  }
  return { service, repairId, targetSha };
}

async function waitForRollout(
  encodedNamespace: string,
  service: string,
  minimumGeneration: number,
): Promise<void> {
  const path =
    `/apis/apps/v1/namespaces/${encodedNamespace}/deployments/` +
    `gaming-${service}-depl`;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const deployment = await kubernetes(path, "GET");
    const desired = deployment.spec?.replicas;
    const observed = deployment.status?.observedGeneration;
    const updated = deployment.status?.updatedReplicas ?? 0;
    const available = deployment.status?.availableReplicas ?? 0;
    const unavailable = deployment.status?.unavailableReplicas ?? 0;
    if (
      Number.isSafeInteger(desired) &&
      desired > 0 &&
      Number.isSafeInteger(observed) &&
      observed >= minimumGeneration &&
      updated === desired &&
      available === desired &&
      unavailable === 0
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error("restart-rollout-timeout");
}

async function restart(
  request: IncomingMessage,
  identity: JsonObject,
): Promise<JsonObject> {
  const requestBody = await body(request);
  exactKeys(requestBody, ["repair_id", "service", "target_sha"]);
  const { service, repairId, targetSha } = validateCommonRequest(requestBody);
  const encodedNamespace = encodeURIComponent(namespace);
  const operationPath =
    `/api/v1/namespaces/${encodedNamespace}/configmaps/${operationConfigMap}`;
  const [releaseMap, currentOperationMap, deployment] = await Promise.all([
    kubernetes(
      `/api/v1/namespaces/${encodedNamespace}/configmaps/${releaseConfigMap}`,
      "GET",
    ),
    kubernetes(operationPath, "GET"),
    kubernetes(
      `/apis/apps/v1/namespaces/${encodedNamespace}/deployments/gaming-${service}-depl`,
      "GET",
    ),
  ]);
  const release = configRecord(releaseMap);
  const currentOperation = configRecord(currentOperationMap);
  const expectedDigest = release.image_digests?.[service];
  const currentImage = deployment.spec?.template?.spec?.containers?.[0]?.image;
  if (
    release.schema !== "betstan.active-release.v1" ||
    release.environment !== environment ||
    release.state !== "active" ||
    release.source_sha !== targetSha ||
    !Number.isSafeInteger(release.generation) ||
    release.generation < 1 ||
    typeof expectedDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(expectedDigest) ||
    typeof currentImage !== "string" ||
    !currentImage.endsWith(`@${expectedDigest}`)
  ) {
    throw new Error("runtime-state-mismatch");
  }

  const now = new Date();
  const activeOperation = operationDocument(
    currentOperation,
    identity,
    repairId,
    targetSha,
    "restarting",
    now,
  );
  let ownedOperationMap = await writeOperation(
    currentOperationMap,
    activeOperation,
  );
  try {
    const restartedAt = iso(new Date());
    const patched = await kubernetes(
      `/apis/apps/v1/namespaces/${encodedNamespace}/deployments/gaming-${service}-depl`,
      "PATCH",
      {
        spec: {
          template: {
            metadata: {
              annotations: {
                "betstan.io/restarted-at": restartedAt,
                "betstan.io/repair-id": repairId,
              },
            },
          },
        },
      },
    );
    const patchedGeneration = patched.metadata?.generation;
    if (!Number.isSafeInteger(patchedGeneration) || patchedGeneration < 1) {
      throw new Error("restart-generation-missing");
    }
    await waitForRollout(encodedNamespace, service, patchedGeneration);
    const validating: JsonObject = {
      ...activeOperation,
      generation: activeOperation.generation + 1,
      phase: "validating",
      expected_transient_codes: [],
      heartbeat_at: iso(new Date()),
      expires_at: iso(new Date(Date.now() + 900_000)),
    };
    ownedOperationMap = await writeOperation(ownedOperationMap, validating);
    return {
      schema: "betstan.production-restart.v1",
      service,
      repair_id: repairId,
      active_release_generation: release.generation,
      operation_id: validating.operation_id,
      accepted_at: restartedAt,
    };
  } catch (error) {
    try {
      const currentMap = await kubernetes(operationPath, "GET");
      const current = configRecord(currentMap);
      if (
        current.operation_id === activeOperation.operation_id &&
        current.repair_id === repairId &&
        current.state === "active"
      ) {
        await writeOperation(
          currentMap,
          terminalOperation(current, "failed", new Date()),
        );
      }
    } catch {
      throw new Error("restart-and-operation-finalization-failed");
    }
    throw error;
  }
}

async function finalize(
  request: IncomingMessage,
  identity: JsonObject,
): Promise<JsonObject> {
  const requestBody = await body(request);
  exactKeys(requestBody, ["repair_id", "result", "service", "target_sha"]);
  const { service, repairId, targetSha } = validateCommonRequest(requestBody);
  const result = requestBody.result;
  if (result !== "succeeded" && result !== "failed") {
    throw new Error("final-result-invalid");
  }
  const controlSha = textClaim(identity, "sha");
  const encodedNamespace = encodeURIComponent(namespace);
  const operationPath =
    `/api/v1/namespaces/${encodedNamespace}/configmaps/${operationConfigMap}`;
  const operationMap = await kubernetes(operationPath, "GET");
  const operation = configRecord(operationMap);
  const runId = runNumber(identity, "run_id");
  const runAttempt = runNumber(identity, "run_attempt");
  if (
    operation.operation_id !== `self-heal-${runId}-${runAttempt}` ||
    operation.repair_id !== repairId ||
    operation.workflow_path !== workflowPath ||
    operation.run_id !== runId ||
    operation.run_attempt !== runAttempt ||
    operation.control_sha !== controlSha ||
    operation.target_sha !== targetSha ||
    operation.phase !== "validating" ||
    operation.state !== "active"
  ) {
    throw new Error("operation-ownership-mismatch");
  }
  const completed = terminalOperation(operation, result, new Date());
  await writeOperation(operationMap, completed);
  return {
    schema: "betstan.production-restart-final.v1",
    service,
    repair_id: repairId,
    operation_id: completed.operation_id,
    result,
    completed_at: completed.heartbeat_at,
  };
}

async function handler(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (request.method === "GET" && request.url === "/healthz") {
    send(response, 200, { status: enabled ? "enabled" : "disabled" });
    return;
  }
  if (
    request.method !== "POST" ||
    ![
      "/__betstan/repair/v1/restart",
      "/__betstan/repair/v1/finalize",
    ].includes(request.url ?? "")
  ) {
    send(response, 404, { error: "not-found" });
    return;
  }
  if (!enabled) {
    send(response, 503, { error: "self-heal-disabled" });
    return;
  }
  try {
    const identity = await authenticatedIdentity(request);
    const result =
      request.url === "/__betstan/repair/v1/restart"
        ? await restart(request, identity)
        : await finalize(request, identity);
    send(response, 200, result);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "repair-failed";
    const unauthorized =
      reason.includes("OIDC") ||
      reason.includes("oidc") ||
      reason === "missing-oidc-token";
    send(response, unauthorized ? 401 : 409, {
      error: unauthorized ? "unauthorized" : reason.slice(0, 80),
    });
  }
}

if (require.main === module) {
  const server = createServer((request, response) => {
    void handler(request, response);
  });
  server.requestTimeout = 180_000;
  server.headersTimeout = 10_000;
  server.listen(port, "0.0.0.0");
}
