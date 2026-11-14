import mongoose from "mongoose";
import {
  acknowledgeAccountingExportPage, AccountingExport, beginAccountingExport, readAccountingExportPage,
} from "../service/accountingExport";
import {
  acknowledgeAccountingSnapshotPage, completeAccountingSnapshot, createAccountingSnapshot,
  readAccountingSnapshotManifest, readAccountingSnapshotPage,
} from "../service/accountingSnapshot";

/**
 * Private source-owned reconciliation transport; output contains owner/accounting
 * data and must never be routed to public logs or Backoffice responses.
 *
 * node -r ts-node/register/transpile-only src/scripts/exportAccounting.ts begin EXPORT_ID
 * node -r ts-node/register/transpile-only src/scripts/exportAccounting.ts read EXPORT_ID
 * node -r ts-node/register/transpile-only src/scripts/exportAccounting.ts ack EXPORT_ID PAGE
 *
 * Persist the receiver's application before ack. This is an overlap export, not a
 * snapshot/completeness certificate. No connection to another service's database.
 *
 * Frozen bootstrap (protected maintenance job only; see snapshot DTO handoff):
 *   snapshot ID FROM_ISO
 *   snapshot-manifest ID
 *   snapshot-read ID
 *   snapshot-ack ID PAGE HASH
 *   snapshot-complete ID MANIFEST_HASH
 *
 * Creation/final completion verify the existing held physical fence and operation
 * lease, plus all seven Resulting queues (including unacked deliveries). Supply
 * NAMESPACE=OCI_K8S_NAMESPACE, LOCK_TOKEN, OPERATION_ID, SOURCE_SHA, RABBITMQ_URI
 * and RABBITMQ_MANAGEMENT_URI in the protected environment, never CLI arguments.
 * This CLI does not acquire/release maintenance or execute a production operation
 * on its own. Bind its MONGO_URI and broker/cluster context to the reviewed source.
 * Keep maintenance held until the receiver commits readiness; reconcile its own
 * accepted-placement outboxes/receipts and deduplicate live overlap before release.
 * An interrupted unsealed build is not resumable: use a new ID under a verified
 * fence. Sealed pages and exact acknowledgements survive restart unchanged.
 */
export async function runAccountingExportCommand(args: string[]): Promise<unknown> {
  const [command, exportId, pageText] = args;
  if (command?.startsWith("snapshot")) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(exportId ?? "")) throw new Error("Invalid accounting snapshot identity");
    if (command === "snapshot" && args.length === 3) return createAccountingSnapshot(exportId, pageText);
    if (command === "snapshot-manifest" && args.length === 2) return readAccountingSnapshotManifest(exportId);
    if (command === "snapshot-read" && args.length === 2) return readAccountingSnapshotPage(exportId);
    if (command === "snapshot-ack" && args.length === 4 && /^[1-9][0-9]*$/.test(pageText)) {
      await acknowledgeAccountingSnapshotPage(exportId, Number(pageText), args[3]);
      return { snapshotId: exportId, acknowledgedPage: Number(pageText) };
    }
    if (command === "snapshot-complete" && args.length === 3) return completeAccountingSnapshot(exportId, pageText);
    throw new Error("Invalid accounting snapshot command");
  }
  if (!["begin", "read", "ack"].includes(command) || !/^[A-Za-z0-9_-]{1,128}$/.test(exportId ?? "")
    || args.length !== (command === "ack" ? 3 : 2)
    || (command === "ack" && (!/^[1-9][0-9]*$/.test(pageText) || !Number.isSafeInteger(Number(pageText))))) {
    throw new Error("Usage: exportAccounting begin|read EXPORT_ID; exportAccounting ack EXPORT_ID PAGE");
  }
  if (command === "begin") {
    await beginAccountingExport(exportId);
    return { exportId, started: true };
  }
  if (command === "read") return readAccountingExportPage(exportId);
  await acknowledgeAccountingExportPage(exportId, Number(pageText));
  return { exportId, acknowledgedPage: Number(pageText) };
}

export async function runAccountingExportCli(args = process.argv.slice(2)): Promise<void> {
  if (!process.env.MONGO_URI) throw new Error("Missing MONGO_URI variable");
  try {
    await mongoose.connect(process.env.MONGO_URI);
    await AccountingExport.init();
    const result = await runAccountingExportCommand(args);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  void runAccountingExportCli().catch(() => {
    // Do not log connection strings, records or driver errors.
    console.error("Accounting export failed; cursor is retained for recovery.");
    process.exitCode = 1;
  });
}
