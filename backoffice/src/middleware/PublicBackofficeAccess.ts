import { NextFunction, Request, Response } from "express";

export const publicBackofficeAccess = (
  _req: Request,
  res: Response,
  next: NextFunction
) => {
  res.set("Cache-Control", "no-store");
  res.set("X-Backoffice-Access", "public");
  next();
};
