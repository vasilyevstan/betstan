import { execFile } from "child_process";
import { request as httpRequest } from "http";
import { request as httpsRequest } from "https";
import { resolve } from "path";
import { promisify } from "util";
import { cashBackHash } from "./cashBackIdentity";

const execute = promisify(execFile);
export const ACCOUNTING_SOURCE_QUEUES = [
  "resulting_place_bet", "resulting_moderation_result", "resulting_result",
  "resulting_live_event_update", "resulting_cash_back_request",
  "resulting_cash_back_source_reply", "resulting_market_settled",
] as const;
export interface AccountingSnapshotFence {
  namespace: string;
  operationId: string;
  sourceSha: string;
  generation: string;
  identityHash: string;
}

export function assertDrainedAccountingQueue(value: any, name: string, vhost: string): void {
  if (!value || value.name !== name || value.vhost !== vhost
    || !["messages", "messages_ready", "messages_unacknowledged", "consumers"]
      .every(field => value[field] === 0)) throw new Error("Accounting source queue is not drained and quiesced");
}

/** Internal transport helper; exported for isolated deadline regression tests. */
export function queueState(url: URL): Promise<unknown> {
  return new Promise((resolveValue, reject) => {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    const cleanup = () => {
      clearTimeout(deadline);
      request.setTimeout(0);
    };
    const fail = (message: string) => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(new Error(message));
    };
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, { method: "GET" }, response => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        if (finished) return;
        bytes += chunk.length;
        if (bytes > 64 * 1024) {
          fail("Queue evidence exceeds budget");
          request.destroy();
        } else chunks.push(chunk);
      });
      response.on("error", () => {
        fail("Queue evidence unavailable");
        request.destroy();
      });
      response.on("end", () => {
        if (finished) return;
        finished = true;
        cleanup();
        if (response.statusCode !== 200) return reject(new Error("Queue evidence unavailable"));
        try { resolveValue(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(new Error("Invalid queue evidence")); }
      });
    });
    const expire = () => {
      if (finished) return;
      fail("Queue evidence timed out");
      request.destroy();
    };
    // Socket timeouts are idle-only. This independent deadline also bounds
    // connection setup and responses that keep delivering small amounts of data.
    deadline = setTimeout(expire, 10000);
    request.setTimeout(10000, expire);
    request.on("error", () => fail("Queue evidence unavailable"));
    request.end();
  });
}

/**
 * Private, read-only prerequisite check. Never enters maintenance, acquires a
 * lock, drains/purges a queue or starts/stops a deployment. The protected owner
 * must hold the SAME lease and physical fence through import/activation.
 *
 * Both URIs must address the same broker host. A local port-forward may use
 * separate local ports. No caller-supplied "complete" boolean is accepted.
 */
export async function verifyAccountingSnapshotFence(): Promise<AccountingSnapshotFence> {
  try {
    const env = { ...process.env };
    if (!env.NAMESPACE || env.NAMESPACE !== env.OCI_K8S_NAMESPACE
      || !env.LOCK_TOKEN || !env.OPERATION_ID || !env.SOURCE_SHA
      || !env.RABBITMQ_URI || !env.RABBITMQ_MANAGEMENT_URI || env.NOW_EPOCH) {
      throw new Error("Missing maintenance authority");
    }
    const options = { env, timeout: 180000, maxBuffer: 64 * 1024 };
    const root = resolve(__dirname, "../../..");
    const lock = await execute("bash", [resolve(root, "infra/oci/scripts/shared-mongo-operation-lock-stan.sh"), "verify"], options);
    const match = /^shared_mongo_lock=verify status=PASS lease_until_epoch=([1-9][0-9]*) fencing_generation=([1-9][0-9]*)\s*$/.exec(lock.stdout);
    if (!match) throw new Error("Invalid maintenance authority");
    await execute("bash", [resolve(root, "infra/oci/scripts/live-data-maintenance-stan.sh"), "verify-held"], options);
    const broker = new URL(env.RABBITMQ_URI);
    const management = new URL(env.RABBITMQ_MANAGEMENT_URI);
    if (!["amqp:", "amqps:"].includes(broker.protocol) || management.hostname !== broker.hostname
      || !(management.protocol === "https:" || (management.protocol === "http:"
        && ["localhost", "127.0.0.1", "[::1]"].includes(management.hostname)))) throw new Error("Invalid broker evidence endpoint");
    const vhost = broker.pathname && broker.pathname !== "/" ? decodeURIComponent(broker.pathname.slice(1)) : "/";
    for (const name of ACCOUNTING_SOURCE_QUEUES) {
      const url = new URL(management);
      url.pathname = `/api/queues/${encodeURIComponent(vhost)}/${encodeURIComponent(name)}`;
      url.search = "";
      url.hash = "";
      assertDrainedAccountingQueue(await queueState(url), name, vhost);
    }
    if (BigInt(match[1]) <= BigInt(Math.floor(Date.now() / 1000))) throw new Error("Maintenance lease expired");
    return {
      namespace: env.NAMESPACE, operationId: env.OPERATION_ID, sourceSha: env.SOURCE_SHA, generation: match[2],
      identityHash: cashBackHash([env.NAMESPACE, env.LOCK_CONFIGMAP ?? "gaming-mongo-migration-lock",
        env.LOCK_TOKEN, env.OPERATION_ID, env.SOURCE_SHA, match[2]]),
    };
  } catch {
    // Driver/subprocess errors can contain credentials or private infrastructure.
    throw new Error("Accounting snapshot requires a verified held maintenance lease and drained source queues");
  }
}
