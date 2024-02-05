import { Request, Response, NextFunction } from "express";
import { CustomError } from "../error/CustomError";

export const errorHandler = (
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
) => {
  if (err instanceof CustomError) {
    return res.status(err.statusCode).send({ errors: err.serializeErrors() });
  }

  if (err instanceof Error) {
    return res.status(400).send({ errors: err.message });
  }

  //res.status(400).send({ errors: [{ message: err.message }] });
};
