import { ensureSlipDraftIndex } from "../scripts/ensureDraftIndexes";

export const ensureSlipReadyForTraffic = async () => {
  const report = await ensureSlipDraftIndex({ apply: true });

  if (!report.ready) {
    throw new Error(
      `Slip draft index guard failed: ${JSON.stringify(report)}`
    );
  }

  return report;
};
