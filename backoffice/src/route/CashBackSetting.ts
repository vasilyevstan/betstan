import express from "express";
import {
  CashBackSetting,
  CashBackSettingState,
  GLOBAL_CASH_BACK_SETTING_ID,
  readCashBackSetting,
  toCashBackSettingState,
} from "../model/CashBackSetting";

const router = express.Router();
const path = "/api/backoffice/cash-back-setting";

const serialize = (state: CashBackSettingState) => ({
  enabled: state.enabled,
  revision: state.revision,
  ...(state.updatedAt ? { updatedAt: state.updatedAt.toISOString() } : {}),
});

const isDuplicateKey = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === 11000;

router.get(path, async (_req, res, next) => {
  try {
    res.send(serialize(await readCashBackSetting()));
  } catch (error) {
    next(error);
  }
});

router.put(path, async (req, res, next) => {
  try {
    const { enabled, expectedEnabled } = req.body ?? {};
    if (typeof enabled !== "boolean" || typeof expectedEnabled !== "boolean") {
      res.status(400).send({ message: "Provide the current and requested cash-back settings as booleans" });
      return;
    }
    let updated: CashBackSettingState | undefined;
    if (enabled !== expectedEnabled) {
      try {
        // CAS on the effective state. Enabled = missing singleton or `enabled: true`, so switching
        // off upserts; a concurrent first write loses on the _id unique index (duplicate key) and
        // is resolved by the re-read below. Switching on requires an existing disabled singleton.
        const document = await CashBackSetting.findOneAndUpdate(
          expectedEnabled
            ? { _id: GLOBAL_CASH_BACK_SETTING_ID, enabled: true }
            : { _id: GLOBAL_CASH_BACK_SETTING_ID, enabled: { $ne: true } },
          { $set: { enabled }, $inc: { revision: 1 }, $currentDate: { updatedAt: true } },
          { new: true, upsert: expectedEnabled }
        ).lean();
        if (document) updated = toCashBackSettingState(document);
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
      }
    }
    if (updated) {
      res.send(serialize(updated));
      return;
    }
    const current = await readCashBackSetting();
    if (current.enabled === enabled) {
      res.send({ ...serialize(current), unchanged: true });
    } else {
      res.status(409).send({ message: "Cash-back setting changed. Refresh before trying again." });
    }
  } catch (error) {
    next(error);
  }
});

export { router as GlobalCashBackSetting };
