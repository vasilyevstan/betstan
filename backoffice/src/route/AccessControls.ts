import express from "express";
import { serviceRequest } from "./RiskCentre";

// Public Risk Centre switches for new customer registration and sign-in; Auth owns and enforces them.
const router = express.Router();
const base = "/api/backoffice/access-controls";
const error = (code: string, message: string) => ({ code, message });

const forward = (res: express.Response, next: express.NextFunction, path: string, method: string, body?: unknown) => {
  void serviceRequest(process.env.AUTH_SERVICE_URL, `/internal/access-controls${path}`, method, body, [200, 400, 404, 409])
    .then(result => { res.status(result.status).send(result.data); })
    .catch(() => {
      try { res.status(503).send(error("ACCESS_CONTROLS_UNAVAILABLE", "Access controls are unavailable")); }
      catch (failure) { next(failure); }
    });
};

router.get(base, (_req, res, next) => {
  res.set("Cache-Control", "no-store");
  forward(res, next, "", "GET");
});

router.put(`${base}/:name`, (req, res, next) => {
  res.set("Cache-Control", "no-store");
  if (!["registration", "login"].includes(req.params.name)) {
    res.status(404).send(error("NOT_FOUND", "Route not found"));
    return;
  }
  const { enabled, expectedEnabled } = req.body ?? {};
  if (typeof enabled !== "boolean" || typeof expectedEnabled !== "boolean") {
    res.status(400).send(error("INVALID_REQUEST", "Provide the current and requested settings as booleans"));
    return;
  }
  forward(res, next, `/${req.params.name}`, "PUT", { enabled, expectedEnabled });
});

export { router as AccessControls };
