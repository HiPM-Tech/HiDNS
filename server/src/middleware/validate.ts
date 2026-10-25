import { sendError } from '../utils/http';
import { Request, Response, NextFunction } from 'express';

type Schema = Record<string, { required?: boolean; type?: string }>;

export function validate(schema: Schema) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const body = req.body as Record<string, unknown>;
    for (const [key, rules] of Object.entries(schema)) {
      if (rules.required && (body[key] === undefined || body[key] === null || body[key] === '')) {
        sendError(res, `Missing required field: ${key}`, 400);
        return;
      }
      if (body[key] !== undefined && rules.type && typeof body[key] !== rules.type) {
        sendError(res, `Field ${key} must be of type ${rules.type}`, 400);
        return;
      }
    }
    next();
  };
}
