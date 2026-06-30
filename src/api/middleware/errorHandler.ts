/**
 * src/api/middleware/errorHandler.ts
 */

import { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { AppError } from "../../utils/errors.js";
import { logger } from "../../utils/logger.js";

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
) {
  if (err instanceof AppError) {
    return res.status(err.httpStatus).json({ error: err.message });
  }

  if (err instanceof ZodError) {
    const message = err.errors
      .map((e) => {
        const field = e.path.length ? e.path.join(".") : undefined;
        return field ? `${field}: ${e.message}` : e.message;
      })
      .join("; ");
    return res.status(400).json({ error: message });
  }

  logger.error(err, "Unhandled error");
  return res.status(500).json({ error: "Internal server error" });
}
