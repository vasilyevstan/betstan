import { execFile } from "child_process";
import http from "http";
import https from "https";
import { resolve } from "path";
import { promisify } from "util";
import { fingerprint } from "./Policy";
import { SnapshotFence } from "./SnapshotContract";

const execute = promisify(execFile);
export const SNAPSHOT_HANDOFF_QUEUES = [
  "resulting_place_bet", "resulting_moderation_result", "resulting_result",
  "resulting_live_event_update", "resulting_cash_back_request", "resulting_cash_back_source_reply",
  "resulting_market_settled", "moderation_place_bet", "moderation_event_result",
  "moderation_live_event_update", "moderation_risk_settle_slip", "moderation_risk_cash_back_outcome",
];
async function assertQueue(url: URL, name: string, vhost: string): Promise<void> {
  await new Promise<void>((resolveValue, reject) => {
    const req = (url.protocol === "https:" ? https : http).get(url, res => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", chunk => {
        size += chunk.length;
        if (size > 65536) req.destroy(new Error("Queue evidence bound"));
        else chunks.push(Buffer.from(chunk));
      });
      res.on("error", reject);
      res.on("end", () => {
        clearTimeout(deadline);
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (res.statusCode !== 200 || data.name !== name || data.vhost !== vhost
            || !["messages", "messages_ready", "messages_unacknowledged", "consumers"].every(k => data[k] === 0)) throw new Error("Not quiesced");
          resolveValue();
        } catch { reject(new Error("Queue evidence unavailable or not quiesced")); }
      });
    });
    const deadline = setTimeout(() => req.destroy(new Error("Queue evidence timeout")), 10000);
    req.on("error", error => { clearTimeout(deadline); reject(error); });
  });
}
/** Read-only use of existing protected maintenance authority. Does not acquire,
 * release, drain, purge, deploy or hold settlement. Never logs secret-bearing errors. */
export async function verifyReceiverFence(): Promise<{ fence: SnapshotFence; leaseUntilEpoch: number }> {
  try {
    const env = { ...process.env };
    if (!env.NAMESPACE || env.NAMESPACE !== env.OCI_K8S_NAMESPACE || !env.LOCK_TOKEN || !env.OPERATION_ID
      || !env.SOURCE_SHA || !env.RABBITMQ_URI || !env.RABBITMQ_MANAGEMENT_URI || env.NOW_EPOCH) throw new Error("Missing authority");
    const root = resolve(__dirname, "../../..");
    const options = { env, timeout: 180000, maxBuffer: 65536 };
    const lock = await execute("bash", [resolve(root, "infra/oci/scripts/shared-mongo-operation-lock-stan.sh"), "verify"], options);
    const match = /^shared_mongo_lock=verify status=PASS lease_until_epoch=([1-9][0-9]*) fencing_generation=([1-9][0-9]*)\s*$/.exec(lock.stdout);
    if (!match) throw new Error("Invalid lease");
    await execute("bash", [resolve(root, "infra/oci/scripts/live-data-maintenance-stan.sh"), "verify-held"], options);
    const broker = new URL(env.RABBITMQ_URI), management = new URL(env.RABBITMQ_MANAGEMENT_URI);
    if (!["amqp:", "amqps:"].includes(broker.protocol) || broker.hostname !== management.hostname
      || !(management.protocol === "https:" || (management.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(management.hostname)))) throw new Error("Invalid broker");
    const vhost = broker.pathname && broker.pathname !== "/" ? decodeURIComponent(broker.pathname.slice(1)) : "/";
    for (const name of SNAPSHOT_HANDOFF_QUEUES) {
      const url = new URL(management);
      url.pathname = `/api/queues/${encodeURIComponent(vhost)}/${encodeURIComponent(name)}`;
      url.search = ""; url.hash = "";
      await assertQueue(url, name, vhost);
    }
    const leaseUntilEpoch = Number(match[1]);
    if (!Number.isSafeInteger(leaseUntilEpoch) || leaseUntilEpoch * 1000 <= Date.now()) throw new Error("Expired lease");
    return { leaseUntilEpoch, fence: {
      namespace: env.NAMESPACE, operationId: env.OPERATION_ID, sourceSha: env.SOURCE_SHA, generation: match[2],
      identityHash: fingerprint([env.NAMESPACE, env.LOCK_CONFIGMAP ?? "gaming-mongo-migration-lock",
        env.LOCK_TOKEN, env.OPERATION_ID, env.SOURCE_SHA, match[2]]),
    } };
  } catch { throw new Error("Snapshot handoff requires the verified held lease, physical fence and drained source/receiver queues"); }
}
