import { readFile } from "node:fs/promises";
import { request } from "node:https";

type JsonObject = Record<string, any>;

const tokenPath = "/var/run/secrets/kubernetes.io/serviceaccount/token";
const caPath = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt";

function quantity(value: string): number {
  const match = /^([0-9.]+)(n|u|m|Ki|Mi|Gi|Ti|K|M|G|T)?$/.exec(value);
  if (!match) {
    throw new Error("unsupported Kubernetes quantity");
  }
  const amount = Number(match[1]);
  const factors: Record<string, number> = {
    "": 1,
    n: 1e-9,
    u: 1e-6,
    m: 1e-3,
    Ki: 1024,
    Mi: 1024 ** 2,
    Gi: 1024 ** 3,
    Ti: 1024 ** 4,
    K: 1000,
    M: 1000 ** 2,
    G: 1000 ** 3,
    T: 1000 ** 4,
  };
  return amount * factors[match[2] ?? ""];
}

async function kubernetesRequest(path: string): Promise<JsonObject> {
  const [token, ca] = await Promise.all([
    readFile(tokenPath, "utf8"),
    readFile(caPath),
  ]);
  return new Promise((resolve, reject) => {
    const call = request(
      {
        host: process.env.KUBERNETES_SERVICE_HOST,
        port: Number(process.env.KUBERNETES_SERVICE_PORT_HTTPS ?? "443"),
        path,
        method: "GET",
        ca,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token.trim()}`,
        },
        timeout: 5000,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 1024 * 1024) {
            response.destroy(new Error("Kubernetes response is too large"));
            return;
          }
          chunks.push(chunk);
        });
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
    call.end();
  });
}

function conditionMap(item: JsonObject): Map<string, string> {
  return new Map(
    (item.status?.conditions ?? []).map((condition: JsonObject) => [
      String(condition.type),
      String(condition.status),
    ]),
  );
}

function readConfigMapRecord(payload: JsonObject, name: string): JsonObject | null {
  const item = (payload.items ?? []).find(
    (candidate: JsonObject) => candidate.metadata?.name === name,
  );
  if (!item) {
    return null;
  }
  const data = item.data;
  if (
    typeof data !== "object" ||
    data === null ||
    Object.keys(data).length !== 1 ||
    typeof data["record.json"] !== "string"
  ) {
    throw new Error(`${name} has an invalid data contract`);
  }
  const record = JSON.parse(data["record.json"]);
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    throw new Error(`${name} record is malformed`);
  }
  return record;
}

function serviceFromName(name: string): string {
  return name.startsWith("gaming-") && name.endsWith("-depl")
    ? name.slice("gaming-".length, -"-depl".length)
    : "platform";
}

async function readMongoSample(): Promise<JsonObject> {
  try {
    const payload = JSON.parse(
      await readFile("/var/run/betstan-monitor/mongo.json", "utf8"),
    );
    const observedAt = Date.parse(String(payload.observed_at ?? ""));
    if (
      !Number.isFinite(observedAt) ||
      Date.now() - observedAt > 120_000 ||
      Date.now() < observedAt
    ) {
      return { ready: false, status: "stale" };
    }
    return {
      ready: payload.ready === true,
      status: String(payload.status ?? "unknown").slice(0, 80),
      version: String(payload.version ?? "").slice(0, 40),
      fcv: String(payload.fcv ?? "").slice(0, 20),
      database_count: Number(payload.database_count ?? 0),
    };
  } catch {
    return { ready: false, status: "unavailable" };
  }
}

async function readRabbitMq(): Promise<JsonObject> {
  const username = process.env.RABBITMQ_MONITOR_USERNAME;
  const password = process.env.RABBITMQ_MONITOR_PASSWORD;
  if (!username || !password) {
    return { ready: false, status: "credentials-unavailable" };
  }
  try {
    const response = await fetch(
      process.env.RABBITMQ_MONITOR_URL ??
        "http://gaming-rabbitmq-srv:15672/api/queues/%2F",
      {
        headers: {
          accept: "application/json",
          authorization:
            `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
        },
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!response.ok) {
      return { ready: false, status: `http-${response.status}` };
    }
    const queues = (await response.json()) as JsonObject[];
    if (!Array.isArray(queues) || queues.length > 100) {
      return { ready: false, status: "malformed" };
    }
    const backlog = queues.reduce(
      (sum, queue) =>
        sum +
        Number(queue.messages_ready ?? 0) +
        Number(queue.messages_unacknowledged ?? 0),
      0,
    );
    return {
      ready: queues.every((queue) => Number(queue.consumers ?? 0) > 0),
      status: "ok",
      queue_count: queues.length,
      backlog,
    };
  } catch {
    return { ready: false, status: "unavailable" };
  }
}

export async function collectDeepHealth(namespace: string): Promise<JsonObject> {
  const encodedNamespace = encodeURIComponent(namespace);
  const [
    nodes,
    metrics,
    deployments,
    statefulsets,
    pods,
    services,
    endpointSlices,
    pvcs,
    certificates,
    configMaps,
    mongo,
    rabbitmq,
  ] = await Promise.all([
    kubernetesRequest("/api/v1/nodes"),
    kubernetesRequest("/apis/metrics.k8s.io/v1beta1/nodes"),
    kubernetesRequest(`/apis/apps/v1/namespaces/${encodedNamespace}/deployments`),
    kubernetesRequest(`/apis/apps/v1/namespaces/${encodedNamespace}/statefulsets`),
    kubernetesRequest(`/api/v1/namespaces/${encodedNamespace}/pods`),
    kubernetesRequest(`/api/v1/namespaces/${encodedNamespace}/services`),
    kubernetesRequest(
      `/apis/discovery.k8s.io/v1/namespaces/${encodedNamespace}/endpointslices`,
    ),
    kubernetesRequest(
      `/api/v1/namespaces/${encodedNamespace}/persistentvolumeclaims`,
    ),
    kubernetesRequest(
      `/apis/cert-manager.io/v1/namespaces/${encodedNamespace}/certificates`,
    ),
    kubernetesRequest(`/api/v1/namespaces/${encodedNamespace}/configmaps`),
    readMongoSample(),
    readRabbitMq(),
  ]);

  const activeRelease = readConfigMapRecord(configMaps, "betstan-active-release-v1");
  const productionOperation = readConfigMapRecord(
    configMaps,
    "betstan-production-operation-v1",
  );
  const node = (nodes.items ?? [])[0] ?? {};
  const nodeMetrics = (metrics.items ?? []).find(
    (item: JsonObject) => item.metadata?.name === node.metadata?.name,
  );
  const conditions = conditionMap(node);
  const allocatable = node.status?.allocatable ?? {};
  const usage = nodeMetrics?.usage ?? {};
  const cpuPercent =
    usage.cpu && allocatable.cpu
      ? (quantity(String(usage.cpu)) / quantity(String(allocatable.cpu))) * 100
      : -1;
  const memoryPercent =
    usage.memory && allocatable.memory
      ? (quantity(String(usage.memory)) /
          quantity(String(allocatable.memory))) *
        100
      : -1;

  const workloadItems = [
    ...(deployments.items ?? []).map((item: JsonObject) => ({
      kind: "Deployment",
      name: String(item.metadata?.name ?? "unknown").slice(0, 100),
      desired: Number(item.spec?.replicas ?? 0),
      ready: Number(item.status?.availableReplicas ?? 0),
    })),
    ...(statefulsets.items ?? []).map((item: JsonObject) => ({
      kind: "StatefulSet",
      name: String(item.metadata?.name ?? "unknown").slice(0, 100),
      desired: Number(item.spec?.replicas ?? 0),
      ready: Number(item.status?.readyReplicas ?? 0),
    })),
  ];
  const imageDigests =
    activeRelease &&
    typeof activeRelease.image_digests === "object" &&
    activeRelease.image_digests !== null
      ? activeRelease.image_digests
      : {};
  const podItems = (pods.items ?? [])
    .map((item: JsonObject) => {
      const app = String(item.metadata?.labels?.app ?? "");
      const service = app.startsWith("gaming-")
        ? app.slice("gaming-".length)
        : "platform";
      const expected = imageDigests[service];
      const statuses = item.status?.containerStatuses ?? [];
      const reasons = statuses.flatMap((status: JsonObject) => [
        status.state?.waiting?.reason,
        status.lastState?.terminated?.reason,
      ]);
      const digestMatch =
        typeof expected !== "string" ||
        statuses.every((status: JsonObject) =>
          String(status.imageID ?? "").endsWith(`@${expected}`),
        );
      return {
        name: String(item.metadata?.name ?? "unknown").slice(0, 100),
        service,
        ready:
          conditionMap(item).get("Ready") === "True" &&
          statuses.length > 0 &&
          statuses.every((status: JsonObject) => status.ready === true),
        restart_count: statuses.reduce(
          (sum: number, status: JsonObject) =>
            sum + Number(status.restartCount ?? 0),
          0,
        ),
        restart_delta: 0,
        reason: reasons.filter(Boolean).join(",").slice(0, 80),
        digest_match: digestMatch,
      };
    })
    .filter((item: JsonObject) => item.service !== "platform");
  const endpointReady = new Map<string, boolean>();
  for (const item of endpointSlices.items ?? []) {
    const name = item.metadata?.labels?.["kubernetes.io/service-name"];
    if (typeof name !== "string") {
      continue;
    }
    const ready = (item.endpoints ?? []).some(
      (endpoint: JsonObject) =>
        Array.isArray(endpoint.addresses) &&
        endpoint.addresses.length > 0 &&
        endpoint.conditions?.ready !== false,
    );
    endpointReady.set(name, endpointReady.get(name) === true || ready);
  }
  const endpointItems = (services.items ?? [])
    .filter((item: JsonObject) => String(item.metadata?.name ?? "").startsWith("gaming-"))
    .map((item: JsonObject) => ({
      name: String(item.metadata?.name ?? "unknown").slice(0, 100),
      service: serviceFromName(
        String(item.metadata?.name ?? "").replace(/-srv$/, "-depl"),
      ),
      ready: endpointReady.get(item.metadata?.name) === true,
    }));
  const now = Date.now();
  const certificateItems = (certificates.items ?? []).map((item: JsonObject) => {
    const ready = conditionMap(item).get("Ready") === "True";
    const notAfter = Date.parse(String(item.status?.notAfter ?? ""));
    return {
      name: String(item.metadata?.name ?? "unknown").slice(0, 100),
      ready,
      days_remaining: Number.isFinite(notAfter)
        ? Math.floor((notAfter - now) / 86_400_000)
        : -1,
    };
  });
  const mongoPvc = (pvcs.items ?? []).find(
    (item: JsonObject) => item.metadata?.name === "gaming-auth-mongo-data",
  );

  return {
    schema: "betstan.deep-health.v1",
    observed_at: new Date().toISOString(),
    active_release: activeRelease,
    production_operation: productionOperation,
    kubernetes: {
      node: {
        count: Array.isArray(nodes.items) ? nodes.items.length : 0,
        architecture: String(
          node.status?.nodeInfo?.architecture ??
            node.metadata?.labels?.["kubernetes.io/arch"] ??
            "unknown",
        ).slice(0, 20),
        ready: conditions.get("Ready") === "True",
        memory_pressure: conditions.get("MemoryPressure") === "True",
        disk_pressure: conditions.get("DiskPressure") === "True",
        pid_pressure: conditions.get("PIDPressure") === "True",
        cpu_percent: Math.round(cpuPercent * 100) / 100,
        memory_percent: Math.round(memoryPercent * 100) / 100,
      },
      workloads: workloadItems,
      pods: podItems,
      endpoints: endpointItems,
      certificates: certificateItems,
      mongo_pvc: {
        count: (pvcs.items ?? []).filter((item: JsonObject) =>
          String(item.metadata?.name ?? "").includes("mongo"),
        ).length,
        bound: mongoPvc?.status?.phase === "Bound",
        size: String(mongoPvc?.spec?.resources?.requests?.storage ?? ""),
      },
    },
    mongo,
    rabbitmq,
  };
}

export const testExports = {
  quantity,
  readConfigMapRecord,
  serviceFromName,
};
