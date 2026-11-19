import express from "express";
import {
  AccessControl,
  AccessControlState,
  AccessSwitch,
  accessSwitchFields,
  ACCESS_CONTROL_ID,
  readAccessControls,
  toAccessControlState,
} from "../model/AccessControl";

// Cluster-internal: ingress routes only /api/auth/* to Auth. Backoffice proxies these for Risk Centre.
const path = "/internal/access-controls";
const router = express.Router();

const serialize = (state: AccessControlState) => ({
  registrationEnabled: state.registrationEnabled,
  loginEnabled: state.loginEnabled,
  revision: state.revision,
  ...(state.updatedAt ? { updatedAt: state.updatedAt.toISOString() } : {}),
});

const isDuplicateKey = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === 11000;

router.get(path, async (_req, res) => {
  res.set("Cache-Control", "no-store").send(serialize(await readAccessControls()));
});

router.put(`${path}/:name`, async (req, res) => {
  res.set("Cache-Control", "no-store");
  if (!Object.prototype.hasOwnProperty.call(accessSwitchFields, req.params.name)) {
    res.status(404).send({ code: "NOT_FOUND", message: "Unknown access switch" });
    return;
  }
  const field = accessSwitchFields[req.params.name as AccessSwitch];
  const { enabled, expectedEnabled } = req.body ?? {};
  if (typeof enabled !== "boolean" || typeof expectedEnabled !== "boolean") {
    res.status(400).send({ code: "INVALID_REQUEST", message: "Provide the current and requested settings as booleans" });
    return;
  }
  let updated: AccessControlState | undefined;
  if (enabled !== expectedEnabled) {
    try {
      // Compare-and-set on the effective value; a missing document is open, so closing may upsert.
      const document = await AccessControl.findOneAndUpdate(
        { _id: ACCESS_CONTROL_ID, [field]: expectedEnabled ? { $ne: false } : false },
        { $set: { [field]: enabled }, $inc: { revision: 1 }, $currentDate: { updatedAt: true } },
        { new: true, upsert: expectedEnabled }
      ).lean();
      if (document) updated = toAccessControlState(document);
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
    }
  }
  if (updated) {
    res.send(serialize(updated));
    return;
  }
  const current = await readAccessControls();
  if (current[field] === enabled) {
    res.send({ ...serialize(current), unchanged: true });
  } else {
    res.status(409).send({ code: "CONFLICT", message: "The setting changed. Refresh before trying again." });
  }
});

export { router as accessControlsRouter };
