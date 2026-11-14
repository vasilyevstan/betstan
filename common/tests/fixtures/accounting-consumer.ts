import { ISettleSlipEvent, ICashBackOutcomeEvent, BetAccountingEvidence } from "../../build";
import { ISettleSlipEvent as OldSettle, ICashBackOutcomeEvent as OldOutcome } from "predecessor-common";

const old: OldSettle = { data: { slipId: "ticket", result: "WIN" } };
const next: ISettleSlipEvent = old;
const evidence: BetAccountingEvidence = { schemaVersion: 1, status: "UNAVAILABLE", reason: "HISTORY_MISSING" };
const additive: ISettleSlipEvent = { data: { ...next.data, accounting: evidence } };
const rolling: OldSettle = additive;
function outcomes(oldOutcome: OldOutcome, newOutcome: ICashBackOutcomeEvent) {
  const newReader: ICashBackOutcomeEvent = oldOutcome;
  const oldReader: OldOutcome = newOutcome;
  return [newReader, oldReader, rolling];
}
void outcomes;
