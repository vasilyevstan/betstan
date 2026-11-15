import mongoose from "mongoose";
import { beginSnapshotImport, finalizeSnapshotImport, importSnapshotPage } from "../risk/SnapshotImport";
import { initializeRisk, riskEnabled } from "../risk/Store";

/** Private stdin transport. Source records never go to public routes or logs.
 * Keep existing maintenance held through source completion AND receiver final ACK.
 * node -r ts-node/register/transpile-only src/scripts/importRiskSnapshot.ts manifest|page|complete
 */
export async function runRiskSnapshotCommand(command: string, value: unknown) {
  if (command === "manifest") return beginSnapshotImport(value);
  if (command === "page") return importSnapshotPage(value);
  if (command === "complete") return finalizeSnapshotImport(value);
  throw new Error("Usage: importRiskSnapshot manifest|page|complete (private JSON on stdin)");
}
async function main() {
  if (process.argv.length !== 3 || !["manifest", "page", "complete"].includes(process.argv[2])
    || !process.env.MONGO_URI || !riskEnabled()) throw new Error("Missing command or receiver capability");
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 512 * 1024) throw new Error("Input exceeds snapshot page bound");
    chunks.push(buffer);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  try {
    await mongoose.connect(process.env.MONGO_URI);
    await initializeRisk();
    const acknowledgement = await runRiskSnapshotCommand(process.argv[2], value);
    process.stdout.write(`${JSON.stringify(acknowledgement)}\n`);
  } finally { await mongoose.disconnect(); }
}
if (require.main === module) void main().catch(() => {
  console.error("Risk snapshot import failed; retained pages and conservative reserves remain available for retry.");
  process.exitCode = 1;
});
