import { Schema, model } from "mongoose";

export const GLOBAL_CASH_BACK_SETTING_ID = "global";

export interface CashBackSettingState {
  enabled: boolean;
  revision: number;
  updatedAt?: Date;
}

interface CashBackSettingDocument extends CashBackSettingState {
  _id: string;
}

// Singleton global switch. `revision` is the explicit CAS counter, so no Mongoose version key.
const cashBackSettingSchema = new Schema<CashBackSettingDocument>({
  _id: { type: String, required: true },
  enabled: { type: Boolean, required: true },
  revision: { type: Number, required: true },
  updatedAt: { type: Date, required: true },
}, { versionKey: false });

const CashBackSetting = model<CashBackSettingDocument>("CashBackSetting", cashBackSettingSchema);

// A missing singleton means cash-back was never switched off globally (legacy default: enabled).
// A present singleton is enabled only when it explicitly says so, so unknown data fails closed.
export const toCashBackSettingState = (
  document: Partial<CashBackSettingDocument> | null | undefined
): CashBackSettingState => {
  if (!document) return { enabled: true, revision: 0 };
  return {
    enabled: document.enabled === true,
    revision: Number.isSafeInteger(document.revision) && document.revision! >= 0 ? document.revision! : 0,
    ...(document.updatedAt instanceof Date && Number.isFinite(document.updatedAt.getTime())
      ? { updatedAt: document.updatedAt } : {}),
  };
};

export const readCashBackSetting = async (): Promise<CashBackSettingState> =>
  toCashBackSettingState(
    await CashBackSetting.findById(GLOBAL_CASH_BACK_SETTING_ID).lean<CashBackSettingDocument>()
  );

export { CashBackSetting };
