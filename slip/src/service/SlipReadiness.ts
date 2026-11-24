import {
  ensureSlipDraftIndex,
  ensureSlipGuestExpiryIndex,
} from "../scripts/ensureDraftIndexes";

export const ensureSlipReadyForTraffic = async () => {
  const report = await ensureSlipDraftIndex({ apply: true });

  if (!report.ready) {
    throw new Error(
      `Slip draft index guard failed: ${JSON.stringify(report)}`
    );
  }

  const guestExpiryReport = await ensureSlipGuestExpiryIndex({ apply: true });

  if (!guestExpiryReport.ready) {
    throw new Error(
      `Slip guest expiry index guard failed: ${JSON.stringify(guestExpiryReport)}`
    );
  }

  return report;
};
