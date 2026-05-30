import { Request, Response, NextFunction } from 'express';
import { config } from '../config';

export function requireToken(req: Request, res: Response, next: NextFunction) {
  if (!config.secretToken) {
    return next();
  }
  const header = req.header('x-secret-token') || req.header('authorization')?.replace(/^Bearer\s+/i, '');
  const token = (req.query.token as string) || header;
  if (token !== config.secretToken) {
    return res.status(401).json({ success: false, error: 'Invalid or missing token' });
  }
  next();
}
